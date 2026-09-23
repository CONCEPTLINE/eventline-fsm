/**
 * Daten-Diät für Lead-LISTEN: alle Spalten AUSSER `notizen` — der JSON-Blob
 * (Details, Termine, Offerte-Metadaten) ist die mit Abstand schwerste Spalte
 * und wird von Liste/Filter/Sortierung/GoalTracker nirgends gelesen. Der
 * LeadEditor lädt seinen Lead (inkl. notizen) selbst per Einzel-Query.
 *
 * Lebt als eigenes Modul (nicht in vertrieb/page.tsx exportiert), weil
 * Next.js App-Router-Pages keine zusätzlichen Named-Exports erlauben —
 * der Build-Typecheck (next-types-plugin) lehnt sie ab. Genutzt von
 * /vertrieb und /vertrieb/archiv.
 */
export const LIST_COLUMNS =
  "id, nr, firma, branche, ansprechperson, position, email, telefon, event_typ, " +
  "status, datum_kontakt, prioritaet, kategorie, step, verloren_grund, assigned_to, " +
  "wiedervorlage_am, wiedervorlage_note, wiedervorlage_snoozed, recontact_count, " +
  "created_at, updated_at";
