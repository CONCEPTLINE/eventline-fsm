"use client";

/**
 * /projekte/[id] -- Projekt-Detail als Tab-Layout (Audit Thema 1).
 *
 * Layout analog zum Auftrag-Detail:
 *   - Sticky-Header mit Nummer + Titel + Status + Meta + Actions + Tab-Nav
 *   - 3 Tabs (URL-Param ?tab=uebersicht|zeit|dokumente):
 *       Uebersicht      -- Team+Budget, Info (Ziel/Notizen), Termine
 *       Zeit & Stempel  -- Stempel-Widget, geplant vs Ist, Zeit-Eintraege
 *       Dokumente & Historie -- Dokumente, Genehmigungs-Kommentar (EINMAL!),
 *                         Storno/Abschluss, Audit-Historie
 *   - Default-Tab je nach Rolle: Admin/Teamleiter -> uebersicht, sonst zeit
 *   - Action-Bar bleibt unten sticky, Modals werden hier zentral gemountet
 *
 * Der Genehmigungs-Kommentar (project.decision_note) wurde frueher parallel
 * in BudgetCard und HistoryCard gerendert. BudgetCard war seit dem
 * TeamBudgetPanel-Refactor toter Code, blieb aber als Datei bestehen. Mit
 * diesem Refactor ist BudgetCard komplett weg -- der Kommentar erscheint
 * jetzt genau einmal, im Historie-Tab.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { BackButton } from "@/components/ui/back-button";
import { Loading } from "@/components/ui/spinner";
import { useConfirm } from "@/components/ui/use-confirm";
import {
  CheckCircle2, XCircle, Loader2, Trash2, Edit3, Ban, ArrowLeft, ArrowRight,
  Send, LayoutGrid, Clock, FolderOpen, MoreVertical,
} from "lucide-react";
import { toast } from "sonner";
import { PROJECT_STATUS_LABEL, formatProjectNumber, progressPct } from "@/lib/projekte-format";
import { TabsNav } from "@/components/ui/tabs-nav";
import { OverviewTab } from "@/components/projekt/tabs/overview-tab";
import { ZeitTab } from "@/components/projekt/tabs/zeit-tab";
import { DocsHistoryTab } from "@/components/projekt/tabs/docs-history-tab";
import {
  DecisionModal, CancelModal, CloseModal, AppointmentModal, AppointmentNotesModal,
} from "@/components/projekt/modals";
import type {
  Appointment, AppointmentParticipant, AuditEntry, Child, Member, Project, TimeEntry,
} from "@/components/projekt/types";
import { useBreadcrumbs } from "@/components/shell/breadcrumbs";

type Tab = "uebersicht" | "zeit" | "dokumente";
const ALL_TABS: Tab[] = ["uebersicht", "zeit", "dokumente"];

export default function ProjektDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const supabase = createClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can, role } = usePermissions();
  // "isAdmin" = wer Projekt-Anfragen genehmigt, Budget setzt, Projekte
  // storniert/abschliesst/loescht. Semantisch das gleiche wie
  // "Teamlead" — beide durften vorher via hardcoded Role-Slug alles;
  // jetzt via projekte:approve (Admin passt automatisch durch).
  const isAdmin = can("projekte:approve");
  const isTeamlead = isAdmin;
  const { confirm, ConfirmModalElement } = useConfirm();

  const [project, setProject] = useState<Project | null>(null);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [children, setChildren] = useState<Child[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [decisionOpen, setDecisionOpen] = useState<"approve" | "reject" | "edit-budget" | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [apptOpen, setApptOpen] = useState<Appointment | "new" | null>(null);
  const [notesModalAppt, setNotesModalAppt] = useState<Appointment | null>(null);
  // Overflow-Menu fuer destruktive Aktionen (Stornieren). Halten wir hier
  // damit Klick-ausserhalb + Esc-close in einem Effect gebuendelt sind.
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!overflowOpen) return;
    function onOutside(e: MouseEvent) {
      if (!overflowRef.current) return;
      if (!overflowRef.current.contains(e.target as Node)) setOverflowOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOverflowOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [overflowOpen]);

  // Tab-State: URL zuerst, sonst Default per Rolle. Rollen-Default greift
  // erst wenn `role` gesetzt ist -- sonst gewinnt kurz "zeit" fuer Admins.
  const urlTab = searchParams.get("tab") as Tab | null;
  const [tab, setTab] = useState<Tab>(
    urlTab && ALL_TABS.includes(urlTab) ? urlTab : "uebersicht",
  );

  useEffect(() => {
    if (urlTab && ALL_TABS.includes(urlTab)) {
      if (urlTab !== tab) setTab(urlTab);
      return;
    }
    // Kein URL-Tab -> Rollen-Default sobald role geladen ist.
    if (!role) return;
    const def: Tab = isTeamlead ? "uebersicht" : "zeit";
    if (def !== tab) setTab(def);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTab, role]);

  function selectTab(t: Tab) {
    setTab(t);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", t);
      window.history.replaceState({}, "", url.toString());
    }
  }

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    setMe(user?.id ?? null);
    const { data: p } = await supabase
      .from("projects")
      .select(`
        *,
        assignee:profiles!projects_assigned_to_fkey(full_name),
        approver:profiles!projects_approved_by_fkey(full_name),
        parent:parent_project_id(id, project_number, title)
      `)
      .eq("id", projectId)
      .maybeSingle();
    if (p) {
      setProject({
        ...p,
        assignee: Array.isArray(p.assignee) ? p.assignee[0] : p.assignee,
        approver: Array.isArray(p.approver) ? p.approver[0] : p.approver,
        parent: Array.isArray(p.parent) ? p.parent[0] : p.parent,
      } as Project);
    }
    const [entriesRes, apptsRes, childrenRes, membersRes, auditRes] = await Promise.all([
      // Konsolidierung Migration 212: Projekt-Stempel liegen jetzt in
      // time_entries (Spalte project_id). entry_date + minutes werden nicht
      // mehr gespeichert, sondern aus clock_in / clock_out abgeleitet
      // (siehe .map() unten). Damit die Tab-Sub-Components (Overview / Zeit)
      // unveraendert bleiben, behaelt das TimeEntry-Interface entry_date +
      // minutes als abgeleitete Felder.
      supabase
        .from("time_entries")
        .select("id, clock_in, clock_out, description, user_id, created_at, user:profiles(full_name)")
        .eq("project_id", projectId)
        .order("clock_in", { ascending: false })
        .order("created_at", { ascending: false }),
      supabase
        .from("project_appointments")
        .select("id, title, description, start_time, end_time, assigned_to, assignee:profiles!project_appointments_assigned_to_fkey(full_name)")
        .eq("project_id", projectId)
        .order("start_time", { ascending: true }),
      supabase
        .from("projects")
        .select("id, project_number, title, status")
        .eq("parent_project_id", projectId)
        .eq("is_deleted", false)
        .order("created_at", { ascending: true }),
      supabase
        .from("project_members")
        .select("user_id, joined_at, member:profiles!project_members_user_id_fkey(full_name, role)")
        .eq("project_id", projectId)
        .order("joined_at", { ascending: true }),
      supabase
        .from("project_audit")
        .select("id, kind, old_value, new_value, reason, created_at, changer:profiles!project_audit_changed_by_fkey(full_name)")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false }),
    ]);
    // entry_date + minutes hier ableiten: entry_date = lokaler Tag (ZRH)
    // des clock_in im ISO-Format YYYY-MM-DD (sv-SE liefert genau das);
    // minutes = ceil((clock_out - clock_in) / 60000). Offene Stempel
    // (clock_out=null) => minutes=null, damit Consumer wie TimeEntriesCard
    // "Laeuft ..." rendern statt "0.00 h".
    const zrhDateFmt = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit",
    });
    setEntries((entriesRes.data ?? []).map((e) => {
      const user = Array.isArray(e.user) ? e.user[0] : e.user;
      const clockInMs = e.clock_in ? new Date(e.clock_in).getTime() : null;
      const clockOutMs = e.clock_out ? new Date(e.clock_out).getTime() : null;
      const minutes = clockInMs != null && clockOutMs != null
        ? Math.max(1, Math.ceil((clockOutMs - clockInMs) / 60000))
        : null;
      const entry_date = e.clock_in
        ? zrhDateFmt.format(new Date(e.clock_in))
        : zrhDateFmt.format(new Date(e.created_at));
      return { ...e, user, entry_date, minutes };
    }) as TimeEntry[]);

    // Termine + Teilnehmer + Notiz-Count in einem Rutsch.
    const apptsBase = (apptsRes.data ?? []).map((a) => ({
      ...a,
      assignee: Array.isArray(a.assignee) ? a.assignee[0] : a.assignee,
    })) as Array<Omit<Appointment, "participants" | "notesCount">>;
    const apptIds = apptsBase.map((a) => a.id);
    const participantsByAppt = new Map<string, AppointmentParticipant[]>();
    const notesCountByAppt = new Map<string, number>();
    if (apptIds.length > 0) {
      const [partsRes, notesRes] = await Promise.all([
        supabase
          .from("project_appointment_participants")
          .select("id, appointment_id, profile_id, customer_id, profile:profile_id(full_name), customer:customer_id(name)")
          .in("appointment_id", apptIds),
        supabase
          .from("project_appointment_notes")
          .select("appointment_id")
          .in("appointment_id", apptIds),
      ]);
      for (const rp of (partsRes.data ?? []) as Array<{
        id: string;
        appointment_id: string;
        profile_id: string | null;
        customer_id: string | null;
        profile: { full_name: string | null } | { full_name: string | null }[] | null;
        customer: { name: string | null } | { name: string | null }[] | null;
      }>) {
        const prof = Array.isArray(rp.profile) ? rp.profile[0] : rp.profile;
        const cust = Array.isArray(rp.customer) ? rp.customer[0] : rp.customer;
        const name = prof?.full_name ?? cust?.name ?? "?";
        const list = participantsByAppt.get(rp.appointment_id) ?? [];
        list.push({ id: rp.id, profile_id: rp.profile_id, customer_id: rp.customer_id, name });
        participantsByAppt.set(rp.appointment_id, list);
      }
      for (const n of (notesRes.data ?? []) as Array<{ appointment_id: string }>) {
        notesCountByAppt.set(n.appointment_id, (notesCountByAppt.get(n.appointment_id) ?? 0) + 1);
      }
    }
    setAppts(apptsBase.map((a) => ({
      ...a,
      participants: participantsByAppt.get(a.id) ?? [],
      notesCount: notesCountByAppt.get(a.id) ?? 0,
    })));
    setChildren((childrenRes.data ?? []) as Child[]);

    // Members inkl. Stundenlohn fuer Kosten-Prognose (Admin).
    const memberList = (membersRes.data ?? []).map((m) => ({
      user_id: m.user_id as string,
      joined_at: m.joined_at as string,
      member: Array.isArray(m.member) ? m.member[0] : m.member,
    }));
    const uids = memberList.map((m) => m.user_id);
    const wageMap = new Map<string, number>();
    if (uids.length > 0) {
      const { data: comps } = await supabase
        .from("employee_compensation")
        .select("profile_id, hourly_wage_chf")
        .in("profile_id", uids)
        .is("effective_to", null);
      for (const c of comps ?? []) wageMap.set(c.profile_id as string, Number(c.hourly_wage_chf));
    }
    setMembers(memberList.map((m) => {
      const mem = m.member as { full_name: string | null; role: string | null } | null;
      return {
        user_id: m.user_id,
        joined_at: m.joined_at,
        full_name: mem?.full_name ?? null,
        role: mem?.role ?? null,
        hourly_wage_chf: wageMap.get(m.user_id) ?? null,
      };
    }));
    setAudit((auditRes.data ?? []).map((a) => ({ ...a, changer: Array.isArray(a.changer) ? a.changer[0] : a.changer })) as AuditEntry[]);
    setLoading(false);
  }, [supabase, projectId]);

  useEffect(() => { load(); }, [load]);

  // Globale Breadcrumbs: "Projekte › PROJ-XX · Titel".
  useBreadcrumbs(
    project
      ? [
          { label: "Projekte", href: "/projekte" },
          {
            label: `${formatProjectNumber(project.project_number)}${
              project.title ? ` · ${project.title}` : ""
            }`,
          },
        ]
      : [],
  );

  if (loading) return <Loading />;
  if (!project) return <div className="text-sm text-muted-foreground">Projekt nicht gefunden.</div>;

  const status = PROJECT_STATUS_LABEL[project.status];
  const usedMin = entries.reduce((a, e) => a + (e.minutes ?? 0), 0);
  const openEntry = entries.find((e) => e.clock_in && !e.clock_out && e.user_id === me);
  const pct = progressPct(usedMin, project.budget_hours);
  const isMember = !!me && members.some((m) => m.user_id === me);
  const canStamp = isMember && project.status === "genehmigt";
  const canJoin = !isMember && !!me && project.status === "genehmigt";
  const canApprove = isAdmin && project.status === "angefragt";
  const canClose = isAdmin && project.status === "genehmigt";
  const canSubmitDraft = project.status === "entwurf" && (me === project.assigned_to || me === project.created_by);
  const isArchived = project.status === "storniert" || project.status === "abgeschlossen" || project.status === "abgelehnt";
  const canCancel = !isArchived && (isAdmin || me === project.assigned_to || me === project.created_by);
  // Inhaltlich bearbeiten darf, wer auf dem Projekt eingeloggt ist (Mitglied,
  // der "Einloggen"-Button vor dem Stempeln) — plus Projektleiter/Ersteller/
  // Admin (Leo 2026-09-17, RLS-Gegenstueck: Migration 230). Statusaktionen
  // (genehmigen/abschliessen/stornieren/loeschen) bleiben oben enger gegated.
  const canEditText = !isArchived && (isAdmin || me === project.assigned_to || me === project.created_by || isMember);
  const canAddAppt = canEditText;
  void canStamp;

  async function deleteProject() {
    const ok = await confirm({
      title: "Projekt löschen?",
      message: "Das Projekt wird als gelöscht markiert. Zeit-Einträge bleiben in der Historie erhalten.",
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    const { error } = await supabase.from("projects").update({ is_deleted: true }).eq("id", projectId);
    if (error) { toast.error("Löschen fehlgeschlagen: " + error.message); return; }
    toast.success("Projekt gelöscht");
    router.push("/projekte");
  }

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: "uebersicht", label: "Übersicht",          icon: <LayoutGrid className="h-4 w-4" /> },
    { key: "zeit",       label: "Zeit & Stempel",      icon: <Clock className="h-4 w-4" /> },
    { key: "dokumente",  label: "Dokumente & Historie", icon: <FolderOpen className="h-4 w-4" /> },
  ];

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      {/* Sticky Header: Nummer, Titel, Status, Meta, Tab-Nav.
          Optik 1:1 wie Auftrag-Detail (src/components/auftrag/tabs/sticky-header.tsx):
          kein Kasten-Look, kein -mx-Bleed, kein border-b — BG matcht den Body-Grau
          (#f5f5f7 light / #0a0a0a dark). Die visuelle Trennung zum Body macht
          die TabsNav-eigene border-b, nicht der Wrapper. */}
      <div className="sticky top-0 z-20 bg-[#f5f5f7]/85 dark:bg-[#0a0a0a]/85 backdrop-blur-md pt-1 pb-4 mb-8">
        <div className="flex items-start gap-2">
          <BackButton fallbackHref="/projekte" size="sm" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-foreground/[0.06] text-[11px] font-mono font-semibold tabular-nums">
                {formatProjectNumber(project.project_number)}
              </span>
              <h1 className="text-xl font-semibold truncate">{project.title}</h1>
              <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded-full ${status.color}`}>
                {status.label}
              </span>
              {project.completion_success === true && (
                <span className="inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300">
                  Erfolgreich
                </span>
              )}
              {project.completion_success === false && (
                <span className="inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300">
                  Nicht erfolgreich
                </span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {project.assignee?.full_name ?? "—"} · angelegt {new Date(project.created_at).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}
              {project.goal_date && (
                <> · Deadline {new Date(project.goal_date + "T12:00:00").toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}</>
              )}
              {project.parent && (
                <> · <ArrowLeft className="inline h-3 w-3" /> aus <Link href={`/projekte/${project.parent.id}`} className="underline hover:text-foreground">{formatProjectNumber(project.parent.project_number)}</Link></>
              )}
            </p>
          </div>
          {isAdmin && (
            <button onClick={deleteProject} className="kasten kasten-muted" data-tooltip="Projekt löschen" aria-label="Projekt löschen">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Tab-Nav */}
        <TabsNav
          tabs={tabs}
          active={tab}
          onChange={(k) => selectTab(k as Tab)}
          className="mt-3"
          ariaLabel="Projekt-Bereiche"
        />
      </div>

      {/* Tab-Inhalt */}
      {tab === "uebersicht" && (
        <OverviewTab
          project={project}
          members={members}
          entries={entries}
          appts={appts}
          openEntry={openEntry ?? null}
          me={me}
          isMember={isMember}
          isAdmin={isAdmin}
          canJoin={canJoin}
          canEdit={canEditText}
          canAddAppt={canAddAppt}
          usedMin={usedMin}
          pct={pct}
          onReload={load}
          onOpenAppt={setApptOpen}
          onOpenApptNotes={setNotesModalAppt}
        />
      )}
      {tab === "zeit" && (
        <ZeitTab
          project={project}
          entries={entries}
          openEntry={openEntry ?? null}
          me={me}
          isMember={isMember}
          isAdmin={isAdmin}
          canJoin={canJoin}
          usedMin={usedMin}
          pct={pct}
          onReload={load}
        />
      )}
      {tab === "dokumente" && (
        <DocsHistoryTab
          project={project}
          children_={children}
          audit={audit}
          isAdmin={isAdmin}
          canEdit={canEditText}
        />
      )}

      {/* Sticky Action-Bar unten.
          Visuelle Grammatik (Audit Thema 5, Regel 1):
          - EINE Primaer-Aktion pro Screen (kasten-blue/-green).
          - Positive Aktionen wie Einreichen/Genehmigen/Abschliessen sind
            blau bzw. gruen; rot ausschliesslich fuer echte destruktive
            Aktionen (Ablehnen einer Genehmigungsanfrage, Stornieren).
          - Stornieren wandert in ein Overflow-Menu (MoreVertical), sonst
            liegen zwei rote Buttons parallel zu einer positiven Aktion. */}
      {(canApprove || canClose || canCancel || canSubmitDraft) && (
        <div className="sticky bottom-2 z-10 bg-card border rounded-xl p-2 flex gap-2 flex-wrap shadow-sm">
          <div className="text-[10px] text-muted-foreground/70 self-center px-1">Aktionen:</div>
          {canSubmitDraft && (
            <button
              onClick={async () => {
                const { error } = await supabase.from("projects").update({ status: "angefragt" }).eq("id", project.id);
                if (error) { toast.error("Einreichen fehlgeschlagen: " + error.message); return; }
                toast.success("Zur Genehmigung eingereicht");
                load();
              }}
              className="kasten kasten-blue"
            >
              <Send className="h-3.5 w-3.5" /> Einreichen
            </button>
          )}
          {canApprove && (
            <>
              <button onClick={() => setDecisionOpen("approve")} className="kasten kasten-green">
                <CheckCircle2 className="h-3.5 w-3.5" /> Genehmigen
              </button>
              <button onClick={() => setDecisionOpen("reject")} className="kasten kasten-red">
                <XCircle className="h-3.5 w-3.5" /> Ablehnen
              </button>
            </>
          )}
          {canClose && (
            <>
              <button onClick={() => setDecisionOpen("edit-budget")} className="kasten kasten-muted">
                <Edit3 className="h-3.5 w-3.5" /> Budget
              </button>
              <button onClick={() => setCloseOpen(true)} className="kasten kasten-blue">
                <CheckCircle2 className="h-3.5 w-3.5" /> Abschliessen
              </button>
            </>
          )}
          {canCancel && (
            <div className="relative ml-auto" ref={overflowRef}>
              <button
                type="button"
                onClick={() => setOverflowOpen(!overflowOpen)}
                className={`kasten ${overflowOpen ? "kasten-active" : "kasten-muted"}`}
                data-tooltip="Weitere Aktionen"
                data-tooltip-align="end"
                aria-expanded={overflowOpen}
                aria-haspopup="menu"
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
              {overflowOpen && (
                <div
                  role="menu"
                  className="absolute right-0 bottom-[calc(100%+6px)] z-40 min-w-[180px] rounded-xl border border-border bg-card shadow-lg p-1"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOverflowOpen(false);
                      setCancelOpen(true);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
                  >
                    <Ban className="h-4 w-4" />
                    Stornieren
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Folgeprojekt-Button bei abgeschlossenen */}
      {isArchived && (isAdmin || me === project.assigned_to || me === project.created_by) && (
        <div className="flex justify-center">
          <button
            onClick={() => router.push(`/projekte/neu?parent=${project.id}`)}
            className="kasten kasten-purple"
          >
            <ArrowRight className="h-3.5 w-3.5" /> Folgeprojekt erstellen
          </button>
        </div>
      )}

      {decisionOpen && <DecisionModal mode={decisionOpen} project={project} onClose={() => setDecisionOpen(null)} onDone={() => { setDecisionOpen(null); load(); }} />}
      {cancelOpen && <CancelModal projectId={project.id} onClose={() => setCancelOpen(false)} onDone={() => { setCancelOpen(false); load(); }} />}
      {closeOpen && <CloseModal projectId={project.id} onClose={() => setCloseOpen(false)} onDone={() => { setCloseOpen(false); load(); }} />}
      {apptOpen && (
        <AppointmentModal
          projectId={project.id}
          initial={apptOpen === "new" ? null : apptOpen}
          onClose={() => setApptOpen(null)}
          onDone={() => { setApptOpen(null); load(); }}
        />
      )}
      {notesModalAppt && (
        <AppointmentNotesModal
          appointmentId={notesModalAppt.id}
          appointmentTitle={notesModalAppt.title}
          me={me}
          isAdmin={isAdmin}
          onClose={() => setNotesModalAppt(null)}
          onChanged={load}
        />
      )}
      {ConfirmModalElement}
    </div>
  );
}
