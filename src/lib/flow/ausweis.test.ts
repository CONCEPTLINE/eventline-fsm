// Ausweis von Trust flow (Ed25519-JWS): Signatur, Aussteller, Empfänger, Zeit, Felder.
import { describe, expect, it } from "vitest";
import { ladeFlowSchluessel, pruefeFlowAusweis } from "./ausweis";
import { claims, signiere, testSchluessel } from "./test-hilfen";

const JETZT = 1_800_000_000;
const k = testSchluessel();
const pub = ladeFlowSchluessel(k.oeffentlichB64)!;
const pruefe = (token: string, aud: Parameters<typeof pruefeFlowAusweis>[1] = "erp-stempel", jetzt = JETZT) =>
  pruefeFlowAusweis(token, aud, pub, jetzt);

describe("Schlüssel aus FLOW_ABRUF_PUBLIC_KEY", () => {
  it("fehlt, leer oder kein Ed25519 → null (Route antwortet 503)", () => {
    expect(ladeFlowSchluessel(undefined)).toBeNull();
    expect(ladeFlowSchluessel("  ")).toBeNull();
    expect(ladeFlowSchluessel("kein-schluessel")).toBeNull();
    expect(pub.asymmetricKeyType).toBe("ed25519");
  });
  it("der öffentliche Schlüssel von Trust flow (06_Aenderungen.md) ist ein gültiger Ed25519-Schlüssel", () => {
    expect(ladeFlowSchluessel("MCowBQYDK2VwAyEAgYnAq76J/sQiWiQso20hbp7UXhUM1qyAedjEdheA60U=")?.asymmetricKeyType).toBe("ed25519");
  });
});

describe("Ausweis prüfen", () => {
  it("gültig → ok, Claims übernommen", () => {
    const c = claims("erp-stempel", JETZT);
    const r = pruefe(signiere(k.privat, c));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ausweis.jti).toBe(c.jti);
      expect(r.ausweis.sub).toBe(c.sub);
      expect(r.ausweis.claims.profile).toEqual(c.profile);
    }
  });

  it("abgelaufen (mehr als 5 s nach exp) → abgelehnt; innerhalb des Spielraums noch gültig", () => {
    const t = signiere(k.privat, claims("erp-stempel", JETZT));
    expect(pruefe(t, "erp-stempel", JETZT + 65).ok).toBe(true);
    expect(pruefe(t, "erp-stempel", JETZT + 66)).toEqual({ ok: false, grund: "abgelaufen" });
  });

  it("länger als 60 s gültig, iat in der Zukunft oder exp ≤ iat → abgelehnt", () => {
    expect(pruefe(signiere(k.privat, claims("erp-stempel", JETZT, { exp: JETZT + 61 })))).toEqual({ ok: false, grund: "zeit" });
    expect(pruefe(signiere(k.privat, claims("erp-stempel", JETZT + 30)))).toEqual({ ok: false, grund: "zeit" });
    expect(pruefe(signiere(k.privat, claims("erp-stempel", JETZT, { exp: JETZT })))).toEqual({ ok: false, grund: "zeit" });
    expect(pruefe(signiere(k.privat, claims("erp-stempel", JETZT, { iat: "jetzt" })))).toEqual({ ok: false, grund: "zeit" });
    expect(pruefe(signiere(k.privat, claims("erp-stempel", JETZT, { nbf: JETZT + 30 })))).toEqual({ ok: false, grund: "zeit" });
  });

  it("falscher Empfänger (aud einer anderen Route) → abgelehnt", () => {
    const t = signiere(k.privat, claims("erp-personen", JETZT));
    expect(pruefe(t, "erp-stempel")).toEqual({ ok: false, grund: "empfaenger" });
    expect(pruefe(t, "erp-personen").ok).toBe(true);
    expect(pruefe(signiere(k.privat, claims("erp-stempel", JETZT, { aud: ["erp-stempel"] })))).toEqual({ ok: false, grund: "empfaenger" });
  });

  it("Stammdaten (A6, aud flow-stammdaten): jahr/monat/von/bis dürfen fehlen; fremder aud → abgelehnt", () => {
    const ohneMonat = claims("flow-stammdaten", JETZT);
    for (const f of ["jahr", "monat", "von", "bis"]) delete ohneMonat[f];
    const r = pruefe(signiere(k.privat, ohneMonat), "flow-stammdaten");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ausweis.aud).toBe("flow-stammdaten");
    expect(pruefe(signiere(k.privat, claims("erp-personen", JETZT)), "flow-stammdaten")).toEqual({ ok: false, grund: "empfaenger" });
    expect(pruefe(signiere(k.privat, ohneMonat), "erp-personen")).toEqual({ ok: false, grund: "empfaenger" });
    // Gemeinsame Pflicht-Claims gelten auch hier (aal2, Gerät).
    expect(pruefe(signiere(k.privat, { ...ohneMonat, aal: "aal1" }), "flow-stammdaten")).toEqual({ ok: false, grund: "felder" });
    expect(pruefe(signiere(k.privat, { ...ohneMonat, geraet: false }), "flow-stammdaten")).toEqual({ ok: false, grund: "felder" });
  });

  it("falscher Schlüssel (anderes Schlüsselpaar) → Signatur ungültig", () => {
    const fremd = testSchluessel();
    expect(pruefe(signiere(fremd.privat, claims("erp-stempel", JETZT)))).toEqual({ ok: false, grund: "signatur" });
  });

  it("veränderte Claims (Signatur passt nicht mehr) → abgelehnt", () => {
    const [h, , s] = signiere(k.privat, claims("erp-stempel", JETZT)).split(".");
    const anders = Buffer.from(JSON.stringify(claims("erp-stempel", JETZT, { profile: ["a0000000-0000-4000-8000-000000000099"] }))).toString("base64url");
    expect(pruefe(`${h}.${anders}.${s}`)).toEqual({ ok: false, grund: "signatur" });
  });

  it("anderer Algorithmus (none/HS256) oder kritische Erweiterung → abgelehnt", () => {
    const c = claims("erp-stempel", JETZT);
    expect(pruefe(signiere(k.privat, c, { alg: "none" }))).toEqual({ ok: false, grund: "header" });
    expect(pruefe(signiere(k.privat, c, { alg: "HS256", typ: "JWT" }))).toEqual({ ok: false, grund: "header" });
    expect(pruefe(signiere(k.privat, c, { alg: "EdDSA", crit: ["exp"] }))).toEqual({ ok: false, grund: "header" });
    const [h, p] = signiere(k.privat, c).split(".");
    expect(pruefe(`${h}.${p}.`)).toEqual({ ok: false, grund: "format" });
  });

  it("falscher Aussteller, Firma, aal oder Gerät → abgelehnt", () => {
    expect(pruefe(signiere(k.privat, claims("erp-stempel", JETZT, { iss: "https://one.trust-group.ch" })))).toEqual({ ok: false, grund: "aussteller" });
    expect(pruefe(signiere(k.privat, claims("erp-stempel", JETZT, { firma: "conceptline" })))).toEqual({ ok: false, grund: "felder" });
    expect(pruefe(signiere(k.privat, claims("erp-stempel", JETZT, { aal: "aal1" })))).toEqual({ ok: false, grund: "felder" });
    expect(pruefe(signiere(k.privat, claims("erp-stempel", JETZT, { geraet: false })))).toEqual({ ok: false, grund: "felder" });
    expect(pruefe(signiere(k.privat, claims("erp-stempel", JETZT, { jti: "kein-uuid-aber-lang-genug" })))).toEqual({ ok: false, grund: "felder" });
  });

  it("Unsinn und zu lange Ausweise → Format", () => {
    expect(pruefe("")).toEqual({ ok: false, grund: "format" });
    expect(pruefe("a.b")).toEqual({ ok: false, grund: "format" });
    expect(pruefe("a.b.c d")).toEqual({ ok: false, grund: "format" });
    expect(pruefe("x".repeat(20_000))).toEqual({ ok: false, grund: "format" });
  });
});
