// Zentrale Nummernkreis-Praefixe + Formatter. Vorher stand "INT-" 110x
// als Literal im Code (Skalierbarkeits-Audit 2026-09-23) — ein
// Praefix-Wechsel waere unfindbar gewesen. Muster: formatProjectNumber
// in projekte-format.ts.

export const ENTITY_PREFIX = {
  job: "INT",
  ticket: "T",
  project: "PROJ",
} as const;

/** "INT-4123" bzw. "INT-…" solange die Nummer noch fehlt. */
export function formatJobNumber(n: number | null | undefined): string {
  return n == null ? `${ENTITY_PREFIX.job}-…` : `${ENTITY_PREFIX.job}-${n}`;
}

/** "T-312". Ticket-Nummern sind nie null. */
export function formatTicketNumber(n: number): string {
  return `${ENTITY_PREFIX.ticket}-${n}`;
}

/** Regex fuer die globale Suche: optionales Praefix + Zahl — aus den
 *  registrierten Praefixen abgeleitet statt hart kodiert. */
export const NUMMER_SUCHE_RE = new RegExp(
  `^(?:${Object.values(ENTITY_PREFIX).join("-|")}-)?(\\d+)$`,
  "i",
);
