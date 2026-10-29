// Gerätefreigabe (vertraute Geräte für Finanzen + Löhne), Lohn-Umbau Phase 1.
//
// Eine Anfrage ist 24 h lang freigebbar; danach muss neu angefragt werden.
// Ältere Anfragen ohne anfrage_gueltig_bis (vor Migration 357) zählen ab
// requested_at.

export const ANFRAGE_GUELTIG_STUNDEN = 24;

export function anfrageGueltigBis(row: { anfrage_gueltig_bis?: string | null; requested_at?: string | null }): Date | null {
  if (row.anfrage_gueltig_bis) return new Date(row.anfrage_gueltig_bis);
  if (row.requested_at) return new Date(new Date(row.requested_at).getTime() + ANFRAGE_GUELTIG_STUNDEN * 3600_000);
  return null;
}

/** Offene Anfrage abgelaufen (nicht mehr freigebbar)? */
export function anfrageAbgelaufen(
  row: { anfrage_gueltig_bis?: string | null; requested_at?: string | null },
  jetzt: Date = new Date(),
): boolean {
  const bis = anfrageGueltigBis(row);
  return !bis || bis.getTime() <= jetzt.getTime();
}
