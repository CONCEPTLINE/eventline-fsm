// Technik-Dashboard: Ampeln fuer die Anzeige zusammenfassen.
// Die Bewertung selbst macht der Server (src/lib/technik-dashboard/ampeln.ts); hier wird nur gelesen.

import type { Ampel, Bauteil, Kachel, NeutralArt, Stufe } from "@/lib/technik-dashboard/typen";
import type { Ton } from "./farben";

export type IconName =
  | "circle-check" | "triangle-alert" | "octagon-x" | "info" | "lock" | "circle-pause" | "clock" | "activity";

export interface Anzeige {
  ton: Ton;
  wort: string;
  icon: IconName;
}

const RANG: Record<Stufe, number> = { kritisch: 3, warnung: 2, gut: 1, neutral: 0 };

export const tonVon = (s: Stufe): Ton => (s === "kritisch" ? "krit" : s === "warnung" ? "warn" : s === "gut" ? "gut" : "neutral");

export const NEUTRAL: Record<NeutralArt, { wort: string; icon: IconName }> = {
  kommt: { wort: "Kommt", icon: "lock" },
  ruht: { wort: "Ruht", icon: "circle-pause" },
  soll_offen: { wort: "Soll offen", icon: "info" },
  veraltet: { wort: "Veraltet", icon: "clock" },
  info: { wort: "Info", icon: "info" },
  nie_gemeldet: { wort: "Nie gemeldet", icon: "info" },
  nicht_lesbar: { wort: "Nicht lesbar", icon: "info" },
};

export function anzeigeVon(a: Pick<Ampel, "stufe" | "neutral"> & { text?: string }): Anzeige {
  if (a.stufe === "kritisch") return { ton: "krit", wort: "Kritisch", icon: "octagon-x" };
  if (a.stufe === "warnung") return { ton: "warn", wort: "Warnung", icon: "triangle-alert" };
  if (a.stufe === "gut") return { ton: "gut", wort: "Gut", icon: "circle-check" };
  const n = NEUTRAL[a.neutral ?? "info"] ?? NEUTRAL.info;
  // Veraltet: «Stand vor X min» direkt an der Kachel (VERTRAG §6.3), wenn der Server-Text kurz genug ist
  if (a.neutral === "veraltet" && "text" in a && typeof a.text === "string" && a.text.length > 0 && a.text.length <= 22) {
    return { ton: "neutral", wort: a.text.replace(/\.$/, ""), icon: n.icon };
  }
  return { ton: "neutral", wort: n.wort, icon: n.icon };
}

/** Schlechteste Ampel; neutral nur, wenn es nichts anderes gibt. */
export function schlechteste(ampeln: Ampel[]): Ampel | null {
  let best: Ampel | null = null;
  for (const a of ampeln) if (!best || RANG[a.stufe] > RANG[best.stufe]) best = a;
  return best;
}

export const ampelnVon = (ampeln: Ampel[], bauteil: Bauteil) => ampeln.filter((a) => a.bauteil === bauteil);
export const ampelnKachel = (ampeln: Ampel[], kachel: Kachel) => ampeln.filter((a) => a.kachel === kachel);
export const ampel = (ampeln: Ampel[], schluessel: string) => ampeln.find((a) => a.schluessel === schluessel) ?? null;

/** Status eines Bauteils = schlechteste Ampel dieses Bauteils. */
export function bauteilAnzeige(ampeln: Ampel[], bauteil: Bauteil): Anzeige & { ampel: Ampel | null } {
  const a = schlechteste(ampelnVon(ampeln, bauteil));
  if (!a) return { ton: "neutral", wort: "Keine Daten", icon: "info", ampel: null };
  return { ...anzeigeVon(a), ampel: a };
}

/** Ampeln eines Bauteils, die Aufmerksamkeit brauchen (Warnung/kritisch zuerst). */
export function probleme(ampeln: Ampel[]): Ampel[] {
  return ampeln.filter((a) => a.stufe === "kritisch" || a.stufe === "warnung").sort((x, y) => RANG[y.stufe] - RANG[x.stufe]);
}
