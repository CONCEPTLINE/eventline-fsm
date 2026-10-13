// Technik-Dashboard: Kuehlung des Rigs fuer die Anzeige (VERTRAG §2.5) — Drehung der gezeichneten Luefter
// aus echten Drehzahlen und der Stand der Profil-Uebernahme. Rein (kein React), getestet in kuehlung.test.ts.

import { PROFIL_UEBERNAHME_MS } from "@/lib/technik-dashboard/konstanten";
import type { KuehlungPaket, LuefterProfil, RigPaket, TechnikStand } from "@/lib/technik-dashboard/typen";

/** Umlaufdauer eines Rotors in s zur Leistung p in % (Entwurf: 3,2 s bei 1 %, 0,5 s ab 100 %). */
export const luefterDauer = (p: number) => (p >= 1 ? Math.max(0.5, 3.2 - ((Math.min(100, p) - 1) / 99) * 2.7) : 3.2);

/** Drehzahl -> Umlaufdauer der gezeichneten Gehaeuseluefter (2000 U/min und mehr = volle Geschwindigkeit). */
export const rpmDauer = (rpm: number) => `${luefterDauer(Math.min(100, rpm / 20)).toFixed(2)}s`;

export const GEZEICHNETE_FRONTLUEFTER = 3;

/**
 * Drehdauer der drei gezeichneten Front-Luefter (oben -> unten), null = steht.
 * Meldet das Rig genau drei Front-Luefter, dreht jeder mit seiner eigenen Drehzahl (nach Nummer). Sonst drehen
 * alle mit dem Mittel der drehenden Luefter: Front, sonst alle gemeldeten, sonst cpu.luefter_rpm (Radiator).
 * Veraltete Messung oder keine Drehzahl: alle still (nie ein erfundener Wert).
 */
export function eckDrehungen(rig: RigPaket | null, frisch: boolean): Array<string | null> {
  const still: Array<string | null> = Array.from({ length: GEZEICHNETE_FRONTLUEFTER }, () => null);
  if (!rig || !frisch) return still;
  const gemeldet = (rig.kuehlung?.luefter ?? []).filter((l): l is typeof l & { rpm: number } => l.rpm !== undefined);
  const front = gemeldet.filter((l) => l.ort === "front").sort((a, b) => a.nr - b.nr);
  if (front.length === GEZEICHNETE_FRONTLUEFTER) return front.map((l) => (l.rpm > 0 ? rpmDauer(l.rpm) : null));
  const quelle = front.length ? front.map((l) => l.rpm) : gemeldet.length ? gemeldet.map((l) => l.rpm) : (rig.cpu?.luefter_rpm ?? []);
  const drehend = quelle.filter((r) => r > 0);
  if (!drehend.length) return still;
  const d = rpmDauer(drehend.reduce((a, b) => a + b, 0) / drehend.length);
  return still.map(() => d);
}

/** Die Kuehlungs-Steuerung meldet sich (ok oder Fehler) — sonst ist der Umschalter gesperrt. */
export const kuehlungEingerichtet = (k: KuehlungPaket | undefined): k is KuehlungPaket => !!k && k.status !== "nicht_eingerichtet";

export interface Uebernahme {
  /** gleich = Rig meldet das gewuenschte Profil · laeuft = gerade gesetzt, Rig hat noch Zeit ·
   *  offen = Rig hat nach Ablauf der Frist nicht uebernommen · unbekannt = Wunsch nicht lesbar. */
  art: "gleich" | "laeuft" | "offen" | "unbekannt";
  wunsch: LuefterProfil | null;
  aktiv: LuefterProfil | null;
}

/** Stand der Profil-Uebernahme, nur aus Serverdaten (ueberlebt Reload): Wunsch aus technik_steuerung,
 *  aktiv aus rig.kuehlung.profil_aktiv, Frist ab geaendert_am. `jetzt` = Serverzeit der letzten Antwort. */
export function uebernahme(stand: Pick<TechnikStand, "steuerung" | "rig">, jetzt: number): Uebernahme {
  const wunsch = stand.steuerung?.luefter_profil ?? null;
  const aktiv = stand.rig?.kuehlung?.profil_aktiv ?? null;
  if (!wunsch) return { art: "unbekannt", wunsch, aktiv };
  if (aktiv === wunsch) return { art: "gleich", wunsch, aktiv };
  const seit = stand.steuerung?.geaendert_am ? Date.parse(stand.steuerung.geaendert_am) : NaN;
  const laeuft = Number.isFinite(seit) && jetzt - seit < PROFIL_UEBERNAHME_MS;
  return { art: laeuft ? "laeuft" : "offen", wunsch, aktiv };
}

/** Obere Achsengrenze fuer Drehzahl-Kurven: hoechster Wert (Mittel/Spitze) auf 500 aufgerundet, mindestens `mindest`. */
export function rpmAchse(punkte: Array<[number, number | null, number | null]> | undefined, mindest: number): number {
  let max = 0;
  for (const [, m, sp] of punkte ?? []) max = Math.max(max, m ?? 0, sp ?? 0);
  return Math.max(mindest, Math.ceil((max * 1.1) / 500) * 500);
}
