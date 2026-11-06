// Reine Regeln des Vermietungs-Ablaufs (keine DB, keine KI) — getestet in schritte.test.ts.
//
// Grundsätze:
//  - Aktueller Schritt = kleinster nicht erledigter (alle erledigt → 5).
//  - Ein Schritt erledigt ⇒ alle davor auch (eine Bestätigung setzt die Konditionen voraus).
//    «Zurück» auf Schritt N öffnet N und alle danach.
//  - Schritt 5 (Übergabe erfolgt) setzt nur ein Mensch, nie eine Mail.
//  - Ab Schritt 2 erledigt gilt das Datum als fixiert (Zusage) → Auftrag 'offen'.
//  - Die KI ergänzt nur LEERE Felder und nie solche, die ein Mensch gesetzt hat.
//  - Jede Wirkung wird als AblaufWirkung festgehalten; «Rückgängig» kehrt genau sie um und
//    lässt spätere Änderungen anderer Herkunft stehen.

import { isoZuZuerich, zuerichZuIso } from "@/lib/stempel-meldungen";
import {
  ARBEIT_LEER,
  BOOL_FELDER,
  FELDER_LEER,
  TEXT_FELDER,
  type Ablauf,
  type AblaufArbeit,
  type AblaufFelder,
  type AblaufWirkung,
  type FeldName,
  type FeldQuelle,
  type MailArt,
  type SchrittNr,
} from "./typen";

export const ALLE_SCHRITTE: readonly SchrittNr[] = [1, 2, 3, 4, 5];

export function istSchritt(n: unknown): n is SchrittNr {
  return n === 1 || n === 2 || n === 3 || n === 4 || n === 5;
}

/** Erledigte Schritte sortiert, ohne Duplikate/Fremdwerte. */
export function erledigtSauber(werte: readonly unknown[] | null | undefined): SchrittNr[] {
  const s = new Set<SchrittNr>();
  for (const w of werte ?? []) {
    const n = typeof w === "string" ? Number(w) : w;
    if (istSchritt(n)) s.add(n);
  }
  return [...s].sort((a, b) => a - b);
}

export function aktuellerSchritt(erledigt: readonly SchrittNr[]): SchrittNr {
  for (const n of ALLE_SCHRITTE) if (!erledigt.includes(n)) return n;
  return 5;
}

/** Schritt N (und alle davor) erledigen → neue Liste + was neu dazukam. */
export function setzeErledigt(erledigt: readonly SchrittNr[], schritt: SchrittNr): { erledigt: SchrittNr[]; plus: SchrittNr[] } {
  const plus = ALLE_SCHRITTE.filter((n) => n <= schritt && !erledigt.includes(n));
  return { erledigt: erledigtSauber([...erledigt, ...plus]), plus };
}

/** Schritt N (und alle danach) wieder öffnen → neue Liste + was wegfiel. */
export function nimmZurueck(erledigt: readonly SchrittNr[], schritt: SchrittNr): { erledigt: SchrittNr[]; minus: SchrittNr[] } {
  const minus = erledigt.filter((n) => n >= schritt);
  return { erledigt: erledigt.filter((n) => n < schritt), minus: [...minus] };
}

// ── Felder ───────────────────────────────────────────────────────

const QUELLE_KEY = "_quelle";

function istTextFeld(k: string): k is (typeof TEXT_FELDER)[number] {
  return (TEXT_FELDER as readonly string[]).includes(k);
}
function istBoolFeld(k: string): k is (typeof BOOL_FELDER)[number] {
  return (BOOL_FELDER as readonly string[]).includes(k);
}

/** Begrenzung je Textfeld (Schutz vor Riesentexten aus Mails/Eingaben). */
const TEXT_MAX: Partial<Record<FeldName, number>> = { bemerkungen: 2000, programm: 1000, catering: 500, adresse: 300 };
const TEXT_MAX_STANDARD = 200;

/** Unbekanntes in ein sauberes Teil-Objekt: nur bekannte Felder, richtige Typen, getrimmt. */
export function felderSauber(roh: unknown): Partial<AblaufFelder> {
  const out: Partial<Record<FeldName, string | boolean>> = {};
  if (!roh || typeof roh !== "object") return out as Partial<AblaufFelder>;
  for (const [k, v] of Object.entries(roh as Record<string, unknown>)) {
    if (istTextFeld(k) && typeof v === "string") {
      let t = v.replace(/\s+/g, (m) => (m.includes("\n") ? "\n" : " ")).trim();
      t = t.slice(0, TEXT_MAX[k] ?? TEXT_MAX_STANDARD);
      if (k === "datum" && t && !/^\d{4}-\d{2}-\d{2}$/.test(t)) continue;
      if (k === "beginn" && t) {
        // «18:00», «18.30», «18h», «18 Uhr», «ca. 18 Uhr», «ab 19h»
        const m = /^(?:ca\.?\s*|ab\s*)?(\d{1,2})(?:\s*[:.h]\s*(\d{2}))?(?!\d)/i.exec(t);
        if (!m || Number(m[1]) > 23 || Number(m[2] ?? 0) > 59) continue;
        t = `${m[1].padStart(2, "0")}:${m[2] ?? "00"}`;
      }
      if (k === "email" && t && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) continue;
      out[k] = k === "email" ? t.toLowerCase() : t;
    } else if (istBoolFeld(k) && typeof v === "boolean") {
      out[k] = v;
    }
  }
  return out as Partial<AblaufFelder>;
}

/** felder-jsonb aus der DB → vollständige Felder + Herkunft. */
export function felderAusDb(roh: unknown): { felder: AblaufFelder; quelle: Partial<Record<FeldName, FeldQuelle>> } {
  const felder: AblaufFelder = { ...FELDER_LEER, ...felderSauber(roh) };
  const quelle: Partial<Record<FeldName, FeldQuelle>> = {};
  const q = roh && typeof roh === "object" ? (roh as Record<string, unknown>)[QUELLE_KEY] : null;
  if (q && typeof q === "object") {
    for (const [k, v] of Object.entries(q as Record<string, unknown>)) {
      if ((istTextFeld(k) || istBoolFeld(k)) && (v === "mail" || v === "manuell")) quelle[k] = v;
    }
  }
  return { felder, quelle };
}

/** Felder + Herkunft (+ Arbeitsstand der Übergabe) → felder-jsonb für die DB (nur gesetzte Werte). */
export function felderZuDb(
  felder: AblaufFelder,
  quelle: Partial<Record<FeldName, FeldQuelle>>,
  arbeit: AblaufArbeit = ARBEIT_LEER,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of TEXT_FELDER) if (felder[k]) out[k] = felder[k];
  for (const k of BOOL_FELDER) if (felder[k] || quelle[k]) out[k] = felder[k];
  if (arbeit.uebergabe_haken.length) out[HAKEN_KEY] = [...arbeit.uebergabe_haken];
  if (arbeit.poller_freigeschaltet) out[POLLER_KEY] = true;
  out[QUELLE_KEY] = { ...quelle };
  return out;
}

// ── Arbeitsstand der Übergabe (Haken, Poller) ─────────────────────
// Liegt in felder-jsonb, ist aber kein Formularfeld: felderSauber/felderErgaenzen kennen die Schlüssel
// nicht, die Mail-KI kann sie also weder lesen noch setzen. Nur PATCH (Mensch) ändert sie.

const HAKEN_KEY = "uebergabe_haken";
const POLLER_KEY = "poller_freigeschaltet";
const HAKEN_MAX = 60;
const HAKEN_LAENGE = 200;

/** felder-jsonb → Arbeitsstand (Unbrauchbares wird verworfen). */
export function arbeitAusDb(roh: unknown): AblaufArbeit {
  const r = roh && typeof roh === "object" && !Array.isArray(roh) ? (roh as Record<string, unknown>) : {};
  const h = Array.isArray(r[HAKEN_KEY]) ? (r[HAKEN_KEY] as unknown[]) : [];
  const haken = [...new Set(h.filter((x): x is string => typeof x === "string" && x.trim() !== "" && x.length <= HAKEN_LAENGE))].slice(0, HAKEN_MAX);
  return { uebergabe_haken: haken, poller_freigeschaltet: r[POLLER_KEY] === true };
}

/** PATCH-Body → geänderter Arbeitsstand (nur die gesendeten Schlüssel) oder Fehlertext. */
export function arbeitAusPatch(body: Record<string, unknown>): { arbeit: Partial<AblaufArbeit> } | { fehler: string } {
  const arbeit: Partial<AblaufArbeit> = {};
  if (HAKEN_KEY in body) {
    const h = body[HAKEN_KEY];
    if (!Array.isArray(h) || h.length > HAKEN_MAX || !h.every((x) => typeof x === "string" && x.trim() !== "" && x.length <= HAKEN_LAENGE)) {
      return { fehler: "Ungültige Übergabe-Haken" };
    }
    arbeit.uebergabe_haken = [...new Set(h as string[])];
  }
  if (POLLER_KEY in body) {
    if (typeof body[POLLER_KEY] !== "boolean") return { fehler: "Ungültiger Wert für «Poller freigeschaltet»" };
    arbeit.poller_freigeschaltet = body[POLLER_KEY] as boolean;
  }
  return { arbeit };
}

type FelderAenderung = {
  felder: AblaufFelder;
  quelle: Partial<Record<FeldName, FeldQuelle>>;
  /** nur die geänderten Felder */
  vorher: Partial<AblaufFelder>;
  neu: Partial<AblaufFelder>;
  quelleVorher: Partial<Record<FeldName, FeldQuelle | null>>;
};

function setzeFeld(a: FelderAenderung, k: FeldName, v: string | boolean, quelle: FeldQuelle) {
  (a.vorher as Record<string, unknown>)[k] = a.felder[k];
  a.quelleVorher[k] = a.quelle[k] ?? null;
  (a.felder as unknown as Record<string, unknown>)[k] = v;
  (a.neu as Record<string, unknown>)[k] = v;
  a.quelle[k] = quelle;
}

/** KI-Ergänzung: nur leere Textfelder bzw. nie gesetzte Ja/Nein-Felder; manuell Gesetztes bleibt. */
export function felderErgaenzen(
  felder: AblaufFelder,
  quelle: Partial<Record<FeldName, FeldQuelle>>,
  vorschlag: Partial<AblaufFelder>,
): FelderAenderung {
  const a: FelderAenderung = { felder: { ...felder }, quelle: { ...quelle }, vorher: {}, neu: {}, quelleVorher: {} };
  const sauber = felderSauber(vorschlag);
  for (const k of TEXT_FELDER) {
    const v = sauber[k];
    if (!v || quelle[k] === "manuell" || felder[k]) continue;
    setzeFeld(a, k, v, "mail");
  }
  for (const k of BOOL_FELDER) {
    const v = sauber[k];
    if (typeof v !== "boolean" || quelle[k] || felder[k] === v) continue;
    setzeFeld(a, k, v, "mail");
  }
  return a;
}

/** Manuelle Änderung (PATCH): überschreibt alles, markiert «manuell». Leerer Text = Feld leeren. */
export function felderManuell(
  felder: AblaufFelder,
  quelle: Partial<Record<FeldName, FeldQuelle>>,
  patch: unknown,
): FelderAenderung {
  const a: FelderAenderung = { felder: { ...felder }, quelle: { ...quelle }, vorher: {}, neu: {}, quelleVorher: {} };
  if (!patch || typeof patch !== "object") return a;
  const roh = patch as Record<string, unknown>;
  const sauber = felderSauber(roh);
  for (const k of TEXT_FELDER) {
    if (!(k in roh)) continue;
    const v = typeof roh[k] === "string" && (roh[k] as string).trim() === "" ? "" : sauber[k];
    if (typeof v !== "string" || v === felder[k]) continue;
    setzeFeld(a, k, v, "manuell");
  }
  for (const k of BOOL_FELDER) {
    const v = sauber[k];
    if (typeof v !== "boolean" || v === felder[k]) continue;
    setzeFeld(a, k, v, "manuell");
  }
  return a;
}

/** Ungültige manuelle Werte (z. B. Datum im falschen Format) — für die 400-Antwort. */
export function felderPatchFehler(patch: unknown): string | null {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return "felder muss ein Objekt sein";
  const roh = patch as Record<string, unknown>;
  const sauber = felderSauber(roh) as Record<string, unknown>;
  for (const [k, v] of Object.entries(roh)) {
    if (!istTextFeld(k) && !istBoolFeld(k)) return `Unbekanntes Feld «${k}»`;
    if (istTextFeld(k) && typeof v === "string" && v.trim() === "") continue;
    if (!(k in sauber)) return `Ungültiger Wert für «${k}»`;
  }
  return null;
}

/** Felder einer Wirkung zurücknehmen — nur dort, wo noch der damals gesetzte Wert steht. */
export function felderZuruecknehmen(
  felder: AblaufFelder,
  quelle: Partial<Record<FeldName, FeldQuelle>>,
  w: Pick<AblaufWirkung, "felder_vorher" | "felder_neu" | "quelle_vorher">,
): { felder: AblaufFelder; quelle: Partial<Record<FeldName, FeldQuelle>>; zurueck: FeldName[] } {
  const f = { ...felder } as unknown as Record<string, unknown>;
  const q = { ...quelle };
  const zurueck: FeldName[] = [];
  for (const [k, neu] of Object.entries(w.felder_neu ?? {})) {
    if (!istTextFeld(k) && !istBoolFeld(k)) continue;
    if (f[k] !== neu) continue; // inzwischen anders gesetzt → stehen lassen
    f[k] = (w.felder_vorher as Record<string, unknown> | undefined)?.[k] ?? FELDER_LEER[k];
    const qv = w.quelle_vorher?.[k];
    if (qv) q[k] = qv;
    else delete q[k];
    zurueck.push(k);
  }
  return { felder: f as unknown as AblaufFelder, quelle: q, zurueck };
}

// ── Absender ─────────────────────────────────────────────────────

const EIGENE_DOMAIN = "eventline-basel.com";

/** Reine E-Mail-Adresse aus «Name <x@y>» (klein geschrieben). */
export function nurAdresse(s: string): string {
  const m = /<([^>]+)>/.exec(s);
  return (m ? m[1] : s).trim().toLowerCase();
}

/** Absender ist EVENTLINE: die reine Adresse endet exakt auf «@eventline-basel.com»
 *  (nicht «…@eventline-basel.com.evil.ch», nicht ein Anzeigename mit dieser Adresse). */
export function istEventlineAdresse(adresse: string): boolean {
  return nurAdresse(adresse).endsWith(`@${EIGENE_DOMAIN}`);
}

/** Adresse irgendeiner EVENTLINE-Domain (auch Subdomains wie in.eventline-basel.com) — nie Mieter-Mail. */
export function istEventlineDomain(adresse: string): boolean {
  const a = nurAdresse(adresse);
  return a.endsWith(`@${EIGENE_DOMAIN}`) || a.endsWith(`.${EIGENE_DOMAIN}`);
}

export type AbsenderRolle = "eventline" | "partner" | "mieter" | "fremd";

/** Wer hat die Mail geschickt? partnerAdressen = aktive Partner-Konten DIESER Location. */
export function absenderRolle(von: string, opts: { mieterEmail: string; partnerAdressen: readonly string[] }): AbsenderRolle {
  const a = nurAdresse(von);
  if (!a) return "fremd";
  if (istEventlineAdresse(a)) return "eventline";
  if (opts.partnerAdressen.some((p) => p && nurAdresse(p) === a)) return "partner";
  const mieter = opts.mieterEmail ? nurAdresse(opts.mieterEmail) : "";
  if (mieter && mieter === a) return "mieter";
  return "fremd";
}

const AN_KUNDE: readonly MailArt[] = ["konditionen_an_kunde", "bestaetigung_an_kunde", "vertrag_an_kunde"];
const VOM_KUNDEN: readonly MailArt[] = ["zusage_kunde", "vertrag_unterschrieben"];

/**
 * Prüfung im Code (nicht nur KI), was eine Mail bewirken darf:
 *  - «…_an_kunde» nur von EVENTLINE,
 *  - Zusage/Unterschrift nur vom Mieter (felder.email), EVENTLINE oder dem Partner der Location,
 *  - das Feld «E-Mail» nur aus Mails von EVENTLINE oder dem Partner.
 * Sonst gilt die Mail als «sonstiges» (kein Schritt/keine Zusage).
 */
export function einordnungPruefen(
  e: { art: MailArt; felder: Partial<AblaufFelder> },
  rolle: AbsenderRolle,
): { art: MailArt; felder: Partial<AblaufFelder> } {
  let art = e.art;
  if (AN_KUNDE.includes(art) && rolle !== "eventline") art = "sonstiges";
  if (VOM_KUNDEN.includes(art) && rolle === "fremd") art = "sonstiges";
  const felder = { ...e.felder };
  if ("email" in felder && rolle !== "eventline" && rolle !== "partner") delete felder.email;
  return { art, felder };
}

/** Name für den Mieter-Vergleich: klein, ohne Akzente/Satzzeichen, Wörter sortiert («Muster, Anna» = «anna muster»). */
export function mieterNameNorm(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

/** Gehört eine neue Anfrage zum selben Mieter wie ein bestehender Auftrag? (E-Mail oder normalisierter Name) */
export function gleicherMieter(
  neu: { emails: readonly string[]; name: string },
  bestehend: { emails: readonly string[]; name: string },
): boolean {
  const a = new Set(neu.emails.map(nurAdresse).filter(Boolean));
  if (bestehend.emails.map(nurAdresse).some((e) => e && a.has(e))) return true;
  const n = mieterNameNorm(neu.name);
  return n !== "" && n === mieterNameNorm(bestehend.name);
}

// ── Neue Anfrage: bestehende Aufträge am selben Tag ──────────────

/** Nicht stornierter, nicht gelöschter Auftrag an der Location, der den Tag berührt. */
export type TagesAuftrag = {
  id: string;
  created_at: string;
  hatAblauf: boolean;
  /** Mieter-Mail(s): felder.email des Ablaufs, contact_email */
  emails: string[];
  /** Mieter: felder.mieter des Ablaufs, sonst contact_person */
  name: string;
};

export type TagesEntscheid = { art: "neu" } | { art: "bestehend"; jobId: string } | { art: "warten" };

/**
 * Wohin mit einer neuen Anfrage für Location + Tag?
 *  - genau ein Ablauf-Auftrag desselben Mieters (E-Mail oder Name) → dorthin,
 *  - mehrere passende oder irgendein anderer (nicht passender) Auftrag am Tag → warten (Admin entscheidet),
 *  - sonst neu anlegen.
 */
export function anfrageAmTag(bestehend: readonly TagesAuftrag[], neu: { emails: readonly string[]; name: string }): TagesEntscheid {
  const passend = bestehend.filter((j) => j.hatAblauf && gleicherMieter(neu, j));
  if (passend.length === 1) return { art: "bestehend", jobId: passend[0].id };
  if (passend.length > 1 || bestehend.length > 0) return { art: "warten" };
  return { art: "neu" };
}

function aelterAls(a: Pick<TagesAuftrag, "id" | "created_at">, b: Pick<TagesAuftrag, "id" | "created_at">): boolean {
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  return ta !== tb ? ta < tb : a.id < b.id;
}

/**
 * Nach dem Anlegen (zwei Mails gleichzeitig): gibt es einen ÄLTEREN Auftrag am Tag, wird der eigene
 * wieder verworfen — die Mail geht an den älteren Ablauf-Auftrag desselben Mieters, sonst wartet sie.
 * Beide Läufe sehen dieselbe Reihenfolge (created_at, dann id) → genau einer bleibt.
 */
export function nachAnlage(
  alle: readonly TagesAuftrag[],
  eigeneId: string,
  neu: { emails: readonly string[]; name: string },
): { art: "behalten" } | { art: "verwerfen"; ziel: string | null } {
  const ich = alle.find((j) => j.id === eigeneId);
  if (!ich) return { art: "behalten" };
  const aeltere = alle.filter((j) => j.id !== eigeneId && aelterAls(j, ich));
  if (!aeltere.length) return { art: "behalten" };
  const e = anfrageAmTag(aeltere, neu);
  return { art: "verwerfen", ziel: e.art === "bestehend" ? e.jobId : null };
}

// ── Mail-Einordnung → Wirkung ────────────────────────────────────

/** Welchen Schritt eine Mail-Art erledigt (null = keinen). Schritt 5 nie per Mail. */
export function schrittFuerMailArt(art: MailArt, anhaengeAnzahl: number): SchrittNr | null {
  switch (art) {
    case "konditionen_an_kunde":
      return 1;
    case "bestaetigung_an_kunde":
      return 2;
    case "vertrag_an_kunde":
      return anhaengeAnzahl > 0 ? 3 : null;
    case "vertrag_unterschrieben":
      return 4;
    default:
      return null;
  }
}

/** Fixiert die Mail-Art bzw. der erledigte Schritt das Datum (Zusage)? */
export function fixiertDurch(art: MailArt | null, schritt: SchrittNr | null): boolean {
  return art === "zusage_kunde" || (schritt !== null && schritt >= 2);
}

export const MAIL_ART_TEXT: Record<MailArt, string> = {
  konditionen_an_kunde: "Mail an Kunde mit Konditionen erkannt",
  zusage_kunde: "Zusage erkannt",
  bestaetigung_an_kunde: "Bestätigungs-Mail an Kunde erkannt",
  vertrag_an_kunde: "Vertrags-Mail erkannt",
  vertrag_unterschrieben: "Unterschriebener Vertrag erkannt",
  felder_ergaenzung: "Ergänzung erkannt",
  sonstiges: "Mail ohne Wirkung",
};

export const FELD_LABEL: Record<FeldName, string> = {
  datum: "Datum", mieter: "Mieter", telefon: "Telefon", adresse: "Adresse", email: "E-Mail", anlass: "Anlass",
  beginn: "Beginn", gaeste: "Gäste", catering: "Catering", programm: "Programm", stellwand: "Stellwand",
  bier: "Bier", buffettisch: "Buffettisch", vorhang: "Vorhang offen", tonanlage: "Tonanlage",
  djMischpult: "DJ-Mischpult", disco: "Disco", buehneLicht: "Bühnenlicht", pollerName: "Poller (Name)",
  pollerMobil: "Poller (Mobil)", komplettservice: "Komplettservice", preisKomplettservice: "Preis Komplettservice",
  bemerkungen: "Bemerkungen",
};

export function felderText(neu: Partial<AblaufFelder>): string {
  const teile = Object.entries(neu).map(([k, v]) => {
    const label = FELD_LABEL[k as FeldName] ?? k;
    if (typeof v === "boolean") return `${label}: ${v ? "ja" : "nein"}`;
    const s = String(v);
    return `${label} (${s.length > 40 ? s.slice(0, 39) + "…" : s})`;
  });
  return teile.join(", ");
}

// ── Phase & Übergabe ─────────────────────────────────────────────

export type AblaufPhase = "schritte" | "laeuft" | "abrechnung" | "abgeschlossen";

/** schritte = 1–5 offen; laeuft = Übergabe erfolgt, Event noch nicht vorbei;
 *  abrechnung = nach Event-Ende (Rapport & Abschluss); abgeschlossen = abgeschlossen_am gesetzt. */
export function ablaufPhase(a: Pick<Ablauf, "erledigt" | "abgeschlossen_am">, eventEnde: string | null, jetzt: Date = new Date()): AblaufPhase {
  if (a.abgeschlossen_am) return "abgeschlossen";
  if (!a.erledigt.includes(5)) return "schritte";
  if (eventEnde && Date.parse(eventEnde) <= jetzt.getTime()) return "abrechnung";
  return "laeuft";
}

/** Zürcher Wandzeit → UTC-ISO, mit dem Offset der konkreten Uhrzeit (zuerichZuIso). Eine Uhrzeit,
 *  die es am Umstellungstag nicht gibt (02:xx im März), wird um eine Stunde nach hinten geschoben. */
export function zuerichIso(tag: string, zeit = "00:00"): string {
  const iso = zuerichZuIso(tag, zeit);
  if (iso) return iso;
  const m = /^(\d{2}):(\d{2})$/.exec(zeit);
  const spaeter = m ? `${String(Math.min(23, Number(m[1]) + 1)).padStart(2, "0")}:${m[2]}` : "00:00";
  return zuerichZuIso(tag, spaeter) ?? new Date(`${tag}T${zeit}:00Z`).toISOString();
}

/** Standard-Übergabe: 14:00 am Veranstaltungstag (1 h). */
export function uebergabeStandard(tag: string): string {
  return zuerichIso(tag, "14:00");
}

/** Übergabe auf einen neuen Tag verschieben — gleiche Zürcher Uhrzeit. */
export function uebergabeVerschieben(bisher: string, neuerTag: string): string {
  return zuerichIso(neuerTag, isoZuZuerich(bisher).zeit);
}

/** Auftrags-Zeitraum aus Datum + Beginn: Start = Beginn (sonst 00:00), Ende = 23:59 desselben Tages. */
export function jobZeitraum(f: Pick<AblaufFelder, "datum" | "beginn">): { start_date: string; end_date: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.datum)) return null;
  const beginn = /^\d{2}:\d{2}$/.test(f.beginn) ? f.beginn : "00:00";
  return { start_date: zuerichIso(f.datum, beginn), end_date: zuerichIso(f.datum, "23:59") };
}

/** Datum/Beginn geändert: Start neu, die bisherige Dauer (Ende − Start) bleibt. Ohne bisheriges Ende
 *  (oder unbrauchbare Werte) gilt 23:59 des Tages wie bei der Anlage. */
export function jobZeitraumVerschieben(
  f: Pick<AblaufFelder, "datum" | "beginn">,
  bisher: { start_date: string | null; end_date: string | null },
): { start_date: string; end_date: string } | null {
  const z = jobZeitraum(f);
  if (!z) return null;
  const s = bisher.start_date ? Date.parse(bisher.start_date) : NaN;
  const e = bisher.end_date ? Date.parse(bisher.end_date) : NaN;
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return z;
  return { start_date: z.start_date, end_date: new Date(Date.parse(z.start_date) + (e - s)).toISOString() };
}

/** Titel eines neuen Auftrags: «<Anlass> <Mieter>». */
export function jobTitel(f: Pick<AblaufFelder, "anlass" | "mieter">): string {
  const t = [f.anlass.trim(), f.mieter.trim()].filter(Boolean).join(" ");
  return (t || "Privatanlass").slice(0, 200);
}

// ── Wirkung planen / umkehren ────────────────────────────────────

/** Was am Ablauf zählt, um eine Wirkung zu planen. */
export type AblaufZustand = {
  erledigt: SchrittNr[];
  fixiert_am: string | null;
  unterschrieben_am: string | null;
  felder: AblaufFelder;
  quelle: Partial<Record<FeldName, FeldQuelle>>;
  /** jobs.status */
  jobStatus: string | null;
};

export type WirkungsPlan = {
  /** Schritt (und alle davor) erledigen */
  erledigen?: SchrittNr;
  /** Schritt (und alle danach) wieder öffnen */
  zurueck?: SchrittNr;
  /** Datum fixieren (Zusage) */
  fixieren?: boolean;
  felder?: FelderAenderung;
};

export type GeplanteWirkung = {
  neu: Omit<AblaufZustand, "jobStatus">;
  /** neuer Auftragsstatus, null = unverändert */
  jobStatus: "offen" | "anfrage" | null;
  wirkung: AblaufWirkung;
  /** true = nichts geändert (kein Ereignis nötig) */
  leer: boolean;
};

export function planeWirkung(z: AblaufZustand, p: WirkungsPlan, jetzt: string): GeplanteWirkung {
  const neu = { erledigt: [...z.erledigt], fixiert_am: z.fixiert_am, unterschrieben_am: z.unterschrieben_am, felder: z.felder, quelle: z.quelle };
  const w: AblaufWirkung = {};
  let jobStatus: GeplanteWirkung["jobStatus"] = null;
  let fixieren = p.fixieren === true;

  if (p.erledigen) {
    const r = setzeErledigt(neu.erledigt, p.erledigen);
    neu.erledigt = r.erledigt;
    if (r.plus.length) w.erledigt_plus = r.plus;
    if (p.erledigen >= 4 && !neu.unterschrieben_am) {
      neu.unterschrieben_am = jetzt;
      w.unterschrieben = true;
    }
    if (fixiertDurch(null, p.erledigen)) fixieren = true;
  }
  if (p.zurueck) {
    const r = nimmZurueck(neu.erledigt, p.zurueck);
    neu.erledigt = r.erledigt;
    if (r.minus.length) w.erledigt_minus = r.minus;
    if (p.zurueck <= 4 && neu.unterschrieben_am) {
      w.unterschrieben_entfernt = neu.unterschrieben_am;
      neu.unterschrieben_am = null;
    }
  }
  if (fixieren && !neu.fixiert_am) {
    neu.fixiert_am = jetzt;
    w.fixiert = { status_vorher: z.jobStatus };
    if (z.jobStatus === "anfrage") jobStatus = "offen";
  }
  if (p.felder && Object.keys(p.felder.neu).length) {
    neu.felder = p.felder.felder;
    neu.quelle = p.felder.quelle;
    w.felder_vorher = p.felder.vorher;
    w.felder_neu = p.felder.neu;
    w.quelle_vorher = p.felder.quelleVorher;
  }
  return { neu, jobStatus, wirkung: w, leer: Object.keys(w).length === 0 };
}

/**
 * Kehrt eine festgehaltene Wirkung um (Rückgängig) und bringt den Ablauf wieder in einen
 * gültigen Zustand:
 *  - erledigt = lückenlos 1..max der verbleibenden erledigten Schritte,
 *  - fixiert_am bleibt, solange ein Schritt ≥ 2 erledigt ist oder ein anderes, noch wirksames
 *    Ereignis das Datum fixiert hat (`fixiertDurchAndere`),
 *  - unterschrieben_am fällt nur weg, wenn Schritt 4 nicht mehr erledigt ist,
 *  - Auftragsstatus passend: fixiert → 'offen', sonst 'anfrage' (nur zwischen diesen beiden).
 */
export function kehreUm(
  z: AblaufZustand,
  w: AblaufWirkung,
  opts: { fixiertDurchAndere?: boolean } = {},
): { neu: Omit<AblaufZustand, "jobStatus">; jobStatus: "offen" | "anfrage" | null } {
  let roh = [...z.erledigt];
  if (w.erledigt_plus?.length) roh = roh.filter((n) => !w.erledigt_plus!.includes(n));
  if (w.erledigt_minus?.length) roh = erledigtSauber([...roh, ...w.erledigt_minus]);
  const max = roh.length ? Math.max(...roh) : 0;
  const erledigt = ALLE_SCHRITTE.filter((n) => n <= max);

  let { fixiert_am, unterschrieben_am, felder, quelle } = z;
  if (w.fixiert && !erledigt.some((n) => n >= 2) && !opts.fixiertDurchAndere) fixiert_am = null;
  if (w.unterschrieben && !erledigt.includes(4)) unterschrieben_am = null;
  if (w.unterschrieben_entfernt && erledigt.includes(4)) unterschrieben_am = unterschrieben_am ?? w.unterschrieben_entfernt;
  if (w.felder_neu) ({ felder, quelle } = felderZuruecknehmen(felder, quelle, w));

  // Status nur nachführen, wenn die Wirkung Schritte/Fixierung betraf (reine Feld-Rücknahme lässt ihn).
  let jobStatus: "offen" | "anfrage" | null = null;
  const betrifftStatus = !!(w.fixiert || w.erledigt_plus?.length || w.erledigt_minus?.length);
  if (betrifftStatus && (z.jobStatus === "offen" || z.jobStatus === "anfrage")) {
    const soll = fixiert_am ? "offen" : "anfrage";
    // War der Auftrag schon vor der Fixierung 'offen' (nicht aus einer Anfrage), bleibt er es.
    const warNieAnfrage = soll === "anfrage" && !!w.fixiert && w.fixiert.status_vorher !== "anfrage";
    if (soll !== z.jobStatus && !warNieAnfrage) jobStatus = soll;
  }
  return { neu: { erledigt, fixiert_am, unterschrieben_am, felder, quelle }, jobStatus };
}

/** Hat das Ereignis überhaupt etwas zum Zurücknehmen? */
export function wirkungVorhanden(w: unknown): w is AblaufWirkung {
  return !!w && typeof w === "object" && Object.keys(w as object).length > 0;
}
