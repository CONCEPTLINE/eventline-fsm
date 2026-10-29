import { describe, expect, it } from "vitest";
import {
  adresse,
  berechneAbgleich,
  eingangFenster,
  gesendetFenster,
  istAutoAntwort,
  istBounce,
  type KontaktAenderung,
  type SyncKontakt,
} from "./mail-sync";

function kontakt(teil: Partial<SyncKontakt> & { id: string }): SyncKontakt {
  return {
    status: "geplant",
    status_manuell: false,
    email: null,
    mail_an: null,
    mail_betreff: null,
    mail_gesendet_am: null,
    letzte_antwort_am: null,
    letzte_antwort_betreff: null,
    antworten_anzahl: 0,
    ...teil,
  };
}

/** Änderungen auf die Kontakte anwenden (wie die DB es täte). */
function anwenden(kontakte: SyncKontakt[], aenderungen: KontaktAenderung[]): SyncKontakt[] {
  return kontakte.map((k) => {
    const a = aenderungen.find((x) => x.id === k.id);
    if (!a) return k;
    return { ...k, ...a.felder, ...(a.status ? { status: a.status.nach } : {}) };
  });
}

const BETREFF = "Ihr Messeauftritt 2027 – EVENTLINE";

describe("Hilfsfunktionen", () => {
  it("normalisiert Adressen", () => {
    expect(adresse("Max Muster <Max.Muster@Firma.CH>")).toBe("max.muster@firma.ch");
    expect(adresse(" mailto:info@x.ch ")).toBe("info@x.ch");
    expect(adresse(null)).toBe("");
  });
  it("erkennt Unzustellbares und Auto-Antworten", () => {
    expect(istBounce({ von: "postmaster@outlook.com", betreff: "x", empfangenAm: "2026-11-01T10:00:00Z" })).toBe(true);
    expect(istBounce({ von: "MAILER-DAEMON@mx.ch", betreff: "x", empfangenAm: "2026-11-01T10:00:00Z" })).toBe(true);
    expect(istBounce({ von: "a@b.ch", betreff: "Unzustellbar: Hallo", empfangenAm: "2026-11-01T10:00:00Z" })).toBe(true);
    expect(istBounce({ von: "a@b.ch", betreff: "AW: Hallo", empfangenAm: "2026-11-01T10:00:00Z" })).toBe(false);
    expect(istAutoAntwort("Automatische Antwort: Ihr Messeauftritt")).toBe(true);
    expect(istAutoAntwort("Out of Office: bis 3.11.")).toBe(true);
    expect(istAutoAntwort("AW: Ihr Messeauftritt")).toBe(false);
  });
});

describe("Gesendet erkennen", () => {
  const sent = [{ betreff: "  ihr messeauftritt 2027 – eventline ", an: ["INFO@Firma.ch"], gesendetAm: "2026-11-02T08:00:00Z" }];

  it("setzt gesendet (Adresse/Betreff Gross-klein egal)", () => {
    const k = [kontakt({ id: "1", mail_an: "info@firma.ch", mail_betreff: BETREFF })];
    const [a] = berechneAbgleich(k, sent, []);
    expect(a.felder.mail_gesendet_am).toBe("2026-11-02T08:00:00Z");
    expect(a.status).toEqual({ von: "geplant", nach: "gesendet" });
  });

  it("anderer Betreff oder Empfänger → nichts", () => {
    expect(berechneAbgleich([kontakt({ id: "1", mail_an: "info@firma.ch", mail_betreff: "Anderes" })], sent, [])).toEqual([]);
    expect(berechneAbgleich([kontakt({ id: "1", mail_an: "x@firma.ch", mail_betreff: BETREFF })], sent, [])).toEqual([]);
  });

  it("manueller Status bleibt, Versandzeit wird trotzdem notiert", () => {
    const k = [kontakt({ id: "1", status: "anrufen", status_manuell: true, mail_an: "info@firma.ch", mail_betreff: BETREFF })];
    const [a] = berechneAbgleich(k, sent, []);
    expect(a.status).toBeUndefined();
    expect(a.felder.mail_gesendet_am).toBe("2026-11-02T08:00:00Z");
  });

  it("schon gesendet → keine Änderung", () => {
    const k = [kontakt({ id: "1", status: "gesendet", mail_an: "info@firma.ch", mail_betreff: BETREFF, mail_gesendet_am: "2026-11-02T08:00:00Z" })];
    expect(berechneAbgleich(k, sent, [])).toEqual([]);
  });
});

describe("Antworten erkennen", () => {
  const basis = [
    kontakt({ id: "a", status: "gesendet", mail_an: "info@alpha.ch", email: "ceo@alpha.ch", mail_betreff: BETREFF, mail_gesendet_am: "2026-11-02T08:00:00Z" }),
    kontakt({ id: "b", status: "gesendet", mail_an: "info@beta.ch", mail_betreff: BETREFF, mail_gesendet_am: "2026-11-02T08:00:00Z" }),
    kontakt({ id: "c", status: "gesendet", mail_an: "verkauf@beta.ch", mail_betreff: BETREFF, mail_gesendet_am: "2026-11-02T08:00:00Z" }),
    kontakt({ id: "g", status: "gesendet", mail_an: "hans@gmail.com", mail_betreff: BETREFF, mail_gesendet_am: "2026-11-02T08:00:00Z" }),
  ];

  it("exakte Adresse (auch über email) → geantwortet", () => {
    const r = berechneAbgleich(basis, [], [{ von: "CEO@alpha.ch", betreff: "AW: Messe", empfangenAm: "2026-11-03T09:00:00Z" }]);
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe("a");
    expect(r[0].status).toEqual({ von: "gesendet", nach: "geantwortet" });
    expect(r[0].felder).toMatchObject({ antworten_anzahl: 1, letzte_antwort_am: "2026-11-03T09:00:00Z", letzte_antwort_betreff: "AW: Messe" });
  });

  it("gleiche Domain nur, wenn eindeutig", () => {
    const eindeutig = berechneAbgleich(basis, [], [{ von: "max@alpha.ch", betreff: "AW", empfangenAm: "2026-11-03T09:00:00Z" }]);
    expect(eindeutig.map((a) => a.id)).toEqual(["a"]);
    const mehrdeutig = berechneAbgleich(basis, [], [{ von: "max@beta.ch", betreff: "AW", empfangenAm: "2026-11-03T09:00:00Z" }]);
    expect(mehrdeutig).toEqual([]);
  });

  it("nie über Gratis-Mailer-Domain zuordnen", () => {
    expect(berechneAbgleich(basis, [], [{ von: "fremd@gmail.com", betreff: "Hallo", empfangenAm: "2026-11-03T09:00:00Z" }])).toEqual([]);
  });

  it("interne Mails und Auto-Antworten zählen nicht", () => {
    const intern = kontakt({ id: "i", status: "gesendet", mail_an: "mischa@eventline-basel.com", mail_betreff: BETREFF, mail_gesendet_am: "2026-11-02T08:00:00Z" });
    expect(berechneAbgleich([intern], [], [{ von: "mischa@eventline-basel.com", betreff: "AW", empfangenAm: "2026-11-03T09:00:00Z" }])).toEqual([]);
    expect(berechneAbgleich(basis, [], [{ von: "info@alpha.ch", betreff: "Automatische Antwort: Messe", empfangenAm: "2026-11-03T09:00:00Z" }])).toEqual([]);
  });

  it("Mail vor dem Versand zählt nicht", () => {
    expect(berechneAbgleich(basis, [], [{ von: "info@alpha.ch", betreff: "AW", empfangenAm: "2026-11-01T09:00:00Z" }])).toEqual([]);
  });

  it("manueller Status bleibt, Antwort wird gezählt", () => {
    const k = [kontakt({ id: "m", status: "termin", status_manuell: true, mail_an: "info@m.ch", mail_betreff: BETREFF, mail_gesendet_am: "2026-11-02T08:00:00Z" })];
    const [a] = berechneAbgleich(k, [], [{ von: "info@m.ch", betreff: "AW", empfangenAm: "2026-11-04T09:00:00Z" }]);
    expect(a.status).toBeUndefined();
    expect(a.felder.antworten_anzahl).toBe(1);
  });

  it("idempotent: zweiter Lauf mit denselben Mails ändert nichts", () => {
    const eingang = [
      { von: "info@alpha.ch", betreff: "AW 1", empfangenAm: "2026-11-03T09:00:00Z" },
      { von: "info@alpha.ch", betreff: "AW 2", empfangenAm: "2026-11-04T09:00:00Z" },
    ];
    const erst = berechneAbgleich(basis, [], eingang);
    expect(erst[0].felder).toMatchObject({ antworten_anzahl: 2, letzte_antwort_betreff: "AW 2" });
    expect(berechneAbgleich(anwenden(basis, erst), [], eingang)).toEqual([]);
  });

  it("in einem Lauf gesendet UND beantwortet", () => {
    const k = [kontakt({ id: "n", status: "geplant", mail_an: "info@neu.ch", mail_betreff: BETREFF })];
    const [a] = berechneAbgleich(
      k,
      [{ betreff: BETREFF, an: ["info@neu.ch"], gesendetAm: "2026-11-05T08:00:00Z" }],
      [{ von: "info@neu.ch", betreff: "AW", empfangenAm: "2026-11-05T10:00:00Z" }],
    );
    expect(a.status).toEqual({ von: "geplant", nach: "geantwortet" });
    expect(a.felder).toMatchObject({ mail_gesendet_am: "2026-11-05T08:00:00Z", antworten_anzahl: 1 });
  });
});

describe("Nicht zustellbar", () => {
  const k = [
    kontakt({ id: "x", status: "gesendet", mail_an: "info@x.ch", mail_betreff: "Messe 2027 – Firma X", mail_gesendet_am: "2026-11-02T08:00:00Z" }),
    kontakt({ id: "y", status: "gesendet", mail_an: "info@y.ch", mail_betreff: "Messe 2027 – Firma Y", mail_gesendet_am: "2026-11-02T08:00:00Z" }),
  ];

  it("eindeutiger Original-Betreff → unzustellbar", () => {
    const [a] = berechneAbgleich(k, [], [{ von: "postmaster@outlook.com", betreff: "Unzustellbar: Messe 2027 – Firma X", empfangenAm: "2026-11-02T08:05:00Z" }]);
    expect(a).toMatchObject({ id: "x", status: { von: "gesendet", nach: "unzustellbar" } });
    expect(a.felder.antworten_anzahl).toBeUndefined();
  });

  it("mehrdeutiger Betreff → nichts", () => {
    const gleich = k.map((c) => ({ ...c, mail_betreff: BETREFF }));
    expect(berechneAbgleich(gleich, [], [{ von: "postmaster@outlook.com", betreff: `Undeliverable: ${BETREFF}`, empfangenAm: "2026-11-02T08:05:00Z" }])).toEqual([]);
  });
});

describe("Suchfenster", () => {
  const jetzt = Date.parse("2026-11-10T12:00:00Z");
  it("Gesendet: ältester Plantermin minus 1 Tag, null wenn nichts offen", () => {
    const k = [
      { ...kontakt({ id: "1", mail_an: "a@a.ch", mail_betreff: "x" }), mail_geplant_am: "2026-11-05T07:00:00Z" },
      { ...kontakt({ id: "2", mail_an: "b@b.ch", mail_betreff: "x" }), mail_geplant_am: "2026-11-20T07:00:00Z" },
    ];
    expect(gesendetFenster(k, jetzt)).toBe("2026-11-04T07:00:00.000Z");
    expect(gesendetFenster([], jetzt)).toBeNull();
  });
  it("Eingang: ab letztem Sync minus 2 Tage, aber nie nach einem neu erkannten Versand", () => {
    const k = [kontakt({ id: "1", mail_gesendet_am: "2026-10-01T08:00:00Z" })];
    expect(eingangFenster(k, null, [])).toBe("2026-10-01T08:00:00.000Z");
    expect(eingangFenster(k, "2026-11-10T12:00:00Z", [])).toBe("2026-11-08T12:00:00.000Z");
    expect(eingangFenster(k, "2026-11-10T12:00:00Z", ["2026-11-05T08:00:00Z"])).toBe("2026-11-05T08:00:00.000Z");
    expect(eingangFenster([kontakt({ id: "2" })], null, [])).toBeNull();
  });
});
