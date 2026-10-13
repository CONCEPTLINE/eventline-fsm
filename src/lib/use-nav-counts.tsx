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
 * Counts («me» = effektiver User aus /api/me, bei «Ansicht als» der
 * simulierte — gleiche Definition wie /todos und Dashboard-Karte):
 *   - todos        — eigene offene Todos (assigned_to = me, status=offen)
 *   - tickets_own  — eigene offene Tickets (created_by = me, status=offen)
 *   - tickets_open — alle offenen Tickets ausser Belege (admin-action queue)
 *   - abrechnung   — abgeschlossene Auftraege ohne Rechnung + offene Belege
 *   - auftraege_action — Partner-Anfragen warten auf Freigabe
 *   - antraege     — Antraege, die DIESE Person genehmigen darf: beantragte
 *                    Abwesenheiten (ferien:approve, wie /api/time-off/[id]/
 *                    decide) + offene Stempel-Korrekturen (tickets:manage,
 *                    wie /api/tickets/[id]/approve). Gleiche Filter wie die
 *                    Listen in /api/hr/anfragen. stempelzeiten:see-all allein
 *                    darf nichts genehmigen → kein Punkt.
 *
 * Aggregation per Nav-Item siehe getBadgeForHref unten —
 *   /todos      → todos
 *   /tickets    → max(tickets_own, tickets_open) ist falsch, beide haben
 *                 unterschiedliche Bedeutung → wir nehmen tickets_open fuer
 *                 tickets:manage (Admin passt via hasPermission durch),
 *                 sonst tickets_own
 *   /antraege   → antraege
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
  antraege: number;
}

const EMPTY: NavCounts = {
  todos: 0,
  tickets_own: 0,
  tickets_open: 0,
  abrechnung: 0,
  auftraege_action: 0,
  antraege: 0,
};

const NavCountsContext = createContext<NavCounts>(EMPTY);

interface ProviderProps {
  children: ReactNode;
  /** Profil-ID des effektiven Users aus dem PermissionsProvider (/api/me).
   *  Bei «Ansicht als» ist das der simulierte User — NICHT die Auth-Session
   *  (auth.getUser() bliebe der Admin). Die Todo-Seite und die Dashboard-
   *  Karte zaehlen mit genau dieser ID; nimmt der Badge eine andere, zeigt
   *  er z. B. die Todos des Admins neben «Keine offenen Todos». */
  userId: string;
  /** Aus dem PermissionsProvider weiter oben. Wenn nicht admin, ueberspringen
   *  wir die Admin-Queue-Queries (RLS wuerde sie ohnehin zu 0 filtern, aber
   *  wir sparen uns die Roundtrips). */
  isAdmin: boolean;
  /** hasPermission(…, "tickets:manage") — Admin passt immer durch. Gated die
   *  tickets_open-Queue (W5): Custom-Rollen mit Ticket-Verantwortung sehen
   *  den Admin-Queue-Badge, nicht nur die eigenen Tickets. */
  canManageTickets: boolean;
  /** hasPermission(…, "ferien:approve") — Admin passt immer durch. Gated
   *  die beantragten Abwesenheiten im Anträge-Punkt (RLS «Genehmiger sieht
   *  alle Ferien» haengt am selben Recht). */
  canApproveFerien: boolean;
}

export function NavCountsProvider({ children, userId, isAdmin, canManageTickets, canApproveFerien }: ProviderProps) {
  const supabase = createClient();
  const [counts, setCounts] = useState<NavCounts>(EMPTY);

  const load = useCallback(async () => {
    if (!userId) return;

    // Alles in EINER parallelen Welle (Perf-Audit — keine zweite Netz-Runde).
    // Index-Mapping: 0-1 personal (laufen immer — jeder User hat Todos/
    // Tickets), 2-4 admin-Queues, 5 tickets:manage-Queue, 6-7 Antraege
    // (ferien:approve bzw. tickets:manage). Nicht berechtigte Queries sind
    // null → 0 via ?? 0.
    const results = await Promise.all([
      supabase
        .from("todos")
        .select("id", { count: "exact", head: true })
        .eq("assigned_to", userId)
        .eq("status", "offen")
        .is("deleted_at", null),
      supabase
        .from("tickets")
        .select("id", { count: "exact", head: true })
        .eq("created_by", userId)
        .eq("status", "offen"),
      // Abrechnung = unbilledJobs + unfiledBelege (admin-only Queue).
      // Filter MUSS identisch zur /abrechnung-Page sein — sonst zeigt
      // der Nav-Badge eine Zahl die nicht zur Liste passt. Inkl.
      // invoice_skipped_at IS NULL damit als "nicht stellen" markierte
      // Jobs nicht doppelt-zaehlen.
      isAdmin
        ? supabase
            .from("jobs")
            .select("id", { count: "exact", head: true })
            .eq("status", "abgeschlossen")
            .is("invoiced_at", null)
            .is("invoice_skipped_at", null)
            .neq("is_deleted", true)
        : null,
      isAdmin
        ? supabase
            .from("tickets")
            .select("id", { count: "exact", head: true })
            .eq("type", "beleg")
            .is("filed_at", null)
            .neq("status", "abgelehnt")
        : null,
      // Auftraege-Action = Partner-Anfragen die auf Freigabe warten
      // (admin-only Queue). (Vermietentwurf-Pipeline weggefallen 2026-09 —
      // Entwuerfe leben jetzt in job_drafts und tauchen hier nicht auf.)
      isAdmin
        ? supabase
            .from("jobs")
            .select("id", { count: "exact", head: true })
            .eq("status", "partner_anfrage")
            .neq("is_deleted", true)
        : null,
      // Tickets-Open = alle offenen Tickets ausser Belege (Belege sind
      // ueber abrechnung gezaehlt, sonst doppelt). Permission-gated statt
      // role==='admin' (W5) — wie die Manage-Aktionen auf /tickets selbst.
      canManageTickets
        ? supabase
            .from("tickets")
            .select("id", { count: "exact", head: true })
            .eq("status", "offen")
            .neq("type", "beleg")
        : null,
      // Antraege: beantragte Abwesenheiten (noch nicht entschieden).
      canApproveFerien
        ? supabase
            .from("time_off")
            .select("id", { count: "exact", head: true })
            .eq("status", "beantragt")
        : null,
      // Antraege: offene Stempel-Korrekturen (Genehmigen = tickets:manage).
      canManageTickets
        ? supabase
            .from("tickets")
            .select("id", { count: "exact", head: true })
            .eq("type", "stempel_aenderung")
            .eq("status", "offen")
        : null,
    ]);

    setCounts({
      todos: results[0]?.count ?? 0,
      tickets_own: results[1]?.count ?? 0,
      tickets_open: results[5]?.count ?? 0,
      abrechnung: (results[2]?.count ?? 0) + (results[3]?.count ?? 0),
      auftraege_action: results[4]?.count ?? 0,
      antraege: (results[6]?.count ?? 0) + (results[7]?.count ?? 0),
    });
  }, [supabase, userId, isAdmin, canManageTickets, canApproveFerien]);

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
    // time_off haengt nicht am Realtime-Kanal (nicht in der Publication) —
    // wer eine Abwesenheit beantragt/entscheidet, feuert lokal
    // «time_off:invalidate», damit der Anträge-Punkt sofort stimmt.
    window.addEventListener("jobs:invalidate", handler);
    window.addEventListener("realtime:tickets", handler);
    window.addEventListener("realtime:todos", handler);
    window.addEventListener("time_off:invalidate", handler);
    document.addEventListener("visibilitychange", visibilityHandler);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("jobs:invalidate", handler);
      window.removeEventListener("realtime:tickets", handler);
      window.removeEventListener("realtime:todos", handler);
      window.removeEventListener("time_off:invalidate", handler);
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
 *  Sidebar, MobileNav und Mehr-Sheet benutzt um den Punkt pro Item zu
 *  bestimmen. Reihenfolge der Auswertung: spezifischer Pfad zuerst.
 *  canManageTickets = hasPermission(…, "tickets:manage") — muss zur
 *  Provider-Prop passen, sonst zeigt der Badge 0 obwohl die Queue laedt.
 *  /antraege braucht kein Flag: der Provider zaehlt nur, was die Person
 *  genehmigen darf (sonst 0). */
export function getBadgeForHref(href: string, counts: NavCounts, canManageTickets: boolean): number {
  if (href.startsWith("/todos")) return counts.todos;
  if (href.startsWith("/abrechnung")) return counts.abrechnung;
  if (href.startsWith("/auftraege")) return counts.auftraege_action;
  if (href.startsWith("/antraege")) return counts.antraege;
  if (href.startsWith("/tickets")) return canManageTickets ? counts.tickets_open : counts.tickets_own;
  return 0;
}
