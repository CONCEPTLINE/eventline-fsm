"use client";

/**
 * Todos-Seite — Redesign (2026-09).
 *
 * Iteration 2 (Filter drastisch reduziert):
 *  Vorher hatte die Seite 7+ Filter-Elemente (Scope×Zeit×Status×Prio +
 *  Personen-Select + Suche + Dringend-Toggle) — Leo: "das ueberfordert
 *  den User". Jetzt nur noch: EIN Scope-Segment (Fuer mich / Delegiert
 *  [/ Alle wenn canSeeAll]) + Suche + "Erledigte anzeigen"-Toggle.
 *
 *  Weitere Details:
 *   - Immer-sichtbares Quick-Add unter der Filter-Leiste, Enter=Speichern
 *     (per onKeyDown im Input — der globale useEnterAsTab-Hook wuerde
 *     sonst zum naechsten Chip springen).
 *   - Zeilen mit Checkbox links, inline-editierbaren Chips (Faellig,
 *     Assignee) und Ellipsis-Menue (Snooze morgen/naechste Woche,
 *     Erinnern, Loeschen).
 *   - Gruppierung nach Zeit (Ueberfaellig / Heute / Morgen / Diese Woche /
 *     Spaeter / Ohne Datum), einklappbar (localStorage).
 *   - Filter-State via URL-Query + localStorage v2 (v1 tolerant ignoriert).
 *
 *  Geloeschte Todos werden nirgends mehr angezeigt (soft-delete bleibt fuer
 *  Recovery via DB durch Admin) — der "Geloescht"-View ist weg.
 *
 *  Backend unangetastet.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { toast } from "sonner";
import { Plus, Loader2, ChevronDown, CheckSquare } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { useConfirm } from "@/components/ui/use-confirm";
import { BackButton } from "@/components/ui/back-button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchableSelect } from "@/components/searchable-select";
import { TOAST } from "@/lib/messages";
import {
  buildTodosQuery, loadScopeCounts,
  type TodoScope,
} from "@/lib/todos-query";
import { bucketForDue, GROUP_LABEL, GROUP_ORDER, type GroupBucket } from "@/lib/relative-date";
import { TodoFilters, type FilterState } from "@/components/todos/todo-filters";
import { QuickAdd } from "@/components/todos/quick-add";
import { TodoRow, type TodoRowData } from "@/components/todos/todo-row";
import { TodoGroupHeader } from "@/components/todos/todo-group-header";
import { TodoDetail } from "@/components/todos/todo-detail";
import type { Profile, Todo, JobPriority } from "@/types";

const PAGE_SIZE = 50;
// v2 nach Filter-Reduktion 2026-09 — alte v1-Keys (status/time/urgent/…)
// werden bewusst ignoriert und nicht migriert.
const LS_KEY = "todos-filters-v2";
const LS_COLLAPSE = "todos-groups-collapsed-v1";

/* -------------------------------------------------------------------------
   URL/LocalStorage-Persistenz-Helper
   ------------------------------------------------------------------------- */

const DEFAULT_STATE: FilterState = {
  scope: "mine",
  showCompleted: false,
  search: "",
};

const VALID_SCOPES: TodoScope[] = ["mine", "delegated", "all"];

function readInitialState(url: URLSearchParams): FilterState {
  const fromLs = (() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as Partial<FilterState>;
    } catch { return null; }
  })();
  // URL wins ueber LS (teilbarer Link soll gewinnen).
  const rawScope = (url.get("scope") ?? fromLs?.scope ?? DEFAULT_STATE.scope) as TodoScope;
  const scope = VALID_SCOPES.includes(rawScope) ? rawScope : DEFAULT_STATE.scope;
  const showCompleted =
    url.get("completed") === "1" ? true
    : url.get("completed") === "0" ? false
    : (fromLs?.showCompleted ?? DEFAULT_STATE.showCompleted);
  const search = url.get("q") ?? ""; // Suche NICHT persistieren
  return { scope, showCompleted, search };
}

/* -------------------------------------------------------------------------
   Page
   ------------------------------------------------------------------------- */

export default function TodosPage() {
  const supabase = createClient();
  const router = useRouter();
  const pathname = usePathname();
  const { can, profile } = usePermissions();
  const canView = can("todos:view");
  const canCreate = can("todos:create");
  const canSeeAll = can("todos:see-all");
  const canRemind = can("todos:edit-all");
  const { confirm, ConfirmModalElement } = useConfirm();

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [todos, setTodos] = useState<TodoRowData[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [counts, setCounts] = useState({ mine: 0, delegated: 0, all: 0 });
  const [reminded, setReminded] = useState<Set<string>>(new Set());
  const [selectedTodo, setSelectedTodo] = useState<TodoRowData | null>(null);
  const [showFullForm, setShowFullForm] = useState(false);
  const [detailForm, setDetailForm] = useState({ title: "", description: "", urgent: false, due_date: "", assigned_to: "" });
  const [submitting, setSubmitting] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return {};
    try { return JSON.parse(localStorage.getItem(LS_COLLAPSE) ?? "{}"); } catch { return {}; }
  });

  const [state, setState] = useState<FilterState>(() =>
    readInitialState(new URLSearchParams(typeof window !== "undefined" ? window.location.search : "")),
  );

  const meId = profile?.id ?? "";
  const meName = profile?.full_name ?? "";

  /* --- URL + LS Persistenz ----------------------------------------------- */
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const toStore: Partial<FilterState> = { ...state, search: "" }; // Suche nicht persistieren
      localStorage.setItem(LS_KEY, JSON.stringify(toStore));
    } catch { /* localStorage voll o.ae. — ignorieren */ }

    // URL sanft aktualisieren (kein Reload, kein History-Entry pro Klick):
    // wir nutzen replace damit Vor-/Zurueck-Knopf nicht dutzende Filter-
    // Zwischenstaende speichert.
    const sp = new URLSearchParams();
    if (state.scope !== DEFAULT_STATE.scope) sp.set("scope", state.scope);
    if (state.showCompleted) sp.set("completed", "1");
    if (state.search) sp.set("q", state.search);
    const qs = sp.toString();
    const target = qs ? `${pathname}?${qs}` : pathname;
    router.replace(target, { scroll: false });
    // NICHT state in Deps von searchParams — sonst Loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, pathname]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try { localStorage.setItem(LS_COLLAPSE, JSON.stringify(collapsed)); } catch {}
  }, [collapsed]);

  /* --- Profiles laden ---------------------------------------------------- */
  useEffect(() => {
    supabase.from("profiles")
      .select("id, full_name, role, is_active, email")
      .eq("is_active", true).neq("role", "partner").neq("role", "lieferant")
      .order("full_name")
      .then(({ data }) => { if (data) setProfiles(data as Profile[]); });
  }, [supabase]);

  /* --- Counts + Liste laden --------------------------------------------- */
  const refreshCounts = useCallback(async () => {
    if (!meId) return;
    const c = await loadScopeCounts(supabase, meId, canSeeAll);
    setCounts(c);
  }, [supabase, meId, canSeeAll]);

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryIdRef = useRef(0);

  const loadTodos = useCallback(async () => {
    if (!meId) return;
    const myId = ++queryIdRef.current;
    setLoading(true);
    const { data, error } = await buildTodosQuery(supabase, {
      ...state,
      userId: meId,
    }, null, PAGE_SIZE + 1);
    if (myId !== queryIdRef.current) return;
    if (error) {
      toast.error("Todos konnten nicht geladen werden: " + error.message);
      setTodos([]);
      setHasMore(false);
    } else if (data) {
      const rows = data as unknown as TodoRowData[];
      setHasMore(rows.length > PAGE_SIZE);
      setTodos(rows.slice(0, PAGE_SIZE));
    }
    setLoading(false);
  }, [supabase, state, meId]);

  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => { loadTodos(); }, 250);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [loadTodos]);

  useEffect(() => { refreshCounts(); }, [refreshCounts]);

  async function loadMore() {
    if (loadingMore || todos.length === 0 || !meId) return;
    setLoadingMore(true);
    const last = todos[todos.length - 1];
    const { data } = await buildTodosQuery(supabase, {
      ...state,
      userId: meId,
    }, { id: last.id }, PAGE_SIZE + 1);
    if (data) {
      const rows = data as unknown as TodoRowData[];
      setHasMore(rows.length > PAGE_SIZE);
      setTodos((prev) => [...prev, ...rows.slice(0, PAGE_SIZE)]);
    }
    setLoadingMore(false);
  }

  /* --- Mutationen ------------------------------------------------------- */

  async function createTodo(payload: { title: string; description?: string | null; dueDate: string | null; assignedTo: string; urgent: boolean }) {
    const priority: JobPriority = payload.urgent ? "dringend" : "normal";
    const { data: { user } } = await supabase.auth.getUser();
    const { error: insertErr } = await supabase.from("todos").insert({
      title: payload.title,
      description: payload.description ?? null,
      priority,
      due_date: payload.dueDate,
      assigned_to: payload.assignedTo,
      created_by: user?.id,
    });
    if (insertErr) {
      TOAST.createError(insertErr.message);
      return;
    }
    // Nur benachrichtigen wenn ein Fremder der Assignee ist — sich selber
    // benachrichtigen ist redundant + laesst die Bell dauernd blinken.
    if (payload.assignedTo && payload.assignedTo !== user?.id) {
      const { data: creator } = await supabase.from("profiles").select("full_name").eq("id", user?.id).single();
      const dueText = payload.dueDate
        ? (() => { const [y,m,d] = payload.dueDate!.split("-").map(Number); return new Date(Date.UTC(y, m-1, d, 12)).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" }); })()
        : null;
      await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userIds: [payload.assignedTo],
          title: priority === "dringend" ? `Dringendes Todo: ${payload.title}` : `Neues Todo: ${payload.title}`,
          message: `Von ${creator?.full_name || "Unbekannt"}${dueText ? ` · Faellig: ${dueText}` : ""}`,
          link: "/todos",
        }),
      });
      if (priority === "dringend") {
        await fetch("/api/todos/urgent-notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            assignedTo: payload.assignedTo,
            title: payload.title,
            description: payload.description ?? null,
            dueDate: payload.dueDate,
            creatorName: creator?.full_name || "Unbekannt",
          }),
        });
      }
    }
    toast.success("Todo erstellt");
    await Promise.all([loadTodos(), refreshCounts()]);
  }

  async function addTodoFullForm(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (!detailForm.title.trim() || !detailForm.due_date || !detailForm.assigned_to) {
      TOAST.createError("Titel, Frist und Zuweisung sind Pflicht");
      return;
    }
    setSubmitting(true);
    try {
      await createTodo({
        title: detailForm.title,
        description: detailForm.description || null,
        dueDate: detailForm.due_date,
        assignedTo: detailForm.assigned_to,
        urgent: detailForm.urgent,
      });
      setDetailForm({ title: "", description: "", urgent: false, due_date: "", assigned_to: "" });
      setShowFullForm(false);
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleTodo(t: TodoRowData) {
    // Optimistic: sofort im Local-State umschalten, dann persistieren.
    const newStatus = t.status === "offen" ? "erledigt" : "offen";
    const completedAt = newStatus === "erledigt" ? new Date().toISOString() : null;
    setTodos((prev) => prev.map((x) => x.id === t.id ? { ...x, status: newStatus as "offen" | "erledigt", completed_at: completedAt } : x));
    if (selectedTodo?.id === t.id) {
      setSelectedTodo({ ...selectedTodo, status: newStatus as "offen" | "erledigt", completed_at: completedAt });
    }
    const { error } = await supabase.from("todos").update({ status: newStatus, completed_at: completedAt }).eq("id", t.id);
    if (error) {
      toast.error("Konnte nicht aktualisiert werden: " + error.message);
      await loadTodos();
      return;
    }
    // Undo-Toast fuer 5 Sekunden — Standard-Task-App-UX. Undo revertet.
    if (newStatus === "erledigt") {
      toast.success("Erledigt", {
        action: {
          label: "Rückgängig",
          onClick: async () => {
            await supabase.from("todos").update({ status: "offen", completed_at: null }).eq("id", t.id);
            await Promise.all([loadTodos(), refreshCounts()]);
          },
        },
        duration: 5000,
      });
    }
    await refreshCounts();
  }

  async function deleteTodo(t: TodoRowData) {
    const ok = await confirm({
      title: "Todo löschen?",
      message: "Das Todo verschwindet aus allen Listen. Wiederherstellung nur über die Datenbank durch einen Admin.",
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from("todos")
      .update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null })
      .eq("id", t.id);
    if (error) { TOAST.deleteError(error.message); return; }
    if (selectedTodo?.id === t.id) setSelectedTodo(null);
    await Promise.all([loadTodos(), refreshCounts()]);
    toast.success("Todo gelöscht");
  }

  async function remindTodo(t: TodoRowData | Todo) {
    if (!t.assigned_to) { toast.error("Kein Empfaenger zugewiesen"); return; }
    if (reminded.has(t.id)) return;
    setReminded((s) => new Set(s).add(t.id));
    const dueText = t.due_date
      ? (() => { const [y,m,d] = t.due_date!.split("-").map(Number); return new Date(Date.UTC(y, m-1, d, 12)).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" }); })()
      : null;
    const res = await fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userIds: [t.assigned_to],
        title: `Erinnerung: ${t.title}`,
        message: dueText ? `Diese Aufgabe ist noch offen. Faellig: ${dueText}` : "Diese Aufgabe ist noch offen.",
        link: "/todos",
      }),
    });
    if (!res.ok) {
      toast.error("Erinnerung konnte nicht gesendet werden");
      setReminded((s) => { const n = new Set(s); n.delete(t.id); return n; });
      return;
    }
    toast.success("Erinnerung gesendet");
    setTimeout(() => {
      setReminded((s) => { const n = new Set(s); n.delete(t.id); return n; });
    }, 30_000);
  }

  async function changeDue(t: TodoRowData, iso: string | null) {
    // Optimistic
    setTodos((prev) => prev.map((x) => x.id === t.id ? { ...x, due_date: iso } : x));
    if (selectedTodo?.id === t.id) setSelectedTodo({ ...selectedTodo, due_date: iso });
    const { error } = await supabase.from("todos").update({ due_date: iso }).eq("id", t.id);
    if (error) {
      toast.error("Faelligkeit konnte nicht gespeichert werden: " + error.message);
      await loadTodos();
      return;
    }
    toast.success(iso ? "Faelligkeit aktualisiert" : "Faelligkeit entfernt");
  }

  async function changeAssignee(t: TodoRowData, assigneeId: string) {
    if (!assigneeId) return;
    const newAssignee = profiles.find((p) => p.id === assigneeId);
    setTodos((prev) => prev.map((x) => x.id === t.id
      ? { ...x, assigned_to: assigneeId, assignee: newAssignee ? { full_name: newAssignee.full_name } : null }
      : x));
    if (selectedTodo?.id === t.id) {
      setSelectedTodo({
        ...selectedTodo,
        assigned_to: assigneeId,
        assignee: newAssignee ? { full_name: newAssignee.full_name } : null,
      });
    }
    const { error } = await supabase.from("todos").update({ assigned_to: assigneeId }).eq("id", t.id);
    if (error) {
      toast.error("Zuweisung konnte nicht gespeichert werden: " + error.message);
      await loadTodos();
      return;
    }
    toast.success("Zugewiesen an " + (newAssignee?.full_name ?? "?"));
    await refreshCounts();
  }

  /* --- Detail-Handler --------------------------------------------------- */

  async function detailToggle() {
    if (!selectedTodo) return;
    await toggleTodo(selectedTodo);
  }
  async function detailDelete() {
    if (!selectedTodo) return;
    await deleteTodo(selectedTodo);
  }
  async function detailRemind() {
    if (!selectedTodo) return;
    await remindTodo(selectedTodo);
  }

  /* --- Gruppierung ------------------------------------------------------ */

  const grouped = useMemo(() => {
    const buckets = new Map<GroupBucket, TodoRowData[]>();
    for (const t of todos) {
      const b = bucketForDue(t.due_date);
      const list = buckets.get(b) ?? [];
      list.push(t);
      buckets.set(b, list);
    }
    // Reihenfolge fix laut GROUP_ORDER
    return GROUP_ORDER.map((b) => ({ bucket: b, rows: buckets.get(b) ?? [] })).filter((g) => g.rows.length > 0);
  }, [todos]);

  /* --- Rendering -------------------------------------------------------- */

  if (!canView) {
    return (
      <div className="max-w-md mx-auto py-16">
        <EmptyState icon={CheckSquare} title="Kein Zugriff auf Aufgaben" description="Deine Rolle hat die Berechtigung 'todos:view' nicht." />
      </div>
    );
  }

  if (selectedTodo) {
    const canEditDetail = selectedTodo.created_by === meId || selectedTodo.assigned_to === meId || canSeeAll;
    return (
      <TodoDetail
        supabase={supabase}
        todo={selectedTodo}
        profiles={profiles}
        canEdit={canEditDetail}
        canRemind={canRemind}
        reminded={reminded.has(selectedTodo.id)}
        onBack={() => setSelectedTodo(null)}
        onToggleComplete={detailToggle}
        onDelete={detailDelete}
        onRemind={detailRemind}
        onDueChange={(iso) => changeDue(selectedTodo as TodoRowData, iso)}
        onAssigneeChange={(id) => changeAssignee(selectedTodo as TodoRowData, id)}
        onAttachmentsChanged={() => loadTodos()}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3 min-h-9">
        <div className="flex items-center gap-4">
          <BackButton fallbackHref="/dashboard" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Aufgaben</h1>
            <p className="text-xs text-muted-foreground/70 mt-1">
              Was heute an dich delegiert ist — Wartung siehe{" "}
              <Link href="/standorte" className="underline hover:text-foreground transition-colors">Standorte</Link>.
            </p>
          </div>
        </div>
        {canCreate && (
          <button
            type="button"
            onClick={() => setShowFullForm((v) => !v)}
            className="kasten-toggle-off"
            data-tooltip="Voll-Formular mit Beschreibung + Anhang-Vorlage"
          >
            <Plus className="h-3.5 w-3.5" />
            Detailliert anlegen
          </button>
        )}
      </div>

      {/* Filter-Leiste */}
      <TodoFilters
        state={state}
        counts={counts}
        canSeeAll={canSeeAll}
        onChange={(patch) => setState((s) => ({ ...s, ...patch }))}
      />

      {/* Quick-Add ist immer sichtbar wenn User erstellen darf. */}
      {canCreate && meId && (
        <QuickAdd
          profiles={profiles}
          meProfileId={meId}
          meProfileName={meName}
          onCreate={async ({ title, dueDate, assignedTo, urgent }) => {
            await createTodo({ title, dueDate, assignedTo, urgent });
          }}
        />
      )}

      {/* Voll-Formular (nur wenn getoggelt) */}
      {showFullForm && canCreate && (
        <Card className="bg-card">
          <CardContent className="p-6">
            <form onSubmit={addTodoFullForm} className="space-y-4">
              <Input placeholder="Was muss erledigt werden? *" value={detailForm.title} onChange={(e) => setDetailForm({ ...detailForm, title: e.target.value })} required />
              <textarea placeholder="Details (optional)" value={detailForm.description} onChange={(e) => setDetailForm({ ...detailForm, description: e.target.value })} className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-card resize-none focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring" rows={2} />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Faellig am *</label>
                  <Input type="date" value={detailForm.due_date} onChange={(e) => setDetailForm({ ...detailForm, due_date: e.target.value })} className="mt-1" required />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Zuweisen an *</label>
                  <div className="mt-1">
                    <SearchableSelect
                      value={detailForm.assigned_to}
                      onChange={(v) => setDetailForm({ ...detailForm, assigned_to: v })}
                      items={profiles.map((p) => ({ id: p.id, label: p.full_name }))}
                      clearable={false}
                      placeholder="Person auswählen ..."
                    />
                  </div>
                </div>
                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={() => setDetailForm({ ...detailForm, urgent: !detailForm.urgent })}
                    className={detailForm.urgent ? "kasten kasten-red w-full" : "kasten kasten-muted w-full"}
                  >
                    {detailForm.urgent ? "Dringend markiert" : "Als dringend markieren"}
                  </button>
                </div>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setShowFullForm(false)} disabled={submitting} className="kasten kasten-muted">Abbrechen</button>
                <button type="submit" disabled={submitting || !detailForm.title.trim() || !detailForm.due_date || !detailForm.assigned_to} className="kasten kasten-blue">
                  {submitting ? "Speichere ..." : "Todo erstellen"}
                </button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Liste */}
      {loading ? (
        <div className="space-y-2">
          {[1,2,3,4].map((i) => (
            <div key={i} className="shimmer rounded-xl h-14" />
          ))}
        </div>
      ) : todos.length === 0 ? (
        <EmptyState
          icon={CheckSquare}
          title={
            state.search ? "Keine Treffer"
            : state.scope === "delegated" ? "Nichts delegiert"
            : "Alles erledigt"
          }
          description={
            !state.search
              ? "Nutze das Feld oben um schnell etwas festzuhalten."
              : undefined
          }
        />
      ) : (
        <div className="space-y-6">
          {grouped.map(({ bucket, rows }) => {
            const label = GROUP_LABEL[bucket];
            const isCollapsed = !!collapsed[bucket];
            return (
              <section key={bucket} className="space-y-2">
                <TodoGroupHeader
                  bucket={bucket}
                  label={label}
                  count={rows.length}
                  collapsed={isCollapsed}
                  onToggle={() => setCollapsed((c) => ({ ...c, [bucket]: !c[bucket] }))}
                />
                {!isCollapsed && (
                  <div className="space-y-2">
                    {rows.map((t) => {
                      const canEditRow = t.created_by === meId || t.assigned_to === meId || canSeeAll;
                      return (
                        <TodoRow
                          key={t.id}
                          todo={t}
                          meId={meId}
                          scope={state.scope}
                          profiles={profiles}
                          canRemind={canRemind}
                          canEditRow={canEditRow}
                          reminded={reminded.has(t.id)}
                          onOpen={(row) => setSelectedTodo(row)}
                          onToggleComplete={toggleTodo}
                          onDueChange={changeDue}
                          onAssigneeChange={changeAssignee}
                          onRemind={remindTodo}
                          onDelete={deleteTodo}
                        />
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}

          {hasMore && (
            <div className="flex justify-center pt-2">
              <button type="button" onClick={loadMore} disabled={loadingMore} className="kasten kasten-muted">
                {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronDown className="h-3.5 w-3.5" />}
                {loadingMore ? "Lade ..." : "Mehr laden"}
              </button>
            </div>
          )}
        </div>
      )}

      {ConfirmModalElement}
    </div>
  );
}
