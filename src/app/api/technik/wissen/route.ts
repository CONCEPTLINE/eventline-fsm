// /api/technik/wissen — Tab «Wissen» auf der Seite /technik (Migration 344). Nur Admins (requireAdmin wie alle
// Technik-Routen), Daten nur ueber den Admin-Client.
//   GET  ?q=&kategorie=&status=aktiv|inaktiv|alle → Eintraege (Suche/Filter in der DB) mit Bezug und «geaendert von»
//   GET  ?optionen=1 → Auswahl fuer den Bezug: Locations, Kunden, Lieferanten, Personen (Stammdaten)
//   POST   { kategorie, begriff, erklaerung, bezug_art?, bezug_id?, aktiv? } → neuer Eintrag
//   PATCH  { id, … wie POST } → Eintrag aendern
//   DELETE ?id= → Eintrag loeschen
// Das Wissen geht an die lokale KI (Nacht-Kontext) und an Claude (Ordner-/Namenswahl) — darum prueft
// leseWissenEingabe (lib/ki/wissen) auf E-Mail, Konto-, AHV-, Telefonnummern, Betraege und Gesundheitsangaben.

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { escapeForIlike } from "@/lib/search-escape";
import { logError } from "@/lib/log";
import {
  BEZUG_ART_TEXT,
  BEZUG_NAME_MAX,
  istKategorie,
  ladeBezugNamen,
  leseWissenEingabe,
  type BezugArt,
  type WissenEingabe,
} from "@/lib/ki/wissen";

export const dynamic = "force-dynamic";

const KEIN_CACHE = { "Cache-Control": "no-store" };
const LISTE_MAX = 500;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Admin = ReturnType<typeof createAdminClient>;

interface Zeile {
  id: string;
  kategorie: string;
  begriff: string;
  erklaerung: string;
  bezug_art: BezugArt | null;
  bezug_id: string | null;
  bezug_name: string | null;
  aktiv: boolean;
  erstellt_am: string;
  geaendert_am: string;
  geaendert_von: string | null;
}

const fehler = (text: string, status: number) => NextResponse.json({ success: false, error: text }, { status, headers: KEIN_CACHE });

/** Name des gewaehlten Stammdatums (Schnappschuss fuer Liste und KI) — null, wenn es den Datensatz nicht gibt. */
async function bezugName(admin: Admin, art: BezugArt, id: string): Promise<string | null> {
  const namen = await ladeBezugNamen(admin, [{ bezug_art: art, bezug_id: id }]);
  return namen.get(`${art}:${id}`) ?? null;
}

async function optionen(admin: Admin) {
  const [loc, kunden, lief, pers] = await Promise.all([
    admin.from("locations").select("id, name").is("archived_at", null).order("name").limit(1000),
    admin.from("customers").select("id, name").is("archived_at", null).order("name").limit(2000),
    admin.from("lieferanten").select("id, name").eq("is_active", true).order("name").limit(1000),
    admin.from("profiles").select("id, full_name, is_active").order("full_name").limit(2000),
  ]);
  for (const r of [loc, kunden, lief, pers]) if (r.error) throw new Error(r.error.message);
  const item = (art: BezugArt, id: string, label: string, zusatz?: string) => ({
    id: `${art}:${id}`, label: label.trim().slice(0, BEZUG_NAME_MAX), sub: zusatz ? `${BEZUG_ART_TEXT[art]} · ${zusatz}` : BEZUG_ART_TEXT[art],
  });
  return [
    ...((loc.data ?? []) as { id: string; name: string }[]).filter((x) => x.name?.trim()).map((x) => item("location", x.id, x.name)),
    ...((kunden.data ?? []) as { id: string; name: string }[]).filter((x) => x.name?.trim()).map((x) => item("kunde", x.id, x.name)),
    ...((lief.data ?? []) as { id: string; name: string }[]).filter((x) => x.name?.trim()).map((x) => item("lieferant", x.id, x.name)),
    ...((pers.data ?? []) as { id: string; full_name: string | null; is_active: boolean }[])
      .filter((x) => x.full_name?.trim())
      .map((x) => item("person", x.id, x.full_name as string, x.is_active ? undefined : "inaktiv")),
  ];
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const admin = createAdminClient();
  const p = req.nextUrl.searchParams;
  try {
    if (p.get("optionen") === "1") {
      return NextResponse.json({ success: true, optionen: await optionen(admin) }, { headers: KEIN_CACHE });
    }
    const q = (p.get("q") ?? "").trim().slice(0, 100);
    const kategorie = p.get("kategorie");
    const status = p.get("status") ?? "aktiv";
    let abfrage = admin
      .from("ki_wissen")
      .select("id, kategorie, begriff, erklaerung, bezug_art, bezug_id, bezug_name, aktiv, erstellt_am, geaendert_am, geaendert_von", { count: "exact" });
    if (kategorie && istKategorie(kategorie)) abfrage = abfrage.eq("kategorie", kategorie);
    if (status === "aktiv") abfrage = abfrage.eq("aktiv", true);
    else if (status === "inaktiv") abfrage = abfrage.eq("aktiv", false);
    if (q) {
      const like = `%${escapeForIlike(q)}%`;
      abfrage = abfrage.or(["begriff", "erklaerung", "bezug_name"].map((s) => `${s}.ilike.${like}`).join(","));
    }
    const { data, error, count } = await abfrage.order("kategorie").order("begriff").limit(LISTE_MAX);
    if (error) throw new Error(error.message);
    const zeilen = (data ?? []) as Zeile[];
    const namen = await ladeBezugNamen(admin, zeilen);
    const leute = [...new Set(zeilen.map((z) => z.geaendert_von).filter((x): x is string => !!x))];
    const wer = new Map<string, string>();
    if (leute.length) {
      const { data: profile, error: pErr } = await admin.from("profiles").select("id, full_name").in("id", leute);
      if (pErr) throw new Error(pErr.message);
      for (const x of (profile ?? []) as { id: string; full_name: string | null }[]) if (x.full_name) wer.set(x.id, x.full_name);
    }
    const { count: alle, error: aErr } = await admin.from("ki_wissen").select("id", { count: "exact", head: true });
    if (aErr) throw new Error(aErr.message);
    const eintraege = zeilen.map((z) => ({
      ...z,
      bezug_name: (z.bezug_art && z.bezug_id ? namen.get(`${z.bezug_art}:${z.bezug_id}`) : null) ?? z.bezug_name,
      geaendert_von_name: z.geaendert_von ? wer.get(z.geaendert_von) ?? null : null,
    }));
    return NextResponse.json({ success: true, eintraege, anzahl: count ?? eintraege.length, gesamt: alle ?? 0 }, { headers: KEIN_CACHE });
  } catch (e) {
    logError("technik.wissen.get", e);
    return fehler("Wissen konnte nicht geladen werden", 500);
  }
}

async function speichern(req: NextRequest, neu: boolean) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const id = typeof body?.id === "string" ? body.id : null;
  if (!neu && (!id || !RE_UUID.test(id))) return fehler("Eintrag fehlt", 400);
  const r = leseWissenEingabe(body);
  if (!r.ok) return fehler(r.fehler, 400);
  const w: WissenEingabe = r.wert;
  const admin = createAdminClient();
  try {
    let bezug_name: string | null = null;
    if (w.bezug_art && w.bezug_id) {
      bezug_name = await bezugName(admin, w.bezug_art, w.bezug_id);
      if (!bezug_name) return fehler("Bezug nicht gefunden — bitte neu wählen", 400);
    }
    const jetzt = new Date().toISOString();
    const felder = { ...w, bezug_name, geaendert_von: auth.user.id, geaendert_am: jetzt };
    const abfrage = neu
      ? admin.from("ki_wissen").insert({ ...felder, erstellt_von: auth.user.id, erstellt_am: jetzt })
      : admin.from("ki_wissen").update(felder).eq("id", id!);
    const { data, error } = await abfrage.select("id");
    if (error) {
      if (error.code === "23505") return fehler("Diesen Begriff gibt es in dieser Kategorie schon", 409);
      throw new Error(error.message);
    }
    if (!data?.length) return fehler("Eintrag nicht gefunden", 404);
    return NextResponse.json({ success: true, id: (data[0] as { id: string }).id }, { headers: KEIN_CACHE });
  } catch (e) {
    logError("technik.wissen.speichern", e);
    return fehler("Speichern fehlgeschlagen", 500);
  }
}

export const POST = (req: NextRequest) => speichern(req, true);
export const PATCH = (req: NextRequest) => speichern(req, false);

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!RE_UUID.test(id)) return fehler("Eintrag fehlt", 400);
  const { count, error } = await createAdminClient().from("ki_wissen").delete({ count: "exact" }).eq("id", id);
  if (error) {
    logError("technik.wissen.loeschen", error);
    return fehler("Löschen fehlgeschlagen", 500);
  }
  if (!count) return fehler("Eintrag nicht gefunden", 404);
  return NextResponse.json({ success: true }, { headers: KEIN_CACHE });
}
