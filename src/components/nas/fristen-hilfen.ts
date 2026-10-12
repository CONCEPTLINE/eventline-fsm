// Reine Anzeige-Bausteine der Gruppe «Fristen» (fristen-gruppe.tsx).
// Alle Daten sind Kalendertage YYYY-MM-DD (Europe/Zurich, Spalte `date`) —
// gerechnet wird auf den Ziffern, nie mit Date-Zeitzonen.

import { FRIST_ART_LABEL } from "@/lib/ki/fristen";
import type { FristArt, FristBedingungen } from "@/lib/ki/typen";

const DATUM_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** «2026-12-31» -> «31.12.2026» (unbekanntes Format bleibt, wie es ist). */
export function fmtTag(iso: string): string {
  const m = DATUM_RE.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

function tagNr(iso: string): number | null {
  const m = DATUM_RE.exec(iso);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000 : null;
}

/** Kalendertage von `heute` bis `datum` (negativ = vorbei). */
export function tageBis(datum: string, heute: string): number | null {
  const a = tagNr(heute);
  const b = tagNr(datum);
  return a === null || b === null ? null : Math.round(b - a);
}

/** «heute», «morgen», «in 12 Tagen», «seit 3 Tagen vorbei». */
export function relativ(datum: string, heute: string): string {
  const n = tageBis(datum, heute);
  if (n === null) return "";
  if (n === 0) return "heute";
  if (n === 1) return "morgen";
  if (n > 1) return `in ${n} Tagen`;
  return n === -1 ? "seit gestern vorbei" : `seit ${-n} Tagen vorbei`;
}

/** Ton des Datums: vorbei = rot, bis 30 Tage = amber, sonst neutral. */
export function datumTon(datum: string, heute: string): "rot" | "amber" | "neutral" {
  const n = tageBis(datum, heute);
  if (n === null) return "neutral";
  if (n < 0) return "rot";
  return n <= 30 ? "amber" : "neutral";
}

/** Ordner einer Datei («A/B/c.pdf» -> «A/B»; Hauptebene -> «»). */
export function ordnerVon(pfad: string): string {
  const i = pfad.lastIndexOf("/");
  return i > 0 ? pfad.substring(0, i) : "";
}

export function artLabel(art: string): string {
  return FRIST_ART_LABEL[art as FristArt] ?? "Frist";
}

const EINHEIT: Record<string, [string, string]> = { tage: ["Tag", "Tage"], wochen: ["Woche", "Wochen"], monate: ["Monat", "Monate"] };
const zahl = (n: number, eins: string, mehr: string) => `${n} ${n === 1 ? eins : mehr}`;

/** Woraus das FSM das Datum gerechnet hat (KI-Bedingungen, MASTERPLAN §3.7)
 *  als kurzer Satz — die Begruendung eines Vorschlags. Leer ohne Grundlage. */
export function beschreibeGrundlage(g: unknown): string {
  if (!g || typeof g !== "object" || Array.isArray(g)) return "";
  const b = g as Partial<FristBedingungen>;
  const teile: string[] = [];
  if (typeof b.faellig === "string") teile.push(`fällig ${fmtTag(b.faellig)}`);
  if (typeof b.beginn === "string") teile.push(`Beginn ${fmtTag(b.beginn)}`);
  if (typeof b.ende === "string") teile.push(`Ende ${fmtTag(b.ende)}`);
  if (typeof b.laufzeit_monate === "number") teile.push(`Laufzeit ${zahl(b.laufzeit_monate, "Monat", "Monate")}`);
  if (typeof b.verlaengerung_monate === "number") teile.push(`verlängert sich um ${zahl(b.verlaengerung_monate, "Monat", "Monate")}`);
  const k = b.kuendigungsfrist;
  if (k && typeof k === "object" && typeof k.anzahl === "number" && EINHEIT[k.einheit]) {
    teile.push(`Kündigungsfrist ${zahl(k.anzahl, ...EINHEIT[k.einheit])}`);
  }
  return teile.join(" · ");
}
