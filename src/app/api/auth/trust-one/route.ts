/**
 * POST /api/auth/trust-one
 * Body: { token: string }  (Ausweis aus Trust one, kommt von /sso#t=…)
 *
 * «Ein Login»: Trust one stellt einen Ed25519-signierten Ausweis aus
 * (60 s gueltig, einmalig). Ablauf:
 *   1. Ausweis pruefen (Signatur, Aussteller, Empfaenger "eventline", Zeit).
 *   2. jti in trust_one_sso_tokens eintragen — schon da = Wiederholung.
 *   3. Verbindung Trust-one-User -> Profil suchen (trust_one_links).
 *      - keine: pending_id (10 Min.) an die Zeile haengen → der Nutzer meldet
 *        sich einmal normal an und verbindet unter /sso/verbinden.
 *      - vorhanden: Profil muss dieselben Bedingungen erfuellen wie beim
 *        normalen Login (aktiv, internes Konto — keine Portal-Rolle). Dann
 *        Session wie beim Passkey-Login herstellen: magiclink-hashed_token
 *        an den Client, der ruft verifyOtp (siehe passkey/auth-verify).
 *
 * Ohne Login erreichbar (Middleware: /api/auth/* ist frei). Service-Rolle
 * nur hier. Nach aussen nie Fehlerdetails: invalid | not_linked | blocked |
 * error | ok. Es wird nie ein User angelegt und nie ueber eine E-Mail aus
 * dem Ausweis gegangen (es gibt keine) — die E-Mail kommt immer AKTUELL aus
 * dem Auth-User des verknuepften Profils.
 */

import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyTrustOneToken } from "@/lib/trust-one-sso";
import { istPortalRolle } from "@/lib/portals";
import { logError } from "@/lib/log";

const PENDING_MS = 10 * 60 * 1000;

function antwort(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
const ungueltig = () => antwort(400, { status: "invalid" });
const gesperrt = () => antwort(403, { status: "blocked" });
const fehler = () => antwort(500, { status: "error" });

export async function POST(request: Request) {
  let token: unknown;
  try {
    const text = await request.text();
    if (text.length > 8000) return ungueltig();
    token = (JSON.parse(text) as { token?: unknown } | null)?.token;
  } catch {
    return ungueltig();
  }
  if (typeof token !== "string") return ungueltig();

  const claims = verifyTrustOneToken(token, "eventline");
  if (!claims) return ungueltig();

  const admin = createAdminClient();
  const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : null;

  // 2) Einmal-Schutz: der Primaerschluessel jti laesst jeden Ausweis genau
  //    einmal durch (auch bei parallelen Anfragen).
  const { error: insErr } = await admin
    .from("trust_one_sso_tokens")
    .insert({ jti: claims.jti, trust_one_user_id: claims.sub, trust_one_name: name });
  if (insErr) {
    if (insErr.code === "23505") return ungueltig();
    logError("api.auth.trust-one.insert", insErr);
    return fehler();
  }

  // 3) Verbindung suchen.
  const { data: link, error: linkErr } = await admin
    .from("trust_one_links")
    .select("profile_id")
    .eq("trust_one_user_id", claims.sub)
    .maybeSingle();
  if (linkErr) {
    logError("api.auth.trust-one.link-lookup", linkErr);
    return fehler();
  }

  if (!link) {
    const pending = randomBytes(32).toString("base64url");
    const { error: upErr } = await admin
      .from("trust_one_sso_tokens")
      .update({ pending_id: pending, pending_until: new Date(Date.now() + PENDING_MS).toISOString() })
      .eq("jti", claims.jti);
    if (upErr) {
      logError("api.auth.trust-one.pending", upErr);
      return fehler();
    }
    return antwort(200, { status: "not_linked", pending, name });
  }

  // Profil: gleiche Huerden wie der normale Login bzw. is_internal_user()
  // (aktiv, Rolle existiert und ist keine Portal-Rolle).
  const { data: profile, error: profErr } = await admin
    .from("profiles")
    .select("id, role, is_active")
    .eq("id", link.profile_id)
    .maybeSingle();
  if (profErr) {
    logError("api.auth.trust-one.profile", profErr);
    return fehler();
  }
  if (!profile || profile.is_active !== true || istPortalRolle(profile.role)) return gesperrt();
  const { data: rolle, error: rolleErr } = await admin
    .from("roles")
    .select("is_portal")
    .eq("slug", profile.role)
    .maybeSingle();
  if (rolleErr) {
    logError("api.auth.trust-one.role", rolleErr);
    return fehler();
  }
  if (!rolle || rolle.is_portal === true) return gesperrt();

  // Auth-User per ID → AKTUELLE E-Mail. Gesperrte Konten (banned_until in
  // der Zukunft) kommen auch hier nicht rein.
  const { data: authData, error: authErr } = await admin.auth.admin.getUserById(profile.id);
  if (authErr && authErr.status !== 404) {
    logError("api.auth.trust-one.auth-user", authErr);
    return fehler();
  }
  const user = authData?.user;
  if (!user || !user.email) return gesperrt();
  if (user.banned_until && new Date(user.banned_until).getTime() > Date.now()) return gesperrt();

  // Session-Handshake wie beim Passkey-Login (generateLink verschickt keine
  // Mail): hashed_token an den Client, der ruft verifyOtp({ type: "email" }).
  const { data: linkData, error: genErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: user.email,
  });
  if (genErr || !linkData?.properties?.hashed_token) {
    logError("api.auth.trust-one.generate-link", genErr ?? "kein hashed_token");
    return fehler();
  }

  // Kein eigenes Login-Protokoll in der App — eine Zeile im Vercel-Log.
  console.info(JSON.stringify({ ctx: "api.auth.trust-one", ereignis: "Anmeldung über Trust one", profile_id: profile.id }));

  return antwort(200, { status: "ok", token_hash: linkData.properties.hashed_token });
}
