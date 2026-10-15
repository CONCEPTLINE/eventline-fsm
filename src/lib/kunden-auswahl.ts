/**
 * Kunden fuer Auswahlfelder — EINE Abfrage fuer alle Kunden-Picker, die
 * eine neue Zuordnung anbieten: Auftrag neu/bearbeiten, Entwurf neu/Detail,
 * Teilnehmer eines Projekt-Termins, Kunde einer Location.
 *
 * Angeboten werden nur aktive, nicht archivierte Kunden (Leo 2026-10-15:
 * archivierte Kunden erscheinen in Auswahlfeldern nicht mehr). Gefiltert
 * wird in der DB-Abfrage, nicht im JS. Archiv-Definition wie
 * src/lib/archiv.ts (kundeArchiviert: archived_at gesetzt).
 *
 * `behalte`: Ist bei einem BESTEHENDEN Datensatz bereits ein (inzwischen)
 * archivierter Kunde gewaehlt, laedt dieselbe Abfrage genau diesen mit —
 * sonst bliebe das Feld leer bzw. der Teilnehmer unsichtbar. Andere
 * Datensaetze bekommen ihn nicht angeboten.
 *
 * Bewusst NICHT hierueber: Listen- und Filteransichten (Kunden-Liste mit
 * Archiv-Filter, globale Suche, Auswertungen) — dort gehoert das Archiv dazu.
 */

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

/** Antwort wie bei supabase-js: Zeilen (oder null) plus Fehler. */
export type KundenAuswahlAntwort<T> = { data: T[] | null; error: PostgrestError | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Zeilen-Typ `T` gibt der Aufrufer passend zu `spalten` an (die Spaltenliste
 *  ist ein Laufzeit-String, den supabase-js hier nicht auswerten kann). */
export function kundenAuswahl<T extends { id: string }>(
  supabase: SupabaseClient,
  spalten: string,
  behalte: ReadonlyArray<string | null | undefined> = [],
): PromiseLike<KundenAuswahlAntwort<T>> {
  // Nur echte UUIDs in den Filter-String (PostgREST-Syntax, keine Injektion).
  const ids = [...new Set(behalte.filter((id): id is string => !!id && UUID.test(id)))];
  const abfrage = supabase.from("customers").select(spalten);
  const gefiltert =
    ids.length > 0
      ? abfrage.or(`and(is_active.eq.true,archived_at.is.null),id.in.(${ids.join(",")})`)
      : abfrage.eq("is_active", true).is("archived_at", null);
  return gefiltert.order("name") as unknown as PromiseLike<KundenAuswahlAntwort<T>>;
}
