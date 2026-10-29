// Rechenkern Lohn — Feiertage.
//
// Der Kern bekommt die Feiertage als Eingabe (je Einsatzort/Kanton
// verschieden). Für EVENTLINE (Basel-Stadt) liefert feiertageBaselStadt()
// die Liste; der Bundesfeiertag 1. August ist überall dabei.
// Ostern nach Meeus/Jones/Butcher.

import type { Feiertag } from "./typen";

function ostersonntag(jahr: number): { monat: number; tag: number } {
  const a = jahr % 19;
  const b = Math.floor(jahr / 100);
  const c = jahr % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const monat = Math.floor((h + l - 7 * m + 114) / 31);
  const tag = ((h + l - 7 * m + 114) % 31) + 1;
  return { monat, tag };
}

function datumPlus(jahr: number, monat: number, tag: number, n: number): string {
  const t = new Date(Date.UTC(jahr, monat - 1, tag + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** Gesetzliche Feiertage Basel-Stadt (wie src/lib/swiss-holidays.ts). */
export function feiertageBaselStadt(jahr: number): Feiertag[] {
  const o = ostersonntag(jahr);
  return [
    { datum: `${jahr}-01-01`, name: "Neujahr" },
    { datum: `${jahr}-01-02`, name: "Berchtoldstag" },
    { datum: datumPlus(jahr, o.monat, o.tag, -2), name: "Karfreitag" },
    { datum: datumPlus(jahr, o.monat, o.tag, 1), name: "Ostermontag" },
    { datum: `${jahr}-05-01`, name: "Tag der Arbeit" },
    { datum: datumPlus(jahr, o.monat, o.tag, 39), name: "Auffahrt" },
    { datum: datumPlus(jahr, o.monat, o.tag, 50), name: "Pfingstmontag" },
    { datum: `${jahr}-08-01`, name: "Bundesfeiertag" },
    { datum: `${jahr}-12-25`, name: "Weihnachten" },
    { datum: `${jahr}-12-26`, name: "Stephanstag" },
  ];
}

/** Feiertage Basel-Stadt für mehrere Jahre (inklusiv). */
export function feiertageBaselStadtJahre(vonJahr: number, bisJahr: number): Feiertag[] {
  const out: Feiertag[] = [];
  for (let j = vonJahr; j <= bisJahr; j++) out.push(...feiertageBaselStadt(j));
  return out;
}
