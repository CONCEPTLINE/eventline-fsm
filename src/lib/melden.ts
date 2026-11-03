// «Melden» — EIN Einstieg fuer alles, was Mitarbeiter melden (Beleg, Krank,
// Abwesenheit, Stempel korrigieren, Anderes = IT/Material).
//
// Jede Stelle (Mein Konto, Sidebar «+ Melden», Befehlspalette, Meine
// Anfragen, Stempelzeiten-Zeile «Korrigieren») ruft oeffneMelden(); der
// MeldenHost im (app)-Layout hoert auf das Window-Event und oeffnet direkt
// das passende kurze Formular (keine Typ-Auswahl davor). Window-Event statt
// Context, damit Aufrufer (z. B. die Palette) nicht den Formular-Code in
// ihren Chunk ziehen — Muster STEMPEL_OPEN_EVENT / CMDK_OPEN_EVENT.

export type MeldenArt = "beleg" | "krank" | "abwesenheit" | "stempel" | "anderes";

/** Vorbelegung fuer «Stempel korrigieren» aus einer Stempelzeiten-Zeile. */
export interface StempelVorbelegung {
  timeEntryId: string;
  clockIn: string;
  clockOut: string | null;
  jobId: string | null;
}

export interface MeldenDetail {
  art: MeldenArt;
  stempel?: StempelVorbelegung;
}

export const MELDEN_EVENT = "eventline:melden";

/** Gemeldet → Listen (Meine Anfragen, Mein Konto) laden neu. */
export const ANFRAGEN_GEAENDERT_EVENT = "eventline:anfragen-geaendert";

export function oeffneMelden(art: MeldenArt, opts: { stempel?: StempelVorbelegung } = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<MeldenDetail>(MELDEN_EVENT, { detail: { art, ...opts } }));
}

export function anfragenGeaendert(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(ANFRAGEN_GEAENDERT_EVENT));
}

/** Die vier Kacheln (Reihenfolge = Anzeige). Icons setzt die Komponente. */
export const MELDEN_KACHELN: ReadonlyArray<{ art: Exclude<MeldenArt, "anderes">; label: string; hinweis: string }> = [
  { art: "beleg", label: "Beleg", hinweis: "Foto, fertig" },
  { art: "abwesenheit", label: "Abwesenheit", hinweis: "Ferien, frei, Militär" },
  { art: "stempel", label: "Stempel korrigieren", hinweis: "vergessen, falsch" },
];

export const ANDERES_LABEL = "Anderes melden (IT, Material)";

/** Darf die Person diese Art melden? Beleg, Stempel und Anderes sind
 *  Tickets (Recht tickets:create, Admins immer); Abwesenheit und Krank
 *  darf jede Person melden. */
export function darfMelden(art: MeldenArt, can: (recht: string) => boolean): boolean {
  if (art === "abwesenheit" || art === "krank") return true;
  return can("tickets:create");
}
