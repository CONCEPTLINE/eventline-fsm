// /api/technik/wissen/fragen — «Offene Fragen der KI» im Tab «Wissen» (Migration 344). Nur Admins.
//   GET  → offene Fragen, je mit «betrifft n Dokumente» (Zaehlung in der DB), meiste Dokumente zuerst
//   GET  ?nur_anzahl=1 → nur die Zahl der offenen Fragen (Badge am Tab)
//   POST { aktion: "beantworten", id, kategorie, begriff, erklaerung, bezug_art?, bezug_id? }
//        → Antwort wird Wissens-Eintrag; offene, unentschiedene Vorschlaege der betroffenen Dateien werden neu berechnet
//          (ki_wissen_frage_beantworten — eine Transaktion; Entschiedenes nie)
//   POST { aktion: "verwerfen", id } → Frage verworfen (kommt nicht wieder)
// Fragen tragen nie sensible Werte (gefiltert beim Melden, lib/ki/wissen leseRueckfragen) und nie Dokumentinhalt.

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { ladeBezugNamen, leseWissenEingabe } from "@/lib/ki/wissen";

export const dynamic = "force-dynamic";

const KEIN_CACHE = { "Cache-Control": "no-store" };
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FRAGEN_MAX = 200;

const fehler = (text: string, status: number) => NextResponse.json({ success: false, error: text }, { status, headers: KEIN_CACHE });

interface FrageZeile {
  id: string;
  art: string;
  begriff: string | null;
  frage: string;
  zuletzt_gefragt: string;
  created_at: string;
  dokumente: { count: number }[] | null;
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const admin = createAdminClient();
  try {
    if (req.nextUrl.searchParams.get("nur_anzahl") === "1") {
      const { count, error } = await admin.from("ki_wissen_fragen").select("id", { count: "exact", head: true }).eq("status", "offen");
      if (error) throw new Error(error.message);
      return NextResponse.json({ success: true, anzahl: count ?? 0 }, { headers: KEIN_CACHE });
    }
    const { data, error } = await admin
      .from("ki_wissen_fragen")
      .select("id, art, begriff, frage, zuletzt_gefragt, created_at, dokumente:ki_wissen_fragen_dokumente(count)")
      .eq("status", "offen")
      .order("zuletzt_gefragt", { ascending: false })
      .limit(FRAGEN_MAX);
    if (error) throw new Error(error.message);
    const fragen = ((data ?? []) as unknown as FrageZeile[])
      .map((f) => ({
        id: f.id, art: f.art, begriff: f.begriff, frage: f.frage, zuletzt_gefragt: f.zuletzt_gefragt, created_at: f.created_at,
        dokumente: f.dokumente?.[0]?.count ?? 0,
      }))
      .sort((a, b) => b.dokumente - a.dokumente || Date.parse(b.zuletzt_gefragt) - Date.parse(a.zuletzt_gefragt));
    return NextResponse.json({ success: true, fragen }, { headers: KEIN_CACHE });
  } catch (e) {
    logError("technik.wissen.fragen.get", e);
    return fehler("Fragen der KI konnten nicht geladen werden", 500);
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!RE_UUID.test(id)) return fehler("Frage fehlt", 400);
  const admin = createAdminClient();

  if (body?.aktion === "verwerfen") {
    const { data, error } = await admin
      .from("ki_wissen_fragen")
      .update({ status: "verworfen", erledigt_von: auth.user.id, erledigt_am: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "offen")
      .select("id");
    if (error) {
      logError("technik.wissen.fragen.verwerfen", error);
      return fehler("Verwerfen fehlgeschlagen", 500);
    }
    if (!data?.length) return fehler("Diese Frage ist nicht mehr offen", 409);
    return NextResponse.json({ success: true }, { headers: KEIN_CACHE });
  }

  if (body?.aktion !== "beantworten") return fehler("Unbekannte Aktion", 400);
  const r = leseWissenEingabe({ ...body, aktiv: true });
  if (!r.ok) return fehler(r.fehler, 400);
  const w = r.wert;
  try {
    let bezugName: string | null = null;
    if (w.bezug_art && w.bezug_id) {
      bezugName = (await ladeBezugNamen(admin, [{ bezug_art: w.bezug_art, bezug_id: w.bezug_id }])).get(`${w.bezug_art}:${w.bezug_id}`) ?? null;
      if (!bezugName) return fehler("Bezug nicht gefunden — bitte neu wählen", 400);
    }
    const { data, error } = await admin.rpc("ki_wissen_frage_beantworten", {
      p_frage_id: id,
      p_kategorie: w.kategorie,
      p_begriff: w.begriff,
      p_erklaerung: w.erklaerung,
      p_bezug_art: w.bezug_art,
      p_bezug_id: w.bezug_id,
      p_bezug_name: bezugName,
      p_von: auth.user.id,
    });
    if (error) {
      if (/frage_nicht_offen|frage_unbekannt/.test(error.message)) return fehler("Diese Frage ist nicht mehr offen", 409);
      throw new Error(error.message);
    }
    const erg = (data ?? {}) as { wissen_id?: string; neu_berechnen?: number };
    return NextResponse.json({ success: true, wissen_id: erg.wissen_id ?? null, neu_berechnen: erg.neu_berechnen ?? 0 }, { headers: KEIN_CACHE });
  } catch (e) {
    logError("technik.wissen.fragen.beantworten", e);
    return fehler("Antwort konnte nicht gespeichert werden", 500);
  }
}
