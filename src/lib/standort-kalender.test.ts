import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  kalenderTerminPruefen,
  istIsoDatum,
  jobKunde,
  partnerKalenderEintraege,
  internKalenderEintraege,
  terminKalenderEintraege,
  kalenderSortieren,
  terminAktionAusfuehren,
  zeitenZuIso,
  serieEingabePruefen,
  type KalenderJob,
} from "@/lib/standort-kalender";

const STANDORT = "d0219c22-458a-4bb5-99fa-e532c5a6bc4e";
const PARTNER = "788912f0-4034-4551-b30c-adcb19121ac1";
const EVENTLINE = "48767098-1686-4a4f-bcca-973ab61a2fab";
const FREMDER_PARTNER = "a84298a1-f5e2-46e9-bcd7-63dcf99df205";
const S = { standortId: STANDORT, teamIds: [PARTNER], fremdePartnerIds: [FREMDER_PARTNER] };
const TERMIN_ID = "abcdef12-3456-4789-8abc-def123456789";

describe("kalenderTerminPruefen", () => {
  const gut = { titel: "  Geburtstag  ", kunde: " Anna ", start: "2026-11-14T18:00:00+01:00", ende: "2026-11-14T23:00:00+01:00", ganztaegig: false, notiz: " Hinterhof " };

  it("gueltige Eingabe wird getrimmt", () => {
    expect(kalenderTerminPruefen(gut)).toEqual({
      ok: true,
      termin: { titel: "Geburtstag", kunde: "Anna", start: gut.start, ende: gut.ende, ganztaegig: false, notiz: "Hinterhof" },
    });
  });
  it("optionale Felder: leer → null, ganztaegig fehlt → false", () => {
    const r = kalenderTerminPruefen({ titel: "X", start: gut.start, kunde: "", ende: "", notiz: "   " });
    expect(r).toEqual({ ok: true, termin: { titel: "X", kunde: null, start: gut.start, ende: null, ganztaegig: false, notiz: null } });
  });
  it("ganztaegig mit Zuercher 00:00 bis 23:59", () => {
    const r = kalenderTerminPruefen({ titel: "Ruhetag", start: "2026-11-14T00:00:00+01:00", ende: "2026-11-15T23:59:00+01:00", ganztaegig: true });
    expect(r.ok && r.termin.ganztaegig).toBe(true);
  });
  it("Titel Pflicht und hoechstens 200 Zeichen", () => {
    expect(kalenderTerminPruefen({ ...gut, titel: "   " })).toEqual({ ok: false, fehler: "Titel fehlt" });
    expect(kalenderTerminPruefen({ ...gut, titel: 5 })).toEqual({ ok: false, fehler: "Titel fehlt" });
    expect(kalenderTerminPruefen({ ...gut, titel: "a".repeat(200) }).ok).toBe(true);
    expect(kalenderTerminPruefen({ ...gut, titel: "a".repeat(201) }).ok).toBe(false);
  });
  it("Kunde hoechstens 200, Notiz hoechstens 2000 Zeichen", () => {
    expect(kalenderTerminPruefen({ ...gut, kunde: "k".repeat(201) }).ok).toBe(false);
    expect(kalenderTerminPruefen({ ...gut, notiz: "n".repeat(2000) }).ok).toBe(true);
    expect(kalenderTerminPruefen({ ...gut, notiz: "n".repeat(2001) }).ok).toBe(false);
    expect(kalenderTerminPruefen({ ...gut, kunde: 7 }).ok).toBe(false);
  });
  it("Beginn ISO mit Zeitzone Pflicht", () => {
    expect(kalenderTerminPruefen({ ...gut, start: undefined }).ok).toBe(false);
    expect(kalenderTerminPruefen({ ...gut, start: "2026-11-14" }).ok).toBe(false);
    expect(kalenderTerminPruefen({ ...gut, start: "2026-11-14T18:00:00" }).ok).toBe(false);
    expect(kalenderTerminPruefen({ ...gut, start: "2026-11-14T17:00:00Z" }).ok).toBe(true);
  });
  it("Ende optional, gueltig und nicht vor dem Beginn", () => {
    expect(kalenderTerminPruefen({ ...gut, ende: null }).ok).toBe(true);
    expect(kalenderTerminPruefen({ ...gut, ende: "morgen" })).toEqual({ ok: false, fehler: "Ungültiges Ende" });
    expect(kalenderTerminPruefen({ ...gut, ende: "2026-11-14T17:59:00+01:00" })).toEqual({ ok: false, fehler: "Ende liegt vor dem Beginn" });
    expect(kalenderTerminPruefen({ ...gut, ende: gut.start }).ok).toBe(true);
    // gleicher Zeitpunkt in anderer Zone: 17:00Z = 18:00+01:00
    expect(kalenderTerminPruefen({ ...gut, ende: "2026-11-14T17:00:00Z" }).ok).toBe(true);
  });
  it("ganztaegig muss boolean sein; Nicht-Objekt wird abgelehnt", () => {
    expect(kalenderTerminPruefen({ ...gut, ganztaegig: "ja" }).ok).toBe(false);
    expect(kalenderTerminPruefen(null).ok).toBe(false);
    expect(kalenderTerminPruefen("x").ok).toBe(false);
  });
});

describe("istIsoDatum", () => {
  it("Datum oder Zeitpunkt, nichts anderes", () => {
    expect(istIsoDatum("2026-11-01")).toBe(true);
    expect(istIsoDatum("2026-11-01T00:00:00.000Z")).toBe(true);
    expect(istIsoDatum("2026-11-01T00:00:00+01:00")).toBe(true);
    expect(istIsoDatum("2026-11-01,id.neq.x")).toBe(false);
    expect(istIsoDatum(null)).toBe(false);
  });
});

function job(teil: Partial<KalenderJob> & { id: string }): KalenderJob {
  return {
    title: "Auftrag",
    status: "offen",
    start_date: "2026-11-13T23:00:00+00:00",
    end_date: null,
    location_id: STANDORT,
    is_deleted: false,
    accepted_at: null,
    rejected_at: null,
    created_by: EVENTLINE,
    contact_person: null,
    customer: null,
    ...teil,
  };
}

const jobs = [
  job({ id: "eigen-1", title: "Hochzeit", created_by: PARTNER, contact_person: "Familie Meier" }),
  job({ id: "fremd-1", title: "Firmenfest Kunde AG", customer: { name: "Kunde AG" } }),
  job({ id: "fremd-2", title: "Vermietung Müller", status: "anfrage", contact_person: "Müller" }),
  job({ id: "fremd-storno", title: "Storniert", status: "storniert" }),
  job({ id: "eigen-abgelehnt", title: "Abgelehnt", status: "storniert", rejected_at: "2026-10-01T10:00:00Z", created_by: PARTNER }),
];
const zuteilungen = [
  { job_id: "eigen-1", assigned_to: "t1" },
  { job_id: "eigen-1", assigned_to: "t2" },
  { job_id: "fremd-1", assigned_to: "t1" },
];
const namen = new Map([["t1", "Dario"], ["t2", "Leo"]]);

describe("jobKunde", () => {
  it("Kunde vor Mieter (contact_person), leer → null", () => {
    expect(jobKunde({ customer: { name: "Kunde AG" }, contact_person: "Anna" })).toBe("Kunde AG");
    expect(jobKunde({ customer: null, contact_person: " Anna " })).toBe("Anna");
    expect(jobKunde({ customer: { name: " " }, contact_person: null })).toBeNull();
  });
});

describe("partnerKalenderEintraege — ohne Kalender: fremde nur «belegt»", () => {
  const e = partnerKalenderEintraege(jobs, S, zuteilungen, namen, { kalender: false });

  it("eigene Anfragen mit Details und Portal-Link", () => {
    expect(e[0]).toEqual({
      id: "eigen-1", art: "anfrage", titel: "Hochzeit", kunde: "Familie Meier", status: "offen",
      start: "2026-11-13T23:00:00+00:00", ende: null, ganztaegig: false, notiz: null,
      zugewiesen: ["Dario", "Leo"], link: "/partner/anfragen/eigen-1", bearbeitbar: false,
      serieId: null, serienTag: null, wiederkehrend: false, quelleId: null, serie: null,
    });
  });
  it("fremde nur Zeitraum mit kuenstlicher ID — kein Titel, Status, Kunde", () => {
    const fremd = e.filter((x) => x.art === "belegt");
    expect(fremd.map((x) => x.id)).toEqual(["belegt-1", "belegt-2"]);
    expect(fremd.every((x) => x.titel === "Belegt" && x.kunde === null && x.status === null && x.link === null && x.zugewiesen.length === 0)).toBe(true);
    expect(JSON.stringify(fremd)).not.toMatch(/Firmenfest|Vermietung|Kunde AG|Müller|Dario|fremd-|anfrage|offen/);
  });
  it("stornierte fremde fallen weg, abgelehnte eigene bleiben", () => {
    expect(e.map((x) => x.id)).toEqual(["eigen-1", "belegt-1", "belegt-2", "eigen-abgelehnt"]);
  });
});

describe("partnerKalenderEintraege — mit Kalender: fremde als «auftrag»", () => {
  const e = partnerKalenderEintraege(jobs, S, zuteilungen, namen, { kalender: true });

  it("fremde mit Titel, Status, Kunde, Zugeteilten, ohne Link", () => {
    const f = e.find((x) => x.id === "fremd-1");
    expect(f).toMatchObject({ art: "auftrag", titel: "Firmenfest Kunde AG", kunde: "Kunde AG", status: "offen", zugewiesen: ["Dario"], link: null, bearbeitbar: false });
    expect(e.find((x) => x.id === "fremd-2")).toMatchObject({ art: "auftrag", kunde: "Müller", status: "anfrage" });
  });
  it("kein «belegt», stornierte fremde weiter weg", () => {
    expect(e.map((x) => x.id)).toEqual(["eigen-1", "fremd-1", "fremd-2", "eigen-abgelehnt"]);
  });
});

describe("internKalenderEintraege", () => {
  const e = internKalenderEintraege(jobs, S, zuteilungen, namen);
  it("ohne stornierte, Partner-Anfragen als «anfrage», Link ins ERP", () => {
    expect(e.map((x) => [x.id, x.art, x.link])).toEqual([
      ["eigen-1", "anfrage", "/auftraege/eigen-1"],
      ["fremd-1", "auftrag", "/auftraege/fremd-1"],
      ["fremd-2", "auftrag", "/auftraege/fremd-2"],
    ]);
  });
  it("angenommene Anfrage zaehlt als «anfrage» auch ohne Partner-Ersteller", () => {
    const r = internKalenderEintraege([job({ id: "x", accepted_at: "2026-10-01T10:00:00Z" })], S, [], namen);
    expect(r[0].art).toBe("anfrage");
  });
});

describe("terminKalenderEintraege + kalenderSortieren", () => {
  const termine = [
    { id: "t-2", titel: "Spaet", kunde: null, start_at: "2026-11-20T18:00:00+00:00", end_at: null, ganztaegig: false, notiz: "n" },
    { id: "t-1", titel: "Ruhetag", kunde: "Basil", start_at: "2026-11-01T23:00:00+00:00", end_at: "2026-11-02T22:59:00+00:00", ganztaegig: true, notiz: null },
  ];
  it("Termine mit Notiz, bearbeitbar nach Recht", () => {
    expect(terminKalenderEintraege(termine, true)[1]).toEqual({
      id: "t-1", art: "termin", titel: "Ruhetag", kunde: "Basil", status: null,
      start: "2026-11-01T23:00:00+00:00", ende: "2026-11-02T22:59:00+00:00", ganztaegig: true, notiz: null,
      zugewiesen: [], link: null, bearbeitbar: true,
      serieId: null, serienTag: null, wiederkehrend: false, quelleId: null, serie: null,
    });
    expect(terminKalenderEintraege(termine, false).every((t) => !t.bearbeitbar)).toBe(true);
  });
  it("chronologisch ueber alle Arten", () => {
    const alle = kalenderSortieren([
      ...partnerKalenderEintraege(jobs, S, zuteilungen, namen, { kalender: true }),
      ...terminKalenderEintraege(termine, true),
    ]);
    expect(alle.map((x) => x.id)).toEqual(["t-1", "eigen-1", "fremd-1", "fremd-2", "eigen-abgelehnt", "t-2"]);
  });
});

// Minimaler Supabase-Ersatz: zeichnet die Kette auf und liefert ein festes Ergebnis.
function fakeDb(
  ergebnis: { data?: unknown; error?: unknown; count?: number | null },
  zeile: { quelle: string | null; ausgeblendet: boolean } | null = { quelle: null, ausgeblendet: false },
) {
  const aufrufe: [string, unknown[]][] = [];
  const kette: Record<string, unknown> = {};
  for (const m of ["from", "insert", "update", "delete", "eq", "select"]) {
    kette[m] = (...args: unknown[]) => { aufrufe.push([m, args]); return kette; };
  }
  kette.maybeSingle = () => { aufrufe.push(["maybeSingle", []]); return Promise.resolve({ error: null, data: zeile }); };
  kette.single = () => { aufrufe.push(["single", []]); return Promise.resolve({ error: null, ...ergebnis }); };
  kette.then = (ok: (v: unknown) => unknown) => Promise.resolve({ error: null, ...ergebnis }).then(ok);
  return { db: kette as unknown as SupabaseClient, aufrufe };
}

describe("terminAktionAusfuehren", () => {
  const eingabe = { titel: "Probe", start: "2026-11-14T18:00:00+01:00" };

  it("unbekannte Aktion und ungueltige ID → 400 ohne DB", async () => {
    const { db, aufrufe } = fakeDb({});
    expect((await terminAktionAusfuehren(db, STANDORT, PARTNER, { aktion: "x" })).status).toBe(400);
    expect((await terminAktionAusfuehren(db, STANDORT, PARTNER, { aktion: "loeschen", id: "1;drop" })).status).toBe(400);
    expect((await terminAktionAusfuehren(db, STANDORT, PARTNER, null)).status).toBe(400);
    expect(aufrufe).toEqual([]);
  });
  it("anlegen setzt Standort und Ersteller", async () => {
    const { db, aufrufe } = fakeDb({ data: { id: TERMIN_ID } });
    const r = await terminAktionAusfuehren(db, STANDORT, PARTNER, { aktion: "anlegen", ...eingabe, location_id: "andere" });
    expect(r).toEqual({ status: 200, body: { success: true, id: TERMIN_ID } });
    const insert = aufrufe.find(([m]) => m === "insert")?.[1][0] as Record<string, unknown>;
    expect(insert).toMatchObject({ titel: "Probe", location_id: STANDORT, erstellt_von: PARTNER, ganztaegig: false, end_at: null });
  });
  it("aendern/loeschen nur im eigenen Standort, 0 Zeilen → 404", async () => {
    const { db, aufrufe } = fakeDb({ count: 0 });
    expect((await terminAktionAusfuehren(db, STANDORT, PARTNER, { aktion: "loeschen", id: TERMIN_ID })).status).toBe(404);
    expect(aufrufe.filter(([m]) => m === "eq").map(([, a]) => a)).toEqual([
      ["id", TERMIN_ID], ["location_id", STANDORT], ["id", TERMIN_ID], ["location_id", STANDORT],
    ]);
    const { db: db2 } = fakeDb({ count: 1 });
    expect(await terminAktionAusfuehren(db2, STANDORT, PARTNER, { aktion: "aendern", id: TERMIN_ID, ...eingabe })).toEqual({ status: 200, body: { success: true } });
  });
  it("ungueltige Eingabe beim Aendern → 400 ohne DB", async () => {
    const { db, aufrufe } = fakeDb({ count: 1 });
    expect(await terminAktionAusfuehren(db, STANDORT, PARTNER, { aktion: "aendern", id: TERMIN_ID, titel: "" })).toEqual({ status: 400, body: { success: false, error: "Titel fehlt" } });
    expect(aufrufe).toEqual([]);
  });
  it("nicht gefundener oder ausgeblendeter Termin → 404 ohne Aenderung", async () => {
    const { db, aufrufe } = fakeDb({ count: 1 }, null);
    expect((await terminAktionAusfuehren(db, STANDORT, PARTNER, { aktion: "loeschen", id: TERMIN_ID })).status).toBe(404);
    expect(aufrufe.some(([m]) => m === "delete" || m === "update")).toBe(false);
    const { db: db2 } = fakeDb({ count: 1 }, { quelle: "programmheft", ausgeblendet: true });
    expect((await terminAktionAusfuehren(db2, STANDORT, PARTNER, { aktion: "aendern", id: TERMIN_ID, ...eingabe })).status).toBe(404);
  });
  it("Programm-Termin loeschen = ausblenden, aendern = programm_manuell", async () => {
    const prog = { quelle: "programmheft", ausgeblendet: false };
    const { db, aufrufe } = fakeDb({ count: 1 }, prog);
    expect((await terminAktionAusfuehren(db, STANDORT, PARTNER, { aktion: "loeschen", id: TERMIN_ID })).status).toBe(200);
    expect(aufrufe.some(([m]) => m === "delete")).toBe(false);
    expect(aufrufe.find(([m]) => m === "update")?.[1][0]).toEqual({ ausgeblendet: true });
    const { db: db2, aufrufe: a2 } = fakeDb({ count: 1 }, prog);
    expect((await terminAktionAusfuehren(db2, STANDORT, PARTNER, { aktion: "aendern", id: TERMIN_ID, ...eingabe })).status).toBe(200);
    expect(a2.find(([m]) => m === "update")?.[1][0]).toMatchObject({ titel: "Probe", programm_manuell: true });
    const { db: db3, aufrufe: a3 } = fakeDb({ count: 1 });
    await terminAktionAusfuehren(db3, STANDORT, PARTNER, { aktion: "aendern", id: TERMIN_ID, ...eingabe });
    expect(a3.find(([m]) => m === "update")?.[1][0]).not.toHaveProperty("programm_manuell");
  });
});

describe("Sommerzeit-Luecke (29.03.2026, 02:00–02:59 gibt es in Zuerich nicht)", () => {
  it("zeitenZuIso verschiebt auf 03:00 statt null", () => {
    expect(zeitenZuIso("2026-03-29", false, "02:30", null)).toEqual({ start: "2026-03-29T01:00:00.000Z", ende: null });
    expect(zeitenZuIso("2026-03-28", false, "22:00", "02:15")?.ende).toBe("2026-03-29T01:00:00.000Z");
    expect(zeitenZuIso("2026-03-29", false, "01:30", null)?.start).toBe("2026-03-29T00:30:00.000Z");
  });
  it("serieEingabePruefen prueft auch «bis» (Folgetag)", () => {
    const basis = { titel: "Party", datum: "2026-03-28", von: "22:00" };
    expect(serieEingabePruefen({ ...basis, bis: "02:30" }).ok).toBe(false);
    expect(serieEingabePruefen({ ...basis, bis: "03:30" }).ok).toBe(true);
    expect(serieEingabePruefen({ ...basis, datum: "2026-03-29", von: "02:30" }).ok).toBe(false);
  });
});
