"use client";

// Hook fuer Konflikt-Check beim Termin-Anlegen / Mitarbeiter-Zuweisen.
//
// Wenn ein Termin auf ein Datum gelegt wird, fragt der Hook alle
// time_off-Eintraege ab deren Datums-Range den Termin-Tag enthaelt
// (status genehmigt ODER beantragt). Konsumenten zeigen die Liste
// als Warnung an + markieren betroffene User-Buttons.
//
// Daten ueber team_abwesenheiten() (Migration 379): dieselben Personen wie
// die time_off-Sicht bisher (eigene, eigenes Team, scope all, Berechtigte),
// ohne Notizen; «krank» fuer Nicht-Berechtigte als «abwesend».

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { AbwesenheitAnzeigeTyp } from "@/lib/abwesenheit-sichtbarkeit";
import type { TimeOffStatus } from "@/types";

export interface TimeOffConflict {
  id: string;
  user_id: string;
  start_date: string;
  end_date: string;
  type: AbwesenheitAnzeigeTyp;
  status: TimeOffStatus;
  user: { full_name: string } | null;
}

interface TeamAbwesenheitRow {
  id: string;
  user_id: string;
  start_date: string;
  end_date: string;
  status: TimeOffStatus;
  typ: AbwesenheitAnzeigeTyp;
  user_name: string | null;
  user_aktiv: boolean;
}

/** Returnt die Liste der time_off-Eintraege die das gegebene Datum (YYYY-MM-DD)
 *  ueberlappen — leer wenn null/undefined oder kein Konflikt. */
export function useTimeOffConflicts(date: string | null | undefined): TimeOffConflict[] {
  const [conflicts, setConflicts] = useState<TimeOffConflict[]>([]);

  useEffect(() => {
    if (!date) {
      setConflicts([]);
      return;
    }
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.rpc("team_abwesenheiten", { p_von: date, p_bis: date });
      if (cancelled) return;
      setConflicts(
        ((data ?? []) as TeamAbwesenheitRow[])
          // Nur AKTIVE Mitarbeiter — deaktivierte sind eh nicht zuweisbar,
          // ihre Abwesenheiten gehoeren nicht in die Konflikt-Warnung.
          .filter((r) => r.user_aktiv && (r.status === "genehmigt" || r.status === "beantragt"))
          .map((r) => ({
            id: r.id,
            user_id: r.user_id,
            start_date: r.start_date,
            end_date: r.end_date,
            type: r.typ,
            status: r.status,
            user: r.user_name ? { full_name: r.user_name } : null,
          })),
      );
    })();
    return () => { cancelled = true; };
  }, [date]);

  return conflicts;
}

/** Map user_id -> Konflikt fuer schnellen Pro-Button-Lookup. Bei mehreren
 *  Eintraegen pro User: genehmigt schlaegt beantragt. */
export function buildConflictMap(conflicts: TimeOffConflict[]): Map<string, TimeOffConflict> {
  const m = new Map<string, TimeOffConflict>();
  for (const c of conflicts) {
    const existing = m.get(c.user_id);
    if (!existing || (existing.status === "beantragt" && c.status === "genehmigt")) {
      m.set(c.user_id, c);
    }
  }
  return m;
}
