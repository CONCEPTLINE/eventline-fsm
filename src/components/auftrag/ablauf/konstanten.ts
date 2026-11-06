/**
 * Feste Inhalte des Vermietungs-Ablaufs (mit Basil abgesprochen, Skizze
 * daten.ts): Anhänge, Übergabe-Liste, Inventar. Schritte und Übergabe-Standard
 * kommen aus src/lib/ablauf/typen.ts, Konditionen (Preise) und Mail-Texte aus
 * src/lib/ablauf/eml.ts (eine Quelle für UI, Outlook-Entwurf und Vertrag).
 */

import { SCHRITTE, UEBERGABE_STANDARD, type SchrittNr } from "@/lib/ablauf/typen";

export { SCHRITTE, type SchrittNr };

/** Erledigte Schritte mit Zeitpunkt und Herkunft (aus den Ereignissen). */
export type Erledigt = Partial<Record<SchrittNr, { zeit: string | null; quelle: string }>>;

export const ANHAENGE_VERTRAG = [
  "Vertrag (aus Vorlage erzeugt)",
  "Informationen für Privatvermietungen (Infoblatt)",
  "Checkliste (Vertragsbestandteil)",
  "Poller-Merkblatt (Einfahrt Süd)",
];

export const UEBERGABE_LISTE = [
  "Rundgang Bar – Spülmaschine nur für Gläser",
  "Vorplatz – Badge, Girlande, Feuerschale, Kletterhalle",
  "Raum",
  "Licht",
  "Ton",
  "Sicherungskasten",
  "Pickettnummer notiert",
  "Notfallnummer gespeichert",
  "Rückgabezeit festgelegt",
];

export const INVENTAR = [
  "Gläser (Kisten gezählt)",
  "Buffettische 2×",
  "Stellwand mit Text",
  "Funkmikrofon 1×",
  "Schlüssel 1× (zurück in Briefkasten beim Poller)",
];

/** Übergabe-Standard: 14:00, 1 Stunde (real ~40 Min, bewusst 1 h). */
export const UEBERGABE_VON = `${String(UEBERGABE_STANDARD.stunde).padStart(2, "0")}:${String(UEBERGABE_STANDARD.minute).padStart(2, "0")}`;
export const UEBERGABE_DAUER_MIN = UEBERGABE_STANDARD.dauerMin;
