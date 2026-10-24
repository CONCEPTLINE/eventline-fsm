import "server-only";
import { createPublicKey, verify } from "node:crypto";

export type TrustOneClaims = { iss: string; aud: string; sub: string; name?: string; iat: number; exp: number; jti: string };
const ISS = "https://one.trust-group.ch";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Prüft Signatur, Aussteller, Empfänger und Zeit. Gibt null bei jedem Fehler (nie Details nach aussen). */
export function verifyTrustOneToken(token: string, audience: "eventline" | "conceptline"): TrustOneClaims | null {
  const key = process.env.TRUST_ONE_SSO_PUBLIC_KEY;
  if (!key || typeof token !== "string" || token.length > 4000) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  try {
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    if (header?.alg !== "EdDSA") return null;
    const pub = createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" });
    if (!verify(null, Buffer.from(`${h}.${p}`), pub, Buffer.from(s, "base64url"))) return null;
    const c = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as TrustOneClaims;
    const now = Math.floor(Date.now() / 1000);
    if (c.iss !== ISS || c.aud !== audience) return null;
    if (typeof c.iat !== "number" || typeof c.exp !== "number") return null;
    if (c.exp < now - 5 || c.iat > now + 30 || c.exp - c.iat > 120) return null;
    if (!UUID.test(c.sub) || typeof c.jti !== "string" || c.jti.length < 16 || c.jti.length > 200) return null;
    if (c.name !== undefined && (typeof c.name !== "string" || c.name.length > 120)) return null;
    return c;
  } catch {
    return null;
  }
}
