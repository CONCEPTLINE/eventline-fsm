// Nur für Tests: Ed25519-Schlüsselpaar und Ausweise wie Trust flow sie ausstellt.
// Wird von keiner Route importiert (die App kann keine Ausweise ausstellen).

import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { stempelBereich } from "@/lib/lohn/kern";
import { FLOW_FIRMA, FLOW_ISS, type FlowAud } from "./ausweis";

export interface TestSchluessel {
  privat: KeyObject;
  /** Wie Env FLOW_ABRUF_PUBLIC_KEY: SPKI/DER base64. */
  oeffentlichB64: string;
}

export function testSchluessel(): TestSchluessel {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privat: privateKey, oeffentlichB64: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

export function signiere(privat: KeyObject, claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "EdDSA", typ: "JWT" }): string {
  const h = b64(header);
  const p = b64(claims);
  const s = sign(null, Buffer.from(`${h}.${p}`), privat).toString("base64url");
  return `${h}.${p}.${s}`;
}

export const SUB = "0f0e0d0c-0b0a-4908-8706-050403020100";
export const P1 = "a0000000-0000-4000-8000-000000000011";
export const P2 = "a0000000-0000-4000-8000-000000000012";

let zaehler = 0;
export function neueJti(): string {
  zaehler++;
  return `00000000-0000-4000-8000-${String(zaehler).padStart(12, "0")}`;
}

/** Gültige Claims für aud; jetzt in Sekunden. */
export function claims(aud: FlowAud, jetzt: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const b = stempelBereich(2026, 12);
  return {
    iss: FLOW_ISS,
    aud,
    sub: SUB,
    jti: neueJti(),
    iat: jetzt,
    exp: jetzt + 60,
    firma: FLOW_FIRMA,
    jahr: 2026,
    monat: 12,
    von: b.von,
    bis: b.bis,
    profile: [P1, P2],
    aal: "aal2",
    geraet: true,
    ...extra,
  };
}
