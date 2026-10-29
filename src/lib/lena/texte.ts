// Vorlesbare Antworttexte der Telefonassistentin «Lena» (/api/lena/*).
// Kurz, Deutsch (Schweizer Schreibung, kein ß), ohne interne Details.
// Rein, ohne Server-Importe (Unit-Tests).

import { formatJobNumber } from "@/lib/nummern-format";
import { formatTag } from "@/lib/lena/zeit";

export const LENA_MAX_TERMINE = 10;
export const LENA_MAX_TAGE = 14;

/** Feste Meldungen. Nach aussen nie Fehlercodes, Tabellen oder Feldnamen. */
export const TEXT = {
  nichtEingerichtet: "Lena ist im System noch nicht eingerichtet.",
  nichtBerechtigt: "Dieser Zugriff ist nicht erlaubt.",
  nurPost: "Diese Adresse nimmt nur POST an.",
  ungueltigeAnfrage: "Die Anfrage war ungültig.",
  zuGross: "Die Anfrage ist zu gross.",
  fehler: "Das hat leider nicht geklappt. Bitte versuch es später nochmals.",

  datumFehlt: "Bitte nenne mir ein Datum.",
  datumUnklar: "Das Datum habe ich nicht verstanden.",
  endeUnklar: "Das Ende habe ich nicht verstanden.",
  endeVorAnfang: "Das Ende muss nach dem Anfang liegen.",
  zeitraumZuWeit: "So weit kann ich nicht nachschauen — höchstens ein Jahr zurück und zwei Jahre voraus.",

  startFehlt: "Bitte nenne mir Datum und Uhrzeit des Termins.",
  uhrzeitFehlt: "Bitte nenne mir auch die Uhrzeit.",
  endeUhrzeitFehlt: "Bitte nenne mir auch die Uhrzeit für das Ende.",
  terminVergangen: "Der Termin liegt in der Vergangenheit. Bitte prüf das Datum.",
  terminZuWeit: "Der Termin liegt mehr als zwei Jahre in der Zukunft. Bitte prüf das Datum.",
  terminZuLang: "Der Termin wäre länger als sieben Tage. Bitte prüf Anfang und Ende.",

  titelFehlt: "Bitte nenne mir einen Titel.",
  titelZuLang: "Der Titel ist zu lang. Bitte fass ihn kürzer.",
  beschreibungZuLang: "Die Beschreibung ist zu lang. Bitte fass sie kürzer.",
  faelligUnklar: "Das Fälligkeitsdatum habe ich nicht verstanden.",
  faelligVergangen: "Das Fälligkeitsdatum liegt in der Vergangenheit.",
  faelligZuWeit: "Das Fälligkeitsdatum liegt mehr als zwei Jahre in der Zukunft.",
  prioritaetUnklar: "Die Priorität ist entweder normal oder dringend.",

  auftragNrFehlt: "Bitte nenne mir die Auftragsnummer.",
  notizFehlt: "Bitte sag mir, was ich notieren soll.",
  notizZuLang: "Die Notiz ist zu lang. Bitte fass sie kürzer.",
} as const;

/** Freitext aus der DB fuer die Sprachausgabe: eine Zeile, gekappt. */
export function vorlesbar(text: string | null | undefined, max = 100): string {
  const s = (text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Satzende: Punkt anhaengen, ausser der Text endet schon mit einem
 *  (z.B. «Fr 30.10.») — sonst laese Lena «30.10..». */
export function satz(s: string): string {
  return /[.!?…]$/.test(s) ? s : `${s}.`;
}

export function auftragNichtGefundenText(nummer: number | null): string {
  return nummer === null
    ? "Einen Auftrag mit dieser Nummer habe ich nicht gefunden."
    : `Ich habe keinen Auftrag ${formatJobNumber(nummer)} gefunden.`;
}

export function auftragArchiviertText(nummer: number): string {
  return `Der Auftrag ${formatJobNumber(nummer)} ist archiviert, also abgeschlossen oder storniert. Dort kann ich nichts mehr eintragen.`;
}

export type TerminZeile = { zeit: string; titel: string };

/** Vorlesbare Liste der Termine im Zeitraum [vonMs, bisExklMs). */
export function termineText(opts: {
  termine: TerminZeile[];
  mehr: boolean;
  vonMs: number;
  bisExklMs: number;
  gekuerzt: boolean;
  jetztMs: number;
}): string {
  const { termine, mehr, vonMs, bisExklMs, gekuerzt, jetztMs } = opts;
  const tagVon = formatTag(vonMs, jetztMs);
  const tagBis = formatTag(bisExklMs - 1, jetztMs);
  const zeitraum = tagVon === tagBis ? `am ${tagVon}` : `vom ${tagVon} bis ${tagBis}`;
  const vorweg = gekuerzt ? `Ich schaue höchstens ${LENA_MAX_TAGE} Tage an, also bis ${satz(tagBis)} ` : "";
  if (termine.length === 0) return `${vorweg}Du hast ${zeitraum} keine Termine.`;
  const liste = termine.map((t) => (t.titel ? `${t.zeit}, ${t.titel}` : t.zeit)).join("; ");
  if (mehr) {
    return satz(`${vorweg}Du hast ${zeitraum} mehr als ${LENA_MAX_TERMINE} Termine. Die ersten ${termine.length}: ${liste}`);
  }
  const anzahl = termine.length === 1 ? "einen Termin" : `${termine.length} Termine`;
  return satz(`${vorweg}Du hast ${zeitraum} ${anzahl}: ${liste}`);
}

export function terminGespeichertText(opts: {
  titel: string;
  zeit: string;
  auftrag?: { nummer: number; titel: string } | null;
  schonVorhanden?: boolean;
}): string {
  const anfang = opts.schonVorhanden ? "Der Termin war schon gespeichert" : "Termin gespeichert";
  const bei = opts.auftrag
    ? `, bei ${formatJobNumber(opts.auftrag.nummer)}${opts.auftrag.titel ? ` «${opts.auftrag.titel}»` : ""}`
    : "";
  return satz(`${anfang}: «${opts.titel}», ${opts.zeit}${bei}`);
}

export function todoGespeichertText(opts: {
  titel: string;
  /** Beginn des Faelligkeitstags (ms) oder null */
  faelligMs?: number | null;
  dringend: boolean;
  schonVorhanden?: boolean;
  jetztMs: number;
}): string {
  const anfang = opts.schonVorhanden ? "Das To-do war schon gespeichert" : "To-do gespeichert";
  const faellig = opts.faelligMs != null ? `, fällig am ${formatTag(opts.faelligMs, opts.jetztMs)}` : "";
  const dringend = opts.dringend ? ", dringend" : "";
  return satz(`${anfang}: «${opts.titel}»${faellig}${dringend}`);
}

export function notizAbgelegtText(opts: { nummer: number; jobTitel: string; schonVorhanden?: boolean }): string {
  const titel = opts.jobTitel ? ` «${opts.jobTitel}»` : "";
  return opts.schonVorhanden
    ? `Die Notiz lag schon bei ${formatJobNumber(opts.nummer)}${titel}.`
    : `Notiz bei ${formatJobNumber(opts.nummer)}${titel} abgelegt.`;
}
