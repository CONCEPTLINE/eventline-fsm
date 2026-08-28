"use client";

/**
 * Notizbloecke auf der Projekt-Detailseite.
 *
 * Mehrere benannte Bloecke statt einem grossen Textfeld: so laesst sich
 * pro Thema getrennt nachvollziehen wer zuletzt was geaendert hat, und
 * die Bloecke bleiben einzeln durchsuchbar. Die vier Standard-Bloecke
 * legt ein DB-Trigger beim Anlegen des Projekts an (Migration 190).
 *
 * Speichern laeuft automatisch mit Verzoegerung — kein Speichern-Knopf.
 * Beim Verlassen der Seite wird ein noch offener Timer sofort ausgefuehrt,
 * damit die letzte Eingabe nicht verloren geht.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/use-confirm";
import { NotebookPen, Plus, ChevronDown, ChevronRight, X, ArrowUp, ArrowDown, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { logError } from "@/lib/log";

interface Note {
  id: string;
  title: string;
  body: string;
  position: number;
  updated_at: string;
  updated_by: string | null;
  editor?: { full_name: string | null } | null;
}

interface Props {
  projectId: string;
  readOnly: boolean;
}

/** Verzoegerung bis eine Aenderung in die DB geschrieben wird. Lang genug
 *  dass normales Tippen nicht jeden Anschlag schickt, kurz genug dass ein
 *  Wechsel in einen anderen Block den Stand sicher hat. */
const AUTOSAVE_MS = 800;

export function ProjektNotizen({ projectId, readOnly }: Props) {
  const supabase = createClient();
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const { confirm, ConfirmModalElement } = useConfirm();

  // Offene Autosave-Timer pro Notiz-ID.
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Letzter noch nicht geschriebener Stand pro Notiz-ID — wird beim
  // Unmount geflusht.
  const pending = useRef<Map<string, { title: string; body: string }>>(new Map());

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("project_notes")
      .select("id, title, body, position, updated_at, updated_by, editor:profiles!project_notes_updated_by_fkey(full_name)")
      .eq("project_id", projectId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) {
      logError("projekte.notizen.load", error);
      setLoading(false);
      return;
    }
    setNotes((data ?? []).map((n) => ({
      ...n,
      editor: Array.isArray(n.editor) ? n.editor[0] : n.editor,
    })) as Note[]);
    setLoading(false);
  }, [supabase, projectId]);

  useEffect(() => { load(); }, [load]);

  const flush = useCallback(async (id: string) => {
    const payload = pending.current.get(id);
    if (!payload) return;
    pending.current.delete(id);
    setSavingIds((s) => new Set(s).add(id));
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("project_notes")
      .update({
        title: payload.title.trim() || "Notiz",
        body: payload.body,
        updated_by: user?.id ?? null,
      })
      .eq("id", id);
    setSavingIds((s) => { const n = new Set(s); n.delete(id); return n; });
    if (error) {
      logError("projekte.notizen.save", error);
      toast.error("Notiz konnte nicht gespeichert werden: " + error.message);
    }
  }, [supabase]);

  // Beim Unmount alle offenen Timer sofort ausfuehren — sonst geht die
  // letzte Eingabe verloren wenn der User direkt wegnavigiert.
  useEffect(() => {
    const timerMap = timers.current;
    const pendingMap = pending.current;
    return () => {
      for (const t of timerMap.values()) clearTimeout(t);
      timerMap.clear();
      for (const id of Array.from(pendingMap.keys())) void flush(id);
    };
  }, [flush]);

  function edit(id: string, patch: Partial<Pick<Note, "title" | "body">>) {
    setNotes((prev) => {
      const next = prev.map((n) => (n.id === id ? { ...n, ...patch } : n));
      const target = next.find((n) => n.id === id);
      if (target) pending.current.set(id, { title: target.title, body: target.body });
      return next;
    });
    const existing = timers.current.get(id);
    if (existing) clearTimeout(existing);
    timers.current.set(id, setTimeout(() => {
      timers.current.delete(id);
      void flush(id);
    }, AUTOSAVE_MS));
  }

  async function addNote() {
    setCreating(true);
    const { data: { user } } = await supabase.auth.getUser();
    const nextPos = notes.length > 0 ? Math.max(...notes.map((n) => n.position)) + 1 : 0;
    const { error } = await supabase.from("project_notes").insert({
      project_id: projectId,
      title: "Neuer Block",
      body: "",
      position: nextPos,
      created_by: user?.id ?? null,
      updated_by: user?.id ?? null,
    });
    setCreating(false);
    if (error) { toast.error("Block konnte nicht angelegt werden: " + error.message); return; }
    load();
  }

  async function removeNote(note: Note) {
    const ok = await confirm({
      title: "Notizblock löschen?",
      message: `„${note.title}“ und der gesamte Inhalt werden gelöscht.`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    // Offenen Autosave verwerfen, sonst schreibt er die geloeschte Zeile
    // gleich wieder an (Update auf 0 Zeilen — still, aber unnoetig).
    const t = timers.current.get(note.id);
    if (t) { clearTimeout(t); timers.current.delete(note.id); }
    pending.current.delete(note.id);

    const { error } = await supabase.from("project_notes").delete().eq("id", note.id);
    if (error) { toast.error("Löschen fehlgeschlagen: " + error.message); return; }
    load();
  }

  /** Tauscht die Position mit dem Nachbarn. Zwei einzelne Updates statt
   *  einer Transaktion — bei zwei Zeilen ist das Risiko eines halben
   *  Tauschs vernachlaessigbar und die Reihenfolge ist rein kosmetisch. */
  async function move(index: number, direction: -1 | 1) {
    const a = notes[index];
    const b = notes[index + direction];
    if (!a || !b) return;
    setNotes((prev) => {
      const next = [...prev];
      next[index] = { ...b, position: a.position };
      next[index + direction] = { ...a, position: b.position };
      return next;
    });
    const [r1, r2] = await Promise.all([
      supabase.from("project_notes").update({ position: b.position }).eq("id", a.id),
      supabase.from("project_notes").update({ position: a.position }).eq("id", b.id),
    ]);
    if (r1.error || r2.error) {
      toast.error("Reihenfolge konnte nicht gespeichert werden");
      load();
    }
  }

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <NotebookPen className="h-3 w-3" /> Notizen ({notes.length})
        </p>
        {!readOnly && (
          <button onClick={addNote} disabled={creating} className="kasten kasten-muted">
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Block
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground p-2">Lädt…</p>
      ) : notes.length === 0 ? (
        <Card>
          <CardContent className="p-4 text-xs text-muted-foreground text-center">
            Keine Notizblöcke.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-1">
          {notes.map((n, i) => {
            const isCollapsed = collapsed.has(n.id);
            const isSaving = savingIds.has(n.id);
            return (
              <Card key={n.id}>
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => toggle(n.id)}
                      className="text-muted-foreground hover:text-foreground shrink-0"
                      aria-label={isCollapsed ? "Aufklappen" : "Zuklappen"}
                    >
                      {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                    {readOnly ? (
                      <span className="flex-1 text-sm font-medium truncate">{n.title}</span>
                    ) : (
                      <Input
                        value={n.title}
                        onChange={(e) => edit(n.id, { title: e.target.value })}
                        className="flex-1 h-8 text-sm font-medium"
                        aria-label="Titel des Notizblocks"
                      />
                    )}
                    <span className="text-muted-foreground shrink-0" aria-live="polite">
                      {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5 opacity-30" />}
                    </span>
                    {!readOnly && (
                      <>
                        <button
                          onClick={() => move(i, -1)}
                          disabled={i === 0}
                          className="text-muted-foreground hover:text-foreground disabled:opacity-25 shrink-0"
                          aria-label="Nach oben"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => move(i, 1)}
                          disabled={i === notes.length - 1}
                          className="text-muted-foreground hover:text-foreground disabled:opacity-25 shrink-0"
                          aria-label="Nach unten"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => removeNote(n)}
                          className="text-muted-foreground hover:text-destructive shrink-0"
                          aria-label="Block löschen"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>

                  {!isCollapsed && (
                    <>
                      {readOnly ? (
                        <p className="text-sm whitespace-pre-wrap text-muted-foreground min-h-[2rem]">
                          {n.body || "—"}
                        </p>
                      ) : (
                        <textarea
                          value={n.body}
                          onChange={(e) => edit(n.id, { body: e.target.value })}
                          rows={6}
                          placeholder="Notizen…"
                          className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background resize-y focus:outline-none focus:ring-2 focus:ring-ring/40"
                        />
                      )}
                      {n.editor?.full_name && (
                        <p className="text-[10px] text-muted-foreground/70">
                          zuletzt: {n.editor.full_name} · {new Date(n.updated_at).toLocaleString("de-CH", { timeZone: "Europe/Zurich" })}
                        </p>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      {ConfirmModalElement}
    </div>
  );
}
