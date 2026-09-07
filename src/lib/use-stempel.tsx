"use client";

// Stempel-Provider + useStempel-Hook.
//
// Vorher war das ein reiner Hook — jeder Mount hat eigenes refresh() +
// eigenes window-Event-Listener gemacht. Bei 4 Stempel-Komponenten gleich-
// zeitig (Sidebar, Widget, JobButton, Modal) auf einer Auftrag-Detail-Seite
// waren das 4× refresh() + 4× DB-Lookup auf time_entries beim Mount.
//
// Jetzt: Provider laedt einmal, alle Konsumenten teilen sich den State.
// Layout wraps die App damit der Provider immer verfuegbar ist (genau wie
// PermissionsProvider).

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import type { TimeEntry } from "@/types";

interface ClockInOpts {
  jobId?: string | null;
  projectId?: string | null;
  description?: string | null;
  rateTierId?: string | null;
}

interface StempelState {
  active: TimeEntry | null;
  loading: boolean;
  clockIn: (opts: ClockInOpts) => Promise<{ success: boolean; error?: string }>;
  clockOut: () => Promise<{ success: boolean; error?: string }>;
  discardActive: () => Promise<{ success: boolean; error?: string }>;
  /**
   * Wechselt den Verrechnungssatz-Modus waehrend laufender Stempelung:
   * beendet den aktuellen Eintrag (clock_out=jetzt) und startet einen
   * neuen mit demselben job/project/description aber neuem rate_tier_id.
   * So bekommt der Report zwei saubere Zeit-Bloecke mit je einem Tarif —
   * kein nachtraegliches Splitten noetig.
   */
  switchRateTier: (rateTierId: string) => Promise<{ success: boolean; error?: string }>;
  refresh: () => Promise<void>;
}

const StempelContext = createContext<StempelState | null>(null);

export function StempelProvider({ children }: { children: ReactNode }) {
  const supabase = createClient();
  const [active, setActive] = useState<TimeEntry | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setActive(null);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("time_entries")
      .select("*")
      .eq("user_id", user.id)
      .is("clock_out", null)
      .maybeSingle();
    setActive((data as TimeEntry | null) ?? null);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { refresh(); }, [refresh]);

  // Konsumiert das `realtime:time_entries`-Event vom globalen Channel im
  // (app)/layout.tsx — kein eigener WebSocket noetig.
  useEffect(() => {
    const handler = () => { refresh(); };
    window.addEventListener("realtime:time_entries", handler);
    return () => window.removeEventListener("realtime:time_entries", handler);
  }, [refresh]);

  const clockIn = useCallback(async (opts: ClockInOpts) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { success: false, error: "Nicht eingeloggt" };
    const payload = {
      user_id: user.id,
      job_id: opts.jobId ?? null,
      project_id: opts.projectId ?? null,
      description: opts.description?.trim() || null,
      rate_tier_id: opts.rateTierId ?? null,
      clock_in: new Date().toISOString(),
    };
    const { data, error } = await supabase
      .from("time_entries")
      .insert(payload)
      .select("*")
      .single();
    if (error) {
      // Unique-Index "time_entries_one_active_per_user" schlaegt zu wenn
      // schon ein offener Eintrag existiert.
      if (error.code === "23505") {
        return { success: false, error: "Du bist schon eingestempelt" };
      }
      return { success: false, error: error.message };
    }
    setActive(data as TimeEntry);
    return { success: true };
  }, [supabase]);

  const clockOut = useCallback(async () => {
    if (!active) return { success: false, error: "Nicht eingestempelt" };
    const { error } = await supabase
      .from("time_entries")
      .update({ clock_out: new Date().toISOString() })
      .eq("id", active.id);
    if (error) return { success: false, error: error.message };
    setActive(null);
    return { success: true };
  }, [active, supabase]);

  // Eintrag komplett verwerfen — nur sinnvoll wenn jemand versehentlich
  // gestempelt hat. Eintraege im DB als gepflegtes Audit-Log halten ist
  // wichtig, deshalb hartes Loeschen statt clock_out=clock_in-Pseudo.
  const discardActive = useCallback(async () => {
    if (!active) return { success: false, error: "Nicht eingestempelt" };
    const { error } = await supabase.from("time_entries").delete().eq("id", active.id);
    if (error) return { success: false, error: error.message };
    setActive(null);
    return { success: true };
  }, [active, supabase]);

  /**
   * Modus wechseln: aktuelle Stempelung schliessen + neue mit neuem
   * rate_tier_id starten. In einer "Transaktion" clientseitig — im Report
   * ergibt das zwei Zeit-Blöcke, je mit korrektem Tarif. Falls das neue
   * Insert scheitert, rollen wir den close-Update zurück (clock_out=null),
   * damit der User nicht ohne laufende Uhr dasteht.
   */
  const switchRateTier = useCallback(async (rateTierId: string) => {
    if (!active) return { success: false, error: "Nicht eingestempelt" };
    if (active.rate_tier_id === rateTierId) return { success: true }; // no-op
    const now = new Date().toISOString();
    const { error: closeErr } = await supabase
      .from("time_entries")
      .update({ clock_out: now })
      .eq("id", active.id);
    if (closeErr) return { success: false, error: closeErr.message };
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { success: false, error: "Nicht eingeloggt" };
    const { data, error: insErr } = await supabase
      .from("time_entries")
      .insert({
        user_id: user.id,
        job_id: active.job_id,
        project_id: active.project_id ?? null,
        description: active.description,
        rate_tier_id: rateTierId,
        clock_in: now,
      })
      .select("*")
      .single();
    if (insErr) {
      // Rollback des close-Updates
      await supabase.from("time_entries").update({ clock_out: null }).eq("id", active.id);
      return { success: false, error: insErr.message };
    }
    setActive(data as TimeEntry);
    return { success: true };
  }, [active, supabase]);

  const value = useMemo<StempelState>(
    () => ({ active, loading, clockIn, clockOut, discardActive, switchRateTier, refresh }),
    [active, loading, clockIn, clockOut, discardActive, switchRateTier, refresh],
  );

  return <StempelContext.Provider value={value}>{children}</StempelContext.Provider>;
}

export function useStempel(): StempelState {
  const ctx = useContext(StempelContext);
  if (!ctx) {
    // Fallback fuer Komponenten die ausserhalb des Providers gemounted
    // werden (sollte in der App nicht vorkommen — Layout wraps alles).
    // No-Op statt Crash damit Tests + Storybook funktionieren.
    return {
      active: null,
      loading: false,
      clockIn: async () => ({ success: false, error: "Kein StempelProvider" }),
      clockOut: async () => ({ success: false, error: "Kein StempelProvider" }),
      discardActive: async () => ({ success: false, error: "Kein StempelProvider" }),
      switchRateTier: async () => ({ success: false, error: "Kein StempelProvider" }),
      refresh: async () => {},
    };
  }
  return ctx;
}

// Hilfsfunktion fuer Live-Timer-Anzeige.
export function formatStempelDuration(clockIn: string, now: number = Date.now()): string {
  const start = new Date(clockIn).getTime();
  const totalSec = Math.max(0, Math.floor((now - start) / 1000));
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  return `${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
}
