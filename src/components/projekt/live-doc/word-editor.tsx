"use client";

/**
 * WordEditor — das Live-Dokument eines Projekts, so nah an Word wie moeglich:
 * weisses A4-Blatt auf grauem Grund, Ribbon-artige Werkzeugleiste
 * (Formatvorlage, Schriftart, Groesse, B/I/U/S, Farben, Ausrichtung, Listen,
 * Tabellen), Ueberschriften im Word-Blau.
 *
 * Kollaboration: Tiptap + Yjs. Der komplette Inhalt lebt im Y.Doc; alle
 * offenen Browser synchronisieren via SupabaseYjsProvider (Broadcast).
 * Fremde Cursor erscheinen farbig mit Namens-Fahne (CollaborationCaret).
 *
 * Persistenz: 1.5s nach der letzten EIGENEN Aenderung wird der komplette
 * Yjs-Zustand (base64) + ein HTML-Schnappschuss in project_docs gespeichert.
 * Alle ~10 Minuten aktiven Schreibens entsteht zusaetzlich eine Version in
 * project_doc_versions (Verlauf ansehen + wiederherstellen).
 *
 * PDF: Druck-Weg — body bekommt .print-livedoc, @media print blendet alles
 * ausser dem Blatt aus (globals.css), window.print() → "Als PDF speichern".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as Y from "yjs";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
import { TextStyleKit } from "@tiptap/extension-text-style";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import { TableKit } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Placeholder } from "@tiptap/extensions";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { SearchableSelect } from "@/components/searchable-select";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/use-confirm";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import {
  ArrowLeft, Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
  List, ListOrdered, ListChecks, Table as TableIcon, Trash2,
  Undo2, Redo2, Printer, History, Loader2, Check,
  Plus, Minus, Subscript as SubscriptIcon, Superscript as SuperscriptIcon,
  RemoveFormatting, Link as LinkIcon, Unlink, Indent, Outdent,
  AArrowUp, AArrowDown,
} from "lucide-react";
import { usePrompt } from "@/components/ui/use-prompt";
import { SupabaseYjsProvider } from "./supabase-yjs-provider";
import {
  TB, WORD_FONTS, WORD_SIZES,
  FontColorControl, HighlightControl, LineSpacingControl,
} from "./ribbon-controls";

// Word-Palette fuer fremde Cursor — kraeftig genug fuer weisses Blatt.
const CURSOR_COLORS = ["#2F5496", "#C00000", "#548235", "#BF8F00", "#7030A0", "#0E7C7B", "#B14A82", "#5B5B5B"];

function cursorColor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return CURSOR_COLORS[h % CURSOR_COLORS.length];
}

const STYLE_ITEMS = [
  { id: "p", label: "Standard" },
  { id: "h1", label: "Überschrift 1" },
  { id: "h2", label: "Überschrift 2" },
  { id: "h3", label: "Überschrift 3" },
];

type SaveState = "idle" | "saving" | "saved" | "error";

type PresenceUser = { clientId: number; name: string; color: string };

type DocVersion = { id: string; content_html: string; created_at: string; created_by: string; author?: string };

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("de-CH", {
    timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export function WordEditor({ docId, projectId, initialTitle, initialState, canWrite, meId, meName }: {
  docId: string;
  projectId: string;
  initialTitle: string;
  initialState: string | null;
  canWrite: boolean;
  meId: string;
  meName: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const { confirm, ConfirmModalElement } = useConfirm();
  const { prompt, PromptModalElement } = usePrompt();

  const [title, setTitle] = useState(initialTitle);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [others, setOthers] = useState<PresenceUser[]>([]);
  const [showVersions, setShowVersions] = useState(false);
  const [versions, setVersions] = useState<DocVersion[] | null>(null);
  const [previewVersion, setPreviewVersion] = useState<DocVersion | null>(null);

  // Y.Doc + Provider leben genau einmal pro Mount. Initial-Zustand aus der
  // DB MUSS vor dem ersten Editor-Render im Doc sein (sonst flackert leer).
  const ydoc = useMemo(() => {
    const d = new Y.Doc();
    if (initialState) {
      try {
        const bin = atob(initialState);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        Y.applyUpdate(d, u8, "db");
      } catch {
        /* korrupter Snapshot — leer starten, Live-Sync liefert den Rest */
      }
    }
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  const provider = useMemo(() => new SupabaseYjsProvider(supabase, docId, ydoc), [supabase, docId, ydoc]);

  useEffect(() => {
    provider.awareness.setLocalStateField("user", { name: meName, color: cursorColor(meId) });
    provider.onRemoteTitle = (t) => setTitle(t);

    const onAwareness = () => {
      const states = Array.from(provider.awareness.getStates().entries());
      setOthers(
        states
          .filter(([clientId]) => clientId !== ydoc.clientID)
          .map(([clientId, s]) => ({
            clientId,
            name: (s as { user?: { name?: string } }).user?.name ?? "Unbekannt",
            color: (s as { user?: { color?: string } }).user?.color ?? "#5B5B5B",
          })),
      );
    };
    provider.awareness.on("change", onAwareness);
    onAwareness();
    return () => {
      provider.awareness.off("change", onAwareness);
      provider.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    editable: canWrite,
    extensions: [
      StarterKit.configure({ undoRedo: false, link: { openOnClick: false } }),
      Collaboration.configure({ document: ydoc }),
      CollaborationCaret.configure({
        provider,
        user: { name: meName, color: cursorColor(meId) },
      }),
      TextStyleKit,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Highlight.configure({ multicolor: true }),
      Subscript,
      Superscript,
      TableKit.configure({ table: { resizable: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: "Schreib los — alle im Projekt sehen es live…" }),
    ],
    editorProps: {
      attributes: { class: "livedoc-content focus:outline-none" },
    },
  }, [docId]);

  // ─── Persistenz (debounced) + Versionen ─────────────────────────
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastVersionAt = useRef<number>(0);
  const editorRef = useRef(editor);
  editorRef.current = editor;

  const persist = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed) return;
    setSaveState("saving");
    const stateB64 = (() => {
      const u8 = Y.encodeStateAsUpdate(ydoc);
      let s = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode(...u8.subarray(i, i + CHUNK));
      return btoa(s);
    })();
    const html = ed.getHTML();
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("project_docs")
      .update({ ydoc_state: stateB64, content_html: html, updated_at: now, updated_by: meId })
      .eq("id", docId);
    if (error) {
      setSaveState("error");
      toast.error("Speichern fehlgeschlagen: " + error.message);
      return;
    }
    setSaveState("saved");
    setSavedAt(now);
    // Verlaufs-Schnappschuss max. alle 10 Minuten aktiven Schreibens.
    if (Date.now() - lastVersionAt.current > 10 * 60 * 1000) {
      lastVersionAt.current = Date.now();
      await supabase.from("project_doc_versions").insert({ doc_id: docId, content_html: html, created_by: meId });
    }
  }, [supabase, docId, meId, ydoc]);

  useEffect(() => {
    if (!canWrite) return;
    // Letzte Version laden, damit nicht bei jedem Oeffnen sofort eine neue entsteht.
    supabase
      .from("project_doc_versions")
      .select("created_at")
      .eq("doc_id", docId)
      .order("created_at", { ascending: false })
      .limit(1)
      .then(({ data }) => {
        if (data?.[0]) lastVersionAt.current = new Date(data[0].created_at).getTime();
      });

    const onUpdate = (_u: Uint8Array, origin: unknown) => {
      if (origin === "remote" || origin === "db") return; // nur eigene Tipparbeit speichert
      setSaveState("saving");
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(persist, 1500);
    };
    ydoc.on("update", onUpdate);
    return () => {
      ydoc.off("update", onUpdate);
      if (persistTimer.current) {
        clearTimeout(persistTimer.current);
        persist(); // Rest beim Verlassen sichern
      }
    };
  }, [ydoc, persist, canWrite, supabase, docId]);

  // ─── Titel ──────────────────────────────────────────────────────
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function onTitleChange(next: string) {
    setTitle(next);
    provider.sendTitle(next);
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(async () => {
      const { error } = await supabase.from("project_docs").update({ title: next || "Ohne Titel" }).eq("id", docId);
      if (error) toast.error("Titel konnte nicht gespeichert werden");
    }, 800);
  }

  // ─── Verlauf ────────────────────────────────────────────────────
  async function openVersions() {
    setShowVersions(true);
    const { data, error } = await supabase
      .from("project_doc_versions")
      .select("id, content_html, created_at, created_by, author:profiles!project_doc_versions_created_by_fkey(full_name)")
      .eq("doc_id", docId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      toast.error("Verlauf konnte nicht geladen werden");
      setVersions([]);
      return;
    }
    setVersions(
      (data ?? []).map((v) => ({
        id: v.id, content_html: v.content_html, created_at: v.created_at, created_by: v.created_by,
        author: (v.author as unknown as { full_name?: string } | null)?.full_name,
      })),
    );
  }

  async function restoreVersion(v: DocVersion) {
    const ok = await confirm({
      title: "Version wiederherstellen?",
      message: `Das Dokument wird auf den Stand vom ${fmtTime(v.created_at)} zurückgesetzt. Der jetzige Stand bleibt im Verlauf erhalten.`,
      confirmLabel: "Wiederherstellen",
      variant: "red",
    });
    if (!ok || !editorRef.current) return;
    // Aktuellen Stand als Version sichern, DANN ersetzen — nichts geht verloren.
    await supabase.from("project_doc_versions").insert({
      doc_id: docId, content_html: editorRef.current.getHTML(), created_by: meId,
    });
    lastVersionAt.current = Date.now();
    editorRef.current.commands.setContent(v.content_html);
    setPreviewVersion(null);
    setShowVersions(false);
    toast.success("Version wiederhergestellt");
  }

  // ─── PDF (Druckweg) ─────────────────────────────────────────────
  function exportPdf() {
    document.body.classList.add("print-livedoc");
    const cleanup = () => {
      document.body.classList.remove("print-livedoc");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
  }

  // ─── Toolbar-Zustaende ──────────────────────────────────────────
  const activeStyle = editor?.isActive("heading", { level: 1 }) ? "h1"
    : editor?.isActive("heading", { level: 2 }) ? "h2"
    : editor?.isActive("heading", { level: 3 }) ? "h3" : "p";
  const activeFont = (editor?.getAttributes("textStyle").fontFamily as string | undefined) ?? WORD_FONTS[0].id;
  const activeSize = ((editor?.getAttributes("textStyle").fontSize as string | undefined) ?? "11pt").replace("pt", "");
  const inTable = !!editor?.isActive("table");
  const inList = !!editor && (editor.isActive("listItem") || editor.isActive("taskItem"));

  function applyStyle(id: string) {
    if (!editor) return;
    const c = editor.chain().focus();
    if (id === "p") c.setParagraph().run();
    else c.toggleHeading({ level: Number(id.slice(1)) as 1 | 2 | 3 }).run();
  }

  /** Schriftgrad schrittweise wie Words A^ / Av — entlang der Word-Groessenleiter. */
  function stepFontSize(dir: 1 | -1) {
    if (!editor) return;
    const idx = WORD_SIZES.indexOf(activeSize);
    const next = idx === -1
      ? (dir === 1 ? WORD_SIZES.find((s) => Number(s) > Number(activeSize)) : [...WORD_SIZES].reverse().find((s) => Number(s) < Number(activeSize)))
      : WORD_SIZES[Math.min(WORD_SIZES.length - 1, Math.max(0, idx + dir))];
    if (next) editor.chain().focus().setFontSize(`${next}pt`).run();
  }

  async function editLink() {
    if (!editor) return;
    const current = (editor.getAttributes("link").href as string | undefined) ?? "";
    const url = await prompt({
      title: "Link einfügen",
      label: "Adresse (URL)",
      placeholder: "https://…",
      defaultValue: current,
    });
    if (url === null) return;
    const trimmed = url.trim();
    if (!trimmed) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    const href = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
  }

  function indent(dir: 1 | -1) {
    if (!editor) return;
    const type = editor.isActive("taskItem") ? "taskItem" : "listItem";
    if (dir === 1) editor.chain().focus().sinkListItem(type).run();
    else editor.chain().focus().liftListItem(type).run();
  }

  return (
    // Negative Raender = exakte Umkehr des (app)/layout-main-Paddings,
    // damit der graue "Schreibtisch" randlos unter dem Blatt liegt.
    <div className="livedoc-page -mx-4 -mb-4 -mt-[calc(env(safe-area-inset-top)+16px)] md:-mx-10 md:-mb-8 md:-mt-10 min-h-screen flex flex-col" style={{ background: "var(--livedoc-desk, #ECECEC)" }}>
      {/* ─── Kopfzeile ─────────────────────────────────────────── */}
      <div className="livedoc-chrome sticky top-0 z-30 bg-card border-b border-border px-3 py-2 flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => router.push(`/projekte/${projectId}?tab=dokumente`)}
          className="kasten kasten-muted"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Projekt
        </button>
        <input
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          disabled={!canWrite}
          placeholder="Ohne Titel"
          className="font-semibold text-sm bg-transparent focus:outline-none focus:border-b focus:border-foreground/40 min-w-0 flex-1 max-w-xs"
        />
        {/* Wer ist gerade drin */}
        <div className="flex items-center -space-x-1.5">
          {others.map((u) => (
            <span
              key={u.clientId}
              data-tooltip={u.name}
              data-tooltip-side="bottom"
              className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-2 ring-card"
              style={{ background: u.color }}
            >
              {u.name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase()}
            </span>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground flex items-center gap-1 ml-auto">
          {saveState === "saving" && <><Loader2 className="h-3 w-3 animate-spin" /> Speichert…</>}
          {saveState === "saved" && savedAt && <><Check className="h-3 w-3 text-green-600" /> Gespeichert {new Date(savedAt).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" })}</>}
          {saveState === "error" && <span className="text-red-600">Nicht gespeichert!</span>}
          {saveState === "idle" && !canWrite && "Nur Lesen"}
        </span>
        <button type="button" onClick={openVersions} className="kasten kasten-muted" data-tooltip="Verlauf" data-tooltip-side="bottom">
          <History className="h-3.5 w-3.5" /> Verlauf
        </button>
        <button type="button" onClick={exportPdf} className="kasten kasten-muted" data-tooltip="Drucken / als PDF speichern" data-tooltip-side="bottom">
          <Printer className="h-3.5 w-3.5" /> PDF
        </button>
      </div>

      {/* ─── Werkzeugleiste (Word-Ribbon light) ────────────────── */}
      {canWrite && editor && (
        <div className="livedoc-chrome sticky top-[45px] z-20 bg-card/95 backdrop-blur border-b border-border px-3 py-1.5 flex items-center gap-1 flex-wrap">
          <TB onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} tooltip="Rückgängig"><Undo2 className="h-4 w-4" /></TB>
          <TB onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} tooltip="Wiederholen"><Redo2 className="h-4 w-4" /></TB>
          <span className="w-px h-5 bg-border mx-1" />
          <div className="w-36"><SearchableSelect value={activeStyle} onChange={applyStyle} items={STYLE_ITEMS} searchable={false} clearable={false} /></div>
          <div className="w-44"><SearchableSelect value={activeFont} onChange={(v) => editor.chain().focus().setFontFamily(v).run()} items={WORD_FONTS} searchable={false} clearable={false} /></div>
          <div className="w-20"><SearchableSelect value={activeSize} onChange={(v) => editor.chain().focus().setFontSize(`${v}pt`).run()} items={WORD_SIZES.map((s) => ({ id: s, label: s }))} searchable={false} clearable={false} /></div>
          <TB onClick={() => stepFontSize(1)} tooltip="Schriftgrad vergrössern"><AArrowUp className="h-4 w-4" /></TB>
          <TB onClick={() => stepFontSize(-1)} tooltip="Schriftgrad verkleinern"><AArrowDown className="h-4 w-4" /></TB>
          <TB onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()} tooltip="Alle Formatierungen löschen"><RemoveFormatting className="h-4 w-4" /></TB>
          <span className="w-px h-5 bg-border mx-1" />
          <TB onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive("bold")} tooltip="Fett (Strg+B)"><Bold className="h-4 w-4" /></TB>
          <TB onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive("italic")} tooltip="Kursiv (Strg+I)"><Italic className="h-4 w-4" /></TB>
          <TB onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive("underline")} tooltip="Unterstrichen (Strg+U)"><UnderlineIcon className="h-4 w-4" /></TB>
          <TB onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive("strike")} tooltip="Durchgestrichen"><Strikethrough className="h-4 w-4" /></TB>
          <TB onClick={() => editor.chain().focus().toggleSubscript().run()} active={editor.isActive("subscript")} tooltip="Tiefgestellt"><SubscriptIcon className="h-4 w-4" /></TB>
          <TB onClick={() => editor.chain().focus().toggleSuperscript().run()} active={editor.isActive("superscript")} tooltip="Hochgestellt"><SuperscriptIcon className="h-4 w-4" /></TB>
          <FontColorControl editor={editor} />
          <HighlightControl editor={editor} />
          <span className="w-px h-5 bg-border mx-1" />
          <TB onClick={() => editor.chain().focus().setTextAlign("left").run()} active={editor.isActive({ textAlign: "left" })} tooltip="Linksbündig"><AlignLeft className="h-4 w-4" /></TB>
          <TB onClick={() => editor.chain().focus().setTextAlign("center").run()} active={editor.isActive({ textAlign: "center" })} tooltip="Zentriert"><AlignCenter className="h-4 w-4" /></TB>
          <TB onClick={() => editor.chain().focus().setTextAlign("right").run()} active={editor.isActive({ textAlign: "right" })} tooltip="Rechtsbündig"><AlignRight className="h-4 w-4" /></TB>
          <TB onClick={() => editor.chain().focus().setTextAlign("justify").run()} active={editor.isActive({ textAlign: "justify" })} tooltip="Blocksatz"><AlignJustify className="h-4 w-4" /></TB>
          <LineSpacingControl editor={editor} />
          <span className="w-px h-5 bg-border mx-1" />
          <TB onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive("bulletList")} tooltip="Aufzählung"><List className="h-4 w-4" /></TB>
          <TB onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive("orderedList")} tooltip="Nummerierung"><ListOrdered className="h-4 w-4" /></TB>
          <TB onClick={() => editor.chain().focus().toggleTaskList().run()} active={editor.isActive("taskList")} tooltip="Checkliste"><ListChecks className="h-4 w-4" /></TB>
          <TB onClick={() => indent(-1)} disabled={!inList} tooltip="Einzug verkleinern"><Outdent className="h-4 w-4" /></TB>
          <TB onClick={() => indent(1)} disabled={!inList} tooltip="Einzug vergrössern"><Indent className="h-4 w-4" /></TB>
          <span className="w-px h-5 bg-border mx-1" />
          <TB onClick={editLink} active={editor.isActive("link")} tooltip="Link einfügen"><LinkIcon className="h-4 w-4" /></TB>
          {editor.isActive("link") && (
            <TB onClick={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()} tooltip="Link entfernen"><Unlink className="h-4 w-4" /></TB>
          )}
          <TB onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} active={inTable} tooltip="Tabelle einfügen"><TableIcon className="h-4 w-4" /></TB>
          {inTable && (
            <>
              <TB onClick={() => editor.chain().focus().addRowAfter().run()} tooltip="Zeile darunter"><span className="flex items-center text-[10px] font-medium"><Plus className="h-3 w-3" />Z</span></TB>
              <TB onClick={() => editor.chain().focus().deleteRow().run()} tooltip="Zeile löschen"><span className="flex items-center text-[10px] font-medium"><Minus className="h-3 w-3" />Z</span></TB>
              <TB onClick={() => editor.chain().focus().addColumnAfter().run()} tooltip="Spalte rechts"><span className="flex items-center text-[10px] font-medium"><Plus className="h-3 w-3" />S</span></TB>
              <TB onClick={() => editor.chain().focus().deleteColumn().run()} tooltip="Spalte löschen"><span className="flex items-center text-[10px] font-medium"><Minus className="h-3 w-3" />S</span></TB>
              <TB onClick={() => editor.chain().focus().deleteTable().run()} tooltip="Tabelle löschen"><Trash2 className="h-4 w-4" /></TB>
            </>
          )}
        </div>
      )}
      {!canWrite && (
        <div className="livedoc-chrome bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-800 px-4 py-1.5 text-[12px] text-amber-800 dark:text-amber-200">
          Nur Lesen — logge dich beim Projekt ein («Einloggen»), um mitzuschreiben.
        </div>
      )}

      {/* ─── Das Blatt ─────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto py-8 px-3">
        <div className="livedoc-sheet mx-auto shadow-[0_2px_12px_rgba(0,0,0,0.18)]" onClick={() => editor?.chain().focus().run()}>
          <EditorContent editor={editor} />
        </div>
      </div>

      {/* ─── Verlauf-Modal ─────────────────────────────────────── */}
      {showVersions && (
        <Modal open onClose={() => { setShowVersions(false); setPreviewVersion(null); }} title={previewVersion ? `Stand vom ${fmtTime(previewVersion.created_at)}` : "Verlauf"} size="lg">
          {previewVersion ? (
            <div className="space-y-3">
              <div className="max-h-[55vh] overflow-auto border border-border rounded-lg p-6" style={{ background: "#fff" }}>
                <div className="livedoc-content" dangerouslySetInnerHTML={{ __html: previewVersion.content_html }} />
              </div>
              <div className="flex justify-between">
                <button type="button" className="kasten kasten-muted" onClick={() => setPreviewVersion(null)}>
                  <ArrowLeft className="h-3.5 w-3.5" /> Zurück zur Liste
                </button>
                {canWrite && (
                  <button type="button" className="kasten kasten-red" onClick={() => restoreVersion(previewVersion)}>
                    <History className="h-3.5 w-3.5" /> Wiederherstellen
                  </button>
                )}
              </div>
            </div>
          ) : versions === null ? (
            <div className="py-8 text-center text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Laden…</div>
          ) : versions.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Noch keine Versionen — sie entstehen automatisch beim Schreiben.</p>
          ) : (
            <ul className="divide-y divide-border max-h-[55vh] overflow-auto">
              {versions.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    onClick={() => setPreviewVersion(v)}
                    className="w-full text-left px-2 py-2.5 rounded-md hover:bg-foreground/[0.05] dark:hover:bg-foreground/[0.12] flex items-center justify-between gap-3"
                  >
                    <span className="text-sm">{fmtTime(v.created_at)}</span>
                    <span className="text-[11px] text-muted-foreground">{v.author ?? "—"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
      {ConfirmModalElement}
      {PromptModalElement}
    </div>
  );
}
