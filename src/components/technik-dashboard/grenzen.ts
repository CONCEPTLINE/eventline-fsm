// Technik-Dashboard: Grenzen-Tabellen und Kurven-Grenzlinien, gelesen aus der einen Quelle
// src/lib/technik-dashboard/konstanten.ts (VERTRAG §4). Hier wird nur in Klartext uebersetzt.

import { CPU_TEMP, FSM_FEHLER_KRITISCH, GRENZEN, KURVEN_GRENZEN, ZEIT_GRENZEN_MS } from "@/lib/technik-dashboard/konstanten";
import type { GrenzZeile } from "./bausteine";

const einheit = (u: string) => (u === "%" ? " %" : u ? ` ${u}` : "");

function hoch(w: number, kr: number, u: string): GrenzZeile[] {
  return [
    { ton: "gut", text: `unter ${w}${einheit(u)}` },
    { ton: "warn", text: `${w} bis ${kr}${einheit(u)}` },
    { ton: "krit", text: `über ${kr}${einheit(u)}` },
  ];
}

function zeit(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${Math.round(ms / 1000)} s`;
}
function alter(g: { warnung: number; kritisch: number }, was = ""): GrenzZeile[] {
  return [
    { ton: "gut", text: `${was}jünger als ${zeit(g.warnung)}` },
    { ton: "warn", text: `${zeit(g.warnung)} bis ${zeit(g.kritisch)}` },
    { ton: "krit", text: `älter als ${zeit(g.kritisch)}` },
  ];
}

export const GRENZ_TABELLEN = {
  cpuTemp: [
    { ton: "gut", text: `Ø bis ${CPU_TEMP.mittel_warnung} °C, Spitze unter ${CPU_TEMP.spitze_warnung} °C` },
    { ton: "warn", text: `Ø über ${CPU_TEMP.mittel_warnung} °C oder Spitze ab ${CPU_TEMP.spitze_warnung} °C` },
    { ton: "krit", text: `ab ${CPU_TEMP.kritisch} °C oder Drosselung` },
  ] as GrenzZeile[],
  cpuLast: [
    { ton: "gut", text: `Ø 5 min unter ${GRENZEN["cpu.last"].warnung} %` },
    { ton: "warn", text: `${GRENZEN["cpu.last"].warnung} bis ${GRENZEN["cpu.last"].kritisch} %` },
    { ton: "krit", text: `Ø 10 min über ${GRENZEN["cpu.last"].kritisch} %` },
  ] as GrenzZeile[],
  gpuTemp: hoch(GRENZEN["gpu.temp"].warnung, GRENZEN["gpu.temp"].kritisch, "°C"),
  ramFrei: [
    { ton: "gut", text: `mehr als ${GRENZEN["ram.verfuegbar"].warnung} GB frei` },
    { ton: "warn", text: `${GRENZEN["ram.verfuegbar"].kritisch} bis ${GRENZEN["ram.verfuegbar"].warnung} GB` },
    { ton: "krit", text: `unter ${GRENZEN["ram.verfuegbar"].kritisch} GB` },
  ] as GrenzZeile[],
  ramSwap: hoch(GRENZEN["ram.swap"].warnung, GRENZEN["ram.swap"].kritisch, "GB"),
  platte: hoch(GRENZEN.platte.warnung, GRENZEN.platte.kritisch, "%"),
  ssdTemp: hoch(GRENZEN["ssd.temp"].warnung, GRENZEN["ssd.temp"].kritisch, "°C"),
  nasVolume: hoch(GRENZEN["nas.volume"].warnung, GRENZEN["nas.volume"].kritisch, "%"),
  nasSysTemp: hoch(GRENZEN["nas.hw.systemtemp"].warnung, GRENZEN["nas.hw.systemtemp"].kritisch, "°C"),
  nasPlTemp: hoch(GRENZEN["nas.hw.plattentemp"].warnung, GRENZEN["nas.hw.plattentemp"].kritisch, "°C"),
  messwerte: alter(ZEIT_GRENZEN_MS["messwerte.frische"]),
  antwort: [
    { ton: "gut", text: `unter ${GRENZEN["verbindung.antwortzeit"].warnung / 1000} s` },
    { ton: "warn", text: `${GRENZEN["verbindung.antwortzeit"].warnung / 1000} bis ${GRENZEN["verbindung.antwortzeit"].kritisch / 1000} s` },
    { ton: "krit", text: `über ${GRENZEN["verbindung.antwortzeit"].kritisch / 1000} s oder ${FSM_FEHLER_KRITISCH} Fehler in Folge` },
  ] as GrenzZeile[],
  ablage: alter(ZEIT_GRENZEN_MS["ablage.sync"]),
  index: alter(ZEIT_GRENZEN_MS["ablage.index"], "Scan "),
  backup: [
    { ton: "gut", text: `Meldung jünger als ${zeit(ZEIT_GRENZEN_MS["backup.fsm"].warnung)}` },
    { ton: "warn", text: `${zeit(ZEIT_GRENZEN_MS["backup.fsm"].warnung)} bis ${zeit(ZEIT_GRENZEN_MS["backup.fsm"].kritisch)}` },
    { ton: "krit", text: `über ${zeit(ZEIT_GRENZEN_MS["backup.fsm"].kritisch)} oder Fehl-Lauf` },
  ] as GrenzZeile[],
  dienste: [
    { ton: "gut", text: "läuft und gesund" },
    { ton: "warn", text: "Absturz in 24 h oder startet gerade" },
    { ton: "krit", text: "gestoppt, ungesund, Speicherabbruch" },
  ] as GrenzZeile[],
  warteschlange: alter(ZEIT_GRENZEN_MS["ki.warteschlange"], "ältester Auftrag "),
  kuehlung: [
    { ton: "gut", text: "Pumpe und alle Lüfter drehen" },
    { ton: "warn", text: "ein Lüfter steht oder die Steuerung meldet einen Fehler" },
    { ton: "krit", text: "Pumpe steht oder meldet keine Drehzahl" },
  ] as GrenzZeile[],
};

/** «Grenzwerte auf einen Blick» (Uebersicht): [Bauteil zum Oeffnen, Name, Warnung, kritisch]. */
export const GRENZ_UEBERSICHT: Array<[string, string, string, string]> = [
  ["cpu", "Prozessor", `Ø über ${CPU_TEMP.mittel_warnung} °C`, `ab ${CPU_TEMP.kritisch} °C`],
  ["cpu", "Kühlung", "ein Lüfter steht", "Pumpe steht"],
  ["gpu", "Grafikkarte", `ab ${GRENZEN["gpu.temp"].warnung} °C`, `über ${GRENZEN["gpu.temp"].kritisch} °C`],
  ["ram", "Arbeitsspeicher", `unter ${GRENZEN["ram.verfuegbar"].warnung} GB frei`, `unter ${GRENZEN["ram.verfuegbar"].kritisch} GB frei`],
  ["ram", "Auslagerung", `ab ${GRENZEN["ram.swap"].warnung} GB`, `über ${GRENZEN["ram.swap"].kritisch} GB`],
  ["platten", "Platten am Rig", `ab ${GRENZEN.platte.warnung} %`, `über ${GRENZEN.platte.kritisch} %`],
  ["dienste", "Dienste", "Absturz in 24 h", "gestoppt"],
  ["app", "Messwerte-Alter", `ab ${zeit(ZEIT_GRENZEN_MS["messwerte.frische"].warnung)}`, `über ${zeit(ZEIT_GRENZEN_MS["messwerte.frische"].kritisch)}`],
  ["ablage", "Ablage-Abgleich", `ab ${zeit(ZEIT_GRENZEN_MS["ablage.sync"].warnung)}`, `über ${zeit(ZEIT_GRENZEN_MS["ablage.sync"].kritisch)}`],
  ["index", "Datei-Index", `ab ${zeit(ZEIT_GRENZEN_MS["ablage.index"].warnung)}`, `über ${zeit(ZEIT_GRENZEN_MS["ablage.index"].kritisch)}`],
  ["nas", "NAS-Volume", `ab ${GRENZEN["nas.volume"].warnung} %`, `über ${GRENZEN["nas.volume"].kritisch} %`],
  ["backup", "FSM-Sicherung", `ab ${zeit(ZEIT_GRENZEN_MS["backup.fsm"].warnung)}`, `über ${zeit(ZEIT_GRENZEN_MS["backup.fsm"].kritisch)}`],
];

/** Grenzlinien einer Kurve (gestrichelt, mit Beschriftung). */
export function grenzLinien(schluessel: string, u: string): Array<{ v: number; label: string; unten?: boolean }> {
  const g = KURVEN_GRENZEN[schluessel];
  if (!g) return [];
  const e = einheit(u);
  if (g.richtung === "tief") return [{ v: g.warnung, label: `${g.warnung}${e} Warnung` }, { v: g.kritisch, label: "", unten: true }];
  return [{ v: g.kritisch, label: `${g.kritisch}${e} kritisch` }, { v: g.warnung, label: `${g.warnung}${e} Warnung`, unten: true }];
}
