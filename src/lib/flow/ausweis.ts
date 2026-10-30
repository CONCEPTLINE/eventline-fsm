// Ausweis von Trust flow prüfen (Schnittstelle ERP ↔ Trust flow, Migration 369).
//
// Vertrag: _backoffice-uebergabe/10_Schnittstelle_Stunden.md + 06_Aenderungen.md (30.10.2026).
// Kompaktes JWS, Header {"alg":"EdDSA","typ":"JWT"}, signiert von Trust flow mit
// FLOW_ABRUF_PRIVATE_KEY (Ed25519). Das ERP kennt nur den ÖFFENTLICHEN Schlüssel
// (Env FLOW_ABRUF_PUBLIC_KEY, SPKI/DER base64) — kein gemeinsames Geheimnis, das
// ERP kann keinen Ausweis ausstellen.
//
// Claims: iss https://flow.trust-group.ch, aud (je Route), sub (Trust-flow-Profil),
// jti (UUID, einmalig — prüft der Server in flow_abrufe), iat, exp (= iat + 60),
// firma "eventline", aal "aal2", geraet true; je Route weitere (src/lib/flow/regeln.ts).
//
// Rein (kein Next.js, keine Datenbank) — Unit-Tests: ausweis.test.ts.

import { createPublicKey, verify, type KeyObject } from "node:crypto";

export const FLOW_ISS = "https://flow.trust-group.ch";
export const FLOW_FIRMA = "eventline";

export const FLOW_AUDS = ["erp-stempel", "erp-personen", "erp-vergleich", "erp-lohnabrechnung-ablage"] as const;
export type FlowAud = (typeof FLOW_AUDS)[number];

/** Höchstens so lange gilt ein Ausweis (exp − iat). */
export const AUSWEIS_GUELTIG_S = 60;
/** Uhren-Spielraum: iat darf so weit in der Zukunft liegen, exp so weit vorbei sein. */
export const UHR_SPIEL_S = 5;
/** Grösster akzeptierter Ausweis (50 Profil-IDs ≈ 2 KB). */
export const AUSWEIS_MAX_ZEICHEN = 16_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL = /^[A-Za-z0-9_-]+$/;

export interface FlowAusweis {
  iss: string;
  aud: FlowAud;
  sub: string;
  jti: string;
  iat: number;
  exp: number;
  firma: string;
  aal: string;
  geraet: true;
  /** Alle Claims (für die routenspezifische Prüfung). */
  claims: Record<string, unknown>;
}

/** Warum ein Ausweis abgelehnt wurde — nur für Protokoll/Tests, nie nach aussen. */
export type AusweisGrund =
  | "format"
  | "header"
  | "signatur"
  | "aussteller"
  | "empfaenger"
  | "zeit"
  | "abgelaufen"
  | "felder";

export type AusweisErgebnis = { ok: true; ausweis: FlowAusweis } | { ok: false; grund: AusweisGrund };

export const istUuid = (x: unknown): x is string => typeof x === "string" && UUID.test(x);

/**
 * Öffentlichen Schlüssel aus dem Env-Wert lesen (SPKI/DER base64). null, wenn
 * leer oder kein Ed25519-Schlüssel — die Routen antworten dann 503 (nie offen).
 */
export function ladeFlowSchluessel(wert: string | undefined | null): KeyObject | null {
  const roh = (wert ?? "").trim();
  if (!roh) return null;
  try {
    const key = createPublicKey({ key: Buffer.from(roh, "base64"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

function jsonTeil(teil: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(teil, "base64url").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Prüft Format, Signatur (Ed25519), Aussteller, Empfänger, Zeit und die
 * gemeinsamen Claims. Den Einmal-Schutz (jti) und die Höchstzahl je Minute
 * prüft der Server danach in der Datenbank (flow_abruf_beginnen).
 */
export function pruefeFlowAusweis(
  token: string,
  erwartet: FlowAud,
  schluessel: KeyObject,
  jetztSek: number = Math.floor(Date.now() / 1000),
): AusweisErgebnis {
  if (typeof token !== "string" || token.length === 0 || token.length > AUSWEIS_MAX_ZEICHEN) return { ok: false, grund: "format" };
  const teile = token.split(".");
  if (teile.length !== 3 || !teile.every((t) => B64URL.test(t))) return { ok: false, grund: "format" };
  const [h, p, s] = teile;

  const header = jsonTeil(h);
  if (!header || header.alg !== "EdDSA") return { ok: false, grund: "header" };
  if (header.typ !== undefined && header.typ !== "JWT") return { ok: false, grund: "header" };
  // Kritische Erweiterungen kennt das ERP nicht → ablehnen (RFC 7515 4.1.11).
  if (header.crit !== undefined) return { ok: false, grund: "header" };

  const signatur = Buffer.from(s, "base64url");
  if (signatur.length !== 64) return { ok: false, grund: "signatur" };
  let echt = false;
  try {
    echt = verify(null, Buffer.from(`${h}.${p}`, "ascii"), schluessel, signatur);
  } catch {
    echt = false;
  }
  if (!echt) return { ok: false, grund: "signatur" };

  const c = jsonTeil(p);
  if (!c) return { ok: false, grund: "format" };
  if (c.iss !== FLOW_ISS) return { ok: false, grund: "aussteller" };
  if (c.aud !== erwartet) return { ok: false, grund: "empfaenger" };

  const { iat, exp, nbf } = c;
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) return { ok: false, grund: "zeit" };
  const i = iat as number;
  const e = exp as number;
  if (e <= i || e - i > AUSWEIS_GUELTIG_S) return { ok: false, grund: "zeit" };
  if (i > jetztSek + UHR_SPIEL_S) return { ok: false, grund: "zeit" };
  if (nbf !== undefined && (!Number.isInteger(nbf) || (nbf as number) > jetztSek + UHR_SPIEL_S)) return { ok: false, grund: "zeit" };
  if (jetztSek > e + UHR_SPIEL_S) return { ok: false, grund: "abgelaufen" };

  if (!istUuid(c.sub) || !istUuid(c.jti)) return { ok: false, grund: "felder" };
  if (c.firma !== FLOW_FIRMA || c.aal !== "aal2" || c.geraet !== true) return { ok: false, grund: "felder" };

  return {
    ok: true,
    ausweis: {
      iss: FLOW_ISS,
      aud: erwartet,
      sub: (c.sub as string).toLowerCase(),
      jti: (c.jti as string).toLowerCase(),
      iat: i,
      exp: e,
      firma: FLOW_FIRMA,
      aal: "aal2",
      geraet: true,
      claims: c,
    },
  };
}
