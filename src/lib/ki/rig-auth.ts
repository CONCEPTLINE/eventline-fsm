// Auth der Rig-Schnittstellen des ERP (/api/ki/sync, /api/ki/sicherheit):
// Bearer KI_SYNC_TOKEN, timing-safe verglichen. Ohne konfiguriertes Secret
// antworten die Routen 503 — faktisch abgeschaltet.

import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";

/** true = gueltig, false = falsch/fehlt, null = Secret nicht konfiguriert. */
export function rigTokenOk(request: Request): boolean | null {
  const secret = process.env.KI_SYNC_TOKEN;
  if (!secret || secret.length < 32) return null; // nicht konfiguriert
  const header = request.headers.get("authorization") ?? "";
  const angeboten = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(angeboten);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Fehlerantwort fuer ungueltige Rig-Anfragen, sonst null. */
export function rigAuthFehler(request: Request): NextResponse | null {
  const ok = rigTokenOk(request);
  if (ok === null) return NextResponse.json({ success: false, error: "Lokale KI nicht konfiguriert" }, { status: 503 });
  if (!ok) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  return null;
}
