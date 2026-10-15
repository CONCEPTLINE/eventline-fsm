/**
 * NBU-Pflicht (Art. 13 UVV) — Szenarien fuer die 8-Stunden-Regel.
 *
 * Regel (siehe src/lib/nbu-pflicht.ts): Stempelzeiten der letzten 3 Monate
 * bis Ende des Abrechnungsmonats, Wochen Mo–So (Europe/Zurich, Zuordnung
 * zum Monat ueber den Donnerstag), nur gearbeitete Wochen. Versichert, wenn
 * Ø je gearbeiteter Woche >= 8 h ODER mehr als die Haelfte der Wochen >= 8 h.
 *
 * Kalender 2026 zur Orientierung: 01.06. Mo, 29.06. Mo, 02.07. Do,
 * 27.07. Mo, 31.08. Mo, 28.09. Mo, 01.10. Do. Sommerzeit: 29.03.–25.10.2026.
 */

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  NBU_MIN_STUNDEN_PRO_WOCHE,
  NBU_BETRACHTUNG_MONATE,
  NBU_HINWEIS_KURZ,
  abrechnungsmonateImZeitraum,
  berechneMitarbeiterAbzuege,
  fmtNbuStunden,
  ladeNbuStatus,
  ladeNbuStatusFuerMonat,
  mitNbuRegel,
  nbuBegruendung,
  nbuBetrachtungszeitraum,
  nbuLadeZeitraum,
  nbuStatusAusStempel,
  nbuStatusAusWochenstunden,
  nbuStatusFuerMonat,
  stempelMinutenJeWoche,
  wochenMontag,
  type NbuStempelEintrag,
} from "./nbu-pflicht";
import type { LohnPctSet } from "./employer-costs";

/** Lokale Zuercher Zeit → UTC-ISO. offsetH = +1 (Winter) / +2 (Sommer). */
function zh(datum: string, zeit: string, offsetH: 1 | 2): string {
  const [y, m, d] = datum.split("-").map(Number);
  const [hh, mm] = zeit.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh - offsetH, mm)).toISOString();
}

/** Sommer-Schicht (CEST) von–bis am selben Tag. */
function sommer(datum: string, von: string, bis: string): NbuStempelEintrag {
  return { start: zh(datum, von, 2), ende: zh(datum, bis, 2) };
}

const SAETZE: LohnPctSet = {
  ahvIvEoPct: 5.3, alvPct: 1.1, nbuPct: 1.45, bvgPct: 0, ktgPct: 0, quellensteuerPct: 0,
  employerAhvPct: 5.3, employerAlvPct: 1.1, employerFakPct: 1.5, employerBuPct: 0.18, employerBvgPct: 0, employerVerwaltungPct: 0.15,
};

describe("Konstanten (anpassbar nach Suva-Bestaetigung)", () => {
  it("8 Stunden pro Woche, 3 Monate Betrachtung", () => {
    expect(NBU_MIN_STUNDEN_PRO_WOCHE).toBe(8);
    expect(NBU_BETRACHTUNG_MONATE).toBe(3);
    expect(NBU_HINWEIS_KURZ).toBe("wird nur abgezogen, wenn Ø ≥ 8 h/Woche");
  });
});

describe("Betrachtungszeitraum + Wochen-Helfer", () => {
  it("September 2026 → 01.07.–30.09.2026", () => {
    expect(nbuBetrachtungszeitraum(2026, 9)).toEqual({ von: "2026-07-01", bis: "2026-09-30" });
  });
  it("Januar 2027 → ueber den Jahreswechsel 01.11.2026–31.01.2027", () => {
    expect(nbuBetrachtungszeitraum(2027, 1)).toEqual({ von: "2026-11-01", bis: "2027-01-31" });
  });
  it("Februar im Schaltjahr endet am 29.", () => {
    expect(nbuBetrachtungszeitraum(2028, 2).bis).toBe("2028-02-29");
  });
  it("ungueltiger Monat wirft", () => {
    expect(() => nbuBetrachtungszeitraum(2026, 13)).toThrow();
    expect(() => nbuBetrachtungszeitraum(2026, 0)).toThrow();
  });
  it("Montag der Woche (Mo–So)", () => {
    expect(wochenMontag("2026-10-19")).toBe("2026-10-19"); // Montag
    expect(wochenMontag("2026-10-25")).toBe("2026-10-19"); // Sonntag gehoert zur Woche davor
    expect(wochenMontag("2027-01-01")).toBe("2026-12-28"); // ueber den Jahreswechsel
  });
  it("Lade-Zeitraum deckt Randwochen + Nachtschichten ab", () => {
    expect(nbuLadeZeitraum([{ jahr: 2026, monat: 9 }])).toEqual({
      vonIso: "2026-06-26T00:00:00Z",
      bisIso: "2026-10-05T00:00:00Z",
    });
  });
  it("Abrechnungsmonate eines Zeitraums ueber den Jahreswechsel", () => {
    expect(abrechnungsmonateImZeitraum("2026-11-15", "2027-02-03")).toEqual([
      { jahr: 2026, monat: 11 }, { jahr: 2026, monat: 12 }, { jahr: 2027, monat: 1 }, { jahr: 2027, monat: 2 },
    ]);
  });
});

describe("Grenzwert 8 Stunden", () => {
  it("genau 8,0 h → versichert (Durchschnitt)", () => {
    const s = nbuStatusAusWochenstunden([8]);
    expect(s).toMatchObject({ versichert: true, regel: "durchschnitt", gearbeiteteWochen: 1, wochenAb8h: 1 });
    expect(s.durchschnittStundenProWoche).toBe(8);
  });

  it("genau 8,0 h aus Stempelzeit (08:00–16:00) → versichert", () => {
    const s = nbuStatusAusStempel([sommer("2026-09-08", "08:00", "16:00")], 2026, 9);
    expect(s).toMatchObject({ versichert: true, regel: "durchschnitt", gearbeiteteWochen: 1, wochenAb8h: 1 });
  });

  it("7,99 h → nicht versichert", () => {
    const s = nbuStatusAusWochenstunden([7.99]);
    expect(s).toMatchObject({ versichert: false, regel: "keine", gearbeiteteWochen: 1, wochenAb8h: 0 });
    // Anzeige rundet ab: nie «Ø 8.0 h … (unter 8 h)»
    expect(nbuBegruendung(s)).toBe("nicht versichert — Ø 7.9 h pro Arbeitswoche (unter 8 h)");
  });

  it("7 h 59 min aus Stempelzeit → nicht versichert", () => {
    const s = nbuStatusAusStempel([sommer("2026-09-08", "08:00", "15:59")], 2026, 9);
    expect(s.versichert).toBe(false);
    expect(s.durchschnittStundenProWoche).toBeCloseTo(479 / 60, 6);
  });

  it("8 h verteilt auf zwei Tage derselben Woche zaehlen zusammen", () => {
    const s = nbuStatusAusStempel([
      sommer("2026-09-08", "08:00", "12:00"),
      sommer("2026-09-10", "13:00", "17:00"),
    ], 2026, 9);
    expect(s).toMatchObject({ versichert: true, gearbeiteteWochen: 1 });
  });
});

describe("Wochen ueber eine Monatsgrenze", () => {
  // Woche 29.06.–05.07.2026: Donnerstag 02.07. → gehoert zum Juli.
  const juniJuli: NbuStempelEintrag[] = [
    sommer("2026-06-30", "08:00", "12:00"), // Di (Juni)
    sommer("2026-07-01", "08:00", "12:00"), // Mi (Juli)
  ];

  it("die Woche zaehlt ganz (8 h) in jedem Zeitraum, der den Juli enthaelt", () => {
    for (const monat of [7, 8, 9]) {
      expect(nbuStatusAusStempel(juniJuli, 2026, monat)).toMatchObject({ versichert: true, gearbeiteteWochen: 1, wochenAb8h: 1 });
    }
  });

  it("…aber nicht im Juni-Zeitraum (April–Juni): genau einmal zugeordnet", () => {
    expect(nbuStatusAusStempel(juniJuli, 2026, 6)).toMatchObject({ versichert: false, gearbeiteteWochen: 0, regel: "keine" });
  });

  it("Woche 28.09.–04.10. (Donnerstag 01.10.) zaehlt fuer Oktober, nicht fuer September", () => {
    const e = [sommer("2026-09-28", "08:00", "12:00"), sommer("2026-10-01", "08:00", "12:00")];
    expect(nbuStatusAusStempel(e, 2026, 9).gearbeiteteWochen).toBe(0);
    expect(nbuStatusAusStempel(e, 2026, 10)).toMatchObject({ versichert: true, gearbeiteteWochen: 1 });
  });

  it("Woche 27.07.–02.08. innerhalb des Zeitraums wird nicht in zwei Teilwochen zerlegt", () => {
    const e = [sommer("2026-07-31", "08:00", "12:00"), sommer("2026-08-01", "08:00", "12:00")];
    const wochen = stempelMinutenJeWoche(e);
    expect(Array.from(wochen.entries())).toEqual([["2026-07-27", 480]]);
    expect(nbuStatusAusStempel(e, 2026, 8)).toMatchObject({ versichert: true, gearbeiteteWochen: 1, wochenAb8h: 1 });
  });

  it("Schicht So 23:00 → Mo 01:00 verteilt sich auf beide Wochen (lokale Zeit)", () => {
    const e = [{ start: zh("2026-09-27", "23:00", 2), ende: zh("2026-09-28", "01:00", 2) }];
    expect(Array.from(stempelMinutenJeWoche(e).entries())).toEqual([["2026-09-21", 60], ["2026-09-28", 60]]);
  });
});

describe("Sommerzeitwechsel (gezaehlt wird die echt gearbeitete Zeit)", () => {
  it("29.03.2026: 01:00–09:00 lokal = nur 7 h (Uhr springt vor) → nicht versichert", () => {
    const e = [{ start: zh("2026-03-29", "01:00", 1), ende: zh("2026-03-29", "09:00", 2) }];
    expect(Array.from(stempelMinutenJeWoche(e).entries())).toEqual([["2026-03-23", 420]]);
    expect(nbuStatusAusStempel(e, 2026, 3)).toMatchObject({ versichert: false, gearbeiteteWochen: 1 });
  });

  it("gleiche Uhrzeiten eine Woche vorher (ohne Wechsel) = 8 h → versichert", () => {
    const e = [{ start: zh("2026-03-22", "01:00", 1), ende: zh("2026-03-22", "09:00", 1) }];
    expect(nbuStatusAusStempel(e, 2026, 3)).toMatchObject({ versichert: true, gearbeiteteWochen: 1 });
  });

  it("25.10.2026: 01:00–08:00 lokal = 8 h (Uhr springt zurueck) → versichert", () => {
    const e = [{ start: zh("2026-10-25", "01:00", 2), ende: zh("2026-10-25", "08:00", 1) }];
    expect(Array.from(stempelMinutenJeWoche(e).entries())).toEqual([["2026-10-19", 480]]);
    expect(nbuStatusAusStempel(e, 2026, 10)).toMatchObject({ versichert: true, gearbeiteteWochen: 1 });
  });
});

describe("Durchschnitt nur ueber gearbeitete Wochen", () => {
  it("nur eine lange Woche in 3 Monaten → versichert (Durchschnitt dieser Woche)", () => {
    const e = [
      sommer("2026-08-10", "07:00", "17:00"), // 10 h
      sommer("2026-08-11", "07:00", "17:00"), // 10 h
      sommer("2026-08-12", "07:00", "17:00"), // 10 h
    ];
    const s = nbuStatusAusStempel(e, 2026, 9);
    expect(s).toMatchObject({ versichert: true, regel: "durchschnitt", gearbeiteteWochen: 1, wochenAb8h: 1 });
    expect(s.durchschnittStundenProWoche).toBe(30);
  });

  it("eine lange Woche (20 h) + vier kurze (je 2 h) → Ø 5.6 h, Minderheit → nicht versichert", () => {
    const s = nbuStatusAusWochenstunden([20, 2, 2, 2, 2]);
    expect(s).toMatchObject({ versichert: false, regel: "keine", gearbeiteteWochen: 5, wochenAb8h: 1 });
    expect(s.durchschnittStundenProWoche).toBeCloseTo(5.6, 6);
  });

  it("eine sehr lange Woche hebt den Schnitt ueber 8 h, obwohl die meisten Wochen kurz sind", () => {
    expect(nbuStatusAusWochenstunden([20, 2, 2])).toMatchObject({ versichert: true, regel: "durchschnitt", wochenAb8h: 1 });
  });

  it("Wochen ohne Stempelzeit zaehlen nicht mit", () => {
    expect(nbuStatusAusWochenstunden([0, 0, 9, 0])).toMatchObject({ versichert: true, gearbeiteteWochen: 1 });
  });
});

describe("Mehrheitsregel (SVV-Empfehlung)", () => {
  it("3 von 5 Wochen >= 8 h, Ø nur 6.2 h → versichert (Mehrheit)", () => {
    const s = nbuStatusAusWochenstunden([9, 9, 9, 2, 2]);
    expect(s).toMatchObject({ versichert: true, regel: "mehrheit", gearbeiteteWochen: 5, wochenAb8h: 3 });
    expect(s.durchschnittStundenProWoche).toBeCloseTo(6.2, 6);
    expect(nbuBegruendung(s)).toBe("versichert — 3 von 5 Arbeitswochen mit mindestens 8 h");
  });

  it("genau die Haelfte (2 von 4) reicht nicht", () => {
    expect(nbuStatusAusWochenstunden([8, 8, 1, 1])).toMatchObject({ versichert: false, regel: "keine", wochenAb8h: 2 });
  });

  it("Mehrheit aus Stempelzeiten ueber drei Monate", () => {
    const e = [
      sommer("2026-07-07", "08:00", "17:00"), // 9 h, Woche 06.07.
      sommer("2026-08-04", "08:00", "17:00"), // 9 h, Woche 03.08.
      sommer("2026-09-08", "08:00", "17:00"), // 9 h, Woche 07.09.
      sommer("2026-09-15", "08:00", "09:00"), // 1 h, Woche 14.09.
      sommer("2026-09-22", "08:00", "09:00"), // 1 h, Woche 21.09.
    ];
    expect(nbuStatusAusStempel(e, 2026, 9)).toMatchObject({ versichert: true, regel: "mehrheit", gearbeiteteWochen: 5, wochenAb8h: 3 });
  });
});

describe("Keine Arbeit", () => {
  it("keine Eintraege → nicht versichert, Abzug 0", () => {
    const s = nbuStatusAusStempel([], 2026, 9);
    expect(s).toEqual({ versichert: false, durchschnittStundenProWoche: 0, gearbeiteteWochen: 0, wochenAb8h: 0, regel: "keine" });
    expect(nbuBegruendung(s)).toBe("nicht versichert — keine Arbeitswoche in den letzten 3 Monaten");
    expect(berechneMitarbeiterAbzuege(0, SAETZE, s).netto).toBe(0);
  });

  it("Arbeit nur ausserhalb des Zeitraums zaehlt nicht", () => {
    const e = [sommer("2026-05-12", "08:00", "18:00")]; // Mai, Zeitraum Sept = Juli–Sept
    expect(nbuStatusAusStempel(e, 2026, 9)).toMatchObject({ versichert: false, gearbeiteteWochen: 0 });
  });

  it("leere Wochenliste", () => {
    expect(nbuStatusAusWochenstunden([])).toMatchObject({ versichert: false, regel: "keine" });
  });
});

describe("Eintraege ohne clock_out / ungueltige Eintraege", () => {
  it("offene Eintraege (noch eingestempelt) zaehlen nicht", () => {
    const e: NbuStempelEintrag[] = [
      { start: zh("2026-09-08", "06:00", 2), ende: null },
      { start: zh("2026-09-09", "06:00", 2), ende: undefined },
    ];
    expect(nbuStatusAusStempel(e, 2026, 9)).toMatchObject({ versichert: false, gearbeiteteWochen: 0 });
  });

  it("Ende vor Start wird ignoriert, gueltige Eintraege zaehlen weiter", () => {
    const e: NbuStempelEintrag[] = [
      { start: zh("2026-09-08", "17:00", 2), ende: zh("2026-09-08", "08:00", 2) }, // verkehrt
      { start: zh("2026-09-09", "06:00", 2), ende: null },                        // offen
      sommer("2026-09-10", "08:00", "16:00"),                                   // 8 h
    ];
    expect(nbuStatusAusStempel(e, 2026, 9)).toMatchObject({ versichert: true, gearbeiteteWochen: 1 });
  });

  it("Date- und Millisekunden-Eingaben funktionieren wie ISO-Strings", () => {
    const start = new Date(zh("2026-09-08", "08:00", 2));
    const e: NbuStempelEintrag[] = [{ start, ende: start.getTime() + 8 * 3_600_000 }];
    expect(nbuStatusAusStempel(e, 2026, 9).versichert).toBe(true);
  });
});

describe("Abzuege mit NBU-Regel", () => {
  it("mitNbuRegel: nicht versichert → NBU 0 %, versichert → unveraendert", () => {
    expect(mitNbuRegel(SAETZE, { versichert: false }).nbuPct).toBe(0);
    expect(mitNbuRegel(SAETZE, { versichert: true })).toBe(SAETZE);
    // Andere Saetze bleiben unberuehrt (AG-Praemie BU unveraendert)
    expect(mitNbuRegel(SAETZE, { versichert: false }).employerBuPct).toBe(0.18);
  });

  it("Lohnabrechnung: Brutto 676.87, versichert → Netto 623.74 (7.85 %)", () => {
    const a = berechneMitarbeiterAbzuege(676.87, SAETZE, { versichert: true });
    expect(a.totalPct).toBeCloseTo(7.85, 6);
    expect(a.zeilen.find((z) => z.schluessel === "NBU")?.betrag).toBeCloseTo(9.81, 2);
    expect(a.netto).toBeCloseTo(623.74, 2);
  });

  it("Lohnabrechnung: Brutto 676.87, nicht versichert → kein NBU, Netto 633.55 (6.40 %)", () => {
    const a = berechneMitarbeiterAbzuege(676.87, SAETZE, { versichert: false });
    expect(a.totalPct).toBeCloseTo(6.4, 6);
    expect(a.zeilen.find((z) => z.schluessel === "NBU")).toEqual({ schluessel: "NBU", pct: 0, betrag: 0 });
    expect(a.netto).toBeCloseTo(633.55, 2);
    expect(a.total + a.netto).toBeCloseTo(676.87, 6);
  });

  it("Begruendung fuer versichert nach Durchschnitt + Anzeige-Rundung", () => {
    expect(nbuBegruendung(nbuStatusAusWochenstunden([9.46, 9.46]))).toBe("versichert — Ø 9.4 h pro Arbeitswoche");
    expect(fmtNbuStunden(7.96)).toBe("7.9");
    expect(fmtNbuStunden(8)).toBe("8.0");
    expect(fmtNbuStunden(3.25)).toBe("3.2");
  });
});

describe("Mehrere Monate aus einer Wochen-Map", () => {
  it("rollierender Zeitraum: dieselben Wochen, je Monat eigener Status", () => {
    const wochen = stempelMinutenJeWoche([
      sommer("2026-06-09", "08:00", "18:00"), // 10 h, Juni
      sommer("2026-09-08", "08:00", "10:00"), // 2 h, September
    ]);
    expect(nbuStatusFuerMonat(wochen, 2026, 7)).toMatchObject({ versichert: true, gearbeiteteWochen: 1 });  // Mai–Juli
    expect(nbuStatusFuerMonat(wochen, 2026, 8)).toMatchObject({ versichert: true, gearbeiteteWochen: 1 });  // Juni–Aug
    expect(nbuStatusFuerMonat(wochen, 2026, 9)).toMatchObject({ versichert: false, gearbeiteteWochen: 1 }); // Juli–Sept
  });
});

// ---------------------------------------------------------------------------
// Lade-Funktion mit nachgebautem Supabase-Client (keine DB)
// ---------------------------------------------------------------------------

type Zeile = { id: string; user_id: string; clock_in: string; clock_out: string | null };
type Aufruf = { methode: string; args: unknown[] };

function fakeClient(zeilen: Zeile[], fehler?: string): { client: SupabaseClient; aufrufe: Aufruf[] } {
  const aufrufe: Aufruf[] = [];
  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  for (const methode of ["select", "in", "not", "gte", "lt", "order"]) {
    builder[methode] = (...args: unknown[]) => {
      aufrufe.push({ methode, args });
      return builder;
    };
  }
  builder.range = (...args: unknown[]) => {
    aufrufe.push({ methode: "range", args });
    const [von, bis] = args as [number, number];
    return Promise.resolve(fehler
      ? { data: null, error: { message: fehler } }
      : { data: zeilen.slice(von, bis + 1), error: null });
  };
  const client = {
    from: (tabelle: string) => {
      aufrufe.push({ methode: "from", args: [tabelle] });
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, aufrufe };
}

describe("ladeNbuStatus (Stempelzeiten aus time_entries)", () => {
  it("fragt nur abgeschlossene Eintraege im gepufferten Zeitraum ab", async () => {
    const { client, aufrufe } = fakeClient([]);
    await ladeNbuStatusFuerMonat(client, "p1", 2026, 9);
    expect(aufrufe).toContainEqual({ methode: "from", args: ["time_entries"] });
    expect(aufrufe).toContainEqual({ methode: "select", args: ["id, user_id, clock_in, clock_out"] });
    expect(aufrufe).toContainEqual({ methode: "in", args: ["user_id", ["p1"]] });
    expect(aufrufe).toContainEqual({ methode: "not", args: ["clock_out", "is", null] });
    expect(aufrufe).toContainEqual({ methode: "gte", args: ["clock_in", "2026-06-26T00:00:00Z"] });
    expect(aufrufe).toContainEqual({ methode: "lt", args: ["clock_in", "2026-10-05T00:00:00Z"] });
  });

  it("laedt seitenweise (mehr als 1000 Zeilen) und ordnet je Person zu", async () => {
    const zeilen: Zeile[] = [];
    // p1: 1003 kurze Eintraege (je 1 min) in einer Woche → 1003 min ≈ 16.7 h
    for (let i = 0; i < 1003; i++) {
      const start = Date.parse(zh("2026-09-08", "06:00", 2)) + i * 2 * 60_000;
      zeilen.push({ id: `a${i}`, user_id: "p1", clock_in: new Date(start).toISOString(), clock_out: new Date(start + 60_000).toISOString() });
    }
    // p2: 2 h in einer Woche
    zeilen.push({ id: "b1", user_id: "p2", clock_in: zh("2026-09-08", "08:00", 2), clock_out: zh("2026-09-08", "10:00", 2) });
    const { client, aufrufe } = fakeClient(zeilen);
    const ergebnis = await ladeNbuStatus(client, ["p1", "p2", "p3"], [{ jahr: 2026, monat: 9 }]);
    expect(aufrufe.filter((a) => a.methode === "range").map((a) => a.args)).toEqual([[0, 999], [1000, 1999]]);
    expect(ergebnis.get("p1")?.get("2026-09")).toMatchObject({ versichert: true, gearbeiteteWochen: 1 });
    expect(ergebnis.get("p1")?.get("2026-09")?.durchschnittStundenProWoche).toBeCloseTo(1003 / 60, 6);
    expect(ergebnis.get("p2")?.get("2026-09")).toMatchObject({ versichert: false, gearbeiteteWochen: 1 });
    // Person ohne Stempelzeit: nicht versichert
    expect(ergebnis.get("p3")?.get("2026-09")).toMatchObject({ versichert: false, gearbeiteteWochen: 0 });
  });

  it("Ladefehler wird geworfen (nie still «nicht versichert»)", async () => {
    const { client } = fakeClient([], "boom");
    await expect(ladeNbuStatusFuerMonat(client, "p1", 2026, 9)).rejects.toThrow(/Stempelzeiten/);
  });

  it("ohne Personen oder Monate keine Abfrage", async () => {
    const { client, aufrufe } = fakeClient([]);
    expect((await ladeNbuStatus(client, [], [{ jahr: 2026, monat: 9 }])).size).toBe(0);
    expect((await ladeNbuStatus(client, ["p1"], [])).size).toBe(0);
    expect(aufrufe).toEqual([]);
  });
});
