"use client";

/**
 * NavCountsProvider — zentraler Fetch der "wartet auf dich"-Zahlen die
 * als kleine Badges in der Navigation (Sidebar + MobileNav + Mobile-Sheet)
 * neben den Nav-Items erscheinen.
 *
 * Vorher waren diese Counts im Dashboard-"Auf dich wartet"-Card. Mit dem
 * Move in die Navigation sieht der User die Zahlen auf jeder Page, ohne
 * extra ins Dashboard zurueck.
 *
 * Counts:
 *   - todos        — eigene offene Todos (assigned_to = me, status=offen)
 *   - tickets_own  — eigene offene Tickets (created_by = me, status=offen)
 *   - tickets_open — alle offenen Tickets ausser Belege (admin-action queue)
 *   - abrechnung   — abgeschlossene Auftraege ohne Rechnung + offene Belege
 *   - auftraege_action — Vermietentwurf Step 4 + Partner-Anfragen warten
 *
 * Aggregation per Nav-Item siehe sidebar.tsx / mobile-nav.tsx —
 *   /todos      → todos
 *   /tickets    → max(tickets_own, tickets_open) ist falsch, beide haben
 *                 unterschiedliche Bedeutung → wir nehmen tickets_open fuer
 *                 Admins, sonst tickets_own
 *   /abrechnung → abrechnung
 *   /auftraege  → auftraege_action
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";

export interface NavCounts {
  todos: number;
  tickets_own: number;
  tickets_open: number;
  abrechnung: number;
  auftraege_action: number;
}

const EMPTY: NavCounts = {
  todos: 0,
  tickets_own: 0,
  tickets_open: 0,
  abrechnung: 0,
  auftraege_action: 0,
};

const NavCountsContext = createContext<NavCounts>(EMPTY);

interface ProviderProps {
  children: ReactNode;
  /** Aus dem PermissionsProvider weiter oben. Wenn nicht admin, ueberspringen
   *  wir die Admin-Queries (RLS wuerde sie ohnehin zu 0 filtern, aber wir
   *  sparen uns die Roundtrips). */
  isAdmin: boolean;
}

export function NavCountsProvider({ children, isAdmin }: ProviderProps) {
  const supabase = createClient();
  const [counts, setCounts] = useState<NavCounts>(EMPTY);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // Personliche Counts laufen immer (jeder User hat Todos/Tickets).
    const personalPromises = [
      supabase
        .from("todos")
        .select("id", { count: "exact", head: true })
        .eq("assigned_to", user.id)
        .eq("status", "offen"),
      supabase
        .from("tickets")
        .select("id", { count: "exact", head: true })
        .eq("created_by", user.id)
        .eq("status", "offen"),
    ];

    // Admin-Queries nur wenn Admin (sonst leere Counts).
    const adminPromises = isAdmin
      ? [
          // Abrechnung = unbilledJobs + unfiledBelege.
          // Filter MUSS identisch zur /abrechnung-Page sein — sonst zeigt
          // der Nav-Badge eine Zahl die nicht zur Liste passt. Inkl.
          // invoice_skipped_at IS NULL damit als "nicht stellen" markierte
          // Jobs nicht doppelt-zaehlen.
          supabase
            .from("jobs")
            .select("id", { count: "exact", head: true })
            .eq("status", "abgeschlossen")
            .is("invoiced_at", null)
            .is("invoice_skipped_at", null)
            .neq("is_deleted", true),
          supabase
            .from("tickets")
            .select("id", { count: "exact", head: true })
            .eq("type", "beleg")
            .is("filed_at", null)
            .neq("status", "abgelehnt"),
          // Auftraege-Action = Vermietentwurf Step 4 + Partner-Anfragen
          supabase
            .from("jobs")
            .select("id", { count: "exact", head: true })
            .eq("status", "anfrage")
            .eq("request_step", 4)
            .neq("is_deleted", true),
          supabase
            .from("jobs")
            .select("id", { count: "exact", head: true })
            .eq("status", "partner_anfrage")
            .neq("is_deleted", true),
          // Tickets-Open = alle offenen Tickets ausser Belege (Belege sind
          // ueber abrechnung gezaehlt, sonst doppelt)
          supabase
            .from("tickets")
            .select("id", { count: "exact", head: true })
            .eq("status", "offen")
            .neq("type", "beleg"),
        ]
      : [];

    const personal = await Promise.all(personalPromises);
    const admin = await Promise.all(adminPromises);

    setCounts({
      todos: personal[0]?.count ?? 0,
      tickets_own: personal[1]?.count ?? 0,
      tickets_open: admin[4]?.count ?? 0,
      abrechnung: (admin[0]?.count ?? 0) + (admin[1]?.count ?? 0),
      auftraege_action: (admin[2]?.count ?? 0) + (admin[3]?.count ?? 0),
    });
  }, [supabase, isAdmin]);

  useEffect(() => {
    load();
    // Realtime-Events vom global-invalidate-Channel triggern Refetch.
    const handler = () => { load(); };
    // Visibility-Change: Tab zurueck-in-Fokus → frische Counts holen
    // (deckt Stale-Counts ab wenn WebSocket im Hintergrund-Tab gedroppt
    // wurde und Events verpasst wurden).
    const visibilityHandler = () => { if (document.visibilityState === "visible") load(); };
    window.addEventListener("jobs:invalidate", handler);
    window.addEventListener("realtime:tickets", handler);
    document.addEventListener("visibilitychange", visibilityHandler);
    return () => {
      window.removeEventListener("jobs:invalidate", handler);
      window.removeEventListener("realtime:tickets", handler);
      document.removeEventListener("visibilitychange", visibilityHandler);
    };
  }, [load]);

  return (
    <NavCountsContext.Provider value={counts}>
      {children}
    </NavCountsContext.Provider>
  );
}

export function useNavCounts(): NavCounts {
  return useContext(NavCountsContext);
}

/** Mapping von Nav-Item-href auf den entsprechenden Counter. Wird in
 *  Sidebar + MobileNav benutzt um die Badge-Zahl pro Item zu bestimmen.
 *  Reihenfolge der Auswertung: spezifischer Pfad zuerst. */
export function getBadgeForHref(href: string, counts: NavCounts, isAdmin: boolean): number {
  if (href.startsWith("/todos")) return counts.todos;
  if (href.startsWith("/abrechnung")) return counts.abrechnung;
  if (href.startsWith("/auftraege")) return counts.auftraege_action;
  if (href.startsWith("/tickets")) return isAdmin ? counts.tickets_open : counts.tickets_own;
  return 0;
}
