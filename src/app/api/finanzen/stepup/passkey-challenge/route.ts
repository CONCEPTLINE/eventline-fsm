// POST /api/finanzen/stepup/passkey-challenge
//
// Startet die Passkey-Bestaetigung fuer /finanzen (Step-up). Der User ist
// bereits angemeldet, Admin und auf einem vertrauten Geraet — deshalb
// duerfen wir allowCredentials mit SEINEN Passkeys ausgeben (kein
// Enumerationsrisiko wie beim Login) und die Challenge MIT user_id
// speichern; passkey-verify prueft beides gegen auth.user.id.
//
// Bewusste Abweichung vom Login (auth-challenge:41 `preferred`):
// userVerification "required" — Step-up ist ein zweiter Faktor auf einer
// bereits angemeldeten Sitzung. Authenticatoren ohne UV nehmen den
// Passwortpfad.

import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { passkeyRpId } from "@/lib/passkey";
import { finanzenJson, requireFinanzenStart } from "@/lib/finanzen/auth";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function POST() {
  const auth = await requireFinanzenStart();
  if (auth.error) return auth.error;

  const admin = createAdminClient();
  const { data: passkeys } = await admin
    .from("user_passkeys")
    .select("credential_id, transports")
    .eq("user_id", auth.user.id);

  const options = await generateAuthenticationOptions({
    rpID: passkeyRpId(),
    userVerification: "required",
    // Leere Liste erlaubt → Browser zeigt alle Passkeys der Domain.
    allowCredentials: (passkeys ?? []).map((p) => ({
      id: p.credential_id as string,
      transports: (p.transports ?? undefined) as string[] | undefined,
    })),
  });

  await admin.rpc("cleanup_expired_passkey_challenges");

  const { error: chalErr } = await admin
    .from("user_passkey_challenges")
    .insert({ challenge: options.challenge, kind: "auth", user_id: auth.user.id });
  if (chalErr) {
    logError("finanzen.stepup.challenge", new Error(`insert fehlgeschlagen (${chalErr.code ?? "?"})`));
    return finanzenJson({ success: false, error: "Konnte Challenge nicht speichern" }, { status: 500 });
  }

  return finanzenJson({ success: true, options });
}
