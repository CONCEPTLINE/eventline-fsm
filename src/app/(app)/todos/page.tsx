"use client";

/**
 * Todos — Liste, server-seitig gefiltert+paginiert (PAGE_SIZE 50).
 * RLS scoped jeden Account auf eigene Todos (created_by oder assigned_to)
 * → kein Personen-Filter noetig, jeder sieht eh nur seine. Layout 1:1 nach
 * /auftraege: Header + Search + Status-Filter + Cards mit auftrag-card-hover.
 * Anhaenge in eigener Tabelle todo_attachments.
 */

import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { deleteRow } from "@/lib/db-mutations";
import { usePermissions } from "@/lib/use-permissions";
import { validateFileSize } from "@/lib/file-upload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import type { Todo, Profile, JobPriority } from "@/types";
import {
  Plus, Check, CheckSquare, Calendar, User, Trash2,
  Upload, FileText, Image as ImageIcon, Download, Eye, Archive, ChevronDown, Search, X, Paperclip, AlertCircle,
} from "lucide-react";
import { PdfPopup } from "@/components/pdf-popup";
import { BackButton } from "@/components/ui/back-button";
import Link from "next/link";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { SearchableSelect } from "@/components/searchable-select";
import { useConfirm } from "@/components/ui/use-confirm";

interface TodoAttachment {
  id: string;
  todo_id: string;
  name: string;
  path: string;
  uploaded_at: string;
}

// Embed-Form aus PostgREST: `attachments:todo_attachments(id)` liefert
// pro Todo ein Array mit minimalen Sub-Rows. Wir nutzen nur die Laenge,
// um in der Liste das Paperclip-Icon zu zeigen.
type TodoListRow = Todo & {
  assignee: { full_name: string } | null;
  attachments: { id: string }[];
};

const PAGE_SIZE = 50;

export default function TodosPage() {
  const [todos, setTodos] = useState<TodoListRow[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [archiveCount, setArchiveCount] = useState(0);
  const [showArchive, setShowArchive] = useState(false);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", urgent: false, due_date: "", assigned_to: "" });
  const [selectedTodo, setSelectedTodo] = useState<Todo | null>(null);
  const [attachments, setAttachments] = useState<TodoAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  // Floating Vorschau (Eye-Button) — non-modal.
  const [previewDoc, setPreviewDoc] = useState<{ url: string; title: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const supabase = createClient();
  const { can } = usePermissions();
  const { confirm, ConfirmModalElement } = useConfirm();

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryIdRef = useRef(0);

  const buildQuery = useCallback((cursor: { id: string } | null) => {
    let q = supabase
      .from("todos")
      .select("*, assignee:profiles!assigned_to(full_name), attachments:todo_attachments(id)")
      .eq("status", showArchive ? "erledigt" : "offen");
    const term = search.trim();
    if (term.length > 0) {
      const like = `%${term}%`;
      q = q.or(`title.ilike.${like},description.ilike.${like}`);
    }
    if (cursor !== null) {
      q = q.lt("id", cursor.id);
    }
    return q
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("id", { ascending: false })
      .limit(PAGE_SIZE + 1);
  }, [supabase, showArchive, search]);

  const loadTodos = useCallback(async () => {
    const myId = ++queryIdRef.current;
    setLoading(true);
    const { data } = await buildQuery(null);
    if (myId !== queryIdRef.current) return;
    if (data) {
      const rows = data as unknown as TodoListRow[];
      setHasMore(rows.length > PAGE_SIZE);
      setTodos(rows.slice(0, PAGE_SIZE));
    }
    setLoading(false);
  }, [buildQuery]);

  const refreshCounts = useCallback(async () => {
    const { count } = await supabase.from("todos").select("*", { count: "exact", head: true }).eq("status", "erledigt");
    setArchiveCount(count ?? 0);
  }, [supabase]);

  useEffect(() => {
    // Konkrete Spalten statt select("*") — bei 100+ Mitarbeitern macht sich
    // das in Bandbreite und Memory bemerkbar (Profile haben viele Felder).
    supabase.from("profiles").select("id, full_name, role, is_active, email").eq("is_active", true).order("full_name")
      .then(({ data }) => { if (data) setProfiles(data as Profile[]); });
    refreshCounts();
  }, [refreshCounts, supabase]);

  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => { loadTodos(); }, 250);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [loadTodos]);

  async function loadMore() {
    if (loadingMore || todos.length === 0) return;
    setLoadingMore(true);
    const last = todos[todos.length - 1];
    const { data } = await buildQuery({ id: last.id });
    if (data) {
      const rows = data as unknown as TodoListRow[];
      setHasMore(rows.length > PAGE_SIZE);
      setTodos((prev) => [...prev, ...rows.slice(0, PAGE_SIZE)]);
    }
    setLoadingMore(false);
  }

  async function addTodo(e: React.FormEvent) {
    e.preventDefault();
    const { data: { user } } = await supabase.auth.getUser();
    const priority: JobPriority = form.urgent ? "dringend" : "normal";
    const { error: insertErr } = await supabase.from("todos").insert({
      title: form.title,
      description: form.description || null,
      priority,
      due_date: form.due_date || null,
      assigned_to: form.assigned_to || null,
      created_by: user?.id,
    });
    if (insertErr) {
      TOAST.createError(insertErr.message);
      return;
    }

    if (form.assigned_to) {
      const { data: creator } = await supabase.from("profiles").select("full_name").eq("id", user?.id).single();
      await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userIds: [form.assigned_to],
          // Dringend-Marker steht in der priority-Spalte; Title bleibt
          // emoji-frei damit Notification-Daten clean sind und in
          // anderen UIs (Mail-Templates, Sidebar-Bell) nicht doppelt
          // mit Icons + Emojis konfligieren.
          title: priority === "dringend" ? `Dringendes Todo: ${form.title}` : `Neues Todo: ${form.title}`,
          message: `Von ${creator?.full_name || "Unbekannt"}${form.due_date ? ` · Fällig: ${(() => { const [y,m,d] = form.due_date.split("-").map(Number); return new Date(y, m-1, d, 12).toLocaleDateString("de-CH"); })()}` : ""}`,
          link: "/todos",
        }),
      });
      if (priority === "dringend") {
        await fetch("/api/todos/urgent-notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            assignedTo: form.assigned_to,
            title: form.title,
            description: form.description || null,
            dueDate: form.due_date || null,
            creatorName: creator?.full_name || "Unbekannt",
          }),
        });
      }
    }
    toast.success("Todo erstellt");

    setForm({ title: "", description: "", urgent: false, due_date: "", assigned_to: "" });
    setShowForm(false);
    await Promise.all([loadTodos(), refreshCounts()]);
  }

  async function toggleTodo(id: string, currentStatus: string) {
    const newStatus = currentStatus === "offen" ? "erledigt" : "offen";
    await supabase.from("todos").update({ status: newStatus, completed_at: newStatus === "erledigt" ? new Date().toISOString() : null }).eq("id", id);
    if (selectedTodo?.id === id) {
      setSelectedTodo({ ...selectedTodo, status: newStatus as "offen" | "erledigt" });
    }
    await Promise.all([loadTodos(), refreshCounts()]);
  }

  async function deleteTodo(id: string) {
    const ok = await confirm({
      title: "Todo löschen?",
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    // Storage-Files muessen von Hand entfernt werden — der DB-Cascade auf
    // todo_attachments raeumt die Tabellen-Rows, nicht die Storage-Objekte.
    const { data: atts } = await supabase.from("todo_attachments").select("path").eq("todo_id", id);
    if (atts && atts.length > 0) {
      await supabase.storage.from("documents").remove(atts.map((a) => a.path));
    }
    const result = await deleteRow("todos", id);
    if (!result.ok) {
      TOAST.deleteError(result.error);
      return;
    }
    setSelectedTodo(null);
    await Promise.all([loadTodos(), refreshCounts()]);
    toast.success("Todo gelöscht");
  }

  function openTodo(todo: Todo) {
    setSelectedTodo(todo);
    loadAttachments(todo.id);
  }

  async function loadAttachments(todoId: string) {
    const { data } = await supabase.from("todo_attachments").select("*").eq("todo_id", todoId).order("uploaded_at", { ascending: true });
    setAttachments((data as TodoAttachment[]) ?? []);
  }

  async function uploadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !selectedTodo) return;
    if (!validateFileSize(file)) return;
    setUploading(true);
    const path = `todos/${selectedTodo.id}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const { error: upErr } = await supabase.storage.from("documents").upload(path, file, { contentType: file.type });
    if (upErr) {
      TOAST.uploadError(upErr.message);
      setUploading(false);
      e.target.value = "";
      return;
    }
    const { data: { user } } = await supabase.auth.getUser();
    const { error: insErr } = await supabase.from("todo_attachments").insert({
      todo_id: selectedTodo.id,
      name: file.name,
      path,
      uploaded_by: user?.id,
    });
    if (insErr) {
      await supabase.storage.from("documents").remove([path]);
      TOAST.uploadError(insErr.message);
      setUploading(false);
      e.target.value = "";
      return;
    }
    await loadAttachments(selectedTodo.id);
    loadTodos();
    toast.success("Datei hochgeladen");
    setUploading(false);
    e.target.value = "";
  }

  async function deleteAttachment(att: TodoAttachment) {
    if (!selectedTodo) return;
    await supabase.storage.from("documents").remove([att.path]);
    await supabase.from("todo_attachments").delete().eq("id", att.id);
    await loadAttachments(selectedTodo.id);
    loadTodos();
    toast.success("Datei gelöscht");
  }

  // Bucket 'documents' ist private — signed URLs noetig.
  async function getSignedUrl(path: string): Promise<string | null> {
    const { data, error } = await supabase.storage.from("documents").createSignedUrl(path, 3600);
    if (error || !data?.signedUrl) {
      toast.error("Datei nicht verfügbar");
      return null;
    }
    return data.signedUrl;
  }

  async function previewFile(path: string, filename: string) {
    const url = await getSignedUrl(path);
    if (url) setPreviewDoc({ url, title: filename });
  }

  async function downloadFile(path: string, filename: string) {
    const url = await getSignedUrl(path);
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  }

  // Detail view
  if (selectedTodo) {
    const assignee = (selectedTodo as unknown as { assignee: { full_name: string } | null }).assignee;
    return (
      <div className="space-y-6 max-w-3xl mx-auto">
        <div className="flex items-center gap-4">
          <BackButton fallbackHref="/todos" />
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h1 className={`text-2xl font-bold tracking-tight ${selectedTodo.status === "erledigt" ? "line-through text-muted-foreground" : ""}`}>{selectedTodo.title}</h1>
              {selectedTodo.priority === "dringend" && selectedTodo.status === "offen" && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold rounded-full bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300">
                  <AlertCircle className="h-3 w-3" />Dringend
                </span>
              )}
            </div>
          </div>
        </div>

        <Card className="bg-card">
          <CardContent className="p-5 space-y-3">
            <div className="flex items-center gap-2">
              {selectedTodo.status === "offen" ? (
                <button onClick={() => toggleTodo(selectedTodo.id, selectedTodo.status)} className="kasten kasten-green">
                  <Check className="h-3.5 w-3.5" />Abschliessen
                </button>
              ) : (
                <button onClick={() => toggleTodo(selectedTodo.id, selectedTodo.status)} className="kasten kasten-muted">
                  Wieder öffnen
                </button>
              )}
              {/* Loeschen nur bei offenen Todos. Erledigte sind read-only — Archiv-
                  Konsistenz mit /auftraege + /kunden. */}
              {selectedTodo.status === "offen" && (
                <button onClick={() => deleteTodo(selectedTodo.id)} className="kasten kasten-red">
                  <Trash2 className="h-3.5 w-3.5" />Löschen
                </button>
              )}
            </div>
            {selectedTodo.description && (
              <div className="p-3 rounded-xl bg-muted/40 border border-border">
                <p className="text-sm whitespace-pre-wrap">{selectedTodo.description}</p>
              </div>
            )}
            <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
              {assignee && <span className="flex items-center gap-1"><User className="h-4 w-4" />{assignee.full_name}</span>}
              {selectedTodo.due_date && <span className="flex items-center gap-1"><Calendar className="h-4 w-4" />Fällig: {new Date(selectedTodo.due_date).toLocaleDateString("de-CH")}</span>}
              <span>Erstellt: {new Date(selectedTodo.created_at).toLocaleDateString("de-CH")}</span>
              {selectedTodo.completed_at && (
                <span className="flex items-center gap-1 text-green-700 dark:text-green-400">
                  <Check className="h-4 w-4" />Abgeschlossen: {new Date(selectedTodo.completed_at).toLocaleDateString("de-CH")}
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-2"><FileText className="h-4 w-4" />Anhänge ({attachments.length})</h2>
              <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading}>
                <Upload className="h-4 w-4 mr-1" />{uploading ? "Hochladen..." : "Datei hochladen"}
              </Button>
              <input ref={fileRef} type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.gif" onChange={uploadFile} className="hidden" />
            </div>
            <div className="space-y-2">
              {attachments.length === 0 && <p className="text-sm text-muted-foreground py-4 text-center">Noch keine Anhänge.</p>}
              {attachments.map((a) => {
                const isImage = /\.(jpg|jpeg|png|gif)$/i.test(a.name);
                return (
                  <div key={a.id} className="flex items-center justify-between p-3 rounded-xl bg-muted/40 border border-border">
                    <button onClick={() => previewFile(a.path, a.name)} className="flex items-center gap-3 min-w-0 flex-1 text-left hover:text-foreground transition-colors">
                      {isImage ? <ImageIcon className="h-5 w-5 text-blue-500 shrink-0" /> : <FileText className="h-5 w-5 text-red-500 shrink-0" />}
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate">{a.name}</p>
                        <p className="text-xs text-muted-foreground">{new Date(a.uploaded_at).toLocaleDateString("de-CH")}</p>
                      </div>
                    </button>
                    <div className="flex items-center gap-1.5 shrink-0 ml-2">
                      <button onClick={() => previewFile(a.path, a.name)} className="icon-btn icon-btn-blue" data-tooltip="Vorschau"><Eye className="h-4 w-4" /></button>
                      <button onClick={() => downloadFile(a.path, a.name)} className="icon-btn icon-btn-muted" data-tooltip="Herunterladen"><Download className="h-4 w-4" /></button>
                      {selectedTodo.status === "offen" && (
                        <button onClick={() => deleteAttachment(a)} className="icon-btn icon-btn-red" data-tooltip="Löschen"><Trash2 className="h-4 w-4" /></button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
        {ConfirmModalElement}
        {previewDoc && (
          <PdfPopup
            url={previewDoc.url}
            title={previewDoc.title}
            onClose={() => setPreviewDoc(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header — gleiche Struktur wie /auftraege: Titel + Subtitle (Hinweis-Zeile)
          links, rechts Archiv-Toggle + "Neues Todo". BackButton vorgeschaltet,
          damit man via HR-Hub mit dem Pfeil wieder rauskommt. */}
      <div className="flex items-center justify-between flex-wrap gap-3 min-h-9">
        <div className="flex items-center gap-4">
          <BackButton fallbackHref="/hr" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{showArchive ? "Todos Archiv" : "Todos"}</h1>
            <p className="text-xs text-muted-foreground/70 mt-1">
              Persönliche Aufgaben — für Wartung am Standort siehe <Link href="/standorte" className="underline hover:text-foreground transition-colors">Standorte</Link>.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowArchive(!showArchive)} className={showArchive ? "kasten-active" : "kasten-toggle-off"}>
            <Archive className="h-3.5 w-3.5" />{showArchive ? "Aktive anzeigen" : `Archiv (${archiveCount})`}
          </button>
          {!showArchive && can("todos:create") && (
            <button
              type="button"
              onClick={() => setShowForm(!showForm)}
              className="kasten kasten-red"
            >
              <Plus className="h-3.5 w-3.5" />Neues Todo
            </button>
          )}
        </div>
      </div>

      {/* Add Form */}
      {showForm && !showArchive && (
        <Card className="bg-card">
          <CardContent className="p-6">
            <form onSubmit={addTodo} className="space-y-4">
              <Input placeholder="Was muss erledigt werden? *" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
              <textarea placeholder="Details (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-card resize-none focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring" rows={2} />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Fällig am</label>
                  <Input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} className="mt-1" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Zuweisen an</label>
                  <div className="mt-1">
                    <SearchableSelect
                      value={form.assigned_to}
                      onChange={(v) => setForm({ ...form, assigned_to: v })}
                      items={[
                        { id: "", label: "Niemand" },
                        ...profiles.map((p) => ({ id: p.id, label: p.full_name })),
                      ]}
                      clearable={false}
                    />
                  </div>
                </div>
                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, urgent: !form.urgent })}
                    className={form.urgent ? "kasten kasten-red w-full" : "kasten kasten-muted w-full"}
                  >
                    {form.urgent ? "Dringend ✓" : "Als dringend markieren"}
                  </button>
                </div>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setShowForm(false)} className="kasten kasten-muted">Abbrechen</button>
                <button type="submit" disabled={!form.title} className="kasten kasten-red">Todo erstellen</button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Such-Bar — schlank, nur ein Such-Feld (RLS scoped eh auf eigene). */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Titel oder Beschreibung suchen…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        {search && (
          <button
            type="button"
            onClick={() => setSearch("")}
            className="h-9 px-3 text-xs text-muted-foreground hover:text-foreground rounded-lg flex items-center gap-1.5 transition-colors"
            data-tooltip="Suche zurücksetzen"
          >
            <X className="h-3.5 w-3.5" />
            Reset
          </button>
        )}
      </div>

      {/* Todo List — Karten-Stil 1:1 wie /auftraege (auftrag-card-hover, kompakt). */}
      {loading ? (
        <div className="space-y-3">{[1,2,3].map((i) => <Card key={i} className="animate-pulse bg-card"><CardContent className="p-5"><div className="h-5 bg-muted rounded w-1/2" /></CardContent></Card>)}</div>
      ) : todos.length === 0 ? (
        <Card className="bg-card border-dashed">
          <CardContent className="py-16 text-center">
            <div className="mx-auto w-14 h-14 rounded-2xl bg-muted flex items-center justify-center mb-4"><CheckSquare className="h-7 w-7 text-muted-foreground" /></div>
            <h3 className="font-semibold text-lg">{showArchive ? "Archiv ist leer" : search ? "Keine Treffer" : "Keine offenen Todos"}</h3>
            <p className="text-sm text-muted-foreground mt-1">{!showArchive && !search ? "Erstelle dein erstes Todo." : ""}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {todos.map((todo) => {
            const overdue = todo.status === "offen" && todo.due_date && new Date(todo.due_date) < new Date(new Date().toDateString());
            const attCount = todo.attachments?.length ?? 0;
            const dueText = todo.due_date
              ? (() => { const [y,m,d] = todo.due_date.split("-").map(Number); return new Date(y, m-1, d, 12).toLocaleDateString("de-CH"); })()
              : null;
            const completedText = todo.completed_at
              ? new Date(todo.completed_at).toLocaleDateString("de-CH")
              : null;
            return (
              <Card
                key={todo.id}
                onClick={() => openTodo(todo)}
                className={`auftrag-card-hover relative bg-card cursor-pointer ${overdue ? "border-red-400 dark:border-red-500/40" : ""} ${todo.status === "erledigt" ? "opacity-70" : ""}`}
              >
                <div className="flex items-center gap-3 px-4 py-1.5">
                  <div className="flex-1 flex flex-col gap-0.5 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`auftrag-card-title font-medium text-sm truncate transition-colors ${todo.status === "erledigt" ? "line-through text-muted-foreground" : ""}`}>{todo.title}</span>
                      {todo.priority === "dringend" && todo.status === "offen" && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0 text-[10px] font-semibold rounded-full bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300 shrink-0">
                          <AlertCircle className="h-2.5 w-2.5" />
                        </span>
                      )}
                      {attCount > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground shrink-0" data-tooltip={`${attCount} Anhang${attCount === 1 ? "" : "e"}`}>
                          <Paperclip className="h-3 w-3" />
                          {attCount}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
                      <span className="truncate">{todo.assignee?.full_name ?? "Niemand"}</span>
                      {/* Active-View: Faelligkeit. Archive-View: Abschluss-Datum
                          (completed_at) — so sieht man auf einen Blick wann die
                          Aufgabe abgehakt wurde. */}
                      {todo.status === "erledigt" && completedText ? (
                        <>
                          <span className="opacity-50 shrink-0">|</span>
                          <span className="whitespace-nowrap shrink-0 text-green-700 dark:text-green-400">
                            Abgeschlossen: {completedText}
                          </span>
                        </>
                      ) : dueText ? (
                        <>
                          <span className="opacity-50 shrink-0">|</span>
                          <span className={`whitespace-nowrap shrink-0 ${overdue ? "text-red-600 dark:text-red-400 font-medium" : ""}`}>
                            {overdue ? "Überfällig: " : "Fällig: "}{dueText}
                          </span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  {todo.status === "offen" && (
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleTodo(todo.id, todo.status); }}
                      className="kasten kasten-green shrink-0"
                      aria-label="Abschliessen"
                    >
                      <Check className="h-3.5 w-3.5" />
                      Abschliessen
                    </button>
                  )}
                  {todo.status === "offen" && (
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteTodo(todo.id); }}
                      className="p-1.5 rounded-lg text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors shrink-0"
                      aria-label="Löschen"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </Card>
            );
          })}
          {hasMore && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="kasten kasten-muted"
              >
                <ChevronDown className="h-3.5 w-3.5" />
                {loadingMore ? "Lade…" : "Mehr laden"}
              </button>
            </div>
          )}
        </div>
      )}
      {ConfirmModalElement}
    </div>
  );
}
