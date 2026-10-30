import "server-only";
import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

// «TFD1» — Verschluesselung eines Mail-Anhangs fuer den Ablage-Dienst im Buero (E1, Umzug der Ablage nach Trust flow).
// Trust flow und die Cloud sehen nur das Chiffrat; entschluesseln kann nur der Rig. Byte-genau nach der Referenz von
// Trust flow (_backoffice-uebergabe/12_tfd1-referenz.mjs = rig/ablage/lib/krypto.mjs = src/lib/ablage/durchgang.ts dort),
// Testvektoren in tfd1-testvektoren.json.
//
//   Kopf 99 Byte: "TFD1" | Version 1 | Flags 0 | Stueckgroesse u32 BE | Laenge Klartext u64 BE | Salz 16 | Absender-Schluessel 65
//   Schluessel = HKDF-SHA256(ECDH(Absender, Rig), Salz, "trust-flow-durchgang-v1|" + auftrag_id) → AES-256-GCM
//   Stuecke à Stueckgroesse (Standard 4 MiB; leere Datei = ein leeres Stueck): Nonce = 8 × 0x00 | Nr. u32 BE,
//   zusaetzliche Daten = Kopf | Nr. u32 BE | letztes (0/1), Tag 16 Byte hinten an jedem Stueck.
// Absender-Schluessel (P-256) und Salz sind je Datei neu und zufaellig. testAbsender/testSalz gibt es nur fuer die
// Testvektoren — im Betrieb nie setzen.

const MAGIE = Buffer.from("TFD1", "ascii");
/** Standard-Stueckgroesse: 4 MiB. */
export const TFD1_STUECK = 4 * 1024 * 1024;
const KOPF = 99;
const TAG = 16;
const INFO = "trust-flow-durchgang-v1|";
/** Oeffentlicher P-256-Schluessel roh unkomprimiert (0x04 ‖ x ‖ y = 65 Byte) als base64url: genau 87 Zeichen. */
const RIG_SCHLUESSEL_FORM = /^B[A-P][A-Za-z0-9_-]{85}$/;

/** Hat `s` die Form eines oeffentlichen Rig-Schluessels (P-256 roh, base64url, 87 Zeichen)? Prueft nur die Form. */
export function istRigSchluessel(s: unknown): s is string {
  return typeof s === "string" && RIG_SCHLUESSEL_FORM.test(s);
}

function empfaengerRoh(b64url: string): Buffer {
  if (!istRigSchluessel(b64url)) throw new Error("rig_schluessel: P-256 roh, base64url (87 Zeichen)");
  const roh = Buffer.from(b64url, "base64url");
  if (roh.length !== 65 || roh[0] !== 4) throw new Error("rig_schluessel: kein P-256-Punkt");
  return roh;
}

function nonce(i: number): Buffer {
  const n = Buffer.alloc(12);
  n.writeUInt32BE(i, 8);
  return n;
}

function zusatz(kopf: Buffer, i: number, letztes: boolean): Buffer {
  const b = Buffer.alloc(KOPF + 5);
  kopf.copy(b, 0);
  b.writeUInt32BE(i, KOPF);
  b[KOPF + 4] = letztes ? 1 : 0;
  return b;
}

/** Laenge des Chiffrats fuer `laenge` Byte Klartext (so gross muss das Objekt im Durchgang sein). */
export function chiffratLaenge(laenge: number, stueck: number = TFD1_STUECK): number {
  return KOPF + laenge + TAG * Math.max(1, Math.ceil(laenge / stueck));
}

export interface Tfd1Optionen {
  /** Stueckgroesse (1024 … 64 MiB), Standard 4 MiB. */
  stueck?: number;
  /** NUR Testvektoren: privater Absender-Skalar (hex, 32 Byte). Im Betrieb nie setzen. */
  testAbsender?: string;
  /** NUR Testvektoren: Salz (hex, 16 Byte). Im Betrieb nie setzen. */
  testSalz?: string;
}

/** Klartext ohne Kopie als Buffer sehen. */
function alsBuffer(x: ArrayBuffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(x)) return x;
  if (x instanceof Uint8Array) return Buffer.from(x.buffer, x.byteOffset, x.byteLength);
  return Buffer.from(x);
}

/**
 * Klartext fuer den Ablage-Dienst verschluesseln. `auftragId` = auftrag_id aus «anmelden» (ein Chiffrat passt nur zu
 * seinem Auftrag), `rigSchluessel` = oeffentlicher Schluessel des Rigs (base64url). Gibt einen Buffer der Laenge
 * chiffratLaenge(klartext.byteLength, stueck).
 */
export function tfd1Verschluesseln(
  klartext: ArrayBuffer | Uint8Array,
  rigSchluessel: string,
  auftragId: string,
  { stueck = TFD1_STUECK, testAbsender, testSalz }: Tfd1Optionen = {},
): Buffer<ArrayBuffer> {
  const klar = alsBuffer(klartext);
  if (typeof auftragId !== "string" || auftragId.length < 1 || auftragId.length > 200) throw new Error("kontext: auftrag_id");
  if (!Number.isInteger(stueck) || stueck < 1024 || stueck > 64 * 1024 * 1024) throw new Error("stueck ungueltig");
  const ecdh = createECDH("prime256v1");
  if (testAbsender) ecdh.setPrivateKey(Buffer.from(testAbsender, "hex"));
  else ecdh.generateKeys();
  const geteilt = ecdh.computeSecret(empfaengerRoh(rigSchluessel));
  const salz = testSalz ? Buffer.from(testSalz, "hex") : randomBytes(16);
  if (salz.length !== 16) throw new Error("Salz: 16 Byte");

  const kopf = Buffer.alloc(KOPF);
  MAGIE.copy(kopf, 0);
  kopf[4] = 1;
  kopf[5] = 0;
  kopf.writeUInt32BE(stueck, 6);
  kopf.writeBigUInt64BE(BigInt(klar.length), 10);
  salz.copy(kopf, 18);
  ecdh.getPublicKey().copy(kopf, 34);
  const key = Buffer.from(hkdfSync("sha256", geteilt, salz, Buffer.from(INFO + auftragId, "utf8"), 32));

  const teile: Buffer[] = [kopf];
  const n = Math.max(1, Math.ceil(klar.length / stueck));
  for (let i = 0; i < n; i++) {
    const c = createCipheriv("aes-256-gcm", key, nonce(i));
    c.setAAD(zusatz(kopf, i, i === n - 1));
    teile.push(c.update(klar.subarray(i * stueck, (i + 1) * stueck)), c.final(), c.getAuthTag());
  }
  return Buffer.concat(teile);
}
