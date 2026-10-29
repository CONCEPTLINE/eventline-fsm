// Eingaben der Telefonassistentin «Lena» pruefen (/api/lena/*).
// Jede Pruefung liefert entweder den sauberen Wert oder einen kurzen,
// vorlesbaren Text, warum es nicht geht. Rein, ohne Server-Importe (Tests).

import { TEXT, LENA_MAX_TAGE } from "@/lib/lena/texte";
import { TAG_MS, datumPlusTage, gueltigesDatum, parseZeitpunkt, zurichMitternacht, zurichTeile } from "@/lib/lena/zeit";

export type LenaEndpunkt = "termine-abfragen" | "termin-erstellen" | "todo-erstellen" | "auftrag-notiz";

export type Pruefung<T> = { ok: true; wert: T } | { ok: false; text: string };

/** Groesste Zahl einer int4-Spalte (jobs.job_number) — groessere Zahlen
 *  sprengen die Abfrage («integer out of range»), siehe FSM-Regel §15. */
export const INT4_MAX = 2147483647;

export const TITEL_MAX = 200;
export const BESCHREIBUNG_MAX = 2000;
export const NOTIZ_MAX = 4000;

const JAHR_MS = 366 * TAG_MS;
const TERMIN_MAX_DAUER_MS = 7 * TAG_MS;
const TERMIN_STANDARD_DAUER_MS = 60 * 60_000;

// ─── Auftragsnummer ──────────────────────────────────────────────────────

export type AuftragNr = { art: "nummer"; nummer: number } | { art: "fehlt" } | { art: "unbekannt" };

/** «INT-26292», «int 26 292», 26292 → 26292. Alle Nicht-Ziffern fallen weg.
 *  Ohne Ziffern → fehlt. 0, mehr als 10 Stellen oder > int4 → unbekannt
 *  (wird als «nicht gefunden» beantwortet, ohne Datenbank-Abfrage). */
export function parseAuftragNr(roh: unknown): AuftragNr {
  if (roh === undefined || roh === null) return { art: "fehlt" };
  let ziffern: string;
  if (typeof roh === "number") {
    if (!Number.isSafeInteger(roh) || roh < 0) return { art: "unbekannt" };
    ziffern = String(roh);
  } else if (typeof roh === "string") {
    if (roh.length > 40) return { art: "unbekannt" };
    ziffern = roh.replace(/\D+/g, "");
    if (!ziffern) return { art: "fehlt" };
  } else {
    return { art: "unbekannt" };
  }
  ziffern = ziffern.replace(/^0+/, "");
  if (!ziffern || ziffern.length > 10) return { art: "unbekannt" };
  const n = Number(ziffern);
  if (!Number.isSafeInteger(n) || n < 1 || n > INT4_MAX) return { art: "unbekannt" };
  return { art: "nummer", nummer: n };
}

// ─── Freitext ────────────────────────────────────────────────────────────

export type TextFeld = { art: "ok"; wert: string } | { art: "leer" } | { art: "zu_lang" };

/** Freitext saeubern: Steuerzeichen weg, einzeilig = alle Leerraeume zu
 *  einem Leerzeichen; mehrzeilig = Zeilenumbrueche bleiben (max. eine
 *  Leerzeile). Zahlen werden zu Text, andere Typen gelten als leer. */
export function textFeld(roh: unknown, max: number, mehrzeilig = false): TextFeld {
  let s: string;
  if (typeof roh === "string") s = roh;
  else if (typeof roh === "number" && Number.isFinite(roh)) s = String(roh);
  else return { art: "leer" };
  if (s.length > max * 4) return { art: "zu_lang" }; // grob, vor dem Saeubern
  s = s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
  if (mehrzeilig) {
    s = s
      .split("\n")
      .map((z) => z.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } else {
    s = s.replace(/\s+/g, " ").trim();
  }
  if (!s) return { art: "leer" };
  if (s.length > max) return { art: "zu_lang" };
  return { art: "ok", wert: s };
}

/** Pflicht-Titel (einzeilig, TITEL_MAX). */
export function titelPruefen(roh: unknown): Pruefung<string> {
  const t = textFeld(roh, TITEL_MAX);
  if (t.art === "leer") return { ok: false, text: TEXT.titelFehlt };
  if (t.art === "zu_lang") return { ok: false, text: TEXT.titelZuLang };
  return { ok: true, wert: t.wert };
}

// ─── Zeitraum fuer termine-abfragen ──────────────────────────────────────

/** von/bis lesen. Datum ohne Uhrzeit: von = Tagesbeginn, bis = Tagesende
 *  (inklusiv). bis fehlt → Ende des von-Tages. Laenger als 14 Tage → auf
 *  14 Tage ab von gekuerzt (gekuerzt = true, wird im Text gesagt).
 *  Erlaubt: von hoechstens ein Jahr zurueck, zwei Jahre voraus. */
export function zeitraumPruefen(
  vonRoh: unknown,
  bisRoh: unknown,
  jetztMs: number,
): Pruefung<{ vonMs: number; bisExklMs: number; gekuerzt: boolean }> {
  if (vonRoh === undefined || vonRoh === null || vonRoh === "") return { ok: false, text: TEXT.datumFehlt };
  const von = parseZeitpunkt(vonRoh);
  if (!von) return { ok: false, text: TEXT.datumUnklar };

  let bisExklMs: number;
  if (bisRoh === undefined || bisRoh === null || bisRoh === "") {
    bisExklMs = zurichMitternacht(datumPlusTage(von.datum, 1));
  } else {
    const bis = parseZeitpunkt(bisRoh);
    if (!bis) return { ok: false, text: TEXT.endeUnklar };
    bisExklMs = bis.nurDatum ? zurichMitternacht(datumPlusTage(bis.datum, 1)) : bis.ms;
  }
  if (!(bisExklMs > von.ms)) return { ok: false, text: TEXT.endeVorAnfang };

  const heute = zurichMitternacht(zurichTeile(jetztMs).datum);
  if (von.ms < heute - JAHR_MS || von.ms > jetztMs + 2 * JAHR_MS) return { ok: false, text: TEXT.zeitraumZuWeit };

  const grenze = von.nurDatum
    ? zurichMitternacht(datumPlusTage(von.datum, LENA_MAX_TAGE))
    : von.ms + LENA_MAX_TAGE * TAG_MS;
  const gekuerzt = bisExklMs > grenze;
  return { ok: true, wert: { vonMs: von.ms, bisExklMs: gekuerzt ? grenze : bisExklMs, gekuerzt } };
}

// ─── Zeiten fuer termin-erstellen ────────────────────────────────────────

/** start Pflicht (mit Uhrzeit), nicht vor heute, hoechstens zwei Jahre
 *  voraus. ende optional (Standard: 1 Stunde), muss nach start liegen,
 *  Dauer hoechstens 7 Tage. */
export function terminZeitenPruefen(
  startRoh: unknown,
  endeRoh: unknown,
  jetztMs: number,
): Pruefung<{ startMs: number; endeMs: number }> {
  if (startRoh === undefined || startRoh === null || startRoh === "") return { ok: false, text: TEXT.startFehlt };
  const start = parseZeitpunkt(startRoh);
  if (!start) return { ok: false, text: TEXT.datumUnklar };
  if (start.nurDatum) return { ok: false, text: TEXT.uhrzeitFehlt };

  const heute = zurichMitternacht(zurichTeile(jetztMs).datum);
  if (start.ms < heute) return { ok: false, text: TEXT.terminVergangen };
  if (start.ms > jetztMs + 2 * JAHR_MS) return { ok: false, text: TEXT.terminZuWeit };

  let endeMs: number;
  if (endeRoh === undefined || endeRoh === null || endeRoh === "") {
    endeMs = start.ms + TERMIN_STANDARD_DAUER_MS;
  } else {
    const ende = parseZeitpunkt(endeRoh);
    if (!ende) return { ok: false, text: TEXT.endeUnklar };
    if (ende.nurDatum) return { ok: false, text: TEXT.endeUhrzeitFehlt };
    endeMs = ende.ms;
  }
  if (!(endeMs > start.ms)) return { ok: false, text: TEXT.endeVorAnfang };
  if (endeMs - start.ms > TERMIN_MAX_DAUER_MS) return { ok: false, text: TEXT.terminZuLang };
  return { ok: true, wert: { startMs: start.ms, endeMs } };
}

// ─── Felder fuer todo-erstellen ──────────────────────────────────────────

/** faellig_am optional, genau YYYY-MM-DD, nicht vor heute, hoechstens zwei
 *  Jahre voraus. Liefert das Datum (fuer todos.due_date) und den Beginn des
 *  Tages (fuer den Antworttext). */
export function faelligPruefen(roh: unknown, jetztMs: number): Pruefung<{ datum: string; ms: number } | null> {
  if (roh === undefined || roh === null || roh === "") return { ok: true, wert: null };
  if (typeof roh !== "string") return { ok: false, text: TEXT.faelligUnklar };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(roh.trim());
  if (!m || !gueltigesDatum(Number(m[1]), Number(m[2]), Number(m[3]))) return { ok: false, text: TEXT.faelligUnklar };
  const datum = `${m[1]}-${m[2]}-${m[3]}`;
  const heute = zurichTeile(jetztMs).datum;
  if (datum < heute) return { ok: false, text: TEXT.faelligVergangen };
  if (datum > datumPlusTage(heute, 731)) return { ok: false, text: TEXT.faelligZuWeit };
  return { ok: true, wert: { datum, ms: zurichMitternacht(datum) } };
}

/** prioritaet optional: «normal» (Standard) oder «dringend». */
export function prioritaetPruefen(roh: unknown): Pruefung<"normal" | "dringend"> {
  if (roh === undefined || roh === null || roh === "") return { ok: true, wert: "normal" };
  if (typeof roh !== "string") return { ok: false, text: TEXT.prioritaetUnklar };
  const p = roh.trim().toLowerCase();
  if (p === "normal" || p === "dringend") return { ok: true, wert: p };
  return { ok: false, text: TEXT.prioritaetUnklar };
}

// ─── Protokoll: nur das Noetigste speichern ──────────────────────────────

function kurz(roh: unknown, max: number): string | null {
  if (typeof roh === "string") return roh.slice(0, max);
  if (typeof roh === "number" && Number.isFinite(roh)) return String(roh).slice(0, max);
  return null;
}

function laenge(roh: unknown): number | null {
  return typeof roh === "string" ? roh.length : null;
}

/** Was von einer Anfrage ins Protokoll (lena_protokoll.eingabe) geht:
 *  Titel gekuerzt, Beschreibung und Notiztext nur als Laenge. */
export function protokollEingabe(endpunkt: LenaEndpunkt, body: Record<string, unknown>): Record<string, unknown> {
  switch (endpunkt) {
    case "termine-abfragen":
      return { von: kurz(body.von, 40), bis: kurz(body.bis, 40) };
    case "termin-erstellen":
      return {
        titel: kurz(body.titel, 40),
        titel_laenge: laenge(body.titel),
        start: kurz(body.start, 40),
        ende: kurz(body.ende, 40),
        auftrag_nr: kurz(body.auftrag_nr, 20),
      };
    case "todo-erstellen":
      return {
        titel: kurz(body.titel, 40),
        titel_laenge: laenge(body.titel),
        faellig_am: kurz(body.faellig_am, 20),
        prioritaet: kurz(body.prioritaet, 20),
        beschreibung_laenge: laenge(body.beschreibung),
      };
    case "auftrag-notiz":
      return { auftrag_nr: kurz(body.auftrag_nr, 20), text_laenge: laenge(body.text) };
  }
}
