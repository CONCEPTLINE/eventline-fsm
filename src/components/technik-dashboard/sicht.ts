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
  /** Stand sofort neu laden (z. B. nach dem Setzen des Luefter-Profils). */
  aktualisiere: () => Promise<void>;
}

export const istTeil = (v: string | null): v is TeilKey => v != null && (TEIL_KEYS as readonly string[]).includes(v);
export const istBereich = (v: string | null): v is Bereich => v === "6h" || v === "24h" || v === "7d";

// ---- Fokus-Modus der Szene ----
// Ein gewaehltes Bauteil hebt sich ab, alles andere in der Szene wird gedimmt. Gedimmt wird so grob wie
// moeglich: liegt der Fokus in einem anderen Geraet, dimmt das ganze Geraet (Gehaeuse samt Inhalt); liegt er
// im selben Geraet, dimmen dort die anderen Bauteile einzeln. So wird nie doppelt gedimmt.

/** Geraet bzw. Strecke, zu der ein Bauteil in der Szene gehoert. */
export type Geraet = "rig" | "nas" | "app" | "ablage" | "backup";
export const GERAET: Record<Bauteil, Geraet> = {
  cpu: "rig", gpu: "rig", ram: "rig", platten: "rig", dienste: "rig", ki: "rig",
  nas: "nas", index: "nas", hardware: "nas",
  app: "app", ablage: "ablage", backup: "backup",
};

/** Bauteil im Fokus, sonst null. «Uebersicht» und «Ereignisse» sind keine Bauteile der Szene und dimmen nichts. */
export function fokusVon(s: Pick<Sicht, "sel" | "offen">): Bauteil | null {
  return s.offen && s.sel !== "uebersicht" && s.sel !== "ereignisse" ? s.sel : null;
}

/** Ganzes Geraet bzw. ganze Strecke: gedimmt, wenn der Fokus woanders liegt. */
export const geraetGedimmt = (fokus: Bauteil | null, g: Geraet): boolean => fokus != null && GERAET[fokus] !== g;

/** Einzelnes Bauteil in einem Geraet: gedimmt, wenn ein anderes Bauteil desselben Geraets im Fokus ist. */
export const teilGedimmt = (fokus: Bauteil | null, teil: Bauteil): boolean => fokus != null && fokus !== teil && GERAET[fokus] === GERAET[teil];

/** Hover-Vorschau auf einem gedimmten Geraet: das Geraet hellt halb auf. */
export const geraetVorschau = (vorschau: Bauteil | null, g: Geraet): boolean => vorschau != null && GERAET[vorschau] === g;
