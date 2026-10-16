// Server-Helfer des Partnerportals (nur in API-Routen importieren) — Gegen-
// stueck zu requireLieferantPortal (src/lib/technik-server.ts).
//
// Seit 2026-10-16 lesen und schreiben Partner-Konten NICHTS mehr direkt in
// jobs / customers / job_appointments / documents / Storage (RLS ohne Partner-
// Zweige, Migration 346). Alles laeuft ueber /api/partner/**: Admin-Client
// NACH der Pruefung hier (eingeloggt, Rolle partner, aktiv, Standort, Recht),
// «eigene Anfrage» nach src/lib/partner-anfrage.ts, Antworten nur mit einer
// festen Feld-Liste. «Ansicht als» (Developer-Mode) wie bei den Lieferanten-
// Routen: es zaehlt das angesehene Konto (effectiveUserId).

import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { istPortalRolle } from "@/lib/portals";
import { isUuid } from "@/lib/search-escape";
import {
  PARTNER_LESE_RECHTE,
  dokumentFuerPartner,
  istEigeneAnfrage,
  partnerOrdner,
  ZURUECKZIEHEN_BESTAETIGT,
  type AnfrageKern,
  type PartnerStandort,
} from "@/lib/partner-anfrage";

export const partnerFehler = (error: string, status: number) =>
  NextResponse.json({ success: false, error }, { status });

export interface PartnerPortalKontext extends PartnerStandort {
  admin: SupabaseClient;
  /** Effektives Partner-Konto (bei «Ansicht als» das angesehene). */
  userId: string;
  userName: string | null;
  standortId: string;
  /** Alle Partner-Konten dieses Standorts (auch deaktivierte) — Teil der
   *  Regel «eigene Anfrage» (Team-Sicht statt 1 Konto pro Standort). */
  teamIds: string[];
  /** Partner-Konten anderer Standorte — deren Anfragen sind nie «eigen». */
  fremdePartnerIds: string[];
  /** Recht der Partner-Rolle (partner:*). */
  darf: (recht: string) => boolean;
  /** Eine der Portal-Leserechte (PARTNER_LESE_RECHTE). */
  darfLesen: boolean;
}

/** Auth-Gate fuer alle Partnerportal-Routen: eingeloggtes, AKTIVES Partner-
 *  Konto mit Standort. Rechte kommen aus roles.permissions der Partner-Rolle
 *  (dieselbe Quelle wie has_permission()). */
export async function requirePartnerPortal(): Promise<
  { error: NextResponse } | ({ error: null } & PartnerPortalKontext)
> {
  const auth = await requireUser();
  if (auth.error) return { error: auth.error };
  const admin = createAdminClient();
  const { data: profil, error: pErr } = await admin
    .from("profiles")
    .select("role, partner_location_id, is_active, full_name")
    .eq("id", auth.effectiveUserId)
    .maybeSingle();
  if (pErr) {
    logError("partner.portal.profil", pErr);
    return { error: partnerFehler("Laden fehlgeschlagen", 500) };
  }
  if (!profil || profil.is_active !== true || profil.role !== "partner" || !profil.partner_location_id) {
    return { error: partnerFehler("Kein Zugriff", 403) };
  }
  const standortId = profil.partner_location_id as string;
  const [rolleRes, partnerRes] = await Promise.all([
    admin.from("roles").select("permissions").eq("slug", profil.role).maybeSingle(),
    admin.from("profiles").select("id, partner_location_id").eq("role", "partner"),
  ]);
  if (rolleRes.error || partnerRes.error) {
    logError("partner.portal.rechte", rolleRes.error ?? partnerRes.error);
    return { error: partnerFehler("Laden fehlgeschlagen", 500) };
  }
  const roh = (rolleRes.data as { permissions?: unknown } | null)?.permissions;
  const rechte = new Set(Array.isArray(roh) ? roh.filter((p): p is string => typeof p === "string") : []);
  const darf = (recht: string) => rechte.has(recht);
  const partnerKonten = (partnerRes.data ?? []) as { id: string; partner_location_id: string | null }[];
  return {
    error: null,
    admin,
    userId: auth.effectiveUserId,
    userName: (profil.full_name as string | null) ?? null,
    standortId,
    teamIds: partnerKonten.filter((p) => p.partner_location_id === standortId).map((p) => p.id),
    fremdePartnerIds: partnerKonten.filter((p) => p.partner_location_id !== standortId).map((p) => p.id),
    darf,
    darfLesen: PARTNER_LESE_RECHTE.some(darf),
  };
}

/** Spalten fuer die Entscheidung «eigene Anfrage» (src/lib/partner-anfrage.ts). */
const KERN_SPALTEN = "id, location_id, is_deleted, status, accepted_at, rejected_at, created_by";

/** Eigene Anfrage laden (plus `spalten`) — fremde und nicht vorhandene
 *  Auftraege sind gleichermassen «nicht gefunden» (keine Existenz-Auskunft). */
export async function eigeneAnfrageLaden<T extends Record<string, unknown>>(
  ctx: PartnerPortalKontext,
  jobId: string,
  spalten = "",
): Promise<{ ok: true; job: T & AnfrageKern & { id: string } } | { ok: false; antwort: NextResponse }> {
  if (!isUuid(jobId)) return { ok: false, antwort: partnerFehler("Ungültige ID", 400) };
  const { data, error } = await ctx.admin
    .from("jobs")
    .select(spalten ? `${KERN_SPALTEN}, ${spalten}` : KERN_SPALTEN)
    .eq("id", jobId.toLowerCase())
    .maybeSingle();
  if (error) {
    logError("partner.portal.anfrage", error, { jobId });
    return { ok: false, antwort: partnerFehler("Laden fehlgeschlagen", 500) };
  }
  const job = data as unknown as (T & AnfrageKern & { id: string }) | null;
  if (!job || !istEigeneAnfrage(job, ctx)) {
    return { ok: false, antwort: partnerFehler("Anfrage nicht gefunden", 404) };
  }
  return { ok: true, job };
}

/** Anzeigenamen von EVENTLINE-Mitarbeitenden (Verantwortliche, Zugeteilte) —
 *  nur interne Konten, wie bisher portal_personen(). Wirft bei DB-Fehler. */
export async function interneNamen(admin: SupabaseClient, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const eindeutig = [...new Set(ids.filter((id): id is string => isUuid(id)))];
  const namen = new Map<string, string>();
  if (eindeutig.length === 0) return namen;
  const { data, error } = await admin.from("profiles").select("id, full_name, role").in("id", eindeutig);
  if (error) throw error;
  for (const p of (data ?? []) as { id: string; full_name: string | null; role: string | null }[]) {
    if (p.full_name && !istPortalRolle(p.role)) namen.set(p.id, p.full_name);
  }
  return namen;
}

export interface PartnerDokument {
  id: string;
  name: string;
  file_size: number | null;
  created_at: string;
}

/** Dokumente einer eigenen Anfrage, die der Partner sehen darf
 *  (dokumentFuerPartner: alles ausser Dokumenten anderer Portal-Konten).
 *  Mit storage_path — der bleibt auf dem Server. Wirft bei DB-Fehler. */
export async function anfrageDokumente(
  admin: SupabaseClient,
  jobId: string,
): Promise<(PartnerDokument & { storage_path: string })[]> {
  const { data, error } = await admin
    .from("documents")
    .select("id, name, file_size, created_at, storage_path, uploaded_by")
    .eq("job_id", jobId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const docs = (data ?? []) as (PartnerDokument & { storage_path: string; uploaded_by: string | null })[];
  const hochlader = [...new Set(docs.map((d) => d.uploaded_by).filter((id): id is string => isUuid(id)))];
  const portal = new Set<string>();
  if (hochlader.length > 0) {
    const { data: profile, error: prErr } = await admin.from("profiles").select("id, role").in("id", hochlader);
    if (prErr) throw prErr;
    for (const p of (profile ?? []) as { id: string; role: string | null }[]) if (istPortalRolle(p.role)) portal.add(p.id);
  }
  return docs
    .filter((d) => dokumentFuerPartner(d, jobId, portal))
    .map((d) => ({ id: d.id, name: d.name, file_size: d.file_size, created_at: d.created_at, storage_path: d.storage_path }));
}

/** Verwaiste Partner-Uploads einer Anfrage loeschen: Dateien im Anfrage-
 *  Ordner ohne documents-Zeile, aelter als 24 h (Upload ueber die signierte
 *  URL, aber «fertig» kam nie). Mit `alle` jede Datei ohne Zeile (nach dem
 *  Zurueckziehen). Wirft nie — Aufraeumen darf keinen Upload stoppen. */
export async function partnerOrdnerAufraeumen(
  admin: SupabaseClient,
  jobId: string,
  opts: { alle?: boolean } = {},
): Promise<void> {
  try {
    const ordner = partnerOrdner(jobId).replace(/\/$/, "");
    const { data: dateien, error } = await admin.storage.from("documents").list(ordner, { limit: 1000 });
    if (error) throw error;
    const grenze = Date.now() - 24 * 3_600_000;
    const kandidaten = ((dateien ?? []) as { id: string | null; name: string; created_at: string | null }[])
      .filter((f) => f.id && f.name && !f.name.includes("/") && !f.name.includes(".."))
      .filter((f) => opts.alle || (f.created_at != null && Date.parse(f.created_at) < grenze))
      .map((f) => `${ordner}/${f.name}`);
    if (kandidaten.length === 0) return;
    const belegt = new Set<string>();
    for (let i = 0; i < kandidaten.length; i += 50) {
      const { data: docs, error: dErr } = await admin
        .from("documents")
        .select("storage_path")
        .in("storage_path", kandidaten.slice(i, i + 50));
      if (dErr) throw dErr;
      for (const d of (docs ?? []) as { storage_path: string }[]) belegt.add(d.storage_path);
    }
    const weg = kandidaten.filter((p) => !belegt.has(p));
    if (weg.length === 0) return;
    const { error: rErr } = await admin.storage.from("documents").remove(weg);
    if (rErr) throw rErr;
  } catch (e) {
    logError("partner.portal.ordner_aufraeumen", e, { jobId });
  }
}

/** Meldung einer Partner-RPC (partner_update_title / partner_submit_anfrage /
 *  partner_withdraw_anfrage) → Klartext + Status. Rohe DB-Texte gehen nur ins
 *  Log; deutsch formulierte Fach-Meldungen der RPC werden durchgereicht. */
export function partnerRpcFehler(message: string | undefined, standard: string): { error: string; status: number } {
  const m = message ?? "";
  if (/job not found|Anfrage nicht gefunden/i.test(m)) return { error: "Anfrage nicht gefunden", status: 404 };
  if (/cannot withdraw confirmed job/i.test(m)) return { error: ZURUECKZIEHEN_BESTAETIGT, status: 409 };
  if (/cannot withdraw job in status/i.test(m)) {
    return { error: "Anfrage wurde bereits bearbeitet und kann nicht mehr zurückgezogen werden", status: 409 };
  }
  if (/can only submit from partner_entwurf/i.test(m)) {
    return { error: "Die Anfrage wurde bereits abgeschickt", status: 409 };
  }
  if (/mindestens ein Termin erforderlich/i.test(m)) {
    return { error: "Zum Absenden ist mindestens ein Termin nötig", status: 400 };
  }
  if (/forbidden|Keine Berechtigung/i.test(m)) return { error: "Kein Zugriff auf diese Anfrage", status: 403 };
  // Fach-Meldungen von partner_update_title (deutsch, fuer den Partner gedacht)
  if (/^(Titel fehlt|Titel ist zu lang|Die Anfrage ist bereits bestätigt|Der Titel kann in diesem Status)/.test(m)) {
    return { error: m, status: /bestätigt|Status/.test(m) ? 409 : 400 };
  }
  return { error: standard, status: 500 };
}
