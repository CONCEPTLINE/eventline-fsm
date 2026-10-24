/**
 * POST /api/auth/trust-one/link
 * Body: { pending: string }  (von POST /api/auth/trust-one, liegt im sessionStorage)
 *
 * Verbindet den Trust-one-User aus dem Ausweis EINMAL fest mit dem Profil des
 * EINGELOGGTEN Nutzers (aus der Session, nie aus dem Body). Danach meldet
 * Trust one diesen Nutzer direkt an.
 *
 *  - Nur aktive interne Konten (requireInternal: keine Portal-Rolle).
 *  - Nicht unter «Ansicht als»: verbunden wuerde sonst das echte Admin-Konto,
 *    angezeigt aber das simulierte.
 *  - pending_id ist 10 Min. gueltig und genau einmal einloesbar (linked_at
 *    wird atomar gesetzt).
 *  - Ein Trust-one-User -> genau ein Profil (bestehende Verbindung dieses
 *    Trust-one-Users wird ersetzt). Ein Profil -> genau ein Trust-one-User:
 *    ist das Profil schon mit einem ANDEREN Trust-one-Konto verbunden, wird
 *    nichts ueberschrieben (klare Meldung).
 */

import { NextResponse } from "next/server";
import { requireInternal } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";

const PENDING_FORMAT = /^[A-Za-z0-9_-]{20,100}$/;
const MSG_ABGELAUFEN =
  "Diese Verbindung ist abgelaufen oder wurde schon verwendet. Klicke in Trust one nochmals auf EVENTLINE ERP.";
const MSG_ANDERES_KONTO =
  "Dein EVENTLINE-Konto ist bereits mit einem anderen Trust-one-Konto verbunden. Wende dich an einen Admin.";
const MSG_FEHLER = "Verbinden hat nicht geklappt. Bitte nochmals versuchen.";

function antwort(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const auth = await requireInternal();
  if (auth.error) return auth.error;
  if (auth.isImpersonating) {
    return antwort(409, { success: false, error: "Bitte zuerst «Ansicht als» beenden." });
  }

  let pending: unknown;
  try {
    pending = ((await request.json()) as { pending?: unknown } | null)?.pending;
  } catch {
    return antwort(400, { success: false, error: MSG_ABGELAUFEN });
  }
  if (typeof pending !== "string" || !PENDING_FORMAT.test(pending)) {
    return antwort(400, { success: false, error: MSG_ABGELAUFEN });
  }

  const admin = createAdminClient();
  const jetzt = new Date().toISOString();

  // Atomar einloesen: nur EINE Anfrage kann linked_at setzen.
  const { data: zeile, error: claimErr } = await admin
    .from("trust_one_sso_tokens")
    .update({ linked_at: jetzt })
    .eq("pending_id", pending)
    .is("linked_at", null)
    .gt("pending_until", jetzt)
    .select("jti, trust_one_user_id, trust_one_name")
    .maybeSingle();
  if (claimErr) {
    logError("api.auth.trust-one.link.claim", claimErr);
    return antwort(500, { success: false, error: MSG_FEHLER });
  }
  if (!zeile) return antwort(410, { success: false, error: MSG_ABGELAUFEN });

  // Bei Fehler danach die Einloesung zuruecknehmen, damit der Nutzer es
  // (innerhalb der 10 Min.) nochmals versuchen kann.
  const zuruecknehmen = async () => {
    const { error } = await admin.from("trust_one_sso_tokens").update({ linked_at: null }).eq("jti", zeile.jti);
    if (error) logError("api.auth.trust-one.link.revert", error);
  };

  const profileId = auth.user.id;
  const { data: vorhanden, error: vorhErr } = await admin
    .from("trust_one_links")
    .select("trust_one_user_id")
    .eq("profile_id", profileId)
    .maybeSingle();
  if (vorhErr) {
    logError("api.auth.trust-one.link.lookup", vorhErr);
    await zuruecknehmen();
    return antwort(500, { success: false, error: MSG_FEHLER });
  }
  if (vorhanden && vorhanden.trust_one_user_id !== zeile.trust_one_user_id) {
    await zuruecknehmen();
    return antwort(409, { success: false, error: MSG_ANDERES_KONTO });
  }

  const { error: upErr } = await admin
    .from("trust_one_links")
    .upsert(
      { trust_one_user_id: zeile.trust_one_user_id, profile_id: profileId, trust_one_name: zeile.trust_one_name },
      { onConflict: "trust_one_user_id" },
    );
  if (upErr) {
    await zuruecknehmen();
    // 23505 auf profile_id: paralleles Verbinden mit einem anderen Trust-one-Konto.
    if (upErr.code === "23505") return antwort(409, { success: false, error: MSG_ANDERES_KONTO });
    logError("api.auth.trust-one.link.upsert", upErr);
    return antwort(500, { success: false, error: MSG_FEHLER });
  }

  console.info(JSON.stringify({ ctx: "api.auth.trust-one.link", ereignis: "Mit Trust one verbunden", profile_id: profileId }));

  return antwort(200, { success: true });
}
