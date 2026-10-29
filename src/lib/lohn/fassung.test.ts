import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fassungsPfad, speichereFassung, LohnFehler } from "./fassung";
import { geraetFreigabeVerboten, lohnAenderungVerboten } from "./zugriff";

const P = "a0000000-0000-4000-8000-000000000017";

/** Minimaler Supabase-Ersatz: wage_documents-Abfrage (naechste Version),
 *  Storage upload/remove, rpc. */
function fake(opts: {
  maxVersion?: number;
  uploadError?: string;
  rpc?: { data?: unknown; error?: { message: string } | null };
}) {
  const remove = vi.fn(async (pfade: string[]) => ({ data: pfade.map((name) => ({ name })), error: null }));
  const upload = vi.fn(async (pfad: string, inhalt: unknown, optionen: { upsert?: boolean }) => ({
    data: opts.uploadError || !inhalt || optionen.upsert ? null : { path: pfad },
    error: opts.uploadError ? { message: opts.uploadError } : null,
  }));
  const rpc = vi.fn(async () => ({ data: opts.rpc?.data ?? null, error: opts.rpc?.error ?? null }));
  const kette: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order", "limit"]) kette[m] = () => kette;
  kette.maybeSingle = async () => ({ data: opts.maxVersion ? { version: opts.maxVersion } : null, error: null });
  const client = {
    from: () => kette,
    storage: { from: () => ({ upload, remove }) },
    rpc,
  } as unknown as SupabaseClient;
  return { client, upload, remove, rpc };
}

const basis = {
  profileId: P,
  docType: "lohnabrechnung" as const,
  year: 2026,
  month: 9,
  pdf: new Uint8Array([37, 80, 68, 70]),
  source: "auto" as const,
  actorId: null,
  actorName: "Automatischer Lohnlauf",
  jetzt: new Date("2026-10-29T09:15:02.123Z"),
  zufall: "abc123",
};

describe("Speicherpfad je Fassung — nie überschreiben", () => {
  it("enthält Periode, Fassung, Zeitstempel und Zufall", () => {
    expect(fassungsPfad({ ...basis, version: 2 })).toBe(`${P}/2026/2026-09/v2-20261029T091502Z-abc123.pdf`);
    expect(fassungsPfad({ ...basis, docType: "lohnausweis", month: null, version: 1 })).toBe(
      `${P}/2026/lohnausweis/v1-20261029T091502Z-abc123.pdf`,
    );
  });
  it("lädt immer mit upsert:false hoch", async () => {
    const f = fake({ rpc: { data: { modus: "neu", id: "x", version: 1 } } });
    await speichereFassung(f.client, basis);
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.upload.mock.calls[0][2]).toMatchObject({ upsert: false });
    expect(f.upload.mock.calls[0][0]).toBe(`${P}/2026/2026-09/v1-20261029T091502Z-abc123.pdf`);
  });
  it("nächste Fassung bekommt n+1 im Pfad", async () => {
    const f = fake({ maxVersion: 3, rpc: { data: { modus: "neue_fassung", id: "x", version: 4, vorherige_version: 3 } } });
    const r = await speichereFassung(f.client, basis);
    expect(f.upload.mock.calls[0][0]).toContain("/v4-");
    expect(r).toMatchObject({ modus: "neue_fassung", version: 4, vorherigeVersion: 3 });
  });
});

describe("PDF und Zeile gemeinsam", () => {
  it("Storage-Fehler: keine Zeile (rpc nie aufgerufen), Fehler wird geworfen", async () => {
    const f = fake({ uploadError: "Storage down" });
    await expect(speichereFassung(f.client, basis)).rejects.toBeInstanceOf(LohnFehler);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("DB-Fehler nach dem Hochladen: genau die eigene Datei wird wieder entfernt", async () => {
    const f = fake({ rpc: { error: { message: "unique violation" } } });
    await expect(speichereFassung(f.client, basis)).rejects.toThrow(/unique violation/);
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.remove.mock.calls[0][0]).toEqual([f.upload.mock.calls[0][0]]);
  });
  it("inzwischen vorhanden (Lauf): eigene Datei weg, nichts überschrieben", async () => {
    const f = fake({ rpc: { data: { modus: "vorhanden", id: "alt", version: 1 } } });
    const r = await speichereFassung(f.client, { ...basis, nurWennKeineGueltige: true });
    expect(r.modus).toBe("vorhanden");
    expect(f.remove).toHaveBeenCalledTimes(1);
  });
});

describe("Vier Augen und Gerätefreigabe", () => {
  const V = "v0000000-0000-4000-8000-000000000001";
  it("niemand ändert den eigenen Lohn — auch kein Admin", () => {
    expect(lohnAenderungVerboten({ actorId: P, targetId: P, actorIstAdmin: true, targetHatLohnRecht: true, vertretungProfileId: null })).toMatch(/eigenen Lohn/);
  });
  it("Lohn eines Lohn-Verwalters: nur Admin oder Vertretung", () => {
    expect(lohnAenderungVerboten({ actorId: "x", targetId: P, actorIstAdmin: true, targetHatLohnRecht: true, vertretungProfileId: null })).toBeNull();
    expect(lohnAenderungVerboten({ actorId: V, targetId: P, actorIstAdmin: false, targetHatLohnRecht: true, vertretungProfileId: V })).toBeNull();
    expect(lohnAenderungVerboten({ actorId: "y", targetId: P, actorIstAdmin: false, targetHatLohnRecht: true, vertretungProfileId: V })).toMatch(/nur ein Admin oder die Vertretung/);
  });
  it("übrige Personen: wer Lohnrecht hat (prüft die Route)", () => {
    expect(lohnAenderungVerboten({ actorId: "y", targetId: P, actorIstAdmin: false, targetHatLohnRecht: false, vertretungProfileId: null })).toBeNull();
  });
  it("Geräte: nie das eigene, nur Admin oder Vertretung", () => {
    expect(geraetFreigabeVerboten({ freigeberId: P, besitzerId: P, freigeberIstAdmin: true, vertretungProfileId: null })).toMatch(/eigene Gerät/);
    expect(geraetFreigabeVerboten({ freigeberId: "x", besitzerId: P, freigeberIstAdmin: true, vertretungProfileId: null })).toBeNull();
    expect(geraetFreigabeVerboten({ freigeberId: V, besitzerId: P, freigeberIstAdmin: false, vertretungProfileId: V })).toBeNull();
    expect(geraetFreigabeVerboten({ freigeberId: "y", besitzerId: P, freigeberIstAdmin: false, vertretungProfileId: V })).toMatch(/nur Admins oder die Vertretung/);
  });
});

describe("Leitplanke: kein Code löscht oder überschreibt Lohn-Dateien", () => {
  const SRC = path.resolve(__dirname, "../..");
  const alle: string[] = [];
  const lauf = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) lauf(p);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) alle.push(p);
    }
  };
  lauf(SRC);
  const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");

  it("Entfernen in «lohndokumente»/«personal-dossiers» nur beim Aufräumen der eigenen, eben hochgeladenen Datei", () => {
    const erlaubt = new Set(["lib/lohn/fassung.ts", "app/api/admin/users/[id]/dossier/route.ts"]);
    const treffer = alle.filter((p) => {
      const t = fs.readFileSync(p, "utf8");
      const lohnBucket = /lohndokumente|personal-dossiers|LOHN_BUCKET|DOSSIER_BUCKET/.test(t);
      return lohnBucket && /\.remove\(/.test(t);
    }).map(rel);
    expect(treffer.filter((r) => !erlaubt.has(r))).toEqual([]);
  });

  it("kein upsert:true auf Lohn-Buckets", () => {
    const treffer = alle.filter((p) => {
      const t = fs.readFileSync(p, "utf8");
      return /lohndokumente|personal-dossiers|LOHN_BUCKET|DOSSIER_BUCKET/.test(t) && /upsert:\s*true/.test(t);
    }).map(rel);
    expect(treffer).toEqual([]);
  });

  it("keine Sammel-Neuerstellung mehr (rebuild-all / generate/bulk)", () => {
    expect(fs.existsSync(path.join(SRC, "app/api/hr/wage-documents/rebuild-all"))).toBe(false);
    expect(fs.existsSync(path.join(SRC, "app/api/hr/wage-documents/generate/bulk"))).toBe(false);
    const verweise = alle.filter((p) => /rebuild-all|generate\/bulk/.test(fs.readFileSync(p, "utf8"))).map(rel);
    expect(verweise).toEqual([]);
  });
});
