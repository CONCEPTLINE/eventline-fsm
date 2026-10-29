// Server-Rahmen der Telefonassistentin «Lena» (Bland AI → /api/lena/*).
// Nur in Routen unter src/app/api/lena/ importieren.
//
// Ablauf jedes Aufrufs (lenaPost):
//   Token (503 nicht eingerichtet / 401) → Anrufer-Header (403) →
//   LENA_USER_ID (503) → Body (413 / 400) → Profil aktiv (503) → Endpunkt.
// Jeder Aufruf — auch abgelehnte und falsche Methoden (405) — bekommt genau
// eine Zeile in lena_protokoll (Migration 359), mit minimierter Eingabe
// (protokollEingabe) und einem kurzen Ergebnis ohne Inhalte.
//
// Fachliche Antworten (nicht gefunden, archiviert, Datum unklar …) kommen mit
// HTTP 200 und { ok: false, text } — so kann Lena den Text in jedem Fall
// vorlesen. Nicht-2xx nur fuer Protokoll-Fehler (Auth, Methode, kein JSON).
// Nach aussen nie interne Details; Fehler gehen ueber logError ins Log.

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { auftragArchiviert } from "@/lib/archiv";
import { formatJobNumber } from "@/lib/nummern-format";
import { LENA_ANRUFER_HEADER, anruferErlaubt, anruferFuersProtokoll, lenaTokenPruefen } from "@/lib/lena/auth";
import { protokollEingabe, type AuftragNr, type LenaEndpunkt } from "@/lib/lena/eingabe";
import { TEXT, auftragArchiviertText, auftragNichtGefundenText, vorlesbar } from "@/lib/lena/texte";

const BODY_MAX = 16 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KOPF = { "Cache-Control": "no-store" } as const;

/** Doppel-Schutz: Bland wiederholt einen Aufruf, wenn die Antwort zu lange
 *  dauert. Gleicher Eintrag innerhalb dieser Zeit = schon gespeichert. */
export const LENA_DOPPEL_FENSTER_MS = 10 * 60_000;

export type LenaAntwort = { ok: boolean; text: string } & Record<string, unknown>;

export type LenaErgebnis = {
  antwort: LenaAntwort;
  /** Fuers Protokoll: kurz, ohne Inhalte (keine Titel, keine Texte). */
  ergebnis: string;
  status?: number;
};

export type LenaKontext = {
  admin: SupabaseClient;
  /** Profil, in dessen Namen Lena anlegt (env LENA_USER_ID, geprueft aktiv). */
  userId: string;
  body: Record<string, unknown>;
  jetztMs: number;
};

type Eintrag = {
  endpunkt: LenaEndpunkt;
  anrufer: string | null;
  eingabe: Record<string, unknown> | null;
  ergebnis: string;
  ok: boolean;
};

async function protokollieren(admin: SupabaseClient | null, eintrag: Eintrag): Promise<void> {
  try {
    const client = admin ?? createAdminClient();
    const { error } = await client.from("lena_protokoll").insert(eintrag);
    if (error) logError("lena.protokoll", new Error(error.code ?? error.message), { endpunkt: eintrag.endpunkt });
  } catch (e) {
    logError("lena.protokoll", e, { endpunkt: eintrag.endpunkt });
  }
}

function antworten(status: number, antwort: LenaAntwort, extra?: Record<string, string>): NextResponse {
  return NextResponse.json(antwort, { status, headers: { ...KOPF, ...extra } });
}

/** Fachliche Ablehnung mit vorlesbarem Text (HTTP 200, ok:false). */
export function lenaAbgelehnt(text: string, ergebnis: string): LenaErgebnis {
  return { antwort: { ok: false, text }, ergebnis: `abgelehnt: ${ergebnis}` };
}

type Ablauf = { status: number; antwort: LenaAntwort; ergebnis: string };

/** POST-Handler einer Lena-Route: Pruefungen, Protokoll, Fehlerbehandlung. */
export async function lenaPost(
  request: Request,
  endpunkt: LenaEndpunkt,
  handler: (ctx: LenaKontext) => Promise<LenaErgebnis>,
): Promise<NextResponse> {
  const anruferHeader = request.headers.get(LENA_ANRUFER_HEADER);
  const eintrag: Eintrag = {
    endpunkt,
    anrufer: anruferFuersProtokoll(anruferHeader),
    eingabe: null,
    ergebnis: "",
    ok: false,
  };
  let admin: SupabaseClient | null = null;

  const ablauf = async (): Promise<Ablauf> => {
    const token = lenaTokenPruefen(request.headers.get("authorization"), process.env.LENA_TOKEN);
    if (token === null) {
      logError("lena.konfiguration", new Error("LENA_TOKEN fehlt oder ist kuerzer als 32 Zeichen"), { endpunkt });
      return { status: 503, antwort: { ok: false, text: TEXT.nichtEingerichtet }, ergebnis: "503 LENA_TOKEN fehlt" };
    }
    if (!token) return { status: 401, antwort: { ok: false, text: TEXT.nichtBerechtigt }, ergebnis: "401 Token falsch oder fehlt" };
    if (!anruferErlaubt(anruferHeader)) {
      return { status: 403, antwort: { ok: false, text: TEXT.nichtBerechtigt }, ergebnis: "403 Anrufer nicht erlaubt" };
    }

    const userId = process.env.LENA_USER_ID?.trim() ?? "";
    if (!UUID_RE.test(userId)) {
      logError("lena.konfiguration", new Error("LENA_USER_ID fehlt oder ist keine UUID"), { endpunkt });
      return { status: 503, antwort: { ok: false, text: TEXT.nichtEingerichtet }, ergebnis: "503 LENA_USER_ID fehlt" };
    }

    const laenge = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(laenge) && laenge > BODY_MAX) {
      return { status: 413, antwort: { ok: false, text: TEXT.zuGross }, ergebnis: "413 Body zu gross" };
    }
    const roh = await request.text();
    if (Buffer.byteLength(roh, "utf8") > BODY_MAX) {
      return { status: 413, antwort: { ok: false, text: TEXT.zuGross }, ergebnis: "413 Body zu gross" };
    }
    let body: unknown;
    try {
      body = JSON.parse(roh);
    } catch {
      return { status: 400, antwort: { ok: false, text: TEXT.ungueltigeAnfrage }, ergebnis: "400 kein JSON" };
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return { status: 400, antwort: { ok: false, text: TEXT.ungueltigeAnfrage }, ergebnis: "400 kein JSON-Objekt" };
    }
    const felder = body as Record<string, unknown>;
    eintrag.eingabe = protokollEingabe(endpunkt, felder);

    admin = createAdminClient();
    const { data: profil, error: profilFehler } = await admin
      .from("profiles")
      .select("id, is_active")
      .eq("id", userId)
      .maybeSingle();
    if (profilFehler) throw new Error(`profiles: ${profilFehler.code ?? profilFehler.message}`);
    if (!profil || profil.is_active !== true) {
      logError("lena.konfiguration", new Error("Profil aus LENA_USER_ID fehlt oder ist inaktiv"), { endpunkt });
      return { status: 503, antwort: { ok: false, text: TEXT.nichtEingerichtet }, ergebnis: "503 Profil fehlt oder inaktiv" };
    }

    const r = await handler({ admin, userId, body: felder, jetztMs: Date.now() });
    return { status: r.status ?? 200, antwort: r.antwort, ergebnis: r.ergebnis };
  };

  let r: Ablauf;
  try {
    r = await ablauf();
  } catch (e) {
    logError(`lena.${endpunkt}`, e);
    r = { status: 500, antwort: { ok: false, text: TEXT.fehler }, ergebnis: "500 interner Fehler" };
  }
  eintrag.ergebnis = r.ergebnis.slice(0, 200);
  eintrag.ok = r.status === 200 && r.antwort.ok === true;
  await protokollieren(admin, eintrag);
  return antworten(r.status, r.antwort);
}

/** Alle Methoden ausser POST: 405 (mit Protokoll-Zeile). */
export function lenaAndereMethoden(endpunkt: LenaEndpunkt) {
  const nichtErlaubt = async (request: Request): Promise<Response> => {
    await protokollieren(null, {
      endpunkt,
      anrufer: anruferFuersProtokoll(request.headers.get(LENA_ANRUFER_HEADER)),
      eingabe: { methode: request.method.slice(0, 16) },
      ergebnis: "405 Methode nicht erlaubt",
      ok: false,
    });
    if (request.method === "HEAD") return new Response(null, { status: 405, headers: { ...KOPF, Allow: "POST" } });
    return antworten(405, { ok: false, text: TEXT.nurPost }, { Allow: "POST" });
  };
  return { GET: nichtErlaubt, PUT: nichtErlaubt, PATCH: nichtErlaubt, DELETE: nichtErlaubt, HEAD: nichtErlaubt, OPTIONS: nichtErlaubt };
}

export type LenaAuftrag = { id: string; nummer: number; titel: string };

/** Auftrag fuer einen Schreibzugriff suchen. Nach aussen nur «nicht
 *  gefunden», «archiviert» oder Nummer + Titel. Geloeschte Auftraege gelten
 *  als nicht gefunden; archiviert = abgeschlossen/storniert (src/lib/archiv.ts)
 *  oder als Anfrage storniert. Die DB-Sperre (Migration 342) greift fuer die
 *  Service-Rolle NICHT — deshalb prueft diese Funktion selbst. */
export async function lenaAuftragZumSchreiben(
  admin: SupabaseClient,
  nr: AuftragNr,
): Promise<{ ok: true; auftrag: LenaAuftrag } | { ok: false; ergebnis: LenaErgebnis }> {
  if (nr.art === "fehlt") return { ok: false, ergebnis: lenaAbgelehnt(TEXT.auftragNrFehlt, "Auftragsnummer fehlt") };
  if (nr.art === "unbekannt") {
    return { ok: false, ergebnis: lenaAbgelehnt(auftragNichtGefundenText(null), "Auftragsnummer ungueltig") };
  }
  const { data, error } = await admin
    .from("jobs")
    .select("id, title, status, job_number, is_deleted, cancelled_as_anfrage")
    .eq("job_number", nr.nummer)
    .maybeSingle();
  if (error) throw new Error(`jobs: ${error.code ?? error.message}`);
  const job = data as {
    id: string;
    title: string | null;
    status: string | null;
    job_number: number;
    is_deleted: boolean | null;
    cancelled_as_anfrage: boolean | null;
  } | null;
  const label = formatJobNumber(nr.nummer);
  if (!job || job.is_deleted === true) {
    return { ok: false, ergebnis: lenaAbgelehnt(auftragNichtGefundenText(nr.nummer), `${label} nicht gefunden`) };
  }
  if (auftragArchiviert(job.status) || job.cancelled_as_anfrage === true) {
    return { ok: false, ergebnis: lenaAbgelehnt(auftragArchiviertText(nr.nummer), `${label} archiviert`) };
  }
  return { ok: true, auftrag: { id: job.id, nummer: nr.nummer, titel: vorlesbar(job.title, 80) } };
}
