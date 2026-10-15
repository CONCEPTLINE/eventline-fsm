// Step-up-Ticket fuer /finanzen (Finanzen Welle 1, Spec B.3/B.5).
//
// Nach vertrautem Geraet (requireAdminTrustedDevice) bestaetigt sich der
// Admin zusaetzlich kurz per Passkey oder Passwort. Das Ergebnis ist ein
// HMAC-signiertes Ticket im HttpOnly-Cookie `eventline_stepup`, das NUR an
// /api/finanzen/* geht (Cookie-Pfad) und 15 Minuten ABSOLUT gilt — keine
// Verlaengerung bei Aktivitaet.
//
// Format (Muster src/lib/ki/ticket.ts):  v1.<base64url(json)>.<hex hmac-sha256>
//   json = { user_id, dev, iat, exp }
//   dev  = sha256-Hex des trusted-device-Cookies (api-auth.ts hashToken):
//          ein gestohlenes Step-up-Cookie nuetzt ohne das Geraete-Cookie nichts.
// Signiert wird "v1.<base64url>", damit die Version unter der Signatur liegt.
//
// Schluessel: HMAC-SHA256(SUPABASE_SERVICE_ROLE_KEY, STEPUP_KEY_KONTEXT) —
// abgeleitet, nie der rohe Pepper, nie derselbe Schluessel wie hashWert()
// in bildschirm.ts (Kontext-Trennung). Code bewusst kopiert statt aus
// bildschirm.ts importiert (das ist Bildschirm-Domaene).

import { createHmac, timingSafeEqual } from "crypto";
import type { NextResponse } from "next/server";
import {
  STEPUP_COOKIE,
  STEPUP_COOKIE_PATH,
  STEPUP_GUELTIG_S,
  STEPUP_KEY_KONTEXT,
  STEPUP_TICKET_VERSION,
  type StepUpClaims,
  type StepUpGrund,
} from "@/lib/finanzen/types";

/** Toleranz fuer iat in der Zukunft (Uhren-Drift), Sekunden. */
const IAT_ZUKUNFT_TOLERANZ_S = 60;
const DEV_HASH_RE = /^[0-9a-f]{64}$/;

function pepper(): string {
  const p = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!p) throw new Error("SUPABASE_SERVICE_ROLE_KEY fehlt");
  return p;
}

/** Abgeleiteter HMAC-Schluessel (Buffer) — nie der rohe Pepper. */
function schluessel(): Buffer {
  return createHmac("sha256", pepper()).update(STEPUP_KEY_KONTEXT).digest();
}

function signiere(kopf: string): string {
  return createHmac("sha256", schluessel()).update(kopf).digest("hex");
}

function hashGleich(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function erstelleStepUpTicket(userId: string, geraetHash: string, jetztMs = Date.now()): { ticket: string; exp: number } {
  const iat = Math.floor(jetztMs / 1000);
  const exp = iat + STEPUP_GUELTIG_S;
  const claims: StepUpClaims = { user_id: userId, dev: geraetHash, iat, exp };
  const kopf = `${STEPUP_TICKET_VERSION}.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}`;
  return { ticket: `${kopf}.${signiere(kopf)}`, exp };
}

/** Claims typgeprueft aus dem base64url-Teil — JSON.parse liefert alles,
 *  ohne diese Pruefung wuerde z. B. exp: "9999999999" koerziert. */
function claimsLesen(teil: string, jetztS: number): StepUpClaims | null {
  let roh: unknown;
  try {
    roh = JSON.parse(Buffer.from(teil, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!roh || typeof roh !== "object") return null;
  const c = roh as Record<string, unknown>;
  const user_id = c.user_id;
  const dev = c.dev;
  const iat = c.iat;
  const exp = c.exp;
  if (typeof user_id !== "string" || user_id.length === 0) return null;
  if (typeof dev !== "string" || !DEV_HASH_RE.test(dev)) return null;
  if (typeof iat !== "number" || !Number.isFinite(iat)) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  if (exp - iat > STEPUP_GUELTIG_S) return null;
  if (iat > jetztS + IAT_ZUKUNFT_TOLERANZ_S) return null;
  return { user_id, dev, iat, exp };
}

/** Pruefreihenfolge: fehlt → format (inkl. Typen) → signatur → abgelaufen →
 *  user → geraet. */
export function pruefeStepUpTicket(
  ticket: string | null | undefined,
  userId: string,
  geraetHash: string | null,
  jetztMs = Date.now(),
): { ok: true; claims: StepUpClaims } | { ok: false; grund: StepUpGrund } {
  if (!ticket) return { ok: false, grund: "fehlt" };
  const teile = ticket.split(".");
  if (teile.length !== 3 || teile[0] !== STEPUP_TICKET_VERSION) return { ok: false, grund: "format" };
  const claims = claimsLesen(teile[1], Math.floor(jetztMs / 1000));
  if (!claims) return { ok: false, grund: "format" };
  const kopf = `${teile[0]}.${teile[1]}`;
  if (!hashGleich(signiere(kopf), teile[2])) return { ok: false, grund: "signatur" };
  if (claims.exp * 1000 <= jetztMs) return { ok: false, grund: "abgelaufen" };
  if (claims.user_id !== userId) return { ok: false, grund: "user" };
  if (!geraetHash || claims.dev !== geraetHash) return { ok: false, grund: "geraet" };
  return { ok: true, claims };
}

// ---------------------------------------------------------------------
// Gleichzeitige Freigabe-Versuche desselben Akteurs (Riegel-Ergaenzung)
// ---------------------------------------------------------------------
// Der Fehlversuchs-Riegel (zaehleFreigabeFehlversuche) ist Zaehlen-dann-
// Pruefen: zwischen Zaehlung und Fehlversuch-Zeile liegt der GoTrue-/
// WebAuthn-Roundtrip. 20 gleichzeitige Anfragen saehen alle denselben
// alten Zaehler. Pro Lambda-Instanz laeuft darum je Akteur nur EIN Versuch;
// ein zweiter gleichzeitiger bekommt 429 ohne GoTrue-Call. Best effort
// (Modul-Zustand je Instanz) — die zweite Verteidigung ist das erneute
// Zaehlen NACH dem Fehlversuch-Insert in den Routen.

const freigabeLaeuft = new Set<string>();

/** true = Versuch darf starten (bis freigabeBeenden); false = fuer diesen
 *  Akteur laeuft gerade einer. */
export function freigabeStarten(userId: string): boolean {
  if (freigabeLaeuft.has(userId)) return false;
  freigabeLaeuft.add(userId);
  return true;
}

export function freigabeBeenden(userId: string): void {
  freigabeLaeuft.delete(userId);
}

export function stepUpCookieOptionen(): { httpOnly: true; secure: boolean; sameSite: "lax"; path: typeof STEPUP_COOKIE_PATH; maxAge: number } {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: STEPUP_COOKIE_PATH,
    maxAge: STEPUP_GUELTIG_S,
  };
}

export function stepUpCookieSetzen(res: NextResponse, ticket: string): void {
  res.cookies.set(STEPUP_COOKIE, ticket, stepUpCookieOptionen());
}

/** Loeschen mit DEMSELBEN Pfad wie beim Setzen (sonst bleibt das Cookie). */
export function stepUpCookieLoeschen(res: NextResponse): void {
  res.cookies.set(STEPUP_COOKIE, "", { ...stepUpCookieOptionen(), maxAge: 0, expires: new Date(0) });
}
