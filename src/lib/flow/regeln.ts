// Regeln der Trust-flow-Schnittstelle je Route (rein, ohne Datenbank).
//
//   pruefeMonatsClaims     Stempel/Vergleich: jahr, monat, profile (≤ 50), Stempel-Bereich
//   pruefeStammdatenClaims Stammdaten (A6): nur profile (≤ 50); jahr/monat/von/bis werden ignoriert
//   pruefeAblageClaims     Lohnabrechnung: erp_profil_id, jahr, monat (ab 12/2026), fassung, sha256
//   lokalerMonat, monateDesStempels, zaehleUeberlappungen, nachtraeglichGeaendert
//   vergleichAusMomentaufnahme
//   teileName, stammdatenPerson
//   pruefeAblageKoerper, dekodierePdf
//
// Vertrag: _backoffice-uebergabe/10_Schnittstelle_Stunden.md (A1), 07_Rueckfragen.md (A5; A6 30.10. 12:20–13:00),
// A6 genau: supabase/lokal/live-gang-a6/VERTRAG.md.
// Unit-Tests: regeln.test.ts.

import { createHash } from "node:crypto";
import { lokalesDatum, stempelBereich } from "@/lib/lohn/kern";
import { istIntern } from "@/lib/roles";
import { istUuid, type FlowAud } from "./ausweis";

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

/** Routen ohne Lohnmonat: jahr/monat im Ausweis werden ignoriert (auch nicht protokolliert). */
const OHNE_MONAT: ReadonlySet<FlowAud> = new Set<FlowAud>(["flow-stammdaten"]);

/** Kennzahlen fürs Protokoll, bevor die Route die Claims streng prüft (nie Wurf). */
export function protokollKennzahlen(
  c: Record<string, unknown>,
  aud?: FlowAud,
): { jahr: number | null; monat: number | null; angefragt: number | null } {
  const jm = aud && OHNE_MONAT.has(aud) ? null : jahrMonat(c);
  const angefragt = Array.isArray(c.profile) ? c.profile.length : istUuid(c.erp_profil_id) ? 1 : null;
  return { jahr: jm?.jahr ?? null, monat: jm?.monat ?? null, angefragt };
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

export interface StammdatenAnfrage {
  /** ERP-Profil-IDs (klein geschrieben, eindeutig, Anfrage-Reihenfolge). */
  profile: string[];
}

/** Claims der Stammdaten (A6): nur `profile` — jahr/monat/von/bis dürfen fehlen und werden ignoriert. */
export function pruefeStammdatenClaims(c: Record<string, unknown>): { ok: true; anfrage: StammdatenAnfrage } | RegelFehler {
  const p = pruefeProfilListe(c);
  return p.ok ? { ok: true, anfrage: { profile: p.profile } } : p;
}

export interface AblageAnfrage {
  profileId: string;
  jahr: number;
  monat: number;
  /** Fassung laut Trust flow/Bexio (1 = erste Abrechnung des Monats). */
  fassung: number;
  sha256: string;
}

/** Claims der Lohnabrechnungs-Ablage (A5). */
export function pruefeAblageClaims(c: Record<string, unknown>): { ok: true; anfrage: AblageAnfrage } | RegelFehler {
  if (!istUuid(c.erp_profil_id)) return fehler("person_ungueltig", "erp_profil_id fehlt oder ist ungültig.");
  const jm = jahrMonat(c);
  if (!jm) return fehler("monat_ungueltig", "jahr/monat fehlen oder sind ungültig.");
  if (vor(jm, BEXIO_AB)) {
    return fehler("erp_monat", `Lohnabrechnungen aus Bexio erst ab Lohnmonat ${monatText(BEXIO_AB.jahr, BEXIO_AB.monat)}.`, 422);
  }
  if (!Number.isInteger(c.fassung) || (c.fassung as number) < 1 || (c.fassung as number) > 99) {
    return fehler("fassung_ungueltig", "fassung (1–99) fehlt oder ist ungültig.");
  }
  if (typeof c.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(c.sha256)) {
    return fehler("sha256_ungueltig", "sha256 (64 Zeichen hex, klein) fehlt oder ist ungültig.");
  }
  return {
    ok: true,
    anfrage: { profileId: (c.erp_profil_id as string).toLowerCase(), ...jm, fassung: c.fassung as number, sha256: c.sha256 },
  };
}

// ---------------------------------------------------------------------------
// Personen
// ---------------------------------------------------------------------------

/** /personen nimmt auch inaktive interne Profile, deren ERP-Anstellung an diesem Tag noch läuft (Austritt
 *  offen oder später) — ab Lohnmonat Dezember 2026 rechnet Trust flow, sie müssen dort zuordenbar sein. */
export const PERSONEN_ANSTELLUNG_AB = `${monatText(BEXIO_AB.jahr, BEXIO_AB.monat)}-01`;

export interface PersonenKandidat {
  id: string;
  full_name: string | null;
  role: string | null;
  is_active: boolean | null;
}

/**
 * Auswahlliste für «Personal bearbeiten» in Trust flow: interne Profile (kein Partner-/Lieferanten-Zugang),
 * die aktiv sind ODER eine ERP-Anstellung haben, die am PERSONEN_ANSTELLUNG_AB noch läuft (`laufend`).
 * Nach Name sortiert; `aktiv` sagt, ob das ERP-Konto aktiv ist.
 */
export function personenAuswahl(
  kandidaten: PersonenKandidat[],
  laufend: ReadonlySet<string>,
): { erp_profil_id: string; name: string; aktiv: boolean }[] {
  const gesehen = new Set<string>();
  const out: { erp_profil_id: string; name: string; aktiv: boolean }[] = [];
  for (const p of kandidaten) {
    const id = p.id.toLowerCase();
    if (gesehen.has(id) || !istIntern(p.role)) continue;
    const aktiv = p.is_active === true;
    if (!aktiv && !laufend.has(id)) continue;
    gesehen.add(id);
    out.push({ erp_profil_id: id, name: String(p.full_name ?? "").trim(), aktiv });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name, "de-CH") || x.erp_profil_id.localeCompare(y.erp_profil_id));
}

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
// Stammdaten (A6) — Antwortform wie der Import in Trust flow (VERTRAG.md)
// ---------------------------------------------------------------------------

/** Arbeitgeberin aller Anstellungen im ERP (gleicher Wert wie der Claim `firma`). */
export const STAMMDATEN_FIRMA = "eventline";

/** Individuelle Arbeitnehmer-Sätze, die Trust flow übernimmt — nur bei `standard: false` befüllt, sonst null.
 *  AHV/IV/EO, ALV, KTG und alle Arbeitgebersätze bewusst NICHT (Trust flow nimmt eigene Werte). */
export const STAMMDATEN_SAETZE = ["quellensteuer_pct", "nbu_pct", "bvg_pct"] as const;
type Satz = (typeof STAMMDATEN_SAETZE)[number];

/**
 * lohn_anstellungen.vertragsart → Lohnform in Trust flow. Arbeit auf Abruf (echt/unecht) wird im
 * Stundenlohn bezahlt. «fest» sagt nur «Festanstellung», nicht die Lohnform → null (beim Bestätigen
 * in Trust flow wählen; im ERP selbst ist jede Lohnzeile ein Stundenlohn). Unbekannte Werte → null.
 */
export const VERTRAGSART_LOHNFORM: Readonly<Record<string, "stundenlohn" | "monatslohn" | null>> = {
  abruf_unecht: "stundenlohn",
  abruf_echt: "stundenlohn",
  fest: null,
};

/**
 * Art des Ansatzes: Das ERP führt hourly_wage_chf IMMER inklusive Ferienzuschlag (Verträge «26.00 inkl.
 * 8,33 % Ferien»; src/lib/lohn/daten.ts lohnzeileAusRoh → stundenlohnArt "inkl_ferien", der Kern rechnet
 * Basislohn = Ansatz / (1 + Ferien-%), Ferien-% = ferien_pct der Zeile oder nach Alter). Es gibt keine
 * Zeile mit Basislohn — darum überall "inkl_ferien".
 */
export const STAMMDATEN_ANSATZ_ART = "inkl_ferien" as const;

export interface StammdatenProfilRoh {
  id: string;
  full_name: string | null;
  birthdate: string | null;
}

export interface StammdatenAnstellungRoh {
  profile_id: string;
  eintritt: string;
  austritt: string | null;
  vertragsart: string | null;
}

export type StammdatenLohnzeileRoh = {
  profile_id: string;
  effective_from: string;
  hourly_wage_chf: unknown;
  uses_standard_lohn: boolean | null;
  /** «kein Lohn» (z. B. Inhaber): der Kern bezahlt die Minuten nicht → ansatz null. */
  wage_exempt: boolean | null;
  /** Fester Ferienzuschlag in % dieser Zeile (Vertrag); null = nach Alter (Kern: ferienPctFix). */
  ferienanteil_pct_override: unknown;
} & Record<Satz, unknown>;

export interface StammdatenAnstellung {
  firma: string;
  eintritt: string;
  austritt: string | null;
  vertragsart: "stundenlohn" | "monatslohn" | null;
}

export interface StammdatenLohnzeile {
  gueltig_ab: string;
  /** CHF je Stunde (inkl. Ferienzuschlag, siehe ansatz_art); null = Zeile «kein Lohn» (wage_exempt). */
  ansatz: number | null;
  standard: boolean;
  quellensteuer_pct: number | null;
  nbu_pct: number | null;
  bvg_pct: number | null;
  ansatz_art: "basis" | "inkl_ferien";
  /** Festes Ferien-% der Zeile (ferienanteil_pct_override), unabhängig von `standard`; null = Ferien-% nach Alter. */
  ferien_pct: number | null;
}

export interface StammdatenPerson {
  erp_profil_id: string;
  name: string;
  vorname: string;
  geburtsdatum: string | null;
  anstellungen: StammdatenAnstellung[];
  lohnzeilen: StammdatenLohnzeile[];
}

/**
 * Das ERP führt nur einen Namen (profiles.full_name, «Vorname Nachname»): erstes Wort = Vorname, Rest = Name.
 * Ein einzelnes Wort gilt als Name (Vorname leer). Doppelvornamen korrigiert das Bestätigen in Trust flow.
 */
export function teileName(voll: string | null): { name: string; vorname: string } {
  const w = (voll ?? "").trim().split(/\s+/).filter(Boolean);
  if (w.length === 0) return { name: "", vorname: "" };
  if (w.length === 1) return { name: w[0], vorname: "" };
  return { name: w.slice(1).join(" "), vorname: w[0] };
}

const DATUM = /^\d{4}-\d{2}-\d{2}$/;
const datumOderNull = (x: unknown): string | null => (typeof x === "string" && DATUM.test(x) ? x : null);
const zahlOderNull = (x: unknown): number | null => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));

/**
 * Stammdaten einer Person für den Import in Trust flow — NUR diese Felder (keine AHV-Nr., IBAN, Adresse,
 * Konfession, Arbeitgebersätze, Notizen). Anstellungen nach Eintritt, Lohnzeilen nach «gültig ab» sortiert;
 * Sätze nur, wenn die Zeile nicht die Standardwerte nimmt (uses_standard_lohn = false — gleiche Regel wie
 * der Kern, src/lib/lohn/daten.ts), sonst null.
 */
export function stammdatenPerson(
  p: StammdatenProfilRoh,
  anstellungen: StammdatenAnstellungRoh[],
  lohnzeilen: StammdatenLohnzeileRoh[],
): StammdatenPerson {
  const id = p.id.toLowerCase();
  const eigen = <T extends { profile_id: string }>(l: T[]) => l.filter((z) => z.profile_id.toLowerCase() === id);
  return {
    erp_profil_id: id,
    ...teileName(p.full_name),
    geburtsdatum: datumOderNull(p.birthdate),
    anstellungen: eigen(anstellungen)
      .sort((x, y) => x.eintritt.localeCompare(y.eintritt))
      .map((a) => ({
        firma: STAMMDATEN_FIRMA,
        eintritt: a.eintritt,
        austritt: a.austritt ?? null,
        vertragsart: VERTRAGSART_LOHNFORM[a.vertragsart ?? ""] ?? null,
      })),
    lohnzeilen: eigen(lohnzeilen)
      .sort((x, y) => x.effective_from.localeCompare(y.effective_from))
      .map((z) => {
        const standard = z.uses_standard_lohn !== false;
        return {
          gueltig_ab: z.effective_from,
          ansatz: z.wage_exempt === true ? null : zahlOderNull(z.hourly_wage_chf),
          standard,
          quellensteuer_pct: standard ? null : zahlOderNull(z.quellensteuer_pct),
          nbu_pct: standard ? null : zahlOderNull(z.nbu_pct),
          bvg_pct: standard ? null : zahlOderNull(z.bvg_pct),
          ansatz_art: STAMMDATEN_ANSATZ_ART,
          ferien_pct: zahlOderNull(z.ferienanteil_pct_override),
        };
      }),
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
