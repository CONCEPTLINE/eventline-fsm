// Regeln der Trust-flow-Schnittstelle je Route (rein, ohne Datenbank).
//
//   pruefeMonatsClaims     Stempel/Vergleich: jahr, monat, profile (≤ 50), Stempel-Bereich
//   pruefeAblageClaims     Ablage: erp_profil_id, art (lohnabrechnung: jahr+monat ab 12/2026 |
//                          lohnausweis: jahr ab 2026, ohne monat), fassung, sha256
//   pruefeSaetzeClaims     Personal-Sätze: saetze [{ erp_profil_id, gueltig_ab, kosten_chf_h, netto_chf_h }] (1–50)
//   pruefeAbwesenheitenClaims  Abwesenheiten (380): jahr, monat, profile (≤ 50)
//   pruefeArztzeugnisClaims    Arztzeugnis (380): time_off_id
//   abwesenheitFuerFlow, arztzeugnisPfadPasst
//   lokalerMonat, monateDesStempels, zaehleUeberlappungen, nachtraeglichGeaendert
//   vergleichAusMomentaufnahme
//   pruefeAblageKoerper, dekodierePdf
//
// Vertrag: _backoffice-uebergabe/10_Schnittstelle_Stunden.md (A1), 07_Rueckfragen.md (A5).
// Unit-Tests: regeln.test.ts.

import { createHash } from "node:crypto";
import { lokalesDatum, stempelBereich } from "@/lib/lohn/kern";
import { istIntern } from "@/lib/roles";
import { istUuid } from "./ausweis";

/** Höchstens so viele ERP-Profil-IDs je Ausweis. */
export const PROFILE_MAX = 50;
/** Vergleich (Parallelmonat) nur bis und mit diesem Lohnmonat — danach rechnet das ERP nicht mehr. */
export const VERGLEICH_BIS = { jahr: 2026, monat: 11 } as const;
/** Lohnabrechnungen aus Bexio ab diesem Lohnmonat (und nur nach lohn_einstellungen.lauf_bis). */
export const BEXIO_AB = { jahr: 2026, monat: 12 } as const;
/** Grösste PDF aus Bexio (dekodiert). */
export const PDF_MAX_BYTES = 2 * 1024 * 1024;
/** Grösster Körper der Ablage-Route (Base64 der PDF + Ausweis + JSON). */
export const ABLAGE_MAX_ZEICHEN = 3_000_000;

export interface RegelFehler {
  ok: false;
  status: number;
  code: string;
  meldung: string;
}
const fehler = (code: string, meldung: string, status = 400): RegelFehler => ({ ok: false, status, code, meldung });

const vor = (a: { jahr: number; monat: number }, b: { jahr: number; monat: number }) =>
  a.jahr < b.jahr || (a.jahr === b.jahr && a.monat < b.monat);

export const monatText = (jahr: number, monat: number) => `${jahr}-${String(monat).padStart(2, "0")}`;

function jahrMonat(c: Record<string, unknown>): { jahr: number; monat: number } | null {
  const { jahr, monat } = c;
  if (!Number.isInteger(jahr) || !Number.isInteger(monat)) return null;
  if ((jahr as number) < 2020 || (jahr as number) > 2100 || (monat as number) < 1 || (monat as number) > 12) return null;
  return { jahr: jahr as number, monat: monat as number };
}

/** Kennzahlen fürs Protokoll, bevor die Route die Claims streng prüft (nie Wurf).
 *  Lohnausweis: nur jahr (monat leer); Sätze: angefragt = Anzahl Einträge; Arztzeugnis: 1. */
export function protokollKennzahlen(c: Record<string, unknown>): { jahr: number | null; monat: number | null; angefragt: number | null } {
  const jm = jahrMonat(c);
  const nurJahr = !jm && c.monat === undefined && Number.isInteger(c.jahr) && (c.jahr as number) >= 2020 && (c.jahr as number) <= 2100
    ? (c.jahr as number) : null;
  const angefragt = Array.isArray(c.profile) ? c.profile.length
    : Array.isArray(c.saetze) ? c.saetze.length
    : istUuid(c.erp_profil_id) || istUuid(c.time_off_id) ? 1 : null;
  return { jahr: jm?.jahr ?? nurJahr, monat: jm?.monat ?? null, angefragt };
}

export interface MonatsAnfrage {
  jahr: number;
  monat: number;
  /** ERP-Profil-IDs (klein geschrieben, eindeutig). */
  profile: string[];
  /** Stempel-Bereich des Kerns (lokale Tage). */
  von: string;
  bis: string;
}

/**
 * Claims für Stempel und Vergleich. `bereich`: von/bis müssen dem
 * stempelBereich() des ERP-Kerns entsprechen (gleicher Kern auf beiden Seiten —
 * weicht er ab, rechnet Trust flow mit anderen Stempeln; laut statt still).
 * `bis`: letzter erlaubter Lohnmonat (Vergleich).
 */
export function pruefeMonatsClaims(
  c: Record<string, unknown>,
  opts: { bereich: boolean; bis?: { jahr: number; monat: number } },
): { ok: true; anfrage: MonatsAnfrage } | RegelFehler {
  const jm = jahrMonat(c);
  if (!jm) return fehler("monat_ungueltig", "jahr/monat fehlen oder sind ungültig.");
  if (opts.bis && vor(opts.bis, jm)) {
    return fehler("monat_nicht_erlaubt", `Nur Lohnmonate bis ${monatText(opts.bis.jahr, opts.bis.monat)} (danach rechnet das ERP nicht mehr).`, 422);
  }
  const p = pruefeProfilListe(c);
  if (!p.ok) return p;
  const b = stempelBereich(jm.jahr, jm.monat);
  if (opts.bereich && (c.von !== b.von || c.bis !== b.bis)) {
    return fehler("bereich_abweichend", `von/bis passen nicht zum Stempel-Bereich des Kerns (${b.von} bis ${b.bis}).`);
  }
  return { ok: true, anfrage: { ...jm, profile: p.profile, von: b.von, bis: b.bis } };
}

/** Claim `profile`: 1–50 ERP-Profil-IDs (UUID), ohne Doppel; klein geschrieben, in Anfrage-Reihenfolge. */
function pruefeProfilListe(c: Record<string, unknown>): { ok: true; profile: string[] } | RegelFehler {
  if (!Array.isArray(c.profile) || c.profile.length === 0) return fehler("profile_fehlen", "profile (ERP-Profil-IDs) fehlt oder ist leer.");
  if (c.profile.length > PROFILE_MAX) return fehler("profile_zu_viele", `Höchstens ${PROFILE_MAX} Profil-IDs je Abruf.`);
  if (!c.profile.every(istUuid)) return fehler("profile_ungueltig", "profile enthält eine ungültige ID.");
  const profile = (c.profile as string[]).map((x) => x.toLowerCase());
  if (new Set(profile).size !== profile.length) return fehler("profile_doppelt", "profile enthält eine ID doppelt.");
  return { ok: true, profile };
}

/** Was abgelegt wird: Lohnabrechnung (je Lohnmonat) oder Lohnausweis (je Jahr). */
export type AblageArt = "lohnabrechnung" | "lohnausweis";
/** Lohnausweise aus Bexio ab diesem Jahr. */
export const AUSWEIS_AB_JAHR = 2026;

export interface AblageAnfrage {
  profileId: string;
  art: AblageArt;
  jahr: number;
  /** Lohnmonat; null beim Lohnausweis. */
  monat: number | null;
  /** Fassung laut Trust flow/Bexio (1 = erste Fassung der Periode). */
  fassung: number;
  sha256: string;
}

/** Claims der Ablage (A5): Lohnabrechnung (art fehlt oder «lohnabrechnung») oder Lohnausweis. */
export function pruefeAblageClaims(c: Record<string, unknown>): { ok: true; anfrage: AblageAnfrage } | RegelFehler {
  if (!istUuid(c.erp_profil_id)) return fehler("person_ungueltig", "erp_profil_id fehlt oder ist ungültig.");
  if (c.art !== undefined && c.art !== "lohnabrechnung" && c.art !== "lohnausweis") {
    return fehler("art_ungueltig", "art muss «lohnabrechnung» oder «lohnausweis» sein.");
  }
  const art: AblageArt = c.art === "lohnausweis" ? "lohnausweis" : "lohnabrechnung";
  let jahr: number;
  let monat: number | null;
  if (art === "lohnausweis") {
    if (c.monat !== undefined) return fehler("monat_nicht_erlaubt", "Lohnausweis: monat darf nicht gesetzt sein.");
    if (!Number.isInteger(c.jahr) || (c.jahr as number) < 2020 || (c.jahr as number) > 2100) {
      return fehler("jahr_ungueltig", "jahr fehlt oder ist ungültig.");
    }
    jahr = c.jahr as number;
    if (jahr < AUSWEIS_AB_JAHR) return fehler("erp_jahr", `Lohnausweise aus Bexio erst ab Jahr ${AUSWEIS_AB_JAHR}.`, 422);
    monat = null;
  } else {
    const jm = jahrMonat(c);
    if (!jm) return fehler("monat_ungueltig", "jahr/monat fehlen oder sind ungültig.");
    if (vor(jm, BEXIO_AB)) {
      return fehler("erp_monat", `Lohnabrechnungen aus Bexio erst ab Lohnmonat ${monatText(BEXIO_AB.jahr, BEXIO_AB.monat)}.`, 422);
    }
    jahr = jm.jahr;
    monat = jm.monat;
  }
  if (!Number.isInteger(c.fassung) || (c.fassung as number) < 1 || (c.fassung as number) > 99) {
    return fehler("fassung_ungueltig", "fassung (1–99) fehlt oder ist ungültig.");
  }
  if (typeof c.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(c.sha256)) {
    return fehler("sha256_ungueltig", "sha256 (64 Zeichen hex, klein) fehlt oder ist ungültig.");
  }
  return {
    ok: true,
    anfrage: { profileId: (c.erp_profil_id as string).toLowerCase(), art, jahr, monat, fassung: c.fassung as number, sha256: c.sha256 },
  };
}

// ---------------------------------------------------------------------------
// Personal-Sätze (POST /api/flow/saetze, Migration 377)
// ---------------------------------------------------------------------------

/** Höchstens so viele Sätze je Ausweis. */
export const SAETZE_MAX = 50;
/** Grösster Satz in CHF/h (numeric(8,2)). */
const SATZ_MAX = 999_999.99;

export interface Satz {
  profileId: string;
  /** YYYY-MM-DD */
  gueltigAb: string;
  kostenChfH: number;
  nettoChfH: number;
}

const istDatum = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [j, m, t] = v.split("-").map(Number);
  const d = new Date(Date.UTC(j, m - 1, t));
  return j >= 2020 && j <= 2100 && d.getUTCFullYear() === j && d.getUTCMonth() === m - 1 && d.getUTCDate() === t;
};

/** Zahl ≥ 0 mit höchstens 2 Nachkommastellen (als JSON-Zahl). */
const istSatz = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= SATZ_MAX && Math.abs(Math.round(v * 100) - v * 100) < 1e-6;

/** Claim `saetze`: 1–50 Einträge, je Person und Datum höchstens einmal. */
export function pruefeSaetzeClaims(c: Record<string, unknown>): { ok: true; anfrage: Satz[] } | RegelFehler {
  if (!Array.isArray(c.saetze) || c.saetze.length === 0) return fehler("saetze_fehlen", "saetze fehlt oder ist leer.");
  if (c.saetze.length > SAETZE_MAX) return fehler("saetze_zu_viele", `Höchstens ${SAETZE_MAX} Sätze je Aufruf.`);
  const out: Satz[] = [];
  const gesehen = new Set<string>();
  for (let i = 0; i < c.saetze.length; i++) {
    const e: unknown = c.saetze[i];
    const o = e && typeof e === "object" && !Array.isArray(e) ? (e as Record<string, unknown>) : null;
    const nr = `saetze[${i}]`;
    if (!o) return fehler("satz_ungueltig", `${nr} ist kein Objekt.`);
    if (!istUuid(o.erp_profil_id)) return fehler("person_ungueltig", `${nr}.erp_profil_id fehlt oder ist ungültig.`);
    if (!istDatum(o.gueltig_ab)) return fehler("datum_ungueltig", `${nr}.gueltig_ab (YYYY-MM-DD) fehlt oder ist ungültig.`);
    if (!istSatz(o.kosten_chf_h)) return fehler("satz_ungueltig", `${nr}.kosten_chf_h: Zahl ≥ 0 mit höchstens 2 Nachkommastellen.`);
    if (!istSatz(o.netto_chf_h)) return fehler("satz_ungueltig", `${nr}.netto_chf_h: Zahl ≥ 0 mit höchstens 2 Nachkommastellen.`);
    const profileId = (o.erp_profil_id as string).toLowerCase();
    const k = `${profileId}|${o.gueltig_ab}`;
    if (gesehen.has(k)) return fehler("satz_doppelt", `${nr}: Person und gueltig_ab kommen doppelt vor.`);
    gesehen.add(k);
    out.push({ profileId, gueltigAb: o.gueltig_ab, kostenChfH: o.kosten_chf_h, nettoChfH: o.netto_chf_h });
  }
  return { ok: true, anfrage: out };
}

// ---------------------------------------------------------------------------
// Abwesenheiten und Arztzeugnis (POST /api/flow/abwesenheiten, /api/flow/arztzeugnis; Migration 380)
// ---------------------------------------------------------------------------

/** Grösstes Arztzeugnis (wie Bucket «arztzeugnisse», Migration 378). */
export const ARZTZEUGNIS_MAX_BYTES = 10 * 1024 * 1024;
/** So lange gilt der signierte Link auf das Arztzeugnis (/arztzeugnis). */
export const ARZTZEUGNIS_LINK_S = 60;

export interface AbwesenheitenAnfrage {
  jahr: number;
  monat: number;
  /** ERP-Profil-IDs (klein geschrieben, eindeutig). */
  profile: string[];
  /** Erster und letzter Kalendertag des Monats (Ortszeit Zürich, YYYY-MM-DD). */
  von: string;
  bis: string;
}

/** Claims für /abwesenheiten: jahr, monat, profile (1–50) — wie /stempel, ohne Stempel-Bereich. */
export function pruefeAbwesenheitenClaims(c: Record<string, unknown>): { ok: true; anfrage: AbwesenheitenAnfrage } | RegelFehler {
  const jm = jahrMonat(c);
  if (!jm) return fehler("monat_ungueltig", "jahr/monat fehlen oder sind ungültig.");
  const p = pruefeProfilListe(c);
  if (!p.ok) return p;
  const letzter = new Date(Date.UTC(jm.jahr, jm.monat, 0)).getUTCDate();
  const m = monatText(jm.jahr, jm.monat);
  return { ok: true, anfrage: { ...jm, profile: p.profile, von: `${m}-01`, bis: `${m}-${String(letzter).padStart(2, "0")}` } };
}

/** Claim `time_off_id` für /arztzeugnis. */
export function pruefeArztzeugnisClaims(c: Record<string, unknown>): { ok: true; anfrage: { timeOffId: string } } | RegelFehler {
  if (!istUuid(c.time_off_id)) return fehler("abwesenheit_ungueltig", "time_off_id fehlt oder ist ungültig.");
  return { ok: true, anfrage: { timeOffId: (c.time_off_id as string).toLowerCase() } };
}

/**
 * Liegt das Arztzeugnis dort, wo /api/krank/[id]/arztzeugnis es ablegt
 * (<user_id>/<time_off_id>/<datei>)? Schutz gegen einen Pfad, der auf das
 * Zeugnis einer anderen Person zeigt.
 */
export function arztzeugnisPfadPasst(pfad: string, userId: string, timeOffId: string): boolean {
  const teile = pfad.split("/");
  return teile.length === 3 && teile[0].toLowerCase() === userId.toLowerCase()
    && teile[1].toLowerCase() === timeOffId.toLowerCase() && teile[2].length > 0 && teile[2] !== "." && teile[2] !== "..";
}

export interface AbwesenheitZeile {
  id: string;
  user_id: string;
  type: string;
  status: string;
  start_date: string;
  end_date: string;
  ende_offen: boolean | null;
  created_at: string;
  approved_at: string | null;
  arztzeugnis_pfad: string | null;
  arztzeugnis_hochgeladen_at: string | null;
}

export interface ArztzeugnisDaten {
  dateiname: string;
  mime: string;
  groesse: number;
  sha256: string;
}

export interface AbwesenheitFuerFlow {
  id: string;
  typ: string;
  status: string;
  von: string;
  bis: string;
  ende_offen: boolean;
  gemeldet_at: string;
  entschieden_at: string | null;
  arztzeugnis: null | { id: string; hochgeladen_at: string | null; dateiname: string; mime: string; groesse: number; sha256: string };
}

/** Eine Abwesenheit für Trust flow — ohne Notizen, ohne Entscheid-Text, ohne Namen. */
export function abwesenheitFuerFlow(z: AbwesenheitZeile, zeugnis: ArztzeugnisDaten | null): AbwesenheitFuerFlow {
  return {
    id: z.id,
    typ: z.type,
    status: z.status,
    von: z.start_date,
    bis: z.end_date,
    ende_offen: z.ende_offen === true,
    gemeldet_at: z.created_at,
    entschieden_at: z.approved_at,
    arztzeugnis: z.arztzeugnis_pfad && zeugnis
      ? { id: z.id, hochgeladen_at: z.arztzeugnis_hochgeladen_at, ...zeugnis }
      : null,
  };
}

/** MIME-Typ aus der Dateiendung (für Zeugnisse vor Migration 380 ohne gespeicherte Angabe). */
export function mimeAusEndung(pfad: string): string {
  const e = (pfad.split(".").pop() ?? "").toLowerCase();
  const je: Record<string, string> = {
    pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  };
  return je[e] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Personen
// ---------------------------------------------------------------------------

/**
 * Aus den signierten Profil-IDs die internen ERP-Profile (kein Partner-/
 * Lieferanten-Zugang), in Anfrage-Reihenfolge — unabhängig von Anstellung und
 * «aktiv» (Entscheid Backoffice 30.10.: Trust flow bestimmt die Personen selbst,
 * Ausgetretene mit Stempeln im Bereich müssen kommen). Unbekannte IDs fallen weg.
 */
export function interneProfile(ids: string[], profile: { id: string; role: string | null }[]): string[] {
  const intern = new Set(profile.filter((p) => istIntern(p.role)).map((p) => p.id.toLowerCase()));
  return ids.filter((id) => intern.has(id.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Stempel
// ---------------------------------------------------------------------------

/** «2026-09» — Lohnmonat eines Zeitpunkts (Ortszeit Zürich). */
export function lokalerMonat(iso: string): string {
  return lokalesDatum(new Date(iso).getTime()).slice(0, 7);
}

/**
 * Lohnmonate, die ein Stempel [Beginn, Ende) berührt (Ortszeit Zürich). Offen
 * (ohne Ende) = nur der Monat des Beginns.
 */
export function monateDesStempels(start: string, ende: string | null): string[] {
  const von = lokalerMonat(start);
  if (!ende) return [von];
  const bisMs = new Date(ende).getTime() - 1;
  if (bisMs < new Date(start).getTime()) return [von];
  const bis = lokalesDatum(bisMs).slice(0, 7);
  const out: string[] = [];
  let [j, m] = von.split("-").map(Number);
  for (let i = 0; i < 24; i++) {
    const k = monatText(j, m);
    out.push(k);
    if (k >= bis) break;
    m++;
    if (m > 12) { m = 1; j++; }
  }
  return out;
}

export interface StempelFuerPruefung {
  start: string;
  ende: string | null;
  /** Überlappung vor Regel 368, bekannt und markiert (time_entries.ueberlappung_altfall). */
  altfall: boolean;
}

/**
 * Stempel der Person, die den Lohnmonat berühren und sich mit einem anderen
 * Stempel derselben Person überschneiden ([Beginn, Ende), offen = bis
 * unendlich). Paare aus zwei markierten Altfällen zählen nicht (bekannt, der
 * Kern zählt die Zeit einmal) — gleiche Regel wie die Datenbank (368).
 */
export function zaehleUeberlappungen(stempel: StempelFuerPruefung[], monat: string): number {
  const iv = stempel.map((s) => ({
    s,
    a: new Date(s.start).getTime(),
    b: s.ende ? new Date(s.ende).getTime() : Number.POSITIVE_INFINITY,
  }));
  let n = 0;
  for (let i = 0; i < iv.length; i++) {
    if (!monateDesStempels(iv[i].s.start, iv[i].s.ende).includes(monat)) continue;
    const ueberlappt = iv.some((o, k) => k !== i && !(iv[i].s.altfall && o.s.altfall) && iv[i].a < o.b && o.a < iv[i].b);
    if (ueberlappt) n++;
  }
  return n;
}

export interface StempelAenderung {
  profileId: string;
  occurredAt: string;
  alt: { clock_in?: unknown; clock_out?: unknown } | null;
  neu: { clock_in?: unknown; clock_out?: unknown } | null;
}

/**
 * Stempel-Änderungen nach der Monatssperre (Antrag/Notweg, lohn_aenderungen)
 * → betroffene Lohnmonate je Person, die im Bereich [vonMonat, bisMonat]
 * liegen (der Stempel-Bereich des abgefragten Monats: genau diese Stempel
 * gehen in seine Rechnung ein). Je Person/Monat der letzte Zeitpunkt.
 */
export function nachtraeglichGeaendert(
  aenderungen: StempelAenderung[],
  vonMonat: string,
  bisMonat: string,
): { erp_profil_id: string; monat: string; geaendert_at: string }[] {
  const je = new Map<string, { erp_profil_id: string; monat: string; geaendert_at: string }>();
  for (const a of aenderungen) {
    const monate = new Set<string>();
    for (const s of [a.alt, a.neu]) {
      if (!s || typeof s.clock_in !== "string") continue;
      const ende = typeof s.clock_out === "string" ? s.clock_out : null;
      for (const m of monateDesStempels(s.clock_in, ende)) monate.add(m);
    }
    const zeit = new Date(a.occurredAt).toISOString();
    for (const m of monate) {
      if (m < vonMonat || m > bisMonat) continue;
      const k = `${a.profileId}|${m}`;
      const bisher = je.get(k);
      if (!bisher || bisher.geaendert_at < zeit) je.set(k, { erp_profil_id: a.profileId, monat: m, geaendert_at: zeit });
    }
  }
  return [...je.values()].sort((x, y) => x.erp_profil_id.localeCompare(y.erp_profil_id) || x.monat.localeCompare(y.monat));
}

// ---------------------------------------------------------------------------
// Vergleich (Parallelmonat)
// ---------------------------------------------------------------------------

export interface MomentaufnahmeRoh {
  profile_id: string;
  fassung: number;
  art: string;
  kern_version: string | null;
  pruefsumme: string;
  auszahlungsdatum: string;
  brutto: unknown;
  ahv_lohn: unknown;
  alv_lohn: unknown;
  uvg_lohn: unknown;
  uvg_art: string;
  positionen: unknown;
  nbu: unknown;
  bisher: unknown;
}

export interface VergleichsWerte {
  fassung: number;
  art: string;
  kern_version: string | null;
  pruefsumme: string;
  auszahlungsdatum: string;
  brutto: number;
  positionen: { lohnart: string; minuten: number | null; betrag: number }[];
  ahv_lohn: number;
  alv_lohn: number;
  uvg_lohn: number;
  uvg_art: string;
  nbu: { versichert: boolean; massgebend: number | null } | null;
  bisher: { ahv_lohn: number; alv_lohn: number; uvg_lohn: number } | null;
}

const zahl = (v: unknown): number => Number(v);

/** ERP-Momentaufnahme → Vergleichswerte (ohne Namen, ohne Bezeichnungen, ohne IDs). */
export function vergleichAusMomentaufnahme(r: MomentaufnahmeRoh): VergleichsWerte {
  const pos = Array.isArray(r.positionen) ? (r.positionen as Record<string, unknown>[]) : [];
  const nbu = r.nbu && typeof r.nbu === "object" ? (r.nbu as Record<string, unknown>) : null;
  const bisher = r.bisher && typeof r.bisher === "object" ? (r.bisher as Record<string, unknown>) : null;
  return {
    fassung: r.fassung,
    art: r.art,
    kern_version: r.kern_version,
    pruefsumme: r.pruefsumme,
    auszahlungsdatum: r.auszahlungsdatum,
    brutto: zahl(r.brutto),
    positionen: pos.map((p) => ({
      lohnart: String(p.lohnart ?? p.art ?? ""),
      minuten: p.minuten == null ? null : zahl(p.minuten),
      betrag: zahl(p.betrag),
    })),
    ahv_lohn: zahl(r.ahv_lohn),
    alv_lohn: zahl(r.alv_lohn),
    uvg_lohn: zahl(r.uvg_lohn),
    uvg_art: r.uvg_art,
    nbu: nbu ? { versichert: nbu.versichert === true, massgebend: nbu.massgebend == null ? null : zahl(nbu.massgebend) } : null,
    bisher: bisher ? { ahv_lohn: zahl(bisher.ahvLohn), alv_lohn: zahl(bisher.alvLohn), uvg_lohn: zahl(bisher.uvgLohn) } : null,
  };
}

// ---------------------------------------------------------------------------
// Lohnabrechnung (A5): Körper und PDF
// ---------------------------------------------------------------------------

/** Körper `{ "ausweis": "<JWS>", "pdf_base64": "<Base64>" }`. */
export function pruefeAblageKoerper(text: string): { ok: true; ausweis: string; pdfBase64: string } | RegelFehler {
  if (text.length > ABLAGE_MAX_ZEICHEN) return fehler("zu_gross", "Körper zu gross (PDF höchstens 2 MB).", 413);
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return fehler("koerper_ungueltig", "Körper ist kein JSON { ausweis, pdf_base64 }.");
  }
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  if (!o || typeof o.ausweis !== "string" || typeof o.pdf_base64 !== "string") {
    return fehler("koerper_ungueltig", "Körper ist kein JSON { ausweis, pdf_base64 }.");
  }
  return { ok: true, ausweis: o.ausweis.trim(), pdfBase64: o.pdf_base64 };
}

export const sha256Hex = (daten: Uint8Array | string) => createHash("sha256").update(daten).digest("hex");

/** Base64 streng dekodieren, Grösse, PDF-Kennung und Prüfsumme (aus dem signierten Ausweis) prüfen. */
export function dekodierePdf(b64: string, sha256: string): { ok: true; pdf: Uint8Array } | RegelFehler {
  const roh = b64.replace(/\s+/g, "");
  if (roh.length === 0 || roh.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(roh)) {
    return fehler("pdf_ungueltig", "pdf_base64 ist kein gültiges Base64.");
  }
  if ((roh.length / 4) * 3 > PDF_MAX_BYTES + 2) return fehler("zu_gross", "PDF grösser als 2 MB.", 413);
  const pdf = new Uint8Array(Buffer.from(roh, "base64"));
  if (pdf.byteLength === 0 || pdf.byteLength > PDF_MAX_BYTES) return fehler("zu_gross", "PDF grösser als 2 MB.", 413);
  if (Buffer.from(pdf.subarray(0, 5)).toString("latin1") !== "%PDF-") return fehler("pdf_ungueltig", "Datei ist keine PDF.");
  if (sha256Hex(pdf) !== sha256) return fehler("sha256_abweichend", "Prüfsumme der PDF passt nicht zum Ausweis.", 422);
  return { ok: true, pdf };
}
