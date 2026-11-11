// Altershinweis beim Anlegen einer Person (Browser und Server, ohne Logik).

/** Mindestalter für eine Anstellung (Entscheid Mischa/Leo 29.10.2026). */
export const MINDESTALTER_ANSTELLUNG = 18;

/** Warnung, wenn die Person am Stichtag (YYYY-MM-DD) jünger als 18 ist, sonst null. */
export function alterWarnung(geburtsdatum: string | null | undefined, stichtag: string): string | null {
  if (!geburtsdatum || !/^\d{4}-\d{2}-\d{2}$/.test(geburtsdatum) || !/^\d{4}-\d{2}-\d{2}$/.test(stichtag)) return null;
  const [gj, gm, gt] = geburtsdatum.split("-").map(Number);
  const [sj, sm, st] = stichtag.split("-").map(Number);
  const alter = sj - gj - (sm < gm || (sm === gm && st < gt) ? 1 : 0);
  return alter < MINDESTALTER_ANSTELLUNG
    ? `Achtung: Die Person ist am ${st}.${sm}.${sj} erst ${alter} Jahre alt — EVENTLINE stellt nur ab ${MINDESTALTER_ANSTELLUNG} Jahren an.`
    : null;
}
