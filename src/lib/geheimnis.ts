// Zeitsicherer Geheimnis-Vergleich (Lohn-Umbau Phase 1, Befund 16).
//
// `a === b` bricht beim ersten abweichenden Zeichen ab — die Antwortzeit
// verrät, wie viele Zeichen eines geratenen Geheimnisses stimmen. Hier werden
// beide Werte zuerst gehasht (gleiche Länge, keine Längen-Auskunft) und dann
// mit crypto.timingSafeEqual verglichen.
//
// Verwendung:
//   if (!istCronAufruf(request)) return 401;          // Cron-Routen
//   if (!geheimnisGleich(token, process.env.X)) ...   // sonstige Geheimnisse
//
// Stand 29.10.2026 nutzen das nur die Lohn-Cron-Routen. Die übrigen Cron-
// Routen (andere Sessions) vergleichen noch mit `!==` und sollen nachziehen:
// siehe supabase/lokal/live-gang-phase1/LIVE-GANG.md («Cron-Routen»).

import { createHash, timingSafeEqual } from "crypto";

/** true, wenn beide Werte gesetzt und gleich sind — zeitsicher. */
export function geheimnisGleich(
  gegeben: string | null | undefined,
  erwartet: string | null | undefined,
): boolean {
  if (!gegeben || !erwartet) return false;
  const a = createHash("sha256").update(gegeben, "utf8").digest();
  const b = createHash("sha256").update(erwartet, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Cron-Aufruf mit `Authorization: Bearer <CRON_SECRET>`? Ohne gesetztes
 *  CRON_SECRET immer false (nie «leeres Geheimnis = offen»). */
export function istCronAufruf(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return geheimnisGleich(request.headers.get("authorization"), `Bearer ${secret}`);
}
