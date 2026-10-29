// «Ausbezahlt» von Hand (Lohn-Umbau Phase 4, Tabelle lohn_auszahlungen).
//
// POST  { momentaufnahme_id, ausbezahlt_am: YYYY-MM-DD, notiz? }
//       Markiert die LETZTE gültige Fassung eines Monats als ausbezahlt.
//       Betrag = lohn_momentaufnahmen.auszahlung dieser Fassung (Korrektur:
//       die Differenz) — nie aus dem Browser. Je Fassung höchstens eine nicht
//       stornierte Auszahlung (DB-Index); Altbestand gilt bereits als ausbezahlt.
// PATCH { id, storno_grund }
//       Storno statt Löschen (Grund Pflicht, mind. 5 Zeichen) — die Zeile bleibt.
//
// Zugriff: Lohnrecht + vertrautes Gerät; nie für sich selbst (Vier Augen,
// wie Lohndokumente). Wartung «Lohn» sperrt (requirePermission).

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";
import { isUuid } from "@/lib/search-escape";
import { todayLocalIso } from "@/lib/swiss-time";
import { logError } from "@/lib/log";

const STORNO_MIN = 5;
const EIGENE = "Die eigene Auszahlung markiert der andere Admin (Vier-Augen-Prinzip).";
const antwort = (error: string, status: number) => NextResponse.json({ success: false, error }, { status });

function gueltigesDatum(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

async function meinName(admin: ReturnType<typeof createAdminClient>, id: string): Promise<string | null> {
  const { data } = await admin.from("profiles").select("full_name").eq("id", id).maybeSingle();
  return (data?.full_name as string | null) ?? null;
}

export async function POST(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const body = (await req.json().catch(() => null)) as { momentaufnahme_id?: unknown; ausbezahlt_am?: unknown; notiz?: unknown } | null;
  const id = typeof body?.momentaufnahme_id === "string" ? body.momentaufnahme_id : "";
  if (!isUuid(id)) return antwort("momentaufnahme_id fehlt", 400);
  if (!gueltigesDatum(body?.ausbezahlt_am)) return antwort("Datum ungültig (YYYY-MM-DD)", 400);
  const am = body!.ausbezahlt_am as string;
  if (am > todayLocalIso()) return antwort("«Ausbezahlt» geht nur für heute oder früher.", 400);
  const notiz = typeof body?.notiz === "string" ? body.notiz.trim().slice(0, 300) || null : null;

  const admin = createAdminClient();
  const { data: f, error } = await admin
    .from("lohn_momentaufnahmen")
    .select("id, profile_id, jahr, monat, fassung, art, auszahlung")
    .eq("id", id)
    .maybeSingle();
  if (error) return antwort(error.message, 500);
  if (!f) return antwort("Fassung nicht gefunden", 404);
  if (f.profile_id === auth.user.id) return antwort(EIGENE, 403);
  if (f.art === "altbestand") return antwort("Altbestand gilt bereits als ausbezahlt.", 400);
  // Nur die gültige (letzte) Fassung des Monats — sonst wäre eine ersetzte Fassung «ausbezahlt».
  const { data: g, error: gErr } = await admin
    .from("lohn_fassungen_gueltig")
    .select("id")
    .eq("profile_id", f.profile_id)
    .eq("jahr", f.jahr)
    .eq("monat", f.monat)
    .maybeSingle();
  if (gErr) return antwort(gErr.message, 500);
  if (g?.id !== f.id) return antwort("Das ist nicht die gültige Fassung dieses Monats — Seite neu laden.", 409);
  const erster = `${f.jahr}-${String(f.monat).padStart(2, "0")}-01`;
  if (am < erster) return antwort("Datum liegt vor dem Lohnmonat.", 400);

  const { data: neu, error: iErr } = await admin
    .from("lohn_auszahlungen")
    .insert({
      momentaufnahme_id: f.id,
      profile_id: f.profile_id,
      jahr: f.jahr,
      monat: f.monat,
      fassung: f.fassung,
      ausbezahlt_am: am,
      betrag: f.auszahlung,
      notiz,
      erfasst_von: auth.user.id,
      erfasst_von_name: await meinName(admin, auth.user.id),
    })
    .select("id, ausbezahlt_am, betrag")
    .single();
  if (iErr) {
    if (iErr.code === "23505") return antwort("Diese Fassung ist schon als ausbezahlt markiert.", 409);
    logError("lohn.auszahlungen.post", iErr, { momentaufnahmeId: id });
    return antwort(iErr.message, 500);
  }
  return NextResponse.json({ success: true, auszahlung: neu });
}

export async function PATCH(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const body = (await req.json().catch(() => null)) as { id?: unknown; storno_grund?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!isUuid(id)) return antwort("id fehlt", 400);
  const grund = typeof body?.storno_grund === "string" ? body.storno_grund.trim().slice(0, 500) : "";
  if (grund.length < STORNO_MIN) return antwort(`Grund für das Storno: mindestens ${STORNO_MIN} Zeichen`, 400);

  const admin = createAdminClient();
  const { data: a, error } = await admin.from("lohn_auszahlungen").select("id, profile_id, storniert_at").eq("id", id).maybeSingle();
  if (error) return antwort(error.message, 500);
  if (!a) return antwort("Nicht gefunden", 404);
  if (a.profile_id === auth.user.id) return antwort(EIGENE, 403);
  if (a.storniert_at) return antwort("Schon storniert.", 409);
  const { data: geaendert, error: uErr } = await admin
    .from("lohn_auszahlungen")
    .update({ storniert_at: new Date().toISOString(), storniert_von: auth.user.id, storniert_von_name: await meinName(admin, auth.user.id), storno_grund: grund })
    .eq("id", id)
    .is("storniert_at", null)
    .select("id");
  if (uErr) {
    logError("lohn.auszahlungen.storno", uErr, { id });
    return antwort(uErr.message, 500);
  }
  if (!geaendert || geaendert.length === 0) return antwort("Schon storniert.", 409);
  return NextResponse.json({ success: true });
}
