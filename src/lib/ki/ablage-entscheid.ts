// V8 «Ablage-Entscheid durch Claude» (docs/lokale-ki/SPEC.md 3.1 + §7 V8).
//
// Idee (Mischa 2026-10-11): Die lokale KI im Buero liest das Dokument und
// erzeugt eine praezise, MINIMIERTE Einordnung (was ist das, Dokumentart,
// Betreff, Partei, Bezug, Jahr). Claude bekommt NUR diese Einordnung plus
// die Ordnerliste und die Kandidaten des Rigs — und entscheidet den
// Zielordner. Dokumentinhalte verlassen das Haus nie.
//
// Ablauf in POST /api/ki/sync (Bereinigung ablage_analyse), hier gebuendelt:
//   (1) regel_ordner gueltig  -> ordner = regel_ordner, Quelle «regel»,
//       Alternativen aus den Kandidaten, KEIN Claude-Aufruf.
//   (2) Einordnung vorhanden + ANTHROPIC_API_KEY -> Minimierung im FSM
//       nochmals erzwingen; personenbezogen (Flag des Rigs, erkannte Person,
//       Bezug «person» oder ein Typ aus KI_PERSON_TYPEN) -> kein Claude-
//       Aufruf, Quelle «lokal»; Restbudget der Route zu knapp -> ebenso.
//       Sonst structuredCall (strict-Tool) mit dem Ordnerbaum OHNE
//       Personalakten -> Quelle «claude». Ohne Treffer: ordner null,
//       Sicherheit «niedrig», die Wahl des lokalen Modells als erste
//       Alternative.
//   (3) Claude-Fehler/Zeitueberschreitung -> lokales Ergebnis, Quelle
//       «lokal», Fehler per logError — der Auftrag scheitert nie.
//   (4) Datenschutz: einordnung/kandidaten werden nicht persistiert, in Logs
//       stehen nur Kennzahlen.
//
// Alles ausser `entscheideOrdner` ist rein (testbar ohne Netz); der
// Claude-Aufruf ist injizierbar.

import { dokTyp } from "@/lib/ablage-doktypen";
import { aiAvailable, structuredCall } from "@/lib/ai/anthropic";
import { logError } from "@/lib/log";
import {
  KI_EINORDNUNG_WAS_MAX,
  KI_ENTSCHEID_BEGRUENDUNG_MAX,
  KI_ENTSCHEID_MAX_ALTERNATIVEN,
  KI_ENTSCHEID_MAX_KANDIDATEN,
  KI_ENTSCHEID_MIN_REST_MS,
  KI_ENTSCHEID_TIMEOUT_MS,
  KI_PERSON_TYPEN,
} from "@/lib/ki/konstanten";
import type {
  AblageAnalyseErgebnis,
  AblageAnalyseKontext,
  AblageEinordnung,
  AblageKandidat,
  EinordnungBezugArt,
  OrdnerSicherheit,
} from "@/lib/ki/typen";

export const PLATZHALTER = "[…]";
export const MITARBEITER_PLATZHALTER = "[Mitarbeiter/in]";

const BEZUG_ARTEN: readonly EinordnungBezugArt[] = ["location", "projekt", "kunde", "partner", "firma", "person"];
const SICHERHEITEN: readonly OrdnerSicherheit[] = ["hoch", "mittel", "niedrig"];
/** Sprachkennung wie «de», «fr», «de-CH», «gsw» — alles andere wird null. */
const RE_SPRACHE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

// ── Minimierung ─────────────────────────────────────────────────────────
// Das Rig minimiert bereits; das FSM erzwingt es nochmals, weil nur hier
// die Grenze zum Internet liegt. Reihenfolge: Kontakte und Kennungen vor
// Betraegen vor nackten langen Zahlen (sonst zerlegt die Zahlen-Regel
// eine IBAN in Reste, die nicht mehr erkannt werden).

/** E-Mail-Adressen. */
const RE_EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
/** IBAN: CH93 0076 2011 6238 5295 7 — mit oder ohne Leerzeichen. */
const RE_IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b/g;
/** AHV-Nummer 756.1234.5678.97 (auch mit Leerzeichen oder kompakt). */
const RE_AHV = /\b756[.\s]?\d{4}[.\s]?\d{4}[.\s]?\d{2}\b/g;
/** Telefon international: +41 61 123 45 67, 0041 61 …, +41 (0)61 …. */
const RE_TEL_INT = /(?:\+|\b00)\d{2,3}[\s\-/.]?(?:\(0\)[\s\-/.]?)?\d(?:[\s\-/.]?\d){6,11}\b/g;
/** Telefon Schweiz national: 061 123 45 67, 061/123 45 67, 0611234567. */
const RE_TEL_CH = /\b0\d{2}[\s\-/.]?\d{3}[\s\-/.]?\d{2}[\s\-/.]?\d{2}\b/g;
/** Zahl mit Schweizer Tausender-/Dezimaltrennern: Apostroph/Hochkomma oder
 *  ein Leerzeichen (nur vor genau drei Ziffern: 1 200.50) als Tausender-
 *  trenner, Punkt/Komma nur zwischen Ziffern (ein Satzzeichen danach bleibt
 *  stehen) und optionalem «.–»/«.-». */
const ZAHL = String.raw`\d(?:[\d'’]|[.,](?=\d)|\s(?=\d{3}(?!\d)))*(?:\.?\s?[-–])?`;
/** Waehrung vor der Zahl: CHF, EUR, Fr./Fr, sFr./SFr, Rp./Rp, €. */
const WAEHRUNG_VOR = String.raw`(?:CHF|EUR|s?Fr\.?|Rp\.?|€)`;
/** Waehrung nach der Zahl: dazu ausgeschrieben Franken, Euro, Rappen. */
const WAEHRUNG_NACH = String.raw`(?:CHF|EUR|s?Fr\.?|Rp\.?|Franken|Euro|Rappen|€)`;
/** Betrag mit Waehrung davor: CHF 1'234.50 · Fr 50.– · sFr. 1 200 · EUR 200 · € 30. */
const RE_BETRAG_VOR = new RegExp(String.raw`(?<!\p{L})${WAEHRUNG_VOR}\s?-?${ZAHL}`, "giu");
/** Betrag mit Waehrung danach: 1'234.50 CHF · 200.- Fr · 3 Franken · 20 Euro · 5 Rp. */
const RE_BETRAG_NACH = new RegExp(String.raw`${ZAHL}\s?${WAEHRUNG_NACH}(?!\p{L})`, "giu");
/** Zahlen mit Apostroph-Tausendertrenner — immer, auch ohne Waehrung
 *  (5'500, 1'250.00, 1'234'567, 2'000.–) — und nackte 6+-stellige Zahlen. */
const RE_LANGE_ZAHL = /\b\d{1,3}(?:['’]\d{3})+(?!\d)(?:[.,]\d+)?(?:\.?\s?[-–])?|\d{6,}/g;
/** Mehrere Platzhalter hintereinander (auch durch Satzzeichen getrennt). */
const RE_PLATZHALTER_DOPPELT = /\[…\](?:\s*[,;:/–-]?\s*\[…\])+/g;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Voller Name als Wortgrenzen-Regex, Gross/Klein egal, in jeder Rotation
 *  der Teile: «Vorname Nachname», «Nachname Vorname», «Nachname, Vorname»;
 *  bei drei und mehr Teilen auch «Nachname1 Nachname2(,) Vorname» usw. —
 *  der nach vorn gezogene Block darf mit Komma enden. */
function nameRegex(name: string): RegExp | null {
  const teile = name.normalize("NFC").split(/\s+/).filter(Boolean).map(escapeRegex);
  if (teile.length === 0 || name.trim().length < 3) return null;
  const varianten = [teile.join("\\s+")];
  for (let k = 1; k < teile.length; k++) {
    varianten.push(`${teile.slice(k).join("\\s+")},?\\s+${teile.slice(0, k).join("\\s+")}`);
  }
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${varianten.join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

/** Freitext minimieren: Beträge, Zahlen mit Tausendertrenner, IBAN, AHV-
 *  Nummern, E-Mail-Adressen, Telefonnummern und 6+-stellige Zahlen ->
 *  «[…]»; volle Namen aus `namen` (alle Profile, auch inaktive) ->
 *  «[Mitarbeiter/in]». */
export function minimiereText(text: string, namen: readonly string[]): string {
  let t = text.normalize("NFC");
  t = t.replace(RE_EMAIL, PLATZHALTER);
  t = t.replace(RE_IBAN, PLATZHALTER);
  t = t.replace(RE_AHV, PLATZHALTER);
  t = t.replace(RE_TEL_INT, PLATZHALTER);
  t = t.replace(RE_TEL_CH, PLATZHALTER);
  t = t.replace(RE_BETRAG_VOR, PLATZHALTER);
  t = t.replace(RE_BETRAG_NACH, PLATZHALTER);
  t = t.replace(RE_LANGE_ZAHL, PLATZHALTER);
  for (const name of namen) {
    const re = nameRegex(name);
    if (re) t = t.replace(re, MITARBEITER_PLATZHALTER);
  }
  t = t.replace(RE_PLATZHALTER_DOPPELT, PLATZHALTER);
  return t.replace(/\s+/g, " ").trim();
}

/** Alle Freitext-Felder der Einordnung minimieren (typ/jahr/sprache/seiten
 *  sind keine Freitexte — typ und sprache sind bereits auf Kennungen
 *  beschraenkt, s. leseEinordnung). */
export function minimiereEinordnung(e: AblageEinordnung, namen: readonly string[]): AblageEinordnung {
  const m = (s: string | null) => (s === null ? null : minimiereText(s, namen) || null);
  return {
    ...e,
    was: minimiereText(e.was, namen),
    betreff: minimiereText(e.betreff, namen),
    partei: m(e.partei),
    bezug: { art: e.bezug.art, name: m(e.bezug.name) },
  };
}

// ── Lesen der Rig-Felder ────────────────────────────────────────────────

/** `einordnung` aus dem Rig-Ergebnis — Felder getrimmt und gekappt; ohne
 *  `was` gibt es nichts einzuordnen (null). `typ` nur als DOK_TYPEN-Key
 *  (sonst leer), `sprache` nur als Sprachkennung (sonst null) — beides
 *  geht ungeprueft Richtung Claude und darf kein Freitext sein.
 *  `personenbezogen` gilt als true, wenn es kein Boolean ist (im Zweifel
 *  nichts hinausschicken). */
export function leseEinordnung(roh: unknown): AblageEinordnung | null {
  if (!roh || typeof roh !== "object" || Array.isArray(roh)) return null;
  const r = roh as Record<string, unknown>;
  const text = (k: string, max: number) => (typeof r[k] === "string" ? (r[k] as string).trim().slice(0, max) : "");
  const was = text("was", KI_EINORDNUNG_WAS_MAX);
  if (!was) return null;

  const bezugRoh = r.bezug && typeof r.bezug === "object" && !Array.isArray(r.bezug) ? (r.bezug as Record<string, unknown>) : {};
  const artRoh = typeof bezugRoh.art === "string" ? bezugRoh.art.trim() : "";
  const art = (BEZUG_ARTEN as readonly string[]).includes(artRoh) ? (artRoh as EinordnungBezugArt) : null;
  const bezugName = typeof bezugRoh.name === "string" ? bezugRoh.name.trim().slice(0, 120) : "";

  let jahr: string | null = null;
  if (typeof r.jahr === "string" && /^\d{4}$/.test(r.jahr.trim())) jahr = r.jahr.trim();
  else if (typeof r.jahr === "number" && Number.isInteger(r.jahr) && r.jahr >= 1900 && r.jahr <= 2200) jahr = String(r.jahr);

  const typ = text("typ", 40);
  const sprache = text("sprache", 10);
  const seiten = Number(r.seiten);
  return {
    was,
    typ: dokTyp(typ) ? typ : "",
    betreff: text("betreff", 120),
    partei: text("partei", 120) || null,
    bezug: { art, name: bezugName || null },
    jahr,
    personenbezogen: typeof r.personenbezogen === "boolean" ? r.personenbezogen : true,
    sprache: RE_SPRACHE.test(sprache) ? sprache : null,
    seiten: Number.isInteger(seiten) && seiten > 0 ? seiten : null,
  };
}

/** `kandidaten` aus dem Rig-Ergebnis: nur Pfade aus der aktiven Liste, ohne
 *  Doppel, Reihenfolge des Rigs, hoechstens KI_ENTSCHEID_MAX_KANDIDATEN. */
export function leseKandidaten(roh: unknown, erlaubt: ReadonlySet<string>): AblageKandidat[] {
  if (!Array.isArray(roh)) return [];
  const out: AblageKandidat[] = [];
  const gesehen = new Set<string>();
  for (const k of roh as unknown[]) {
    if (out.length >= KI_ENTSCHEID_MAX_KANDIDATEN) break;
    if (!k || typeof k !== "object") continue;
    const r = k as Record<string, unknown>;
    const pfad = typeof r.pfad === "string" ? r.pfad.trim() : "";
    if (!pfad || !erlaubt.has(pfad) || gesehen.has(pfad)) continue;
    const g = Number(r.gewicht);
    gesehen.add(pfad);
    out.push({
      pfad,
      quelle: r.quelle === "regel" ? "regel" : "vorbild",
      gewicht: Number.isFinite(g) && g > 0 ? Math.round(g * 100) / 100 : 0,
    });
  }
  return out;
}

/** Bis zu zwei Alternativen aus den Kandidaten (schwerste zuerst), ohne den
 *  gewaehlten Ordner. */
export function alternativenAusKandidaten(kandidaten: readonly AblageKandidat[], ordner: string | null): string[] {
  return [...kandidaten]
    .sort((a, b) => b.gewicht - a.gewicht)
    .map((k) => k.pfad)
    .filter((p, i, liste) => p !== ordner && liste.indexOf(p) === i)
    .slice(0, KI_ENTSCHEID_MAX_ALTERNATIVEN);
}

/** Liste ohne Luecken und Doppel, Reihenfolge bleibt. */
function ohneDoppel(liste: readonly (string | null | undefined)[]): string[] {
  return [...new Set(liste.filter((x): x is string => typeof x === "string" && x.length > 0))];
}

// ── Personenbezug ───────────────────────────────────────────────────────

/** Personenbezogen heisst: nichts verlaesst das Haus. Nicht nur das Flag des
 *  Rigs zaehlt — auch eine im Ergebnis erkannte Mitarbeiterin/ein erkannter
 *  Mitarbeiter, ein Bezug auf eine Person oder ein personenbezogener
 *  Dokumenttyp (Lohnabrechnung, Behoerde, Zertifikat — im Rig-Typ wie in der
 *  Einordnung). */
export function istPersonenbezogen(e: AblageEinordnung, lokal: Pick<AblageAnalyseErgebnis, "person" | "typ">): boolean {
  return e.personenbezogen || lokal.person !== null || e.bezug.art === "person" || KI_PERSON_TYPEN.has(lokal.typ) || KI_PERSON_TYPEN.has(e.typ);
}

/** Namen fuer Minimierung und Personalakten-Erkennung: alle Profile plus
 *  (zur Sicherheit) die Mitarbeiterliste, ohne Doppel. */
function alleNamen(kontext: AblageAnalyseKontext): string[] {
  return ohneDoppel([...(kontext.namen_alle ?? []), ...kontext.mitarbeiter].map((n) => n.trim()));
}

// ── Personalakten im Ordnerbaum ─────────────────────────────────────────
// Wie rig/eventline-ki/dienst/app/ordnerwahl.py (falte/woerter/personen_akte):
// Umlaute gefaltet, Woerter ab drei Zeichen ohne Zahlen und Fuellwoerter.

const STOPP = new Set([
  "und", "der", "die", "das", "den", "dem", "des", "fuer", "mit", "von", "vom", "zum", "zur", "the", "and",
  "gmbh", "int", "nr", "allgemein", "sonstiges", "sonstige",
]);

function falte(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

function woerter(s: string): string[] {
  return falte(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !STOPP.has(t));
}

function istAkte(pfad: string, personen: readonly (readonly string[])[]): boolean {
  const teile = pfad.split("/");
  if (teile.length < 2) return false;
  const blatt = teile[teile.length - 1];
  // Vorlagen (0000_*) sind keine Akte; die Akte liegt unter einer Personal-Wurzel.
  if (/^0000_/.test(blatt) || !teile.slice(0, -1).some((s) => falte(s).includes("personal"))) return false;
  const blattWoerter = new Set(woerter(blatt.replace(/^\d+_/, "")));
  if (blattWoerter.size === 0) return false;
  return personen.some((w) => w.every((x) => blattWoerter.has(x)));
}

/** Ist der Pfad die Personalakte einer Person aus `namen`? Blatt = optionale
 *  Nummer (NNNN_) + alle Woerter eines vollen Namens in beliebiger
 *  Reihenfolge (Vorname_Nachname oder Nachname_Vorname), Umlaute gefaltet
 *  (Näf = Naef), unter einer Wurzel mit «Personal» im Namen; Vorlagen
 *  0000_* nie. */
export function istPersonenAkte(pfad: string, namen: readonly string[]): boolean {
  return istAkte(pfad, namen.map(woerter).filter((w) => w.length > 0));
}

/** Ordnerliste fuer Claude bei NICHT personenbezogenen Dokumenten: Personal-
 *  akten (aktiver wie inaktiver Profile) samt Unterordnern fallen weg, der
 *  Elternordner (z. B. 06_PERSONAL/01_Personalakten_Festangestellt) bleibt.
 *  Claude sieht die Namen nicht und kann keine Akte waehlen — Antworten
 *  werden gegen diese gekappte Liste geprueft. */
export function kappePersonalakten(ordner: readonly string[], namen: readonly string[]): string[] {
  const personen = namen.map(woerter).filter((w) => w.length > 0);
  if (personen.length === 0) return [...ordner];
  const akten = ordner.filter((p) => istAkte(p, personen));
  if (akten.length === 0) return [...ordner];
  return ordner.filter((p) => !akten.some((a) => p === a || p.startsWith(a + "/")));
}

// ── Claude ──────────────────────────────────────────────────────────────

export interface Entscheid {
  ordner: string | null;
  alternativen: string[];
  sicherheit: OrdnerSicherheit;
  begruendung: string;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ordner", "alternativen", "sicherheit", "begruendung"],
  properties: {
    ordner: {
      type: "string",
      description:
        "Der Zielordner — AUSSCHLIESSLICH exakt ein Pfad aus der Ordnerliste (Schreibweise 1:1, voller Pfad). Leer lassen, wenn keiner klar passt. NIE einen Pfad erfinden.",
    },
    alternativen: {
      type: "array",
      items: { type: "string" },
      description:
        "Bis zu 2 naechstbeste Zielordner, exakt aus der Ordnerliste, ohne den gewaehlten. Leer, wenn es keine sinnvollen gibt.",
    },
    sicherheit: {
      type: "string",
      enum: ["hoch", "mittel", "niedrig"],
      description:
        "hoch = Einordnung und Ordner passen eindeutig; mittel = plausibel, ein anderer Ordner waere denkbar; niedrig = unsicher oder geraten (auch wenn ordner leer bleibt).",
    },
    begruendung: {
      type: "string",
      description: "Ein kurzer Satz Deutsch (hoechstens 120 Zeichen): warum dieser Ordner. Keine Inhalte des Dokuments wiederholen.",
    },
  },
};

const SYSTEM = `Du bestimmst den Zielordner fuer ein Dokument in der Dokumentenablage der EVENTLINE GmbH (Eventtechnik, Basel). Das Dokument selbst siehst du nie — nur eine minimierte Einordnung, die die lokale KI im Buero erstellt hat, dazu Kandidaten aus Vorbild-Dokumenten und Regeln sowie die vollstaendige Liste der aktiven Ordner.

Hauskonvention:
- Dokumente zu einer Location, einem Projekt oder einem Kunden liegen im Ordner dieser Location / dieses Projekts / dieses Kunden — und dort im Unterordner nach Dokumentart (z. B. Verwaltungsvertraege, Plaene_Grundrisse, Bewilligungen), wenn es ihn gibt.
- Jahresordner (2026, 2027, …) gibt es nur in Sammelordnern, die laufend neue Ablagen pro Jahr bekommen (z. B. Backups, Steuern, Rechnungen). Dort gehoert das Dokument in den Jahresordner seines Dokumentjahrs, wenn er existiert.
- Ordner, die nur Unterordner gruppieren (z. B. ein Bereichs- oder Sammelordner mit Instanzen darunter), sind nie das Ziel — waehle den passenden Unterordner.
- Vorlagen-Ordner (z. B. Ordner_Struktur_Vorlage) sind nie das Ziel fuer echte Dokumente.

Regeln:
- ordner AUSSCHLIESSLICH exakt aus der Liste, Schreibweise 1:1. Passt keiner klar: ordner leer lassen. NIE einen Pfad erfinden.
- Kandidaten und die Wahl des lokalen Modells sind Hinweise, keine Pflicht: weiche ab, wenn die Einordnung klar auf einen anderen Ordner zeigt. Ein Kandidat mit Quelle «Regel» ist ein starker Hinweis.
- alternativen: bis zu 2 naechstbeste Ordner aus der Liste, ohne den gewaehlten.
- sicherheit ehrlich einschaetzen; die Begruendung ist ein kurzer Satz ohne Dokumentinhalte.`;

/** Ordnerliste als eingerueckter Baum — jede Zeile traegt den VOLLEN Pfad
 *  (die Einrueckung zeigt nur die Hierarchie), damit die Antwort exakt aus
 *  der Liste kopiert werden kann. */
export function baueOrdnerBaum(ordner: readonly string[]): string {
  return ordner.map((p) => "  ".repeat(Math.max(0, p.split("/").length - 1)) + p).join("\n");
}

/** Benutzer-Eingabe fuer Claude: Baum, minimierte Einordnung, Kandidaten,
 *  Wahl des lokalen Modells. Enthaelt NIE beschrieb/zusammenfassung. */
export function baueEingabe(opts: {
  ordner: readonly string[];
  einordnung: AblageEinordnung;
  kandidaten: readonly AblageKandidat[];
  lokalOrdner: string | null;
  lokalAlternativen: readonly string[];
}): string {
  const e = opts.einordnung;
  const bezug = e.bezug.art || e.bezug.name ? `${e.bezug.art ?? "unbekannt"}${e.bezug.name ? ` «${e.bezug.name}»` : ""}` : "keiner";
  const kandidaten =
    opts.kandidaten.length === 0
      ? "keine"
      : opts.kandidaten
          .map((k, i) => `${i + 1}. ${k.pfad} — ${k.quelle === "regel" ? "Regel" : "Vorbild-Dokumente"}, Gewicht ${k.gewicht}`)
          .join("\n");
  return `Ordnerliste (aktiv, exakte Schreibweise; Einrueckung = Hierarchie):
${baueOrdnerBaum(opts.ordner)}

Einordnung des Dokuments (minimiert, von der lokalen KI im Buero):
Was: ${e.was}
Dokumentart: ${e.typ || "unbekannt"}
Betreff: ${e.betreff || "—"}
Partei: ${e.partei ?? "—"}
Bezug: ${bezug}
Jahr: ${e.jahr ?? "unbekannt"}
Sprache: ${e.sprache ?? "unbekannt"} · Seiten: ${e.seiten ?? "unbekannt"}

Kandidaten (Hinweise, beste zuerst):
${kandidaten}

Wahl des lokalen Modells: ${opts.lokalOrdner ?? "keine"}
Alternativen des lokalen Modells: ${opts.lokalAlternativen.length > 0 ? opts.lokalAlternativen.join(", ") : "keine"}`;
}

/** Echter Claude-Aufruf (strict-Tool, Muster /api/ablage/name-vorschlag).
 *  max_tokens bewusst hoch (Memory-Regel: der 4096-Default kappt grosse
 *  Listen still — hier klein, aber kostet nichts). */
export function frageClaudeNachOrdner(eingabe: string): Promise<unknown> {
  return structuredCall<unknown>({
    system: SYSTEM,
    content: [{ type: "text", text: eingabe }],
    toolName: "ordner_entscheid",
    toolDescription: "Der Zielordner fuer das Dokument — exakt aus der Liste — mit Alternativen, Sicherheit und kurzer Begruendung.",
    schema: SCHEMA,
    maxTokens: 8192,
  });
}

/** Antwort absichern: ordner nur aus der erlaubten Liste (sonst null — und
 *  ein erfundener Pfad macht die Sicherheit zu «niedrig»), Alternativen
 *  nur aus der Liste, ohne ordner, ohne Doppel, hoechstens zwei;
 *  Begruendung gekappt. */
export function validiereEntscheid(roh: unknown, erlaubt: ReadonlySet<string>): Entscheid {
  const r = roh && typeof roh === "object" && !Array.isArray(roh) ? (roh as Record<string, unknown>) : {};
  const ordnerRoh = typeof r.ordner === "string" ? r.ordner.trim() : "";
  const ordner = ordnerRoh && erlaubt.has(ordnerRoh) ? ordnerRoh : null;
  const alternativen: string[] = [];
  if (Array.isArray(r.alternativen)) {
    for (const a of r.alternativen as unknown[]) {
      if (alternativen.length >= KI_ENTSCHEID_MAX_ALTERNATIVEN) break;
      if (typeof a !== "string") continue;
      const pfad = a.trim();
      if (pfad && pfad !== ordner && erlaubt.has(pfad) && !alternativen.includes(pfad)) alternativen.push(pfad);
    }
  }
  const sicherheitRoh = typeof r.sicherheit === "string" ? r.sicherheit : "";
  let sicherheit: OrdnerSicherheit = (SICHERHEITEN as readonly string[]).includes(sicherheitRoh) ? (sicherheitRoh as OrdnerSicherheit) : "niedrig";
  if (ordnerRoh && !ordner) sicherheit = "niedrig";
  const begruendung = typeof r.begruendung === "string" ? r.begruendung.replace(/\s+/g, " ").trim().slice(0, KI_ENTSCHEID_BEGRUENDUNG_MAX) : "";
  return { ordner, alternativen, sicherheit, begruendung };
}

function mitTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Claude antwortet nicht innerhalb von ${Math.round(ms / 1000)} s`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export interface EntscheidAbhaengigkeiten {
  /** Standard: aiAvailable() (ANTHROPIC_API_KEY gesetzt). */
  verfuegbar?: () => boolean;
  /** Standard: frageClaudeNachOrdner (echter Aufruf). */
  frageClaude?: (eingabe: string) => Promise<unknown>;
  /** Hoechstens so lange auf EINEN Claude-Aufruf warten (Standard
   *  KI_ENTSCHEID_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Restbudget der aufrufenden Route in ms — POST /api/ki/sync verteilt
   *  KI_SYNC_POST_BUDGET_MS auf alle Ergebnisse eines Batches. Unter
   *  KI_ENTSCHEID_MIN_REST_MS wird Claude gar nicht gefragt (Quelle
   *  «lokal»), sonst kappt es die Wartezeit. Ohne Angabe gilt nur timeoutMs. */
  restBudgetMs?: number;
}

/** Wartezeit auf Claude: timeoutMs, gekappt auf das Restbudget der Route;
 *  null = Restbudget unter KI_ENTSCHEID_MIN_REST_MS -> gar nicht fragen. */
export function wartezeitFuerClaude(deps: Pick<EntscheidAbhaengigkeiten, "timeoutMs" | "restBudgetMs">): number | null {
  const timeout = deps.timeoutMs ?? KI_ENTSCHEID_TIMEOUT_MS;
  if (deps.restBudgetMs === undefined) return timeout;
  if (deps.restBudgetMs < KI_ENTSCHEID_MIN_REST_MS) return null;
  return Math.min(timeout, deps.restBudgetMs);
}

/** Zielordner fuer ein bereinigtes Ablage-Ergebnis festlegen (Regel ->
 *  Claude -> lokal, s. Kopf der Datei). `roh` ist das unveraenderte
 *  Rig-Ergebnis (nur fuer regel_ordner/kandidaten/einordnung gelesen),
 *  `lokal` das Ergebnis von bereinigeAblageErgebnis. Liefert ein Rig ohne
 *  V8-Felder, bleibt `lokal` unveraendert (kein Chip im UI). */
export async function entscheideOrdner(
  lokal: AblageAnalyseErgebnis,
  roh: Record<string, unknown>,
  kontext: AblageAnalyseKontext,
  deps: EntscheidAbhaengigkeiten = {},
): Promise<AblageAnalyseErgebnis> {
  if (!("regel_ordner" in roh) && !("kandidaten" in roh) && !("einordnung" in roh)) return lokal;

  const erlaubt = new Set(kontext.ordner);
  const kandidaten = leseKandidaten(roh.kandidaten, erlaubt);

  // (1) Verbindliche Regel des Rigs — kein Claude-Aufruf.
  const regel = typeof roh.regel_ordner === "string" ? roh.regel_ordner.trim() : "";
  if (regel && erlaubt.has(regel)) {
    return {
      ...lokal,
      ordner: regel,
      ordner_alternativen: alternativenAusKandidaten(kandidaten, regel),
      neuer_ordner: null,
      ordner_quelle: "regel",
    };
  }

  const lokalErgebnis: AblageAnalyseErgebnis = { ...lokal, ordner_quelle: "lokal" };

  // (2) Einordnung vorhanden und Schluessel gesetzt — sonst bleibt es lokal.
  const einordnungRoh = leseEinordnung(roh.einordnung);
  const verfuegbar = deps.verfuegbar ?? aiAvailable;
  if (!einordnungRoh || !verfuegbar()) return lokalErgebnis;

  // Personenbezogen: nichts verlaesst das Haus.
  if (istPersonenbezogen(einordnungRoh, lokal)) return lokalErgebnis;

  // Zeitbudget der Route zu knapp: gar nicht mehr fragen.
  const wartezeit = wartezeitFuerClaude(deps);
  if (wartezeit === null) return lokalErgebnis;

  const namen = alleNamen(kontext);
  const einordnung = minimiereEinordnung(einordnungRoh, namen);
  // Das Dokument ist nicht personenbezogen: Claude sieht den Baum ohne
  // Personalakten und waehlt nur daraus — alles andere gilt als erfunden.
  const ordnerClaude = kappePersonalakten(kontext.ordner, namen);
  const erlaubtClaude = new Set(ordnerClaude);
  const eingabe = baueEingabe({
    ordner: ordnerClaude,
    einordnung,
    kandidaten: kandidaten.filter((k) => erlaubtClaude.has(k.pfad)),
    lokalOrdner: lokal.ordner !== null && erlaubtClaude.has(lokal.ordner) ? lokal.ordner : null,
    lokalAlternativen: (lokal.ordner_alternativen ?? []).filter((a) => erlaubtClaude.has(a)),
  });

  const start = Date.now();
  try {
    const antwort = await mitTimeout((deps.frageClaude ?? frageClaudeNachOrdner)(eingabe), wartezeit);
    const e = validiereEntscheid(antwort, erlaubtClaude);
    const lokaleAlternativen = lokal.ordner_alternativen ?? [];
    const begruendung = e.begruendung ? { ordner_begruendung: e.begruendung } : {};
    if (e.ordner === null) {
      // Kein Treffer (oder erfundener Pfad): der Nutzer muss waehlen — die
      // Wahl des lokalen Modells zuerst, dann dessen Alternativen, Claude-
      // Alternativen fuellen auf; neuer_ordner bleibt. Sicherheit immer niedrig.
      return {
        ...lokal,
        ordner: null,
        ordner_alternativen: ohneDoppel([lokal.ordner, ...lokaleAlternativen, ...e.alternativen]).slice(0, KI_ENTSCHEID_MAX_ALTERNATIVEN),
        ordner_quelle: "claude",
        ordner_sicherheit: "niedrig",
        ...begruendung,
      };
    }
    return {
      ...lokal,
      ordner: e.ordner,
      // Nennt Claude keine Alternativen, bleiben die des lokalen Modells
      // als Vorschlaege stehen (der Nutzer muss ohnehin einen Ordner waehlen).
      ordner_alternativen: e.alternativen.length > 0 ? e.alternativen : lokaleAlternativen.filter((a) => a !== e.ordner),
      neuer_ordner: null,
      ordner_quelle: "claude",
      ordner_sicherheit: e.sicherheit,
      ...begruendung,
    };
  } catch (err) {
    // (3) Nur Kennzahlen ins Log — nie die Einordnung.
    logError("ki.sync.entscheid", err, {
      kandidaten: kandidaten.length,
      ordner_lokal: lokal.ordner !== null,
      ordner_anzahl: ordnerClaude.length,
      wartezeit_ms: wartezeit,
      dauer_ms: Date.now() - start,
    });
    return lokalErgebnis;
  }
}
