"use client";

// Hook fuer Konflikt-Check beim Termin-Anlegen / Mitarbeiter-Zuweisen.
//
// Wenn ein Termin auf ein Datum gelegt wird, fragt der Hook alle
// time_off-Eintraege ab deren Datums-Range den Termin-Tag enthaelt
// (status genehmigt ODER beantragt). Konsumenten zeigen die Liste
// als Warnung an + markieren betroffene User-Buttons.
//
// RLS: Admins (mit ferien:approve) sehen alle, normale User sehen nur
// eigene Eintraege. Termin-Anlegen ist typisch eine Admin-Action,
// daher reicht das in der Praxis.

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { TimeOff } from "@/types";

export interface TimeOffConflict extends TimeOff {
  user: { full_name: string } | null;
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
      const { data } = await supabase
        .from("time_off")
        // Nur AKTIVE Mitarbeiter — deaktivierte sind eh nicht zuweisbar,
        // ihre Abwesenheiten gehoeren nicht in die Konflikt-Warnung.
        .select("*, user:profiles!time_off_user_id_fkey!inner(full_name, is_active)")
        .eq("user.is_active", true)
        .lte("start_date", date)
        .gte("end_date", date)
        .in("status", ["genehmigt", "beantragt"]);
      if (cancelled) return;
      setConflicts((data as unknown as TimeOffConflict[]) ?? []);
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
