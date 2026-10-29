// Auth der Telefonassistentin «Lena» (Bland AI, Custom Tools → /api/lena/*).
// Muster aus src/lib/ki/rig-auth.ts kopiert (nicht importiert — eigener
// Bereich, eigenes Secret): Bearer LENA_TOKEN, timing-safe verglichen. Ohne
// (oder mit zu kurzem) Secret antworten die Routen 503 — faktisch abgeschaltet.
//
// Bewusst ohne Server-Importe ausser crypto — wird in Unit-Tests direkt geprueft.

import { timingSafeEqual } from "crypto";

/** Mindestlaenge des Secrets — kuerzer gilt als «nicht konfiguriert». */
export const LENA_TOKEN_MIN = 32;

/** Einzige erlaubte Anrufer-Nummer (Leo), E.164 ohne Leerzeichen. */
export const LENA_ANRUFER_ERLAUBT = "+41782049521";

/** Optionaler Header, in den Bland die Nummer des Anrufers schreibt. */
export const LENA_ANRUFER_HEADER = "x-lena-anrufer";

/** true = gueltig, false = falsch/fehlt, null = Secret nicht konfiguriert. */
export function lenaTokenPruefen(authorization: string | null, secret: string | undefined): boolean | null {
  const s = secret?.trim() ?? "";
  if (s.length < LENA_TOKEN_MIN) return null; // nicht konfiguriert
  const header = authorization ?? "";
  const angeboten = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(angeboten);
  const b = Buffer.from(s);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Anrufer-Pruefung (Zusatz, Hauptschutz bleibt der Token):
 *  Header fehlt → erlaubt. Header gesetzt (auch leer oder mit nicht
 *  ersetztem Platzhalter) → nach Entfernen aller Leerzeichen muss er exakt
 *  die erlaubte Nummer sein, sonst abgelehnt (fail closed). */
export function anruferErlaubt(header: string | null): boolean {
  if (header === null) return true;
  return header.replace(/\s+/g, "") === LENA_ANRUFER_ERLAUBT;
}

/** Anrufer fuers Protokoll: ohne Leerzeichen, auf 32 Zeichen gekappt. */
export function anruferFuersProtokoll(header: string | null): string | null {
  if (header === null) return null;
  return header.replace(/\s+/g, "").slice(0, 32);
}
