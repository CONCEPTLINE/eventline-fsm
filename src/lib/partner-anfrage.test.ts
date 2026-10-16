import { describe, it, expect } from "vitest";
import {
  istEigeneAnfrage,
  eigeneAnfrageFilter,
  dokumentFuerPartner,
  terminPruefen,
  tageBisVeranstaltung,
  aenderungGesperrt,
  partnerOrdner,
  partnerBelegungen,
  zugewieseneNamen,
  type AnfrageKern,
} from "@/lib/partner-anfrage";

const STANDORT = "d0219c22-458a-4bb5-99fa-e532c5a6bc4e";
const ANDERER = "ab01188b-61a3-4453-93ab-53d0bb695fa8";
const PARTNER = "788912f0-4034-4551-b30c-adcb19121ac1";
const KOLLEGE = "11111111-1111-4111-8111-111111111111";
const EVENTLINE = "48767098-1686-4a4f-bcca-973ab61a2fab";
const FREMDER_PARTNER = "a84298a1-f5e2-46e9-bcd7-63dcf99df205";
const TEAM = [PARTNER, KOLLEGE];
const S = { standortId: STANDORT, teamIds: TEAM, fremdePartnerIds: [FREMDER_PARTNER] };
const JOB = "abcdef12-3456-4789-8abc-def123456789";

function job(teil: Partial<AnfrageKern>): AnfrageKern {
  return {
    location_id: STANDORT,
    is_deleted: false,
    status: "offen",
    accepted_at: null,
    rejected_at: null,
    created_by: EVENTLINE,
    ...teil,
  };
}

describe("istEigeneAnfrage — Regel «eigene Anfrage»", () => {
  it("offene Partner-Status zaehlen immer (Entwurf, Anfrage)", () => {
    expect(istEigeneAnfrage(job({ status: "partner_entwurf" }), S)).toBe(true);
    expect(istEigeneAnfrage(job({ status: "partner_anfrage" }), S)).toBe(true);
  });

  it("von EVENTLINE entschieden (accepted_at / rejected_at) zaehlt — auch migrierte ohne Ersteller", () => {
    expect(istEigeneAnfrage(job({ status: "abgeschlossen", accepted_at: "2026-05-01T10:00:00Z", created_by: null }), S)).toBe(true);
    expect(istEigeneAnfrage(job({ status: "storniert", rejected_at: "2026-05-01T10:00:00Z" }), S)).toBe(true);
  });

  it("vom Partner-Team angelegt zaehlt, auch ohne Entscheid (Status ausserhalb des Entscheid-Wegs geaendert)", () => {
    expect(istEigeneAnfrage(job({ status: "offen", created_by: KOLLEGE }), S)).toBe(true);
  });

  it("EVENTLINE-eigene Auftraege und Vermietungen am Standort sind fremd", () => {
    expect(istEigeneAnfrage(job({ status: "offen" }), S)).toBe(false);
    expect(istEigeneAnfrage(job({ status: "storniert" }), S)).toBe(false);
    expect(istEigeneAnfrage(job({ status: "anfrage" }), S)).toBe(false);
  });

  it("Anfrage eines anderen Standorts, die EVENTLINE hierher verlegt hat: fremd", () => {
    expect(istEigeneAnfrage(job({ status: "offen", accepted_at: "2026-05-01T10:00:00Z", created_by: FREMDER_PARTNER }), S)).toBe(false);
    expect(istEigeneAnfrage(job({ status: "partner_anfrage", created_by: FREMDER_PARTNER }), S)).toBe(false);
  });

  it("anderer Standort, geloescht oder ohne Standort: nie eigen", () => {
    expect(istEigeneAnfrage(job({ status: "partner_anfrage", location_id: ANDERER }), S)).toBe(false);
    expect(istEigeneAnfrage(job({ status: "partner_anfrage", is_deleted: true }), S)).toBe(false);
    expect(istEigeneAnfrage(job({ status: "partner_anfrage", location_id: null }), S)).toBe(false);
    expect(istEigeneAnfrage(job({ status: "partner_anfrage" }), { ...S, standortId: "" })).toBe(false);
  });
});

describe("eigeneAnfrageFilter — dieselbe Regel als PostgREST-Filter", () => {
  it("Status, Entscheid und Team; Anfragen fremder Partner ausgeschlossen (NULL-sicher)", () => {
    expect(eigeneAnfrageFilter(S)).toEqual([
      `status.in.(partner_entwurf,partner_anfrage),accepted_at.not.is.null,rejected_at.not.is.null,created_by.in.(${PARTNER},${KOLLEGE})`,
      `created_by.is.null,created_by.not.in.(${FREMDER_PARTNER})`,
    ]);
  });
  it("ohne Team/fremde bzw. mit kaputten IDs: kein created_by-Teil (sprengt nie den Filter)", () => {
    expect(eigeneAnfrageFilter({ teamIds: [], fremdePartnerIds: [] })).toEqual([
      "status.in.(partner_entwurf,partner_anfrage),accepted_at.not.is.null,rejected_at.not.is.null",
    ]);
    expect(eigeneAnfrageFilter({ teamIds: ["x),status.eq.offen,(", ""], fremdePartnerIds: ["y)"] }).join("|")).not.toContain("created_by");
  });
});

describe("dokumentFuerPartner — alles ausser Dokumenten anderer Portal-Konten", () => {
  const portal = new Set([PARTNER, "lief-1"]);
  it("EVENTLINE-Dokumente (intern oder System ohne Hochlader) ja", () => {
    expect(dokumentFuerPartner({ storage_path: `jobs/${JOB}/Rechnung.pdf`, uploaded_by: EVENTLINE }, JOB, portal)).toBe(true);
    expect(dokumentFuerPartner({ storage_path: `rapporte/${JOB}/r.pdf`, uploaded_by: null }, JOB, portal)).toBe(true);
  });
  it("Partner-Anhaenge im Anfrage-Ordner ja (auch bei gross geschriebener Job-ID)", () => {
    expect(dokumentFuerPartner({ storage_path: `${partnerOrdner(JOB)}1_a.pdf`, uploaded_by: PARTNER }, JOB.toUpperCase(), portal)).toBe(true);
  });
  it("Lieferanten-Angebot (Portal-Konto, eigener Ordner) nein", () => {
    expect(dokumentFuerPartner({ storage_path: `jobs/${JOB}/lieferant-x/Angebot.pdf`, uploaded_by: "lief-1" }, JOB, portal)).toBe(false);
  });
  it("Pfad-Ausbruch oder leerer Pfad nein", () => {
    expect(dokumentFuerPartner({ storage_path: `${partnerOrdner(JOB)}../../jobs/x.pdf`, uploaded_by: PARTNER }, JOB, portal)).toBe(false);
    expect(dokumentFuerPartner({ storage_path: `jobs/${JOB}/../x.pdf`, uploaded_by: EVENTLINE }, JOB, portal)).toBe(false);
    expect(dokumentFuerPartner({ storage_path: null, uploaded_by: EVENTLINE }, JOB, portal)).toBe(false);
  });
});

describe("terminPruefen — Regeln wie bisher (Portal + partner_update_termin)", () => {
  const veranstaltung = { start_date: "2026-11-13T23:00:00+00:00", end_date: "2026-11-14T23:00:00+00:00" }; // 14.–15.11. Zuerich
  const gut = { titel: " Aufbau ", start: "2026-11-14T18:00:00+01:00", ende: "2026-11-14T23:00:00+01:00", beschreibung: " ", zeit_modus: "fix" };

  it("gueltiger Termin wird getrimmt, leere Beschreibung = null", () => {
    const r = terminPruefen(gut, veranstaltung);
    expect(r).toEqual({ ok: true, termin: { titel: "Aufbau", start: gut.start, ende: gut.ende, beschreibung: null, zeitModus: "fix" } });
  });
  it("«Fertig bis» hat nie eine Endzeit", () => {
    const r = terminPruefen({ ...gut, zeit_modus: "deadline" }, veranstaltung);
    expect(r.ok && r.termin.ende).toBe(null);
  });
  it("Pflichtfelder und Zeitfenster-Art", () => {
    expect(terminPruefen({ ...gut, titel: "  " }, veranstaltung)).toEqual({ ok: false, fehler: "Titel fehlt" });
    expect(terminPruefen({ ...gut, start: "" }, veranstaltung)).toEqual({ ok: false, fehler: "Startzeit fehlt" });
    expect(terminPruefen({ ...gut, start: "2026-11-14 18:00" }, veranstaltung)).toEqual({ ok: false, fehler: "Startzeit fehlt" });
    expect(terminPruefen({ ...gut, zeit_modus: "irgendwann" }, veranstaltung)).toEqual({ ok: false, fehler: "Ungültiger Zeitfenster-Modus" });
    expect(terminPruefen({ ...gut, ende: "morgen" }, veranstaltung)).toEqual({ ok: false, fehler: "Ungültige Endzeit" });
  });
  it("Termin-Tag nach Zuercher Kalender innerhalb der Veranstaltung", () => {
    // 14.11. 00:30 Zuerich = 13.11. 23:30 UTC → gehoert zum 14. (Beginn) → ok
    expect(terminPruefen({ ...gut, start: "2026-11-14T00:30:00+01:00", ende: null }, veranstaltung).ok).toBe(true);
    expect(terminPruefen({ ...gut, start: "2026-11-13T22:00:00+01:00" }, veranstaltung)).toEqual({ ok: false, fehler: "Termin liegt vor dem Veranstaltungsbeginn" });
    expect(terminPruefen({ ...gut, start: "2026-11-16T09:00:00+01:00" }, veranstaltung)).toEqual({ ok: false, fehler: "Termin liegt nach dem Veranstaltungsende" });
    // ohne Veranstaltungs-Datum keine Bereichs-Pruefung
    expect(terminPruefen(gut, { start_date: null, end_date: null }).ok).toBe(true);
  });
});

describe("partnerBelegungen — fremde Belegungen nur als «belegt»", () => {
  const basis = { location_id: STANDORT, is_deleted: false, accepted_at: null, rejected_at: null, start_date: "2026-11-13T23:00:00+00:00", end_date: null };
  const jobs = [
    { ...basis, id: "eigen-1", title: "Hochzeit", status: "offen", created_by: PARTNER },
    { ...basis, id: "fremd-1", title: "Firmenfest Kunde AG", status: "offen", created_by: EVENTLINE },
    { ...basis, id: "fremd-2", title: "Vermietung Müller", status: "anfrage", created_by: EVENTLINE },
    { ...basis, id: "fremd-storno", title: "Storniert", status: "storniert", created_by: EVENTLINE },
    { ...basis, id: "eigen-abgelehnt", title: "Abgelehnt", status: "storniert", rejected_at: "2026-10-01T10:00:00Z", created_by: PARTNER },
  ];
  const zuteilungen = [
    { job_id: "eigen-1", assigned_to: "t1" },
    { job_id: "eigen-1", assigned_to: "t2" },
    { job_id: "eigen-1", assigned_to: "t1" },
    { job_id: "fremd-1", assigned_to: "t1" },
  ];
  const namen = new Map([["t1", "Dario"], ["t2", "Leo"]]);
  const b = partnerBelegungen(jobs, S, zuteilungen, namen);

  it("eigene mit Titel, Status und Zugeteilten (jede Person einmal)", () => {
    expect(b[0]).toEqual({ id: "eigen-1", eigen: true, title: "Hochzeit", status: "offen", start_date: basis.start_date, end_date: null, zugewiesen: ["Dario", "Leo"] });
  });
  it("fremde nur Zeitraum mit kuenstlicher ID — kein Titel, Status, Kunde", () => {
    const fremd = b.filter((x) => !x.eigen);
    expect(fremd).toEqual([
      { id: "belegt-1", eigen: false, start_date: basis.start_date, end_date: null },
      { id: "belegt-2", eigen: false, start_date: basis.start_date, end_date: null },
    ]);
    expect(JSON.stringify(fremd)).not.toMatch(/Firmenfest|Vermietung|fremd-|anfrage|offen/);
  });
  it("stornierte fremde fallen weg, abgelehnte eigene bleiben", () => {
    expect(b.map((x) => x.id)).toEqual(["eigen-1", "belegt-1", "belegt-2", "eigen-abgelehnt"]);
  });
  it("zugewieseneNamen ignoriert andere Auftraege und Unbekannte", () => {
    expect(zugewieseneNamen("eigen-1", [...zuteilungen, { job_id: "eigen-1", assigned_to: "partner-x" }], namen)).toEqual(["Dario", "Leo"]);
    expect(zugewieseneNamen("leer", zuteilungen, namen)).toEqual([]);
  });
});

describe("Sperrfrist (3 Kalendertage, Europe/Zurich)", () => {
  it("rechnet den Zuercher Tag, nicht den UTC-Tag", () => {
    // Veranstaltung 19.10. (Zuerich-Mitternacht = 18.10. 22:00 UTC), heute 16.10.
    expect(tageBisVeranstaltung("2026-10-18T22:00:00+00:00", "2026-10-16")).toBe(3);
    expect(aenderungGesperrt("2026-10-18T22:00:00+00:00", "2026-10-16")).toBe(false);
    expect(aenderungGesperrt("2026-10-17T22:00:00+00:00", "2026-10-16")).toBe(true);
    expect(aenderungGesperrt(null, "2026-10-16")).toBe(false);
  });
});
