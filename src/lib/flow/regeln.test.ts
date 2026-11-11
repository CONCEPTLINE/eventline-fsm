// Regeln der Trust-flow-Routen: Claims, Stempel-Prüfung, nachträgliche Änderungen, Vergleich, PDF.
import { describe, expect, it } from "vitest";
import { stempelBereich } from "@/lib/lohn/kern";
import {
  abwesenheitFuerFlow,
  arztzeugnisPfadPasst,
  dekodierePdf,
  interneProfile,
  mimeAusEndung,
  monateDesStempels,
  nachtraeglichGeaendert,
  pruefeAblageClaims,
  pruefeAblageKoerper,
  pruefeAbwesenheitenClaims,
  pruefeArztzeugnisClaims,
  pruefeMonatsClaims,
  pruefeSaetzeClaims,
  protokollKennzahlen,
  sha256Hex,
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
  it("Vergleich nur bis 2026-10 (letzter ERP-Lohnmonat), danach → 422", () => {
    const okt = stempelBereich(2026, 10);
    expect(pruefeMonatsClaims({ jahr: 2026, monat: 10, von: okt.von, bis: okt.bis, profile: [P1] }, { bereich: false, bis: VERGLEICH_BIS }).ok).toBe(true);
    const nov = stempelBereich(2026, 11);
    expect(pruefeMonatsClaims({ jahr: 2026, monat: 11, von: nov.von, bis: nov.bis, profile: [P1] }, { bereich: false, bis: VERGLEICH_BIS })).toMatchObject({ code: "monat_nicht_erlaubt" });
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
    // Ohne abzuege/spesen/netto in der Momentaufnahme: alles null, nie geschätzt.
    expect(v.abzuege).toEqual({ ahv_an: null, alv_an: null, nbu_an: null, ktg_an: null, bvg_an: null, qst: null });
    expect(v.spesen).toBeNull();
    expect(v.netto).toBeNull();
  });

  const roh = (extra: Record<string, unknown>) => ({
    profile_id: P1, fassung: 2, art: "korrektur", kern_version: "2026.11-2", pruefsumme: "cd", auszahlungsdatum: "2026-11-25",
    brutto: "1000.00", ahv_lohn: "1000.00", alv_lohn: "1000.00", uvg_lohn: "1000.00", uvg_art: "bu_nbu",
    positionen: [], nbu: { versichert: true, massgebend: 9.5 }, bisher: null, ...extra,
  });

  it("Abzüge je Art (inkl. Rückerstattung), Spesen und Netto: CHF mit 2 Nachkommastellen", () => {
    const v = vergleichAusMomentaufnahme(roh({
      abzuege: [
        { art: "ahv_iv_eo", bezeichnung: "AHV/IV/EO", prozent: 5.3, basis: 1000, betrag: 53 },
        { art: "alv", bezeichnung: "ALV", prozent: 1.1, basis: 1000, betrag: "11.00" },
        { art: "nbu", bezeichnung: "NBU", prozent: 1.2, basis: 1000, betrag: 12 },
        { art: "bvg", bezeichnung: "BVG", prozent: 0, basis: 1000, betrag: 0 },
        { art: "ktg", bezeichnung: "KTG", prozent: 0.5, basis: 1000, betrag: 5 },
        { art: "quellensteuer", bezeichnung: "Quellensteuer", prozent: 4.15, basis: 1000, betrag: 41.5 },
        { art: "ahv_iv_eo", bezeichnung: "Rückerstattung Muster", prozent: 0, basis: 0, betrag: -3.1, rueckerstattung: true, zusatzpostenId: "z9" },
      ],
      spesen: 120.3,
      netto: "880.60",
    }));
    expect(v.abzuege).toEqual({ ahv_an: 49.9, alv_an: 11, nbu_an: 12, ktg_an: 5, bvg_an: 0, qst: 41.5 });
    expect(v.spesen).toBe(120.3);
    expect(v.netto).toBe(880.6);
    // Bestehende Felder unverändert, keine Bezeichnungen/IDs aus den Abzügen.
    expect(v.brutto).toBe(1000);
    expect(v.nbu).toEqual({ versichert: true, massgebend: 9.5 });
    expect(JSON.stringify(v)).not.toMatch(/Rückerstattung|Muster|z9|bezeichnung/);
  });

  it("Fehlende oder ungültige Werte → null (nie geschätzt)", () => {
    // Altbestand ohne KTG-/Quellensteuer-Zeile, ungültiger BVG-Betrag, Spesen fehlen (vor Phase 4).
    const v = vergleichAusMomentaufnahme(roh({
      art: "altbestand",
      abzuege: [
        { art: "ahv_iv_eo", betrag: 53 },
        { art: "alv", betrag: 11 },
        { art: "nbu", betrag: 0 },
        { art: "bvg", betrag: "x" },
        null,
      ],
      spesen: null,
      netto: 936,
    }));
    expect(v.abzuege).toEqual({ ahv_an: 53, alv_an: 11, nbu_an: 0, ktg_an: null, bvg_an: null, qst: null });
    expect(v.spesen).toBeNull();
    expect(v.netto).toBe(936);
    // Abzüge kein Array, Netto leer
    const w = vergleichAusMomentaufnahme(roh({ abzuege: { ahv: 53 }, spesen: "", netto: undefined }));
    expect(Object.values(w.abzuege).every((x) => x === null)).toBe(true);
    expect(w.spesen).toBeNull();
    expect(w.netto).toBeNull();
    // Spesen 0 bleibt 0 (Wert vorhanden), kein −0
    expect(vergleichAusMomentaufnahme(roh({ spesen: 0, netto: -0 }))).toMatchObject({ spesen: 0, netto: 0 });
    expect(Object.is(vergleichAusMomentaufnahme(roh({ netto: -0 })).netto, 0)).toBe(true);
  });
});

describe("Lohnabrechnung aus Bexio (A5)", () => {
  const pdf = Buffer.from("%PDF-1.4\n% Test\n");
  const sha = sha256Hex(pdf);
  const c = (extra: Record<string, unknown> = {}) => ({ erp_profil_id: P1, jahr: 2026, monat: 12, fassung: 1, sha256: sha, ...extra });

  it("Claims: ab Lohnmonat 2026-12, Fassung 1–99, sha256 hex", () => {
    expect(pruefeAblageClaims(c())).toEqual({ ok: true, anfrage: { profileId: P1, art: "lohnabrechnung", jahr: 2026, monat: 12, fassung: 1, sha256: sha } });
    expect(pruefeAblageClaims(c({ art: "lohnabrechnung" }))).toMatchObject({ ok: true, anfrage: { art: "lohnabrechnung", monat: 12 } });
    expect(pruefeAblageClaims(c({ art: "lohn" }))).toMatchObject({ code: "art_ungueltig" });
    expect(pruefeAblageClaims(c({ monat: 11 }))).toMatchObject({ ok: true, anfrage: { monat: 11 } });
    expect(pruefeAblageClaims(c({ monat: 10 }))).toMatchObject({ code: "erp_monat", status: 422 });
    expect(pruefeAblageClaims(c({ fassung: 0 }))).toMatchObject({ code: "fassung_ungueltig" });
    expect(pruefeAblageClaims(c({ sha256: sha.toUpperCase() }))).toMatchObject({ code: "sha256_ungueltig" });
    expect(pruefeAblageClaims(c({ erp_profil_id: "x" }))).toMatchObject({ code: "person_ungueltig" });
  });
  it("Lohnausweis: jahr ab 2026, ohne monat", () => {
    const a = (extra: Record<string, unknown> = {}) => ({ erp_profil_id: P1, art: "lohnausweis", jahr: 2026, fassung: 1, sha256: sha, ...extra });
    expect(pruefeAblageClaims(a())).toEqual({ ok: true, anfrage: { profileId: P1, art: "lohnausweis", jahr: 2026, monat: null, fassung: 1, sha256: sha } });
    expect(pruefeAblageClaims(a({ monat: 12 }))).toMatchObject({ code: "monat_nicht_erlaubt", status: 400 });
    expect(pruefeAblageClaims(a({ jahr: 2025 }))).toMatchObject({ code: "erp_jahr", status: 422 });
    expect(pruefeAblageClaims(a({ jahr: "2026" }))).toMatchObject({ code: "jahr_ungueltig" });
    expect(pruefeAblageClaims(a({ fassung: 100 }))).toMatchObject({ code: "fassung_ungueltig" });
    expect(protokollKennzahlen(a())).toEqual({ jahr: 2026, monat: null, angefragt: 1 });
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

describe("Personal-Sätze (/saetze)", () => {
  const e = (extra: Record<string, unknown> = {}) => ({ erp_profil_id: P1, gueltig_ab: "2026-12-01", kosten_chf_h: 41.35, netto_chf_h: 28, ...extra });

  it("gültige Liste → Sätze in Reihenfolge, IDs klein", () => {
    expect(pruefeSaetzeClaims({ saetze: [e(), e({ erp_profil_id: P2.toUpperCase(), gueltig_ab: "2027-01-01", kosten_chf_h: 0, netto_chf_h: 0.05 })] })).toEqual({
      ok: true,
      anfrage: [
        { profileId: P1, gueltigAb: "2026-12-01", kostenChfH: 41.35, nettoChfH: 28 },
        { profileId: P2, gueltigAb: "2027-01-01", kostenChfH: 0, nettoChfH: 0.05 },
      ],
    });
    expect(protokollKennzahlen({ saetze: [e(), e()] })).toEqual({ jahr: null, monat: null, angefragt: 2 });
  });
  it("null = kein Stundensatz (Provisionslohn), Feld muss aber vorhanden sein", () => {
    expect(pruefeSaetzeClaims({ saetze: [e({ kosten_chf_h: null, netto_chf_h: null })] })).toEqual({
      ok: true,
      anfrage: [{ profileId: P1, gueltigAb: "2026-12-01", kostenChfH: null, nettoChfH: null }],
    });
    expect(pruefeSaetzeClaims({ saetze: [{ erp_profil_id: P1, gueltig_ab: "2026-12-01", kosten_chf_h: null }] })).toMatchObject({ code: "satz_ungueltig" });
  });
  it("1–50 Einträge", () => {
    expect(pruefeSaetzeClaims({})).toMatchObject({ code: "saetze_fehlen" });
    expect(pruefeSaetzeClaims({ saetze: [] })).toMatchObject({ code: "saetze_fehlen" });
    const viele = Array.from({ length: 51 }, (_, i) => e({ gueltig_ab: `2026-12-${String((i % 28) + 1).padStart(2, "0")}`, erp_profil_id: i < 28 ? P1 : P2 }));
    expect(pruefeSaetzeClaims({ saetze: viele })).toMatchObject({ code: "saetze_zu_viele" });
  });
  it("Person, Datum, Zahlen ≥ 0 mit höchstens 2 Nachkommastellen, keine Doppel", () => {
    expect(pruefeSaetzeClaims({ saetze: [e({ erp_profil_id: "x" })] })).toMatchObject({ code: "person_ungueltig" });
    expect(pruefeSaetzeClaims({ saetze: [e({ gueltig_ab: "2026-02-30" })] })).toMatchObject({ code: "datum_ungueltig" });
    expect(pruefeSaetzeClaims({ saetze: [e({ gueltig_ab: "01.12.2026" })] })).toMatchObject({ code: "datum_ungueltig" });
    expect(pruefeSaetzeClaims({ saetze: [e({ kosten_chf_h: -1 })] })).toMatchObject({ code: "satz_ungueltig" });
    expect(pruefeSaetzeClaims({ saetze: [e({ kosten_chf_h: 1.005 })] })).toMatchObject({ code: "satz_ungueltig" });
    expect(pruefeSaetzeClaims({ saetze: [e({ netto_chf_h: "28.00" })] })).toMatchObject({ code: "satz_ungueltig" });
    expect(pruefeSaetzeClaims({ saetze: [e({ netto_chf_h: Number.NaN })] })).toMatchObject({ code: "satz_ungueltig" });
    expect(pruefeSaetzeClaims({ saetze: [e({ netto_chf_h: undefined })] })).toMatchObject({ code: "satz_ungueltig" });
    expect(pruefeSaetzeClaims({ saetze: ["x"] })).toMatchObject({ code: "satz_ungueltig" });
    expect(pruefeSaetzeClaims({ saetze: [e(), e({ erp_profil_id: P1.toUpperCase(), kosten_chf_h: 50 })] })).toMatchObject({ code: "satz_doppelt" });
  });
});

describe("Abwesenheiten und Arztzeugnis (/abwesenheiten, /arztzeugnis)", () => {
  const T = "b0000000-0000-4000-8000-000000000001";

  it("Claims Abwesenheiten: Monat als Kalendertage, profile wie /stempel, ohne Stempel-Bereich", () => {
    expect(pruefeAbwesenheitenClaims({ jahr: 2026, monat: 2, profile: [P1.toUpperCase(), P2] })).toEqual({
      ok: true,
      anfrage: { jahr: 2026, monat: 2, profile: [P1, P2], von: "2026-02-01", bis: "2026-02-28" },
    });
    expect(pruefeAbwesenheitenClaims({ jahr: 2028, monat: 2, profile: [P1] })).toMatchObject({ anfrage: { bis: "2028-02-29" } });
    expect(pruefeAbwesenheitenClaims({ jahr: 2026, monat: 12, profile: [P1] })).toMatchObject({ anfrage: { von: "2026-12-01", bis: "2026-12-31" } });
    expect(pruefeAbwesenheitenClaims({ jahr: 2026, monat: 13, profile: [P1] })).toMatchObject({ code: "monat_ungueltig" });
    expect(pruefeAbwesenheitenClaims({ jahr: 2026, monat: 12, profile: [] })).toMatchObject({ code: "profile_fehlen" });
    expect(pruefeAbwesenheitenClaims({ jahr: 2026, monat: 12, profile: [P1, P1] })).toMatchObject({ code: "profile_doppelt" });
    const viele = Array.from({ length: 51 }, (_, i) => `a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(pruefeAbwesenheitenClaims({ jahr: 2026, monat: 12, profile: viele })).toMatchObject({ code: "profile_zu_viele" });
  });

  it("Claims Arztzeugnis: time_off_id (UUID, klein); Protokoll zählt 1", () => {
    expect(pruefeArztzeugnisClaims({ time_off_id: T.toUpperCase() })).toEqual({ ok: true, anfrage: { timeOffId: T } });
    expect(pruefeArztzeugnisClaims({})).toMatchObject({ code: "abwesenheit_ungueltig", status: 400 });
    expect(pruefeArztzeugnisClaims({ time_off_id: "x" })).toMatchObject({ code: "abwesenheit_ungueltig" });
    expect(protokollKennzahlen({ time_off_id: T })).toEqual({ jahr: null, monat: null, angefragt: 1 });
  });

  it("Pfad des Zeugnisses muss zu Person und Abwesenheit passen", () => {
    expect(arztzeugnisPfadPasst(`${P1}/${T}/1730000000000.pdf`, P1, T)).toBe(true);
    expect(arztzeugnisPfadPasst(`${P2}/${T}/1730000000000.pdf`, P1, T)).toBe(false);
    expect(arztzeugnisPfadPasst(`${P1}/${P2}/1730000000000.pdf`, P1, T)).toBe(false);
    expect(arztzeugnisPfadPasst(`${P1}/${T}/x/../y.pdf`, P1, T)).toBe(false);
    expect(arztzeugnisPfadPasst(`${P1}/${T}/`, P1, T)).toBe(false);
  });

  it("Abwesenheit für Trust flow: nur die Felder des Vertrags, Zeugnis nur mit Pfad", () => {
    const z = {
      id: T, user_id: P1, type: "krank", status: "genehmigt", start_date: "2026-11-28", end_date: "2026-12-03",
      ende_offen: null, created_at: "2026-11-28T07:00:00+00:00", approved_at: null,
      arztzeugnis_pfad: `${P1}/${T}/1.pdf`, arztzeugnis_hochgeladen_at: "2026-11-30T10:00:00+00:00",
      arztzeugnis_an_flow_at: null,
    };
    const d = { dateiname: "Zeugnis.pdf", mime: "application/pdf", groesse: 1234, sha256: "a".repeat(64) };
    expect(abwesenheitFuerFlow(z, d)).toEqual({
      id: T, typ: "krank", status: "genehmigt", von: "2026-11-28", bis: "2026-12-03", ende_offen: false,
      gemeldet_at: "2026-11-28T07:00:00+00:00", entschieden_at: null,
      arztzeugnis: {
        id: T, hochgeladen_at: "2026-11-30T10:00:00+00:00", dateiname: "Zeugnis.pdf", mime: "application/pdf", groesse: 1234, sha256: "a".repeat(64),
        an_flow_at: null, geloescht: false,
      },
    });
    expect(abwesenheitFuerFlow({ ...z, arztzeugnis_pfad: null }, d).arztzeugnis).toBeNull();
    expect(abwesenheitFuerFlow(z, null).arztzeugnis).toBeNull();
    expect(Object.keys(abwesenheitFuerFlow(z, null))).not.toContain("note");
  });

  it("übergeben und im ERP gelöscht: Angaben bleiben als Beleg, geloescht: true", () => {
    const z = {
      id: T, user_id: P1, type: "krank", status: "genehmigt", start_date: "2026-10-01", end_date: "2026-10-05",
      ende_offen: null, created_at: "2026-10-01T07:00:00+00:00", approved_at: null,
      arztzeugnis_pfad: null, arztzeugnis_hochgeladen_at: "2026-10-03T10:00:00+00:00",
      arztzeugnis_an_flow_at: "2026-10-04T08:00:00+00:00",
    };
    const d = { dateiname: "Zeugnis.pdf", mime: "application/pdf", groesse: 1234, sha256: "a".repeat(64) };
    expect(abwesenheitFuerFlow(z, d).arztzeugnis).toEqual({
      id: T, hochgeladen_at: "2026-10-03T10:00:00+00:00", dateiname: "Zeugnis.pdf", mime: "application/pdf", groesse: 1234,
      sha256: "a".repeat(64), an_flow_at: "2026-10-04T08:00:00+00:00", geloescht: true,
    });
    // Übergeben, Datei noch da: geloescht false.
    expect(abwesenheitFuerFlow({ ...z, arztzeugnis_pfad: `${P1}/${T}/1.pdf` }, d).arztzeugnis?.geloescht).toBe(false);
    // Nie übergeben und kein Pfad: nichts.
    expect(abwesenheitFuerFlow({ ...z, arztzeugnis_an_flow_at: null }, d).arztzeugnis).toBeNull();
  });

  it("MIME aus der Endung (ältere Zeugnisse)", () => {
    expect(mimeAusEndung("a/b/1.PDF")).toBe("application/pdf");
    expect(mimeAusEndung("a/b/1.jpeg")).toBe("image/jpeg");
    expect(mimeAusEndung("a/b/1.heic")).toBe("image/heic");
    expect(mimeAusEndung("a/b/1")).toBe("application/octet-stream");
  });
});
