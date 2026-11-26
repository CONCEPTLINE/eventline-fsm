// Funktionen einer Einteilung an einer Location (Ressourcen › Planungsbrett).
// Werte wie in der Datenbank (standort_mitarbeiter.funktion,
// standort_planstellen.funktion, Migration 392).

export const FUNKTIONEN = ["geschaeftsleitung", "betriebsleitung", "personal"] as const;
export type Funktion = (typeof FUNKTIONEN)[number];

export const FUNKTION_LABEL: Record<Funktion, string> = {
  geschaeftsleitung: "Geschäftsleitung",
  betriebsleitung: "Betriebsleitung",
  personal: "Personal",
};

export function istFunktion(x: unknown): x is Funktion {
  return typeof x === "string" && (FUNKTIONEN as readonly string[]).includes(x);
}
