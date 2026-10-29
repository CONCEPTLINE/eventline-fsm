// Tests auf dem ECHTEN Rechenkern (keine kopierte Logik).
import { describe, expect, it } from "vitest";
import {
  KernFehler,
  auszahlungsdatumNachRegel,
  feiertageBaselStadtJahre,
  ferienPctNachAlter,
  ganzeWochen,
  jahresEinsaetze,
  rechneMonat,
  rundeChf,
  stempelBereich,
  type Firmensatz,
  type Lohnzeile,
  type MonatsEingabe,
  type Stempel,
} from "./index";

const SATZ_2026: Firmensatz = {
  gueltigAb: "2026-03-09",
  an: { ahvIvEo: 5.3, alv: 1.1, nbu: 1.45, bvg: 0, ktg: 0, quellensteuer: 0 },
  ag: { ahvIvEo: 5.3, alv: 1.1, fak: 1.35, bu: 0.5742, bvg: 0, verwaltung: 0.11 },
  bvgSchwelleMonat: 1890,
};
const SATZ_2027: Firmensatz = {
  gueltigAb: "2027-01-01",
  an: { ahvIvEo: 5.3, alv: 1.1, nbu: 1.44, bvg: 0, ktg: 0, quellensteuer: 0 },
  ag: { ahvIvEo: 5.3, alv: 1.1, fak: 1.35, bu: 0.5829, bvg: 0, verwaltung: 0.11 },
  bvgSchwelleMonat: 1920,
};

function zeile(ab: string, lohn: number, bis: string | null = null, extra: Partial<Lohnzeile> = {}): Lohnzeile {
  return { id: `z-${ab}`, gueltigAb: ab, gueltigBis: bis, stundenlohn: lohn, stundenlohnArt: "inkl_ferien", ferienPctFix: null, ohneLohn: false, eigeneSaetze: null, ...extra };
}

/** Stempel in Ortszeit Zürich (Sommer +02:00, Winter +01:00). */
function s(start: string, ende: string | null): Stempel {
  return { start, ende };
}

function eingabe(over: Partial<MonatsEingabe> & Pick<MonatsEingabe, "jahr" | "monat" | "stempel">): MonatsEingabe {
  return {
    person: { geburtsdatum: "1990-01-01", anstellungen: [{ eintritt: "2026-03-09", austritt: null }], ahvVerlangtJahre: [] },
    lohnzeilen: [zeile("2026-03-09", 26)],
    firmensaetze: [SATZ_2026, SATZ_2027],
    feiertage: feiertageBaselStadtJahre(2025, 2027),
    auszahlungsdatum: auszahlungsdatumNachRegel(over.jahr, over.monat, 5, feiertageBaselStadtJahre(2025, 2028)),
    ...over,
  };
}

const pos = (r: ReturnType<typeof rechneMonat>, art: string) => r.positionen.filter((p) => p.lohnart === art);

describe("Rundung", () => {
  it("kaufmännisch auf 5 Rappen, einmal", () => {
    expect(rundeChf(1.123)).toBe(1.1);
    expect(rundeChf(1.125)).toBe(1.15);
    expect(rundeChf(23.99114)).toBe(24);
    expect(rundeChf(0.024)).toBe(0);
    expect(rundeChf(-1.125)).toBe(-1.15);
  });
});

describe("Normalfall", () => {
  it("12 h zu 26.00 inkl. 8,33 % Ferien: Stundenlohn, 1. August, Ferien", () => {
    const r = rechneMonat(eingabe({ jahr: 2026, monat: 9, stempel: [s("2026-09-07T08:00:00+02:00", "2026-09-07T20:00:00+02:00")] }));
    expect(r.mengen.minuten).toBe(720);
    const normal = pos(r, "normal")[0];
    expect(normal.minuten).toBe(720);
    expect(normal.ansatz!).toBeCloseTo(26 / 1.0833, 10);
    expect(normal.betrag).toBe(288);
    expect(pos(r, "feiertag_1aug")[0].betrag).toBe(1.1);
    expect(pos(r, "ferien")[0].betrag).toBe(24);
    expect(r.brutto).toBe(313.1);
    // Abzüge nach Sätzen am Auszahlungsdatum (7.10.2026 → 2026)
    expect(r.auszahlungsdatum).toBe("2026-10-07");
    const ahv = r.abzuege.find((a) => a.art === "ahv_iv_eo")!;
    expect(ahv.betrag).toBe(rundeChf(313.1 * 0.053));
    expect(r.netto).toBe(Number((r.brutto - r.totalAbzuege).toFixed(2)));
  });

  it("Lohnerhöhung mitten im Monat: Lohn tageweise", () => {
    const r = rechneMonat(eingabe({
      jahr: 2026,
      monat: 9,
      lohnzeilen: [zeile("2026-03-09", 26, "2026-09-14"), zeile("2026-09-15", 28)],
      stempel: [
        s("2026-09-10T08:00:00+02:00", "2026-09-10T14:00:00+02:00"),
        s("2026-09-16T08:00:00+02:00", "2026-09-16T14:00:00+02:00"),
      ],
    }));
    const n = pos(r, "normal");
    expect(n).toHaveLength(2);
    expect(n.map((p) => p.minuten)).toEqual([360, 360]);
    // inkl. Ferien zusammen = 6 × 26 + 6 × 28 = 324 (statt 12 × 28 = 336)
    const ohneAug = r.positionen.filter((p) => p.lohnart !== "feiertag_1aug").reduce((a, p) => a + p.betrag, 0);
    expect(ohneAug).toBeCloseTo(324, 1);
  });
});

describe("Sonntag und Nacht", () => {
  it("Sa 21:00 → So 05:00: Sonntag ab Sa 23 Uhr, eine Nacht", () => {
    const r = rechneMonat(eingabe({ jahr: 2026, monat: 8, stempel: [s("2026-08-08T21:00:00+02:00", "2026-08-09T05:00:00+02:00")] }));
    expect(r.mengen.minuten).toBe(480);
    expect(r.mengen.sonntagMinutenMitZuschlag).toBe(360);
    expect(r.mengen.nachtMinutenMitZuschlag).toBe(360);
    expect(r.mengen.naechte).toHaveLength(1);
    expect(r.mengen.naechte[0].datum).toBe("2026-08-08");
    expect(r.mengen.sonntage.map((x) => x.datum)).toEqual(["2026-08-09"]);
  });

  it("So 20:00 → Mo 00:30: Sonntag nur bis 23 Uhr", () => {
    const r = rechneMonat(eingabe({ jahr: 2026, monat: 8, stempel: [s("2026-08-16T20:00:00+02:00", "2026-08-17T00:30:00+02:00")] }));
    expect(r.mengen.sonntagMinutenMitZuschlag).toBe(180);
    expect(r.mengen.nachtMinutenMitZuschlag).toBe(90);
    expect(r.mengen.naechte.map((x) => x.datum)).toEqual(["2026-08-16"]);
  });

  it("Feiertag wie Sonntag (Vortag 23 Uhr), 1. August zählt mit", () => {
    // Sa 1.8.2026 18:00–23:30: bis 23 Uhr Bundesfeiertag, ab 23 Uhr schon Sonntag 2.8.
    const r = rechneMonat(eingabe({ jahr: 2026, monat: 8, stempel: [s("2026-08-01T18:00:00+02:00", "2026-08-01T23:30:00+02:00")] }));
    expect(r.mengen.sonntagMinutenMitZuschlag).toBe(330);
    expect(r.mengen.sonntage.map((x) => [x.datum, x.name, x.minutenImMonat])).toEqual([["2026-08-01", "Bundesfeiertag", 300], ["2026-08-02", "Sonntag", 30]]);
  });

  it("Schicht über Mitternacht und Jahreswechsel: Nacht gehört ins Jahr des Abends", () => {
    const st = [s("2026-12-31T22:00:00+01:00", "2027-01-01T04:00:00+01:00")];
    const dez = rechneMonat(eingabe({ jahr: 2026, monat: 12, stempel: st }));
    const jan = rechneMonat(eingabe({ jahr: 2027, monat: 1, stempel: st, lohnzeilen: [zeile("2026-03-09", 26)] }));
    expect(dez.mengen.naechte.map((x) => x.datum)).toEqual(["2026-12-31"]);
    expect(jan.mengen.naechte.map((x) => x.datum)).toEqual(["2026-12-31"]);
    expect(dez.mengen.nachtMinutenMitZuschlag + jan.mengen.nachtMinutenMitZuschlag).toBe(300);
    // 31.12. 23:00 – 1.1. 23:00 ist Neujahr (Feiertag)
    expect(dez.mengen.sonntage.map((x) => x.datum)).toEqual(["2027-01-01"]);
    // Dezember-Lohn wird im Januar 2027 ausbezahlt → Sätze 2027
    expect(dez.auszahlungsjahr).toBe(2027);
    expect(dez.saetze.firmensatzAb).toBe("2027-01-01");
  });

  it("ab der 25. Nacht Zeitzuschlag 10 % statt Geld, ab dem 7. Sonntag kein Zuschlag", () => {
    const st: Stempel[] = [];
    // 30 Nächte Mo und Mi 23:00–01:00 ab 5.1.2026 (keine Sonn-/Feiertage berührt)
    let d = new Date(Date.UTC(2026, 0, 5));
    while (st.length < 30) {
      const wt = d.getUTCDay();
      if (wt === 1 || wt === 3) {
        const iso = d.toISOString().slice(0, 10);
        const tz = iso >= "2026-03-29" ? "+02:00" : "+01:00";
        const next = new Date(d.getTime() + 86400000).toISOString().slice(0, 10);
        st.push(s(`${iso}T23:00:00${tz}`, `${next}T01:00:00${tz}`));
      }
      d = new Date(d.getTime() + 86400000);
    }
    // 8 Sonntage 10–12 Uhr
    for (const so of ["2026-05-03", "2026-05-10", "2026-05-17", "2026-05-24", "2026-05-31", "2026-06-07", "2026-06-14", "2026-06-21"]) {
      st.push(s(`${so}T10:00:00+02:00`, `${so}T12:00:00+02:00`));
    }
    const pers = { geburtsdatum: "1990-01-01", anstellungen: [{ eintritt: "2026-01-01", austritt: null }], ahvVerlangtJahre: [] };
    const lz = [zeile("2026-01-01", 26)];
    const fs = [{ ...SATZ_2026, gueltigAb: "2026-01-01" }, SATZ_2027];
    const april = rechneMonat(eingabe({ jahr: 2026, monat: 4, stempel: st, person: pers, lohnzeilen: lz, firmensaetze: fs }));
    expect(april.mengen.naechteImJahrVorMonat).toBeGreaterThan(0);
    const alle = jahresEinsaetze(st, pers.anstellungen, feiertageBaselStadtJahre(2026, 2026), 2026);
    expect(alle.naechte).toHaveLength(30);
    expect(alle.naechte.filter((n) => n.mitZuschlag)).toHaveLength(24);
    expect(alle.sonntage.filter((n) => n.mitZuschlag)).toHaveLength(6);
    const juni = rechneMonat(eingabe({ jahr: 2026, monat: 6, stempel: st, person: pers, lohnzeilen: lz, firmensaetze: fs }));
    expect(juni.mengen.sonntagMinutenOhneZuschlag).toBe(240); // 7. und 8. Sonntag
    const ueber = [april, rechneMonat(eingabe({ jahr: 2026, monat: 3, stempel: st, person: pers, lohnzeilen: lz, firmensaetze: fs }))];
    expect(ueber.some((r) => r.mengen.zeitzuschlagMinuten > 0)).toBe(true);
  });
});

describe("Ferienzuschlag nach Alter", () => {
  it("10,64 % bis und mit dem Monat des 20. Geburtstags", () => {
    expect(ferienPctNachAlter("2006-07-15", 2026, 7)).toBe(10.64);
    expect(ferienPctNachAlter("2006-07-15", 2026, 8)).toBe(8.33);
    expect(ferienPctNachAlter("2006-07-15", 2026, 6)).toBe(10.64);
  });
  it("Geburtsdatum fehlt → Fehler (kein stilles 8,33 %)", () => {
    expect(() =>
      rechneMonat(eingabe({ jahr: 2026, monat: 9, person: { geburtsdatum: null, anstellungen: null, ahvVerlangtJahre: [] }, stempel: [s("2026-09-07T08:00:00+02:00", "2026-09-07T10:00:00+02:00")] })),
    ).toThrow(KernFehler);
  });
});

describe("NBU nach 7/87", () => {
  function wochen(stundenProWoche: number, von: string, anzahl: number): Stempel[] {
    const out: Stempel[] = [];
    let d = new Date(`${von}T00:00:00Z`);
    for (let i = 0; i < anzahl; i++) {
      const iso = d.toISOString().slice(0, 10);
      const min = Math.round(stundenProWoche * 60);
      const start = new Date(`${iso}T08:00:00+02:00`).getTime();
      out.push({ start: new Date(start).toISOString(), ende: new Date(start + min * 60000).toISOString() });
      d = new Date(d.getTime() + 7 * 86400000);
    }
    return out;
  }
  it("jede Woche 7.75 h → nicht versichert, 8.25 h → versichert", () => {
    const unter = rechneMonat(eingabe({ jahr: 2026, monat: 9, stempel: wochen(7.75, "2026-06-01", 18) }));
    const ueber = rechneMonat(eingabe({ jahr: 2026, monat: 9, stempel: wochen(8.25, "2026-06-01", 18) }));
    expect(unter.nbu.versichert).toBe(false);
    expect(unter.abzuege.find((a) => a.art === "nbu")!.betrag).toBe(0);
    expect(ueber.nbu.versichert).toBe(true);
    expect(ueber.abzuege.find((a) => a.art === "nbu")!.prozent).toBe(1.45);
  });
  it("Arbeitswochen zählen nur, wenn sie überwiegen", () => {
    // eine grosse Woche (42.5 h) in 3 Monaten: Arbeitswochen überwiegen nicht → alle Wochen
    const st = [s("2026-06-08T08:00:00+02:00", "2026-06-08T16:30:00+02:00"), s("2026-06-09T08:00:00+02:00", "2026-06-09T16:30:00+02:00"), s("2026-06-10T08:00:00+02:00", "2026-06-10T16:30:00+02:00"), s("2026-06-11T08:00:00+02:00", "2026-06-11T16:30:00+02:00"), s("2026-06-12T08:00:00+02:00", "2026-06-12T16:30:00+02:00")];
    const r = rechneMonat(eingabe({ jahr: 2026, monat: 6, stempel: st }));
    const v3 = r.nbu.varianten[0];
    expect(v3.nurArbeitswochen).toBe(false);
    expect(v3.arbeitswochen).toBe(1);
    expect(r.nbu.versichert).toBe(false);
  });
  it("nur ganze Wochen", () => {
    expect(ganzeWochen("2026-07-01", "2026-09-30")[0]).toBe("2026-07-06");
    expect(ganzeWochen("2026-07-01", "2026-09-30").at(-1)).toBe("2026-09-21");
  });
});

describe("Sätze, Fehler, Hinweise", () => {
  it("fehlende Firmensätze am Auszahlungsdatum → Fehler (keine Ersatzsätze)", () => {
    expect(() => rechneMonat(eingabe({ jahr: 2026, monat: 9, firmensaetze: [{ ...SATZ_2026, gueltigAb: "2026-12-01" }], stempel: [] }))).toThrow(/Firmensätze/);
  });
  it("Lohnzeile mit eigenen Sätzen: fehlender Satz → Fehler", () => {
    const z = zeile("2026-03-09", 29, null, { eigeneSaetze: { an: { ...SATZ_2026.an, quellensteuer: NaN }, ag: SATZ_2026.ag } });
    expect(() => rechneMonat(eingabe({ jahr: 2026, monat: 9, lohnzeilen: [z], stempel: [] }))).toThrow(/quellensteuer/);
  });
  it("Quellensteuer fester Satz aus der Lohnzeile", () => {
    const z = zeile("2026-03-09", 29, null, { eigeneSaetze: { an: { ...SATZ_2026.an, quellensteuer: 10.58 }, ag: SATZ_2026.ag } });
    const r = rechneMonat(eingabe({ jahr: 2026, monat: 9, lohnzeilen: [z], stempel: [s("2026-09-07T08:00:00+02:00", "2026-09-07T16:00:00+02:00")] }));
    expect(r.abzuege.find((a) => a.art === "quellensteuer")!.betrag).toBe(rundeChf(r.brutto * 0.1058));
    expect(r.hinweise.some((h) => h.code === "quellensteuer")).toBe(true);
  });
  it("Stempel ohne Lohnzeile → Fehler", () => {
    expect(() => rechneMonat(eingabe({ jahr: 2026, monat: 9, lohnzeilen: [zeile("2026-09-15", 26)], stempel: [s("2026-09-07T08:00:00+02:00", "2026-09-07T10:00:00+02:00")] }))).toThrow(/keine Lohnzeile/);
  });
  it("überlappende Stempel zählen einmal, offener Stempel nicht", () => {
    const r = rechneMonat(eingabe({ jahr: 2026, monat: 9, stempel: [s("2026-09-11T08:00:00+02:00", "2026-09-11T12:00:00+02:00"), s("2026-09-11T11:30:00+02:00", "2026-09-11T13:00:00+02:00"), s("2026-09-12T08:00:00+02:00", null)] }));
    expect(r.mengen.minuten).toBe(300);
    expect(r.hinweise.map((h) => h.code)).toEqual(expect.arrayContaining(["ueberlappung", "offener_stempel"]));
  });
  it("vor Eintritt nicht bezahlt", () => {
    const r = rechneMonat(eingabe({ jahr: 2026, monat: 9, person: { geburtsdatum: "1990-01-01", anstellungen: [{ eintritt: "2026-09-10", austritt: null }], ahvVerlangtJahre: [] }, stempel: [s("2026-09-07T08:00:00+02:00", "2026-09-07T10:00:00+02:00"), s("2026-09-11T08:00:00+02:00", "2026-09-11T10:00:00+02:00")] }));
    expect(r.mengen.minuten).toBe(120);
    expect(r.lohnperiode).toEqual({ von: "2026-09-10", bis: "2026-09-30" });
    expect(r.hinweise.some((h) => h.code === "ausserhalb_anstellung")).toBe(true);
  });
  it("Sommerzeit-Ende: Nacht 25.10. 00–06 Uhr = 7 h", () => {
    const r = rechneMonat(eingabe({ jahr: 2026, monat: 10, stempel: [s("2026-10-25T00:00:00+02:00", "2026-10-25T06:00:00+01:00")] }));
    expect(r.mengen.minuten).toBe(420);
  });
  it("2'500-Grenze nach Auszahlungsjahr", () => {
    const r = rechneMonat(eingabe({ jahr: 2026, monat: 9, bisher: { ahvLohn: 2300, alvLohn: 2300, uvgLohn: 2300 }, stempel: [s("2026-09-07T08:00:00+02:00", "2026-09-07T16:00:00+02:00")] }));
    expect(r.ahv2500.status).toBe("ueberschritten");
    const v = rechneMonat(eingabe({ jahr: 2026, monat: 9, person: { geburtsdatum: "1990-01-01", anstellungen: null, ahvVerlangtJahre: [2026] }, stempel: [s("2026-09-07T08:00:00+02:00", "2026-09-07T10:00:00+02:00")] }));
    expect(v.ahv2500.status).toBe("verlangt");
  });
});

describe("Auszahlung und Stempel-Bereich", () => {
  it("5. Arbeitstag des Folgemonats", () => {
    const ft = feiertageBaselStadtJahre(2026, 2027);
    expect(auszahlungsdatumNachRegel(2026, 11, 5, ft)).toBe("2026-12-07");
    expect(auszahlungsdatumNachRegel(2026, 12, 5, ft)).toBe("2027-01-08");
  });
  it("Januar braucht das ganze Vorjahr, sonst 12 Monate zurück", () => {
    expect(stempelBereich(2027, 1).von <= "2026-01-01").toBe(true);
    expect(stempelBereich(2026, 10).von <= "2025-11-01").toBe(true);
    expect(stempelBereich(2026, 10).bis).toBe("2026-11-01");
  });
});
