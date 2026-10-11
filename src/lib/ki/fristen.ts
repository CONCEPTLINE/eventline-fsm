// Frist-Rechnung der Nachtarbeit (docs/lokale-ki/MASTERPLAN.md §3.7).
// Hausregel «WO rechnen deterministisch, KI nur WAS»: das Hauptmodell auf
// dem Rig liefert nur die Vertragsbedingungen (Beginn, Ende, Laufzeit,
// Verlaengerung, Kuendigungsfrist, Faelligkeit), das Datum rechnet dieser
// Code. Rein (kein I/O), alle Daten als Kalendertage YYYY-MM-DD in
// Europe/Zurich — keine Date-Zeitzonen-Arithmetik.

import { plusTage } from "@/lib/swiss-time";
import { KI_FRIST_MAX_JAHRE } from "./konstanten";
import type { FristArt, FristBedingungen } from "./typen";

export const FRIST_ARTEN: readonly FristArt[] = ["kuendigung", "ablauf", "vertragsende", "verlaengerung", "zahlung", "sonstige"];

/** Anzeige-Namen fuer die strukturierte Bezeichnung («<Art> · <Partei>»). */
export const FRIST_ART_LABEL: Readonly<Record<FristArt, string>> = {
  kuendigung: "Kündigung",
  ablauf: "Ablauf",
  vertragsende: "Vertragsende",
  verlaengerung: "Verlängerung",
  zahlung: "Zahlung",
  sonstige: "Frist",
};

export type FristGrund = "frist_unvollstaendig" | "frist_vergangen" | "frist_zu_fern";
export type FristRechnung = { ok: true; datum: string } | { ok: false; grund: FristGrund };

const DATUM_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Gueltiges Kalenderdatum YYYY-MM-DD (1900–2199), sonst null. */
export function leseDatum(roh: unknown): string | null {
  if (typeof roh !== "string") return null;
  const m = DATUM_RE.exec(roh);
  if (!m) return null;
  const j = Number(m[1]);
  const mo = Number(m[2]);
  const t = Number(m[3]);
  if (j < 1900 || j > 2199 || mo < 1 || mo > 12 || t < 1 || t > tageImMonat(j, mo)) return null;
  return roh;
}

function tageImMonat(jahr: number, monat: number): number {
  // Tag 0 des Folgemonats = letzter Tag dieses Monats (UTC, zeitzonenfrei).
  return new Date(Date.UTC(jahr, monat, 0)).getUTCDate();
}

function teile(iso: string): [number, number, number] {
  const [j, m, t] = iso.split("-").map(Number);
  return [j, m, t];
}

function iso(j: number, m: number, t: number): string {
  return `${String(j).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(t).padStart(2, "0")}`;
}

/** Datum + n Monate (n darf negativ sein), kalendarisch: ist das Datum ein
 *  Monatsende, ist das Ergebnis das Monatsende des Zielmonats (31.12. − 3
 *  Monate = 30.09.); sonst wird der Tag auf die Laenge des Zielmonats
 *  geklemmt (31.01. + 1 Monat = 28./29.02.). */
export function plusMonate(datum: string, n: number): string {
  const [j, m, t] = teile(datum);
  const monatsende = t === tageImMonat(j, m);
  const index = j * 12 + (m - 1) + n;
  const zj = Math.floor(index / 12);
  const zm = index - zj * 12 + 1;
  const laenge = tageImMonat(zj, zm);
  return iso(zj, zm, monatsende ? laenge : Math.min(t, laenge));
}

/** Kuendigungstermin = Vertragsende − Kuendigungsfrist. */
function minusFrist(ende: string, frist: NonNullable<FristBedingungen["kuendigungsfrist"]>): string {
  if (frist.einheit === "monate") return plusMonate(ende, -frist.anzahl);
  if (frist.einheit === "wochen") return plusTage(ende, -7 * frist.anzahl);
  return plusTage(ende, -frist.anzahl);
}

/** Schutz gegen Endlosschleifen bei sehr alten Vertraegen mit kurzer
 *  Verlaengerung (z. B. Beginn 1990, monatlich). */
const MAX_PERIODEN = 2_000;

/**
 * Rechnet aus den Bedingungen das Frist-Datum (MASTERPLAN §3.7):
 *  1. zahlung/sonstige oder `faellig` gesetzt -> faellig.
 *  2. Vertragsende E = ende, sonst beginn + laufzeit − 1 Tag, sonst keine Frist.
 *  3. E < heute: mit Verlaengerung E so lange verschieben, bis E >= heute;
 *     ohne -> frist_vergangen.
 *  4. ablauf/vertragsende/verlaengerung -> E.
 *  5. kuendigung -> E − Kuendigungsfrist; liegt das vor heute, mit
 *     Verlaengerung die naechste Periode, sonst frist_vergangen.
 *  6. Plausibel nur heute <= datum <= heute + 10 Jahre.
 */
export function berechneFrist(art: FristArt, b: FristBedingungen, heute: string): FristRechnung {
  const grenze = plusMonate(heute, KI_FRIST_MAX_JAHRE * 12);
  const pruefe = (datum: string): FristRechnung => {
    if (datum < heute) return { ok: false, grund: "frist_vergangen" };
    if (datum > grenze) return { ok: false, grund: "frist_zu_fern" };
    return { ok: true, datum };
  };

  // 1. Faelligkeit
  if (art === "zahlung" || art === "sonstige" || b.faellig) {
    return b.faellig ? pruefe(b.faellig) : { ok: false, grund: "frist_unvollstaendig" };
  }

  // 2. Vertragsende
  let ende: string | null = b.ende;
  if (!ende && b.beginn && b.laufzeit_monate) ende = plusTage(plusMonate(b.beginn, b.laufzeit_monate), -1);
  if (!ende) return { ok: false, grund: "frist_unvollstaendig" };
  if (art === "kuendigung" && !b.kuendigungsfrist) return { ok: false, grund: "frist_unvollstaendig" };

  const verl = b.verlaengerung_monate;
  // Periode k immer vom Ausgangs-Ende aus rechnen (ende0 + k × Verlaengerung),
  // nie Schritt fuer Schritt: ein geklemmter Tag (30.01. -> 28.02.) gaelte
  // sonst ab da als Monatsende und das Datum wanderte auf den 31.
  const ende0 = ende;
  const endeDerPeriode = (k: number): string => (k === 0 ? ende0 : plusMonate(ende0, k * verl!));
  // 3. Vergangenes Ende in die laufende Periode schieben
  let perioden = 0;
  while (ende < heute) {
    if (!verl) return { ok: false, grund: "frist_vergangen" };
    if (++perioden > MAX_PERIODEN) return { ok: false, grund: "frist_vergangen" };
    ende = endeDerPeriode(perioden);
  }

  // 4. Ablauf-Arten
  if (art !== "kuendigung") return pruefe(ende);

  // 5. Kuendigungstermin; verpasst -> naechste Periode (falls verlaengert)
  const frist = b.kuendigungsfrist!;
  let datum = minusFrist(ende, frist);
  while (datum < heute) {
    if (!verl) return { ok: false, grund: "frist_vergangen" };
    if (++perioden > MAX_PERIODEN) return { ok: false, grund: "frist_vergangen" };
    ende = endeDerPeriode(perioden);
    datum = minusFrist(ende, frist);
  }
  return pruefe(datum);
}
