// Lohnausweis (Formular 11) und AK 40 — auf der ECHTEN Vorlage und den echten Funktionen.
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  ahvNummer,
  ak40Csv,
  eoTageImJahr,
  franken,
  fuelleLohnausweis,
  ladeVorlage,
  leseCsv,
  lesePersonalien,
  lohnausweisWerte,
  personalienVorlage,
  zahlCh,
  type LohnausweisWerte,
} from "./lohnausweis";
import type { JahreslistenZeile } from "./jahresliste";

const P = "a0000000-0000-4000-8000-000000000015";

function zeile(o: Partial<JahreslistenZeile>): JahreslistenZeile {
  return {
    profile_id: P, arbeitsjahr: 2026, monat: 9, auszahlungsjahr: 2026, auszahlungsdaten: ["2026-10-07"], fassung: 1,
    lohnperiode_von: "2026-09-01", lohnperiode_bis: "2026-09-30", brutto: 0, netto: 0, ahv_lohn: 0, ahv_beitragsfrei: 0, alv_lohn: 0,
    uvg_lohn_nur_bu: 0, uvg_lohn_bu_nbu: 0, quellensteuer: 0, steuerbar: 0, zusatz_steuerbar: 0, zusatz_texte: [], spesen: 0, spesen_texte: [],
    auszahlungsbetrag: 0, abzug_ahv_iv_eo: 0, abzug_alv: 0, abzug_nbu: 0, abzug_bvg: 0, abzug_ktg: 0, ...o,
  };
}

describe("Lohnausweis-Werte", () => {
  const zeilen = [
    zeile({ monat: 8, steuerbar: 1200.45, abzug_ahv_iv_eo: 63.6, abzug_alv: 13.2, abzug_nbu: 17.4, quellensteuer: 0 }),
    zeile({
      monat: 9, steuerbar: 900.5, zusatz_steuerbar: 100, zusatz_texte: ["Quellensteuer vom Arbeitgeber bezahlt"], spesen: 35.5, spesen_texte: ["Verpflegung auswärts"],
      abzug_ahv_iv_eo: 47.75, abzug_alv: 9.9, abzug_nbu: 0, abzug_ktg: 3.1,
    }),
    zeile({ monat: 12, arbeitsjahr: 2025, auszahlungsjahr: 2026, steuerbar: 10 }),
    zeile({ monat: 12, auszahlungsjahr: 2027, steuerbar: 999 }), // anderes Auszahlungsjahr → nicht im Ausweis 2026
  ];
  const w = lohnausweisWerte({
    profileId: P, name: "Sara Huber", jahr: 2026, geburtsdatum: "1995-04-02", zeilen,
    anstellungen: [{ eintritt: "2026-03-09", austritt: null, vertragsart: "abruf_unecht", pensum_pct: null }], eoTage: 3,
  });
  it("Ziffern ganze Franken, 8 = 1 + 7, 11 = 8 − 9 − 10", () => {
    // steuerbar 2110.95 − Zusatz 100 = 2010.95 → 2011; Ziff. 7 = 100
    expect(w.ziffer1).toBe(2011);
    expect(w.ziffer7).toBe(100);
    expect(w.ziffer7Art).toBe("Quellensteuer vom Arbeitgeber bezahlt");
    expect(w.ziffer8).toBe(2111);
    expect(w.ziffer9).toBe(franken(63.6 + 13.2 + 17.4 + 47.75 + 9.9)); // 151.85 → 152
    expect(w.ziffer9).toBe(152);
    expect(w.ziffer11).toBe(2111 - 152);
    expect(w.ziffer13_1_2).toBe(36);
    expect(w.ziffer13Art).toBe("Effektive Spesen: Verpflegung auswärts");
  });
  it("Lohnperiode = Anstellung im Kalenderjahr; Bemerkungen Teilzeit, EO, Krankentaggeld", () => {
    expect([w.von, w.bis]).toEqual(["2026-03-09", "2026-12-31"]);
    expect(w.bemerkungen).toEqual(["Teilzeitbeschäftigung im Stundenlohn", "Lohnfortzahlung/EO: 3 Tage Militär-/Zivildienst", "Beiträge Krankentaggeldversicherung CHF 3"]);
  });
  it("Rundung kaufmännisch, Tausender wie das Formular", () => {
    expect(franken(2.5)).toBe(3);
    expect(franken(-2.5)).toBe(-3);
    expect(franken(2.49)).toBe(2);
    expect(zahlCh(25320)).toBe("25'320");
    expect(zahlCh(-1234567)).toBe("-1'234'567");
  });
  it("EO-Tage: Kalendertage im Jahr, Überschneidungen einmal", () => {
    expect(eoTageImJahr([{ start_date: "2025-12-30", end_date: "2026-01-02" }, { start_date: "2026-01-02", end_date: "2026-01-03" }], 2026)).toBe(3);
  });
});

describe("Personalien-CSV", () => {
  it("AHV-Nummer mit Prüfziffer", () => {
    expect(ahvNummer("7561234567897")).toBe("756.1234.5678.97");
    expect(ahvNummer("756.1234.5678.90")).toBeNull();
    expect(ahvNummer("123")).toBeNull();
  });
  it("Vorlage → ausgefüllt zurück (Excel: «;», BOM, Anführungszeichen)", () => {
    const v = personalienVorlage([{ profile_id: P, name: "Sara Huber", geburtsdatum: "1995-04-02" }]);
    expect(v.startsWith("﻿profile_id;name;ahv_nr")).toBe(true);
    expect(leseCsv(v)[1]).toEqual([P, "Sara Huber", "", "02.04.1995", "", "", "", ""]);
    const ausgefuellt = `﻿profile_id;name;ahv_nr;geburtsdatum;strasse;adresszusatz;plz;ort\r\n${P};"Huber; Sara";7561234567897;02.04.1995;Testweg 3;;4051;Basel\r\nkaputt;x;;;;;;\r\n`;
    const r = lesePersonalien(ausgefuellt);
    expect(r.daten.get(P)).toMatchObject({ name: "Huber; Sara", ahv_nr: "756.1234.5678.97", strasse: "Testweg 3", plz: "4051", ort: "Basel" });
    expect(r.fehler).toHaveLength(1);
    expect(lesePersonalien(`profile_id,ahv_nr\n${P},756.0000.0000.00\n`).fehler[0]).toMatch(/AHV-Nr/);
  });
});

describe("Formular 11 (offizielle ESTV-Vorlage)", () => {
  const w: LohnausweisWerte = {
    profileId: P, name: "Sara Huber", jahr: 2026, von: "2026-03-09", bis: "2026-12-31", geburtsdatum: "1995-04-02",
    ziffer1: 2011, ziffer7: 100, ziffer7Art: "Quellensteuer vom Arbeitgeber bezahlt", ziffer8: 2111, ziffer9: 152, ziffer10_1: 0, ziffer11: 1959,
    ziffer12: 0, ziffer13_1_2: 36, ziffer13Art: "Effektive Spesen: Verpflegung auswärts", bemerkungen: ["Teilzeitbeschäftigung im Stundenlohn"],
    chf: { steuerbar: 0, zusatzSteuerbar: 0, beitraege: 0, bvg: 0, quellensteuer: 0, spesen: 0, ktg: 0 },
  };
  const firma = { name: "EVENTLINE GmbH", street: "Teststrasse 1", zip: "4000", city: "Basel", country: "Schweiz", phone: "000 000 00 00", email: "", website: "", uid_number: "", iban: "" };
  it("Vorlage ist die geprüfte Datei und hat die erwarteten Felder", async () => {
    const v = await ladeVorlage();
    const doc = await PDFDocument.load(v);
    const namen = doc.getForm().getFields().map((f) => f.getName());
    for (const n of ["OptionKreuzOhneRahmen_A", "AHVLinks_C", "TextLinks_C-GebDatum", "TextLinks_D", "TextLinks_E-von", "TextLinks_E-bis", "TextMehrzeiligLinks_Empfaenger",
      "DezZahlNull_1", "TextLinks_7-Art", "DezZahlNull_7", "DezZahlNull_8", "DezZahlNull_9", "DezZahlNull_10_1", "DezZahlNull_11", "DezZahlNull_12",
      "TextLinks_13_1_2-Art", "DezZahlNull_13_1_2", "TextLinks_15_1", "TextLinks_15_2", "TextLinks_I", "TextMehrzeiligLinks_Bestaetigung"]) {
      expect(namen).toContain(n);
    }
  });
  it("befüllt und flach (ohne Personalien: Platzhalter)", async () => {
    const { pdf, hinweise } = await fuelleLohnausweis(await ladeVorlage(), w, null, { firma, zustaendig: "Admin Test", datum: "2027-01-15" });
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getForm().getFields()).toHaveLength(0); // flach
    expect(hinweise).toEqual(expect.arrayContaining(["AHV-Nr. fehlt", "Adresse fehlt"]));
  });
  it("mit Personalien keine Platzhalter", async () => {
    const { hinweise } = await fuelleLohnausweis(await ladeVorlage(), w, { profile_id: P, ahv_nr: "756.1234.5678.97", strasse: "Testweg 3", plz: "4051", ort: "Basel" }, { firma, zustaendig: null, datum: "2027-01-15" });
    expect(hinweise).toEqual([]);
  });
});

describe("AK 40", () => {
  it("CSV mit BOM, «;», Punkt-Dezimal", () => {
    const csv = ak40Csv(2026, [{ profile_id: P, name: "Jonas Frei", ahv_nr: null, geburtsdatum: null, von: "2026-03-09", bis: "2026-12-31", ahv_lohn: 2475, ahv_beitragsfrei: 2475, alv_lohn: 2475 }]);
    expect(csv.startsWith("﻿AHV-Nr.;Name")).toBe(true);
    expect(csv).toContain(";Jonas Frei;;09.03.2026;31.12.2026;2475.00;2475.00;0.00;2475.00;");
  });
});
