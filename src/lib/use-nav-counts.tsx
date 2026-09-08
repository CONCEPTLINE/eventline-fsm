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
 *   - auftraege_action — Partner-Anfragen warten auf Freigabe
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
        .eq("status", "offen")
        .is("deleted_at", null),
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
          // Auftraege-Action = Partner-Anfragen die auf Freigabe warten.
          // (Vermietentwurf-Pipeline weggefallen 2026-09 — Entwuerfe leben
          // jetzt in job_drafts und tauchen nicht in dieser Queue auf.)
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

    // Personal + Admin in EINER parallelen Welle — vorher warteten die 4
    // Admin-Count-Queries auf die 2 persoenlichen (eine volle Netz-Runde
    // extra bei jedem Badge-Refresh). Index-Mapping: 0-1 personal,
    // 2-5 admin (bei Non-Admins undefined → 0 via ?? 0).
    const results = await Promise.all([...personalPromises, ...adminPromises]);

    setCounts({
      todos: results[0]?.count ?? 0,
      tickets_own: results[1]?.count ?? 0,
      tickets_open: results[5]?.count ?? 0,
      abrechnung: (results[2]?.count ?? 0) + (results[3]?.count ?? 0),
      auftraege_action: results[4]?.count ?? 0,
    });
  }, [supabase, isAdmin]);

  useEffect(() => {
    load();
    // Realtime-Events vom global-invalidate-Channel triggern Refetch —
    // aber COALESCED (leading + trailing, 2.5s-Fenster): der Channel feuert
    // jobs:invalidate bei JEDER jobs-Aenderung irgendeines Users, z.B. dem
    // 800ms-Notizen-Autosave im Auftrag-Detail. Ohne Debounce feuert jeder
    // offene Tab dann pausenlos bis zu 6 Count-Queries. Leading edge bleibt:
    // das erste Event (v.a. lokal gefeuerte nach eigener Aktion) refetcht
    // SOFORT; der Sturm danach wird auf 1 Refresh je 2.5s gedeckelt
    // (trailing Lauf am Fensterende nimmt den letzten Stand mit).
    const WINDOW_MS = 2500;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let trailingPending = false;
    const openWindow = () => {
      timer = setTimeout(() => {
        timer = null;
        if (trailingPending) {
          trailingPending = false;
          load();
          openWindow();
        }
      }, WINDOW_MS);
    };
    const coalescedLoad = () => {
      if (timer) {
        trailingPending = true;
        return;
      }
      load();
      openWindow();
    };
    const handler = () => { coalescedLoad(); };
    // Visibility-Change: Tab zurueck-in-Fokus → frische Counts holen
    // (deckt Stale-Counts ab wenn WebSocket im Hintergrund-Tab gedroppt
    // wurde und Events verpasst wurden). Laeuft durch dieselbe Coalesce-
    // Logik, damit Fokus + gleichzeitiges Realtime-Event nicht doppelt laden.
    const visibilityHandler = () => { if (document.visibilityState === "visible") coalescedLoad(); };
    window.addEventListener("jobs:invalidate", handler);
    window.addEventListener("realtime:tickets", handler);
    window.addEventListener("realtime:todos", handler);
    document.addEventListener("visibilitychange", visibilityHandler);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("jobs:invalidate", handler);
      window.removeEventListener("realtime:tickets", handler);
      window.removeEventListener("realtime:todos", handler);
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
