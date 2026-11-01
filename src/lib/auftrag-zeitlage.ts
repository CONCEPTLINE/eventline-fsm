// Zeitliche Lage eines Auftrags fuer die Auftragsliste: laeuft er gerade, kommt er noch oder ist er vorbei?
// Rein (kein React, keine Datenbank) — Tests: auftrag-zeitlage.test.ts. Alle Kalendertage in Europe/Zurich.
//
// Auftraege ohne Uhrzeit sind in der DB auf 00:00 Zuerich gespeichert: Ihr letzter Tag zaehlt dann ganz.
// Hat der Start eine Uhrzeit, gilt das Ende exakt (auch 00:00 = bis Mitternacht).

import { localDateIso } from "@/lib/swiss-time";

export type AuftragZeitlage = "aktiv" | "kommend" | "vergangen";

const uhrzeitFormat = new Intl.DateTimeFormat("de-CH", {
  timeZone: "Europe/Zurich",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const istMitternacht = (d: Date) => uhrzeitFormat.format(d) === "00:00";

export function auftragZeitlage(
  auftrag: { status: string; start_date: string | null; end_date: string | null },
  jetzt: Date,
): AuftragZeitlage {
  const start = auftrag.start_date ? new Date(auftrag.start_date) : null;
  const ende = auftrag.end_date ? new Date(auftrag.end_date) : null;
  // Ohne Datum: wie bisher bei den kommenden (die Liste sortiert sie ans Ende).
  if (!start && !ende) return "kommend";

  const unbrauchbaresEnde = !ende || (start !== null && ende.getTime() < start.getTime());
  const letzter = unbrauchbaresEnde ? start! : ende;
  // Ohne brauchbares Ende oder ganz ohne Uhrzeit laeuft der Auftrag bis zum Ende des letzten Tages.
  const tagesgenau = unbrauchbaresEnde || (istMitternacht(letzter) && (!start || istMitternacht(start)));
  const vorbei = tagesgenau
    ? localDateIso(letzter) < localDateIso(jetzt)
    : letzter.getTime() < jetzt.getTime();
  if (vorbei) return "vergangen";

  const begonnen = (start ?? letzter).getTime() <= jetzt.getTime();
  // Nur freigegebene Auftraege laufen; Partner-Anfragen und geschlossene zaehlen nie als aktiv.
  return begonnen && auftrag.status === "offen" ? "aktiv" : "kommend";
}
