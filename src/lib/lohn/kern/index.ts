// Zeit- und Stunden-Hilfen (früher «Rechenkern Lohn»).
//
// Gerechnet wird der Lohn seit November 2026 nur noch in Trust flow
// (Lohn-Abbau 11.11.2026). Hier bleibt, was Stempel/Stunden und die
// Trust-flow-Schnittstelle brauchen: lokale Tage (Europe/Zurich), den
// Stempel-Bereich je Monat und die minutengenaue Verteilung auf Kalendertage.
// Rein: keine Datenbank, kein Next.js.

export * from "./typen";
export { stempelBereich } from "./stempel-bereich";
export { summeChf } from "./regeln";
export { plusTage, monatsErster, monatsLetzter, monatSchluessel, wochenMontag, lokalesDatum, jeLokalerStunde } from "./zeit";
