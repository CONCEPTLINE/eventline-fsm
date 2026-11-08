// Server-Bausteine des Vermietungs-Ablaufs: Laden/Schreiben von auftrag_ablauf, Ereignisse,
// Rückgängig, Mail-Wirkung (Webhook) und neuer Auftrag aus einer Anfrage-Mail.
//
// Schreiben mit optimistischer Sperre (updated_at): Webhook und App können gleichzeitig
// ändern — bei Konflikt wird der Plan auf dem frischen Stand neu gerechnet (max. 3 Versuche).
// Die API-Routen geben den RLS-Client (Recht auftraege:view/edit + Sichtbarkeit des Auftrags),
// der Webhook den Admin-Client.

import type { SupabaseClient } from "@supabase/supabase-js";
import { auftragArchiviert } from "@/lib/archiv";
import { logError } from "@/lib/log";
import { plusTage } from "@/lib/swiss-time";
import { aktivePersonen, standortMitarbeiterIds, verfuegbarkeitBerechnen } from "@/lib/standort-verfuegbarkeit";
import {
  erkenneAnfrage,
  erwaehnteLocations,
  ordneAblaufMailEin,
  type ErkennungAnhang,
  type ErkennungMail,
} from "./erkennung";
import {
  MAIL_ART_TEXT,
  absenderRolle,
  aktuellerSchritt,
  arbeitAusDb,
  arbeitAusPatch,
  einordnungPruefen,
  erledigtSauber,
  felderAusDb,
  felderErgaenzen,
  felderManuell,
  felderPatchFehler,
  felderText,
  felderZuDb,
  istEventlineAdresse,
  istEventlineDomain,
  istSchritt,
  jobTitel,
  jobZeitraum,
  jobZeitraumVerschieben,
  kehreUm,
  nurAdresse,
  planeWirkung,
  schrittFuerMailArt,
  uebergabeStandard,
  uebergabeVerschieben,
  wirkungVorhanden,
  zuerichIso,
  anfrageAmTag,
  nachAnlage,
  type AblaufZustand,
  type GeplanteWirkung,
  type TagesAuftrag,
} from "./schritte";
import {
  SCHRITTE,
  type Ablauf,
  type AblaufAntwort,
  type AblaufArbeit,
  type AblaufEreignis,
  type AblaufMail,
  type AblaufPerson,
  type AblaufWirkung,
  type EreignisQuelle,
  type FeldName,
  type FeldQuelle,
  type SchrittNr,
} from "./typen";

const ABLAUF_SELECT =
  "job_id, schritt, erledigt, felder, fixiert_am, unterschrieben_am, uebergabe_person_id, uebergabe_start, vertrag_dokument_id, abgeschlossen_am, created_at, updated_at";

type AblaufRow = {
  job_id: string;
  schritt: number;
  erledigt: number[] | null;
  felder: unknown;
  fixiert_am: string | null;
  unterschrieben_am: string | null;
  uebergabe_person_id: string | null;
  uebergabe_start: string | null;
  vertrag_dokument_id: string | null;
  abgeschlossen_am: string | null;
  created_at: string;
  updated_at: string;
};

/** Fachlicher Fehler mit HTTP-Status für die Routen. */
export class AblaufFehler extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AblaufFehler";
    this.status = status;
  }
}

export function ablaufAusRow(r: AblaufRow): Ablauf {
  const erledigt = erledigtSauber(r.erledigt);
  const { felder, quelle } = felderAusDb(r.felder);
  const arbeit = arbeitAusDb(r.felder);
  return {
    job_id: r.job_id,
    schritt: aktuellerSchritt(erledigt),
    erledigt,
    felder,
    feld_quelle: quelle,
    uebergabe_haken: arbeit.uebergabe_haken,
    poller_freigeschaltet: arbeit.poller_freigeschaltet,
    fixiert_am: r.fixiert_am,
    unterschrieben_am: r.unterschrieben_am,
    uebergabe_person_id: r.uebergabe_person_id,
    uebergabe_start: r.uebergabe_start,
    vertrag_dokument_id: r.vertrag_dokument_id,
    abgeschlossen_am: r.abgeschlossen_am,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

type JobKern = { id: string; status: string | null; location_id: string | null; start_date: string | null; end_date: string | null; title: string | null };

async function ladeRow(db: SupabaseClient, jobId: string): Promise<AblaufRow | null> {
  const { data, error } = await db.from("auftrag_ablauf").select(ABLAUF_SELECT).eq("job_id", jobId).maybeSingle();
  if (error) throw new Error("Ablauf laden: " + error.message);
  return (data as AblaufRow | null) ?? null;
}

async function ladeJob(db: SupabaseClient, jobId: string): Promise<JobKern | null> {
  const { data, error } = await db
    .from("jobs")
    .select("id, status, location_id, start_date, end_date, title")
    .eq("id", jobId)
    .not("is_deleted", "is", true)
    .maybeSingle();
  if (error) throw new Error("Auftrag laden: " + error.message);
  return (data as JobKern | null) ?? null;
}

/** Ablauf eines Auftrags (null = Auftrag ohne Ablauf). */
export async function ladeAblauf(db: SupabaseClient, jobId: string): Promise<Ablauf | null> {
  const row = await ladeRow(db, jobId);
  return row ? ablaufAusRow(row) : null;
}

function zustand(row: AblaufRow, jobStatus: string | null): AblaufZustand {
  const a = ablaufAusRow(row);
  return { erledigt: a.erledigt, fixiert_am: a.fixiert_am, unterschrieben_am: a.unterschrieben_am, felder: a.felder, quelle: a.feld_quelle, jobStatus };
}

async function setzeJobStatus(db: SupabaseClient, jobId: string, von: string | null, nach: "offen" | "anfrage"): Promise<void> {
  if (!von || von === nach) return;
  const { error } = await db
    .from("jobs")
    .update({ status: nach, request_step: nach === "anfrage" ? 1 : null })
    .eq("id", jobId)
    .eq("status", von);
  if (error) throw new AblaufFehler("Auftragsstatus nicht änderbar: " + error.message, 500);
}

/** Status nach dem Schreiben des Ablaufs nachführen. Ein Fehler hier darf den geschriebenen Ablauf
 *  nicht ohne Ereignis (= ohne Rückgängig) lassen → nur protokollieren. */
async function jobStatusNachfuehren(db: SupabaseClient, jobId: string, von: string | null, nach: "offen" | "anfrage"): Promise<void> {
  try {
    await setzeJobStatus(db, jobId, von, nach);
  } catch (e) {
    logError("ablauf.job_status", e, { jobId, von, nach });
  }
}

type Neu = Omit<AblaufZustand, "jobStatus">;

/** Schreibt einen neuen Zustand mit optimistischer Sperre. false = jemand war schneller.
 *  Der Arbeitsstand der Übergabe (Haken/Poller) bleibt erhalten, ausser `arbeit` ändert ihn (nur PATCH). */
async function schreibeZustand(
  db: SupabaseClient,
  row: AblaufRow,
  neu: Neu,
  extra: Record<string, unknown> = {},
  arbeit: Partial<AblaufArbeit> = {},
): Promise<AblaufRow | null> {
  const patch = {
    erledigt: neu.erledigt,
    schritt: aktuellerSchritt(neu.erledigt),
    fixiert_am: neu.fixiert_am,
    unterschrieben_am: neu.unterschrieben_am,
    felder: felderZuDb(neu.felder, neu.quelle, { ...arbeitAusDb(row.felder), ...arbeit }),
    ...extra,
  };
  const { data, error } = await db
    .from("auftrag_ablauf")
    .update(patch)
    .eq("job_id", row.job_id)
    .eq("updated_at", row.updated_at)
    .select(ABLAUF_SELECT);
  if (error) throw new AblaufFehler("Ablauf speichern: " + error.message, 500);
  return ((data ?? [])[0] as AblaufRow | undefined) ?? null;
}

type EreignisEingabe = {
  text: string;
  schritt: SchrittNr | null;
  quelle: EreignisQuelle;
  auftragMailId?: string | null;
  erstelltVon?: string | null;
};

async function ereignisAnlegen(db: SupabaseClient, jobId: string, e: EreignisEingabe, wirkung: AblaufWirkung | null): Promise<string | null> {
  const { data, error } = await db
    .from("auftrag_ablauf_ereignisse")
    .insert({
      job_id: jobId,
      text: e.text.slice(0, 1000),
      schritt: e.schritt,
      quelle: e.quelle,
      auftrag_mail_id: e.auftragMailId ?? null,
      wirkung: wirkung && Object.keys(wirkung).length ? wirkung : null,
      erstellt_von: e.erstelltVon ?? null,
    })
    .select("id")
    .single();
  if (error) {
    logError("ablauf.ereignis", error.message, { jobId });
    return null;
  }
  return (data as { id: string }).id;
}

/**
 * Plan auf dem aktuellen Stand ausführen: Auftragsstatus → Ablauf (Sperre) → Ereignis.
 * planen() bekommt den frischen Zustand; null bzw. leere Wirkung = nichts tun.
 */
async function fuehreAus(
  db: SupabaseClient,
  jobId: string,
  planen: (z: AblaufZustand, row: AblaufRow) => (GeplanteWirkung & { extraWirkung?: Partial<AblaufWirkung> }) | null,
  ereignis: (g: GeplanteWirkung) => EreignisEingabe,
): Promise<{ ablauf: Ablauf; ereignisId: string | null }> {
  for (let versuch = 0; versuch < 3; versuch++) {
    const [row, job] = await Promise.all([ladeRow(db, jobId), ladeJob(db, jobId)]);
    if (!row || !job) throw new AblaufFehler("Kein Ablauf zu diesem Auftrag", 404);
    const g = planen(zustand(row, job.status), row);
    if (!g || g.leer) return { ablauf: ablaufAusRow(row), ereignisId: null };
    const neuRow = await schreibeZustand(db, row, g.neu);
    if (!neuRow) continue; // Konflikt → neu rechnen (Status erst nach erfolgreichem Schreiben)
    if (g.jobStatus) await jobStatusNachfuehren(db, jobId, job.status, g.jobStatus);
    const ereignisId = await ereignisAnlegen(db, jobId, ereignis(g), { ...g.wirkung, ...(g.extraWirkung ?? {}) });
    return { ablauf: ablaufAusRow(neuRow), ereignisId };
  }
  throw new AblaufFehler("Der Ablauf wurde gleichzeitig geändert — bitte nochmals versuchen.", 409);
}

async function pruefeOffen(db: SupabaseClient, jobId: string): Promise<JobKern> {
  const job = await ladeJob(db, jobId);
  if (!job) throw new AblaufFehler("Auftrag nicht gefunden", 404);
  if (auftragArchiviert(job.status)) throw new AblaufFehler("Der Auftrag ist archiviert und kann nur noch gelesen werden.", 409);
  return job;
}

function schrittTitel(n: SchrittNr): string {
  return SCHRITTE.find((s) => s.nr === n)?.titel ?? `Schritt ${n}`;
}

function folgenText(w: AblaufWirkung): string[] {
  const teile: string[] = [];
  if (w.erledigt_plus?.length) {
    const max = Math.max(...w.erledigt_plus) as SchrittNr;
    teile.push(w.erledigt_plus.length > 1 ? `Schritte bis ${max} erledigt` : `Schritt ${max} erledigt`);
  }
  if (w.erledigt_minus?.length) teile.push(`Schritt ${Math.min(...w.erledigt_minus)} wieder offen`);
  if (w.fixiert) teile.push("Datum fixiert (für den Partner noch verborgen)");
  if (w.unterschrieben) teile.push("jetzt im Partner-Kalender sichtbar");
  if (w.unterschrieben_entfernt) teile.push("im Partner-Kalender wieder verborgen");
  return teile;
}

// ── GET ──────────────────────────────────────────────────────────

type EreignisRow = {
  id: string;
  job_id: string;
  zeit: string;
  text: string;
  schritt: number | null;
  quelle: EreignisQuelle;
  auftrag_mail_id: string | null;
  wirkung: unknown;
  rueckgaengig_am: string | null;
  erstellt_von: string | null;
  profil: { full_name: string | null } | { full_name: string | null }[] | null;
};

const eins = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

/** Text-Element des Eingangs → Auszug ohne die «Von:/Betreff:»-Kopfzeilen. */
function auszugAus(content: string | null): string | null {
  if (!content) return null;
  const ohneKopf = content.replace(/^Von: .*\nBetreff: .*\n\n/, "");
  const t = ohneKopf.replace(/\s+/g, " ").trim();
  return t ? (t.length > 300 ? t.slice(0, 299) + "…" : t) : null;
}

/**
 * Personal der Location mit Verfügbarkeit am Tag. Datenschutz: den Abwesenheitsgrund (z. B. «Krank»)
 * sieht nur, wer ihn sehen darf (darf_abwesenheitsgrund_sehen, Migration 379 — sonst «abwesend»);
 * die Telefonnummer kommt nur für die gewählte Übergabeperson mit (Infomail/Eckdaten).
 */
async function ladePersonal(
  db: SupabaseClient,
  admin: SupabaseClient,
  job: JobKern,
  tag: string | null,
  uebergabePersonId: string | null,
): Promise<AblaufPerson[]> {
  if (!job.location_id) return [];
  let ids: string[];
  try {
    ids = await standortMitarbeiterIds(db, job.location_id);
  } catch (e) {
    logError("ablauf.personal.ids", e, { jobId: job.id });
    return [];
  }
  const personen = await aktivePersonen(admin, ids);
  if (!personen.length) return [];
  const telefon = new Map<string, string | null>();
  if (uebergabePersonId && personen.some((p) => p.id === uebergabePersonId)) {
    const { data: tel } = await admin.from("profiles").select("phone").eq("id", uebergabePersonId).maybeSingle();
    telefon.set(uebergabePersonId, (tel as { phone: string | null } | null)?.phone?.trim() || null);
  }
  const { data: darf, error: darfErr } = await db.rpc("darf_abwesenheitsgrund_sehen");
  if (darfErr) logError("ablauf.personal.grund_recht", darfErr.message, { jobId: job.id });
  const grundSichtbar = darf === true;
  const tage = tag ? await verfuegbarkeitBerechnen(admin, job.location_id, personen, tag, tag, { partnersicht: false, grundSichtbar }) : [];
  const t = tage[0];
  return personen.map((p) => {
    const weg = t?.weg.find((w) => w.name === p.name) ?? null;
    return { id: p.id, name: p.name, telefon: telefon.get(p.id) ?? null, frei: !weg, grund: weg?.grund ?? null };
  });
}

/** Veranstaltungstag (Zürich) aus den Feldern, sonst aus dem Auftragsstart. */
function veranstaltungsTag(a: Ablauf, job: JobKern): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(a.felder.datum)) return a.felder.datum;
  if (!job.start_date) return null;
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(new Date(job.start_date));
}

/** GET /api/jobs/[id]/ablauf — db = RLS-Client, admin nur für Namen/Verfügbarkeit des Personals. */
export async function ladeAblaufAntwort(db: SupabaseClient, admin: SupabaseClient, jobId: string): Promise<AblaufAntwort | null> {
  const [row, job] = await Promise.all([ladeRow(db, jobId), ladeJob(db, jobId)]);
  if (!row || !job) return null;
  const ablauf = ablaufAusRow(row);

  const [ereignisRes, mailRes] = await Promise.all([
    db
      .from("auftrag_ablauf_ereignisse")
      .select("id, job_id, zeit, text, schritt, quelle, auftrag_mail_id, wirkung, rueckgaengig_am, erstellt_von, profil:profiles!auftrag_ablauf_ereignisse_erstellt_von_fkey(full_name)")
      .eq("job_id", jobId)
      .order("zeit", { ascending: false })
      .limit(200),
    db
      .from("auftrag_mails")
      .select("id, resend_email_id, empfangen_am, absender, cc, betreff, zuordnung")
      .eq("job_id", jobId)
      .order("empfangen_am", { ascending: false })
      .limit(100),
  ]);
  if (ereignisRes.error) throw new Error("Ereignisse laden: " + ereignisRes.error.message);
  if (mailRes.error) throw new Error("Mails laden: " + mailRes.error.message);

  const ereignisse: AblaufEreignis[] = ((ereignisRes.data ?? []) as unknown as EreignisRow[]).map((e) => ({
    id: e.id,
    job_id: e.job_id,
    zeit: e.zeit,
    text: e.text,
    schritt: istSchritt(e.schritt) ? e.schritt : null,
    quelle: e.quelle,
    auftrag_mail_id: e.auftrag_mail_id,
    rueckgaengig_am: e.rueckgaengig_am,
    erstellt_von: e.erstellt_von,
    erstellt_von_name: eins(e.profil)?.full_name ?? null,
    ruecknehmbar: !e.rueckgaengig_am && wirkungVorhanden(e.wirkung),
  }));

  type MailRow = { id: string; resend_email_id: string; empfangen_am: string; absender: string | null; cc: string[] | null; betreff: string | null; zuordnung: string | null };
  const mailRows = (mailRes.data ?? []) as MailRow[];
  const auszug = new Map<string, string | null>();
  const anhaenge = new Map<string, string[]>();
  if (mailRows.length) {
    const { data: items } = await db
      .from("job_inbox_items")
      .select("resend_email_id, kind, content, file_name")
      .eq("job_id", jobId)
      .in("resend_email_id", mailRows.map((m) => m.resend_email_id));
    for (const it of (items ?? []) as { resend_email_id: string; kind: string; content: string | null; file_name: string | null }[]) {
      if (it.kind === "text" && !auszug.has(it.resend_email_id)) auszug.set(it.resend_email_id, auszugAus(it.content));
      if (it.kind === "datei" && it.file_name) anhaenge.set(it.resend_email_id, [...(anhaenge.get(it.resend_email_id) ?? []), it.file_name]);
    }
  }
  const mails: AblaufMail[] = mailRows.map((m) => ({
    id: m.id,
    empfangen_am: m.empfangen_am,
    absender: m.absender,
    cc: m.cc ?? [],
    betreff: m.betreff,
    richtung: m.absender && istEventlineAdresse(m.absender) ? "aus" : "ein",
    auszug: auszug.get(m.resend_email_id) ?? null,
    anhaenge: anhaenge.get(m.resend_email_id) ?? [],
    zuordnung: m.zuordnung,
  }));

  let personal: AblaufPerson[] = [];
  try {
    personal = await ladePersonal(db, admin, job, veranstaltungsTag(ablauf, job), ablauf.uebergabe_person_id);
  } catch (e) {
    logError("ablauf.personal", e, { jobId });
  }
  return { ablauf, ereignisse, mails, personal };
}

// ── PATCH ────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PATCH: Felder (manuell), Übergabeperson/-zeit, Übergabe-Haken/Poller. Kein Ereignis (Eingaben, keine Schritte). */
export async function aendereAblauf(
  db: SupabaseClient,
  jobId: string,
  body: Record<string, unknown>,
): Promise<{ ablauf: Ablauf; warnung?: string }> {
  const job = await pruefeOffen(db, jobId);
  if ("felder" in body) {
    const f = felderPatchFehler(body.felder);
    if (f) throw new AblaufFehler(f);
  }
  const pa = arbeitAusPatch(body);
  if ("fehler" in pa) throw new AblaufFehler(pa.fehler);
  const extra: Record<string, unknown> = {};
  if ("uebergabe_person_id" in body) {
    const p = body.uebergabe_person_id;
    if (p !== null && (typeof p !== "string" || !UUID_RE.test(p))) throw new AblaufFehler("Ungültige Übergabeperson");
    if (p) {
      if (!job.location_id) throw new AblaufFehler("Der Auftrag hat keine Location");
      const ids = await standortMitarbeiterIds(db, job.location_id).catch(() => [] as string[]);
      if (!ids.includes(p)) throw new AblaufFehler("Die Übergabeperson muss der Location zugeteilt sein");
    }
    extra.uebergabe_person_id = p;
  }
  if ("uebergabe_start" in body) {
    const s = body.uebergabe_start;
    if (s !== null && (typeof s !== "string" || Number.isNaN(Date.parse(s)))) throw new AblaufFehler("Ungültige Übergabezeit");
    extra.uebergabe_start = s ? new Date(s).toISOString() : null;
  }

  for (let versuch = 0; versuch < 3; versuch++) {
    const row = await ladeRow(db, jobId);
    if (!row) throw new AblaufFehler("Kein Ablauf zu diesem Auftrag", 404);
    const z = zustand(row, job.status);
    const a = "felder" in body ? felderManuell(z.felder, z.quelle, body.felder) : null;
    const neu = { ...z, felder: a?.felder ?? z.felder, quelle: a?.quelle ?? z.quelle };
    const zusatz = { ...extra };
    const tagOk = /^\d{4}-\d{2}-\d{2}$/.test(neu.felder.datum);
    // Person gewählt, aber noch keine Zeit → Standard 14:00 am Veranstaltungstag.
    if (zusatz.uebergabe_person_id && !("uebergabe_start" in body) && !row.uebergabe_start && tagOk) {
      zusatz.uebergabe_start = uebergabeStandard(neu.felder.datum);
    }
    // Datum geändert → geplante Übergabe auf den neuen Tag mitziehen (gleiche Zürcher Uhrzeit).
    if (a && "datum" in a.neu && tagOk && row.uebergabe_start && !("uebergabe_start" in body)) {
      zusatz.uebergabe_start = uebergabeVerschieben(row.uebergabe_start, neu.felder.datum);
    }
    const neuRow = await schreibeZustand(db, row, neu, zusatz, pa.arbeit);
    if (!neuRow) continue;
    const warnung = a ? await auftragAbgleichen(db, jobId, a.neu) : undefined;
    return { ablauf: ablaufAusRow(neuRow), ...(warnung ? { warnung } : {}) };
  }
  throw new AblaufFehler("Der Ablauf wurde gleichzeitig geändert — bitte nochmals versuchen.", 409);
}

/** Geänderte Felder in den Auftrag spiegeln: Datum/Beginn → Zeitraum, Mieter/Telefon/E-Mail → Kontakt. */
async function auftragAbgleichen(db: SupabaseClient, jobId: string, neu: Partial<Ablauf["felder"]>): Promise<string | undefined> {
  const patch: Record<string, unknown> = {};
  if ("datum" in neu || "beginn" in neu) {
    // Nur den Start verschieben, die bisherige Dauer bleibt (ohne Ende: 23:59 des Tages).
    const [row, job] = await Promise.all([ladeRow(db, jobId), ladeJob(db, jobId)]);
    const f = row ? felderAusDb(row.felder).felder : null;
    const z = f && job ? jobZeitraumVerschieben(f, job) : null;
    if (z) Object.assign(patch, z);
  }
  if ("mieter" in neu) patch.contact_person = neu.mieter || null;
  if ("telefon" in neu) patch.contact_phone = neu.telefon || null;
  if ("email" in neu) patch.contact_email = neu.email || null;
  if (!Object.keys(patch).length) return undefined;
  const { error } = await db.from("jobs").update(patch).eq("id", jobId);
  if (error) {
    logError("ablauf.auftrag_abgleich", error.message, { jobId });
    return "Gespeichert, aber Datum/Kontakt im Auftrag nicht nachgeführt — bitte im Auftrag prüfen.";
  }
  return undefined;
}

// ── Schritt manuell ──────────────────────────────────────────────

export async function schrittManuell(
  db: SupabaseClient,
  jobId: string,
  aktion: "erledigt" | "zurueck",
  schritt: SchrittNr,
  userId: string,
): Promise<{ ablauf: Ablauf; ereignisId: string | null }> {
  await pruefeOffen(db, jobId);
  const jetzt = new Date().toISOString();
  return fuehreAus(
    db,
    jobId,
    (z) => planeWirkung(z, aktion === "erledigt" ? { erledigen: schritt } : { zurueck: schritt }, jetzt),
    (g) => {
      const kopf = `Schritt ${schritt} «${schrittTitel(schritt)}» ${aktion === "erledigt" ? "manuell erledigt" : "manuell wieder geöffnet"}`;
      const folgen = folgenText(g.wirkung).filter((t) => !t.startsWith("Schritt"));
      return { text: folgen.length ? `${kopf} → ${folgen.join(", ")}` : kopf, schritt: aktion === "erledigt" ? schritt : null, quelle: "manuell", erstelltVon: userId };
    },
  );
}

// ── Rückgängig ───────────────────────────────────────────────────

export async function ereignisRueckgaengig(db: SupabaseClient, jobId: string, ereignisId: string, userId: string): Promise<{ ablauf: Ablauf }> {
  await pruefeOffen(db, jobId);
  const { data: e, error } = await db
    .from("auftrag_ablauf_ereignisse")
    .select("id, text, wirkung, rueckgaengig_am")
    .eq("id", ereignisId)
    .eq("job_id", jobId)
    .maybeSingle();
  if (error) throw new AblaufFehler("Ereignis laden: " + error.message, 500);
  if (!e) throw new AblaufFehler("Ereignis nicht gefunden", 404);
  const ev = e as { id: string; text: string; wirkung: unknown; rueckgaengig_am: string | null };
  if (ev.rueckgaengig_am) throw new AblaufFehler("Schon rückgängig gemacht", 409);
  if (!wirkungVorhanden(ev.wirkung)) throw new AblaufFehler("Dieses Ereignis kann nicht rückgängig gemacht werden", 409);
  const w = ev.wirkung;

  // Zuerst beanspruchen (gegen Doppelklick), bei Fehlschlag wieder freigeben.
  const jetzt = new Date().toISOString();
  const { data: claim, error: claimErr } = await db
    .from("auftrag_ablauf_ereignisse")
    .update({ rueckgaengig_am: jetzt })
    .eq("id", ereignisId)
    .is("rueckgaengig_am", null)
    .select("id");
  if (claimErr) throw new AblaufFehler("Rückgängig: " + claimErr.message, 500);
  if (!claim?.length) throw new AblaufFehler("Schon rückgängig gemacht", 409);

  try {
    // Hat ein anderes, noch wirksames Ereignis das Datum fixiert? (dann bleibt es fixiert)
    const { count: andereFix, error: fixErr } = await db
      .from("auftrag_ablauf_ereignisse")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId)
      .neq("id", ereignisId)
      .is("rueckgaengig_am", null)
      .not("wirkung->fixiert", "is", null);
    if (fixErr) throw new AblaufFehler("Rückgängig: " + fixErr.message, 500);
    let ablauf: Ablauf | null = null;
    for (let versuch = 0; versuch < 3 && !ablauf; versuch++) {
      const [row, job] = await Promise.all([ladeRow(db, jobId), ladeJob(db, jobId)]);
      if (!row || !job) throw new AblaufFehler("Kein Ablauf zu diesem Auftrag", 404);
      const r = kehreUm(zustand(row, job.status), w, { fixiertDurchAndere: (andereFix ?? 0) > 0 });
      const neuRow = await schreibeZustand(db, row, r.neu);
      if (!neuRow) continue;
      if (r.jobStatus) await jobStatusNachfuehren(db, jobId, job.status, r.jobStatus);
      ablauf = ablaufAusRow(neuRow);
    }
    if (!ablauf) throw new AblaufFehler("Der Ablauf wurde gleichzeitig geändert — bitte nochmals versuchen.", 409);
    if (w.dokument_ids?.length) {
      const { error: dErr } = await db.from("documents").update({ folder: null }).in("id", w.dokument_ids).eq("folder", "Vertrag");
      if (dErr) logError("ablauf.rueckgaengig.dokumente", dErr.message, { jobId });
    }
    await ereignisAnlegen(db, jobId, { text: `Rückgängig: ${ev.text}`, schritt: null, quelle: "manuell", erstelltVon: userId }, null);
    return { ablauf };
  } catch (err) {
    await db.from("auftrag_ablauf_ereignisse").update({ rueckgaengig_am: null }).eq("id", ereignisId);
    throw err;
  }
}

// ── Mail-Wirkung (Webhook, nach erfolgreicher Zuordnung) ─────────

/** Dokumente der Mail (aus legeImAuftragAb) in den Ordner «Vertrag» legen → IDs. */
async function vertragsDokumente(admin: SupabaseClient, jobId: string, resendEmailId: string): Promise<string[]> {
  const { data: items } = await admin
    .from("job_inbox_items")
    .select("file_path")
    .eq("job_id", jobId)
    .eq("resend_email_id", resendEmailId)
    .eq("kind", "datei");
  const pfade = ((items ?? []) as { file_path: string | null }[]).map((i) => i.file_path).filter((p): p is string => !!p);
  if (!pfade.length) return [];
  const { data, error } = await admin
    .from("documents")
    .update({ folder: "Vertrag" })
    .eq("job_id", jobId)
    .in("storage_path", pfade)
    .is("folder", null)
    .select("id");
  if (error) {
    logError("ablauf.vertrag_dokumente", error.message, { jobId });
    return [];
  }
  return ((data ?? []) as { id: string }[]).map((d) => d.id);
}

type PartnerKonto = { email: string | null; partner_location_id: string | null; is_active: boolean | null };

async function partnerKonten(admin: SupabaseClient): Promise<PartnerKonto[]> {
  const { data, error } = await admin.from("profiles").select("email, partner_location_id, is_active").eq("role", "partner");
  if (error) throw new Error("Partner-Konten laden: " + error.message);
  return (data ?? []) as PartnerKonto[];
}

/**
 * Wirkung einer zugeordneten Mail auf einen Auftrag MIT Ablauf (KI-Einordnung). Ohne Ablauf:
 * sofort zurück (keine KI, Verhalten wie bisher). Wirft nie — Fehler werden geloggt.
 */
export async function ablaufMailWirkung(
  admin: SupabaseClient,
  opts: { jobId: string; auftragMailId: string; resendEmailId: string; mail: ErkennungMail; anhangAnzahl: number },
): Promise<void> {
  const { jobId, auftragMailId, resendEmailId, mail } = opts;
  try {
    const row = await ladeRow(admin, jobId);
    if (!row) return;
    const job = await ladeJob(admin, jobId);
    if (!job || auftragArchiviert(job.status)) return;
    const { count } = await admin
      .from("auftrag_ablauf_ereignisse")
      .select("id", { count: "exact", head: true })
      .eq("auftrag_mail_id", auftragMailId);
    if (count) return; // schon verarbeitet (Wiederholung)

    const a = ablaufAusRow(row);
    let location: string | null = null;
    if (job.location_id) {
      const { data: l } = await admin.from("locations").select("name").eq("id", job.location_id).maybeSingle();
      location = (l as { name: string | null } | null)?.name ?? null;
    }
    const partner = await partnerKonten(admin);
    const ki = await ordneAblaufMailEin(mail, {
      felder: a.felder,
      erledigt: a.erledigt,
      fixiert: !!a.fixiert_am,
      unterschrieben: !!a.unterschrieben_am,
      location,
      gesperrteAdressen: partner.map((p) => (p.email ?? "").toLowerCase()).filter(Boolean),
    });
    if (!ki) return;
    // Code-Prüfung des Absenders (nicht nur KI): wer darf welche Wirkung auslösen?
    const rolle = absenderRolle(mail.von, {
      mieterEmail: a.felder.email,
      partnerAdressen: partner
        .filter((p) => p.is_active && !!job.location_id && p.partner_location_id === job.location_id)
        .map((p) => p.email ?? ""),
    });
    const einordnung = einordnungPruefen(ki, rolle);
    const { art } = einordnung;
    const jetzt = new Date().toISOString();

    // a) Schritt / Zusage / Unterschrift
    const schritt = schrittFuerMailArt(art, opts.anhangAnzahl);
    if (schritt || art === "zusage_kunde") {
      const dokumentIds = art === "vertrag_unterschrieben" ? await vertragsDokumente(admin, jobId, resendEmailId) : [];
      await fuehreAus(
        admin,
        jobId,
        (z) => {
          const g = planeWirkung(z, { erledigen: schritt ?? undefined, fixieren: art === "zusage_kunde" }, jetzt);
          return dokumentIds.length ? { ...g, extraWirkung: { dokument_ids: dokumentIds } } : g;
        },
        (g) => {
          const kopf = art === "vertrag_an_kunde" ? `Vertrags-Mail mit ${opts.anhangAnzahl} Anhang/Anhängen erkannt` : MAIL_ART_TEXT[art];
          const folgen = folgenText(g.wirkung);
          if (dokumentIds.length) folgen.push("Vertrag unter Dokumente › Vertrag abgelegt");
          return { text: folgen.length ? `${kopf} → ${folgen.join(", ")}` : kopf, schritt, quelle: "mail", auftragMailId };
        },
      );
    }

    // b) Felder ergänzen (nur leere, nie manuelle)
    if (Object.keys(einordnung.felder).length) {
      await fuehreAus(
        admin,
        jobId,
        (z) => planeWirkung(z, { felder: felderErgaenzen(z.felder, z.quelle, einordnung.felder) }, jetzt),
        (g) => ({ text: `Aus Mail ergänzt: ${felderText(g.wirkung.felder_neu ?? {})}`, schritt: null, quelle: "mail", auftragMailId }),
      );
    }
  } catch (e) {
    logError("ablauf.mail_wirkung", e, { jobId });
  }
}

// ── Neuer Auftrag aus einer Anfrage-Mail ─────────────────────────

type KalenderLocation = { id: string; name: string };

async function projektleitung(admin: SupabaseClient): Promise<string | null> {
  const { data: leo } = await admin
    .from("profiles")
    .select("id")
    .ilike("email", "leo@eventline-basel.com")
    .eq("is_active", true)
    .maybeSingle();
  if (leo) return (leo as { id: string }).id;
  const { data: admins } = await admin
    .from("profiles")
    .select("id")
    .eq("role", "admin")
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1);
  return ((admins ?? [])[0] as { id: string } | undefined)?.id ?? null;
}

/** Nicht stornierte, nicht gelöschte Aufträge (mit oder ohne Ablauf) an dieser Location, die den Tag berühren. */
async function auftraegeAmTag(admin: SupabaseClient, locationId: string, tag: string): Promise<TagesAuftrag[]> {
  const start = zuerichIso(tag);
  const ende = zuerichIso(plusTage(tag, 1));
  const { data, error } = await admin
    .from("jobs")
    .select("id, status, created_at, contact_email, contact_person, auftrag_ablauf(felder)")
    .eq("location_id", locationId)
    .not("is_deleted", "is", true)
    .lt("start_date", ende)
    .or(`end_date.gte."${start}",and(end_date.is.null,start_date.gte."${start}")`);
  if (error) throw new Error("Aufträge am Tag: " + error.message);
  type Row = {
    id: string;
    status: string | null;
    created_at: string;
    contact_email: string | null;
    contact_person: string | null;
    auftrag_ablauf: { felder: unknown } | { felder: unknown }[] | null;
  };
  return ((data ?? []) as Row[])
    .filter((j) => j.status !== "storniert")
    .map((j) => {
      const ab = eins(j.auftrag_ablauf);
      const f = ab ? felderAusDb(ab.felder).felder : null;
      return {
        id: j.id,
        created_at: j.created_at,
        hatAblauf: !!ab,
        emails: [f?.email ?? "", j.contact_email ?? ""].filter(Boolean),
        name: f?.mieter || j.contact_person || "",
      };
    });
}

/**
 * Einen gerade aus einer Mail angelegten Auftrag wieder entfernen (Doppel-Anlage, Ablegen gescheitert).
 * Nur für eigene, eben erst angelegte Aufträge: Dokumente (inkl. Datei) zuerst, dann der Auftrag
 * (Ablauf, Ereignisse und Eingang hängen per Cascade daran). true = genau ein Auftrag gelöscht.
 */
export async function verwerfeNeuenAblaufAuftrag(admin: SupabaseClient, jobId: string, grund: string): Promise<boolean> {
  try {
    const { data: docs } = await admin.from("documents").select("id, storage_path").eq("job_id", jobId);
    const liste = (docs ?? []) as { id: string; storage_path: string | null }[];
    if (liste.length) {
      const pfade = liste.map((d) => d.storage_path).filter((p): p is string => !!p);
      if (pfade.length) await admin.storage.from("documents").remove(pfade);
      await admin.from("documents").delete().in("id", liste.map((d) => d.id));
    }
    const { count, error } = await admin.from("jobs").delete({ count: "exact" }).eq("id", jobId);
    if (error || count !== 1) {
      logError("ablauf.neuer_auftrag.verwerfen", error?.message ?? `gelöscht: ${count}`, { jobId, grund });
      return false;
    }
    return true;
  } catch (e) {
    logError("ablauf.neuer_auftrag.verwerfen", e, { jobId, grund });
    return false;
  }
}

/**
 * Mail ohne Zuordnung: neue Privatvermietungs-Anfrage? (Vertrag Punkt 1)
 *  a) Absender = Partner-Konto einer Location mit Partner-Kalender, oder
 *  b) die KI erkennt eine neue Anfrage für eine solche Location (Vorfilter: Mail nennt die Location).
 * In beiden Fällen zählt nur «eindeutig».
 * Am selben Tag an derselben Location (siehe anfrageAmTag): Ablauf-Auftrag desselben Mieters → dorthin
 * (via 'ki'); anderer Auftrag → null (Mail wartet, Admin entscheidet); sonst neuer Auftrag (via 'ablauf').
 * Zwei gleichzeitige Mails: nach dem Anlegen erneut prüfen, der jüngere eigene Auftrag wird verworfen.
 * Wirft nie.
 */
export async function neuerAuftragAusMail(
  admin: SupabaseClient,
  opts: { auftragMailId: string; mail: ErkennungMail; anhaenge: () => Promise<ErkennungAnhang[]> },
): Promise<{ jobId: string; via: "ablauf" | "ki" } | null> {
  const { mail } = opts;
  try {
    const { data: locs, error } = await admin.from("locations").select("id, name").eq("partner_kalender", true);
    if (error) throw new Error(error.message);
    const locations = (locs ?? []) as KalenderLocation[];
    if (!locations.length) return null;

    const absender = nurAdresse(mail.von);
    const partnerRows = await partnerKonten(admin);
    const partner = partnerRows.find(
      (p) => p.is_active && (p.email ?? "").toLowerCase() === absender && locations.some((l) => l.id === p.partner_location_id),
    );
    const partnerLocationId = partner?.partner_location_id ?? null;
    if (!partnerLocationId && !erwaehnteLocations(mail, locations).length) return null; // keine KI für fremde Mails

    const erg = await erkenneAnfrage(mail, {
      locations,
      partnerLocationId,
      anhaenge: await opts.anhaenge(),
      gesperrteAdressen: partnerRows.map((p) => (p.email ?? "").toLowerCase()),
    });
    if (!erg || !erg.neueAnfrage) return null;
    const locationId = erg.locationId ?? partnerLocationId;
    if (!locationId) return null;
    if (erg.sicherheit !== "eindeutig") return null; // auch beim Partner-Absender nur «eindeutig»
    const felder = erg.felder;
    if (!felder.datum) return null;

    // Mieter der neuen Anfrage: E-Mail aus den Feldern, bei Privatpersonen auch der Absender selbst.
    const mieter = {
      emails: [felder.email ?? "", !partner && !istEventlineDomain(absender) ? absender : ""].filter(Boolean),
      name: felder.mieter ?? "",
    };
    const vorher = anfrageAmTag(await auftraegeAmTag(admin, locationId, felder.datum), mieter);
    if (vorher.art === "bestehend") return { jobId: vorher.jobId, via: "ki" };
    if (vorher.art === "warten") return null;

    const { felder: voll } = felderAusDb(felder);
    const quelle: Partial<Record<FeldName, FeldQuelle>> = {};
    for (const k of Object.keys(felder) as FeldName[]) quelle[k] = "mail";
    const zeitraum = jobZeitraum(voll);
    if (!zeitraum) return null;
    const gaeste = /^\d{1,5}$/.test(voll.gaeste.trim()) ? Number(voll.gaeste.trim()) : null;

    const { data: neu, error: insErr } = await admin
      .from("jobs")
      .insert({
        title: jobTitel(voll),
        job_type: "location",
        location_id: locationId,
        // Normaler Auftrag («Bevorstehend»): 'anfrage' ist ein Alt-Status ohne Liste.
        status: "offen",
        ...zeitraum,
        contact_person: voll.mieter || null,
        contact_phone: voll.telefon || null,
        contact_email: voll.email || null,
        guest_count: gaeste,
        project_lead_id: await projektleitung(admin),
        created_by: null,
      })
      .select("id")
      .single();
    if (insErr || !neu) throw new Error("Auftrag anlegen: " + (insErr?.message ?? "ohne ID"));
    const jobId = (neu as { id: string }).id;

    const { error: abErr } = await admin
      .from("auftrag_ablauf")
      .insert({ job_id: jobId, schritt: 1, erledigt: [], felder: felderZuDb(voll, quelle) });
    if (abErr) {
      // Ohne Ablauf kein halber Auftrag: wieder entfernen, Mail wartet wie bisher.
      logError("ablauf.neuer_auftrag.ablauf", abErr.message, { jobId });
      await verwerfeNeuenAblaufAuftrag(admin, jobId, "Ablauf nicht angelegt");
      return null;
    }

    // Gleichzeitige zweite Mail? Erneut zählen — der jüngere eigene Auftrag wird verworfen.
    let danach: ReturnType<typeof nachAnlage> = { art: "behalten" };
    try {
      danach = nachAnlage(await auftraegeAmTag(admin, locationId, felder.datum), jobId, mieter);
    } catch (e) {
      logError("ablauf.neuer_auftrag.nachpruefung", e, { jobId });
    }
    if (danach.art === "verwerfen") {
      const weg = await verwerfeNeuenAblaufAuftrag(admin, jobId, "gleichzeitige Anfrage");
      if (weg) return danach.ziel ? { jobId: danach.ziel, via: "ki" } : null;
      // Löschen gescheitert → die Mail bleibt beim eigenen Auftrag (nichts geht verloren).
    }

    const wer = partnerLocationId ? `Absender ${absender}` : "Neue Mietanfrage erkannt";
    const uebernommen = Object.keys(felder).length ? ", Felder aus der Anfrage übernommen" : "";
    await ereignisAnlegen(
      admin,
      jobId,
      { text: `${wer} → Ablauf erkannt, Auftrag angelegt${uebernommen}${erg.grund ? ` (${erg.grund})` : ""}`, schritt: null, quelle: "system", auftragMailId: opts.auftragMailId },
      null,
    );
    return { jobId, via: "ablauf" };
  } catch (e) {
    logError("ablauf.neuer_auftrag", e);
    return null;
  }
}
