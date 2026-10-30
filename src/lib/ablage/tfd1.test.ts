// lib/ablage/tfd1 — «TFD1» byte-genau gegen die Testvektoren der Referenz von Trust flow, Zufall im Betrieb und
// Gegenprobe mit dem Test-Empfaenger (Entschluesseln wie der Rig; das ERP selbst entschluesselt nie).
import { createECDH, createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { TEST_RIG_OEFFENTLICH, TEST_RIG_PRIVAT_HEX, tfd1Entschluesseln } from "./test-hilfen";
import { chiffratLaenge, istRigSchluessel, TFD1_STUECK, tfd1Verschluesseln } from "./tfd1";
import fixture from "./tfd1-testvektoren.json";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const EMPFAENGER = TEST_RIG_OEFFENTLICH;
const PRIVAT = TEST_RIG_PRIVAT_HEX;

describe("tfd1Verschluesseln — Testvektoren der Referenz (byte-genau)", () => {
  it("Test-Empfaenger: oeffentlicher Schluessel passt zum privaten", () => {
    const e = createECDH("prime256v1");
    e.setPrivateKey(Buffer.from(PRIVAT, "hex"));
    expect(e.getPublicKey().toString("base64url")).toBe(EMPFAENGER);
    expect(EMPFAENGER).toHaveLength(87);
  });

  it.each(fixture.vektoren.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    const klar = Buffer.from(v.klartext_hex, "hex");
    const c = tfd1Verschluesseln(klar, EMPFAENGER, v.kontext, { stueck: v.stueck, testAbsender: v.test_absender, testSalz: v.test_salz });
    expect(c.length).toBe(v.chiffrat_laenge);
    expect(c.length).toBe(chiffratLaenge(klar.length, v.stueck));
    expect(sha256(c)).toBe(v.chiffrat_sha256);
    expect(c.toString("base64")).toBe(v.chiffrat_base64);
    // Gegenprobe wie der Rig; falscher Kontext (andere auftrag_id) wird abgelehnt
    expect(tfd1Entschluesseln(c, PRIVAT, v.kontext).toString("hex")).toBe(v.klartext_hex);
    expect(() => tfd1Entschluesseln(c, PRIVAT, v.kontext + "x")).toThrow();
  });

  it("Vektor «kurz» stimmt auch als ArrayBuffer und als Teil-Ansicht (Uint8Array mit Versatz)", () => {
    const v = fixture.vektoren.find((x) => x.name === "kurz")!;
    const klar = Buffer.from(v.klartext_hex, "hex");
    const opts = { stueck: v.stueck, testAbsender: v.test_absender, testSalz: v.test_salz };
    const ab = klar.buffer.slice(klar.byteOffset, klar.byteOffset + klar.byteLength);
    expect(sha256(tfd1Verschluesseln(ab, EMPFAENGER, v.kontext, opts))).toBe(v.chiffrat_sha256);
    const gross = new Uint8Array(klar.length + 7);
    gross.set(klar, 3);
    expect(sha256(tfd1Verschluesseln(gross.subarray(3, 3 + klar.length), EMPFAENGER, v.kontext, opts))).toBe(v.chiffrat_sha256);
  });
});

describe("tfd1Verschluesseln — Betrieb", () => {
  it("ohne Test-Parameter jedes Mal anders (Absender-Schluessel und Salz zufaellig), beide entschluesselbar", () => {
    const klar = Buffer.from("Rechnung als PDF-Ersatz", "utf8");
    const a = tfd1Verschluesseln(klar, EMPFAENGER, "auftrag-1");
    const b = tfd1Verschluesseln(klar, EMPFAENGER, "auftrag-1");
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(18, 34).equals(b.subarray(18, 34))).toBe(false); // Salz
    expect(a.subarray(34, 99).equals(b.subarray(34, 99))).toBe(false); // Absender-Schluessel
    expect(tfd1Entschluesseln(a, PRIVAT, "auftrag-1").equals(klar)).toBe(true);
    expect(tfd1Entschluesseln(b, PRIVAT, "auftrag-1").equals(klar)).toBe(true);
  });

  it("Round-Trip ueber mehrere 4-MiB-Stuecke (9 MiB + 5 Byte), Laenge = chiffratLaenge", () => {
    const klar = Buffer.alloc(9 * 1024 * 1024 + 5);
    for (let i = 0; i < klar.length; i += 4093) klar[i] = i % 251;
    const c = tfd1Verschluesseln(klar, EMPFAENGER, "0b3a2c1e-1111-4222-8333-444455556666");
    expect(c.length).toBe(chiffratLaenge(klar.length));
    expect(c.length).toBe(99 + klar.length + 16 * 3);
    expect(c.subarray(0, 4).toString("ascii")).toBe("TFD1");
    expect(c.readUInt32BE(6)).toBe(TFD1_STUECK);
    expect(tfd1Entschluesseln(c, PRIVAT, "0b3a2c1e-1111-4222-8333-444455556666").equals(klar)).toBe(true);
  });

  it("chiffratLaenge: leere Datei = ein leeres Stueck, genau 4 MiB = ein Stueck, 4 MiB + 1 = zwei", () => {
    expect(chiffratLaenge(0)).toBe(115);
    expect(chiffratLaenge(37)).toBe(152);
    expect(chiffratLaenge(TFD1_STUECK)).toBe(99 + TFD1_STUECK + 16);
    expect(chiffratLaenge(TFD1_STUECK + 1)).toBe(99 + TFD1_STUECK + 1 + 32);
    expect(chiffratLaenge(2500, 1024)).toBe(2647);
  });

  it("lehnt ungueltige Eingaben ab: Rig-Schluessel, auftrag_id, Stueckgroesse", () => {
    const klar = Buffer.from("x");
    expect(istRigSchluessel(EMPFAENGER)).toBe(true);
    expect(istRigSchluessel(EMPFAENGER.slice(1))).toBe(false);
    expect(istRigSchluessel(`${EMPFAENGER}=`)).toBe(false);
    expect(istRigSchluessel(null)).toBe(false);
    expect(() => tfd1Verschluesseln(klar, EMPFAENGER.slice(0, 86), "k")).toThrow(/rig_schluessel/);
    expect(() => tfd1Verschluesseln(klar, `C${EMPFAENGER.slice(1)}`, "k")).toThrow(/rig_schluessel/);
    expect(() => tfd1Verschluesseln(klar, "B" + "A".repeat(86), "k")).toThrow(); // Form ok, aber kein Punkt der Kurve
    expect(() => tfd1Verschluesseln(klar, EMPFAENGER, "")).toThrow(/auftrag_id/);
    expect(() => tfd1Verschluesseln(klar, EMPFAENGER, "k".repeat(201))).toThrow(/auftrag_id/);
    expect(() => tfd1Verschluesseln(klar, EMPFAENGER, "k", { stueck: 1023 })).toThrow(/stueck/);
  });
});
