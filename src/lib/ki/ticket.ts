// Tickets fuer die Direktverbindung Browser -> Rig (SPEC 2.2) — nur noch
// fuer Archiv-Fragen (Phase 3). Das FSM bestaetigt damit, WER fuer
// 10 Minuten zugreifen darf; das Rig prueft Signatur, Ablauf und Scope
// selbst ueber das geteilte Geheimnis KI_TICKET_SECRET — ohne Rueckfrage
// ans FSM, denn Archiv-Antworten gehen nie ueber Vercel/Supabase.
// (Diktate laufen ueber die Warteschlange, /api/ki/diktat.)
//
// Format:  v1.<base64url(json)>.<hex hmac-sha256>
//          json = { sub, scope: "archiv", exp: unix-sekunden }
// Signiert wird der Text VOR dem letzten Punkt ("v1.<base64url>"), damit
// die Versionskennung mit unter der Signatur liegt.

import { createHmac } from "crypto";
import { KI_TICKET_GUELTIG_S } from "./konstanten";
import type { KiTicketClaims, KiTicketScope } from "./typen";

/** true wenn das geteilte Geheimnis gesetzt ist — sonst ist die Direkt-API
 *  faktisch abgeschaltet und die Routen antworten 503. */
export function kiTicketKonfiguriert(): boolean {
  return (process.env.KI_TICKET_SECRET ?? "").length >= 32;
}

export function erstelleKiTicket(sub: string, scope: KiTicketScope, jetztMs = Date.now()): { ticket: string; exp: number } {
  const secret = process.env.KI_TICKET_SECRET ?? "";
  if (secret.length < 32) throw new Error("KI_TICKET_SECRET fehlt oder ist zu kurz");
  const exp = Math.floor(jetztMs / 1000) + KI_TICKET_GUELTIG_S;
  const claims: KiTicketClaims = { sub, scope, exp };
  const kopf = `v1.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}`;
  const signatur = createHmac("sha256", secret).update(kopf).digest("hex");
  return { ticket: `${kopf}.${signatur}`, exp };
}
