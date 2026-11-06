import { describe, expect, it } from "vitest";
import {
  absenderRolle,
  aktuellerSchritt,
  anfrageAmTag,
  einordnungPruefen,
  gleicherMieter,
  istEventlineAdresse,
  jobZeitraumVerschieben,
  nachAnlage,
  uebergabeVerschieben,
  zuerichIso,
  type TagesAuftrag,
  arbeitAusDb,
  arbeitAusPatch,
  felderAusDb,
  felderErgaenzen,
  felderManuell,
  felderZuDb,
  jobZeitraum,
  kehreUm,
  planeWirkung,
  schrittFuerMailArt,
  type AblaufZustand,
} from "./schritte";
import { FELDER_LEER } from "./typen";

const T = "2026-11-05T09:05:00.000Z";

function z(p: Partial<AblaufZustand> = {}): AblaufZustand {
  return { erledigt: [], fixiert_am: null, unterschrieben_am: null, felder: { ...FELDER_LEER }, quelle: {}, jobStatus: "anfrage", ...p };
}

describe("Schritte", () => {
  it("aktueller Schritt = kleinster offener", () => {
    expect(aktuellerSchritt([])).toBe(1);
    expect(aktuellerSchritt([1, 2])).toBe(3);
    expect(aktuellerSchritt([2])).toBe(1);
    expect(aktuellerSchritt([1, 2, 3, 4, 5])).toBe(5);
  });

  it("Mail-Arten: Vertrag nur mit Anhang, nie Schritt 5", () => {
    expect(schrittFuerMailArt("konditionen_an_kunde", 0)).toBe(1);
    expect(schrittFuerMailArt("vertrag_an_kunde", 0)).toBeNull();
    expect(schrittFuerMailArt("vertrag_an_kunde", 4)).toBe(3);
    expect(schrittFuerMailArt("vertrag_unterschrieben", 1)).toBe(4);
    expect(schrittFuerMailArt("zusage_kunde", 0)).toBeNull();
  });

  it("Bestätigung erledigt 1+2, fixiert, Auftrag → offen; Rückgängig stellt alles her", () => {
    const g = planeWirkung(z(), { erledigen: 2 }, T);
    expect(g.neu.erledigt).toEqual([1, 2]);
    expect(g.neu.fixiert_am).toBe(T);
    expect(g.jobStatus).toBe("offen");
    const r = kehreUm({ ...z(), ...g.neu, jobStatus: "offen" }, g.wirkung);
    expect(r.neu.erledigt).toEqual([]);
    expect(r.neu.fixiert_am).toBeNull();
    expect(r.jobStatus).toBe("anfrage");
  });

  it("Unterschrift setzt unterschrieben_am; zweite gleiche Mail ist leer", () => {
    const g = planeWirkung(z({ erledigt: [1, 2, 3], fixiert_am: T, jobStatus: "offen" }), { erledigen: 4 }, T);
    expect(g.wirkung).toEqual({ erledigt_plus: [4], unterschrieben: true });
    const g2 = planeWirkung({ ...z(), ...g.neu, jobStatus: "offen" }, { erledigen: 4 }, T);
    expect(g2.leer).toBe(true);
  });

  it("zurück auf 3 öffnet 3–5 und nimmt die Unterschrift zurück", () => {
    const g = planeWirkung(z({ erledigt: [1, 2, 3, 4], unterschrieben_am: T, fixiert_am: T, jobStatus: "offen" }), { zurueck: 3 }, T);
    expect(g.neu.erledigt).toEqual([1, 2]);
    expect(g.neu.unterschrieben_am).toBeNull();
    expect(g.neu.fixiert_am).toBe(T);
    const r = kehreUm({ ...z(), ...g.neu, jobStatus: "offen" }, g.wirkung);
    expect(r.neu.erledigt).toEqual([1, 2, 3, 4]);
    expect(r.neu.unterschrieben_am).toBe(T);
  });
});

describe("Felder", () => {
  it("KI ergänzt nur leere und nie manuelle Felder", () => {
    const f = { ...FELDER_LEER, mieter: "Christina", gaeste: "70" };
    const a = felderErgaenzen(f, { gaeste: "manuell" }, { email: "c@bluewin.ch", mieter: "Andere", disco: true });
    expect(a.neu).toEqual({ email: "c@bluewin.ch", disco: true });
    expect(a.felder.mieter).toBe("Christina");
    const b = felderErgaenzen(f, { gaeste: "manuell" }, { gaeste: "90" });
    expect(b.neu).toEqual({});
  });

  it("KI setzt ein manuell auf «nein» gesetztes Ja/Nein-Feld nicht", () => {
    const a = felderErgaenzen({ ...FELDER_LEER }, { disco: "manuell" }, { disco: true });
    expect(a.neu).toEqual({});
  });

  it("Rückgängig der Ergänzung lässt spätere manuelle Änderung stehen", () => {
    const a = felderErgaenzen({ ...FELDER_LEER }, {}, { email: "c@bluewin.ch", gaeste: "70" });
    const m = felderManuell(a.felder, a.quelle, { gaeste: "80" });
    const g = planeWirkung(z(), { felder: a }, T);
    const r = kehreUm({ ...z(), felder: m.felder, quelle: m.quelle }, g.wirkung);
    expect(r.neu.felder.email).toBe("");
    expect(r.neu.felder.gaeste).toBe("80");
    expect(r.neu.quelle.gaeste).toBe("manuell");
    expect(r.neu.quelle.email).toBeUndefined();
  });

  it("DB-Rundreise mit Herkunft; ungültige Werte fallen weg", () => {
    const db = felderZuDb({ ...FELDER_LEER, datum: "2026-11-27", disco: true }, { datum: "mail" });
    const back = felderAusDb({ ...db, beginn: "18 Uhr", email: "kaputt" });
    expect(back.felder.datum).toBe("2026-11-27");
    expect(back.felder.disco).toBe(true);
    expect(back.felder.beginn).toBe("18:00");
    expect(back.felder.email).toBe("");
    expect(back.quelle).toEqual({ datum: "mail" });
  });

  it("Übergabe-Haken/Poller: DB-Rundreise, KI-Ergänzung fasst sie nie an, PATCH validiert", () => {
    const db = felderZuDb({ ...FELDER_LEER, mieter: "Anna Muster" }, {}, { uebergabe_haken: ["Raum", "inv:Gläser"], poller_freigeschaltet: true });
    expect(arbeitAusDb(db)).toEqual({ uebergabe_haken: ["Raum", "inv:Gläser"], poller_freigeschaltet: true });
    // Formularfelder kennen die Schlüssel nicht → die KI sieht/setzt sie nicht
    const f = felderAusDb(db);
    expect(f.felder).not.toHaveProperty("uebergabe_haken");
    const e = felderErgaenzen(f.felder, f.quelle, { uebergabe_haken: ["x"], poller_freigeschaltet: false } as never);
    expect(e.neu).toEqual({});
    expect(arbeitAusDb({ uebergabe_haken: "Raum", poller_freigeschaltet: "ja" })).toEqual({ uebergabe_haken: [], poller_freigeschaltet: false });
    expect(arbeitAusPatch({ uebergabe_haken: ["Raum", "Raum"] })).toEqual({ arbeit: { uebergabe_haken: ["Raum"] } });
    expect(arbeitAusPatch({ uebergabe_haken: [1] })).toHaveProperty("fehler");
    expect(arbeitAusPatch({ poller_freigeschaltet: "ja" })).toHaveProperty("fehler");
    expect(arbeitAusPatch({ felder: {} })).toEqual({ arbeit: {} });
  });

  it("Zeitraum in Zürcher Zeit (Winter)", () => {
    expect(jobZeitraum({ datum: "2026-11-27", beginn: "18:00" })).toEqual({
      start_date: "2026-11-27T17:00:00.000Z",
      end_date: "2026-11-27T22:59:00.000Z",
    });
  });
});

describe("Rückgängig normalisiert (M7)", () => {
  it("a) Schritt 2 (fixiert) zurück, Schritt 3 danach per Mail bleibt → 1..3 erledigt, Datum bleibt fixiert", () => {
    const g1 = planeWirkung(z(), { erledigen: 2 }, T); // plus [1,2], fixiert
    const s1 = { ...z(), ...g1.neu, jobStatus: "offen" as const };
    const g2 = planeWirkung(s1, { erledigen: 3 }, T); // plus [3]
    const r = kehreUm({ ...s1, ...g2.neu }, g1.wirkung);
    expect(r.neu.erledigt).toEqual([1, 2, 3]);
    expect(r.neu.fixiert_am).toBe(T);
    expect(r.jobStatus).toBeNull();
  });

  it("b) Unterschrift (1–4) zurück nach «zurück auf 3» → nichts erledigt, nicht fixiert, unterschrieben weg, Anfrage", () => {
    const g1 = planeWirkung(z(), { erledigen: 4 }, T); // plus [1..4], unterschrieben, fixiert
    const s1 = { ...z(), ...g1.neu, jobStatus: "offen" as const };
    const g2 = planeWirkung(s1, { zurueck: 3 }, T); // minus [3,4], unterschrieben_entfernt
    const r = kehreUm({ ...s1, ...g2.neu }, g1.wirkung);
    expect(r.neu.erledigt).toEqual([]);
    expect(r.neu.fixiert_am).toBeNull();
    expect(r.neu.unterschrieben_am).toBeNull();
    expect(r.jobStatus).toBe("anfrage");
  });

  it("Lücke wird geschlossen; Unterschrift bleibt, solange Schritt 4 erledigt ist", () => {
    const g1 = planeWirkung(z(), { erledigen: 1 }, T); // plus [1]
    const s1 = { ...z(), ...g1.neu };
    const g2 = planeWirkung(s1, { erledigen: 4 }, T); // plus [2,3,4], unterschrieben, fixiert
    const s2 = { ...s1, ...g2.neu, jobStatus: "offen" as const };
    const r = kehreUm(s2, g1.wirkung);
    expect(r.neu.erledigt).toEqual([1, 2, 3, 4]);
    expect(r.neu.unterschrieben_am).toBe(T);
    expect(r.neu.fixiert_am).toBe(T);
    expect(r.jobStatus).toBeNull();
  });

  it("Zusage zurück: bleibt fixiert, wenn ein anderes wirksames Ereignis fixiert hat", () => {
    const g = planeWirkung(z(), { fixieren: true }, T);
    const s = { ...z(), ...g.neu, jobStatus: "offen" as const };
    expect(kehreUm(s, g.wirkung, { fixiertDurchAndere: true }).neu.fixiert_am).toBe(T);
    const r = kehreUm(s, g.wirkung);
    expect(r.neu.fixiert_am).toBeNull();
    expect(r.jobStatus).toBe("anfrage");
  });

  it("War der Auftrag vor der Fixierung schon offen, bleibt er offen", () => {
    const g = planeWirkung(z({ jobStatus: "offen" }), { erledigen: 2 }, T);
    const r = kehreUm({ ...z(), ...g.neu, jobStatus: "offen" }, g.wirkung);
    expect(r.neu.fixiert_am).toBeNull();
    expect(r.jobStatus).toBeNull();
  });
});

describe("Absender (M5/M6)", () => {
  it("EVENTLINE nur bei exakter Domain der reinen Adresse", () => {
    expect(istEventlineAdresse("Leo <LEO@Eventline-Basel.com>")).toBe(true);
    expect(istEventlineAdresse("x@eventline-basel.com.evil.ch")).toBe(false);
    expect(istEventlineAdresse("\"leo@eventline-basel.com\" <boese@gmail.com>")).toBe(false);
    expect(istEventlineAdresse("auftrag@in.eventline-basel.com")).toBe(false);
  });

  it("Rolle: EVENTLINE, Partner der Location, Mieter, fremd", () => {
    const o = { mieterEmail: "anna@bluewin.ch", partnerAdressen: ["basil@barakuba.ch"] };
    expect(absenderRolle("Leo <leo@eventline-basel.com>", o)).toBe("eventline");
    expect(absenderRolle("Basil <Basil@barakuba.ch>", o)).toBe("partner");
    expect(absenderRolle("anna@bluewin.ch", o)).toBe("mieter");
    expect(absenderRolle("spam@example.com", o)).toBe("fremd");
    expect(absenderRolle("spam@example.com", { mieterEmail: "", partnerAdressen: [] })).toBe("fremd");
  });

  it("«an Kunde» nur von EVENTLINE; Zusage/Unterschrift nicht von Fremden; E-Mail nur von EVENTLINE/Partner", () => {
    const f = { email: "neu@x.ch", gaeste: "70" };
    expect(einordnungPruefen({ art: "bestaetigung_an_kunde", felder: f }, "mieter").art).toBe("sonstiges");
    expect(einordnungPruefen({ art: "vertrag_an_kunde", felder: f }, "eventline").art).toBe("vertrag_an_kunde");
    expect(einordnungPruefen({ art: "zusage_kunde", felder: f }, "fremd").art).toBe("sonstiges");
    expect(einordnungPruefen({ art: "zusage_kunde", felder: f }, "mieter").art).toBe("zusage_kunde");
    expect(einordnungPruefen({ art: "vertrag_unterschrieben", felder: f }, "partner").art).toBe("vertrag_unterschrieben");
    expect(einordnungPruefen({ art: "felder_ergaenzung", felder: f }, "mieter").felder).toEqual({ gaeste: "70" });
    expect(einordnungPruefen({ art: "felder_ergaenzung", felder: f }, "partner").felder).toEqual(f);
  });
});

describe("Anfrage am selben Tag (M2/M3/M4)", () => {
  const anna = { emails: ["anna@bluewin.ch"], name: "Anna Muster" };
  const j = (p: Partial<TagesAuftrag>): TagesAuftrag => ({ id: "a", created_at: "2026-11-01T10:00:00Z", hatAblauf: true, emails: [], name: "", ...p });

  it("Mieter-Vergleich über E-Mail oder normalisierten Namen", () => {
    expect(gleicherMieter(anna, { emails: ["ANNA@bluewin.ch"], name: "" })).toBe(true);
    expect(gleicherMieter(anna, { emails: [], name: "Muster,  Anna" })).toBe(true);
    expect(gleicherMieter({ emails: [], name: "Zoë Müller" }, { emails: [], name: "zoe muller" })).toBe(true);
    expect(gleicherMieter(anna, { emails: ["b@x.ch"], name: "Beat Muster" })).toBe(false);
    expect(gleicherMieter({ emails: [], name: "" }, { emails: [], name: "" })).toBe(false);
  });

  it("gleicher Mieter → bestehender Ablauf-Auftrag; anderer Auftrag am Tag → warten; leer → neu", () => {
    expect(anfrageAmTag([j({ id: "A", name: "Anna Muster" })], anna)).toEqual({ art: "bestehend", jobId: "A" });
    expect(anfrageAmTag([j({ id: "A", name: "Beat Keller" })], anna)).toEqual({ art: "warten" });
    expect(anfrageAmTag([j({ id: "A", hatAblauf: false, name: "Anna Muster" })], anna)).toEqual({ art: "warten" });
    expect(anfrageAmTag([j({ id: "A", name: "Anna Muster" }), j({ id: "B", emails: ["anna@bluewin.ch"] })], anna)).toEqual({ art: "warten" });
    expect(anfrageAmTag([j({ id: "A", name: "Anna Muster" }), j({ id: "B", name: "Beat" })], anna)).toEqual({ art: "bestehend", jobId: "A" });
    expect(anfrageAmTag([], anna)).toEqual({ art: "neu" });
  });

  it("gleichzeitig angelegt: der jüngere wird verworfen und geht an den älteren", () => {
    const alt = j({ id: "A", created_at: "2026-11-06T10:00:00.100Z", name: "Anna Muster" });
    const jung = j({ id: "B", created_at: "2026-11-06T10:00:00.200Z", name: "Anna Muster" });
    expect(nachAnlage([alt, jung], "B", anna)).toEqual({ art: "verwerfen", ziel: "A" });
    expect(nachAnlage([alt, jung], "A", anna)).toEqual({ art: "behalten" });
    // gleiche Zeit → id entscheidet, genau einer bleibt
    const x = j({ id: "X", created_at: "2026-11-06T10:00:00Z" });
    const y = j({ id: "Y", created_at: "2026-11-06T10:00:00Z" });
    expect(nachAnlage([x, y], "X", anna)).toEqual({ art: "behalten" });
    expect(nachAnlage([x, y], "Y", anna)).toEqual({ art: "verwerfen", ziel: null });
  });
});

describe("Zeit (L11/L13/M8)", () => {
  it("Offset der konkreten Uhrzeit am Umstellungstag", () => {
    // 29.03.2026: 02:00 → 03:00 (Sommerzeit). 00:30 noch +01:00, 12:00 schon +02:00.
    expect(zuerichIso("2026-03-29", "00:30")).toBe("2026-03-28T23:30:00.000Z");
    expect(zuerichIso("2026-03-29", "12:00")).toBe("2026-03-29T10:00:00.000Z");
    // 25.10.2026: 03:00 → 02:00 (Winterzeit). 00:30 noch +02:00, 23:59 +01:00.
    expect(zuerichIso("2026-10-25", "00:30")).toBe("2026-10-24T22:30:00.000Z");
    expect(zuerichIso("2026-10-25", "23:59")).toBe("2026-10-25T22:59:00.000Z");
  });

  it("Datum/Beginn verschiebt nur den Start, die Dauer bleibt; ohne Ende 23:59", () => {
    const bisher = { start_date: "2026-11-27T17:00:00.000Z", end_date: "2026-11-28T01:00:00.000Z" }; // 8 h
    expect(jobZeitraumVerschieben({ datum: "2026-12-04", beginn: "19:00" }, bisher)).toEqual({
      start_date: "2026-12-04T18:00:00.000Z",
      end_date: "2026-12-05T02:00:00.000Z",
    });
    expect(jobZeitraumVerschieben({ datum: "2026-12-04", beginn: "19:00" }, { start_date: bisher.start_date, end_date: null })).toEqual({
      start_date: "2026-12-04T18:00:00.000Z",
      end_date: "2026-12-04T22:59:00.000Z",
    });
  });

  it("Übergabe zieht mit dem Datum mit (gleiche Zürcher Uhrzeit, auch über die Zeitumstellung)", () => {
    expect(uebergabeVerschieben("2026-10-10T12:00:00.000Z", "2026-11-27")).toBe("2026-11-27T13:00:00.000Z"); // 14:00
  });
});
