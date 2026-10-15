// POST /api/finanzen/stepup/passkey-verify
// Body: { response: AuthenticationResponseJSON }
//
// Verifiziert die Passkey-Antwort fuer das Step-up (Kern kopiert aus
// /api/auth/passkey/auth-verify Z.74-174 — bewusst nicht refactort; der
// Session-Teil ab Z.176 entfaellt, die Sitzung besteht ja schon).
//
// Zusaetzlich zum Login:
//   • Riegel ZUERST: ≥ STEPUP_MAX_FEHLVERSUCHE Eintraege
//     finanzen.freigabe_fehlgeschlagen in STEPUP_SPERRE_MS → 429 (der 429
//     selbst wird NICHT protokolliert, sonst verlaengert jeder Klick die Sperre).
//     Gegen parallele Anfragen: je Akteur nur ein Versuch gleichzeitig
//     (freigabeStarten) + erneutes Zaehlen nach dem Fehlversuch-Insert.
//   • credRow muss zu auth.user.id gehoeren (Lookup .eq("user_id")) —
//     fremder Passkey → Fehlversuch + 401.
//   • Challenge-Lookup mit kind='auth' UND user_id = auth.user.id.
//   • requireUserVerification: true (Login hat false).
//   • Erfolg: Protokoll finanzen.freigabe FAIL-CLOSED (ohne Zeile kein
//     Cookie), dann Ticket-Cookie setzen.

import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { passkeyOrigin, passkeyRpId } from "@/lib/passkey";
import { finanzenFehler, finanzenJson, protokollFehler, requireFinanzenStart } from "@/lib/finanzen/auth";
import { erstelleStepUpTicket, freigabeBeenden, freigabeStarten, stepUpCookieSetzen } from "@/lib/finanzen/stepup";
import { protokolliereZugriff, zaehleFreigabeFehlversuche } from "@/lib/finanzen/zugriffe";
import {
  FINANZEN_FEHLER,
  STEPUP_MAX_FEHLVERSUCHE,
  ZUGRIFF_AKTION,
  type StepUpBestaetigtAntwort,
} from "@/lib/finanzen/types";

export const dynamic = "force-dynamic";

interface Body {
  response?: AuthenticationResponseJSON;
}

export async function POST(request: Request) {
  const auth = await requireFinanzenStart();
  if (auth.error) return auth.error;
  const { user, geraetHash } = auth;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return finanzenJson({ success: false, error: "Ungültiger Body" }, { status: 400 });
  }
  const response = body.response;
  if (!response || !response.id) {
    return finanzenJson({ success: false, error: "response fehlt" }, { status: 400 });
  }

  // Riegel zuerst.
  if ((await zaehleFreigabeFehlversuche(user.id)) >= STEPUP_MAX_FEHLVERSUCHE) {
    return finanzenFehler(FINANZEN_FEHLER.STEPUP_GESPERRT, 429, "Zu viele Fehlversuche — bitte 15 Minuten warten.");
  }
  // Je Akteur nur ein Versuch gleichzeitig (Zaehlen-dann-Pruefen-Luecke).
  if (!freigabeStarten(user.id)) {
    return finanzenFehler(FINANZEN_FEHLER.STEPUP_GESPERRT, 429, "Eine Bestätigung läuft bereits.");
  }
  try {
    return await verifizieren(response, user.id, geraetHash);
  } finally {
    freigabeBeenden(user.id);
  }
}

async function verifizieren(response: AuthenticationResponseJSON, userId: string, geraetHash: string) {
  const user = { id: userId };
  const fehlversuch = async (message: string) => {
    await protokolliereZugriff({
      actorProfileId: user.id,
      bereich: "finanzen",
      aktion: ZUGRIFF_AKTION.FINANZEN_FREIGABE_FEHLGESCHLAGEN,
      geraetHash,
      details: { methode: "passkey" },
    });
    // Nach dem Insert erneut zaehlen: der 5. Fehlversuch sperrt sofort.
    if ((await zaehleFreigabeFehlversuche(user.id)) >= STEPUP_MAX_FEHLVERSUCHE) {
      return finanzenFehler(FINANZEN_FEHLER.STEPUP_GESPERRT, 429, "Zu viele Fehlversuche — bitte 15 Minuten warten.");
    }
    return finanzenJson({ success: false, error: message }, { status: 401 });
  };

  const admin = createAdminClient();

  // 1) Credential laden — MUSS dem eingeloggten User gehoeren.
  const { data: credRow } = await admin
    .from("user_passkeys")
    .select("id, user_id, public_key, counter, transports")
    .eq("credential_id", response.id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!credRow || credRow.user_id !== user.id) {
    return fehlversuch("Passkey gehört nicht zu diesem Konto.");
  }

  // 2) Exakte Challenge aus clientDataJSON (ein Verify, kein Durchprobieren).
  let expectedChallenge: string;
  try {
    const clientDataJson = Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8");
    const clientData = JSON.parse(clientDataJson) as { challenge?: unknown };
    if (typeof clientData.challenge !== "string" || clientData.challenge.length === 0) {
      throw new Error("challenge fehlt");
    }
    expectedChallenge = clientData.challenge;
  } catch {
    return finanzenJson({ success: false, error: "Ungültige clientDataJSON." }, { status: 400 });
  }

  const { data: chalRow } = await admin
    .from("user_passkey_challenges")
    .select("id, challenge, expires_at")
    .eq("kind", "auth")
    .eq("challenge", expectedChallenge)
    .eq("user_id", user.id)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (!chalRow) {
    return fehlversuch("Keine gültige Challenge — bitte erneut bestätigen.");
  }

  let verified = false;
  let matchedChallenge: { id: string; challenge: string } | null = null;
  let newCounter = 0;

  try {
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: chalRow.challenge,
      expectedOrigin: passkeyOrigin(),
      expectedRPID: passkeyRpId(),
      credential: {
        id: response.id,
        publicKey: new Uint8Array(Buffer.from(credRow.public_key, "base64url")),
        counter: Number(credRow.counter ?? 0),
        transports: (credRow.transports ?? undefined) as
          | ("internal" | "hybrid" | "usb" | "nfc" | "ble")[]
          | undefined,
      },
      requireUserVerification: true,
    });
    if (v.verified) {
      verified = true;
      matchedChallenge = { id: chalRow.id as string, challenge: chalRow.challenge as string };
      newCounter = v.authenticationInfo.newCounter;
    }
  } catch {
    // verify wirft → schlicht als Fehlversuch behandeln
  }

  if (!verified || !matchedChallenge) {
    return fehlversuch("Passkey-Verifikation fehlgeschlagen.");
  }

  // 3) Counter + last_used_at hochschreiben, Challenge verbrauchen.
  await admin
    .from("user_passkeys")
    .update({ counter: newCounter, last_used_at: new Date().toISOString() })
    .eq("id", credRow.id);
  await admin.from("user_passkey_challenges").delete().eq("id", matchedChallenge.id);

  // 4) Ticket + Protokoll (fail-closed: ohne Protokoll kein Cookie) + Cookie.
  const { ticket, exp } = erstelleStepUpTicket(user.id, geraetHash);
  const protokolliert = await protokolliereZugriff({
    actorProfileId: user.id,
    bereich: "finanzen",
    aktion: ZUGRIFF_AKTION.FINANZEN_FREIGABE,
    geraetHash,
    details: { methode: "passkey" },
  });
  if (!protokolliert) return protokollFehler();

  const antwort: StepUpBestaetigtAntwort = { success: true, bisUnix: exp };
  const res = finanzenJson(antwort);
  stepUpCookieSetzen(res, ticket);
  return res;
}
