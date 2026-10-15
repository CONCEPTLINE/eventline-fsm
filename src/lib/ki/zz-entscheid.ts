// Rueckstau ZZ, Rezept zz/v3 — «Staerken verteilen» (Mischa 2026-10-15):
//   (A) die lokale KI im Buero liest das GANZE Dokument (in Teilen) und
//       schreibt einen ausfuehrlichen, GEFILTERTEN Beschrieb (Dokumentart,
//       Zweck, Beteiligte mit Rolle, Bezug, Status, Datum …) — ohne Betraege,
//       Konto-/AHV-/Ausweis-/Policen-/Telefonnummern, Adressen, Gesundheits-
//       oder Kuendigungsgruende, woertliche Zitate;
//   (B) Claude (App-API, structuredCall) bekommt NUR diesen Beschrieb, den
//       Dateinamen, den bisherigen ZZ-Unterpfad, die Ordnerstruktur, die
//       Dateinamen in Kandidatenordnern, Fakten-Hinweise des Rigs und
//       fruehere Entscheide des Teams — nie Dokumenttext — und schlaegt
//       Zielordner (bestehend oder NEU), Dateinamen, Begruendung, Sicherheit
//       und Alternativen vor;
//   (C) ein Mensch gibt frei (src/components/nas/vorschlaege-gruppe.tsx).
// Rezept zz/v4 (16.10.2026): die Angaben des Beschriebs sind im Dokument
// belegt, Unbelegtes steht unter `unbekannt`; dazu Firmenwissen des Teams
// (Tab «Wissen», lib/ki/wissen) im Prompt und 0–2 Rueckfragen von Claude im
// Ergebnis (gefiltert in lib/ki/wissen, Liste «Offene Fragen der KI»).
// Hier alles Reine: Lesen/Filtern des Beschriebs, Prompt, Schema, Pruefung
// der Antwort, Auswahl der Lern-Beispiele. Der Aufruf selbst ist
// frageClaudeZz (injizierbar in lib/ki/zz-warteschlange).

import type Anthropic from "@anthropic-ai/sdk";
import { structuredCall } from "@/lib/ai/anthropic";
import { inhaltImNamen, pruefeNeuenDateinamen } from "./dateiname";
import { hatZzSegment, leseOrdnerName, zielGesperrt } from "./pfade";
import type { OrdnerSicherheit } from "./typen";

// ── Beschrieb ───────────────────────────────────────────────────────────

export interface ZzBeteiligter {
  name: string;
  rolle: string;
}

/** Gefilterter Beschrieb der lokalen KI (Felder fehlen, wenn leer). */
export interface ZzBeschrieb {
  typ: string | null;
  typ_label: string | null;
  dokumentart: string | null;
  unterart: string | null;
  titel: string | null;
  zweck: string | null;
  bezug: string | null;
  status: string | null;
  datum: string | null;
  zeitraum: string | null;
  sprache: string | null;
  absender: string | null;
  empfaenger: string | null;
  beteiligte: ZzBeteiligter[];
  schlagworte: string[];
  seiten: number | null;
  teile: number | null;
  gelesen: string | null;
  dateityp: string | null;
  ocr: boolean;
  personenbezogen: boolean;
  /** Rezept zz/v4 (Belegstellen, 16.10.2026): Felder, die die lokale KI im
   *  Dokument NICHT belegen konnte («unbekannt» statt geraten). null = aelterer
   *  Beschrieb ohne Belegpruefung. Alle uebrigen Angaben zu Datum, Zeitraum,
   *  Status, Bezug, Absender/Empfaenger und Beteiligten sind belegt. */
  unbekannt: string[] | null;
}

/** Felder mit Belegpflicht (= rig/…/jobs/zz.BELEG_FELDER + «beteiligte»). */
export const ZZ_BELEG_FELDER = ["datum", "zeitraum", "status", "bezug", "absender", "empfaenger", "beteiligte"] as const;
const BELEG_FELD_TEXT: Readonly<Record<(typeof ZZ_BELEG_FELDER)[number], string>> = {
  datum: "Datum", zeitraum: "Zeitraum", status: "Status", bezug: "Bezug", absender: "Absender", empfaenger: "Empfaenger",
  beteiligte: "Beteiligte",
};

const FELDER: readonly [keyof ZzBeschrieb, number][] = [
  ["typ", 40],
  ["typ_label", 60],
  ["dokumentart", 60],
  ["unterart", 80],
  ["titel", 60],
  ["zweck", 300],
  ["bezug", 160],
  ["zeitraum", 40],
  ["absender", 80],
  ["empfaenger", 80],
  ["gelesen", 80],
];
const STATUS = new Set(["entwurf", "unterschrieben", "final", "version", "vorlage"]);
/** Woertliche Zitate («…», "…", „…“) ab 12 Zeichen fallen weg. */
const RE_ZITAT = /[«"„“”‚‘'][^«»"„“”]{12,}[»"“”‘’']/g;

/** Freitext: getrimmt, Zitate raus, gekappt; mit Inhaltsangabe (Betrag,
 *  Nummer, IBAN, AHV, Telefon, E-Mail, Adresse, Gesundheit/Kuendigungsgrund,
 *  lange Zahl) -> null (das ganze Feld faellt weg, nie «repariert»). */
export function sauberText(roh: unknown, max: number): string | null {
  if (typeof roh !== "string") return null;
  const s = roh.normalize("NFC").replace(RE_ZITAT, "").replace(/\s+/g, " ").trim().slice(0, max).trim();
  if (!s) return null;
  return inhaltImNamen(s) ? null : s;
}

/** Beschrieb vom Rig lesen und im FSM NOCHMALS filtern (hier liegt die
 *  Grenze zum Internet). Ohne Dokumentart, Titel, Zweck und Schlagworte
 *  gibt es nichts zu entscheiden -> trotzdem gueltig (Dateiname + Ablageort
 *  tragen dann), solange es ein Objekt ist. `namen` (alle Profile) bleibt
 *  fuer kuenftige Minimierung; Personennamen sind nach Mischas Vorgabe
 *  erlaubt (Arbeitnehmer im Personaldokument). */
export function leseZzBeschrieb(roh: unknown, namen: readonly string[]): ZzBeschrieb | null {
  void namen;
  if (!roh || typeof roh !== "object" || Array.isArray(roh)) return null;
  const r = roh as Record<string, unknown>;
  const b: ZzBeschrieb = {
    typ: null, typ_label: null, dokumentart: null, unterart: null, titel: null, zweck: null, bezug: null, status: null,
    datum: null, zeitraum: null, sprache: null, absender: null, empfaenger: null, beteiligte: [], schlagworte: [],
    seiten: null, teile: null, gelesen: null, dateityp: null, ocr: r.ocr === true, personenbezogen: r.personenbezogen === true,
    unbekannt: Array.isArray(r.unbekannt)
      ? ZZ_BELEG_FELDER.filter((f) => (r.unbekannt as unknown[]).includes(f))
      : null,
  };
  for (const [f, max] of FELDER) (b as unknown as Record<string, unknown>)[f] = sauberText(r[f], max);
  if (typeof r.status === "string" && STATUS.has(r.status)) b.status = r.status;
  if (typeof r.datum === "string" && /^(19|20)\d{2}-\d{2}-\d{2}$/.test(r.datum)) b.datum = r.datum;
  if (typeof r.sprache === "string" && /^[a-z]{2,3}(-[a-z]{2})?$/i.test(r.sprache)) b.sprache = r.sprache.toLowerCase();
  if (typeof r.dateityp === "string" && /^[a-z0-9]{1,10}$/i.test(r.dateityp)) b.dateityp = r.dateityp.toLowerCase();
  for (const [f, max] of [["seiten", 5000], ["teile", 1000]] as const) {
    const n = Number(r[f]);
    if (Number.isInteger(n) && n > 0 && n <= max) b[f] = n;
  }
  if (Array.isArray(r.beteiligte)) {
    for (const e of r.beteiligte as unknown[]) {
      if (b.beteiligte.length >= 8 || !e || typeof e !== "object") continue;
      const x = e as Record<string, unknown>;
      const name = sauberText(x.name, 80);
      if (!name || b.beteiligte.some((y) => y.name.toLowerCase() === name.toLowerCase())) continue;
      b.beteiligte.push({ name, rolle: sauberText(x.rolle, 60) ?? "" });
    }
  }
  if (Array.isArray(r.schlagworte)) {
    for (const w of r.schlagworte as unknown[]) {
      const s = sauberText(w, 30);
      if (s && b.schlagworte.length < 10 && !b.schlagworte.some((y) => y.toLowerCase() === s.toLowerCase())) b.schlagworte.push(s);
    }
  }
  return b;
}

/** Ein Fakten-Hinweis des Rigs (aus Ordner-/Dateinamen gebaut): eine Zeile,
 *  hoechstens 300 Zeichen, ohne Betraege/IBAN/AHV/Telefon/E-Mail/Gesundheit.
 *  Pfade mit Nummern («002506_», «INT-26-100») sind hier erlaubt. */
const RE_FAKT_VERBOTEN: readonly RegExp[] = [
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/i,
  /(?<![A-Za-z0-9])(?:CH|LI|DE|AT|FR|IT)\d{2}(?:[\s\-]?[0-9A-Z]){12,}/,
  /(?<!\d)756[.\s\-]?\d{4}[.\s\-]?\d{4}[.\s\-]?\d{2}(?!\d)/,
  /(?:\+|(?<!\d)00)\d{2}(?:[\s.\-]?\d){6,}(?![\d_])/,
  /(?<![\p{L}\d_])(?:CHF|EUR|USD|S?Fr\.)\s?\d/iu,
  /\d[\d'’.,]*\s?(?:CHF|EUR|Franken)(?!\p{L})/iu,
  /krank|arzt|ärzt|diagnose|therapie|schwanger|burn[\s_\-]?out|kündigungsgrund|kuendigungsgrund/iu,
];
export function filtereFakt(roh: unknown): string | null {
  if (typeof roh !== "string") return null;
  const s = roh.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!s || enthaeltSensibles(s)) return null;
  return s;
}

/** Steht irgendwo im (beliebig langen) Text ein Wert, den filtereFakt verbietet? (E-Mail, IBAN/Konto, AHV, Telefon,
 *  Betrag, Gesundheit/Kuendigungsgrund — z. B. fuer Eintraege im Firmenwissen, die auch an Claude gehen.) */
export function enthaeltSensibles(roh: string): boolean {
  const s = roh.normalize("NFC").replace(/\s+/g, " ");
  return RE_FAKT_VERBOTEN.some((re) => re.test(s));
}

/** Ordner-Segmente der Datei unterhalb der ZZ_-Freigabe, ohne Dateiname. */
export function herkunftAusPfad(pfad: string): string[] {
  const teile = pfad.normalize("NFC").split("/").slice(0, -1);
  const i = teile.findIndex((t) => /^zz_/i.test(t));
  return i === -1 ? [] : teile.slice(i + 1);
}

/** Dokumentart fuer Lern-Beispiele (Vergleich gleicher Arten). */
export function dokartAus(b: ZzBeschrieb): string | null {
  return (b.dokumentart ?? b.typ_label ?? b.typ)?.trim().toLowerCase() || null;
}

// ── Lern-Beispiele (Mischa: «ja lernen») ────────────────────────────────

export interface Lernbeispiel {
  aktion: "angenommen" | "korrigiert" | "abgelehnt";
  beschrieb: unknown;
  dokart: string | null;
  original_name: string | null;
  vorgeschlagen_ordner: string | null;
  final_ordner: string | null;
  vorgeschlagen_name: string | null;
  final_name: string | null;
  ordner_geaendert: boolean | null;
  name_geaendert: boolean | null;
}

function falte(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function woerter(s: string | null | undefined): string[] {
  return falte(s ?? "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w));
}

function beschriebWoerter(b: ZzBeschrieb | null): Set<string> {
  if (!b) return new Set();
  return new Set([
    ...woerter(b.dokumentart), ...woerter(b.unterart), ...woerter(b.titel), ...woerter(b.bezug),
    ...b.schlagworte.flatMap(woerter), ...b.beteiligte.flatMap((x) => woerter(x.name)),
  ]);
}

const MAX_POSITIV = 3;

/** Die relevantesten frueheren Entscheide: gleiche Dokumentart (+3), gleiche
 *  Person/Firma (+2), Wort-Ueberlappung (Jaccard × 4). Nur Treffer mit
 *  Bezug (Punkte > 0); Korrekturen und Ablehnungen vor Bestaetigungen ohne
 *  Aenderung (davon hoechstens 3). `zeilen` kommen neueste zuerst; das
 *  Ergebnis bleibt in dieser Reihenfolge (neueste zuerst). */
export function waehleBeispiele(b: ZzBeschrieb, zeilen: readonly Lernbeispiel[], max = 10): Lernbeispiel[] {
  const art = dokartAus(b);
  const eigene = beschriebWoerter(b);
  const leute = new Set(b.beteiligte.flatMap((x) => woerter(x.name)));
  const bewertet = zeilen.map((z, i) => {
    const zb = leseZzBeschrieb(z.beschrieb, []);
    const fremde = beschriebWoerter(zb);
    const schnitt = [...eigene].filter((w) => fremde.has(w)).length;
    const vereinigt = new Set([...eigene, ...fremde]).size || 1;
    let punkte = (schnitt / vereinigt) * 4;
    if (art && (z.dokart?.trim().toLowerCase() ?? (zb ? dokartAus(zb) : null)) === art) punkte += 3;
    if (zb && zb.beteiligte.some((x) => woerter(x.name).some((w) => leute.has(w)))) punkte += 2;
    const positiv = z.aktion === "angenommen" && !z.ordner_geaendert && !z.name_geaendert;
    return { z, i, punkte, positiv };
  });
  const relevant = bewertet.filter((x) => x.punkte > 0.5).sort((a, c) => (c.punkte - a.punkte) || (a.i - c.i));
  const gewaehlt: typeof relevant = [];
  let positive = 0;
  for (const x of relevant) {
    if (gewaehlt.length >= max) break;
    if (x.positiv) {
      if (positive >= MAX_POSITIV) continue;
      positive++;
    }
    gewaehlt.push(x);
  }
  return gewaehlt.sort((a, c) => a.i - c.i).map((x) => x.z);
}

// ── Prompt ──────────────────────────────────────────────────────────────

export const DOKUMENT_MARKER = "\n\n=== Dokument ===\n";

export const ZZ_SYSTEM = `Du sortierst Dokumente aus dem Rueckstau «ZZ_Dokumente_zum_Einsortieren» in die Dokumentenablage (NAS) der EVENTLINE GmbH (Eventtechnik, Basel; bis Maerz 2026 der Verein EVENTLINE). Das Dokument selbst siehst du nie: die lokale KI im Buero hat es ganz gelesen und einen gefilterten Beschrieb geschrieben. Dazu bekommst du den Dateinamen, den bisherigen Ablageort in ZZ (oft ein starker Hinweis, z. B. «2025-Personal/<Person>»), die aktive Ordnerstruktur, Dateinamen in Kandidatenordnern, Fakten-Hinweise (deterministisch geprueft) und fruehere Entscheide des Teams. Ein Mensch prueft deinen Vorschlag vor dem Verschieben.

Hauskonvention der Ablage:
- Personendokumente (Arbeitsvertrag und Beilagen, Lohn, Zeugnisse, Bewerbung, Ausweis, Kurs-/Schulungsnachweise einer Person) gehoeren in die PERSONALAKTE dieser Person: 06_PERSONAL/<Sammelordner>/NNNN_Vorname_Nachname/<Unterordner nach Dokumentart> (z. B. 01_Vertraege_Anstellung, 02_Bewerbung_Zeugnisse/…, 04_Schulungen_Zertifikate, 06_Korrespondenz_Sonstiges). Nie in die Akte einer anderen Person, nie in Vorlagen-Ordner (0000_…, 30XX_…, 05_Vorlagen_Dokumente), nie zu einer Location, nur weil es ein Vertrag ist.
- Gibt es fuer die Person KEINE Personalakte, schlage eine NEUE Akte vor (ziel_neu = true): direkt unter dem passenden Sammelordner (Festangestellt, Ehmalige fuer fruehere Mitarbeitende z. B. des Vereins, Freelancer/02_Einzelakten fuer Freischaffende), benannt wie die vorhandenen Akten «NNNN_Vorname_Nachname» (Nummer passend zu den Geschwistern; unbekannt: die naechste freie im Schema des Sammelordners).
- Dokumente zu einer Location, einem Partner, einem Kunden oder einem Projekt/Event gehoeren in dessen Ordner und dort in den Unterordner nach Dokumentart (Verwaltungsvertraege, Plaene_Grundrisse, Bewilligungen, Fotos …). Eine Liste/ein Export, der viele Locations nennt (z. B. Leads), gehoert NICHT zu einer einzelnen Location.
- «Entwuerfe»-Ordner nur fuer Entwuerfe (status entwurf oder «Entwurf» im Namen), nie als Sammelbecken; unterschriebene Vertraege in «Signed», Nachtraege in «Nachtraege».
- Ordner, die nur Unterordner gruppieren, sind nie das Ziel — waehle den passenden Unterordner. Vorlagen-Ordner nur fuer echte Vorlagen. Jahresordner nur in Sammelordnern.
- NIE ein Ziel unter ZZ_* (jede Tiefe) und nie 99_System.

Ziel:
- Bestehender Ordner: ziel_ordner exakt aus der Ordnerliste (volle Schreibweise 1:1), ziel_neu = false.
- Passt kein bestehender Ordner klar: EIN neuer Ordner direkt unter einem bestehenden (ziel_ordner = "<bestehender Eltern-Pfad>/<Neuer_Name>", ziel_neu = true), benannt im Stil der Geschwister (Nummern-Praefix, Unterstriche). Nur eine neue Ebene.

Dateiname (name_vorschlag):
- Immer einen vorschlagen, Pflicht bei Namen ohne Aussage (nur Ziffern, Scan/IMG/DSC …).
- Im Stil der Dateien im Zielordner (Trenner, Datumsform, Reihenfolge der Teile) — einheitlich: gleiche Dokumentart = gleiches Schema, nicht fuenf Arten, einen Arbeitsvertrag zu benennen. Gibt es dort keine Dateien: YYYY-MM-DD_Dokumentart_Partei-oder-Person_Titel.ext (Datum aus dem Beschrieb oder Dateinamen; ohne Datum ohne Datumsteil).
- Endung exakt wie das Original. Keine Inhaltsdetails im Namen: keine Betraege, Nummern (Policen-, Kunden-, Rechnungs-, AHV-, Konto-, Telefonnummern), Adressen, Gesundheits- oder Kuendigungsgruende.

Fruehere Entscheide des Teams: so hat das Team frueher korrigiert und bestaetigt — daran orientieren (Ordnerwahl und Namensschema), wenn der Fall vergleichbar ist.

Beschrieb: Angaben zu Datum, Zeitraum, Status, Bezug, Absender/Empfaenger und Beteiligten hat die lokale KI im Dokument woertlich belegt (geprueft). Was unter «nicht belegt (unbekannt)» steht, wurde im Dokument nicht gefunden — nimm dafuer nichts an (kein Datum erfinden, keine Rolle unterstellen).

Firmenwissen: vom Team gepflegte Eintraege (Abkuerzungen, Benennungsregeln, Zuordnungen, Ansprechpartner, Ordner-Hinweise). Sie gehen deinen Annahmen vor; Benennungsregeln immer befolgen.

Rueckfragen (rueckfragen): 0 bis 2, nur wenn dir fuer DIESES Dokument eine Auskunft des Teams fehlt, die Ordner oder Namen aendern wuerde — eine unbekannte Abkuerzung, unklar ob eine Firma Kunde, Lieferant oder Partner ist, eine unbekannte Person, eine mehrdeutige Benennung. Keine Rueckfrage, wenn das Firmenwissen sie beantwortet oder du sicher bist. art: abkuerzung | zuordnung | person | benennung | sonstiges; begriff: das unklare Wort bzw. der Name, kurz; frage: ein kurzer Satz Deutsch (hoechstens 160 Zeichen), allgemein formuliert, damit dieselbe Frage fuer mehrere Dokumente gilt — ohne Betraege, Nummern, Adressen, Gesundheits- oder Kuendigungsangaben. Deinen Vorschlag machst du trotzdem (beste Annahme, Sicherheit entsprechend).

sicherheit: hoch = Person bzw. Partei eindeutig UND passender bestehender Unterordner; mittel = plausibel, Alternative denkbar, oder neuer Ordner; niedrig = unsicher. begruendung: EIN kurzer Satz Deutsch (hoechstens 120 Zeichen), ohne Inhaltsdetails. alternativen: bis zu 2 bestehende Ordner aus der Liste, ohne das Ziel.`;

/** Ordnerliste als eingerueckter Baum — jede Zeile traegt den VOLLEN Pfad. */
export function baueZzOrdnerBaum(ordner: readonly string[]): string {
  return ordner
    .filter((p) => !hatZzSegment(p) && !zielGesperrt(p))
    .map((p) => "  ".repeat(Math.max(0, p.split("/").length - 1)) + p)
    .join("\n");
}

function zeileBeschrieb(b: ZzBeschrieb): string {
  const z: string[] = [];
  const f = (label: string, v: string | number | null | undefined) => {
    if (v !== null && v !== undefined && v !== "") z.push(`${label}: ${v}`);
  };
  f("Dokumentart", b.dokumentart ?? b.typ_label);
  f("Unterart", b.unterart);
  f("Titel", b.titel);
  f("Zweck", b.zweck);
  f("Bezug", b.bezug);
  f("Status", b.status);
  f("Datum", b.datum);
  f("Zeitraum", b.zeitraum);
  f("Absender", b.absender);
  f("Empfaenger", b.empfaenger);
  if (b.beteiligte.length) z.push(`Beteiligte: ${b.beteiligte.map((x) => (x.rolle ? `${x.name} (${x.rolle})` : x.name)).join("; ")}`);
  if (b.schlagworte.length) z.push(`Schlagworte: ${b.schlagworte.join(", ")}`);
  f("Sprache", b.sprache);
  f("Seiten", b.seiten);
  f("Gelesen", b.gelesen);
  f("Dateityp", b.dateityp);
  if (b.ocr) z.push("Text per OCR erkannt");
  if (b.personenbezogen) z.push("Personendokument: ja");
  if (b.unbekannt?.length) z.push(`Im Dokument nicht belegt (unbekannt): ${b.unbekannt.map((x) => BELEG_FELD_TEXT[x as keyof typeof BELEG_FELD_TEXT] ?? x).join(", ")}`);
  return z.length ? z.map((x) => `- ${x}`).join("\n") : "- (kein lesbarer Inhalt — nur Dateiname und Ablageort tragen)";
}

function zeileBeispiel(x: Lernbeispiel): string {
  const b = leseZzBeschrieb(x.beschrieb, []);
  const was = b ? [b.dokumentart ?? b.typ_label, b.titel, b.beteiligte.map((y) => y.name).join("/")].filter(Boolean).join(", ") : "";
  const vorher = `${x.vorgeschlagen_ordner ?? "—"}${x.vorgeschlagen_name ? ` · «${x.vorgeschlagen_name}»` : ""}`;
  if (x.aktion === "abgelehnt") {
    return `- ${was || "Dokument"} (Datei «${x.original_name ?? "?"}»): Vorschlag ${vorher} → ABGELEHNT${x.final_ordner ? `, stattdessen ${x.final_ordner}` : ""}`;
  }
  const nachher = `${x.final_ordner ?? "—"}${x.final_name ? ` · «${x.final_name}»` : ""}`;
  const was_geaendert = [x.ordner_geaendert ? "Ordner" : null, x.name_geaendert ? "Name" : null].filter(Boolean).join(" + ");
  return `- ${was || "Dokument"} (Datei «${x.original_name ?? "?"}»): Vorschlag ${vorher} → ${was_geaendert ? `KORRIGIERT (${was_geaendert}) zu ${nachher}` : "bestaetigt"}`;
}

/** Eingabe fuer Claude. Der Teil VOR DOKUMENT_MARKER (Ordnerbaum) ist fuer
 *  alle Dokumente gleich und wird gecacht (frageClaudeZz). Enthaelt NIE
 *  Dokumenttext — nur Beschrieb, Namen, Pfade, Fakten. */
export function baueZzEingabe(opts: {
  ordner: readonly string[];
  beschrieb: ZzBeschrieb;
  dateiname: string;
  herkunft: readonly string[];
  fakten: readonly string[];
  kandidaten: readonly string[];
  namenJeOrdner: ReadonlyMap<string, readonly string[]>;
  beispiele?: readonly Lernbeispiel[];
  /** Schon vorgeschlagene, noch nicht angelegte NEUE Ordner (offene
   *  Vorschlaege mit ziel_neu) — damit drei Dokumente derselben Person
   *  dieselbe neue Akte bekommen statt drei verschiedene Nummern. */
  neueOrdnerOffen?: readonly string[];
  /** Firmenwissen fuer dieses Dokument, fertige Zeilen (lib/ki/wissen
   *  waehleWissen + zeileWissen, mit Budget). */
  wissen?: readonly string[];
}): string {
  const kandidaten = opts.kandidaten.length
    ? opts.kandidaten
        .map((k, i) => {
          const namen = opts.namenJeOrdner.get(k) ?? [];
          return `${i + 1}. ${k}\n   Dateien dort: ${namen.length ? namen.slice(0, 8).join("; ") : "(noch keine)"}`;
        })
        .join("\n")
    : "keine";
  // Weitere Ordner mit Dateinamen (z. B. Personalakten-Unterordner aus den Fakten).
  const weitere = [...opts.namenJeOrdner.entries()]
    .filter(([k, n]) => !opts.kandidaten.includes(k) && n.length > 0)
    .slice(0, 8)
    .map(([k, n]) => `- ${k}: ${n.slice(0, 6).join("; ")}`)
    .join("\n");
  const beispiele = opts.beispiele?.length ? opts.beispiele.map(zeileBeispiel).join("\n") : "keine";
  return `Ordnerliste (aktiv, exakte Schreibweise; Einrueckung = Hierarchie):
${baueZzOrdnerBaum(opts.ordner)}${DOKUMENT_MARKER}Dateiname: ${opts.dateiname}
Bisheriger Ablageort in ZZ: ${opts.herkunft.length ? opts.herkunft.join(" / ") : "(direkt in der ZZ-Freigabe)"}

Beschrieb der lokalen KI (gefiltert, ohne sensible Werte${opts.beschrieb.unbekannt ? "; Angaben im Dokument belegt" : ""}):
${zeileBeschrieb(opts.beschrieb)}

Fakten-Hinweise (nur Hinweise, du entscheidest):
${opts.fakten.length ? opts.fakten.map((f) => `- ${f}`).join("\n") : "- keine"}

Firmenwissen des Teams (gilt vor deinen Annahmen):
${opts.wissen?.length ? opts.wissen.join("\n") : "- keines zu diesem Dokument"}

Kandidaten-Ordner (aehnliche Dokumente, Regeln) mit vorhandenen Dateinamen (Benennungsstil):
${kandidaten}${weitere ? `\n\nWeitere Ordner mit Dateinamen:\n${weitere}` : ""}

Bereits vorgeschlagene NEUE Ordner (noch nicht angelegt — passt einer, genau diesen Pfad wieder verwenden, ziel_neu = true):
${opts.neueOrdnerOffen?.length ? opts.neueOrdnerOffen.slice(0, 30).map((p) => `- ${p}`).join("\n") : "keine"}

Fruehere Entscheide des Teams (so hat das Team korrigiert — daran orientieren):
${beispiele}`;
}

export const ZZ_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ziel_ordner", "ziel_neu", "name_vorschlag", "begruendung", "sicherheit", "alternativen", "rueckfragen"],
  properties: {
    ziel_ordner: {
      type: "string",
      description: "Zielordner: exakt ein Pfad aus der Ordnerliste ODER (ziel_neu=true) «<bestehender Eltern-Pfad>/<Neuer_Name>».",
    },
    ziel_neu: { type: "boolean", description: "true, wenn ziel_ordner ein NEUER Ordner ist (noch nicht in der Liste)." },
    name_vorschlag: { type: "string", description: "Neuer Dateiname inkl. Endung des Originals, im Stil des Zielordners." },
    begruendung: { type: "string", description: "Ein kurzer Satz Deutsch (hoechstens 120 Zeichen), ohne Inhaltsdetails." },
    sicherheit: { type: "string", enum: ["hoch", "mittel", "niedrig"] },
    alternativen: {
      type: "array",
      items: { type: "string" },
      description: "Bis zu 2 bestehende Ordner exakt aus der Liste, ohne das Ziel.",
    },
    rueckfragen: {
      type: "array",
      description: "0 bis 2 Rueckfragen ans Team (leer, wenn nichts unklar ist).",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["art", "begriff", "frage"],
        properties: {
          art: { type: "string", enum: ["abkuerzung", "zuordnung", "person", "benennung", "sonstiges"] },
          begriff: { type: "string", description: "Das unklare Wort bzw. der Name, kurz (leer, wenn keiner)." },
          frage: { type: "string", description: "Ein kurzer Satz Deutsch, hoechstens 160 Zeichen, ohne sensible Werte." },
        },
      },
    },
  },
};

/** Echter Claude-Aufruf (nur im App-Ablauf, nie in Tests/Schleifen). Der
 *  Ordnerbaum ist ein eigener, gecachter Block (gleich fuer alle Dokumente). */
export function frageClaudeZz(eingabe: string): Promise<unknown> {
  const i = eingabe.indexOf(DOKUMENT_MARKER);
  const content: Anthropic.ContentBlockParam[] =
    i === -1
      ? [{ type: "text", text: eingabe }]
      : [
          { type: "text", text: eingabe.slice(0, i), cache_control: { type: "ephemeral" } },
          { type: "text", text: eingabe.slice(i) },
        ];
  return structuredCall<unknown>({
    system: ZZ_SYSTEM,
    content,
    toolName: "zz_einordnung",
    toolDescription: "Zielordner (bestehend oder neu), neuer Dateiname, Begruendung, Sicherheit, Alternativen und hoechstens 2 Rueckfragen ans Team fuer ein Dokument aus dem ZZ-Rueckstau.",
    schema: ZZ_SCHEMA,
    // Projektregel: strict-Tool braucht hohes max_tokens (die Antwort selbst ist klein).
    maxTokens: 8192,
  });
}

// ── Pruefung der Antwort ────────────────────────────────────────────────

export interface ZzEntscheid {
  ziel_ordner: string;
  ziel_neu: boolean;
  name_vorschlag: string | null;
  begruendung: string;
  sicherheit: OrdnerSicherheit;
  alternativen: string[];
  /** Rueckfragen roh (hoechstens 4) — geprueft und gefiltert in lib/ki/wissen leseRueckfragen. */
  rueckfragen: unknown[];
}

const SICHERHEITEN: readonly OrdnerSicherheit[] = ["hoch", "mittel", "niedrig"];

/** Antwort absichern. `aktiv` = aktive Ordner in NFC. Ziel bestehend: muss
 *  in `aktiv` stehen, nie ZZ/99_System. Ziel neu: Eltern in `aktiv`, Name
 *  wie beim «Ordner anlegen» (leseOrdnerName), nicht schon vorhanden (dann
 *  bestehend), nicht oberste Ebene. Sonst null. Neuer Ordner hoechstens
 *  «mittel». Name ueber pruefeNeuenDateinamen (Endung, Inhalts-Filter). */
export function validiereZzEntscheid(roh: unknown, opts: { aktiv: ReadonlySet<string>; originalName: string }): ZzEntscheid | null {
  const r = roh && typeof roh === "object" && !Array.isArray(roh) ? (roh as Record<string, unknown>) : null;
  if (!r || typeof r.ziel_ordner !== "string") return null;
  const ziel = r.ziel_ordner.normalize("NFC").trim().replace(/\/+$/, "");
  if (!ziel || ziel.includes("..") || ziel.startsWith("/") || zielGesperrt(ziel)) return null;
  let neu = r.ziel_neu === true;
  if (opts.aktiv.has(ziel)) neu = false;
  else if (!neu) return null;
  if (neu) {
    const i = ziel.lastIndexOf("/");
    if (i <= 0) return null;
    const eltern = ziel.slice(0, i);
    const name = leseOrdnerName(ziel.slice(i + 1));
    if (!opts.aktiv.has(eltern) || !name || name !== ziel.slice(i + 1)) return null;
  }
  const alternativen: string[] = [];
  if (Array.isArray(r.alternativen)) {
    for (const a of r.alternativen as unknown[]) {
      if (alternativen.length >= 2 || typeof a !== "string") continue;
      const p = a.normalize("NFC").trim();
      if (p && p !== ziel && opts.aktiv.has(p) && !zielGesperrt(p) && !alternativen.includes(p)) alternativen.push(p);
    }
  }
  let sicherheit: OrdnerSicherheit = SICHERHEITEN.includes(r.sicherheit as OrdnerSicherheit) ? (r.sicherheit as OrdnerSicherheit) : "niedrig";
  if (neu && sicherheit === "hoch") sicherheit = "mittel";
  const begruendungRoh = typeof r.begruendung === "string" ? r.begruendung.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  const begruendung = begruendungRoh && !inhaltImNamen(begruendungRoh) ? begruendungRoh : "";
  return {
    ziel_ordner: ziel,
    ziel_neu: neu,
    name_vorschlag: pruefeNeuenDateinamen(r.name_vorschlag, opts.originalName),
    begruendung,
    sicherheit,
    alternativen,
    rueckfragen: Array.isArray(r.rueckfragen) ? (r.rueckfragen as unknown[]).slice(0, 4) : [],
  };
}
