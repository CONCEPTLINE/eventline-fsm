// GET /api/einstellungen/zugriffe?tage=30&bereich=finanzen|lohn
//
// Karte «Zugriffe auf Finanzen & Lohn» (Einstellungen › Sicherheit, Admin).
// Liefert die letzten 200 Eintraege aus finanzen.zugriffe im Zeitfenster
// (Default 30 Tage, max. 90) — OHNE geraet_hash und OHNE Profil-IDs
// (Datenminimierung: ein Geraete-Tabellen-Bezeichner hat im Browser nichts
// zu suchen; die Karte zeigt nur Labels). Das Protokoll enthaelt keine
// Betraege, deshalb hier kein eigener Protokolleintrag.

import { requireAdmin } from "@/lib/api-auth";
import { finanzenDb } from "@/lib/finanzen/db";
import { finanzenJson } from "@/lib/finanzen/auth";
import { logError } from "@/lib/log";
import type { ZugriffAnzeigeRow, ZugriffBereich, ZugriffeAntwort } from "@/lib/finanzen/types";

export const dynamic = "force-dynamic";

const TAGE_DEFAULT = 30;
const TAGE_MAX = 90;

export async function GET(request: Request) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const tageRoh = Number(url.searchParams.get("tage"));
  const tage = Math.min(TAGE_MAX, Math.max(1, Number.isFinite(tageRoh) && tageRoh > 0 ? Math.floor(tageRoh) : TAGE_DEFAULT));
  const bereichRoh = url.searchParams.get("bereich");
  const bereich: ZugriffBereich | null = bereichRoh === "finanzen" || bereichRoh === "lohn" ? bereichRoh : null;
  const seit = new Date(Date.now() - tage * 86_400_000).toISOString();

  let query = finanzenDb()
    .from("zugriffe")
    .select("id, occurred_at, actor_label, bereich, aktion, ziel_label, details")
    .gte("occurred_at", seit);
  if (bereich) query = query.eq("bereich", bereich);
  const { data, error } = await query.order("occurred_at", { ascending: false }).limit(200);

  if (error) {
    logError("einstellungen.zugriffe", new Error(`select fehlgeschlagen (${error.code ?? "?"})`));
    return finanzenJson({ success: false, error: "Zugriffe konnten nicht geladen werden" }, { status: 500 });
  }

  const antwort: ZugriffeAntwort = {
    success: true,
    eintraege: (data ?? []) as ZugriffAnzeigeRow[],
    tage,
  };
  return finanzenJson(antwort);
}
