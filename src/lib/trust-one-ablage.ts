import "server-only";
import { unstable_cache } from "next/cache";
import { TRUST_ONE_ABLAGE_BEREICH, TRUST_ONE_URL_STANDARD } from "@/lib/trust-one";

// Fremd-API der Ablage in Trust one (Trust one: src/app/api/ablage/extern/*). Die Ablage der EVENTLINE GmbH lebt seit
// 24.10.2026 dort; das ERP liefert nur noch Mail-Anhaenge an und liest die Fristen-Zaehler.
//   leiteAblageAnhangWeiter()  POST {TRUST_ONE_URL}/api/ablage/extern/eingang   (Resend-Webhook ablage@…), zweistufig:
//                              anmelden → PUT der Bytes an die signierte Upload-URL (Trust-one-Speicher) → bestaetigen
//   ladeTrustOneFristen()      GET  {TRUST_ONE_URL}/api/ablage/extern/fristen   (Dashboard, Buero-Bildschirm)
// Anmeldung: Bearer TRUST_ONE_ABLAGE_TOKEN (= ABLAGE_EXTERN_TOKEN in Trust one). TRUST_ONE_URL ist optional
// (Standard https://one.trust-group.ch). Werte nie loggen. Die Speicher-Adresse kommt absolut aus der Antwort von
// «anmelden» (Token steckt in der URL) — das ERP kennt keinen Schluessel des Trust-one-Speichers.

/** Wartezeit auf die Fristen (Dashboard und Wand warten darauf). */
const FRISTEN_TIMEOUT_MS = 8_000;
/** Wartezeit auf «anmelden» bzw. «bestaetigen» (nur JSON, die Trust-one-Route hat maxDuration 30). */
const EINGANG_SCHRITT_TIMEOUT_MS = 20_000;
/** Wartezeit auf den Upload in den Speicher (bis 50 MB). */
const UPLOAD_TIMEOUT_MS = 120_000;
/** Fristen-Zaehler kurz zwischenspeichern — Dashboard und Wand pollen, die Fristen aendern sich selten. */
const FRISTEN_CACHE_S = 300;

function basisUrl(): string {
  return (process.env.TRUST_ONE_URL?.trim() || TRUST_ONE_URL_STANDARD).replace(/\/+$/, "");
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
 *  noch nicht entschieden. Das Dashboard zaehlt beide, der Buero-Bildschirm nur `aktiv`. */
export interface TrustOneFristen {
  aktiv: number;
  vorschlag: number;
}

function anzahl(x: unknown): number | null {
  return typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : null;
}

async function holeFristen(): Promise<TrustOneFristen> {
  const t = token();
  if (!t) throw new Error("Fristen: Trust one ist nicht verbunden (TRUST_ONE_ABLAGE_TOKEN fehlt)");
  let res: Response;
  try {
    res = await fetch(`${basisUrl()}/api/ablage/extern/fristen?bereich=${TRUST_ONE_ABLAGE_BEREICH}&tage=30`, {
      headers: { Authorization: `Bearer ${t}` },
      cache: "no-store",
      signal: AbortSignal.timeout(FRISTEN_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Fristen: Trust one ist nicht erreichbar");
  }
  const j = (await res.json().catch(() => null)) as { success?: unknown; anzahl_aktiv?: unknown; anzahl_vorschlag?: unknown } | null;
  const aktiv = anzahl(j?.anzahl_aktiv);
  const vorschlag = anzahl(j?.anzahl_vorschlag);
  if (!res.ok || j?.success !== true || aktiv === null || vorschlag === null) {
    throw new Error(`Fristen: Trust one antwortet nicht wie erwartet (HTTP ${res.status})`);
  }
  return { aktiv, vorschlag };
}

/** Fristen-Zaehler aus Trust one, 5 min zwischengespeichert. Wirft bei jedem Fehler (§7: nie still als 0 anzeigen) —
 *  ein Fehler wird nicht zwischengespeichert, der naechste Aufruf fragt neu. */
export const ladeTrustOneFristen = unstable_cache(holeFristen, ["trust-one-ablage-fristen-30"], { revalidate: FRISTEN_CACHE_S });

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

/** Warum Trust one einen Anhang endgueltig nicht nimmt: `groesse` (413, ueber 50 MB), `typ` (415, Dateityp nicht
 *  erlaubt), `ungueltig` (400, Anfrage passt nicht — Bereich, Name …). */
export type AblageAbweisung = "groesse" | "typ" | "ungueltig";

/** `ok` = in Trust one angekommen (auch `doppelt` = war schon da); `abgewiesen` = Trust one nimmt den Anhang nicht
 *  (Typ, Groesse) — ein Neuversuch hilft nicht; `fehler` = voruebergehend (nicht erreichbar, nicht eingerichtet,
 *  Speicher-/Serverfehler, Zeit abgelaufen) — ein Neuversuch kann helfen. `grund` ist ohne Inhalt und ohne Geheimnis,
 *  nur fuers Protokoll. */
export type AblageWeiterleitung =
  | { status: "ok"; doppelt: boolean }
  | { status: "abgewiesen"; ursache: AblageAbweisung; grund: string }
  | { status: "fehler"; grund: string };

const ABWEISUNG: Record<number, AblageAbweisung> = { 400: "ungueltig", 413: "groesse", 415: "typ" };

/** Restzeit bis `frist` (Epoch-ms), hoechstens `max`. */
function wartezeit(max: number, frist?: number): number {
  return frist === undefined ? max : Math.min(max, frist - Date.now());
}

function netzFehler(e: unknown): { status: "fehler"; grund: string } {
  return { status: "fehler", grund: e instanceof Error && e.name === "TimeoutError" ? "Zeitueberschreitung" : "nicht erreichbar" };
}

/** Ein JSON-Schritt an /api/ablage/extern/eingang. Antwort `{ ok: true, … }` → die Felder; sonst eingeordnet:
 *  400/413/415 = abgewiesen (kein Neuversuch), alles andere (401/503 Token, 502 Speicher, Netz) = fehler. */
async function eingangSchritt(
  t: string,
  body: Record<string, unknown>,
  frist?: number,
): Promise<{ antwort: Record<string, unknown> } | Exclude<AblageWeiterleitung, { status: "ok" }>> {
  const ms = wartezeit(EINGANG_SCHRITT_TIMEOUT_MS, frist);
  if (ms <= 0) return { status: "fehler", grund: "Zeit abgelaufen" };
  let res: Response;
  try {
    res = await fetch(`${basisUrl()}/api/ablage/extern/eingang`, {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    return netzFehler(e);
  }
  const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok && j?.ok === true) return { antwort: j };
  const schritt = String(body.schritt);
  const meldung = typeof j?.error === "string" ? `: ${j.error.slice(0, 200)}` : "";
  const ursache = ABWEISUNG[res.status];
  if (ursache) return { status: "abgewiesen", ursache, grund: `${schritt} HTTP ${res.status}${meldung}` };
  return { status: "fehler", grund: `${schritt} HTTP ${res.status}${meldung}` };
}

/** Leitet einen Mail-Anhang an den Ablage-Eingang in Trust one weiter — die Datei geht direkt in den Speicher, nie
 *  durch einen Vercel-Body (Grenze ~4,5 MB):
 *    1. anmelden  {schritt, bereich, name, mime, groesse, mail_id} → {pfad, upload_url} oder {schon_da}
 *    2. PUT upload_url (Body = Bytes, content-type = mime, x-upsert: false — wie storage-js uploadToSignedUrl)
 *    3. bestaetigen {… , pfad, absender, betreff, empfangen_am} → {id} oder {schon_da}
 *  `frist` (Epoch-ms, optional) begrenzt alle drei Schritte zusammen — danach `fehler` («Zeit abgelaufen»), die
 *  Wiederholung von Resend holt den Anhang nach (idempotent ueber mail_id + Name + Groesse). */
export async function leiteAblageAnhangWeiter(a: AblageAnhang, frist?: number): Promise<AblageWeiterleitung> {
  const t = token();
  if (!t) return { status: "fehler", grund: "TRUST_ONE_ABLAGE_TOKEN fehlt" };

  const mime = a.mime || "application/octet-stream";
  const kern = {
    bereich: TRUST_ONE_ABLAGE_BEREICH,
    name: a.name,
    mime,
    groesse: a.bytes.byteLength,
    mail_id: a.mailId,
  };

  const anmeldung = await eingangSchritt(t, { schritt: "anmelden", ...kern }, frist);
  if (!("antwort" in anmeldung)) return anmeldung;
  if (anmeldung.antwort.schon_da === true) return { status: "ok", doppelt: true };
  const { pfad, upload_url: uploadUrl } = anmeldung.antwort;
  let ziel: URL | null = null;
  try {
    ziel = typeof uploadUrl === "string" ? new URL(uploadUrl) : null;
  } catch {
    ziel = null;
  }
  if (typeof pfad !== "string" || !ziel || (ziel.protocol !== "https:" && ziel.protocol !== "http:")) {
    return { status: "fehler", grund: "anmelden: Antwort ohne pfad/upload_url" };
  }

  const ms = wartezeit(UPLOAD_TIMEOUT_MS, frist);
  if (ms <= 0) return { status: "fehler", grund: "Zeit abgelaufen" };
  let up: Response;
  try {
    up = await fetch(ziel.href, {
      method: "PUT",
      headers: { "content-type": mime, "x-upsert": "false", "cache-control": "max-age=3600" },
      body: a.bytes,
      cache: "no-store",
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    return netzFehler(e);
  }
  if (!up.ok) {
    // Den Speicher-Fehlertext nicht weitergeben (kann die Upload-URL enthalten) — nur der Status zaehlt.
    await up.body?.cancel().catch(() => undefined);
    if (up.status === 413) return { status: "abgewiesen", ursache: "groesse", grund: "Upload HTTP 413" };
    return { status: "fehler", grund: `Upload HTTP ${up.status}` };
  }

  const bestaetigung = await eingangSchritt(
    t,
    { schritt: "bestaetigen", ...kern, pfad, absender: a.absender, betreff: a.betreff, empfangen_am: a.empfangenAm },
    frist,
  );
  if (!("antwort" in bestaetigung)) return bestaetigung;
  return { status: "ok", doppelt: bestaetigung.antwort.schon_da === true };
}
