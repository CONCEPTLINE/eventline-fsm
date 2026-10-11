"use client";

// Offline-Rapport (Handy): Entwurf write-ahead in IndexedDB, Fotos/Unter-
// schriften als Blobs, Sync-Kette zum Server (Konzept §4 «Rapport»).
//
// Sync-Kette je Auftrag (strikt nacheinander, eine Sperre je job_id):
//   (1) service_reports INSERT mit id = report_id (Client-UUID).
//       23505 Trigger («Rapport») → am Server schon abgeschlossen → Nachtrag.
//       23505 Unique-Entwurf      → Server-Entwurf laden und ZUSAMMENFUEHREN
//                                   (Entscheid Mischa 2026-10-11, README Welle 2).
//   (2) Fotos nach documents/rapport-photos/{serverId}/{localId}.jpg,
//       report_photos mit id = localId (23505 = schon da). Blob danach weg.
//   (3) Unterschriften nach signatures/{serverId}/tech.png | client.png;
//       die Pfade gehen im selben UPDATE wie (4) mit.
//   (4) Text-UPDATE mit .eq("updated_at", base_updated_at) und select():
//       0 Zeilen → Server-Stand laden: abgeschlossen → Nachtrag; unveraendert
//       → kein Schreibrecht (RLS) → «fehler»; geaendert → «konflikt», der
//       Nutzer waehlt «Server-Version uebernehmen» oder «Meine senden».
//       Nach jedem eigenen Schreibvorgang wird base_updated_at aus der
//       Antwort uebernommen.
//   (5) POST /api/reports/[id]/finalize — nur wenn finalize_requested_at
//       gesetzt und (1)–(4) ohne Konflikt durch sind. Idempotent.
//
// Netz-/Auth-Fehler lassen den Entwurf auf «lokal» und planen einen Backoff
// (2 s → 60 s). Trigger (online, sichtbar, Realtime) registriert die Seite
// via registriereSyncTrigger (sync-trigger.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";
import { formatJobNumber } from "@/lib/nummern-format";
import { todayLocalIso } from "@/lib/swiss-time";
import { MAX_UPLOAD_SIZE_BYTES } from "@/lib/file-upload";
import { istNetzfehler } from "./stempel-outbox";
import {
  aktualisiereBlob,
  aktualisiereRapportDraft,
  cacheLesen,
  istQuotaFehler,
  ladeBlobs,
  ladeRapportDraft,
  ladeRapportDrafts,
  loescheBlob,
  loescheRapportDraft,
  speichereBlob,
  speichereRapportDraft,
  type RapportBlob,
  type RapportDraft,
  type RapportDraftForm,
  type RapportDraftStatus,
  type RapportDraftTimeRange,
} from "./db";

/** Window-Event nach jeder Aenderung eines Entwurfs. detail: { jobId }. */
export const RAPPORT_OUTBOX_EVENT = "rapport:outbox";

export const MAX_FOTOS = 30;

function melde(jobId: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(RAPPORT_OUTBOX_EVENT, { detail: { jobId } }));
}

/** Fuer Aufrufer, die einen Entwurf direkt ueber db.ts schreiben (z. B. der
 *  Abgleich beim Laden in rapport-mobil): Aenderung nach aussen melden, damit
 *  OfflineStreifen/UebertragungenSheet den Stand neu lesen. */
export function meldeRapportAenderung(jobId: string) {
  melde(jobId);
}

// ---------------------------------------------------------------------------
// Fortschritt («Wird gesendet 2/5») — nur im Speicher, je Auftrag.
// ---------------------------------------------------------------------------

export interface RapportFortschritt {
  done: number;
  total: number;
}
const fortschritte = new Map<string, RapportFortschritt>();
export function rapportFortschritt(jobId: string): RapportFortschritt | null {
  return fortschritte.get(jobId) ?? null;
}

// ---------------------------------------------------------------------------
// Server-Zeile
// ---------------------------------------------------------------------------

export interface ServerRapport {
  id: string;
  job_id: string;
  created_by: string;
  status: "entwurf" | "abgeschlossen";
  updated_at: string;
  report_date: string;
  work_description: string;
  equipment_used: string | null;
  issues: string | null;
  client_name: string | null;
  technician_name: string | null;
  time_ranges: RapportDraftTimeRange[] | null;
  signature_url: string | null;
  technician_signature_url: string | null;
  client_absent: boolean | null;
  pdf_url: string | null;
  creator: { full_name: string } | { full_name: string }[] | null;
}

const SERVER_SELECT =
  "id, job_id, created_by, status, updated_at, report_date, work_description, equipment_used, issues, " +
  "client_name, technician_name, time_ranges, signature_url, technician_signature_url, client_absent, pdf_url, " +
  "creator:profiles!created_by(full_name)";

export function erstellerName(r: ServerRapport | null | undefined): string {
  if (!r?.creator) return "Kollege";
  const c = Array.isArray(r.creator) ? r.creator[0] : r.creator;
  return c?.full_name ?? "Kollege";
}

/** Neuester Rapport des Auftrags (wie das Desktop-Modal: egal von wem). */
export async function ladeServerRapport(sb: SupabaseClient, jobId: string) {
  const { data, error, status } = await sb
    .from("service_reports")
    .select(SERVER_SELECT)
    .eq("job_id", jobId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return { row: (data as unknown as ServerRapport | null) ?? null, error, status };
}

async function ladeServerRapportNachId(sb: SupabaseClient, id: string) {
  const { data, error, status } = await sb.from("service_reports").select(SERVER_SELECT).eq("id", id).maybeSingle();
  return { row: (data as unknown as ServerRapport | null) ?? null, error, status };
}

async function ladeServerEntwurf(sb: SupabaseClient, jobId: string) {
  const { data, error, status } = await sb
    .from("service_reports")
    .select(SERVER_SELECT)
    .eq("job_id", jobId)
    .eq("status", "entwurf")
    .maybeSingle();
  return { row: (data as unknown as ServerRapport | null) ?? null, error, status };
}

// ---------------------------------------------------------------------------
// Formular-Helfer
// ---------------------------------------------------------------------------

export function leeresFormular(vorgabe: Partial<RapportDraftForm> = {}): RapportDraftForm {
  return {
    work_description: "",
    equipment_used: "",
    issues: "",
    client_name: "",
    signer_type: "kunde",
    signer_role: "",
    client_absent: false,
    technician_id: "",
    technician_name: "",
    time_ranges: [],
    signature_url: null,
    technician_signature_url: null,
    ...vorgabe,
  };
}

/** Server-Zeile → Formular. signer_type/signer_role stehen nicht in der DB. */
export function serverZuForm(r: ServerRapport, basis?: RapportDraftForm): RapportDraftForm {
  return {
    work_description: r.work_description ?? "",
    equipment_used: r.equipment_used ?? "",
    issues: r.issues ?? "",
    client_name: r.client_name ?? "",
    signer_type: basis?.signer_type ?? "kunde",
    signer_role: basis?.signer_role ?? "",
    client_absent: !!r.client_absent,
    technician_id: basis?.technician_id ?? "",
    technician_name: r.technician_name ?? basis?.technician_name ?? "",
    time_ranges: Array.isArray(r.time_ranges) ? r.time_ranges : [],
    signature_url: r.signature_url ?? null,
    technician_signature_url: r.technician_signature_url ?? null,
  };
}

function rangeKey(t: RapportDraftTimeRange): string {
  return `${t.date}|${t.start}|${t.end}|${t.pause ?? 0}|${t.technician_id}`;
}

function hatZeit(t: RapportDraftTimeRange): boolean {
  return !!(t.date || t.start || t.end || t.technician_id);
}

/** Text-Zusammenfuehrung: einer leer → der andere; beide → untereinander mit Namen. */
function textZusammen(server: string | null, mein: string, meName: string): string {
  const s = (server ?? "").trim();
  const m = mein.trim();
  if (!m) return s;
  if (!s) return m;
  if (s === m || s.includes(m)) return s;
  return `${s}\n\n— ${meName}:\n${m}`;
}

/**
 * Zwei Entwuerfe zusammenfuehren (fremder Server-Entwurf + meiner):
 * Zeiten = Server + meine ohne exakte Duplikate, Texte wie textZusammen,
 * Kundenunterschrift: Server behaelt, meine nur wenn Server keine hat.
 */
export function zusammenfuehren(server: ServerRapport, mein: RapportDraftForm, meName: string): RapportDraftForm {
  const serverRanges = Array.isArray(server.time_ranges) ? server.time_ranges : [];
  const keys = new Set(serverRanges.map(rangeKey));
  const ranges = [...serverRanges];
  for (const t of mein.time_ranges) {
    if (!hatZeit(t)) continue;
    const k = rangeKey(t);
    if (keys.has(k)) continue;
    keys.add(k);
    const kopie = { ...t };
    delete kopie.quelle;
    ranges.push(kopie);
  }
  ranges.sort((a, z) => (a.date + a.start).localeCompare(z.date + z.start));
  const serverHatKunde = !!server.signature_url || !!server.client_absent;
  return {
    work_description: textZusammen(server.work_description, mein.work_description, meName),
    equipment_used: textZusammen(server.equipment_used, mein.equipment_used, meName),
    issues: textZusammen(server.issues, mein.issues, meName),
    client_name: (server.client_name ?? "").trim() || mein.client_name,
    signer_type: mein.signer_type,
    signer_role: server.client_name ? "" : mein.signer_role,
    client_absent: serverHatKunde ? !!server.client_absent : mein.client_absent,
    technician_id: mein.technician_id,
    technician_name: (server.technician_name ?? "").trim() || mein.technician_name,
    time_ranges: ranges,
    signature_url: server.signature_url ?? null,
    technician_signature_url: server.technician_signature_url ?? null,
  };
}

/** Eigener Server-Entwurf (Desktop) + lokaler dirty Entwurf: lokal gewinnt feldweise, wo lokal etwas steht. */
export function feldweise(server: ServerRapport, mein: RapportDraftForm): RapportDraftForm {
  const s = serverZuForm(server, mein);
  const meineZeiten = mein.time_ranges.filter(hatZeit);
  return {
    ...s,
    work_description: mein.work_description.trim() ? mein.work_description : s.work_description,
    equipment_used: mein.equipment_used.trim() ? mein.equipment_used : s.equipment_used,
    issues: mein.issues.trim() ? mein.issues : s.issues,
    client_name: mein.client_name.trim() ? mein.client_name : s.client_name,
    client_absent: mein.client_absent || s.client_absent,
    technician_name: mein.technician_name || s.technician_name,
    time_ranges: meineZeiten.length > 0 ? mein.time_ranges : s.time_ranges,
  };
}

/** Pflichtfelder wie das Desktop-Modal (handleFinalSubmit). null = vollstaendig. */
export function fehlendePflichtfelder(form: RapportDraftForm): string | null {
  if (!form.work_description.trim()) return "Arbeitsbeschreibung fehlt";
  const ranges = form.time_ranges;
  if (ranges.length === 0) return "Einsatzzeit fehlt";
  for (let i = 0; i < ranges.length; i++) {
    const t = ranges[i];
    const tag = ranges.length > 1 ? `Zeit ${i + 1}: ` : "";
    if (!t.date) return `${tag}Datum fehlt`;
    if (!t.start) return `${tag}Von-Zeit fehlt`;
    if (!t.end) return `${tag}Bis-Zeit fehlt`;
    if (!t.technician_id) return `${tag}Techniker fehlt`;
  }
  return null;
}

/** Kundenname fuer den Abschluss — wie das Desktop-Modal («Name (Rolle)» bei Mieter). */
function clientNameFinal(form: RapportDraftForm): string | null {
  if (form.client_absent) return null;
  const n = form.client_name.trim();
  if (!n) return null;
  return form.signer_type === "mieter" && form.signer_role.trim() ? `${n} (${form.signer_role.trim()})` : n;
}

function serverPayload(form: RapportDraftForm, finalisieren: boolean, clientPath: string | null, techPath: string | null) {
  return {
    report_date: form.time_ranges[0]?.date || todayLocalIso(),
    work_description: form.work_description,
    equipment_used: form.equipment_used || null,
    issues: form.issues || null,
    client_name: finalisieren ? clientNameFinal(form) : form.client_name || null,
    technician_name: form.technician_name || null,
    time_ranges: form.time_ranges,
    signature_url: form.client_absent ? null : clientPath,
    technician_signature_url: techPath,
    client_absent: form.client_absent,
  };
}

// ---------------------------------------------------------------------------
// Lokal schreiben (write-ahead)
// ---------------------------------------------------------------------------

export function neuerDraft(jobId: string, userId: string, form: RapportDraftForm): RapportDraft {
  return {
    job_id: jobId,
    user_id: userId,
    report_id: crypto.randomUUID(),
    server_id: null,
    base_updated_at: null,
    form,
    local_updated_at: new Date().toISOString(),
    dirty: false,
    finalize_requested_at: null,
    status: "lokal",
    last_error: null,
    merged_with: null,
    server_form: null,
    pdf_url: null,
  };
}

/**
 * Eingabe sofort in IndexedDB. Liefert den gespeicherten Entwurf oder null
 * bei Quota-/IDB-Fehler (dann Toast; nichts darf als gespeichert gelten).
 */
export async function speichereEingabe(draft: RapportDraft, form: RapportDraftForm): Promise<RapportDraft | null> {
  const neu: RapportDraft = {
    ...draft,
    form,
    local_updated_at: new Date().toISOString(),
    dirty: true,
    merged_with: null,
    status: draft.status === "gesendet" || draft.status === "fehler" ? "lokal" : draft.status,
    last_error: draft.status === "fehler" ? null : draft.last_error,
  };
  try {
    await speichereRapportDraft(neu);
  } catch (e) {
    toast.error(istQuotaFehler(e)
      ? "Speicher auf dem Gerät voll — Eingabe nicht gespeichert"
      : `Konnte nicht gespeichert werden: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  melde(draft.job_id);
  return neu;
}

/** Blob (Foto/Unterschrift) write-ahead ablegen. false = nicht gespeichert (Toast). */
export async function speichereBlobSicher(blob: RapportBlob): Promise<boolean> {
  try {
    await speichereBlob(blob);
  } catch (e) {
    toast.error(istQuotaFehler(e)
      ? "Speicher auf dem Gerät voll — Foto nicht gespeichert"
      : `Konnte nicht gespeichert werden: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  return true;
}

/** Abschluss vormerken (offline) bzw. anstossen (online). dirty=true, damit
 *  Schritt 4 den Abschluss-Stand (Kundenname mit Rolle) nochmals schreibt. */
export async function abschlussVormerken(jobId: string): Promise<RapportDraft | null> {
  const d = await aktualisiereRapportDraft(jobId, {
    finalize_requested_at: new Date().toISOString(),
    dirty: true,
    status: "lokal",
    last_error: null,
  });
  melde(jobId);
  return d;
}

/** Konflikt: Server-Version gilt — lokale Texte/Zeiten werden ersetzt, Fotos bleiben (additiv). */
export async function konfliktServerUebernehmen(jobId: string, meId: string): Promise<void> {
  const d = await ladeRapportDraft(jobId, meId);
  if (!d || !d.server_form) return;
  await aktualisiereRapportDraft(jobId, {
    form: { ...d.server_form, signer_type: d.form.signer_type, signer_role: d.form.signer_role, technician_id: d.form.technician_id },
    server_form: null,
    dirty: false,
    status: "lokal",
    last_error: null,
    local_updated_at: new Date().toISOString(),
  });
  melde(jobId);
}

/** Konflikt: meine Version ueberschreibt den Server (base = aktueller Server-Stand). */
export async function konfliktMeineSenden(jobId: string): Promise<void> {
  await aktualisiereRapportDraft(jobId, { server_form: null, dirty: true, status: "lokal", last_error: null });
  melde(jobId);
}

/** Fehler zuruecksetzen → naechster Lauf versucht es erneut. */
export async function erneutVersuchen(jobId: string): Promise<void> {
  await aktualisiereRapportDraft(jobId, { status: "lokal", last_error: null });
  melde(jobId);
}

// ---------------------------------------------------------------------------
// Fehler einordnen
// ---------------------------------------------------------------------------

interface DbFehler {
  code?: string | null;
  message?: string | null;
}

type Ausgang =
  | { art: "weiter" }
  | { art: "wartet"; fehler: string }
  | { art: "stopp"; status: Exclude<RapportDraftStatus, "lokal" | "sendet" | "gesendet">; fehler: string | null };

const OHNE_NETZ = "Kein Netz";

function istAuthFehler(error: DbFehler | null, status: number | undefined): boolean {
  if (status === 401) return true;
  if (error?.code === "PGRST301") return true;
  return /jwt/i.test(error?.message ?? "");
}

function istTriggerAbgeschlossen(error: DbFehler | null): boolean {
  return error?.code === "23505" && /Rapport/i.test(error.message ?? "");
}

function einordnen(error: DbFehler, status: number | undefined, kontext: string): Ausgang {
  if (istNetzfehler(error, status)) return { art: "wartet", fehler: OHNE_NETZ };
  if (istAuthFehler(error, status)) return { art: "wartet", fehler: "Sitzung abgelaufen — wird nach dem Anmelden gesendet" };
  if (istTriggerAbgeschlossen(error)) return { art: "stopp", status: "bereits_abgeschlossen", fehler: null };
  if (error.code === "42501") return { art: "stopp", status: "fehler", fehler: `${kontext}: kein Schreibrecht auf diesen Rapport` };
  return { art: "stopp", status: "fehler", fehler: `${kontext}: ${error.message || "Unbekannter Fehler"}` };
}

// ---------------------------------------------------------------------------
// Sperre je Auftrag + Backoff
// ---------------------------------------------------------------------------

const ketten = new Map<string, Promise<unknown>>();
function mitSperre<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const vorher = ketten.get(jobId) ?? Promise.resolve();
  const p = vorher.then(fn, fn);
  ketten.set(jobId, p.catch(() => {}));
  return p;
}

const backoffs = new Map<string, { timer: ReturnType<typeof setTimeout> | null; n: number }>();
function planeBackoff(sb: SupabaseClient, meId: string, meName: string, jobId: string) {
  const alt = backoffs.get(jobId);
  if (alt?.timer) return;
  const n = alt?.n ?? 0;
  const delay = Math.min(60_000, 2_000 * 2 ** n);
  const timer = setTimeout(() => {
    backoffs.set(jobId, { timer: null, n: n + 1 });
    void syncRapport(sb, meId, meName, jobId);
  }, delay);
  backoffs.set(jobId, { timer, n: n + 1 });
}
function backoffZuruecksetzen(jobId: string) {
  const b = backoffs.get(jobId);
  if (b?.timer) clearTimeout(b.timer);
  backoffs.delete(jobId);
}

// ---------------------------------------------------------------------------
// Sync-Lauf
// ---------------------------------------------------------------------------

async function setze(jobId: string, patch: Partial<Omit<RapportDraft, "job_id" | "user_id">>): Promise<RapportDraft | null> {
  const d = await aktualisiereRapportDraft(jobId, patch);
  melde(jobId);
  return d;
}

/**
 * Sendet den Entwurf eines Auftrags (alle Schritte, die anstehen). Laeuft
 * nie doppelt je Auftrag. Ohne Netz passiert nichts.
 */
export function syncRapport(sb: SupabaseClient, meId: string, meName: string, jobId: string): Promise<void> {
  return mitSperre(jobId, async () => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    let d: RapportDraft | null;
    try {
      d = await ladeRapportDraft(jobId, meId);
    } catch {
      return;
    }
    if (!d) return;
    if (d.status === "konflikt" || d.status === "fehler" || d.status === "bereits_abgeschlossen" || d.status === "abgeschlossen") return;

    let blobs = await ladeBlobs(d.report_id);
    const sigBlobs = blobs.filter((b) => b.kind !== "photo");
    const fotoBlobs = blobs.filter((b) => b.kind === "photo");
    const willFinalisieren = !!d.finalize_requested_at;
    const hatArbeit = d.dirty || blobs.length > 0 || (willFinalisieren && !!d.server_id);
    if (!hatArbeit) {
      if (d.status !== "gesendet") await setze(jobId, { status: "gesendet" });
      return;
    }

    const total = (d.server_id ? 0 : 1) + fotoBlobs.length + 1 + (willFinalisieren ? 1 : 0);
    let done = 0;
    const tick = () => {
      fortschritte.set(jobId, { done, total });
      melde(jobId);
    };
    fortschritte.set(jobId, { done, total });
    d = (await setze(jobId, { status: "sendet" })) ?? d;

    const ende = async (a: Ausgang): Promise<void> => {
      fortschritte.delete(jobId);
      if (a.art === "wartet") {
        await setze(jobId, { status: "lokal", last_error: a.fehler });
        planeBackoff(sb, meId, meName, jobId);
        return;
      }
      if (a.art === "stopp") {
        await setze(jobId, { status: a.status, last_error: a.fehler });
      }
    };

    try {
      // ── (1) Server-Zeile sicherstellen ─────────────────────────────────
      if (!d.server_id) {
        const vorInsert = d.local_updated_at;
        const payload = serverPayload(d.form, false, null, null);
        const { data, error, status } = await sb
          .from("service_reports")
          .insert({ id: d.report_id, job_id: jobId, created_by: meId, status: "entwurf", ...payload })
          .select("id, updated_at")
          .single();
        if (!error && data) {
          // Insert trug den ganzen Stand — nur wenn seither nichts getippt wurde, gilt er als geschrieben.
          const jetzt = (await ladeRapportDraft(jobId, meId)) ?? d;
          d = (await setze(jobId, {
            server_id: data.id as string,
            base_updated_at: data.updated_at as string,
            dirty: jetzt.local_updated_at !== vorInsert,
          })) ?? d;
        } else if (error?.code === "23505" && !istTriggerAbgeschlossen(error)) {
          if (/pkey/i.test(error.message)) {
            // Eigener Insert kam an, Antwort ging verloren.
            const eigene = await ladeServerRapportNachId(sb, d.report_id);
            if (eigene.error) return ende(einordnen(eigene.error, eigene.status, "Rapport laden"));
            if (!eigene.row) return ende({ art: "stopp", status: "fehler", fehler: "Rapport am Server nicht gefunden" });
            d = (await setze(jobId, { server_id: eigene.row.id, base_updated_at: eigene.row.updated_at })) ?? d;
          } else {
            // Unique-Entwurf: jemand (oder ich am Computer) hat schon einen Entwurf.
            const s = await ladeServerEntwurf(sb, jobId);
            if (s.error) return ende(einordnen(s.error, s.status, "Entwurf laden"));
            if (!s.row) return ende({ art: "stopp", status: "fehler", fehler: "Entwurf am Server nicht gefunden — bitte erneut versuchen" });
            const frisch = (await ladeRapportDraft(jobId, meId)) ?? d;
            const fremd = s.row.created_by !== meId;
            const form = fremd ? zusammenfuehren(s.row, frisch.form, meName) : feldweise(s.row, frisch.form);
            if (fremd && s.row.signature_url) {
              // Server hat schon eine Kundenunterschrift: meine wird abgelegt, nicht verknuepft.
              for (const b of sigBlobs) if (b.kind === "sig_client") await aktualisiereBlob(b.local_id, { caption: "ablage" });
            }
            d = (await setze(jobId, {
              server_id: s.row.id,
              base_updated_at: s.row.updated_at,
              form,
              dirty: true,
              merged_with: fremd ? erstellerName(s.row) : null,
              local_updated_at: new Date().toISOString(),
            })) ?? d;
            blobs = await ladeBlobs(d.report_id);
          }
        } else if (error) {
          return ende(einordnen(error, status, "Rapport anlegen"));
        }
        done++;
        tick();
      }
      const serverId = d.server_id!;

      // ── (2) Fotos ──────────────────────────────────────────────────────
      for (const b of blobs.filter((x) => x.kind === "photo")) {
        await aktualisiereBlob(b.local_id, { upload_status: "sendet" });
        melde(jobId);
        const pfad = `rapport-photos/${serverId}/${b.local_id}.jpg`;
        const up = await sb.storage.from("documents").upload(pfad, b.blob, { contentType: b.blob.type || "image/jpeg", upsert: true });
        if (up.error) {
          const a = einordnen({ message: up.error.message }, undefined, "Foto hochladen");
          await aktualisiereBlob(b.local_id, { upload_status: a.art === "wartet" ? "wartet" : "fehler" });
          return ende(a);
        }
        const ins = await sb.from("report_photos").insert({ id: b.local_id, report_id: serverId, storage_path: pfad, caption: b.caption, sort_order: b.sort });
        if (ins.error && ins.error.code !== "23505") {
          const a = einordnen(ins.error, ins.status, "Foto speichern");
          await aktualisiereBlob(b.local_id, { upload_status: a.art === "wartet" ? "wartet" : "fehler" });
          return ende(a);
        }
        await loescheBlob(b.local_id);
        done++;
        tick();
      }

      // ── (3) Unterschriften ─────────────────────────────────────────────
      let techPath = d.form.technician_signature_url;
      let clientPath = d.form.signature_url;
      const hochgeladen: string[] = [];
      for (const b of blobs.filter((x) => x.kind !== "photo")) {
        const ablage = b.kind === "sig_client" && b.caption === "ablage";
        const datei = b.kind === "sig_tech" ? "tech.png" : ablage ? `client_${meId}.png` : "client.png";
        const pfad = `signatures/${serverId}/${datei}`;
        const up = await sb.storage.from("documents").upload(pfad, b.blob, { contentType: "image/png", upsert: true });
        if (up.error) return ende(einordnen({ message: up.error.message }, undefined, "Unterschrift hochladen"));
        if (b.kind === "sig_tech") techPath = pfad;
        else if (!ablage) clientPath = pfad;
        hochgeladen.push(b.local_id);
      }

      // ── (4) Text-Update mit Basis-Pruefung ─────────────────────────────
      const frischVor = (await ladeRapportDraft(jobId, meId)) ?? d;
      if (frischVor.dirty || hochgeladen.length > 0) {
        const payload = serverPayload(frischVor.form, !!frischVor.finalize_requested_at, clientPath, techPath);
        const basis = frischVor.base_updated_at ?? d.base_updated_at ?? "";
        const { data, error, status } = await sb
          .from("service_reports")
          .update(payload)
          .eq("id", serverId)
          .eq("updated_at", basis)
          .select("updated_at");
        if (error) return ende(einordnen(error, status, "Rapport speichern"));
        if (!data || data.length === 0) {
          const s = await ladeServerRapportNachId(sb, serverId);
          if (s.error) return ende(einordnen(s.error, s.status, "Rapport laden"));
          if (!s.row) return ende({ art: "stopp", status: "fehler", fehler: "Rapport am Server nicht gefunden" });
          if (s.row.status === "abgeschlossen") return ende({ art: "stopp", status: "bereits_abgeschlossen", fehler: null });
          if (s.row.updated_at === basis) {
            return ende({
              art: "stopp",
              status: "fehler",
              fehler: `Kein Schreibrecht — der Entwurf gehört ${erstellerName(s.row)}. Die Freigabe für zugeteilte Techniker ist noch nicht eingespielt.`,
            });
          }
          fortschritte.delete(jobId);
          await setze(jobId, { status: "konflikt", server_form: serverZuForm(s.row, frischVor.form), base_updated_at: s.row.updated_at, last_error: null });
          return;
        }
        for (const id of hochgeladen) await loescheBlob(id);
        const neueBasis = (data[0] as { updated_at: string }).updated_at;
        const frischNach = (await ladeRapportDraft(jobId, meId)) ?? frischVor;
        if (frischNach.local_updated_at !== frischVor.local_updated_at) {
          // Waehrend des Sendens weiter getippt → Basis uebernehmen, naechster Lauf schreibt nach.
          fortschritte.delete(jobId);
          await setze(jobId, { base_updated_at: neueBasis, status: "lokal", last_error: null });
          backoffZuruecksetzen(jobId);
          void syncRapport(sb, meId, meName, jobId);
          return;
        }
        d = (await setze(jobId, {
          base_updated_at: neueBasis,
          dirty: false,
          form: { ...frischNach.form, signature_url: frischNach.form.client_absent ? null : clientPath, technician_signature_url: techPath },
          last_error: null,
        })) ?? d;
      }
      done++;
      tick();

      // ── (5) Abschluss ──────────────────────────────────────────────────
      if (d.finalize_requested_at) {
        let res: Response;
        try {
          res = await fetch(`/api/reports/${serverId}/finalize`, { method: "POST" });
        } catch (e) {
          return ende({ art: "wartet", fehler: istNetzfehler({ message: e instanceof Error ? e.message : String(e) }, 0) ? OHNE_NETZ : "Abschluss nicht erreichbar" });
        }
        const json = (await res.json().catch(() => null)) as { success?: boolean; error?: string; code?: string; pdf_url?: string | null; steps?: Record<string, string> } | null;
        if (res.status === 401) return ende({ art: "wartet", fehler: "Sitzung abgelaufen — wird nach dem Anmelden gesendet" });
        if (!res.ok || !json?.success) {
          if (json?.code === "bereits_abgeschlossen") return ende({ art: "stopp", status: "bereits_abgeschlossen", fehler: null });
          return ende({ art: "stopp", status: "fehler", fehler: json?.error || `Abschluss fehlgeschlagen (HTTP ${res.status})` });
        }
        fortschritte.delete(jobId);
        await setze(jobId, {
          status: "abgeschlossen",
          pdf_url: json.pdf_url ?? null,
          last_error: json.steps?.pdf && json.steps.pdf.startsWith("fehler") ? "PDF konnte noch nicht erzeugt werden" : null,
        });
        backoffZuruecksetzen(jobId);
        window.dispatchEvent(new Event("jobs:invalidate"));
        return;
      }

      fortschritte.delete(jobId);
      backoffZuruecksetzen(jobId);
      await setze(jobId, { status: "gesendet", last_error: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ende(istNetzfehler({ message: msg }, 0) ? { art: "wartet", fehler: OHNE_NETZ } : { art: "stopp", status: "fehler", fehler: msg });
    }
  });
}

/**
 * Abgeschlossener Rapport, aber PDF/Stempel fehlen noch («Erneut versuchen»):
 * finalize ist idempotent und holt nur Fehlendes nach.
 */
export async function abschlussNachholen(jobId: string, meId: string): Promise<string | null> {
  const d = await ladeRapportDraft(jobId, meId);
  if (!d?.server_id) return "Kein Rapport am Server";
  let res: Response;
  try {
    res = await fetch(`/api/reports/${d.server_id}/finalize`, { method: "POST" });
  } catch {
    return OHNE_NETZ;
  }
  const json = (await res.json().catch(() => null)) as { success?: boolean; error?: string; pdf_url?: string | null; steps?: Record<string, string> } | null;
  if (!res.ok || !json?.success) return json?.error || `Abschluss fehlgeschlagen (HTTP ${res.status})`;
  const pdfFehler = json.steps?.pdf?.startsWith("fehler") ? "PDF konnte noch nicht erzeugt werden" : null;
  await setze(jobId, { status: "abgeschlossen", pdf_url: json.pdf_url ?? null, last_error: pdfFehler });
  return pdfFehler;
}

async function sendeAlleEinmal(sb: SupabaseClient, meId: string, meName: string): Promise<void> {
  let drafts: RapportDraft[];
  try {
    drafts = await ladeRapportDrafts(meId);
  } catch {
    return;
  }
  for (const d of drafts) {
    if (d.status === "abgeschlossen" || d.status === "konflikt" || d.status === "fehler" || d.status === "bereits_abgeschlossen") continue;
    try {
      await syncRapport(sb, meId, meName, d.job_id);
    } catch {
      // Ein Entwurf (IDB-Lesefehler) darf die uebrigen nicht blockieren.
    }
  }
}

// Ein Lauf zur Zeit: die Trigger (App-Start, online, sichtbar, Realtime)
// feuern gern kurz nacheinander. Kommt waehrend eines Laufs ein weiterer
// Ausloeser, folgt danach genau ein weiterer Durchgang mit den zuletzt
// uebergebenen Argumenten — kein Ausloeser geht verloren, keiner laeuft doppelt.
type AlleArgs = { sb: SupabaseClient; meId: string; meName: string };
let alleLauf: Promise<void> | null = null;
let alleNochmal: AlleArgs | null = null;

/** Alle Entwuerfe des Nutzers nachsenden (Trigger: App-Start, online, sichtbar). */
export function sendeAlleRapporte(sb: SupabaseClient, meId: string, meName: string): Promise<void> {
  if (alleLauf) {
    alleNochmal = { sb, meId, meName };
    return alleLauf;
  }
  alleLauf = (async () => {
    let args: AlleArgs = { sb, meId, meName };
    for (;;) {
      await sendeAlleEinmal(args.sb, args.meId, args.meName);
      if (!alleNochmal) return;
      args = alleNochmal;
      alleNochmal = null;
    }
  })().finally(() => {
    alleLauf = null;
  });
  return alleLauf;
}

// ---------------------------------------------------------------------------
// Wartende Rapporte (OfflineStreifen / UebertragungenSheet)
// ---------------------------------------------------------------------------

export type WartenderRapport = {
  jobId: string;
  label: string;
  status: "wartet" | "sendet" | "konflikt" | "fehler";
  hinweis: string | null;
};

/** Auftrags-Bezeichnung aus dem Offline-Cache (rapport-mobil legt `job:<id>` beim Laden ab). */
async function rapportLabel(userId: string, jobId: string): Promise<string> {
  const c = await cacheLesen<{ job_number: number | null; title: string }>(userId, `job:${jobId}`).catch(() => null);
  if (!c?.data) return "Rapport";
  const titel = (c.data.title ?? "").trim();
  return titel ? `${formatJobNumber(c.data.job_number)} · ${titel}` : formatJobNumber(c.data.job_number);
}

/**
 * Alle Entwuerfe des Nutzers, die noch nicht fertig sind. «lokal»/«gesendet»
 * zaehlen nur, wenn wirklich etwas zu senden ist (Text geaendert, Abschluss
 * vorgemerkt oder Fotos/Unterschriften noch auf dem Geraet). «bereits
 * abgeschlossen» braucht wie ein Konflikt einen Entscheid des Nutzers.
 */
export async function ladeWartendeRapporte(userId: string): Promise<WartenderRapport[]> {
  let drafts: RapportDraft[];
  try {
    drafts = await ladeRapportDrafts(userId);
  } catch {
    return [];
  }
  drafts.sort((a, z) => a.local_updated_at.localeCompare(z.local_updated_at));
  const liste: WartenderRapport[] = [];
  for (const d of drafts) {
    let status: WartenderRapport["status"];
    let hinweis = d.last_error;
    switch (d.status) {
      case "abgeschlossen":
        continue;
      case "sendet":
        status = "sendet";
        hinweis = null;
        break;
      case "konflikt":
        status = "konflikt";
        hinweis = hinweis ?? "Am Server parallel geändert — im Rapport entscheiden";
        break;
      case "bereits_abgeschlossen":
        status = "konflikt";
        hinweis = "Am Server bereits abgeschlossen — im Rapport als Nachtrag ans Büro senden";
        break;
      case "fehler":
        status = "fehler";
        break;
      default: {
        let offen = d.dirty || !!d.finalize_requested_at;
        if (!offen) {
          const blobs = await ladeBlobs(d.report_id).catch(() => [] as RapportBlob[]);
          offen = blobs.length > 0;
        }
        if (!offen) continue;
        status = "wartet";
      }
    }
    liste.push({ jobId: d.job_id, label: await rapportLabel(userId, d.job_id), status, hinweis });
  }
  return liste;
}

// ---------------------------------------------------------------------------
// Uploaded Foto entfernen (Server) — count exact, 0 Zeilen = kein Recht.
// ---------------------------------------------------------------------------

export async function loescheServerFoto(sb: SupabaseClient, photoId: string, storagePath: string): Promise<string | null> {
  const { error, count } = await sb.from("report_photos").delete({ count: "exact" }).eq("id", photoId);
  if (error) return error.message;
  if ((count ?? 0) === 0) return "Foto konnte nicht entfernt werden — kein Löschrecht auf diesem Rapport";
  // Storage best effort (Waisen sind kein Nutzerproblem).
  await sb.storage.from("documents").remove([storagePath]);
  return null;
}

// ---------------------------------------------------------------------------
// Nachtrag ans Buero (Rapport war am Server schon abgeschlossen)
// ---------------------------------------------------------------------------

function zeitenAlsText(ranges: RapportDraftTimeRange[], namen: Map<string, string>): string {
  return ranges
    .filter(hatZeit)
    .map((t) => `${t.date} ${t.start}–${t.end} (Pause ${t.pause ?? 0} min) ${namen.get(t.technician_id) ?? t.technician_id}`)
    .join("\n");
}

/**
 * Lokalen Entwurf als IT-Ticket «Rapport-Nachtrag INT-Nr» ans Buero senden
 * (Text + Zeiten als Beschreibung, Fotos/Unterschriften als ticket_attachments
 * ueber denselben Upload-Pfad wie new-ticket-modal). Danach ist der lokale
 * Entwurf weg. Liefert eine Fehlermeldung oder null.
 */
export async function sendeAlsNachtrag(
  sb: SupabaseClient,
  meId: string,
  jobId: string,
  jobNumber: number | null,
  namen: Map<string, string>,
): Promise<string | null> {
  const d = await ladeRapportDraft(jobId, meId);
  if (!d) return "Kein Entwurf auf dem Gerät";
  const f = d.form;
  const teile = [
    `Nachtrag zum bereits abgeschlossenen Rapport ${formatJobNumber(jobNumber)}.`,
    f.work_description.trim() ? `Was wurde gemacht:\n${f.work_description.trim()}` : "",
    f.equipment_used.trim() ? `Material:\n${f.equipment_used.trim()}` : "",
    f.issues.trim() ? `Probleme:\n${f.issues.trim()}` : "",
    f.time_ranges.some(hatZeit) ? `Zeiten:\n${zeitenAlsText(f.time_ranges, namen)}` : "",
    f.client_name.trim() ? `Kunde/Mieter vor Ort: ${f.client_name.trim()}${f.signer_role.trim() ? ` (${f.signer_role.trim()})` : ""}` : "",
  ].filter(Boolean);
  const { data: ticket, error } = await sb
    .from("tickets")
    .insert({
      type: "it",
      title: `Rapport-Nachtrag ${formatJobNumber(jobNumber)}`,
      description: teile.join("\n\n"),
      priority: "normal",
      data: { job_id: jobId, quelle: "rapport_nachtrag" },
      created_by: meId,
    })
    .select("id")
    .single();
  if (error || !ticket) return error?.message ?? "Ticket konnte nicht angelegt werden";

  const blobs = await ladeBlobs(d.report_id);
  for (const b of blobs) {
    const name = b.kind === "photo" ? `${b.local_id}.jpg` : b.kind === "sig_tech" ? "unterschrift_techniker.png" : "unterschrift_kunde.png";
    const path = `tickets/${ticket.id}/${Date.now()}_${name}`;
    const up = await sb.storage.from("documents").upload(path, b.blob, { contentType: b.blob.type || undefined });
    if (up.error) return `Datei konnte nicht hochgeladen werden: ${up.error.message}`;
    const ins = await sb.from("ticket_attachments").insert({
      ticket_id: ticket.id,
      storage_path: path,
      filename: name,
      mime_type: b.blob.type || null,
      size_bytes: b.blob.size,
      uploaded_by: meId,
    });
    if (ins.error) return ins.error.message;
  }
  await fetch("/api/tickets/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket_id: ticket.id, event: "created" }),
  }).catch(() => {});
  await loescheRapportDraft(jobId, d.report_id);
  melde(jobId);
  return null;
}

// ---------------------------------------------------------------------------
// Fotos verkleinern — createImageBitmap mit resizeWidth (kein Voll-Canvas,
// iOS-Canvas-Limit), nacheinander, JPEG 0.8. HEIC/Dekodierfehler → Original,
// falls <= 25 MB, sonst Fehler.
// ---------------------------------------------------------------------------

const MAX_KANTE = 1800;

function liesMasse(file: File): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

export async function bereiteFotoVor(file: File): Promise<{ blob: Blob } | { fehler: string }> {
  try {
    const masse = await liesMasse(file);
    if (!masse) throw new Error("decode");
    const quer = masse.w >= masse.h;
    const laenge = quer ? masse.w : masse.h;
    const opts: ImageBitmapOptions = { resizeQuality: "high" };
    if (laenge > MAX_KANTE) {
      if (quer) opts.resizeWidth = MAX_KANTE;
      else opts.resizeHeight = MAX_KANTE;
    }
    const bitmap = await createImageBitmap(file, opts);
    try {
      const w = bitmap.width;
      const h = bitmap.height;
      if (typeof OffscreenCanvas !== "undefined") {
        const c = new OffscreenCanvas(w, h);
        const ctx = c.getContext("2d");
        if (!ctx) throw new Error("canvas");
        ctx.drawImage(bitmap, 0, 0, w, h);
        return { blob: await c.convertToBlob({ type: "image/jpeg", quality: 0.8 }) };
      }
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("canvas");
      ctx.drawImage(bitmap, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.8));
      if (!blob) throw new Error("toBlob");
      return { blob };
    } finally {
      bitmap.close();
    }
  } catch {
    if (file.size <= MAX_UPLOAD_SIZE_BYTES) return { blob: file };
    return { fehler: "Format nicht unterstützt und Datei zu gross — bitte mit dem Kamera-Knopf aufnehmen" };
  }
}

/** dataURL (SignaturePad) → PNG-Blob. */
export async function dataUrlZuBlob(dataUrl: string): Promise<Blob> {
  return (await fetch(dataUrl)).blob();
}
