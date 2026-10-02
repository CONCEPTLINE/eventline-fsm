// Buero-Bildschirm ohne Login (Leo 2026-10-02, Migration 285).
//
// Ablauf: /bildschirm fordert einen 6-stelligen Code an → Mail an
// admin@eventline-basel.com → Code eingeben → langlebiges Session-Cookie
// (nur fuer /api/bildschirm/daten, rein lesend, keine Supabase-Session).
// Codes und Tokens liegen in der DB ausschliesslich als HMAC-Hash; der
// Pepper ist der Service-Role-Key (ist auf Vercel vorhanden, kein neues
// Secret noetig). Rohes Token kennt nur das Cookie des Bildschirms.

import { createHmac, randomBytes, randomInt, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const BILDSCHIRM_COOKIE = "eventline_bildschirm";
export const BILDSCHIRM_MAIL = "admin@eventline-basel.com";
/** Code-Gueltigkeit in Minuten. */
export const CODE_MINUTEN = 10;
/** Fehlversuche, nach denen ein Code entwertet wird. */
export const CODE_MAX_VERSUCHE = 6;
/** Cookie-Lebensdauer (400 Tage = Browser-Maximum). */
const COOKIE_SEKUNDEN = 400 * 24 * 3600;

function pepper(): string {
  const p = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!p) throw new Error("SUPABASE_SERVICE_ROLE_KEY fehlt");
  return p;
}

export function hashWert(wert: string): string {
  return createHmac("sha256", pepper()).update(wert).digest("hex");
}

export function hashGleich(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function neuerCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function neuesToken(): string {
  return randomBytes(32).toString("hex");
}

export function cookieOptionen() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: COOKIE_SEKUNDEN,
  };
}

/** Gueltige Bildschirm-Session aus dem Cookie — sonst null. Stempelt
 *  last_seen_at hoechstens alle 5 Minuten (Dashboard pollt alle 30s). */
export async function bildschirmSession(req: NextRequest): Promise<{ id: string } | null> {
  const token = req.cookies.get(BILDSCHIRM_COOKIE)?.value;
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const admin = createAdminClient();
  const { data } = await admin
    .from("bildschirm_sessions")
    .select("id, last_seen_at")
    .eq("token_hash", hashWert(token))
    .is("revoked_at", null)
    .maybeSingle();
  if (!data) return null;
  const seen = data.last_seen_at ? new Date(data.last_seen_at as string).getTime() : 0;
  if (Date.now() - seen > 5 * 60_000) {
    await admin.from("bildschirm_sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", data.id);
  }
  return { id: data.id as string };
}
