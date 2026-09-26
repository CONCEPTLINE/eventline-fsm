// Zeitfenster-Arten fuer Termine (job_appointments.zeit_modus, Migration 268).
// Zentrale Labels/Erklaerungen — Partner-Portal (Erfassung) und Firmenportal
// (Anzeige) nutzen dieselben Texte, damit beide Seiten vom Gleichen reden.
//
// Hintergrund (Partnerwunsch Barakuba): nicht jeder Termin ist gleich hart —
// manches MUSS exakt dann stattfinden, manches darf EVENTLINE nach Absprache
// mit den Mieter:innen schieben, und manches muss nur bis zu einem Zeitpunkt
// fertig sein.

export type TerminZeitModus = "fix" | "verschiebbar" | "deadline";

export const ZEIT_MODI: {
  key: TerminZeitModus;
  label: string;
  /** Erklaerung aus Partner-Sicht (Erfassung im Portal). */
  hint: string;
  /** Kurz-Hinweis aus EVENTLINE-Sicht (Anzeige intern). */
  internHint: string;
}[] = [
  {
    key: "fix",
    label: "Fixe Zeiten",
    hint: "Muss zwingend in diesem Zeitfenster stattfinden.",
    internHint: "Muss zwingend in diesem Zeitfenster stattfinden.",
  },
  {
    key: "verschiebbar",
    label: "Nach Absprache verschiebbar",
    hint: "EVENTLINE darf das Zeitfenster nach Absprache mit deinen Mieter:innen verschieben — du wirst über jede Verschiebung informiert.",
    internHint: "Darf nach Absprache mit den Mieter:innen verschoben werden — der Partner wird bei einer Verschiebung automatisch informiert.",
  },
  {
    key: "deadline",
    label: "Fertig bis",
    hint: "EVENTLINE plant frei und garantiert, dass es bis zu diesem Zeitpunkt erledigt ist.",
    internHint: "Zeitlicher Spielraum — muss nur bis zum angegebenen Zeitpunkt erledigt sein.",
  },
];

export function zeitModusDef(modus: string | null | undefined) {
  return ZEIT_MODI.find((m) => m.key === modus) ?? ZEIT_MODI[0];
}
