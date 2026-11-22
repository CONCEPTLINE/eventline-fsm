// «Ein Login» aus LINERA one: Aussteller alt und neu (E9), Signatur, Empfänger.
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { verifyTrustOneToken } = await import("./trust-one-sso");

const paar = generateKeyPairSync("ed25519");
const pubB64 = (paar.publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64");

function token(claims: Record<string, unknown>, privat: KeyObject = paar.privateKey): string {
  const h = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const s = sign(null, Buffer.from(`${h}.${p}`), privat).toString("base64url");
  return `${h}.${p}.${s}`;
}

function claims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const iat = Math.floor(Date.now() / 1000);
  return { iss: "https://one.linera-group.ch", aud: "eventline", sub: randomUUID(), iat, exp: iat + 60, jti: randomUUID(), ...extra };
}

beforeEach(() => {
  vi.stubEnv("TRUST_ONE_SSO_PUBLIC_KEY", pubB64);
  vi.stubEnv("LINERA_ONE_SSO_PUBLIC_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("verifyTrustOneToken", () => {
  it("alter Aussteller one.trust-group.ch → abgelehnt (E9 W5)", () => {
    expect(verifyTrustOneToken(token(claims({ iss: "https://one.trust-group.ch" })), "eventline")).toBeNull();
  });

  it("neuer Aussteller one.linera-group.ch → gültig (Schlüsseltag)", () => {
    expect(verifyTrustOneToken(token(claims({ iss: "https://one.linera-group.ch" })), "eventline")?.iss).toBe("https://one.linera-group.ch");
  });

  it("fremder Aussteller, falscher Empfänger oder fremder Schlüssel → abgelehnt", () => {
    expect(verifyTrustOneToken(token(claims({ iss: "https://flow.linera-group.ch" })), "eventline")).toBeNull();
    expect(verifyTrustOneToken(token(claims({ iss: "https://one.linera-group.ch/" })), "eventline")).toBeNull();
    expect(verifyTrustOneToken(token(claims({ iss: ["https://one.linera-group.ch"] })), "eventline")).toBeNull();
    expect(verifyTrustOneToken(token(claims({ aud: "conceptline" })), "eventline")).toBeNull();
    expect(verifyTrustOneToken(token(claims(), generateKeyPairSync("ed25519").privateKey), "eventline")).toBeNull();
  });

  it("ohne öffentlichen Schlüssel → abgelehnt", () => {
    vi.stubEnv("TRUST_ONE_SSO_PUBLIC_KEY", "");
    expect(verifyTrustOneToken(token(claims()), "eventline")).toBeNull();
  });

  it("Schlüssel unter dem neuen Namen LINERA_ONE_SSO_PUBLIC_KEY → gültig (alter Name nur Rückfall)", () => {
    vi.stubEnv("TRUST_ONE_SSO_PUBLIC_KEY", "");
    vi.stubEnv("LINERA_ONE_SSO_PUBLIC_KEY", pubB64);
    expect(verifyTrustOneToken(token(claims()), "eventline")).not.toBeNull();
  });
});
