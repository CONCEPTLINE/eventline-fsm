// Rechenkern Lohn — Stempel auf Tage, Nächte und Sonntage verteilen.
//
// Regeln:
//   - Überlappende Stempel einer Person zählen jede Minute nur einmal.
//   - Offene Stempel (ohne Ende) zählen nicht.
//   - Minuten ausserhalb der Anstellung zählen nicht (weder Lohn noch Zähler).
//   - Nacht = 23:00–06:00. EINE Nacht = Abend 23:00 bis Morgen 06:00; sie
//     gehört zum Datum (und Kalenderjahr) des Abends, an dem sie um 23 Uhr
//     beginnt — auch eine Schicht über Mitternacht ist nur EINE Nacht.
//   - Sonntag = Samstag 23:00 bis Sonntag 23:00; Feiertage (inkl. 1. August)
//     gleich: Vortag 23:00 bis Feiertag 23:00. Schlüssel = Datum des
//     Sonn-/Feiertags, Rang im Kalenderjahr dieses Datums.

import type { Anstellung, Feiertag, Stempel } from "./typen";
import { NACHT_BIS_STUNDE, NACHT_VON_STUNDE, SONNTAG_BEGINN_VORTAG_STUNDE } from "./regeln";
import { jeLokalerStunde, plusTage, vereinige, wochentag, wochenMontag, zuMs } from "./zeit";

export interface TagBucket {
  datum: string;
  minuten: number;
  nachtMinuten: number;
  sonntagMinuten: number;
  /** Nacht-Schlüssel (Abend-Datum) → Minuten an diesem Tag. */
  nacht: Map<string, number>;
  /** Sonntag-/Feiertag-Schlüssel → Minuten an diesem Tag. */
  sonntag: Map<string, number>;
  ausserhalbAnstellung: number;
}

export interface Verteilung {
  tage: Map<string, TagBucket>;
  /** Minuten je Woche (Schlüssel Montag), nur innerhalb der Anstellung. */
  wochen: Map<string, number>;
  /** Alle Nacht-Schlüssel mit Minuten (innerhalb der Anstellung). */
  naechte: Set<string>;
  /** Alle Sonntag-/Feiertag-Schlüssel mit Minuten (innerhalb der Anstellung). */
  sonntage: Set<string>;
  offeneStempel: Stempel[];
  /** Doppelt gestempelte Zeit in ms (alle Stempel). */
  doppeltMs: number;
}

export function inAnstellung(datum: string, anstellungen: Anstellung[] | null): boolean {
  if (anstellungen == null) return true;
  return anstellungen.some((a) => a.eintritt <= datum && (a.austritt == null || datum <= a.austritt));
}

export function feiertagsKarte(feiertage: Feiertag[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of feiertage) m.set(f.datum, f.name);
  return m;
}

/** Sonntag oder Feiertag? Name oder null. */
export function sonntagOderFeiertag(datum: string, feiertage: Map<string, string>): string | null {
  const f = feiertage.get(datum);
  if (f) return f;
  return wochentag(datum) === 0 ? "Sonntag" : null;
}

export function verteile(stempel: Stempel[], anstellungen: Anstellung[] | null, feiertage: Map<string, string>): Verteilung {
  const offeneStempel: Stempel[] = [];
  const roh: { start: number; ende: number }[] = [];
  for (const s of stempel) {
    if (s.ende == null) {
      offeneStempel.push(s);
      continue;
    }
    roh.push({ start: zuMs(s.start), ende: zuMs(s.ende) });
  }
  const { intervalle, doppeltMs } = vereinige(roh);

  const tage = new Map<string, TagBucket>();
  const wochen = new Map<string, number>();
  const naechte = new Set<string>();
  const sonntage = new Set<string>();
  const montagJeTag = new Map<string, string>();
  const anstellungJeTag = new Map<string, boolean>();

  for (const iv of intervalle) {
    jeLokalerStunde(iv.start, iv.ende, (datum, stunde, minuten) => {
      let b = tage.get(datum);
      if (!b) {
        b = { datum, minuten: 0, nachtMinuten: 0, sonntagMinuten: 0, nacht: new Map(), sonntag: new Map(), ausserhalbAnstellung: 0 };
        tage.set(datum, b);
      }
      let drin = anstellungJeTag.get(datum);
      if (drin === undefined) {
        drin = inAnstellung(datum, anstellungen);
        anstellungJeTag.set(datum, drin);
      }
      if (!drin) {
        b.ausserhalbAnstellung += minuten;
        return;
      }
      b.minuten += minuten;
      let montag = montagJeTag.get(datum);
      if (!montag) {
        montag = wochenMontag(datum);
        montagJeTag.set(datum, montag);
      }
      wochen.set(montag, (wochen.get(montag) ?? 0) + minuten);

      if (stunde >= NACHT_VON_STUNDE || stunde < NACHT_BIS_STUNDE) {
        const nachtSchluessel = stunde >= NACHT_VON_STUNDE ? datum : plusTage(datum, -1);
        b.nachtMinuten += minuten;
        b.nacht.set(nachtSchluessel, (b.nacht.get(nachtSchluessel) ?? 0) + minuten);
        naechte.add(nachtSchluessel);
      }
      const sonntagSchluessel = stunde >= SONNTAG_BEGINN_VORTAG_STUNDE ? plusTage(datum, 1) : datum;
      if (sonntagOderFeiertag(sonntagSchluessel, feiertage)) {
        b.sonntagMinuten += minuten;
        b.sonntag.set(sonntagSchluessel, (b.sonntag.get(sonntagSchluessel) ?? 0) + minuten);
        sonntage.add(sonntagSchluessel);
      }
    });
  }
  return { tage, wochen, naechte, sonntage, offeneStempel, doppeltMs };
}

/** Rang je Kalenderjahr des Schlüssels (1 = erster im Jahr). */
export function rangImJahr(schluessel: Iterable<string>): Map<string, number> {
  const sortiert = Array.from(schluessel).sort();
  const rang = new Map<string, number>();
  const zaehler = new Map<string, number>();
  for (const k of sortiert) {
    const j = k.slice(0, 4);
    const n = (zaehler.get(j) ?? 0) + 1;
    zaehler.set(j, n);
    rang.set(k, n);
  }
  return rang;
}
