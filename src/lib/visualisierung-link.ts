// Teilbare Links fuer HTML-Visualisierungen (Leo 2026-10-22): Kunden/Partner
// sehen ein 3D-Modell ohne Login unter /ansicht/<token>.
//
// Token = "<docId>.<exp>.<signatur>", signiert per HMAC-SHA256. Pepper ist
// der Service-Role-Key (Muster bildschirm.ts — auf Vercel vorhanden, kein
// neues Secret), mit eigenem Zweck-Praefix getrennt von anderen HMACs.
// Kein DB-Eintrag: der Link gilt bis exp und nur, solange das Dokument
// existiert — Dokument loeschen = Link sofort tot.

import { createHmac, timingSafeEqual } from "crypto";
import { appUrl } from "@/lib/app-url";

/** Gueltigkeit eines Links. */
export const LINK_GUELTIG_TAGE = 90;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function signatur(docId: string, exp: number): string {
  const pepper = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!pepper) throw new Error("SUPABASE_SERVICE_ROLE_KEY fehlt");
  return createHmac("sha256", pepper)
    .update(`visualisierung-link:v1:${docId}:${exp}`)
    .digest("base64url");
}

export function erstelleVisualisierungLink(docId: string, jetztMs = Date.now()): { url: string; gueltigBis: string } {
  const exp = Math.floor(jetztMs / 1000) + LINK_GUELTIG_TAGE * 24 * 3600;
  const token = `${docId}.${exp}.${signatur(docId, exp)}`;
  return { url: appUrl(`/ansicht/${token}`), gueltigBis: new Date(exp * 1000).toISOString() };
}

/** docId bei gueltigem, nicht abgelaufenem Token — sonst null. */
export function pruefeVisualisierungLink(token: string, jetztMs = Date.now()): string | null {
  const [docId, expRoh, sig, ...rest] = token.split(".");
  if (rest.length || !docId || !expRoh || !sig || !UUID_RE.test(docId) || !/^\d{1,12}$/.test(expRoh)) return null;
  const exp = Number(expRoh);
  if (exp * 1000 < jetztMs) return null;
  const soll = Buffer.from(signatur(docId, exp));
  const ist = Buffer.from(sig);
  return soll.length === ist.length && timingSafeEqual(soll, ist) ? docId : null;
}

/** Antwort fuer eine HTML-Visualisierung. Der Sandbox-CSP fuer die
 *  ausliefernden Pfade steht in next.config.ts (visualisierungCsp). */
export function visualisierungAntwort(inhalt: ArrayBuffer, name: string, download = false): Response {
  return new Response(inhalt, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
