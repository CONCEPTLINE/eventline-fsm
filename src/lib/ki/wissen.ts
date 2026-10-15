// Wissen der KI (Technik-Seite, Tab «Wissen», Migration 344; Mischa 2026-10-16):
// Eintraege, die Admins pflegen — Abkuerzung/Begriff, Benennungsregel,
// Zuordnung «X gehoert zu Y», Ansprechpartner/Rolle, Ordner-Hinweis,
// Sonstiges —, und die Rueckfragen, die Claude beim Ordner-/Namensentscheid
// im Rueckstau ZZ stellt (0–2 je Dokument, dedupliziert).
//
// Hier alles Reine (getestet): Eingaben pruefen, Relevanzauswahl fuer den
// Claude-Prompt (Begriff/Bezug im Dateinamen, Ablageort, Beschrieb, in den
// Kandidaten oder Fakten + alle Benennungsregeln, mit Budget), die Zeilen
// fuer Claude und das Rig, Rueckfragen lesen/filtern (gleicher Filter wie der
// Beschrieb) und ihr Dedup-Schluessel. Dazu die Lader (Admin-Client).

import type { createAdminClient } from "@/lib/supabase/admin";
import { inhaltImNamen } from "./dateiname";
import { enthaeltSensibles, type ZzBeschrieb } from "./zz-entscheid";

type Admin = ReturnType<typeof createAdminClient>;

export const WISSEN_KATEGORIEN = ["abkuerzung", "benennung", "zuordnung", "ansprechpartner", "ordner", "sonstiges"] as const;
export type WissenKategorie = (typeof WISSEN_KATEGORIEN)[number];
export const WISSEN_KATEGORIE_TEXT: Readonly<Record<WissenKategorie, string>> = {
  abkuerzung: "Abkürzung/Begriff",
  benennung: "Benennungsregel",
  zuordnung: "Zuordnung",
  ansprechpartner: "Ansprechpartner/Rolle",
  ordner: "Ordner-Hinweis",
  sonstiges: "Sonstiges",
};

export const BEZUG_ARTEN = ["location", "kunde", "lieferant", "person"] as const;
export type BezugArt = (typeof BEZUG_ARTEN)[number];
export const BEZUG_ART_TEXT: Readonly<Record<BezugArt, string>> = {
  location: "Location",
  kunde: "Kunde",
  lieferant: "Lieferant",
  person: "Person",
};

export const FRAGE_ARTEN = ["abkuerzung", "zuordnung", "person", "benennung", "sonstiges"] as const;
export type FrageArt = (typeof FRAGE_ARTEN)[number];
export const FRAGE_ART_TEXT: Readonly<Record<FrageArt, string>> = {
  abkuerzung: "Abkürzung",
  zuordnung: "Zuordnung",
  person: "Person",
  benennung: "Benennung",
  sonstiges: "Sonstiges",
};
/** Vorschlag fuer die Kategorie, wenn eine Frage beantwortet wird (editierbar). */
export const KATEGORIE_FUER_FRAGE: Readonly<Record<FrageArt, WissenKategorie>> = {
  abkuerzung: "abkuerzung",
  zuordnung: "zuordnung",
  person: "ansprechpartner",
  benennung: "benennung",
  sonstiges: "sonstiges",
};

export const BEGRIFF_MAX = 120;
export const ERKLAERUNG_MAX = 1000;
export const FRAGE_MAX = 300;
export const BEZUG_NAME_MAX = 160;
/** So viele Rueckfragen darf Claude je Dokument stellen. */
export const RUECKFRAGEN_MAX = 2;
/** Zeichen fuer das Firmenwissen im Claude-Prompt (~800 Tokens). */
export const WISSEN_CLAUDE_BUDGET = 2400;
/** Davon hoechstens so viel fuer die Benennungsregeln (immer dabei). */
export const WISSEN_BENENNUNG_BUDGET = 1000;
const ZEILE_MAX = 400;
/** Ans Rig (Nacht-Kontext): Erklaerung gekappt wie dort (rig/eventline-ki/dienst/app/wissen.py MAX_ERKLAERUNG). */
const RIG_ERKLAERUNG_MAX = 600;
const AKTIV_MAX = 1000;

export interface WissenEintrag {
  id: string;
  kategorie: WissenKategorie;
  begriff: string;
  erklaerung: string;
  bezug_art: BezugArt | null;
  bezug_id: string | null;
  bezug_name: string | null;
  aktiv: boolean;
}

export const istKategorie = (x: unknown): x is WissenKategorie =>
  typeof x === "string" && (WISSEN_KATEGORIEN as readonly string[]).includes(x);
export const istBezugArt = (x: unknown): x is BezugArt =>
  typeof x === "string" && (BEZUG_ARTEN as readonly string[]).includes(x);
export const istFrageArt = (x: unknown): x is FrageArt =>
  typeof x === "string" && (FRAGE_ARTEN as readonly string[]).includes(x);

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_STEUER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function text(roh: unknown, max: number): string {
  if (typeof roh !== "string") return "";
  return roh.normalize("NFC").replace(RE_STEUER, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max).trim();
}

export interface WissenEingabe {
  kategorie: WissenKategorie;
  begriff: string;
  erklaerung: string;
  bezug_art: BezugArt | null;
  bezug_id: string | null;
  aktiv: boolean;
}

/** Eingabe aus Formular/API pruefen. Das Wissen geht auch an Claude: keine
 *  E-Mail, IBAN/Konto, AHV, Telefon, Betraege, Gesundheits- oder
 *  Kuendigungsangaben (gleicher Filter wie die Fakten-Hinweise). */
export function leseWissenEingabe(roh: unknown): { ok: true; wert: WissenEingabe } | { ok: false; fehler: string } {
  const r = roh && typeof roh === "object" && !Array.isArray(roh) ? (roh as Record<string, unknown>) : {};
  if (!istKategorie(r.kategorie)) return { ok: false, fehler: "Unbekannte Kategorie" };
  const begriff = text(r.begriff, BEGRIFF_MAX + 1);
  const erklaerung = text(r.erklaerung, ERKLAERUNG_MAX + 1);
  if (!begriff) return { ok: false, fehler: "Begriff/Titel fehlt" };
  if (begriff.length > BEGRIFF_MAX) return { ok: false, fehler: `Begriff/Titel höchstens ${BEGRIFF_MAX} Zeichen` };
  if (!erklaerung) return { ok: false, fehler: "Erklärung fehlt" };
  if (erklaerung.length > ERKLAERUNG_MAX) return { ok: false, fehler: `Erklärung höchstens ${ERKLAERUNG_MAX} Zeichen` };
  if (enthaeltSensibles(begriff) || enthaeltSensibles(erklaerung)) {
    return { ok: false, fehler: "Bitte keine E-Mail-Adressen, Konto-, AHV- oder Telefonnummern, Beträge oder Gesundheitsangaben — das Wissen geht auch an Claude" };
  }
  let bezug_art: BezugArt | null = null;
  let bezug_id: string | null = null;
  if (r.bezug_art !== null && r.bezug_art !== undefined && r.bezug_art !== "") {
    if (!istBezugArt(r.bezug_art) || typeof r.bezug_id !== "string" || !RE_UUID.test(r.bezug_id)) {
      return { ok: false, fehler: "Bezug ungültig" };
    }
    bezug_art = r.bezug_art;
    bezug_id = r.bezug_id.toLowerCase();
  }
  return { ok: true, wert: { kategorie: r.kategorie, begriff, erklaerung, bezug_art, bezug_id, aktiv: r.aktiv !== false } };
}

// ── Relevanz (deterministisch) ──────────────────────────────────────────

/** Gefaltete Woerter: klein, ohne Akzente, ä/ae → a (gleich wie das Rig). */
export function woerter(s: string | null | undefined): string[] {
  return (s ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/ae/g, "a").replace(/oe/g, "o").replace(/ue/g, "u").replace(/ß/g, "ss")
    .replace(/\p{M}/gu, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const folgeIn = (folge: readonly string[], quelle: string) => folge.length > 0 && quelle.includes(` ${folge.join(" ")} `);

export interface WissenAnlass {
  dateiname: string;
  herkunft: readonly string[];
  beschrieb: ZzBeschrieb | null;
  kandidaten: readonly string[];
  fakten: readonly string[];
}

/** Texte des Beschriebs — robust auch fuer aeltere/teilweise gespeicherte Beschriebe (Felder koennen fehlen). */
function beschriebTexte(b: Partial<ZzBeschrieb> | null): string[] {
  if (!b || typeof b !== "object") return [];
  const beteiligte = Array.isArray(b.beteiligte) ? b.beteiligte : [];
  const schlagworte = Array.isArray(b.schlagworte) ? b.schlagworte : [];
  return [
    b.dokumentart, b.unterart, b.titel, b.zweck, b.bezug, b.absender, b.empfaenger, b.zeitraum, b.typ_label,
    ...beteiligte.flatMap((x) => (x && typeof x === "object" ? [x.name, x.rolle] : [])), ...schlagworte,
  ].filter((x): x is string => typeof x === "string" && x.length > 0);
}

export function zeileWissen(e: Pick<WissenEintrag, "kategorie" | "begriff" | "erklaerung" | "bezug_art" | "bezug_name">): string {
  const bezug = e.bezug_name ? ` (${e.bezug_art ? `${BEZUG_ART_TEXT[e.bezug_art]}: ` : ""}${e.bezug_name})` : "";
  const z = `- [${WISSEN_KATEGORIE_TEXT[e.kategorie]}] ${e.begriff}: ${e.erklaerung.replace(/\s+/g, " ")}${bezug}`;
  return z.length <= ZEILE_MAX ? z : `${z.slice(0, ZEILE_MAX - 1).trimEnd()}…`;
}

/** Firmenwissen fuer EIN Dokument: alle aktiven Benennungsregeln (bis zu
 *  ihrem Budget) und die Eintraege, deren Begriff oder Bezug als ganze
 *  Wortfolge im Dateinamen, im bisherigen Ablageort, im Beschrieb, in den
 *  Kandidatenordnern oder den Fakten steht; Ordner-Hinweise auch, wenn ihre
 *  Erklaerung einen Kandidatenordner nennt. Laengere (spezifischere) Begriffe
 *  zuerst; gekappt auf das Budget (ganze Zeilen). */
export function waehleWissen(alle: readonly WissenEintrag[], a: WissenAnlass, budget = WISSEN_CLAUDE_BUDGET): WissenEintrag[] {
  const quelle = ` ${[a.dateiname, ...a.herkunft, ...beschriebTexte(a.beschrieb), ...a.kandidaten, ...a.fakten]
    .flatMap(woerter).join(" ")} `;
  const kandidatenNfc = a.kandidaten.map((k) => k.normalize("NFC"));
  const aktiv = alle.filter((e) => e.aktiv);
  const aus: WissenEintrag[] = [];
  let rest = budget;
  let benennungRest = Math.min(WISSEN_BENENNUNG_BUDGET, budget);
  for (const e of aktiv.filter((x) => x.kategorie === "benennung").sort((x, y) => x.begriff.localeCompare(y.begriff, "de"))) {
    const n = zeileWissen(e).length + 1;
    if (n > benennungRest || n > rest) continue;
    aus.push(e);
    benennungRest -= n;
    rest -= n;
  }
  const treffer: { e: WissenEintrag; rang: number; laenge: number }[] = [];
  for (const e of aktiv) {
    if (e.kategorie === "benennung") continue;
    const b = woerter(e.begriff);
    if (folgeIn(b, quelle)) treffer.push({ e, rang: 0, laenge: b.join(" ").length });
    else if (e.bezug_name && folgeIn(woerter(e.bezug_name), quelle)) treffer.push({ e, rang: 1, laenge: e.bezug_name.length });
    else if (e.kategorie === "ordner" && kandidatenNfc.some((k) => e.erklaerung.normalize("NFC").includes(k))) {
      treffer.push({ e, rang: 2, laenge: 0 });
    }
  }
  treffer.sort((x, y) => x.rang - y.rang || y.laenge - x.laenge || x.e.begriff.localeCompare(y.e.begriff, "de"));
  for (const { e } of treffer) {
    const n = zeileWissen(e).length + 1;
    if (n > rest) continue;
    aus.push(e);
    rest -= n;
  }
  return aus;
}

/** Fuer den Nacht-Kontext des Rigs (lese_wissen in rig/…/wissen.py). */
export function wissenFuerRig(alle: readonly WissenEintrag[]): { kategorie: WissenKategorie; begriff: string; erklaerung: string; bezug: string | null }[] {
  return alle
    .filter((e) => e.aktiv)
    .slice(0, 500)
    .map((e) => ({
      kategorie: e.kategorie,
      begriff: e.begriff,
      erklaerung: e.erklaerung.replace(/\s+/g, " ").slice(0, RIG_ERKLAERUNG_MAX),
      bezug: e.bezug_name ?? null,
    }));
}

// ── Rueckfragen von Claude ──────────────────────────────────────────────

export interface ZzRueckfrage {
  art: FrageArt;
  begriff: string | null;
  frage: string;
  schluessel: string;
}

const STOPP = new Set([
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einer", "eines", "ist", "sind", "was", "wer", "wie", "wo",
  "wozu", "welche", "welcher", "welches", "zu", "zum", "zur", "und", "oder", "fur", "von", "mit", "im", "in", "an", "auf",
  "bedeutet", "heisst", "steht", "gehort", "gehoert", "es", "sich", "bei", "dieser", "diese", "dieses", "dazu", "davon",
  "dabei", "darin", "damit", "hier", "noch", "auch", "nicht", "kein", "keine", "bitte", "genau", "welchem", "welchen", "wem",
  "wen", "ob", "wird", "werden", "soll", "sollen", "kann", "man", "fuer", "uber", "ueber",
]);

/** Gleiche/aehnliche Frage = gleicher Schluessel: Art + gefalteter Begriff;
 *  ohne Begriff Art + die Inhaltswoerter der Frage (sortiert, einmalig). */
export function frageSchluessel(art: FrageArt, begriff: string | null, frage: string): string {
  const b = woerter(begriff).join(" ");
  if (b) return `${art}:${b}`.slice(0, 200);
  const w = [...new Set(woerter(frage).filter((x) => x.length >= 3 && !STOPP.has(x)))].sort();
  return `${art}:f:${w.join(" ")}`.slice(0, 200);
}

/** Rueckfragen aus Claudes Antwort: hoechstens 2, bekannte Art, Frage 8–300
 *  Zeichen, Begriff hoechstens 120 — beides ohne sensible Werte (gleicher
 *  Filter wie der Beschrieb: Betraege, Nummern, IBAN, AHV, Telefon, E-Mail,
 *  Adressen, Gesundheit/Kuendigungsgrund); sonst faellt die Frage weg. Gleiche
 *  Schluessel nur einmal. */
export function leseRueckfragen(roh: unknown): ZzRueckfrage[] {
  const aus: ZzRueckfrage[] = [];
  for (const x of Array.isArray(roh) ? (roh as unknown[]) : []) {
    if (aus.length >= RUECKFRAGEN_MAX) break;
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    if (!istFrageArt(r.art)) continue;
    const frage = text(r.frage, FRAGE_MAX + 1).replace(/\s+/g, " ");
    const begriff = text(r.begriff, BEGRIFF_MAX + 1).replace(/\s+/g, " ") || null;
    if (frage.length < 8 || frage.length > FRAGE_MAX || (begriff && begriff.length > BEGRIFF_MAX)) continue;
    if (inhaltImNamen(frage) || (begriff && inhaltImNamen(begriff))) continue;
    const schluessel = frageSchluessel(r.art, begriff, frage);
    if (schluessel.length < 3 || aus.some((y) => y.schluessel === schluessel)) continue;
    aus.push({ art: r.art, begriff, frage, schluessel });
  }
  return aus;
}

// ── Lader (Admin-Client) ────────────────────────────────────────────────

/** Namen der Bezuege aus den Stammdaten (aktuell), Rueckfall der beim
 *  Speichern gemerkte Name. Vier kleine Abfragen je Art, nur gesuchte IDs. */
export async function ladeBezugNamen(admin: Admin, eintraege: readonly Pick<WissenEintrag, "bezug_art" | "bezug_id">[]): Promise<Map<string, string>> {
  const aus = new Map<string, string>();
  const tabelle: Record<BezugArt, { t: string; name: string }> = {
    location: { t: "locations", name: "name" },
    kunde: { t: "customers", name: "name" },
    lieferant: { t: "lieferanten", name: "name" },
    person: { t: "profiles", name: "full_name" },
  };
  for (const art of BEZUG_ARTEN) {
    const ids = [...new Set(eintraege.filter((e) => e.bezug_art === art && e.bezug_id).map((e) => e.bezug_id as string))];
    if (!ids.length) continue;
    const { data, error } = await admin.from(tabelle[art].t).select(`id, ${tabelle[art].name}`).in("id", ids.slice(0, 500));
    if (error) throw new Error(`Bezug (${art}): ${error.message}`);
    for (const z of (data ?? []) as unknown as Record<string, unknown>[]) {
      const n = String(z[tabelle[art].name] ?? "").trim();
      if (n) aus.set(`${art}:${z.id as string}`, n.slice(0, BEZUG_NAME_MAX));
    }
  }
  return aus;
}

/** Aktive Eintraege mit aktuellem Bezugsnamen (Kontext Rig, Claude-Prompt). */
export async function ladeWissenAktiv(admin: Admin): Promise<WissenEintrag[]> {
  const { data, error } = await admin
    .from("ki_wissen")
    .select("id, kategorie, begriff, erklaerung, bezug_art, bezug_id, bezug_name, aktiv")
    .eq("aktiv", true)
    .order("geaendert_am", { ascending: false })
    .limit(AKTIV_MAX);
  if (error) throw new Error(`ki_wissen: ${error.message}`);
  const zeilen = ((data ?? []) as WissenEintrag[]).filter((e) => istKategorie(e.kategorie));
  const namen = await ladeBezugNamen(admin, zeilen);
  return zeilen.map((e) => ({
    ...e,
    bezug_name: (e.bezug_art && e.bezug_id ? namen.get(`${e.bezug_art}:${e.bezug_id}`) : null) ?? e.bezug_name ?? null,
  }));
}
