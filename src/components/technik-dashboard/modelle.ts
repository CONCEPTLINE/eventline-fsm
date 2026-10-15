// Technik-Dashboard: geladene KI-Modelle und Belegung des Arbeitsspeichers (VERTRAG §2.7, Nachtrag 15.10.2026).
// Mischa: «Warum sehe ich das grosse Modell nicht, wenn es aktiv ist?» und «es soll auch RAM abfragen». Ob die KI
// rechnet, kommt aus der Last der Modelle (Sammler), nicht nur aus der Auftragsliste des Dienstes.

import { KI_HINTERGRUND_ANZEIGE, modellAnzeige, modellOrt, modellZustand } from "@/lib/technik-dashboard/konstanten";
import type { KiModellLast, KiPaket, RamBelegung, RigPaket } from "@/lib/technik-dashboard/typen";
import { K } from "./farben";
import { gbBin, zahlKurz } from "./format";

/** Zeile in zwei Teilen: vorne «Grosses Modell (26B) · Prozessor» (darf bei Platzmangel gekuerzt werden), hinten
 *  «rechnet · 15 GB» (Zustand und Groesse laut Ollama, wird nie gekuerzt). */
export function modellZeileTeile(m: KiModellLast): { vorne: string; hinten: string } {
  return {
    vorne: [modellAnzeige(m), modellOrt(m)].filter(Boolean).join(" · "),
    hinten: [modellZustand(m), m.groesse_b != null ? `${zahlKurz(gbBin(m.groesse_b))} GB` : null].filter(Boolean).join(" · "),
  };
}

/** «Grosses Modell (26B) · Prozessor · rechnet · 15 GB». */
export function modellZeile(m: KiModellLast): string {
  const { vorne, hinten } = modellZeileTeile(m);
  return `${vorne} · ${hinten}`;
}

export interface KiLage {
  /** Ein Auftrag laeuft oder ein Modell rechnet (Last). */
  rechnet: boolean;
  auftrag: boolean;
  /** Ein Modell rechnet ohne Auftrag und ohne eigene Hintergrundarbeit des Dienstes (z. B. Messung, Test). */
  ausserhalb: boolean;
  /** Anzeige der Hintergrundarbeit, wenn ein Modell dafuer rechnet. */
  hintergrund: string | null;
  modelle: KiModellLast[];
}

export function kiLage(rig: RigPaket | null | undefined, ki: KiPaket | null | undefined): KiLage {
  const modelle = rig?.ki_modelle ?? [];
  const modellRechnet = modelle.some((m) => m.rechnet === true);
  const auftrag = !!ki?.auftrag;
  return {
    rechnet: auftrag || modellRechnet,
    auftrag,
    ausserhalb: modellRechnet && !auftrag && !ki?.hintergrund,
    hintergrund: modellRechnet && !auftrag && ki?.hintergrund ? KI_HINTERGRUND_ANZEIGE[ki.hintergrund] : null,
    modelle,
  };
}

export const AUSSERHALB_TEXT = "rechnet ausserhalb der Warteschlange (z. B. Messung/Test)";

export type BelegungArt = "modell" | "ki" | "trustone" | "system" | "frei";
export interface BelegungTeil { schluessel: string; name: string; b: number; art: BelegungArt; rechnet?: boolean }

/** Farbe je Teil (Szene und Detail-Panel gleich): Modelle kraeftig, uebriger KI-Bereich halb, Trust one wie seine
 *  Kurve, System leise, verfuegbar = Spur. Nie nur Farbe: die Legende nennt jeden Teil. */
export const BELEGUNG_FARBE: Record<BelegungArt, { farbe: string; op?: number }> = {
  modell: { farbe: K.A }, ki: { farbe: K.A, op: 0.42 }, trustone: { farbe: K.B }, system: { farbe: K.dash }, frei: { farbe: K.track },
};

/** Teile fuer Balken und Legende. Die KI-Modelle je Modell nach ihrem festen Speicher (anteilig auf die Summe des
 *  Sammlers), danach uebriger KI-Bereich, Trust one, System und uebrige Programme, verfuegbar. Leere Teile fallen weg
 *  (verfuegbar bleibt immer). */
export function belegungTeile(b: RamBelegung, modelle: KiModellLast[]): BelegungTeil[] {
  const mitSpeicher = modelle.filter((m) => (m.ram_b ?? 0) > 0);
  const summe = mitSpeicher.reduce((s, m) => s + (m.ram_b ?? 0), 0);
  const teile: BelegungTeil[] = [];
  if (summe > 0) {
    mitSpeicher.forEach((m, i) => teile.push({
      schluessel: `m${i}`, name: modellAnzeige(m), b: (b.ki_modelle_b * (m.ram_b ?? 0)) / summe, art: "modell", rechnet: m.rechnet === true,
    }));
  } else if (b.ki_modelle_b > 0) {
    teile.push({ schluessel: "m", name: "KI-Modelle", b: b.ki_modelle_b, art: "modell" });
  }
  teile.push(
    { schluessel: "ki", name: "Übriger KI-Bereich", b: b.ki_rest_b, art: "ki" },
    { schluessel: "to", name: "Trust one (Summe)", b: b.trustone_b, art: "trustone" },
    { schluessel: "sys", name: "System und Programme", b: b.system_b, art: "system" },
  );
  return [...teile.filter((t) => t.b > 0), { schluessel: "frei", name: "Verfügbar", b: b.verfuegbar_b, art: "frei" }];
}

/** Ganzes = Summe aller Teile (inkl. verfuegbar), damit der Balken genau aufgeht. */
export const belegungGanz = (teile: BelegungTeil[]) => teile.reduce((s, t) => s + t.b, 0);
