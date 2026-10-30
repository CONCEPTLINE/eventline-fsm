// Nur für Tests: Gegenstück zu «TFD1» wie der Ablage-Dienst auf dem Rig (Referenz tfd1Entschluesseln) und der
// Test-Empfänger der Referenz-Testvektoren. Wird von keiner Route importiert (das ERP entschlüsselt nie und kennt keinen
// privaten Rig-Schlüssel).

import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { chiffratLaenge } from "./tfd1";
import vektoren from "./tfd1-testvektoren.json";

const KOPF = 99;
const TAG = 16;

/** Öffentlicher Test-Empfänger (= rig_schluessel im Test, 87 Zeichen base64url). Nie im Betrieb. */
export const TEST_RIG_OEFFENTLICH: string = vektoren.test_empfaenger_oeffentlich;
/** Privater Skalar des Test-Empfängers (hex). Nie im Betrieb. */
export const TEST_RIG_PRIVAT_HEX: string = vektoren.test_empfaenger_privat_hex;

/** Entschlüsselt ein TFD1-Chiffrat mit dem privaten Skalar des Empfängers; wirft bei falschem Kontext/Schlüssel. */
export function tfd1Entschluesseln(chiffrat: Uint8Array, privatHex: string, kontext: string): Buffer {
  const c = Buffer.from(chiffrat);
  const kopf = c.subarray(0, KOPF);
  if (kopf.subarray(0, 4).toString("ascii") !== "TFD1" || kopf[4] !== 1 || kopf[5] !== 0) throw new Error("kein TFD1");
  const stueck = kopf.readUInt32BE(6);
  const laenge = Number(kopf.readBigUInt64BE(10));
  if (c.length !== chiffratLaenge(laenge, stueck)) throw new Error("Länge stimmt nicht");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privatHex, "hex"));
  const geteilt = ecdh.computeSecret(kopf.subarray(34, 99));
  const key = Buffer.from(hkdfSync("sha256", geteilt, kopf.subarray(18, 34), Buffer.from("trust-flow-durchgang-v1|" + kontext, "utf8"), 32));
  const n = Math.max(1, Math.ceil(laenge / stueck));
  const aus: Buffer[] = [];
  let pos = KOPF;
  for (let i = 0; i < n; i++) {
    const len = Math.min(stueck, laenge - i * stueck);
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(i, 8);
    const aad = Buffer.alloc(KOPF + 5);
    kopf.copy(aad, 0);
    aad.writeUInt32BE(i, KOPF);
    aad[KOPF + 4] = i === n - 1 ? 1 : 0;
    const d = createDecipheriv("aes-256-gcm", key, nonce);
    d.setAAD(aad);
    d.setAuthTag(c.subarray(pos + len, pos + len + TAG));
    aus.push(d.update(c.subarray(pos, pos + len)), d.final());
    pos += len + TAG;
  }
  return Buffer.concat(aus);
}
