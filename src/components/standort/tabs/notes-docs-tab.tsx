"use client";

/**
 * Standort-Detail: Tab "Notizen & Dokumente".
 *
 * Notizen — Ort fuer das Standort-Wissen: Tuerschluessel-Code, WLAN-Passwort,
 * Ansprech-Notizen, "Lampe C3 defekt", externe Links (Dropbox, Kalender).
 * Wichtiges kann per Pin auf den Uebersichts-Tab gehoben werden — dann
 * sehen alle es sofort beim Oeffnen des Standorts.
 *
 * Dokumente — PDFs/Bilder mit Preview + Download.
 *
 * Layout: auf md+ zwei Spalten, auf mobil untereinander.
 */

import { useMemo, useRef, useState } from "react";
import { useConfirm } from "@/components/ui/use-confirm";
import { PdfPopup } from "@/components/pdf-popup";
import {
  FileText, Trash2, Plus, Upload, Download, Eye, Pin, PinOff, Link as LinkIcon,
  StickyNote, Check, X, Pencil,
} from "lucide-react";
import type { Note, DocEntry } from "./use-standort-data";

type Props = {
  notes: Note[];
  docs: DocEntry[];
  canEdit: boolean;
  onAddNote: (content: string) => Promise<boolean>;
  onDeleteNote: (noteId: string) => Promise<void>;
  onTogglePinNote: (noteId: string) => Promise<void>;
  onUpdateNote: (noteId: string, content: string) => Promise<void>;
  onUploadDoc: (file: File) => Promise<boolean>;
  onDeleteDoc: (doc: { name: string; path: string }) => Promise<void>;
  onGetDocSignedUrl: (path: string) => Promise<string | null>;
};

function isUrl(s: string): boolean {
  return /^https?:\/\/\S+/i.test(s.trim());
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function NotesDocsTab({
  notes,
  docs,
  canEdit,
  onAddNote,
  onDeleteNote,
  onTogglePinNote,
  onUpdateNote,
  onUploadDoc,
  onDeleteDoc,
  onGetDocSignedUrl,
}: Props) {
  const { confirm, ConfirmModalElement } = useConfirm();
  const [newNoteText, setNewNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const docRef = useRef<HTMLInputElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<{ url: string; title: string } | null>(null);

  // Sortierung: gepinnt zuerst, dann neueste. Innerhalb der Gruppen nach
  // created_at absteigend.
  const sortedNotes = useMemo(() => {
    return [...notes].sort((a, b) => {
      const pa = a.pinned ? 1 : 0;
      const pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (b.created_at ?? "").localeCompare(a.created_at ?? "");
    });
  }, [notes]);

  async function handleAddNote() {
    if (!newNoteText.trim() || savingNote) return;
    setSavingNote(true);
    const ok = await onAddNote(newNoteText);
    setSavingNote(false);
    if (ok) setNewNoteText("");
  }

  async function handleDeleteNote(n: Note) {
    const ok = await confirm({
      title: "Notiz löschen?",
      message: n.content.length > 60 ? `"${n.content.slice(0, 60)}…"` : `"${n.content}"`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    await onDeleteNote(n.id);
  }

  async function handleUploadDoc(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingDoc(true);
    await onUploadDoc(file);
    setUploadingDoc(false);
    e.target.value = "";
  }

  async function handleDeleteDoc(doc: DocEntry) {
    const ok = await confirm({
      title: "Dokument löschen?",
      message: `"${doc.name}" wird entfernt.`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    await onDeleteDoc(doc);
  }

  async function openDocPreview(doc: DocEntry) {
    const url = await onGetDocSignedUrl(doc.path);
    if (url) setPreviewDoc({ url, title: doc.name });
  }

  async function downloadDoc(doc: DocEntry) {
    const url = await onGetDocSignedUrl(doc.path);
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.name;
    a.click();
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* ─── Notizen ─────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-border bg-card overflow-hidden">
        <header className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <StickyNote className="h-4 w-4 text-muted-foreground" />
              Notizen
              <span className="text-[10px] font-normal text-muted-foreground">({notes.length})</span>
            </h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Codes, Passwörter, Ansprech-Notizen. <Pin className="inline h-2.5 w-2.5 mb-0.5 fill-amber-400 text-amber-500" strokeWidth={2.5} /> pinnen = auf der Übersicht sichtbar.
            </p>
          </div>
        </header>

        <div className="p-3 space-y-2">
          {/* Neue Notiz */}
          {canEdit && (
            <div className="rounded-xl border border-border bg-muted/20 p-2.5 focus-within:border-foreground/40 transition-colors">
              <textarea
                value={newNoteText}
                onChange={(e) => setNewNoteText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    handleAddNote();
                  }
                }}
                placeholder="Neue Notiz oder Link…"
                rows={2}
                className="w-full px-1 py-0.5 text-sm bg-transparent resize-none focus:outline-none placeholder:text-muted-foreground/60"
                style={{ fieldSizing: "content" } as React.CSSProperties}
              />
              <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t border-border/50">
                <span className="text-[10px] text-muted-foreground">
                  Strg+Enter zum Speichern
                </span>
                <button
                  type="button"
                  onClick={handleAddNote}
                  disabled={!newNoteText.trim() || savingNote}
                  className="kasten kasten-red disabled:opacity-40"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {savingNote ? "Speichert…" : "Hinzufügen"}
                </button>
              </div>
            </div>
          )}

          {/* Liste */}
          {sortedNotes.length === 0 ? (
            <div className="text-center py-10">
              <div className="mx-auto w-11 h-11 rounded-xl bg-muted flex items-center justify-center mb-2">
                <StickyNote className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">Noch keine Notizen</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto leading-relaxed">
                Beispiele: „Türschlüssel-Code 4523", „WLAN: SCALA-Gast / Passwort xyz", Dropbox-Link zum Grundriss.
              </p>
            </div>
          ) : (
            sortedNotes.map((n) => (
              <NoteCard
                key={n.id}
                note={n}
                canEdit={canEdit}
                editing={editingId === n.id}
                onStartEdit={() => setEditingId(n.id)}
                onCancelEdit={() => setEditingId(null)}
                onSaveEdit={async (content) => { await onUpdateNote(n.id, content); setEditingId(null); }}
                onTogglePin={() => onTogglePinNote(n.id)}
                onDelete={() => handleDeleteNote(n)}
              />
            ))
          )}
        </div>
      </section>

      {/* ─── Dokumente ───────────────────────────────────────────── */}
      <section className="rounded-2xl border border-border bg-card overflow-hidden">
        <header className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              Dokumente
              <span className="text-[10px] font-normal text-muted-foreground">({docs.length})</span>
            </h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              PDFs, Grundrisse, Übergabeprotokolle, Fotos.
            </p>
          </div>
          {canEdit && (
            <button
              type="button"
              onClick={() => docRef.current?.click()}
              disabled={uploadingDoc}
              className="kasten kasten-red"
            >
              <Upload className="h-3.5 w-3.5" />
              {uploadingDoc ? "Lade…" : "Upload"}
            </button>
          )}
          <input
            ref={docRef}
            type="file"
            accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png"
            onChange={handleUploadDoc}
            className="hidden"
          />
        </header>

        <div className="p-3 space-y-2">
          {docs.length === 0 ? (
            <div className="text-center py-10">
              <div className="mx-auto w-11 h-11 rounded-xl bg-muted flex items-center justify-center mb-2">
                <FileText className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">Noch keine Dokumente</p>
              <p className="text-xs text-muted-foreground mt-1">
                PDF, Bilder oder Office-Dateien hochladen.
              </p>
            </div>
          ) : (
            docs.map((d) => (
              <div
                key={d.path}
                className="group flex items-center gap-3 p-2.5 rounded-xl border border-border bg-muted/20 hover:bg-muted/40 transition-colors"
              >
                <div className="w-9 h-9 shrink-0 rounded-lg bg-red-50 dark:bg-red-500/15 text-red-600 dark:text-red-400 flex items-center justify-center">
                  <FileText className="h-4 w-4" />
                </div>
                <button
                  onClick={() => openDocPreview(d)}
                  className="flex-1 min-w-0 text-left"
                >
                  <p className="text-sm font-medium truncate group-hover:text-foreground">{d.name}</p>
                  <p className="text-[11px] text-muted-foreground">{fmtDate(d.uploaded_at)}</p>
                </button>
                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    onClick={() => openDocPreview(d)}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06]"
                    data-tooltip="Vorschau"
                    aria-label="Vorschau"
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => downloadDoc(d)}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06]"
                    data-tooltip="Herunterladen"
                    aria-label="Herunterladen"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                  {canEdit && (
                    <button
                      onClick={() => handleDeleteDoc(d)}
                      className="p-1.5 rounded-md text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10"
                      data-tooltip="Löschen"
                      aria-label="Löschen"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

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

/* --------------------------------------------------------------- */
function NoteCard({
  note, canEdit, editing, onStartEdit, onCancelEdit, onSaveEdit, onTogglePin, onDelete,
}: {
  note: Note;
  canEdit: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (content: string) => Promise<void>;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(note.content);
  const url = isUrl(note.content);

  if (editing) {
    return (
      <div
        className="rounded-xl border-2 p-2.5"
        style={{ borderColor: "var(--foreground)" }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          autoFocus
          className="w-full px-1 py-0.5 text-sm bg-transparent resize-none focus:outline-none"
          style={{ fieldSizing: "content" } as React.CSSProperties}
        />
        <div className="flex items-center justify-end gap-1.5 mt-1.5 pt-1.5 border-t border-border/50">
          <button type="button" onClick={onCancelEdit} className="kasten kasten-muted">
            <X className="h-3.5 w-3.5" />
            Abbrechen
          </button>
          <button
            type="button"
            onClick={() => onSaveEdit(draft)}
            disabled={!draft.trim() || draft === note.content}
            className="kasten kasten-red"
          >
            <Check className="h-3.5 w-3.5" />
            Speichern
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`group relative flex items-start gap-2.5 p-3 rounded-xl border transition-colors ${
        note.pinned
          ? "border-amber-300/50 bg-amber-50/40 dark:bg-amber-500/[0.06] dark:border-amber-500/25"
          : "border-border bg-muted/20 hover:bg-muted/40"
      }`}
    >
      {/* Icon links: Link/StickyNote, bei pinned mit gelbem BG */}
      <div
        className="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center"
        style={{
          backgroundColor: note.pinned ? "rgba(245,158,11,0.15)" : "rgba(0,0,0,0.05)",
          color: note.pinned ? "rgb(154,90,10)" : "var(--muted-foreground)",
        }}
      >
        {url ? <LinkIcon className="h-3.5 w-3.5" /> : <StickyNote className="h-3.5 w-3.5" />}
      </div>

      {/* Inhalt */}
      <div className="min-w-0 flex-1">
        {url ? (
          <a
            href={note.content}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline break-all"
          >
            {note.content}
          </a>
        ) : (
          <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">{note.content}</p>
        )}
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-[10px] text-muted-foreground">{fmtDate(note.created_at)}</span>
          {note.pinned && (
            <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-300">
              <Pin className="h-2.5 w-2.5 fill-current" strokeWidth={2.5} />
              Gepinnt
            </span>
          )}
        </div>
      </div>

      {/* Aktionen — meist versteckt, sichtbar beim Hover */}
      {canEdit && (
        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={onTogglePin}
            className={`p-1.5 rounded-md transition-colors ${
              note.pinned
                ? "text-amber-600 hover:bg-amber-100 dark:hover:bg-amber-500/15"
                : "text-muted-foreground hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-500/10"
            }`}
            data-tooltip={note.pinned ? "Pin entfernen" : "Auf Übersicht pinnen"}
            aria-label={note.pinned ? "Pin entfernen" : "Auf Übersicht pinnen"}
          >
            {note.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          </button>
          {!url && (
            <button
              type="button"
              onClick={onStartEdit}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06]"
              data-tooltip="Bearbeiten"
              aria-label="Bearbeiten"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            className="p-1.5 rounded-md text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10"
            data-tooltip="Löschen"
            aria-label="Löschen"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
