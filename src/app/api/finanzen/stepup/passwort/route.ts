// POST /api/finanzen/stepup/passwort
// Body: { passwort: string }  (1–STEPUP_PASSWORT_MAX Zeichen, sonst 400)
//
// Passwort-Fallback des Step-ups. Das Passwort wird serverseitig mit einem
// WEGWERF-Client (Anon-Key, persistSession:false) gegen GoTrue geprueft —
// die entstehende Wegwerf-Sitzung wird sofort mit
// admin.auth.admin.signOut(access_token, "local") revoziert.
// NIE scope "global": das wuerde den Admin in allen Browsern ausloggen.
// Tokens werden nie gespeichert, keine Cookies ausser dem Step-up-Ticket.
//
//   • Riegel: ≥ STEPUP_MAX_FEHLVERSUCHE Fehlversuche in STEPUP_SPERRE_MS → 429.
//     (GoTrue hat kein Account-Lockout; sein IP-Limit traefe Vercels
//     Egress-IP und damit ALLE Nutzer.) Gegen parallele Anfragen: je Akteur
//     nur ein Versuch gleichzeitig (freigabeStarten) + erneutes Zaehlen nach
//     dem Fehlversuch-Insert (5. Fehlversuch → sofort 429).
//   • Falsches Passwort → Protokoll finanzen.freigabe_fehlgeschlagen + 401.
//   • Erfolg → Protokoll finanzen.freigabe FAIL-CLOSED, dann Cookie.
// Kein Logging des Passworts, nie logError mit E-Mail.

import { createClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { finanzenFehler, finanzenJson, protokollFehler, requireFinanzenStart } from "@/lib/finanzen/auth";
import { erstelleStepUpTicket, freigabeBeenden, freigabeStarten, stepUpCookieSetzen } from "@/lib/finanzen/stepup";
import { protokolliereZugriff, zaehleFreigabeFehlversuche } from "@/lib/finanzen/zugriffe";
import {
  FINANZEN_FEHLER,
  STEPUP_MAX_FEHLVERSUCHE,
  STEPUP_PASSWORT_MAX,
  ZUGRIFF_AKTION,
  type StepUpBestaetigtAntwort,
} from "@/lib/finanzen/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requireFinanzenStart();
  if (auth.error) return auth.error;
  const { user, geraetHash } = auth;

  const body = (await request.json().catch(() => null)) as { passwort?: unknown } | null;
  const passwort = body?.passwort;
  if (typeof passwort !== "string" || passwort.length < 1 || passwort.length > STEPUP_PASSWORT_MAX) {
    return finanzenJson({ success: false, error: "Ungültige Eingabe" }, { status: 400 });
  }
  if (!user.email) {
    return finanzenJson({ success: false, error: "Konto ohne E-Mail — Passwortpfad nicht möglich." }, { status: 400 });
  }

  // Riegel zuerst.
  if ((await zaehleFreigabeFehlversuche(user.id)) >= STEPUP_MAX_FEHLVERSUCHE) {
    return finanzenFehler(FINANZEN_FEHLER.STEPUP_GESPERRT, 429, "Zu viele Fehlversuche — bitte 15 Minuten warten.");
  }
  // Je Akteur nur ein Versuch gleichzeitig (Zaehlen-dann-Pruefen-Luecke
  // waehrend des GoTrue-Roundtrips).
  if (!freigabeStarten(user.id)) {
    return finanzenFehler(FINANZEN_FEHLER.STEPUP_GESPERRT, 429, "Eine Bestätigung läuft bereits.");
  }

  let wegwerfToken: string | null = null;
  try {
    // Wegwerf-Client — bewusst NICHT @/lib/supabase/server (der wuerde die
    // Cookies der echten Sitzung anfassen).
    const wegwerf = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
    );
    const { data, error } = await wegwerf.auth.signInWithPassword({ email: user.email, password: passwort });
    wegwerfToken = data.session?.access_token ?? null;

    if (error) {
      // 400/401/403 = Passwort abgelehnt. Alles andere (429 Rate-Limit, 5xx,
      // Netz) ist kein Fehlversuch des Users → 503 ohne Protokoll-Zeile.
      const status = error.status ?? 0;
      if (status !== 400 && status !== 401 && status !== 403) {
        return finanzenJson({ success: false, error: "Anmeldedienst nicht erreichbar" }, { status: 503 });
      }
      await protokolliereZugriff({
        actorProfileId: user.id,
        bereich: "finanzen",
        aktion: ZUGRIFF_AKTION.FINANZEN_FREIGABE_FEHLGESCHLAGEN,
        geraetHash,
        details: { methode: "passwort" },
      });
      // Nach dem Insert erneut zaehlen: der 5. Fehlversuch sperrt sofort
      // (schliesst das Fenster auf einen Roundtrip).
      if ((await zaehleFreigabeFehlversuche(user.id)) >= STEPUP_MAX_FEHLVERSUCHE) {
        return finanzenFehler(FINANZEN_FEHLER.STEPUP_GESPERRT, 429, "Zu viele Fehlversuche — bitte 15 Minuten warten.");
      }
      return finanzenFehler(FINANZEN_FEHLER.PASSWORT_FALSCH, 401, "Passwort stimmt nicht.");
    }
  } finally {
    freigabeBeenden(user.id);
  }

  // Deterministischer Revoke der Wegwerf-Sitzung — NIE "global".
  if (wegwerfToken) {
    await createAdminClient().auth.admin.signOut(wegwerfToken, "local").catch(() => undefined);
  }

  const { ticket, exp } = erstelleStepUpTicket(user.id, geraetHash);
  const protokolliert = await protokolliereZugriff({
    actorProfileId: user.id,
    bereich: "finanzen",
    aktion: ZUGRIFF_AKTION.FINANZEN_FREIGABE,
    geraetHash,
    details: { methode: "passwort" },
  });
  if (!protokolliert) return protokollFehler();

  const antwort: StepUpBestaetigtAntwort = { success: true, bisUnix: exp };
  const res = finanzenJson(antwort);
  stepUpCookieSetzen(res, ticket);
  return res;
}
