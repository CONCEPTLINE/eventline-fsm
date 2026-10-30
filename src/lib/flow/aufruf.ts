// Ablauf eines Aufrufs aus Trust flow (alle Routen /api/flow/*), rein und testbar.
//
//   1. Kein öffentlicher Schlüssel (Env FLOW_ABRUF_PUBLIC_KEY)  → 503 nicht_eingerichtet (nie offen)
//   2. Ausweis prüfen (Signatur, Aussteller, Empfänger, Zeit)   → 401 ausweis_ungueltig
//   3. Wartung im Bereich «lohn»                                → 503 wartung (Hinweis wie in der App)
//   4. Einmal-Schutz + Höchstzahl je Minute (Datenbank, atomar) → 409 ausweis_verwendet | 429 zu_viele
//   5. Claims der Route                                         → 400/422 (Protokoll «abgelehnt»)
//   6. Ausführen; Protokoll abschliessen (Personen, sha256 der Antwort), erst dann antworten.
//
// Nach aussen nur Codes, nie Details zur Signaturprüfung. Die Datenbank-Seite
// (flow_abrufe, Migration 369) und die Wartung kommen über `FlowSpeicher`
// (Server: src/lib/flow/server.ts; Tests: Attrappe in aufruf.test.ts).

import { WARTUNG_FEHLER_CODE, WARTUNG_MELDUNG } from "@/lib/wartung";
import { ladeFlowSchluessel, pruefeFlowAusweis, type AusweisGrund, type FlowAud, type FlowAusweis } from "./ausweis";
import { protokollKennzahlen, sha256Hex, type RegelFehler } from "./regeln";

export interface BeginnDaten {
  jti: string;
  aud: FlowAud;
  sub: string;
  jahr: number | null;
  monat: number | null;
  angefragt: number | null;
  iat: number;
  exp: number;
}

export type BeginnErgebnis =
  | { status: "ok"; id: string }
  | { status: "wiederholt" }
  | { status: "zu_viele"; retryAfter: number };

export interface Abschluss {
  status: "ok" | "abgelehnt" | "fehler";
  geliefert: number | null;
  sha256: string | null;
  grund: string | null;
}

export interface FlowSpeicher {
  /** Bereich «lohn» in Wartung (ohne Ausnahme — Trust flow ist kein Konto)? */
  wartungAktiv(): Promise<boolean>;
  beginne(d: BeginnDaten): Promise<BeginnErgebnis>;
  schliesse(id: string, a: Abschluss): Promise<void>;
}

export interface FlowAntwort {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export type Ausgefuehrt = { ok: true; body: unknown; geliefert: number } | RegelFehler;

export interface FlowLog {
  aud: FlowAud;
  status: number;
  code: string;
  grund?: AusweisGrund | string;
  geliefert?: number | null;
}

const KOPF = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

function json(status: number, body: unknown, extra: Record<string, string> = {}): FlowAntwort {
  return { status, body: JSON.stringify(body), headers: { ...KOPF, ...extra } };
}
const fehlerAntwort = (status: number, code: string, meldung: string, extra: Record<string, string> = {}) =>
  json(status, { success: false, code, error: meldung }, extra);

export async function bearbeiteFlowAufruf<T>(o: {
  aud: FlowAud;
  token: string;
  schluesselWert: string | undefined;
  speicher: FlowSpeicher;
  /** Routenspezifische Claims (nach dem Einmal-Schutz, damit auch Ablehnungen im Protokoll stehen). */
  pruefe: (ausweis: FlowAusweis) => { ok: true; anfrage: T } | RegelFehler;
  ausfuehren: (anfrage: T, ausweis: FlowAusweis, abrufId: string) => Promise<Ausgefuehrt>;
  jetztSek?: number;
  log?: (e: FlowLog) => void;
}): Promise<FlowAntwort> {
  const log = o.log ?? (() => {});
  const schluessel = ladeFlowSchluessel(o.schluesselWert);
  if (!schluessel) {
    log({ aud: o.aud, status: 503, code: "nicht_eingerichtet" });
    return fehlerAntwort(503, "nicht_eingerichtet", "Schnittstelle nicht eingerichtet.");
  }

  const r = pruefeFlowAusweis(o.token, o.aud, schluessel, o.jetztSek);
  if (!r.ok) {
    log({ aud: o.aud, status: 401, code: "ausweis_ungueltig", grund: r.grund });
    return fehlerAntwort(401, "ausweis_ungueltig", "Ausweis ungültig.");
  }
  const a = r.ausweis;

  if (await o.speicher.wartungAktiv()) {
    log({ aud: o.aud, status: 503, code: WARTUNG_FEHLER_CODE });
    return json(503, { success: false, code: WARTUNG_FEHLER_CODE, error: WARTUNG_MELDUNG, message: WARTUNG_MELDUNG, bereich: "lohn" });
  }

  const k = protokollKennzahlen(a.claims, o.aud);
  const b = await o.speicher.beginne({ jti: a.jti, aud: o.aud, sub: a.sub, ...k, iat: a.iat, exp: a.exp });
  if (b.status === "wiederholt") {
    log({ aud: o.aud, status: 409, code: "ausweis_verwendet" });
    return fehlerAntwort(409, "ausweis_verwendet", "Ausweis wurde schon verwendet — für jeden Abruf einen neuen ausstellen.");
  }
  if (b.status === "zu_viele") {
    log({ aud: o.aud, status: 429, code: "zu_viele" });
    return fehlerAntwort(429, "zu_viele", "Zu viele Abrufe — bitte kurz warten.", { "Retry-After": String(Math.max(1, b.retryAfter)) });
  }

  const p = o.pruefe(a);
  if (!p.ok) {
    await o.speicher.schliesse(b.id, { status: "abgelehnt", geliefert: null, sha256: null, grund: p.code });
    log({ aud: o.aud, status: p.status, code: p.code });
    return fehlerAntwort(p.status, p.code, p.meldung);
  }

  let e: Ausgefuehrt;
  try {
    e = await o.ausfuehren(p.anfrage, a, b.id);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    // Protokoll-Fehler hier nicht mehr werfen: die 500 geht so oder so raus.
    await o.speicher.schliesse(b.id, { status: "fehler", geliefert: null, sha256: null, grund: text.slice(0, 500) }).catch(() => {});
    log({ aud: o.aud, status: 500, code: "fehler", grund: text.slice(0, 200) });
    return fehlerAntwort(500, "fehler", "Abruf fehlgeschlagen.");
  }
  if (!e.ok) {
    await o.speicher.schliesse(b.id, { status: "abgelehnt", geliefert: null, sha256: null, grund: e.code });
    log({ aud: o.aud, status: e.status, code: e.code });
    return fehlerAntwort(e.status, e.code, e.meldung);
  }

  const body = JSON.stringify(e.body);
  const sha = sha256Hex(body);
  // Erst protokollieren, dann liefern: ohne vollständiges Protokoll verlässt nichts das ERP.
  await o.speicher.schliesse(b.id, { status: "ok", geliefert: e.geliefert, sha256: sha, grund: null });
  log({ aud: o.aud, status: 200, code: "ok", geliefert: e.geliefert });
  return { status: 200, body, headers: { ...KOPF, "X-Antwort-Sha256": sha } };
}
