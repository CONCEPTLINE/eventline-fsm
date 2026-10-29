// Lohn-Daten aus der Datenbank → Eingaben des Rechenkerns (nur Server).
//
// EINE Ladestelle für alle Rechenwege (Monatstabelle, Lohnabrechnung, Excel,
// Lohn-Details, «Mein Monat», Prognosen). Alles seitenweise (keine stille
// 1'000-Zeilen-Grenze), jeder Ladefehler wirft. Keine Ersatzwerte: fehlende
// Sätze kommen als NaN in den Kern und werden dort als Fehler gemeldet.
//
// Konvention ERP: employee_compensation.hourly_wage_chf ist der Stundenlohn
// INKLUSIVE Ferienzuschlag (Verträge «26.00 inkl. 8,33 % Ferien»).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  auszahlungsdatumNachRegel,
  feiertageBaselStadtJahre,
  KernFehler,
  plusTage,
  rechneMonat,
  stempelBereich,
  type Anstellung,
  type BisherImAuszahlungsjahr,
  type Firmensatz,
  type Lohnzeile,
  type MonatsEingabe,
  type MonatsErgebnis,
  type Person,
  type Stempel,
} from "./kern";
import { ladeLohnEinstellungen } from "./zugriff";

const SEITE = 1000;

/** Alle Zeilen einer Abfrage seitenweise. */
export async function ladeAlleSeiten<T>(
  abfrage: (von: number, bis: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  was: string,
): Promise<T[]> {
  const alle: T[] = [];
  for (let von = 0; ; von += SEITE) {
    const { data, error } = await abfrage(von, von + SEITE - 1);
    if (error) throw new Error(`${was} konnten nicht geladen werden: ${error.message}`);
    alle.push(...(data ?? []));
    if (!data || data.length < SEITE) return alle;
  }
}

function inStuecken<T>(liste: T[], n = 150): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < liste.length; i += n) out.push(liste.slice(i, i + n));
  return out;
}

const zahl = (v: unknown): number => (v == null || v === "" ? NaN : Number(v));

// ---------------------------------------------------------------------------
// Firmensätze
// ---------------------------------------------------------------------------
export interface FirmensatzZeile {
  effective_from: string;
  default_ahv_iv_eo_pct: unknown; default_alv_pct: unknown; default_nbu_pct: unknown; default_bvg_pct: unknown;
  default_ktg_pct: unknown; default_quellensteuer_pct: unknown; default_employer_ahv_pct: unknown;
  default_employer_alv_pct: unknown; default_employer_fak_pct: unknown; default_employer_bu_pct: unknown;
  default_employer_bvg_pct: unknown; default_employer_verwaltung_pct: unknown; bvg_threshold_chf: unknown;
}

export function firmensatzAusZeile(r: FirmensatzZeile): Firmensatz {
  return {
    gueltigAb: r.effective_from,
    an: {
      ahvIvEo: zahl(r.default_ahv_iv_eo_pct), alv: zahl(r.default_alv_pct), nbu: zahl(r.default_nbu_pct),
      bvg: zahl(r.default_bvg_pct), ktg: zahl(r.default_ktg_pct), quellensteuer: zahl(r.default_quellensteuer_pct),
    },
    ag: {
      ahvIvEo: zahl(r.default_employer_ahv_pct), alv: zahl(r.default_employer_alv_pct), fak: zahl(r.default_employer_fak_pct),
      bu: zahl(r.default_employer_bu_pct), bvg: zahl(r.default_employer_bvg_pct), verwaltung: zahl(r.default_employer_verwaltung_pct),
    },
    bvgSchwelleMonat: zahl(r.bvg_threshold_chf),
  };
}

export async function ladeFirmensaetze(admin: SupabaseClient): Promise<Firmensatz[]> {
  const zeilen = await ladeAlleSeiten<FirmensatzZeile>(
    (von, bis) => admin.from("payroll_defaults").select("*").order("effective_from").range(von, bis),
    "Firmensätze",
  );
  return zeilen.map(firmensatzAusZeile);
}

// ---------------------------------------------------------------------------
// Lohnzeilen
// ---------------------------------------------------------------------------
export const LOHNZEILE_SPALTEN =
  "id, profile_id, hourly_wage_chf, effective_from, effective_to, uses_standard_lohn, ferienanteil_pct_override, wage_exempt, auto_lohnabrechnung, " +
  "ahv_iv_eo_pct, alv_pct, nbu_pct, bvg_pct, ktg_pct, quellensteuer_pct, employer_ahv_pct, employer_alv_pct, employer_fak_pct, employer_bu_pct, employer_bvg_pct, employer_verwaltung_pct";

export interface LohnzeileRoh {
  id: string;
  profile_id: string;
  hourly_wage_chf: unknown;
  effective_from: string;
  effective_to: string | null;
  uses_standard_lohn: boolean | null;
  ferienanteil_pct_override: unknown;
  wage_exempt: boolean | null;
  auto_lohnabrechnung: boolean | null;
  ahv_iv_eo_pct: unknown; alv_pct: unknown; nbu_pct: unknown; bvg_pct: unknown; ktg_pct: unknown; quellensteuer_pct: unknown;
  employer_ahv_pct: unknown; employer_alv_pct: unknown; employer_fak_pct: unknown; employer_bu_pct: unknown;
  employer_bvg_pct: unknown; employer_verwaltung_pct: unknown;
}

export function lohnzeileAusRoh(r: LohnzeileRoh): Lohnzeile {
  return {
    id: r.id,
    gueltigAb: r.effective_from,
    gueltigBis: r.effective_to,
    stundenlohn: zahl(r.hourly_wage_chf),
    stundenlohnArt: "inkl_ferien",
    ferienPctFix: r.ferienanteil_pct_override == null ? null : zahl(r.ferienanteil_pct_override),
    ohneLohn: r.wage_exempt === true,
    eigeneSaetze: r.uses_standard_lohn === false
      ? {
          an: { ahvIvEo: zahl(r.ahv_iv_eo_pct), alv: zahl(r.alv_pct), nbu: zahl(r.nbu_pct), bvg: zahl(r.bvg_pct), ktg: zahl(r.ktg_pct), quellensteuer: zahl(r.quellensteuer_pct) },
          ag: { ahvIvEo: zahl(r.employer_ahv_pct), alv: zahl(r.employer_alv_pct), fak: zahl(r.employer_fak_pct), bu: zahl(r.employer_bu_pct), bvg: zahl(r.employer_bvg_pct), verwaltung: zahl(r.employer_verwaltung_pct) },
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Personen-Daten
// ---------------------------------------------------------------------------
export interface LohnPerson {
  profileId: string;
  name: string;
  role: string | null;
  email: string | null;
  aktiv: boolean;
  person: Person;
  lohnzeilenRoh: LohnzeileRoh[];
  lohnzeilen: Lohnzeile[];
  stempel: Stempel[];
}

interface AnstellungRoh {
  profile_id: string;
  eintritt: string;
  austritt: string | null;
  ruhend_von: string | null;
  ruhend_bis: string | null;
  ahv_verlangt_jahre: number[] | null;
}

/** UTC-Grenze sicher vor/nach einem lokalen Kalendertag (Puffer 1 Tag). */
function utcVor(datum: string): string {
  return `${plusTage(datum, -1)}T00:00:00Z`;
}
function utcNach(datum: string): string {
  return `${plusTage(datum, 2)}T00:00:00Z`;
}

/**
 * Lädt für die Personen alles, was der Kern braucht: Profil (Geburtsdatum),
 * Anstellungen, Lohnzeilen, Stempel im Bereich [von, bis] (lokale Tage;
 * offene Stempel inklusive, der Kern zählt sie nicht).
 */
export async function ladeLohnPersonen(
  admin: SupabaseClient,
  profileIds: string[],
  bereich: { von: string; bis: string },
): Promise<Map<string, LohnPerson>> {
  const ids = Array.from(new Set(profileIds));
  const out = new Map<string, LohnPerson>();
  if (ids.length === 0) return out;

  const profile: { id: string; full_name: string | null; role: string | null; email: string | null; birthdate: string | null; is_active: boolean | null }[] = [];
  const zeilen: LohnzeileRoh[] = [];
  const anst: AnstellungRoh[] = [];
  const stempel: { id: string; user_id: string; clock_in: string; clock_out: string | null }[] = [];
  for (const teil of inStuecken(ids)) {
    const [p, z, a, s] = await Promise.all([
      ladeAlleSeiten<(typeof profile)[number]>((von, bis) => admin.from("profiles").select("id, full_name, role, email, birthdate, is_active").in("id", teil).order("id").range(von, bis), "Profile"),
      ladeAlleSeiten<LohnzeileRoh>((von, bis) => admin.from("employee_compensation").select(LOHNZEILE_SPALTEN).in("profile_id", teil).order("id").range(von, bis) as unknown as PromiseLike<{ data: LohnzeileRoh[] | null; error: { message: string } | null }>, "Lohnzeilen"),
      ladeAlleSeiten<AnstellungRoh>((von, bis) => admin.from("lohn_anstellungen").select("profile_id, eintritt, austritt, ruhend_von, ruhend_bis, ahv_verlangt_jahre").in("profile_id", teil).order("id").range(von, bis), "Anstellungen"),
      ladeAlleSeiten<(typeof stempel)[number]>((von, bis) => admin.from("time_entries").select("id, user_id, clock_in, clock_out").in("user_id", teil)
        .gte("clock_in", utcVor(bereich.von)).lt("clock_in", utcNach(bereich.bis)).order("id").range(von, bis), "Stempelzeiten"),
    ]);
    profile.push(...p);
    zeilen.push(...z);
    anst.push(...a);
    stempel.push(...s);
  }

  for (const p of profile) {
    const eigeneAnst = anst.filter((a) => a.profile_id === p.id);
    const anstellungen: Anstellung[] | null = eigeneAnst.length === 0
      ? null
      : eigeneAnst.map((a) => ({ eintritt: a.eintritt, austritt: a.austritt, ruhendVon: a.ruhend_von, ruhendBis: a.ruhend_bis }));
    const ahvVerlangtJahre = Array.from(new Set(eigeneAnst.flatMap((a) => a.ahv_verlangt_jahre ?? []))).sort();
    const roh = zeilen.filter((z) => z.profile_id === p.id).sort((a, b) => a.effective_from.localeCompare(b.effective_from));
    out.set(p.id, {
      profileId: p.id,
      name: p.full_name ?? "?",
      role: p.role,
      email: p.email,
      aktiv: p.is_active === true,
      person: { id: p.id, geburtsdatum: p.birthdate, anstellungen, ahvVerlangtJahre },
      lohnzeilenRoh: roh,
      lohnzeilen: roh.map(lohnzeileAusRoh),
      stempel: stempel
        .filter((s) => s.user_id === p.id)
        .sort((a, b) => a.clock_in.localeCompare(b.clock_in) || a.id.localeCompare(b.id))
        .map((s) => ({ id: s.id, start: s.clock_in, ende: s.clock_out })),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auszahlung, bisherige Löhne im Auszahlungsjahr
// ---------------------------------------------------------------------------

/** Regel-Auszahlungsdatum des Lohnmonats (n-ter Arbeitstag des Folgemonats, Feiertage BS). */
export function regelAuszahlungsdatum(jahr: number, monat: number, arbeitstag: number): string {
  return auszahlungsdatumNachRegel(jahr, monat, arbeitstag, feiertageBaselStadtJahre(jahr, jahr + 1));
}

export interface FassungsSumme {
  profile_id: string;
  jahr: number;
  monat: number;
  ahv_lohn: number;
  alv_lohn: number;
  uvg_lohn: number;
  /** Auszahlungsdatum der ursprünglichen Abrechnung (Sätze-Datum). */
  auszahlung_original: string;
}

/** Gültige (letzte) Fassungen der Personen in den Lohnjahren [vonJahr, bisJahr]. */
export async function ladeGueltigeFassungen(admin: SupabaseClient, profileIds: string[], vonJahr: number, bisJahr: number): Promise<FassungsSumme[]> {
  const out: FassungsSumme[] = [];
  for (const teil of inStuecken(Array.from(new Set(profileIds)))) {
    const zeilen = await ladeAlleSeiten<{ profile_id: string; jahr: number; monat: number; ahv_lohn: unknown; alv_lohn: unknown; uvg_lohn: unknown; auszahlungsdatum: string; orig: string | null }>(
      (von, bis) => admin.from("lohn_fassungen_gueltig").select("profile_id, jahr, monat, ahv_lohn, alv_lohn, uvg_lohn, auszahlungsdatum, orig:ergebnis->>auszahlungsdatum")
        .in("profile_id", teil).gte("jahr", vonJahr).lte("jahr", bisJahr).order("profile_id").order("jahr").order("monat").range(von, bis),
      "Fassungen",
    );
    for (const z of zeilen) {
      out.push({
        profile_id: z.profile_id, jahr: z.jahr, monat: z.monat,
        ahv_lohn: Number(z.ahv_lohn), alv_lohn: Number(z.alv_lohn), uvg_lohn: Number(z.uvg_lohn),
        auszahlung_original: z.orig ?? z.auszahlungsdatum,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rechnen
// ---------------------------------------------------------------------------
export function monatsEingabe(
  p: LohnPerson,
  firmensaetze: Firmensatz[],
  jahr: number,
  monat: number,
  auszahlungsdatum: string,
  bisher?: BisherImAuszahlungsjahr,
  zusatzStempel: Stempel[] = [],
): MonatsEingabe {
  const b = stempelBereich(jahr, monat);
  const stempel = [...p.stempel, ...zusatzStempel].filter((s) => {
    const t = new Date(s.start).getTime();
    return t >= new Date(utcVor(b.von)).getTime() && t < new Date(utcNach(b.bis)).getTime();
  });
  return {
    jahr,
    monat,
    person: p.person,
    stempel,
    lohnzeilen: p.lohnzeilen,
    firmensaetze,
    feiertage: feiertageBaselStadtJahre(Number(b.von.slice(0, 4)), Number(b.bis.slice(0, 4)) + 1),
    auszahlungsdatum,
    bisher: bisher ?? { ahvLohn: 0, alvLohn: 0, uvgLohn: 0 },
  };
}

export type RechenErgebnis =
  | { ok: true; eingabe: MonatsEingabe; ergebnis: MonatsErgebnis }
  | { ok: false; eingabe: MonatsEingabe; fehler: string; code: string };

/** Rechnet einen Monat; Kern-Fehler kommen als Ergebnis zurück (nie geschluckt). */
export function rechne(eingabe: MonatsEingabe): RechenErgebnis {
  try {
    return { ok: true, eingabe, ergebnis: rechneMonat(eingabe) };
  } catch (e) {
    if (e instanceof KernFehler) return { ok: false, eingabe, fehler: e.message, code: e.code };
    throw e;
  }
}

/** Stempel-Bereich für mehrere Monate (Vereinigung). */
export function bereichFuerMonate(monate: { jahr: number; monat: number }[]): { von: string; bis: string } {
  let von = "";
  let bis = "";
  for (const m of monate) {
    const b = stempelBereich(m.jahr, m.monat);
    if (!von || b.von < von) von = b.von;
    if (!bis || b.bis > bis) bis = b.bis;
  }
  return { von, bis };
}

export interface MonatsAuftrag {
  jahr: number;
  monat: number;
}

export const monatKey = (jahr: number, monat: number) => `${jahr}-${String(monat).padStart(2, "0")}`;

/** Frühere Lohnmonate, die im selben Jahr ausbezahlt werden wie Monat M
 *  (Auszahlung im Folgemonat: Dezember des Vorjahres bis M-1; für den
 *  Dezember beginnt ein neues Auszahlungsjahr). */
export function vormonateImAuszahlungsjahr(jahr: number, monat: number): MonatsAuftrag[] {
  if (monat === 12) return [];
  const out: MonatsAuftrag[] = [{ jahr: jahr - 1, monat: 12 }];
  for (let m = 1; m < monat; m++) out.push({ jahr, monat: m });
  return out;
}

/** Stempel-Bereich inklusive der Vormonate im Auszahlungsjahr (für «bisher»). */
export function bereichMitVormonaten(monate: MonatsAuftrag[]): { von: string; bis: string } {
  return bereichFuerMonate([...monate, ...monate.flatMap((m) => vormonateImAuszahlungsjahr(m.jahr, m.monat))]);
}

/**
 * Die gemeinsame Rechnung aller Wege: lädt einmal (Personen, Lohnzeilen,
 * Anstellungen, Stempel, Firmensätze, Fassungen) und rechnet je Person und
 * Monat mit dem Kern. Kern-Fehler stehen im Ergebnis (ok: false).
 *  - auszahlungsdatum: Standard = Regel (n-ter Arbeitstag Folgemonat)
 *  - zusatzStempel: z. B. geplante Termine für Prognosen
 *  - «bisher» (2'500-Grenze, Höchstlöhne): je früherem Monat im selben
 *    Auszahlungsjahr die gültige Fassung, sonst die Kern-Rechnung des Monats.
 *  - personen: vorgeladen mit bereichMitVormonaten(monate)
 */
export async function rechneMonate(
  admin: SupabaseClient,
  profileIds: string[],
  monate: MonatsAuftrag[],
  opts: {
    auszahlungsdatum?: (jahr: number, monat: number) => string;
    zusatzStempel?: Map<string, Stempel[]>;
    personen?: Map<string, LohnPerson>;
    firmensaetze?: Firmensatz[];
  } = {},
): Promise<{ personen: Map<string, LohnPerson>; firmensaetze: Firmensatz[]; ergebnisse: Map<string, Map<string, RechenErgebnis>> }> {
  const ergebnisse = new Map<string, Map<string, RechenErgebnis>>();
  if (profileIds.length === 0 || monate.length === 0) {
    return { personen: opts.personen ?? new Map(), firmensaetze: opts.firmensaetze ?? [], ergebnisse };
  }
  const einst = await ladeLohnEinstellungen(admin);
  const regel = (j: number, m: number) => regelAuszahlungsdatum(j, m, einst.auszahlungArbeitstag);
  const datum = opts.auszahlungsdatum ?? regel;
  const jahre = monate.map((m) => m.jahr);
  const [personen, firmensaetze, fassungen] = await Promise.all([
    opts.personen ? Promise.resolve(opts.personen) : ladeLohnPersonen(admin, profileIds, bereichMitVormonaten(monate)),
    opts.firmensaetze ? Promise.resolve(opts.firmensaetze) : ladeFirmensaetze(admin),
    ladeGueltigeFassungen(admin, profileIds, Math.min(...jahre) - 1, Math.max(...jahre)),
  ]);
  const nul = { ahvLohn: 0, alvLohn: 0, uvgLohn: 0 };
  for (const id of profileIds) {
    const p = personen.get(id);
    if (!p) continue;
    const zusatz = opts.zusatzStempel?.get(id) ?? [];
    // Löhne früherer Monate: Fassung, sonst Kern (ohne «bisher»; beeinflusst nur Höchstlöhne).
    const vorCache = new Map<string, { ahv: number; alv: number; uvg: number; jahr: number }>();
    const vorLohn = (j: number, m: number) => {
      const k = monatKey(j, m);
      let v = vorCache.get(k);
      if (!v) {
        const f = fassungen.find((z) => z.profile_id === id && z.jahr === j && z.monat === m);
        if (f) {
          v = { ahv: f.ahv_lohn, alv: f.alv_lohn, uvg: f.uvg_lohn, jahr: Number(f.auszahlung_original.slice(0, 4)) };
        } else {
          const az = regel(j, m);
          const r = rechne(monatsEingabe(p, firmensaetze, j, m, az, nul, zusatz));
          v = r.ok ? { ahv: r.ergebnis.loehne.ahv, alv: r.ergebnis.loehne.alv, uvg: r.ergebnis.loehne.uvg, jahr: Number(az.slice(0, 4)) } : { ahv: 0, alv: 0, uvg: 0, jahr: 0 };
        }
        vorCache.set(k, v);
      }
      return v;
    };
    const jePerson = new Map<string, RechenErgebnis>();
    for (const m of monate) {
      const az = datum(m.jahr, m.monat);
      const azJahr = Number(az.slice(0, 4));
      const bisher = { ahvLohn: 0, alvLohn: 0, uvgLohn: 0 };
      for (const v of vormonateImAuszahlungsjahr(m.jahr, m.monat)) {
        const l = vorLohn(v.jahr, v.monat);
        if (l.jahr !== azJahr) continue;
        bisher.ahvLohn += l.ahv;
        bisher.alvLohn += l.alv;
        bisher.uvgLohn += l.uvg;
      }
      const runde = (x: number) => Number(x.toFixed(2));
      jePerson.set(monatKey(m.jahr, m.monat), rechne(monatsEingabe(p, firmensaetze, m.jahr, m.monat, az,
        { ahvLohn: runde(bisher.ahvLohn), alvLohn: runde(bisher.alvLohn), uvgLohn: runde(bisher.uvgLohn) }, zusatz)));
    }
    ergebnisse.set(id, jePerson);
  }
  return { personen, firmensaetze, ergebnisse };
}
