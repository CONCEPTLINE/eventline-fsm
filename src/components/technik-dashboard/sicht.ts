// Technik-Dashboard: gemeinsamer Lese-Zustand der Seite (an Szene, Panels und Streifen gereicht).

import type { Bauteil, Bereich, Reihen, TechnikStand } from "@/lib/technik-dashboard/typen";

export type TeilKey = Bauteil | "ereignisse" | "uebersicht";
export const TEIL_KEYS: readonly TeilKey[] = [
  "cpu", "gpu", "ram", "platten", "dienste", "ki", "app", "ablage", "nas", "index", "hardware", "backup", "ereignisse", "uebersicht",
];
/** Bauteile mit Kurven und Zeitraum-Umschalter. */
export const BEREICH_TEILE: readonly TeilKey[] = ["cpu", "gpu", "ram"];

export interface Sicht {
  stand: TechnikStand;
  /** Serverzeit (ms) zum Zeitpunkt der letzten Antwort. */
  jetzt: number;
  sel: TeilKey;
  /** Detail offen (Spalte oder Schublade). */
  offen: boolean;
  waehle: (k: TeilKey) => void;
  /** 24 h fuer Streifen und Fahnen. */
  reihen24: Reihen | null;
  /** Gewaehlter Zeitraum fuer die Panel-Kurven. */
  reihen: Reihen | null;
  bereich: Bereich;
  /** Letzter Abruf fehlgeschlagen: Daten stehen, gelten als veraltet. */
  abrufFehler: boolean;
}

export const istTeil = (v: string | null): v is TeilKey => v != null && (TEIL_KEYS as readonly string[]).includes(v);
export const istBereich = (v: string | null): v is Bereich => v === "6h" || v === "24h" || v === "7d";
