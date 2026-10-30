import "server-only";
import { unstable_cache } from "next/cache";
import { chiffratLaenge, istRigSchluessel, tfd1Verschluesseln } from "@/lib/ablage/tfd1";
import { FLOW_FIRMA } from "@/lib/flow/ausweis";
import { TRUST_ONE_ABLAGE_BEREICH, TRUST_ONE_FRISTEN_LINK, TRUST_ONE_URL_STANDARD } from "@/lib/trust-one";

// Fremd-API der Ablage in Trust one (Trust one: src/app/api/ablage/extern/*). Die Ablage der EVENTLINE GmbH lebt seit
// 24.10.2026 dort; das ERP liefert nur noch Mail-Anhaenge an und liest die Fristen-Zaehler.
//   leiteAblageAnhangWeiter()  POST {TRUST_ONE_URL}/api/ablage/extern/eingang   (Resend-Webhook ablage@…), zweistufig:
//                              anmelden → PUT der Bytes an die signierte Upload-URL (Trust-one-Speicher) → bestaetigen
//   ladeTrustOneFristen()      GET  {TRUST_ONE_URL}/api/ablage/extern/fristen   (Dashboard, Buero-Bildschirm)
// Anmeldung: Bearer TRUST_ONE_ABLAGE_TOKEN (= ABLAGE_EXTERN_TOKEN in Trust one). TRUST_ONE_URL ist optional
// (Standard https://one.trust-group.ch). Werte nie loggen. Die Speicher-Adresse kommt absolut aus der Antwort von
// «anmelden» (Token steckt in der URL) — das ERP kennt keinen Schluessel des Trust-one-Speichers.
//
// Umzug nach Trust flow (Umzugstag 28.11.2026): EIN Schalter, env ABLAGE_ZIEL = "trust-one" (Standard, auch leer
// oder unbekannt) | "trust-flow" — ablageZiel(). Bei "trust-flow":
//   ladeTrustOneFristen()      POST {TRUST_FLOW_URL}/api/ablage/extern/fristen  Body {firma: "eventline", tage: 30}
//                              → {offen, faellig, vorschlaege}; faellig (innert 30 Tagen) = aktiv, vorschlaege = vorschlag
//   ablageFristenLink()        {TRUST_FLOW_URL}/eventline/fristen statt der Fristen-Ansicht in Trust one (Dashboard-Kachel)
//   leiteAblageAnhangWeiter()  (E1) POST {TRUST_FLOW_URL}/api/ablage/extern/eingang: anmelden → Anhang mit «TFD1»
//                              fuer den Rig verschluesseln (lib/ablage/tfd1) → PUT des Chiffrats → bestaetigen.
//                              Trust flow und die Cloud sehen den Inhalt nie. Der oeffentliche Rig-Schluessel ist
//                              fest hinterlegt (env RIG_ABLAGE_ENC_PUBLIC_KEY) und muss mit `rig_schluessel` aus der
//                              Antwort uebereinstimmen — sonst kein Upload; fehlt er, geht nichts raus (fail closed).
// TRUST_FLOW_URL ist optional (Standard https://flow.trust-group.ch); gleicher Bearer TRUST_ONE_ABLAGE_TOKEN
// (ABLAGE_EXTERN_TOKEN zieht mit um).

/** Wartezeit auf die Fristen (Dashboard und Wand warten darauf). */
const FRISTEN_TIMEOUT_MS = 8_000;
/** Wartezeit auf «anmelden» bzw. «bestaetigen» (nur JSON, die Trust-one-Route hat maxDuration 30). */
const EINGANG_SCHRITT_TIMEOUT_MS = 20_000;
/** Wartezeit auf den Upload in den Speicher (bis 50 MB). */
const UPLOAD_TIMEOUT_MS = 120_000;
/** Fristen-Zaehler kurz zwischenspeichern — Dashboard und Wand pollen, die Fristen aendern sich selten. */
const FRISTEN_CACHE_S = 300;
/** Fenster des Fristen-Zaehlers (Tage ab heute, Zuerich) — gleich in Trust one und Trust flow. */
const FRISTEN_TAGE = 30;

/** Basis-Adresse von Trust flow (env TRUST_FLOW_URL kann sie ueberschreiben). */
export const TRUST_FLOW_URL_STANDARD = "https://flow.trust-group.ch";

export type AblageZiel = "trust-one" | "trust-flow";

/** Wohin die Ablage-Aufrufe gehen: env ABLAGE_ZIEL; nur "trust-flow" schaltet um, alles andere = "trust-one". */
export function ablageZiel(): AblageZiel {
  return process.env.ABLAGE_ZIEL?.trim().toLowerCase() === "trust-flow" ? "trust-flow" : "trust-one";
}

const ZIEL_NAME: Record<AblageZiel, string> = { "trust-one": "Trust one", "trust-flow": "Trust flow" };

function basisUrl(ziel: AblageZiel): string {
  const roh = ziel === "trust-flow"
    ? process.env.TRUST_FLOW_URL?.trim() || TRUST_FLOW_URL_STANDARD
    : process.env.TRUST_ONE_URL?.trim() || TRUST_ONE_URL_STANDARD;
  return roh.replace(/\/+$/, "");
}

function token(): string | null {
  return process.env.TRUST_ONE_ABLAGE_TOKEN?.trim() || null;
}

/** Ist die Verbindung zur Trust-one-Ablage eingerichtet (Token gesetzt)? */
export function trustOneAblageBereit(): boolean {
  return token() !== null;
}

// ---------------------------------------------------------------------------
// Fristen
// ---------------------------------------------------------------------------

/** Fristen der Ablage von Zuerich-heute bis +30 Tage. `aktiv` = bestaetigt, `vorschlag` = Vorschlag der lokalen KI,
 *  noch nicht entschieden. Das Dashboard zaehlt beide, der Buero-Bildschirm nur `aktiv`. Gleiche Form fuer beide
 *  Ziele (Trust flow: faellig → aktiv, vorschlaege → vorschlag; offen = alle offenen, hier nicht gebraucht). */
export interface TrustOneFristen {
  aktiv: number;
  vorschlag: number;
}

function anzahl(x: unknown): number | null {
  return typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : null;
}

async function holeFristen(ziel: AblageZiel): Promise<TrustOneFristen> {
  const name = ZIEL_NAME[ziel];
  const t = token();
  if (!t) throw new Error(`Fristen: ${name} ist nicht verbunden (TRUST_ONE_ABLAGE_TOKEN fehlt)`);
  const gemeinsam = { cache: "no-store" as const, signal: AbortSignal.timeout(FRISTEN_TIMEOUT_MS) };
  let res: Response;
  try {
    res = ziel === "trust-flow"
      ? await fetch(`${basisUrl(ziel)}/api/ablage/extern/fristen`, {
          method: "POST",
          headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
          body: JSON.stringify({ firma: FLOW_FIRMA, tage: FRISTEN_TAGE }),
          ...gemeinsam,
        })
      : await fetch(`${basisUrl(ziel)}/api/ablage/extern/fristen?bereich=${TRUST_ONE_ABLAGE_BEREICH}&tage=${FRISTEN_TAGE}`, {
          headers: { Authorization: `Bearer ${t}` },
          ...gemeinsam,
        });
  } catch {
    throw new Error(`Fristen: ${name} ist nicht erreichbar`);
  }
  const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const [aktiv, vorschlag, formOk] = ziel === "trust-flow"
    ? [anzahl(j?.faellig), anzahl(j?.vorschlaege), true]
    : [anzahl(j?.anzahl_aktiv), anzahl(j?.anzahl_vorschlag), j?.success === true];
  if (!res.ok || !formOk || aktiv === null || vorschlag === null) {
    throw new Error(`Fristen: ${name} antwortet nicht wie erwartet (HTTP ${res.status})`);
  }
  return { aktiv, vorschlag };
}

/** Je Ziel eigener Eintrag (das Argument gehoert zum Cache-Schluessel): Umschalten zeigt sofort das neue Ziel. */
const fristenZwischengespeichert = unstable_cache(holeFristen, ["ablage-fristen-30"], { revalidate: FRISTEN_CACHE_S });

/** Fristen-Zaehler der Ablage (Ziel laut ABLAGE_ZIEL), 5 min zwischengespeichert. Wirft bei jedem Fehler (§7: nie
 *  still als 0 anzeigen) — ein Fehler wird nicht zwischengespeichert, der naechste Aufruf fragt neu. */
export function ladeTrustOneFristen(): Promise<TrustOneFristen> {
  return fristenZwischengespeichert(ablageZiel());
}

/** Ziel der Dashboard-Zeile «Fristen in 30 Tagen»: folgt ABLAGE_ZIEL — Trust flow `{TRUST_FLOW_URL}/<firma>/fristen`,
 *  sonst wie bisher die Fristen-Ansicht in Trust one. Server-seitig, weil der Schalter eine Server-Env ist. */
export function ablageFristenLink(): string {
  return ablageZiel() === "trust-flow" ? `${basisUrl("trust-flow")}/${FLOW_FIRMA}/fristen` : TRUST_ONE_FRISTEN_LINK;
}

// ---------------------------------------------------------------------------
// Mail-Eingang
// ---------------------------------------------------------------------------

export interface AblageAnhang {
  bytes: ArrayBuffer;
  name: string;
  mime: string;
  /** Absender der Mail (Resend `from`). */
  absender: string | null;
  betreff: string | null;
  /** Empfangszeit der Mail (ISO), sonst setzt Trust one «jetzt». */
  empfangenAm: string | null;
  /** Resend-Mail-ID — macht die Weiterleitung idempotent (Trust one erkennt denselben Anhang wieder). */
  mailId: string;
}

/** Warum das Ziel einen Anhang endgueltig nicht nimmt: `groesse` (413; Trust one ueber 50 MB, Trust flow ueber 48 MiB),
 *  `typ` (415, Dateityp nicht erlaubt), `ungueltig` (400, Anfrage passt nicht — Bereich, Name …). */
export type AblageAbweisung = "groesse" | "typ" | "ungueltig";

/** `ok` = am Ziel angekommen (auch `doppelt` = war schon da); `abgewiesen` = das Ziel nimmt den Anhang nicht
 *  (Typ, Groesse …) — ein Neuversuch hilft nicht; `fehler` = voruebergehend (nicht erreichbar, nicht eingerichtet,
 *  Speicher-/Serverfehler, Zeit abgelaufen, Rig-Schluessel stimmt nicht) — ein Neuversuch kann helfen. `grund` ist
 *  ohne Inhalt und ohne Geheimnis, nur fuers Protokoll. Gleiche Bedeutung fuer beide Ziele (api/inbound/mail:
 *  `fehler` → Webhook 502, Resend wiederholt; `abgewiesen` → Meldung an die Admins). */
export type AblageWeiterleitung =
  | { status: "ok"; doppelt: boolean }
  | { status: "abgewiesen"; ursache: AblageAbweisung; grund: string }
  | { status: "fehler"; grund: string };

type AblageFehlschlag = Exclude<AblageWeiterleitung, { status: "ok" }>;

/** HTTP-Status → endgueltige Abweisung (beide Ziele); alles andere (401, 503, 502, 409 …) ist voruebergehend. 401
 *  bewusst fehler: ein falscher Token darf keinen Anhang endgueltig verlieren — Resend wiederholt, nach der Korrektur
 *  kommt er an. */
const ABWEISUNG: Record<number, AblageAbweisung> = { 400: "ungueltig", 413: "groesse", 415: "typ" };

/** Groesste Anhang-Datei (Klartext) je Ziel: Trust one 50 MB, Trust flow 48 MiB (darueber 413). */
const MAX_GROESSE: Record<AblageZiel, number> = { "trust-one": 50 * 1024 * 1024, "trust-flow": 48 * 1024 * 1024 };

/** Groesste Anhang-Datei fuer das aktuelle Ziel (ABLAGE_ZIEL) — api/inbound/mail prueft damit vor dem Weiterleiten. */
export function ablageMaxGroesse(): number {
  return MAX_GROESSE[ablageZiel()];
}

/** Anzeigename des aktuellen Ziels («Trust one» | «Trust flow») fuer Meldungen an die Admins. */
export function ablageZielName(): string {
  return ZIEL_NAME[ablageZiel()];
}

/** Restzeit bis `frist` (Epoch-ms), hoechstens `max`. */
function wartezeit(max: number, frist?: number): number {
  return frist === undefined ? max : Math.min(max, frist - Date.now());
}

function netzFehler(e: unknown): { status: "fehler"; grund: string } {
  return { status: "fehler", grund: e instanceof Error && e.name === "TimeoutError" ? "Zeitueberschreitung" : "nicht erreichbar" };
}

/** Ergebnis eines Aufrufs: ok, oder der Fehlschlag mit dem HTTP-Status (`null` = kein HTTP: Netz, Zeit) — der
 *  Trust-flow-Weg entscheidet daran ueber eine Wiederholung (409 neu anmelden, 502 Upload wiederholen). */
type Fehlversuch = { http: number | null; ergebnis: AblageFehlschlag };

/** Ein JSON-Schritt an {ziel}/api/ablage/extern/eingang. Antwort `{ ok: true, … }` → die Felder; sonst eingeordnet
 *  nach ABWEISUNG (abgewiesen, kein Neuversuch), alles andere = fehler. Trust flow: 401 traegt im Grund die Ursache
 *  «zugang» (Token pruefen) fuers Protokoll. */
async function eingangSchritt(
  ziel: AblageZiel,
  t: string,
  body: Record<string, unknown>,
  frist?: number,
): Promise<{ antwort: Record<string, unknown> } | Fehlversuch> {
  const ms = wartezeit(EINGANG_SCHRITT_TIMEOUT_MS, frist);
  if (ms <= 0) return { http: null, ergebnis: { status: "fehler", grund: "Zeit abgelaufen" } };
  let res: Response;
  try {
    res = await fetch(`${basisUrl(ziel)}/api/ablage/extern/eingang`, {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    return { http: null, ergebnis: netzFehler(e) };
  }
  const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok && j?.ok === true) return { antwort: j };
  const schritt = String(body.schritt);
  const meldung = typeof j?.error === "string" ? `: ${j.error.slice(0, 200)}` : "";
  const ursache = ABWEISUNG[res.status];
  const zugang = ziel === "trust-flow" && res.status === 401 ? " (zugang)" : "";
  const grund = `${schritt} HTTP ${res.status}${zugang}${meldung}`;
  return { http: res.status, ergebnis: ursache ? { status: "abgewiesen", ursache, grund } : { status: "fehler", grund } };
}

/** Upload-Adresse aus «anmelden»: absolute http(s)-URL, sonst null. */
function uploadZiel(roh: unknown): URL | null {
  try {
    const u = typeof roh === "string" ? new URL(roh) : null;
    return u && (u.protocol === "https:" || u.protocol === "http:") ? u : null;
  } catch {
    return null;
  }
}

/** PUT der Datei an die signierte Upload-URL (Speicher des Ziels; ohne ERP-Token). 413 = abgewiesen (groesse),
 *  sonst jeder Nicht-2xx = fehler. Den Speicher-Fehlertext nicht weitergeben (kann die Upload-URL enthalten). */
async function hochladen(
  ziel: URL,
  body: ArrayBuffer | Uint8Array<ArrayBuffer>,
  headers: Record<string, string>,
  frist?: number,
): Promise<{ ok: true } | Fehlversuch> {
  const ms = wartezeit(UPLOAD_TIMEOUT_MS, frist);
  if (ms <= 0) return { http: null, ergebnis: { status: "fehler", grund: "Zeit abgelaufen" } };
  let up: Response;
  try {
    up = await fetch(ziel.href, { method: "PUT", headers, body, cache: "no-store", signal: AbortSignal.timeout(ms) });
  } catch (e) {
    return { http: null, ergebnis: netzFehler(e) };
  }
  if (up.ok) return { ok: true };
  await up.body?.cancel().catch(() => undefined);
  if (up.status === 413) return { http: 413, ergebnis: { status: "abgewiesen", ursache: "groesse", grund: "Upload HTTP 413" } };
  return { http: up.status, ergebnis: { status: "fehler", grund: `Upload HTTP ${up.status}` } };
}

/** Leitet einen Mail-Anhang an den Ablage-Eingang des Ziels laut ABLAGE_ZIEL weiter (Trust one bzw. ab dem Umzug
 *  Trust flow) — die Datei geht direkt in den Speicher, nie durch einen Vercel-Body (Grenze ~4,5 MB). `frist`
 *  (Epoch-ms, optional) begrenzt alle Schritte zusammen — danach `fehler` («Zeit abgelaufen»), die Wiederholung von
 *  Resend holt den Anhang nach (idempotent ueber mail_id + Name + Groesse). */
export async function leiteAblageAnhangWeiter(a: AblageAnhang, frist?: number): Promise<AblageWeiterleitung> {
  const t = token();
  if (!t) return { status: "fehler", grund: "TRUST_ONE_ABLAGE_TOKEN fehlt" };
  return ablageZiel() === "trust-flow" ? leiteAnTrustFlow(t, a, frist) : leiteAnTrustOne(t, a, frist);
}

/** Trust one (bis zum Umzug):
 *    1. anmelden  {schritt, bereich, name, mime, groesse, mail_id} → {pfad, upload_url} oder {schon_da}
 *    2. PUT upload_url (Body = Bytes, content-type = mime, x-upsert: false — wie storage-js uploadToSignedUrl)
 *    3. bestaetigen {… , pfad, absender, betreff, empfangen_am} → {id} oder {schon_da} */
async function leiteAnTrustOne(t: string, a: AblageAnhang, frist?: number): Promise<AblageWeiterleitung> {
  const mime = a.mime || "application/octet-stream";
  const kern = {
    bereich: TRUST_ONE_ABLAGE_BEREICH,
    name: a.name,
    mime,
    groesse: a.bytes.byteLength,
    mail_id: a.mailId,
  };

  const anmeldung = await eingangSchritt("trust-one", t, { schritt: "anmelden", ...kern }, frist);
  if (!("antwort" in anmeldung)) return anmeldung.ergebnis;
  if (anmeldung.antwort.schon_da === true) return { status: "ok", doppelt: true };
  const { pfad, upload_url: uploadUrl } = anmeldung.antwort;
  const ziel = uploadZiel(uploadUrl);
  if (typeof pfad !== "string" || !ziel) {
    return { status: "fehler", grund: "anmelden: Antwort ohne pfad/upload_url" };
  }

  const up = await hochladen(ziel, a.bytes, { "content-type": mime, "x-upsert": "false", "cache-control": "max-age=3600" }, frist);
  if (!("ok" in up)) return up.ergebnis;

  const bestaetigung = await eingangSchritt(
    "trust-one",
    t,
    { schritt: "bestaetigen", ...kern, pfad, absender: a.absender, betreff: a.betreff, empfangen_am: a.empfangenAm },
    frist,
  );
  if (!("antwort" in bestaetigung)) return bestaetigung.ergebnis;
  return { status: "ok", doppelt: bestaetigung.antwort.schon_da === true };
}

/** Trust flow (ab dem Umzug, E1; Vertrag _backoffice-uebergabe/12_TFD1_Referenz.md):
 *    0. RIG_ABLAGE_ENC_PUBLIC_KEY fehlt/ungueltig → fehler, nichts geht raus; ueber 48 MiB → abgewiesen wie 413
 *    1. anmelden {schritt, firma, name, mime, groesse (Klartext), mail_id, absender, betreff}
 *       → {auftrag_id, upload_url, rig_schluessel} oder {schon_da} (= ok, doppelt, ohne Upload)
 *    2. rig_schluessel muss exakt RIG_ABLAGE_ENC_PUBLIC_KEY sein (sonst fehler, kein Upload) → TFD1 mit auftrag_id
 *    3. PUT upload_url (Body = Chiffrat der Laenge chiffratLaenge(groesse), content-type application/octet-stream)
 *    4. bestaetigen {schritt, firma, auftrag_id} → {id}
 *  Wiederholungen nach Vertrag: 409 (Auftrag abgelaufen) → einmal neu anmelden; 5xx beim PUT bzw. 502 (Speicher) beim
 *  Bestaetigen → Schritt 3 einmal wiederholen, dann 4. Sonst wie Trust one: 400/413/415 abgewiesen, Rest (auch 401) fehler. */
async function leiteAnTrustFlow(t: string, a: AblageAnhang, frist?: number): Promise<AblageWeiterleitung> {
  const rig = process.env.RIG_ABLAGE_ENC_PUBLIC_KEY?.trim();
  if (!rig) return { status: "fehler", grund: "RIG_ABLAGE_ENC_PUBLIC_KEY fehlt" };
  if (!istRigSchluessel(rig)) return { status: "fehler", grund: "RIG_ABLAGE_ENC_PUBLIC_KEY ungültig (P-256 roh, base64url, 87 Zeichen)" };
  const groesse = a.bytes.byteLength;
  if (groesse > MAX_GROESSE["trust-flow"]) {
    return { status: "abgewiesen", ursache: "groesse", grund: `über 48 MiB (${groesse} Byte), nicht angemeldet` };
  }

  const anmelden = {
    schritt: "anmelden",
    firma: FLOW_FIRMA,
    name: a.name,
    mime: a.mime || "application/octet-stream",
    groesse,
    mail_id: a.mailId,
    absender: a.absender,
    betreff: a.betreff,
  };

  for (let runde = 1; ; runde++) {
    const anmeldung = await eingangSchritt("trust-flow", t, anmelden, frist);
    if (!("antwort" in anmeldung)) {
      if (anmeldung.http === 409 && runde === 1) continue;
      return anmeldung.ergebnis;
    }
    if (anmeldung.antwort.schon_da === true) return { status: "ok", doppelt: true };
    const { auftrag_id: auftragId, upload_url: uploadUrl, rig_schluessel: rigAntwort } = anmeldung.antwort;
    const ziel = uploadZiel(uploadUrl);
    if (typeof auftragId !== "string" || !auftragId || !ziel) {
      return { status: "fehler", grund: "anmelden: Antwort ohne auftrag_id/upload_url" };
    }
    // Schluessel-Pinning: Trust flow (oder wer die Antwort faelscht) darf den Empfaenger nie bestimmen.
    if (rigAntwort !== rig) {
      return { status: "fehler", grund: "Rig-Schlüssel stimmt nicht: anmelden liefert einen anderen als RIG_ABLAGE_ENC_PUBLIC_KEY — kein Upload" };
    }

    let chiffrat: Buffer<ArrayBuffer>;
    try {
      chiffrat = tfd1Verschluesseln(a.bytes, rig, auftragId);
    } catch (e) {
      return { status: "fehler", grund: `verschlüsseln: ${e instanceof Error ? e.message : "unbekannt"}` };
    }
    if (chiffrat.length !== chiffratLaenge(groesse)) return { status: "fehler", grund: "verschlüsseln: Länge stimmt nicht" };

    let neuAnmelden = false;
    for (let upload = 1; !neuAnmelden; upload++) {
      const up = await hochladen(ziel, chiffrat, { "content-type": "application/octet-stream" }, frist);
      if (!("ok" in up)) {
        if (up.http !== null && up.http >= 500 && upload === 1) continue;
        return up.ergebnis;
      }
      const bestaetigung = await eingangSchritt("trust-flow", t, { schritt: "bestaetigen", firma: FLOW_FIRMA, auftrag_id: auftragId }, frist);
      if ("antwort" in bestaetigung) return { status: "ok", doppelt: false };
      if (bestaetigung.http === 502 && upload === 1) continue;
      if (bestaetigung.http === 409 && runde === 1) neuAnmelden = true;
      else return bestaetigung.ergebnis;
    }
  }
}
