import { describe, it, expect, vi } from "vitest";

// lauf.ts zieht Server-Module (Admin-Client, Mail, Notifications) nach —
// für die reinen Teile (planeLauf, arbeiteAb) nicht nötig.
vi.mock("@/lib/notification-service", () => ({ notifySystem: vi.fn() }));
vi.mock("@/lib/notification-recipients", () => ({ recipientsWithPermission: vi.fn(async () => []) }));
vi.mock("./abrechnung", () => ({ erzeugeUndSpeichereLohnabrechnung: vi.fn() }));

import { abrechnungsZeile, arbeiteAb, bestimmeMonatsStatus, laufBisHinweis, laufStatus, laufZusammenfassung, planeLauf, zeileImMonat, type CompZeile, type PersonInfo } from "./lauf";
import { LohnFehler } from "./fassung";
import { alarmBetreff, alarmMailHtml, alarmZeilen, monatsstundenLink, ohneBetraege } from "./alarm";

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

describe("Phase 4: blockiert (Stempel prüfen) statt zu tiefer Abrechnung", () => {
  const auftraege = [
    { profileId: A, name: "Anna", monat: { jahr: 2026, monat: 9 } },
    { profileId: B, name: "Ben", monat: { jahr: 2026, monat: 9 } },
    { profileId: C, name: "Cleo", monat: { jahr: 2026, monat: 9 } },
  ];

  it("LohnFehler «stempel_pruefen» ist blockiert, kein Fehler — die anderen laufen weiter", async () => {
    const r = await arbeiteAb(auftraege, async (a) => {
      if (a.profileId === B) throw new LohnFehler("Stempel prüfen: 1 offener Stempel (seit 28.09., 08:00)", 409, "stempel_pruefen");
      return { version: 1 };
    });
    expect(r.map((x) => [x.name, x.ok, !!x.blockiert, !!x.fehler])).toEqual([
      ["Anna", true, false, false],
      ["Ben", false, true, false],
      ["Cleo", true, false, false],
    ]);
    expect(r[1].blockiert).toMatch(/offener Stempel/);
    expect(laufStatus(r)).toEqual({ status: "blockiert", erstellt: 2, fehler: 0, blockiert: 1 });
  });

  it("Status: Fehler gehen vor blockiert; ohne Erstellte = fehler, sonst teilweise", async () => {
    const zeile = (ok: boolean, extra: object = {}) => ({ profile_id: A, name: "A", monat: "2026-09", ok, ...extra });
    expect(laufStatus([zeile(true), zeile(false, { fehler: "x" }), zeile(false, { blockiert: "y" })]).status).toBe("teilweise");
    expect(laufStatus([zeile(false, { fehler: "x" }), zeile(false, { blockiert: "y" })]).status).toBe("fehler");
    expect(laufStatus([zeile(false, { blockiert: "y" })]).status).toBe("blockiert");
    expect(laufStatus([zeile(true), zeile(true, { uebersprungen: "inzwischen vorhanden" })])).toEqual({ status: "ok", erstellt: 1, fehler: 0, blockiert: 0 });
    expect(laufStatus([]).status).toBe("ok");
  });

  it("Zusammenfassung nennt blockierte Monate nur, wenn es welche gibt", () => {
    expect(laufZusammenfassung({ erstellt: 3, blockiert: 0, fehler: 0, offen: 0 })).toBe("3 erstellt, 0 Fehler");
    expect(laufZusammenfassung({ erstellt: 3, blockiert: 2, fehler: 1, offen: 4 })).toBe("3 erstellt, 2 blockiert (Stempel prüfen), 1 Fehler, 4 offen");
  });

  it("abrechnungsZeile: Abrechnung nötig auch bei «automatisch aus», nicht bei kein Lohn / ausserhalb der Anstellung", () => {
    const zeilen = [z(A, "2026-03-09", "2026-07-31", { auto_lohnabrechnung: false }), z(A, "2026-08-01", null, { wage_exempt: true })];
    expect(abrechnungsZeile(zeilen, [], { jahr: 2026, monat: 7 })).not.toBeNull();
    expect(abrechnungsZeile(zeilen, [], { jahr: 2026, monat: 8 })).toBeNull();
    expect(abrechnungsZeile(zeilen, [{ profile_id: A, eintritt: "2026-05-01", austritt: null }], { jahr: 2026, monat: 4 })).toBeNull();
  });
});

describe("Phase 4: Alarm-Mail ohne Beträge", () => {
  const alarm = {
    laufId: "x",
    art: "ergebnis" as const,
    zusammenfassung: "1 erstellt, 1 blockiert (Stempel prüfen), 1 Fehler",
    ergebnisse: [
      { name: "Ben <b>Wyss</b>", monat: "2026-06", blockiert: "Stempel prüfen: 1 offener Stempel (seit 29.06., 21:00)" },
      { name: "Noah Brunner", monat: "2026-09", fehler: "Netto negativ: CHF -1'234.50 bei Fr. 12" },
    ],
  };

  it("Beträge werden aus Fehlertexten entfernt, Datum/Uhrzeit bleiben", () => {
    expect(ohneBetraege("Netto CHF 1'234.50, Abzug Fr. 12.30")).toBe("Netto CHF …, Abzug Fr. …");
    expect(ohneBetraege("seit 29.06., 21:00, 17:30 h")).toBe("seit 29.06., 21:00, 17:30 h");
  });

  it("Zeilen: Fehler zuerst, dann blockiert; kein CHF-Betrag; HTML escaped; Link auf Monatsstunden des frühesten Monats", () => {
    const zeilen = alarmZeilen(alarm);
    expect(zeilen[0]).toMatch(/^Fehler: Noah Brunner · September 2026 — Netto negativ: CHF …/);
    expect(zeilen[1]).toMatch(/^Blockiert: Ben <b>Wyss<\/b> · Juni 2026 — Stempel prüfen/);
    const html = alarmMailHtml(alarm, new Date("2026-11-05T07:00:00Z"));
    expect(html).not.toMatch(/\d'\d{3}\.\d{2}|CHF\s*-?\d/);
    expect(html).toContain("Ben &lt;b&gt;Wyss&lt;/b&gt;");
    expect(html).toContain("tab=monatsstunden&amp;monat=2026-06");
    expect(alarmBetreff(alarm)).toBe("EVENTLINE Lohnlauf: 1 Fehler, 1 blockiert (Stempel prüfen)");
    expect(alarmBetreff({ laufId: null, art: "start", text: "x" })).toBe("EVENTLINE Lohnlauf: konnte nicht starten");
    expect(monatsstundenLink()).toBe("/lohn?ansicht=team&tab=monatsstunden");
  });
});

describe("lauf_bis: ab Dezember 2026 rechnet Trust flow/Bexio (Entscheid Mischa 30.10.2026)", () => {
  const laufBis = { jahr: 2026, monat: 11 };

  it("Monate nach lauf_bis werden gar nicht geplant; EIN Hinweis je Lauf, nicht je Person", () => {
    const r = planeLauf({
      heute: "2027-02-10", // gesperrt bis Januar 2027
      laufAb: { jahr: 2026, monat: 10 },
      laufBis,
      comps: [z(A, "2026-03-09", null), z(B, "2026-03-09", null)],
      personen: personen([[A, "Anna", true], [B, "Ben", true]]),
      vorhanden: new Set(),
    });
    expect(monate(r, A)).toEqual(["2026-10", "2026-11"]);
    expect(monate(r, B)).toEqual(["2026-10", "2026-11"]);
    expect(r.hinweise.map((h) => h.text)).toEqual([laufBisHinweis(laufBis)]);
    expect(laufBisHinweis(laufBis)).toBe("Ab Dezember 2026 rechnet Trust flow/Bexio — der Lauf erzeugt dafür keine Lohnabrechnungen mehr.");
  });

  it("solange kein gesperrter Monat nach lauf_bis liegt: kein Hinweis", () => {
    const r = planeLauf({ heute: "2026-10-29", laufAb: { jahr: 2026, monat: 3 }, laufBis, comps: [z(A, "2026-03-09", null)], personen: personen([[A, "Anna", true]]), vorhanden: new Set() });
    expect(monate(r, A)).toHaveLength(7);
    expect(r.hinweise).toEqual([]);
  });

  it("Abrechnung bricht mit «lauf_bis» ab (Wettlauf): übersprungen, kein Fehler", async () => {
    const r = await arbeiteAb([{ profileId: A, name: "Anna", monat: { jahr: 2026, monat: 12 } }], async () => {
      throw new LohnFehler("Ab Dezember 2026 läuft der Lohn über Trust flow/Bexio", 409, "lauf_bis");
    });
    expect(r[0].ok).toBe(true);
    expect(r[0].uebersprungen).toBe("über Trust flow");
    expect(laufStatus(r).status).toBe("ok");
  });

  it("Statusspalte: nach lauf_bis «über Trust flow» statt «fehlt»/«blockiert»/«—»", () => {
    const basis = { gesperrt: true, noetig: true, fassungArt: null, manuell: false, ausbezahlt: false, vorschlagOffen: false, stempelProbleme: 0, laufFehler: null, nachLaufBis: true } as const;
    expect(bestimmeMonatsStatus(basis)).toBe("trust_flow");
    expect(bestimmeMonatsStatus({ ...basis, stempelProbleme: 2 })).toBe("trust_flow");
    expect(bestimmeMonatsStatus({ ...basis, gesperrt: false })).toBe("trust_flow");
    expect(bestimmeMonatsStatus({ ...basis, noetig: false })).toBe("keine");
    expect(bestimmeMonatsStatus({ ...basis, nachLaufBis: false })).toBe("fehlt");
    expect(bestimmeMonatsStatus({ ...basis, nachLaufBis: false, stempelProbleme: 1 })).toBe("blockiert");
  });

  it("Statusspalte: Lohnabrechnung aus Bexio nach lauf_bis = «über Trust flow», nie «hochgeladen»/«keine»", () => {
    const basis = { gesperrt: true, noetig: true, fassungArt: null, manuell: true, bexio: true, ausbezahlt: false, vorschlagOffen: false, stempelProbleme: 0, laufFehler: null, nachLaufBis: true } as const;
    expect(bestimmeMonatsStatus(basis)).toBe("trust_flow");
    expect(bestimmeMonatsStatus({ ...basis, noetig: false })).toBe("trust_flow");
    expect(bestimmeMonatsStatus({ ...basis, gesperrt: false })).toBe("trust_flow");
    // Von Hand hochgeladen (nicht aus Bexio) bleibt wie bisher «erstellt».
    expect(bestimmeMonatsStatus({ ...basis, bexio: false })).toBe("erstellt");
  });
});
