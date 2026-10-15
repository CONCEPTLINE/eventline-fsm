// POST /api/ablage/upload: der KI-Vorschlag der Karte landet neben dem final gewaehlten Ziel (Migration 339) —
// Seiten nur vom Server (Ergebnis der lokalen KI), ein ungueltiger Vorschlag blockiert das Ablegen nie.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeAdmin, type FakeDb } from "@/lib/ki/test-fake-db";
import { baueAblageName } from "@/lib/ablage-doktypen";
import { todayLocalIso } from "@/lib/swiss-time";

const zustand = vi.hoisted(() => ({ db: null as unknown as FakeDb }));

vi.mock("@/lib/api-auth", () => ({ requireAdmin: async () => ({ effectiveUserId: "u1" }) }));
vi.mock("@/lib/log", () => ({ logError: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    ...fakeAdmin(zustand.db),
    storage: {
      from: () => ({
        download: async () => ({ data: new Blob(["%PDF-1.4 Probe"], { type: "application/pdf" }), error: null }),
        move: async () => ({ error: null }),
        upload: async () => ({ error: null }),
      }),
    },
  }),
}));

import { POST } from "./route";

const TMP = "0f0e0d0c-0b0a-4908-8706-050403020100";
const ORDNER = "00_ADMIN/01_Rechnungen";

function formular(felder: Record<string, string>, datei?: File): NextRequest {
  const fd = new FormData();
  for (const [k, v] of Object.entries(felder)) fd.append(k, v);
  if (datei) fd.append("file", datei);
  return new NextRequest("http://localhost/api/ablage/upload", { method: "POST", body: fd });
}

const FELDER = { typ: "rechnung", betreff: "Licht", partei: "Herzog Tech", nummer: "", dok_datum: "2026-10-01", ordner: ORDNER };

beforeEach(() => {
  zustand.db = {
    aufrufe: [],
    tabellen: {
      ablage_ordner: [{ pfad: ORDNER, aktiv: true }, { pfad: "00_ADMIN/02_Offerten", aktiv: true }],
      ablage_items: [],
      ablage_datei_index: [],
      ablage_fristen: [],
      ki_auftraege: [{
        art: "ablage_analyse", "payload->>storage_path": `ki-tmp/${TMP}`, created_at: "2026-10-15T18:00:00Z",
        payload: { storage_path: `ki-tmp/${TMP}`, file_name: "scan_001.pdf", mime: "application/pdf", size: 14 },
        ergebnis: { seiten: 3, ordner: ORDNER, ordner_quelle: "claude" },
      }],
    },
  };
});

describe("POST /api/ablage/upload — KI-Vorschlag neben dem Ziel", () => {
  it("lokal gelesen + Claude-Ordner unveraendert uebernommen: Quelle, Ordner, Name wie final, Seiten vom Server", async () => {
    const vorschlag = { quelle: "claude", ordner: ORDNER, typ: "rechnung", betreff: "Licht", person: "", partei: "Herzog Tech", nummer: "", dok_datum: "2026-10-01" };
    const r = await POST(formular({ ...FELDER, tmp_id: TMP, ki_vorschlag: JSON.stringify(vorschlag) }));
    const j = await r.json();
    expect(r.status).toBe(200);
    const [zeile] = zustand.db.tabellen.ablage_items;
    expect(zeile).toMatchObject({ ordner_pfad: ORDNER, abgelegt_name: j.abgelegt_name, ki_quelle: "claude", ki_ordner: ORDNER, ki_name: j.abgelegt_name, seiten: 3 });
    expect(zustand.db.tabellen.ki_auftraege).toHaveLength(0);
  });

  it("Claude-Weg (getippt), Ordner und Betreff geaendert: Vorschlag bleibt, wie er war; ohne lokale KI keine Seiten", async () => {
    const vorschlag = { quelle: "beschrieb", ordner: "00_ADMIN/02_Offerten", typ: "rechnung", betreff: "Strom", partei: "Herzog Tech", nummer: "", dok_datum: "" };
    const datei = new File(["%PDF-1.4 Probe"], "rechnung.pdf", { type: "application/pdf" });
    const r = await POST(formular({ ...FELDER, ki_vorschlag: JSON.stringify(vorschlag) }, datei));
    expect(r.status).toBe(200);
    const [zeile] = zustand.db.tabellen.ablage_items;
    const kiName = baueAblageName({ typKey: "rechnung", betreff: "Strom", partei: "Herzog Tech", nummer: "", dokDatum: "" }, "rechnung.pdf", todayLocalIso());
    expect(zeile).toMatchObject({ ordner_pfad: ORDNER, ki_quelle: "beschrieb", ki_ordner: "00_ADMIN/02_Offerten", ki_name: kiName, seiten: null });
    expect(zeile.abgelegt_name).not.toBe(kiName);
  });

  it("ohne oder mit ungueltigem Vorschlag: ablegen wie bisher, keine KI-Spalten", async () => {
    const datei = () => new File(["%PDF-1.4 Probe"], "a.pdf", { type: "application/pdf" });
    expect((await POST(formular({ ...FELDER }, datei()))).status).toBe(200);
    expect((await POST(formular({ ...FELDER, ki_vorschlag: "{kaputt", force: "1" }, datei()))).status).toBe(200);
    expect((await POST(formular({ ...FELDER, ki_vorschlag: JSON.stringify({ quelle: "erfunden" }), force: "1" }, datei()))).status).toBe(200);
    for (const z of zustand.db.tabellen.ablage_items) expect(z).not.toHaveProperty("ki_quelle");
  });
});
