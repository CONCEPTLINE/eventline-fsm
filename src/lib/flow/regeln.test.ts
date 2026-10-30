// Regeln der Trust-flow-Routen: Claims, Stempel-Prüfung, nachträgliche Änderungen, Vergleich, PDF.
import { describe, expect, it } from "vitest";
import { stempelBereich } from "@/lib/lohn/kern";
import { lohnzeileAusRoh, type LohnzeileRoh } from "@/lib/lohn/daten";
import {
  dekodierePdf,
  interneProfile,
  monateDesStempels,
  nachtraeglichGeaendert,
  PERSONEN_ANSTELLUNG_AB,
  personenAuswahl,
  pruefeAblageClaims,
  pruefeAblageKoerper,
  pruefeMonatsClaims,
  pruefeStammdatenClaims,
  sha256Hex,
  STAMMDATEN_ANSATZ_ART,
  stammdatenPerson,
  teileName,
  vergleichAusMomentaufnahme,
  VERGLEICH_BIS,
  zaehleUeberlappungen,
} from "./regeln";
import { P1, P2 } from "./test-hilfen";

const b = stempelBereich(2026, 12);
const monat = (extra: Record<string, unknown> = {}) => ({ jahr: 2026, monat: 12, von: b.von, bis: b.bis, profile: [P1, P2], ...extra });

describe("Claims Stempel/Vergleich", () => {
  it("gültig: Stempel-Bereich wie der Kern, IDs klein", () => {
    const r = pruefeMonatsClaims(monat({ profile: [P1.toUpperCase()] }), { bereich: true });
    expect(r).toEqual({ ok: true, anfrage: { jahr: 2026, monat: 12, profile: [P1], von: b.von, bis: b.bis } });
  });
  it("von/bis weichen vom Kern ab → bereich_abweichend (laut statt mit anderen Stempeln rechnen)", () => {
    expect(pruefeMonatsClaims(monat({ bis: "2027-01-31" }), { bereich: true })).toMatchObject({ ok: false, code: "bereich_abweichend" });
    expect(pruefeMonatsClaims(monat({ von: undefined }), { bereich: false }).ok).toBe(true);
  });
  it("profile: leer, über 50, doppelt, ungültig → 400", () => {
    expect(pruefeMonatsClaims(monat({ profile: [] }), { bereich: true })).toMatchObject({ code: "profile_fehlen", status: 400 });
    const viele = Array.from({ length: 51 }, (_, i) => `a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(pruefeMonatsClaims(monat({ profile: viele }), { bereich: true })).toMatchObject({ code: "profile_zu_viele" });
    expect(pruefeMonatsClaims(monat({ profile: viele.slice(0, 50) }), { bereich: true }).ok).toBe(true);
    expect(pruefeMonatsClaims(monat({ profile: [P1, P1] }), { bereich: true })).toMatchObject({ code: "profile_doppelt" });
    expect(pruefeMonatsClaims(monat({ profile: ["x"] }), { bereich: true })).toMatchObject({ code: "profile_ungueltig" });
    expect(pruefeMonatsClaims(monat({ monat: 13 }), { bereich: true })).toMatchObject({ code: "monat_ungueltig" });
  });
  it("Vergleich nur bis 2026-11 (Parallelmonat), Dezember → 422", () => {
    const nov = stempelBereich(2026, 11);
    expect(pruefeMonatsClaims({ jahr: 2026, monat: 11, von: nov.von, bis: nov.bis, profile: [P1] }, { bereich: false, bis: VERGLEICH_BIS }).ok).toBe(true);
    expect(pruefeMonatsClaims(monat(), { bereich: false, bis: VERGLEICH_BIS })).toMatchObject({ ok: false, code: "monat_nicht_erlaubt", status: 422 });
    expect(pruefeMonatsClaims(monat({ jahr: 2027, monat: 1 }), { bereich: false, bis: VERGLEICH_BIS })).toMatchObject({ code: "monat_nicht_erlaubt" });
  });
});

describe("Personen-Filter /stempel und /lohnabrechnung", () => {
  it("nur interne ERP-Profile aus dem signierten profile — Partner/Lieferanten und unbekannte IDs fallen weg, Reihenfolge bleibt", () => {
    const P3 = "a0000000-0000-4000-8000-000000000013";
    const P4 = "a0000000-0000-4000-8000-000000000099";
    const profile = [
      { id: P2, role: "techniker" },
      { id: P1, role: "admin" },
      { id: P3, role: "partner" },
      { id: "a0000000-0000-4000-8000-000000000014", role: "lieferant" },
    ];
    expect(interneProfile([P2, P3, P4, P1], profile)).toEqual([P2, P1]);
    expect(interneProfile([P3], profile)).toEqual([]);
    expect(interneProfile([P1], [{ id: P1, role: null }])).toEqual([]);
  });
});

describe("Stempel: Monate, Überlappungen, nachträgliche Änderungen", () => {
  it("Monate eines Stempels nach Ortszeit Zürich, Ende exklusiv", () => {
    // 30.11. 22:00 → 1.12. 04:00 Ortszeit
    expect(monateDesStempels("2026-11-30T21:00:00Z", "2026-12-01T03:00:00Z")).toEqual(["2026-11", "2026-12"]);
    // endet genau um Mitternacht (Ende exklusiv) → nur November
    expect(monateDesStempels("2026-11-30T18:00:00Z", "2026-11-30T23:00:00Z")).toEqual(["2026-11"]);
    // 31.12. 23:30 UTC = 1.1. 00:30 Ortszeit
    expect(monateDesStempels("2026-12-31T23:30:00Z", null)).toEqual(["2027-01"]);
  });
  it("Überlappung zählt je Stempel im Monat; Paar aus zwei Altfällen zählt nicht; angrenzend ist keine", () => {
    const s = [
      { start: "2026-12-05T08:00:00Z", ende: "2026-12-05T12:00:00Z", altfall: false },
      { start: "2026-12-05T11:00:00Z", ende: "2026-12-05T14:00:00Z", altfall: false },
      { start: "2026-12-06T08:00:00Z", ende: "2026-12-06T10:00:00Z", altfall: false },
      { start: "2026-12-06T10:00:00Z", ende: "2026-12-06T12:00:00Z", altfall: false },
    ];
    expect(zaehleUeberlappungen(s, "2026-12")).toBe(2);
    expect(zaehleUeberlappungen(s, "2026-11")).toBe(0);
    expect(zaehleUeberlappungen(s.map((x, i) => ({ ...x, altfall: i < 2 })), "2026-12")).toBe(0);
    // offener Stempel überlappt alles danach
    expect(zaehleUeberlappungen([{ start: "2026-12-07T08:00:00Z", ende: null, altfall: false }, { start: "2026-12-08T08:00:00Z", ende: "2026-12-08T09:00:00Z", altfall: false }], "2026-12")).toBe(2);
  });
  it("nachträglich geändert: alt und neu, nur Monate im Stempel-Bereich, je Person/Monat der letzte Zeitpunkt", () => {
    const r = nachtraeglichGeaendert([
      { profileId: P1, occurredAt: "2027-01-10T09:00:00Z", alt: { clock_in: "2026-11-30T21:00:00+00:00", clock_out: "2026-12-01T03:00:00+00:00" }, neu: { clock_in: "2026-11-30T21:00:00+00:00", clock_out: "2026-11-30T22:30:00+00:00" } },
      { profileId: P1, occurredAt: "2027-01-12T09:00:00Z", alt: null, neu: { clock_in: "2026-12-03T08:00:00+00:00", clock_out: "2026-12-03T10:00:00+00:00" } },
      { profileId: P2, occurredAt: "2027-01-11T09:00:00Z", alt: { clock_in: "2025-10-03T08:00:00+00:00", clock_out: "2025-10-03T10:00:00+00:00" }, neu: null },
    ], "2025-11", "2026-12");
    expect(r).toEqual([
      { erp_profil_id: P1, monat: "2026-11", geaendert_at: "2027-01-10T09:00:00.000Z" },
      { erp_profil_id: P1, monat: "2026-12", geaendert_at: "2027-01-12T09:00:00.000Z" },
    ]);
  });
});

describe("Vergleich", () => {
  it("Momentaufnahme → nur Zahlen, Lohnarten und Minuten (keine Bezeichnungen, keine IDs)", () => {
    const v = vergleichAusMomentaufnahme({
      profile_id: P1, fassung: 1, art: "regulaer", kern_version: "2026.11-2", pruefsumme: "ab", auszahlungsdatum: "2026-12-07",
      brutto: "313.10", ahv_lohn: 313.1, alv_lohn: "313.10", uvg_lohn: 313.1, uvg_art: "bu",
      positionen: [{ lohnart: "normal", bezeichnung: "Stundenlohn", minuten: 720, ansatz: 24.0007, betrag: 288 }, { lohnart: "zusatz", bezeichnung: "Bonus Muster", minuten: null, betrag: 50, zusatzpostenId: "z1" }],
      nbu: { versichert: false, massgebend: null, begruendung: "…" },
      bisher: { ahvLohn: 1000, alvLohn: 1000, uvgLohn: 1000 },
    });
    expect(v.brutto).toBe(313.1);
    expect(v.positionen).toEqual([{ lohnart: "normal", minuten: 720, betrag: 288 }, { lohnart: "zusatz", minuten: null, betrag: 50 }]);
    expect(v.nbu).toEqual({ versichert: false, massgebend: null });
    expect(v.bisher).toEqual({ ahv_lohn: 1000, alv_lohn: 1000, uvg_lohn: 1000 });
    expect(JSON.stringify(v)).not.toMatch(/Bonus|Stundenlohn|z1/);
  });
});

describe("Lohnabrechnung aus Bexio (A5)", () => {
  const pdf = Buffer.from("%PDF-1.4\n% Test\n");
  const sha = sha256Hex(pdf);
  const c = (extra: Record<string, unknown> = {}) => ({ erp_profil_id: P1, jahr: 2026, monat: 12, fassung: 1, sha256: sha, ...extra });

  it("Claims: ab Lohnmonat 2026-12, Fassung 1–99, sha256 hex", () => {
    expect(pruefeAblageClaims(c())).toEqual({ ok: true, anfrage: { profileId: P1, jahr: 2026, monat: 12, fassung: 1, sha256: sha } });
    expect(pruefeAblageClaims(c({ monat: 11 }))).toMatchObject({ code: "erp_monat", status: 422 });
    expect(pruefeAblageClaims(c({ fassung: 0 }))).toMatchObject({ code: "fassung_ungueltig" });
    expect(pruefeAblageClaims(c({ sha256: sha.toUpperCase() }))).toMatchObject({ code: "sha256_ungueltig" });
    expect(pruefeAblageClaims(c({ erp_profil_id: "x" }))).toMatchObject({ code: "person_ungueltig" });
  });
  it("Körper { ausweis, pdf_base64 }", () => {
    expect(pruefeAblageKoerper(JSON.stringify({ ausweis: " a.b.c ", pdf_base64: "QQ==" }))).toEqual({ ok: true, ausweis: "a.b.c", pdfBase64: "QQ==" });
    expect(pruefeAblageKoerper("a.b.c")).toMatchObject({ code: "koerper_ungueltig" });
    expect(pruefeAblageKoerper(JSON.stringify({ ausweis: "a.b.c" }))).toMatchObject({ code: "koerper_ungueltig" });
  });
  it("PDF: Base64 streng, Kennung %PDF-, Prüfsumme aus dem Ausweis, höchstens 2 MB", () => {
    const r = dekodierePdf(pdf.toString("base64"), sha);
    expect(r.ok && Buffer.from(r.pdf).equals(pdf)).toBe(true);
    expect(dekodierePdf(pdf.toString("base64"), sha256Hex("anders"))).toMatchObject({ code: "sha256_abweichend", status: 422 });
    expect(dekodierePdf("kein base64!", sha)).toMatchObject({ code: "pdf_ungueltig" });
    const keinPdf = Buffer.from("hallo welt");
    expect(dekodierePdf(keinPdf.toString("base64"), sha256Hex(keinPdf))).toMatchObject({ code: "pdf_ungueltig" });
    const gross = Buffer.alloc(2 * 1024 * 1024 + 10, 0x20);
    gross.write("%PDF-");
    expect(dekodierePdf(gross.toString("base64"), sha256Hex(gross))).toMatchObject({ code: "zu_gross", status: 413 });
  });
});

describe("Stammdaten (A6)", () => {
  it("Claims: nur profile (≤ 50, UUID, ohne Doppel); jahr/monat/von/bis fehlen oder sind beliebig", () => {
    expect(pruefeStammdatenClaims({ profile: [P1.toUpperCase(), P2] })).toEqual({ ok: true, anfrage: { profile: [P1, P2] } });
    expect(pruefeStammdatenClaims({ profile: [P1], jahr: 1999, monat: 13, von: "x", bis: "y" })).toEqual({ ok: true, anfrage: { profile: [P1] } });
    const viele = Array.from({ length: 51 }, (_, i) => `a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(pruefeStammdatenClaims({ profile: viele })).toMatchObject({ ok: false, status: 400, code: "profile_zu_viele" });
    expect(pruefeStammdatenClaims({ profile: viele.slice(0, 50) }).ok).toBe(true);
    expect(pruefeStammdatenClaims({})).toMatchObject({ code: "profile_fehlen" });
    expect(pruefeStammdatenClaims({ profile: [P1, P1] })).toMatchObject({ code: "profile_doppelt" });
    expect(pruefeStammdatenClaims({ profile: ["x"] })).toMatchObject({ code: "profile_ungueltig" });
  });

  it("Name: erstes Wort = Vorname, Rest = Name", () => {
    expect(teileName("  Erika   Muster Beispiel ")).toEqual({ vorname: "Erika", name: "Muster Beispiel" });
    expect(teileName("Muster")).toEqual({ vorname: "", name: "Muster" });
    expect(teileName(null)).toEqual({ vorname: "", name: "" });
  });

  const profil = { id: P1.toUpperCase(), full_name: "Erika Muster", birthdate: "1990-04-01" };
  const lohn = (extra: Record<string, unknown>) => ({
    profile_id: P1, effective_from: "2026-03-09", hourly_wage_chf: "26.50", wage_exempt: false, ferienanteil_pct_override: null,
    uses_standard_lohn: true, quellensteuer_pct: null, nbu_pct: null, bvg_pct: null, ...extra,
  });

  it("Antwortform exakt wie der Import in Trust flow, sortiert, nur eigene Zeilen", () => {
    const p = stammdatenPerson(
      profil,
      [
        { profile_id: P1, eintritt: "2026-10-01", austritt: null, vertragsart: "fest" },
        { profile_id: P1, eintritt: "2026-03-09", austritt: "2026-06-30", vertragsart: "abruf_unecht" },
        { profile_id: P2, eintritt: "2026-03-09", austritt: null, vertragsart: "abruf_echt" },
      ],
      [lohn({ effective_from: "2026-10-01", hourly_wage_chf: 28 }), lohn({}), lohn({ profile_id: P2 })],
    );
    expect(p).toEqual({
      erp_profil_id: P1,
      name: "Muster",
      vorname: "Erika",
      geburtsdatum: "1990-04-01",
      anstellungen: [
        { firma: "eventline", eintritt: "2026-03-09", austritt: "2026-06-30", vertragsart: "stundenlohn" },
        { firma: "eventline", eintritt: "2026-10-01", austritt: null, vertragsart: null },
      ],
      lohnzeilen: [
        { gueltig_ab: "2026-03-09", ansatz: 26.5, standard: true, quellensteuer_pct: null, nbu_pct: null, bvg_pct: null, ansatz_art: "inkl_ferien", ferien_pct: null },
        { gueltig_ab: "2026-10-01", ansatz: 28, standard: true, quellensteuer_pct: null, nbu_pct: null, bvg_pct: null, ansatz_art: "inkl_ferien", ferien_pct: null },
      ],
    });
    expect(Object.keys(p).join(",")).toBe("erp_profil_id,name,vorname,geburtsdatum,anstellungen,lohnzeilen");
    expect(Object.keys(p.lohnzeilen[0]).join(",")).toBe("gueltig_ab,ansatz,standard,quellensteuer_pct,nbu_pct,bvg_pct,ansatz_art,ferien_pct");
    expect(Object.keys(p.anstellungen[0]).join(",")).toBe("firma,eintritt,austritt,vertragsart");
  });

  it("Standard → Sätze null (auch wenn in der Zeile etwas steht); individuell → Quellensteuer/NBU/BVG, nie AHV/ALV/KTG/Arbeitgeber", () => {
    const roh = { quellensteuer_pct: "10.5800", nbu_pct: "1.4500", bvg_pct: "0.0000", ahv_iv_eo_pct: 5.3, alv_pct: 1.1, ktg_pct: 0.5, employer_ahv_pct: 5.3, notes: "x" };
    const [std, ind] = stammdatenPerson(profil, [], [lohn(roh), lohn({ ...roh, effective_from: "2027-01-01", uses_standard_lohn: false })]).lohnzeilen;
    expect(std).toMatchObject({ standard: true, quellensteuer_pct: null, nbu_pct: null, bvg_pct: null });
    expect(ind).toMatchObject({ standard: false, quellensteuer_pct: 10.58, nbu_pct: 1.45, bvg_pct: 0 });
    const text = JSON.stringify(ind);
    for (const verboten of ["ahv", "alv", "ktg", "employer", "notes", "iban", "adresse"]) expect(text).not.toContain(verboten);
  });

  it("«kein Lohn» (wage_exempt) → ansatz null; fehlendes/kaputtes Geburtsdatum → null; unbekannte Vertragsart → null", () => {
    const p = stammdatenPerson({ ...profil, birthdate: null }, [{ profile_id: P1, eintritt: "2026-03-09", austritt: null, vertragsart: "neu" }], [lohn({ wage_exempt: true })]);
    expect(p.lohnzeilen[0].ansatz).toBeNull();
    expect(p.geburtsdatum).toBeNull();
    expect(p.anstellungen[0].vertragsart).toBeNull();
    expect(stammdatenPerson({ ...profil, birthdate: "01.04.1990" }, [], []).geburtsdatum).toBeNull();
  });

  it("ferien_pct: festes Ferien-% der Zeile, unabhängig von standard; sonst null (nach Alter)", () => {
    const [fest, alter, individuell] = stammdatenPerson(profil, [], [
      lohn({ ferienanteil_pct_override: "10.6400" }),
      lohn({ effective_from: "2026-10-01" }),
      lohn({ effective_from: "2027-01-01", uses_standard_lohn: false, ferienanteil_pct_override: 8.33, quellensteuer_pct: 5 }),
    ]).lohnzeilen;
    expect(fest).toMatchObject({ standard: true, ferien_pct: 10.64, quellensteuer_pct: null });
    expect(alter.ferien_pct).toBeNull();
    expect(individuell).toMatchObject({ standard: false, ferien_pct: 8.33, quellensteuer_pct: 5 });
  });

  it("ansatz_art = so, wie der Kern hourly_wage_chf liest (inkl. Ferienzuschlag)", () => {
    const roh = { id: "z", profile_id: P1, hourly_wage_chf: 26, effective_from: "2026-01-01", effective_to: null, uses_standard_lohn: true } as unknown as LohnzeileRoh;
    expect(lohnzeileAusRoh(roh).stundenlohnArt).toBe(STAMMDATEN_ANSATZ_ART);
  });
});

describe("Personen-Auswahl /personen", () => {
  const P3 = "a0000000-0000-4000-8000-000000000013";
  const P4 = "a0000000-0000-4000-8000-000000000014";
  it("aktive interne + inaktive mit laufender Anstellung (aktiv: false); Portal-Zugänge und Ausgetretene fehlen", () => {
    const liste = personenAuswahl(
      [
        { id: P1, full_name: "Zora Beispiel", role: "techniker", is_active: true },
        { id: P2, full_name: "Anna Beispiel", role: "techniker", is_active: false },
        { id: P3, full_name: "Ben Beispiel", role: "techniker", is_active: false },
        { id: P4, full_name: "Carla Partner", role: "partner", is_active: true },
        { id: P1, full_name: "Zora Beispiel", role: "techniker", is_active: true },
      ],
      new Set([P2, P4]),
    );
    expect(liste).toEqual([
      { erp_profil_id: P2, name: "Anna Beispiel", aktiv: false },
      { erp_profil_id: P1, name: "Zora Beispiel", aktiv: true },
    ]);
    expect(PERSONEN_ANSTELLUNG_AB).toBe("2026-12-01");
  });
});
