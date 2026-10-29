import { describe, expect, it } from "vitest";
import {
  adresse,
  antwortZuordnung,
  berechneAbgleich,
  eingangFenster,
  gesendetFenster,
  istAntwortBetreff,
  istAutoAntwort,
  istBounce,
  ndrAdressen,
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
    mail_conversation_id: null,
    graph_message_id: null,
    letzte_antwort_am: null,
    letzte_antwort_betreff: null,
    antworten_anzahl: 0,
    antwort_graph_ids: [],
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

const BETREFF = "Ihr Stand an der Blickfang Basel 2027";
const T0 = "2026-11-02T08:00:00Z";

describe("Hilfsfunktionen", () => {
  it("normalisiert Adressen", () => {
    expect(adresse("Max Muster <Max.Muster@Firma.CH>")).toBe("max.muster@firma.ch");
    expect(adresse(" mailto:info@x.ch ")).toBe("info@x.ch");
    expect(adresse(null)).toBe("");
  });

  it("erkennt Unzustellbares — auch von der eigenen Domain, nicht «verzögert»", () => {
    const m = (von: string, betreff: string) => ({ von, betreff });
    expect(istBounce(m("postmaster@outlook.com", "x"))).toBe(true);
    expect(istBounce(m("MAILER-DAEMON@mx.ch", "x"))).toBe(true);
    expect(istBounce(m("postmaster@eventline-basel.com", "Unzustellbar: Ihr Stand"))).toBe(true);
    expect(istBounce(m("MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@eventline-basel.com", "Undeliverable: x"))).toBe(true);
    expect(istBounce(m("a@b.ch", "Undelivered Mail Returned to Sender"))).toBe(true);
    expect(istBounce(m("postmaster@eventline-basel.com", "Zustellung verzögert: Ihr Stand"))).toBe(false);
    expect(istBounce(m("a@b.ch", "AW: Hallo"))).toBe(false);
  });

  it("erkennt Auto-Antworten, auch hinter Präfixen", () => {
    expect(istAutoAntwort("Automatische Antwort: Ihr Stand")).toBe(true);
    expect(istAutoAntwort("AW: Automatische Antwort: Ihr Stand")).toBe(true);
    expect(istAutoAntwort("Abwesenheit bis 3.11.")).toBe(true);
    expect(istAutoAntwort("Ich bin nicht im Büro")).toBe(true);
    expect(istAutoAntwort("Out of Office: bis 3.11.")).toBe(true);
    expect(istAutoAntwort("AW: Ihr Stand")).toBe(false);
  });

  it("Antwort-Betreff = Präfix + Original", () => {
    expect(istAntwortBetreff("AW: Ihr Stand an der Blickfang Basel 2027", BETREFF)).toBe(true);
    expect(istAntwortBetreff("RE: AW:  ihr stand an der blickfang basel 2027", BETREFF)).toBe(true);
    expect(istAntwortBetreff("Ihr Stand an der Blickfang Basel 2027", BETREFF)).toBe(false);
    expect(istAntwortBetreff("AW: Rechnung 4711", BETREFF)).toBe(false);
    expect(istAntwortBetreff("WG: Ihr Stand an der Blickfang Basel 2027", BETREFF)).toBe(false);
  });

  it("liest Empfänger aus einer Unzustellbarkeits-Meldung (ohne eigene Domain/Mailsysteme)", () => {
    const text = "Ihre Nachricht an info@firma-x.ch konnte nicht zugestellt werden.\nVon: leo@eventline-basel.com\npostmaster@mx.firma-x.ch";
    expect(ndrAdressen(text)).toEqual(["info@firma-x.ch"]);
  });
});

describe("Gesendet erkennen", () => {
  const sent = [{ id: "S1", conversationId: "C1", betreff: "  ihr stand an der blickfang basel 2027 ", an: ["INFO@Firma.ch"], gesendetAm: T0 }];

  it("setzt gesendet, Konversation und Graph-ID", () => {
    const [a] = berechneAbgleich([kontakt({ id: "1", mail_an: "info@firma.ch", mail_betreff: BETREFF })], sent, []);
    expect(a.felder).toMatchObject({ mail_gesendet_am: T0, mail_conversation_id: "C1", graph_message_id: "S1" });
    expect(a.status).toEqual({ von: "geplant", nach: "gesendet" });
  });

  it("anderer Betreff oder Empfänger → nichts", () => {
    expect(berechneAbgleich([kontakt({ id: "1", mail_an: "info@firma.ch", mail_betreff: "Anderes" })], sent, [])).toEqual([]);
    expect(berechneAbgleich([kontakt({ id: "1", mail_an: "x@firma.ch", mail_betreff: BETREFF })], sent, [])).toEqual([]);
  });

  it("manueller Status bleibt, Versandzeit wird trotzdem notiert", () => {
    const [a] = berechneAbgleich([kontakt({ id: "1", status: "anrufen", status_manuell: true, mail_an: "info@firma.ch", mail_betreff: BETREFF })], sent, []);
    expect(a.status).toBeUndefined();
    expect(a.felder.mail_gesendet_am).toBe(T0);
  });

  it("schon gesendet, aber ohne Konversation → Konversation nachtragen, Zeit bleibt", () => {
    const k = [kontakt({ id: "1", status: "gesendet", mail_an: "info@firma.ch", mail_betreff: BETREFF, mail_gesendet_am: "2026-11-01T07:00:00Z" })];
    const [a] = berechneAbgleich(k, sent, []);
    expect(a.felder).toEqual({ mail_conversation_id: "C1", graph_message_id: "S1" });
    expect(a.status).toBeUndefined();
  });
});

describe("Antworten erkennen", () => {
  const basis = [
    kontakt({ id: "a", status: "gesendet", mail_an: "info@alpha.ch", email: "ceo@alpha.ch", mail_betreff: BETREFF, mail_gesendet_am: T0, mail_conversation_id: "CA" }),
    kontakt({ id: "b", status: "gesendet", mail_an: "info@beta.ch", mail_betreff: BETREFF, mail_gesendet_am: T0 }),
  ];

  it("gleiche Konversation → geantwortet, auch von anderer Adresse derselben Firma", () => {
    const r = berechneAbgleich(basis, [], [{ id: "M1", conversationId: "CA", von: "assistenz@alpha.ch", betreff: "AW: Messe", empfangenAm: "2026-11-03T09:00:00Z" }]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: "a", status: { von: "gesendet", nach: "geantwortet" } });
    expect(r[0].felder).toMatchObject({ antworten_anzahl: 1, letzte_antwort_betreff: "AW: Messe", antwort_graph_ids: ["M1"] });
  });

  it("Newsletter vom Kontakt (andere Konversation, kein Antwort-Betreff) zählt NICHT", () => {
    expect(berechneAbgleich(basis, [], [{ conversationId: "X", von: "info@alpha.ch", betreff: "Newsletter November", empfangenAm: "2026-11-03T09:00:00Z" }])).toEqual([]);
    expect(berechneAbgleich(basis, [], [{ von: "info@beta.ch", betreff: "Rechnung 4711", empfangenAm: "2026-11-03T09:00:00Z" }])).toEqual([]);
  });

  it("Rückfall: exakte Adresse + Antwort-Betreff", () => {
    const r = berechneAbgleich(basis, [], [{ id: "M2", von: "info@beta.ch", betreff: `AW: ${BETREFF}`, empfangenAm: "2026-11-03T09:00:00Z" }]);
    expect(r.map((a) => a.id)).toEqual(["b"]);
  });

  it("nie über die Domain zuordnen", () => {
    expect(berechneAbgleich(basis, [], [{ von: "max@beta.ch", betreff: `AW: ${BETREFF}`, empfangenAm: "2026-11-03T09:00:00Z" }])).toEqual([]);
  });

  it("interne Mails, Mailsysteme und Auto-Antworten zählen nicht — auch in der Konversation", () => {
    const m = (von: string, betreff: string) => [{ conversationId: "CA", von, betreff, empfangenAm: "2026-11-03T09:00:00Z" }];
    expect(berechneAbgleich(basis, [], m("mischa@eventline-basel.com", "AW: Messe"))).toEqual([]);
    expect(berechneAbgleich(basis, [], m("info@alpha.ch", "Automatische Antwort: Messe"))).toEqual([]);
  });

  it("Mail vor dem Versand zählt nicht", () => {
    expect(berechneAbgleich(basis, [], [{ conversationId: "CA", von: "info@alpha.ch", betreff: "AW", empfangenAm: "2026-11-01T09:00:00Z" }])).toEqual([]);
  });

  it("eine Erstmail an mehrere Kontakte: nur der Absender gilt", () => {
    const zwei = [
      kontakt({ id: "x", mail_an: "x@x.ch", mail_gesendet_am: T0, mail_conversation_id: "CM" }),
      kontakt({ id: "y", mail_an: "y@y.ch", mail_gesendet_am: T0, mail_conversation_id: "CM" }),
    ];
    const zu = antwortZuordnung(zwei);
    expect(zu({ conversationId: "CM", von: "y@y.ch", betreff: "AW", empfangenAm: "2026-11-03T09:00:00Z" }).map((k) => k.id)).toEqual(["y"]);
    expect(zu({ conversationId: "CM", von: "z@z.ch", betreff: "AW", empfangenAm: "2026-11-03T09:00:00Z" })).toEqual([]);
  });

  it("manueller Status bleibt, Antwort wird gezählt", () => {
    const k = [kontakt({ id: "m", status: "termin", status_manuell: true, mail_an: "info@m.ch", mail_betreff: BETREFF, mail_gesendet_am: T0, mail_conversation_id: "CMM" })];
    const [a] = berechneAbgleich(k, [], [{ conversationId: "CMM", von: "info@m.ch", betreff: "AW", empfangenAm: "2026-11-04T09:00:00Z" }]);
    expect(a.status).toBeUndefined();
    expect(a.felder.antworten_anzahl).toBe(1);
  });

  it("idempotent: zweiter Lauf mit denselben Mails ändert nichts", () => {
    const eingang = [
      { id: "R1", conversationId: "CA", von: "info@alpha.ch", betreff: "AW 1", empfangenAm: "2026-11-03T09:00:00Z" },
      { id: "R2", conversationId: "CA", von: "info@alpha.ch", betreff: "AW 2", empfangenAm: "2026-11-04T09:00:00Z" },
    ];
    const erst = berechneAbgleich(basis, [], eingang);
    expect(erst[0].felder).toMatchObject({ antworten_anzahl: 2, letzte_antwort_betreff: "AW 2", antwort_graph_ids: ["R1", "R2"] });
    expect(berechneAbgleich(anwenden(basis, erst), [], eingang)).toEqual([]);
  });

  it("in einem Lauf gesendet UND beantwortet", () => {
    const k = [kontakt({ id: "n", mail_an: "info@neu.ch", mail_betreff: BETREFF })];
    const [a] = berechneAbgleich(
      k,
      [{ id: "S9", conversationId: "CN", betreff: BETREFF, an: ["info@neu.ch"], gesendetAm: "2026-11-05T08:00:00Z" }],
      [{ id: "R9", conversationId: "CN", von: "info@neu.ch", betreff: "AW", empfangenAm: "2026-11-05T10:00:00Z" }],
    );
    expect(a.status).toEqual({ von: "geplant", nach: "geantwortet" });
    expect(a.felder).toMatchObject({ mail_gesendet_am: "2026-11-05T08:00:00Z", antworten_anzahl: 1 });
  });
});

describe("Nicht zustellbar", () => {
  // 62 Mails mit demselben Betreff (Messe-Realität): Zuordnung über Konversation/Empfänger.
  const k = [
    kontakt({ id: "x", status: "gesendet", mail_an: "info@x.ch", mail_betreff: BETREFF, mail_gesendet_am: T0, mail_conversation_id: "CX" }),
    kontakt({ id: "y", status: "gesendet", mail_an: "info@y.ch", mail_betreff: BETREFF, mail_gesendet_am: T0, mail_conversation_id: "CY" }),
  ];

  it("Meldung von der EIGENEN Domain, Zuordnung über die Konversation", () => {
    const [a] = berechneAbgleich(k, [], [{ conversationId: "CX", von: "postmaster@eventline-basel.com", betreff: `Unzustellbar: ${BETREFF}`, empfangenAm: "2026-11-02T08:05:00Z" }]);
    expect(a).toMatchObject({ id: "x", status: { von: "gesendet", nach: "unzustellbar" } });
    expect(a.felder.antworten_anzahl).toBeUndefined();
  });

  it("Zuordnung über den Empfänger im Meldungstext", () => {
    const [a] = berechneAbgleich(k, [], [{ von: "MAILER-DAEMON@mx.y.ch", betreff: "Undelivered Mail Returned to Sender", empfangenAm: "2026-11-02T08:05:00Z", ndrEmpfaenger: ["info@y.ch"] }]);
    expect(a).toMatchObject({ id: "y", status: { nach: "unzustellbar" } });
  });

  it("mehrdeutig oder ohne Hinweis → nichts", () => {
    expect(berechneAbgleich(k, [], [{ von: "postmaster@outlook.com", betreff: `Undeliverable: ${BETREFF}`, empfangenAm: "2026-11-02T08:05:00Z" }])).toEqual([]);
    expect(berechneAbgleich(k, [], [{ von: "postmaster@outlook.com", betreff: "Undeliverable", empfangenAm: "2026-11-02T08:05:00Z", ndrEmpfaenger: ["info@x.ch", "info@y.ch"] }])).toEqual([]);
  });

  it("«Zustellung verzögert» ändert nichts", () => {
    expect(berechneAbgleich(k, [], [{ conversationId: "CX", von: "postmaster@eventline-basel.com", betreff: `Zustellung verzögert: ${BETREFF}`, empfangenAm: "2026-11-02T08:05:00Z" }])).toEqual([]);
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
  it("Gesendet: nie mehr als 45 Tage zurück", () => {
    const k = [{ ...kontakt({ id: "1", mail_an: "a@a.ch", mail_betreff: "x" }), mail_geplant_am: "2026-05-01T07:00:00Z" }];
    expect(gesendetFenster(k, jetzt)).toBe("2026-09-26T12:00:00.000Z");
  });
  it("Eingang: ab letztem Sync minus 2 Tage, nie nach einem neu erkannten Versand, max. 45 Tage", () => {
    const k = [kontakt({ id: "1", mail_gesendet_am: "2026-10-01T08:00:00Z" })];
    expect(eingangFenster(k, null, [], jetzt)).toBe("2026-10-01T08:00:00.000Z");
    expect(eingangFenster(k, "2026-11-10T12:00:00Z", [], jetzt)).toBe("2026-11-08T12:00:00.000Z");
    expect(eingangFenster(k, "2026-11-10T12:00:00Z", ["2026-11-05T08:00:00Z"], jetzt)).toBe("2026-11-05T08:00:00.000Z");
    expect(eingangFenster([kontakt({ id: "2", mail_gesendet_am: "2026-01-01T00:00:00Z" })], null, [], jetzt)).toBe("2026-09-26T12:00:00.000Z");
    expect(eingangFenster([kontakt({ id: "3" })], null, [], jetzt)).toBeNull();
  });
});
