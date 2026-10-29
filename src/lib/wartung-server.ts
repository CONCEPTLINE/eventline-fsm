import "server-only";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { logError } from "@/lib/log";
import {
  KEINE_WARTUNG,
  WARTUNG_BEREICHE,
  WARTUNG_FEHLER_CODE,
  WARTUNG_MELDUNG,
  erstelleWartungsCache,
  normalisiereWartung,
  wartungZugaenge,
  wartungZugang,
  type WartungAnfrage,
  type WartungBereich,
  type WartungStand,
  type WartungZugang,
} from "@/lib/wartung";

// Wartungsmodus, Server-Teil: Stand aus public.wartung (Migration 363),
// 10 s gecacht je Instanz (Regeln und Fehlerverhalten: src/lib/wartung.ts).

const CACHE_MS = 10_000;

async function ladeAusDb(): Promise<WartungStand> {
  const { data, error } = await createAdminClient()
    .from("wartung")
    .select("bereiche, grund, seit, ausnahmen")
    .eq("id", "default")
    .maybeSingle();
  if (error) throw new Error(`Wartung konnte nicht geladen werden: ${error.message}`);
  return data ? normalisiereWartung(data) : KEINE_WARTUNG;
}

const cache = erstelleWartungsCache(ladeAusDb, {
  ttlMs: CACHE_MS,
  beiFehler: (e) => logError("wartung.laden", e),
});

/** Aktueller Stand (gecacht). `frisch` liest an der DB vorbei (Cron, Schalter). */
export function ladeWartung(opts?: { frisch?: boolean }): Promise<WartungStand> {
  return cache.lesen(opts);
}

/** Ungecacht und streng: wirft, wenn der Stand nicht lesbar ist. Für den
 *  Cron des Lohnlaufs — der läuft im Zweifel NICHT. */
export function ladeWartungStreng(): Promise<WartungStand> {
  return ladeAusDb();
}

/** Nach dem Schalten in der App: diese Instanz liest beim nächsten Mal neu. */
export function wartungCacheLeeren(): void {
  cache.leeren();
}

/** 503 mit der Wartungsmeldung — die App zeigt `error` als Toast. */
export function wartungAntwort(bereich: WartungBereich): NextResponse {
  return NextResponse.json(
    { success: false, error: WARTUNG_MELDUNG, message: WARTUNG_MELDUNG, code: WARTUNG_FEHLER_CODE, bereich },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

/** null = darf; sonst die 503-Antwort. `profileId` = das ECHTE Konto
 *  (Ausnahmen gelten auch in «Ansicht als»). */
export async function wartungSperre(bereich: WartungBereich, profileId: string | null): Promise<NextResponse | null> {
  const stand = await ladeWartung();
  return wartungZugang(stand, bereich, profileId) === "gesperrt" ? wartungAntwort(bereich) : null;
}

const ALLES_FREI = Object.fromEntries(WARTUNG_BEREICHE.map((b) => [b, "frei"])) as Record<WartungBereich, WartungZugang>;

/** Für Seiten-Layouts (Server Components): Zugang je Bereich für die
 *  angemeldete Person. Ohne Wartung kein Auth-Aufruf. */
export async function wartungFuerAnfrage(): Promise<WartungAnfrage> {
  const stand = await ladeWartung();
  if (stand.bereiche.length === 0) return { zugang: ALLES_FREI, grund: null, seit: null };
  let profileId: string | null = null;
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    profileId = data.user?.id ?? null;
  } catch (e) {
    logError("wartung.nutzer", e);
  }
  return { zugang: wartungZugaenge(stand, profileId), grund: stand.grund, seit: stand.seit };
}
