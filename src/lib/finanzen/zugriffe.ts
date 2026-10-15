// Lese-Protokoll Finanzen + Lohn (finanzen.zugriffe, Spec B.3 / Entscheid 5).
//
//   protokolliereZugriff(e)       → true = Zeile geschrieben, false = Fehler
//                                    (geloggt). WIRFT NIE.
//   geraetHashAusCookies()        → hashToken(trusted-device-Cookie) | null
//   zaehleFreigabeFehlversuche()  → Fehlversuche des Akteurs in den letzten
//                                    STEPUP_SPERRE_MS; bei DB-Fehler fail-closed
//                                    (= STEPUP_MAX_FEHLVERSUCHE → 429).
//
// Verwendung:
//   Finanz-Routen (fail-closed):  if (!(await protokolliereZugriff(...))) return protokollFehler();
//   Lohn-Routen   (fail-open):    await protokolliereZugriff(...);   // Rueckgabe ignorieren
//
// Akteur ist IMMER auth.user.id (der echte User), nie effectiveUserId.
// details NIE mit Betraegen, Namen, Rechnungs-/Dokumentnummern.

import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashToken, TRUSTED_DEVICE_COOKIE } from "@/lib/api-auth";
import { finanzenDb } from "@/lib/finanzen/db";
import { logError } from "@/lib/log";
import {
  STEPUP_MAX_FEHLVERSUCHE,
  STEPUP_SPERRE_MS,
  ZUGRIFF_AKTION,
  type ZugriffEintrag,
} from "@/lib/finanzen/types";

/** true = Zeile geschrieben; false = Fehler (geloggt). Wirft NIE. */
export async function protokolliereZugriff(e: ZugriffEintrag): Promise<boolean> {
  try {
    // Labels denormalisieren (Muster permission-audit.ts), damit das
    // Protokoll auch nach User-Loeschung lesbar bleibt.
    const ids: string[] = [e.actorProfileId];
    if (e.zielProfileId && e.zielProfileId !== e.actorProfileId) ids.push(e.zielProfileId);
    const { data: profiles } = await createAdminClient()
      .from("profiles")
      .select("id, full_name")
      .in("id", ids);
    const labelById = new Map((profiles ?? []).map((p) => [p.id as string, (p.full_name as string | null) ?? null]));

    const { error } = await finanzenDb().from("zugriffe").insert({
      actor_profile_id: e.actorProfileId,
      actor_label: labelById.get(e.actorProfileId) ?? null,
      bereich: e.bereich,
      aktion: e.aktion,
      ziel_profile_id: e.zielProfileId ?? null,
      ziel_label: e.zielProfileId ? (labelById.get(e.zielProfileId) ?? null) : null,
      geraet_hash: e.geraetHash ?? null,
      details: e.details ?? {},
    });
    if (error) {
      // Nur der Code — Postgres legt bei Constraint-Fehlern die ganze Zeile
      // in DETAIL, das darf nie in ein Log.
      logError("finanzen.zugriffe", new Error(`insert fehlgeschlagen (${error.code ?? "?"})`), { aktion: e.aktion, bereich: e.bereich });
      return false;
    }
    return true;
  } catch (err) {
    logError("finanzen.zugriffe", err, { aktion: e.aktion, bereich: e.bereich });
    return false;
  }
}

/** sha256-Hex des trusted-device-Cookies — null ohne Cookie (oder wenn
 *  cookies() ausserhalb eines Requests nicht verfuegbar ist). */
export async function geraetHashAusCookies(): Promise<string | null> {
  try {
    const store = await cookies();
    const c = store.get(TRUSTED_DEVICE_COOKIE)?.value;
    return c ? hashToken(c) : null;
  } catch {
    return null;
  }
}

/** Fehlversuche (finanzen.freigabe_fehlgeschlagen) des Akteurs seit
 *  now − STEPUP_SPERRE_MS. Bei DB-Fehler → STEPUP_MAX_FEHLVERSUCHE
 *  (fail-closed: ohne Zaehlung keine Freischaltung). */
export async function zaehleFreigabeFehlversuche(actorProfileId: string): Promise<number> {
  try {
    const seit = new Date(Date.now() - STEPUP_SPERRE_MS).toISOString();
    const { count, error } = await finanzenDb()
      .from("zugriffe")
      .select("id", { count: "exact", head: true })
      .eq("actor_profile_id", actorProfileId)
      .eq("aktion", ZUGRIFF_AKTION.FINANZEN_FREIGABE_FEHLGESCHLAGEN)
      .gte("occurred_at", seit);
    if (error) {
      logError("finanzen.zugriffe.fehlversuche", new Error(`count fehlgeschlagen (${error.code ?? "?"})`));
      return STEPUP_MAX_FEHLVERSUCHE;
    }
    return count ?? 0;
  } catch (err) {
    logError("finanzen.zugriffe.fehlversuche", err);
    return STEPUP_MAX_FEHLVERSUCHE;
  }
}
