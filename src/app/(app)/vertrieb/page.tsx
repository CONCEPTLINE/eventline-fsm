"use client";

/**
 * Vertrieb-Cockpit — neue Drei-Spalten-Architektur.
 *
 *  ┌────────────────────────────────────────────────────────────────────────┐
 *  │ Header + KPIs + Funnel + Vertriebsziel-Tracker                          │
 *  ├──────────────┬──────────────┬──────────────────────────────────────────┤
 *  │ ALLE (alle)  │ MEINE/Person │ DETAIL — Lead-Editor des selektierten   │
 *  │ collapsable  │ Drop-Target  │ Leads. Wenn nichts gewaehlt: Hint.      │
 *  │ Drag-Source  │ + Drag-Source│                                          │
 *  ├──────────────┴──────────────┴──────────────────────────────────────────┤
 *
 * Drag-Drop:
 *  - General -> Personal = Lead assignen (Reassign nur fuer Admin)
 *  - Personal -> General = Lead unassignen (jeder darf eigene zurueckgeben)
 *
 * /vertrieb/[id] leitet auf /vertrieb?lead=<id> um — alter Bookmark-
 * Support, Detail oeffnet sich direkt.
 *
 * Mobile (< md): die drei Spalten werden zu Tabs gestapelt
 * (Alle / Meine / Detail). Detail-Tab nur wenn was selektiert.
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { TOAST } from "@/lib/messages";
import { usePermissions } from "@/lib/use-permissions";
import { Card, CardContent } from "@/components/ui/card";
import type { VertriebContact } from "@/types";
import { Plus, TrendingUp, PartyPopper, Trophy, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { toast } from "sonner";
import { LeadEditor } from "@/components/vertrieb/lead-editor";
import { GoalTracker } from "@/components/vertrieb/goal-tracker";
import { GeneralColumn } from "@/components/vertrieb/columns/general-column";
import { PersonalColumn } from "@/components/vertrieb/columns/personal-column";
import { useConfirm } from "@/components/ui/use-confirm";
import { parseEventStart } from "@/lib/vertrieb-anomaly";

type Counts = {
  total: number; offen: number; kontaktiert: number; gespraech: number;
  gewonnen: number; abgesagt: number; step_1: number; step_2: number;
  step_3: number; step_4: number;
};

type MobileTab = "all" | "mine" | "detail";

export default function VertriebPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();
  const { can, role } = usePermissions();
  const { confirm, ConfirmModalElement } = useConfirm();
  const isAdmin = role === "admin";

  // Daten
  const [contacts, setContacts] = useState<VertriebContact[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [salesPeople, setSalesPeople] = useState<{ id: string; full_name: string }[]>([]);
  const [loading, setLoading] = useState(true);

  // Selection + UI
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(searchParams.get("lead"));
  const [viewedPersonId, setViewedPersonId] = useState<string>("");
  const [generalCollapsed, setGeneralCollapsed] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>("all");

  const load = useCallback(async () => {
    const [{ data }, countsRes, salesRes, userRes] = await Promise.all([
      supabase.from("vertrieb_contacts").select("*").order("nr").limit(2000),
      supabase.from("vertrieb_counts").select("*").single(),
      supabase
        .from("profiles")
        .select("id, full_name")
        .in("email", ["leo@eventline-basel.com", "mischa@eventline-basel.com", "raul@eventline-basel.com"])
        .eq("is_active", true)
        .order("full_name"),
      supabase.auth.getUser(),
    ]);
    if (data) setContacts(data as VertriebContact[]);
    if (countsRes.data) setCounts(countsRes.data);
    if (salesRes.data) setSalesPeople(salesRes.data);
    if (userRes.data.user) {
      setCurrentUserId(userRes.data.user.id);
      if (!viewedPersonId) setViewedPersonId(userRes.data.user.id);
    }
    setLoading(false);
  }, [supabase, viewedPersonId]);

  useEffect(() => {
    load();
    const handler = () => load();
    window.addEventListener("realtime:vertrieb_contacts", handler);
    return () => window.removeEventListener("realtime:vertrieb_contacts", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // URL <-> Selection sync (Detail oeffnen via ?lead=<id>).
  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedLeadId) url.searchParams.set("lead", selectedLeadId);
    else url.searchParams.delete("lead");
    window.history.replaceState({}, "", url.toString());
  }, [selectedLeadId]);

  // Assign-Handler: Lead in personal column droppen
  async function assignLead(leadId: string, toUserId: string) {
    const lead = contacts.find((c) => c.id === leadId);
    if (!lead) return;
    if (lead.assigned_to === toUserId) return; // No-op

    // Reassign-Regel: nur Admin darf einen Lead von User A nach User B
    // umlegen. Nicht-Admins koennen nur unassigned Leads holen.
    if (lead.assigned_to && lead.assigned_to !== toUserId && !isAdmin) {
      toast.error("Dieser Lead gehoert schon jemandem — nur Admin darf umverteilen");
      return;
    }
    // Admin-Reassign braucht Confirm wenn jemand anderem weggenommen wird.
    if (lead.assigned_to && lead.assigned_to !== toUserId && isAdmin) {
      const oldOwner = salesPeople.find((s) => s.id === lead.assigned_to)?.full_name ?? "jemand anderem";
      const ok = await confirm({
        title: "Lead umverteilen?",
        message: `${lead.firma} ist aktuell ${oldOwner} zugewiesen. Wirklich uebernehmen?`,
        confirmLabel: "Umverteilen",
        variant: "red",
      });
      if (!ok) return;
    }

    // Optimistic Update
    const before = lead.assigned_to;
    setContacts((prev) => prev.map((c) => c.id === leadId ? { ...c, assigned_to: toUserId } : c));
    const { error } = await supabase.from("vertrieb_contacts").update({ assigned_to: toUserId }).eq("id", leadId);
    if (error) {
      setContacts((prev) => prev.map((c) => c.id === leadId ? { ...c, assigned_to: before } : c));
      TOAST.supabaseError(error, "Zuweisung fehlgeschlagen");
    }
  }

  async function unassignLead(leadId: string) {
    const lead = contacts.find((c) => c.id === leadId);
    if (!lead || !lead.assigned_to) return;
    const before = lead.assigned_to;
    setContacts((prev) => prev.map((c) => c.id === leadId ? { ...c, assigned_to: null } : c));
    const { error } = await supabase.from("vertrieb_contacts").update({ assigned_to: null }).eq("id", leadId);
    if (error) {
      setContacts((prev) => prev.map((c) => c.id === leadId ? { ...c, assigned_to: before } : c));
      TOAST.supabaseError(error, "Zurueckgeben fehlgeschlagen");
    }
  }

  function selectLead(c: VertriebContact) {
    setSelectedLeadId(c.id);
    setMobileTab("detail");
  }

  function closeDetail() {
    setSelectedLeadId(null);
    setMobileTab("mine");
  }

  const statusCounts: Record<string, number> = counts ? {
    offen: counts.offen, kontaktiert: counts.kontaktiert, gespraech: counts.gespraech,
    gewonnen: counts.gewonnen, abgesagt: counts.abgesagt,
  } : {};

  return (
    <div className="space-y-4 flex flex-col" style={{ minHeight: "calc(100vh - 120px)" }}>
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Vertrieb</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {(counts?.total ?? 0) - (statusCounts.abgesagt || 0)} aktiv · {statusCounts.gewonnen || 0} gewonnen · {statusCounts.offen || 0} offen
          </p>
        </div>
        <div className="flex items-center gap-2">
          {can("vertrieb:create") && (
            <Link href="/vertrieb/neu" className="kasten kasten-red">
              <Plus className="h-3.5 w-3.5" />Lead
            </Link>
          )}
        </div>
      </div>

      {/* KPIs (only desktop) */}
      {counts && counts.total > 0 && (
        <div className="hidden md:grid gap-3 md:grid-cols-3">
          <StatCards counts={counts} contacts={contacts} />
        </div>
      )}

      {/* Goal-Tracker */}
      <GoalTracker contacts={contacts} isAdmin={isAdmin} />

      {/* Mobile Tab-Bar */}
      <div className="md:hidden flex gap-1 p-1 rounded-lg bg-muted">
        <MobileTabBtn label="Alle" active={mobileTab === "all"} onClick={() => setMobileTab("all")} />
        <MobileTabBtn label="Meine" active={mobileTab === "mine"} onClick={() => setMobileTab("mine")} />
        {selectedLeadId && (
          <MobileTabBtn label="Detail" active={mobileTab === "detail"} onClick={() => setMobileTab("detail")} />
        )}
      </div>

      {/* Drei-Spalten-Layout */}
      <div className="flex-1 min-h-0 flex gap-3 rounded-lg overflow-hidden">
        {/* SPALTE 1 — Alle Leads */}
        <div
          className={`${
            mobileTab === "all" ? "flex" : "hidden md:flex"
          } ${
            generalCollapsed ? "md:w-9" : "md:w-72"
          } w-full flex-col rounded-lg border border-border bg-card overflow-hidden shrink-0 transition-all`}
        >
          {generalCollapsed ? (
            <button
              type="button"
              onClick={() => setGeneralCollapsed(false)}
              className="h-full flex items-start justify-center pt-3 text-muted-foreground hover:text-foreground"
              data-tooltip="Alle Leads ausklappen"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          ) : (
            <>
              <div className="flex items-center justify-end px-1 py-1 border-b border-border shrink-0">
                <button
                  type="button"
                  onClick={() => setGeneralCollapsed(true)}
                  className="icon-btn icon-btn-muted hidden md:flex"
                  data-tooltip="Einklappen"
                  aria-label="Einklappen"
                >
                  <PanelLeftClose className="h-3.5 w-3.5" />
                </button>
              </div>
              <GeneralColumn
                contacts={contacts}
                selectedId={selectedLeadId}
                onSelect={selectLead}
                onUnassign={unassignLead}
                canReassign={isAdmin}
              />
            </>
          )}
        </div>

        {/* SPALTE 2 — Persoenlich */}
        <div className={`${
          mobileTab === "mine" ? "flex" : "hidden md:flex"
        } md:w-72 w-full flex-col rounded-lg border border-border bg-card overflow-hidden shrink-0`}>
          {currentUserId && (
            <PersonalColumn
              contacts={contacts}
              selectedId={selectedLeadId}
              onSelect={selectLead}
              viewedUserId={viewedPersonId || currentUserId}
              setViewedUserId={setViewedPersonId}
              currentUserId={currentUserId}
              isAdmin={isAdmin}
              salesPeople={salesPeople}
              onAssign={assignLead}
            />
          )}
        </div>

        {/* DETAIL — Rest des Bildschirms */}
        <div className={`${
          mobileTab === "detail" ? "flex" : "hidden md:flex"
        } flex-1 min-w-0 rounded-lg border border-border bg-card overflow-hidden`}>
          {selectedLeadId ? (
            <div className="w-full overflow-y-auto p-4">
              <LeadEditor contactId={selectedLeadId} onClose={closeDetail} />
            </div>
          ) : (
            <DetailEmptyState />
          )}
        </div>
      </div>

      {ConfirmModalElement}
      {/* Loading-Indikator als unauffaelliger Hinweis */}
      {loading && <p className="text-xs text-muted-foreground text-center">Lade…</p>}
    </div>
  );
}

function MobileTabBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 h-8 rounded-md text-xs font-medium transition-colors ${
        active ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

function DetailEmptyState() {
  return (
    <div className="w-full flex items-center justify-center text-center text-muted-foreground p-8">
      <div className="space-y-2">
        <p className="text-sm">Kein Lead ausgewählt.</p>
        <p className="text-xs opacity-70">Klick einen Lead links an um Details zu sehen.</p>
      </div>
    </div>
  );
}

// ------------------ KPI-Cards ------------------

function StatCards({ counts, contacts }: { counts: Counts; contacts: VertriebContact[] }) {
  const aktive = counts.step_1 + counts.step_2 + counts.step_3 + counts.step_4;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const in30 = new Date(today); in30.setDate(today.getDate() + 30);
  const events30 = contacts.filter((c) => {
    if (c.status === "abgesagt" || c.status === "gewonnen") return false;
    const ed = parseEventStart(c);
    return !!ed && ed >= today && ed <= in30;
  }).length;

  const closed = counts.gewonnen + counts.abgesagt;
  const winRate = closed > 0 ? Math.round((counts.gewonnen / closed) * 100) : null;

  return (
    <>
      <KpiCard icon={TrendingUp} tone="blue" label="Aktive Pipeline" value={aktive} sub="Leads in Bearbeitung" />
      <KpiCard icon={PartyPopper} tone="purple" label="Events nächste 30 Tage" value={events30} sub="anstehend" />
      <KpiCard
        icon={Trophy}
        tone="green"
        label="Win-Rate"
        value={winRate !== null ? `${winRate}%` : "—"}
        sub={closed > 0 ? `${counts.gewonnen} von ${closed} abgeschlossen` : "noch keine abgeschlossen"}
      />
    </>
  );
}

function KpiCard({ icon: Icon, tone, label, value, sub }: {
  icon: typeof TrendingUp;
  tone: "blue" | "purple" | "green";
  label: string;
  value: number | string;
  sub: string;
}) {
  const toneClass = tone === "blue"
    ? "bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-400"
    : tone === "purple"
      ? "bg-purple-50 dark:bg-purple-500/15 text-purple-600 dark:text-purple-400"
      : "bg-green-50 dark:bg-green-500/15 text-green-600 dark:text-green-400";
  return (
    <Card className="bg-card">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${toneClass}`}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold leading-none mt-1.5 tabular-nums">{value}</p>
            <p className="text-[11px] text-muted-foreground mt-1">{sub}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
