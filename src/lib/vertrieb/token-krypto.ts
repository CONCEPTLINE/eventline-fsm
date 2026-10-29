/**
 * Vertrieb: Refresh-Token des Postfachs verschlüsselt speichern (Audit M4).
 *
 * AES-256-GCM. Schlüssel = SHA-256(SUPABASE_SERVICE_ROLE_KEY | fester Kontext
 * aus m365-konstanten.json) — das Geheimnis gibt es in allen Vercel-
 * Umgebungen, es braucht keine neue Variable. Gleiche Ableitung im Skript
 * scripts/vertrieb-postfach-verbinden.mjs.
 * Format: "v1:" + base64(iv[12] | tag[16] | geheimtext).
 * Ein alter, unverschlüsselter Token wird beim Lesen akzeptiert (der Aufrufer
 * schreibt ihn danach verschlüsselt zurück).
 * Achtung: Wird der Service-Role-Key gewechselt, muss das Postfach neu
 * verbunden werden.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import KONSTANTEN from "./m365-konstanten.json";

const PRAEFIX = "v1:";

function schluessel(geheimnis = process.env.SUPABASE_SERVICE_ROLE_KEY): Buffer {
  if (!geheimnis) throw new Error("SUPABASE_SERVICE_ROLE_KEY fehlt");
  return createHash("sha256").update(`${geheimnis}|${KONSTANTEN.schluesselKontext}`, "utf8").digest();
}

export function verschluessele(klar: string, geheimnis?: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", schluessel(geheimnis), iv);
  const geheim = Buffer.concat([c.update(klar, "utf8"), c.final()]);
  return PRAEFIX + Buffer.concat([iv, c.getAuthTag(), geheim]).toString("base64");
}

/** Entschlüsselt; ein unverschlüsselter Alt-Token kommt unverändert zurück. */
export function entschluessele(gespeichert: string, geheimnis?: string): { klar: string; warVerschluesselt: boolean } {
  if (!gespeichert.startsWith(PRAEFIX)) return { klar: gespeichert, warVerschluesselt: false };
  const roh = Buffer.from(gespeichert.slice(PRAEFIX.length), "base64");
  const d = createDecipheriv("aes-256-gcm", schluessel(geheimnis), roh.subarray(0, 12));
  d.setAuthTag(roh.subarray(12, 28));
  const klar = Buffer.concat([d.update(roh.subarray(28)), d.final()]).toString("utf8");
  return { klar, warVerschluesselt: true };
}
