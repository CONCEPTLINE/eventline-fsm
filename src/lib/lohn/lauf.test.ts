import { describe, it, expect, vi } from "vitest";

// lauf.ts zieht Server-Module (Admin-Client, Mail, Notifications) nach —
// für die reinen Teile (planeLauf, arbeiteAb) nicht nötig.
vi.mock("@/lib/notification-service", () => ({ notifySystem: vi.fn() }));
vi.mock("@/lib/notification-recipients", () => ({ recipientsWithPermission: vi.fn(async () => []) }));
vi.mock("./abrechnung", () => ({ erzeugeUndSpeichereLohnabrechnung: vi.fn() }));

import { arbeiteAb, planeLauf, zeileImMonat, type CompZeile, type PersonInfo } from "./lauf";
import { LohnFehler } from "./fassung";

const A = "a0000000-0000-4000-8000-0000000000a1";
const B = "a0000000-0000-4000-8000-0000000000b2";
const C = "a0000000-0000-4000-8000-0000000000c3";

function z(profile_id: string, effective_from: string, effective_to: string | null, extra: Partial<CompZeile> = {}): CompZeile {
  return { profile_id, effective_from, effective_to, wage_exempt: false, auto_lohnabrechnung: true, ...extra };
}
const personen = (eintraege: [string, string, boolean][]) =>
  new Map<string, PersonInfo>(eintraege.map(([id, name, aktiv]) => [id, { name, aktiv }]));
const monate = (r: { auftraege: { profileId: string; monat: { jahr: number; monat: number } }[] }, id: string) =>
  r.auftraege.filter((a) => a.profileId === id).map((a) => `${a.monat.jahr}-${String(a.monat.monat).padStart(2, "0")}`);

describe("planeLauf — welche gesperrten Monate werden nachgeholt", () => {
  const heute = "2026-10-29"; // gesperrt bis September
  const laufAb = { jahr: 2026, monat: 3 };

  it("holt ALLE gesperrten Monate ohne gültige Fassung nach, nicht nur den Vormonat", () => {
    const r = planeLauf({
      heute,
      laufAb,
      comps: [z(A, "2026-03-09", null)],
      personen: personen([[A, "Anna", true]]),
      vorhanden: new Set([`${A}|2026-04`, `${A}|2026-08`]),
    });
    expect(monate(r, A)).toEqual(["2026-03", "2026-05", "2026-06", "2026-07", "2026-09"]);
  });

  it("Eintritt Mitte Monat: der Eintrittsmonat zählt, davor nichts", () => {
    const r = planeLauf({
      heute,
      laufAb,
      comps: [z(A, "2026-07-15", null)],
      personen: personen([[A, "Anna", true]]),
      vorhanden: new Set(),
    });
    expect(monate(r, A)).toEqual(["2026-07", "2026-08", "2026-09"]);
  });

  it("Austritt: Monate bis zum Austritt (Schlussabrechnung), danach nichts — auch wenn inaktiv", () => {
    const r = planeLauf({
      heute,
      laufAb,
      comps: [z(B, "2026-03-09", "2026-06-30")],
      personen: personen([[B, "Ben", false]]),
      vorhanden: new Set([`${B}|2026-03`, `${B}|2026-04`, `${B}|2026-05`]),
    });
    expect(monate(r, B)).toEqual(["2026-06"]);
    expect(r.hinweise).toEqual([]);
  });

  it("inaktiv mit offener Lohnzeile: keine Monate, aber ein Hinweis", () => {
    const r = planeLauf({
      heute,
      laufAb,
      comps: [z(C, "2026-03-09", null)],
      personen: personen([[C, "Cleo", false]]),
      vorhanden: new Set(),
    });
    expect(monate(r, C)).toEqual([]);
    expect(r.hinweise).toHaveLength(1);
    expect(r.hinweise[0].text).toMatch(/Austritt/);
  });

  it("kein Lohn (wage_exempt) und Auto-Abrechnung aus werden übersprungen — je Monat nach gültiger Zeile", () => {
    const r = planeLauf({
      heute,
      laufAb: { jahr: 2026, monat: 7 },
      comps: [
        z(A, "2026-03-09", "2026-07-31"),
        z(A, "2026-08-01", "2026-08-31", { wage_exempt: true }),
        z(A, "2026-09-01", null, { auto_lohnabrechnung: false }),
        z(B, "2026-03-09", null),
      ],
      personen: personen([[A, "Anna", true], [B, "Ben", true]]),
      vorhanden: new Set(),
    });
    expect(monate(r, A)).toEqual(["2026-07"]);
    expect(monate(r, B)).toEqual(["2026-07", "2026-08", "2026-09"]);
  });

  it("vor «Lauf ab» wird nie etwas erzeugt (Korrektur-Phase)", () => {
    const r = planeLauf({
      heute: "2026-11-05",
      laufAb: { jahr: 2026, monat: 10 },
      comps: [z(A, "2026-03-09", null)],
      personen: personen([[A, "Anna", true]]),
      vorhanden: new Set(),
    });
    expect(monate(r, A)).toEqual(["2026-10"]);
  });

  it("Lohnerhöhung Mitte Monat: die jüngere Zeile gilt für den Monat (wie die Abrechnung)", () => {
    const zeilen = [z(A, "2026-03-09", "2026-09-14"), z(A, "2026-09-15", null, { auto_lohnabrechnung: false })];
    expect(zeileImMonat(zeilen, { jahr: 2026, monat: 9 })?.effective_from).toBe("2026-09-15");
    expect(zeileImMonat(zeilen, { jahr: 2026, monat: 8 })?.effective_from).toBe("2026-03-09");
    expect(zeileImMonat(zeilen, { jahr: 2026, monat: 2 })).toBeNull();
  });

  it("Abrechnung im Papierkorb: nicht neu erzeugen, sondern Hinweis", () => {
    const r = planeLauf({
      heute,
      laufAb: { jahr: 2026, monat: 8 },
      comps: [z(A, "2026-03-09", null)],
      personen: personen([[A, "Anna", true]]),
      vorhanden: new Set([`${A}|2026-09`]),
      imPapierkorb: new Set([`${A}|2026-08`]),
    });
    expect(monate(r, A)).toEqual([]);
    expect(r.hinweise.map((h) => h.text)).toEqual(["August 2026: Abrechnung liegt im Papierkorb — wiederherstellen oder neu erzeugen"]);
  });

  it("verwaiste Lohnzeile ohne Profil: nichts", () => {
    const r = planeLauf({ heute, laufAb, comps: [z(A, "2026-03-09", null)], personen: new Map(), vorhanden: new Set() });
    expect(r.auftraege).toEqual([]);
  });
});

describe("arbeiteAb — ein Fehler betrifft nur die betroffene Person", () => {
  const auftraege = [
    { profileId: A, name: "Anna", monat: { jahr: 2026, monat: 9 } },
    { profileId: B, name: "Ben", monat: { jahr: 2026, monat: 9 } },
    { profileId: C, name: "Cleo", monat: { jahr: 2026, monat: 9 } },
  ];

  it("Speicherfehler bei Ben: Anna und Cleo werden trotzdem erzeugt", async () => {
    const erzeuge = vi.fn(async (a: { profileId: string }) => {
      if (a.profileId === B) throw new LohnFehler("PDF konnte nicht gespeichert werden: Storage down");
      return { version: 1 };
    });
    const r = await arbeiteAb(auftraege, erzeuge);
    expect(erzeuge).toHaveBeenCalledTimes(3);
    expect(r.map((x) => [x.name, x.ok])).toEqual([["Anna", true], ["Ben", false], ["Cleo", true]]);
    expect(r[1].fehler).toMatch(/Storage down/);
  });

  it("inzwischen vorhandene Fassung ist kein Fehler (nichts überschrieben)", async () => {
    const r = await arbeiteAb(auftraege.slice(0, 1), async () => {
      throw new LohnFehler("schon vorhanden", 409, "neue_fassung");
    });
    expect(r[0].ok).toBe(true);
    expect(r[0].uebersprungen).toBeTruthy();
  });
});

describe("planeLauf — Anstellung (Phase 2)", () => {
  const heute = "2026-10-29";
  const laufAb = { jahr: 2026, monat: 3 };
  it("kein Abrechnen vor Eintritt / nach Austritt der Anstellung, auch bei offener Lohnzeile", () => {
    const r = planeLauf({
      heute,
      laufAb,
      comps: [z(A, "2026-03-09", null)],
      personen: personen([[A, "Anna", false]]),
      vorhanden: new Set(),
      anstellungen: [{ profile_id: A, eintritt: "2026-05-10", austritt: "2026-07-31" }],
    });
    expect(monate(r, A)).toEqual(["2026-05", "2026-06", "2026-07"]);
    expect(r.hinweise).toEqual([]);
  });
  it("inaktiv, Anstellung ohne Austritt und offene Lohnzeile: Hinweis statt Abrechnungen", () => {
    const r = planeLauf({
      heute,
      laufAb,
      comps: [z(C, "2026-03-09", null)],
      personen: personen([[C, "Cleo", false]]),
      vorhanden: new Set(),
      anstellungen: [{ profile_id: C, eintritt: "2026-03-09", austritt: null }],
    });
    expect(monate(r, C)).toEqual([]);
    expect(r.hinweise).toHaveLength(1);
  });
});
