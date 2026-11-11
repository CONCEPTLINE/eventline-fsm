// Typen der Zeit-/Stunden-Hilfen.
//
// Konventionen:
//   - Datum (IsoDatum): "YYYY-MM-DD", Kalendertag in Europe/Zurich.
//   - Zeitpunkt: ISO 8601 mit Zone (z. B. aus Postgres timestamptz).

export type IsoDatum = string;
export type Zeitpunkt = string;

/** Eine Stempelzeit [start, ende). ende null = noch offen → zählt nicht. */
export interface Stempel {
  id?: string;
  start: Zeitpunkt;
  ende: Zeitpunkt | null;
}
