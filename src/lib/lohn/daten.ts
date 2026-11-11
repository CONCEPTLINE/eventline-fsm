// Datenbank-Hilfen rund um Stempel und Lohndokumente (nur Server).
//
// Alles seitenweise (keine stille 1'000-Zeilen-Grenze), jeder Ladefehler wirft.
// Gerechnet wird der Lohn seit November 2026 nur noch in Trust flow
// (Lohn-Abbau 11.11.2026) — das ERP liefert Stempel/Abwesenheiten und zeigt PDFs.

import { plusTage } from "./kern";

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

/** UTC-Grenze sicher vor/nach einem lokalen Kalendertag (Puffer 1 Tag) — für den
 *  Stempel-Abruf von Trust flow (src/lib/flow/daten.ts). */
export function utcVor(datum: string): string {
  return `${plusTage(datum, -1)}T00:00:00Z`;
}
export function utcNach(datum: string): string {
  return `${plusTage(datum, 2)}T00:00:00Z`;
}
