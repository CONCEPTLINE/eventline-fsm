"use client";

/**
 * DocsHistoryTab -- Dokumente + Historie (inkl. Genehmigungs-/Abschluss-
 * Kommentar). Der Genehmigungs-Kommentar wird HIER geloest, und NIRGENDS
 * sonst mehr angezeigt (frueher gab es ihn doppelt in BudgetCard +
 * HistoryCard -- BudgetCard ist mit dem Refactor komplett entfernt).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/use-confirm";
import {
  DocFolderMove,
  DocFolderTag,
  collectFolders,
  folderForUpload,
  matchesFolder,
  type ActiveFolder,
} from "@/components/ui/doc-folders";
import { PdfPopup } from "@/components/pdf-popup";
import { DocFolderList, istDateiDrag } from "@/components/ui/doc-folder-list";
import {
  Paperclip, FileText, Loader2, Trash2, Eye, Download, History,
  ArrowLeft, ArrowRight, Link2, Plus, ExternalLink, Files, FolderOpen,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { formatDateFull } from "@/lib/format";
import { toast } from "sonner";
import { deleteRow, updateRow } from "@/lib/db-mutations";
import { validateFileList } from "@/lib/file-upload";
import { PROJECT_STATUS_LABEL, formatProjectNumber } from "@/lib/projekte-format";
import type { AuditEntry, Child, Project } from "../types";
import { LiveDocsSection } from "../live-doc/live-docs-section";

/* ============================================================
   DOCUMENTS
   ============================================================ */

interface DocRow {
  id: string;
  name: string;
  storage_path: string;
  file_size: number | null;
  mime_type: string | null;
  created_at: string;
  uploaded_by: string;
  uploader?: { full_name: string | null } | null;
  /** Ordner-Name (eine Ebene, Migration 227). null = Hauptordner. */
  folder?: string | null;
}

function ProjectDocuments({ projectId, isAdmin, canUpload, nurLesen }: {
  projectId: string;
  isAdmin: boolean;
  canUpload: boolean;
  /** Archiviertes Projekt (src/lib/archiv.ts): auch kein Loeschen mehr. */
  nurLesen: boolean;
}) {
  const supabase = createClient();
  const { confirm, ConfirmModalElement } = useConfirm();
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [me, setMe] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<{ url: string; title: string } | null>(null);

  // Ordner (eine Ebene, Attribut pro Dokument — siehe doc-folders.tsx).
  // Leere Ordner sind seit Migration 386 in project_doc_ordner gespeichert.
  // Gewaehlter Ordner steht in der URL (?ordner=, «-» = Hauptordner) und
  // ueberlebt so einen Reload.
  const [activeFolder, setActiveFolderState] = useState<ActiveFolder>(() => {
    if (typeof window === "undefined") return null;
    const v = new URLSearchParams(window.location.search).get("ordner");
    return v === null ? null : v === "-" ? "" : v;
  });
  const setActiveFolder = useCallback((next: ActiveFolder) => {
    setActiveFolderState(next);
    const url = new URL(window.location.href);
    if (next === null) url.searchParams.delete("ordner");
    else url.searchParams.set("ordner", next === "" ? "-" : next);
    window.history.replaceState(window.history.state, "", url.toString());
  }, []);
  const [gespeicherteOrdner, setGespeicherteOrdner] = useState<{ id: string; name: string }[]>([]);
  const [ordnerGeladen, setOrdnerGeladen] = useState(false);
  const [dropAktiv, setDropAktiv] = useState(false);

  const folders = useMemo(
    () => collectFolders(docs.map((d) => d.folder), gespeicherteOrdner.map((o) => o.name)),
    [docs, gespeicherteOrdner],
  );
  const mainCount = useMemo(() => docs.filter((d) => !d.folder).length, [docs]);
  const visibleDocs = useMemo(
    () => docs.filter((d) => matchesFolder(d.folder, activeFolder)),
    [docs, activeFolder],
  );

  useEffect(() => {
    if (!loading && ordnerGeladen && activeFolder && !folders.some((f) => f.name === activeFolder)) {
      setActiveFolder(null);
    }
  }, [activeFolder, folders, loading, ordnerGeladen, setActiveFolder]);

  async function previewDocInBrowser(doc: DocRow) {
    const { data, error } = await supabase.storage.from("documents").createSignedUrl(doc.storage_path, 3600);
    if (error || !data?.signedUrl) { toast.error("Datei nicht verfügbar"); return; }
    setPreviewDoc({ url: data.signedUrl, title: doc.name });
  }
  async function downloadDoc(doc: DocRow) {
    const { data, error } = await supabase.storage.from("documents").createSignedUrl(doc.storage_path, 3600);
    if (error || !data?.signedUrl) { toast.error("Datei nicht verfügbar"); return; }
    const a = document.createElement("a");
    a.href = data.signedUrl;
    a.download = doc.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    setMe(user?.id ?? null);
    const { data } = await supabase
      .from("documents")
      .select("id, name, storage_path, file_size, mime_type, created_at, uploaded_by, folder, uploader:profiles!documents_uploaded_by_fkey(full_name)")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    setDocs((data ?? []).map((d) => ({ ...d, uploader: Array.isArray(d.uploader) ? d.uploader[0] : d.uploader })) as DocRow[]);
    const { data: ordner, error: ordnerErr } = await supabase
      .from("project_doc_ordner")
      .select("id, name")
      .eq("project_id", projectId);
    if (ordnerErr) toast.error("Ordner konnten nicht geladen werden: " + ordnerErr.message);
    setGespeicherteOrdner((ordner ?? []) as { id: string; name: string }[]);
    setOrdnerGeladen(true);
    setLoading(false);
  }, [supabase, projectId]);

  useEffect(() => { load(); }, [load]);

  async function handleFiles(files: FileList | null, ziel?: string) {
    if (!files || files.length === 0) return;
    const validated = validateFileList(files);
    if (!validated) return;
    setUploading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setUploading(false); return; }
    let ok = 0, fail = 0;
    for (const file of validated) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `projekte/${projectId}/${Date.now()}_${safeName}`;
      try {
        const fd = new FormData(); fd.append("file", file); fd.append("path", path);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const j = await res.json();
        if (!j.success) { fail++; continue; }
        const { error } = await supabase.from("documents").insert({
          name: file.name, storage_path: path, file_size: file.size, mime_type: file.type,
          project_id: projectId, uploaded_by: user.id,
          // Upload landet im Ziel-Ordner (auf Ordner gezogen) bzw. im aktiven
          // Ordner (bei "Alle" → Hauptordner). "" = Hauptordner.
          folder: ziel !== undefined ? (ziel || null) : folderForUpload(activeFolder),
        });
        if (error) fail++; else ok++;
      } catch { fail++; }
    }
    setUploading(false);
    if (ok > 0) toast.success(`${ok} Datei(en) hochgeladen`);
    if (fail > 0) toast.error(`${fail} Datei(en) fehlgeschlagen`);
    load();
  }

  async function ordnerAnlegen(name: string) {
    const { data, error } = await supabase.from("project_doc_ordner").insert({ project_id: projectId, name, created_by: me }).select("id, name").single();
    if (error || !data) { toast.error("Ordner konnte nicht angelegt werden: " + (error?.message ?? "?")); return; }
    setGespeicherteOrdner((prev) => [...prev, data as { id: string; name: string }]);
    setActiveFolder(name);
  }

  async function ordnerLoeschen(name: string) {
    if (docs.some((d) => d.folder === name)) { toast.error("Der Ordner ist nicht leer."); return; }
    const ok = await confirm({
      title: "Ordner löschen?",
      message: `Der leere Ordner «${name}» wird entfernt.`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    const eintrag = gespeicherteOrdner.find((o) => o.name === name);
    if (eintrag) {
      const result = await deleteRow("project_doc_ordner", eintrag.id);
      if (!result.ok) { toast.error("Löschen fehlgeschlagen: " + (result.error ?? "Unbekannter Fehler")); return; }
    }
    setGespeicherteOrdner((prev) => prev.filter((o) => o.name !== name));
    if (activeFolder === name) setActiveFolder(null);
    toast.success("Ordner gelöscht");
  }

  async function moveDoc(doc: DocRow, folder: string | null) {
    const result = await updateRow("documents", doc.id, { folder });
    if (!result.ok) {
      toast.error("Verschieben fehlgeschlagen: " + (result.error ?? "Unbekannter Fehler"));
      return;
    }
    setDocs((prev) => prev.map((d) => (d.id === doc.id ? { ...d, folder } : d)));
    toast.success(folder ? `In «${folder}» verschoben` : "In den Hauptordner verschoben");
  }

  async function deleteDoc(doc: DocRow) {
    const ok = await confirm({
      title: "Dokument löschen?",
      message: `"${doc.name}" wird unwiderruflich entfernt.`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    // Erst die Zeile (die DB kann ablehnen, z.B. Archiv = nur lesen), dann
    // die Datei — sonst bliebe eine Zeile ohne Datei zurueck.
    const result = await deleteRow("documents", doc.id);
    if (!result.ok) { toast.error("Löschen fehlgeschlagen: " + (result.error ?? "Unbekannter Fehler")); return; }
    await supabase.storage.from("documents").remove([doc.storage_path]);
    toast.success("Gelöscht");
    load();
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Paperclip className="h-4 w-4 text-muted-foreground" />
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex-1">Dokumente ({docs.length})</p>
        </div>
        <div className="flex flex-col md:flex-row gap-4">
          {!loading && (folders.length > 0 || canUpload) && (
            <div className="md:w-64 shrink-0 md:border-r md:border-border md:pr-4">
              <DocFolderList
                folders={folders}
                mainCount={mainCount}
                totalCount={docs.length}
                active={activeFolder}
                onSelect={setActiveFolder}
                onCreate={ordnerAnlegen}
                onDelete={ordnerLoeschen}
                onDropFiles={(folder, files) => handleFiles(files, folder)}
                canCreate={canUpload}
              />
            </div>
          )}
          <div
            className="flex-1 min-w-0 space-y-2 rounded-xl transition-colors"
            onDragOver={canUpload ? (e) => { if (!istDateiDrag(e)) return; e.preventDefault(); setDropAktiv(true); } : undefined}
            onDragLeave={canUpload ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAktiv(false); } : undefined}
            onDrop={canUpload ? (e) => {
              if (!istDateiDrag(e)) return;
              e.preventDefault();
              setDropAktiv(false);
              if (!uploading && e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
            } : undefined}
          >
        {!loading && folders.length > 0 && (
          <div className="flex items-center gap-1.5 min-w-0">
            {activeFolder === null
              ? <Files className="h-4 w-4 shrink-0 text-muted-foreground" />
              : <FolderOpen className="h-4 w-4 shrink-0 text-amber-500 dark:text-amber-400" />}
            <span className="text-sm font-semibold truncate">
              {activeFolder === null ? "Alle Dokumente" : activeFolder === "" ? "Hauptordner" : activeFolder}
            </span>
            <span className="text-xs text-muted-foreground shrink-0">· {visibleDocs.length}</span>
          </div>
        )}
        {canUpload && (
          <label
            className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-dashed text-sm transition-colors cursor-pointer"
            style={{
              background: dropAktiv ? "color-mix(in srgb, var(--accent) 10%, transparent)" : "color-mix(in srgb, var(--muted) 20%, transparent)",
              borderColor: dropAktiv ? "var(--accent)" : undefined,
              color: dropAktiv ? "var(--foreground)" : "var(--muted-foreground)",
            }}
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
            {uploading
              ? "Lädt hoch…"
              : dropAktiv
              ? `Loslassen zum Hochladen${activeFolder ? ` in «${activeFolder}»` : ""}`
              : `Dateien hierher ziehen oder auswählen…${activeFolder ? ` (in «${activeFolder}»)` : ""}`}
            <input type="file" multiple className="sr-only" disabled={uploading} onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
          </label>
        )}
        {loading ? (
          <p className="text-xs text-muted-foreground italic">Lädt…</p>
        ) : docs.length === 0 ? (
          !canUpload && <p className="text-xs text-muted-foreground italic">Keine Dokumente.</p>
        ) : visibleDocs.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            Keine Dokumente in diesem Ordner — der nächste Upload landet hier.
          </p>
        ) : (
          <div className="space-y-1">
            {visibleDocs.map((d) => (
              <div key={d.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/20 text-sm">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <button onClick={() => previewDocInBrowser(d)} className="flex-1 min-w-0 text-left hover:underline">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="truncate">{d.name}</span>
                    {activeFolder === null && <DocFolderTag folder={d.folder} />}
                  </span>
                  <span className="block text-[10px] text-muted-foreground">
                    {d.file_size ? `${(d.file_size / 1024).toFixed(0)} KB · ` : ""}
                    {d.uploader?.full_name ?? "—"} · {new Date(d.created_at).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}
                  </span>
                </button>
                <div className="flex items-center gap-1 shrink-0">
                  {canUpload && (
                    <DocFolderMove
                      folders={folders.map((f) => f.name)}
                      current={d.folder ?? null}
                      onMove={(folder) => moveDoc(d, folder)}
                      buttonClassName="kasten kasten-muted !py-1 !px-2"
                    />
                  )}
                  <button onClick={() => previewDocInBrowser(d)} className="kasten kasten-blue !py-1 !px-2" data-tooltip="Vorschau" aria-label="Vorschau">
                    <Eye className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => downloadDoc(d)} className="kasten kasten-muted !py-1 !px-2" data-tooltip="Herunterladen" aria-label="Herunterladen">
                    <Download className="h-3.5 w-3.5" />
                  </button>
                  {!nurLesen && (isAdmin || me === d.uploaded_by) && (
                    <button onClick={() => deleteDoc(d)} className="kasten kasten-red !py-1 !px-2" data-tooltip="Löschen" aria-label="Löschen">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
          </div>
        </div>
        {ConfirmModalElement}
        {previewDoc && (
          <PdfPopup url={previewDoc.url} title={previewDoc.title} onClose={() => setPreviewDoc(null)} />
        )}
      </CardContent>
    </Card>
  );
}

/* ============================================================
   LINKS (Migration 385)
   ============================================================ */

interface LinkRow {
  id: string;
  titel: string;
  url: string;
  created_at: string;
  created_by: string | null;
  ersteller?: { full_name: string | null } | null;
}

/** Eingabe zu einer http(s)-Adresse machen; ohne Schema → https://. null = ungültig. */
function normalisiereUrl(roh: string): string | null {
  const t = roh.trim();
  if (!t || /\s/.test(t)) return null;
  const mitSchema = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(mitSchema);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".") && u.hostname !== "localhost") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function hostVon(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function ProjectLinks({ projectId, isAdmin, canEdit, nurLesen }: {
  projectId: string;
  isAdmin: boolean;
  canEdit: boolean;
  /** Archiviertes Projekt: nur lesen. */
  nurLesen: boolean;
}) {
  const supabase = createClient();
  const { confirm, ConfirmModalElement } = useConfirm();
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<string | null>(null);
  const [formOffen, setFormOffen] = useState(false);
  const [titel, setTitel] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const darfAnlegen = canEdit && !nurLesen;

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    setMe(user?.id ?? null);
    const { data, error } = await supabase
      .from("project_links")
      .select("id, titel, url, created_at, created_by, ersteller:profiles!project_links_created_by_fkey(full_name)")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    if (error) toast.error("Links konnten nicht geladen werden: " + error.message);
    setLinks((data ?? []).map((l) => ({ ...l, ersteller: Array.isArray(l.ersteller) ? l.ersteller[0] : l.ersteller })) as LinkRow[]);
    setLoading(false);
  }, [supabase, projectId]);

  // queueMicrotask: kein synchroner setState im Effekt (react-hooks/set-state-in-effect).
  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  function schliessen() {
    setFormOffen(false);
    setTitel("");
    setUrl("");
  }

  async function speichern() {
    const t = titel.trim();
    const u = normalisiereUrl(url);
    if (!t) { toast.error("Bitte einen Titel eingeben."); return; }
    if (!u) { toast.error("Bitte eine gültige Adresse eingeben (z. B. https://…)."); return; }
    setSaving(true);
    const { error } = await supabase.from("project_links").insert({ project_id: projectId, titel: t, url: u, created_by: me });
    setSaving(false);
    if (error) { toast.error("Link konnte nicht gespeichert werden: " + error.message); return; }
    toast.success("Link hinzugefügt");
    schliessen();
    load();
  }

  async function loeschen(l: LinkRow) {
    const ok = await confirm({
      title: "Link entfernen?",
      message: `«${l.titel}» wird aus dem Projekt entfernt.`,
      confirmLabel: "Entfernen",
      variant: "red",
    });
    if (!ok) return;
    const result = await deleteRow("project_links", l.id);
    if (!result.ok) { toast.error("Entfernen fehlgeschlagen: " + (result.error ?? "Unbekannter Fehler")); return; }
    toast.success("Link entfernt");
    load();
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-muted-foreground" />
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex-1">Links ({links.length})</p>
          {darfAnlegen && !formOffen && (
            <button onClick={() => setFormOffen(true)} className="kasten kasten-muted !py-1 !px-2">
              <Plus className="h-3.5 w-3.5" /> Link
            </button>
          )}
        </div>
        {formOffen && (
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              autoFocus
              value={titel}
              onChange={(e) => setTitel(e.target.value)}
              placeholder="Titel"
              maxLength={200}
              className="h-8 text-sm sm:w-56"
            />
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); speichern(); } }}
              placeholder="https://…"
              inputMode="url"
              className="h-8 text-sm flex-1"
            />
            <div className="flex gap-2 shrink-0">
              <button onClick={speichern} disabled={saving} className="kasten kasten-green">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                {saving ? "Speichert…" : "Hinzufügen"}
              </button>
              <button onClick={schliessen} disabled={saving} className="kasten kasten-muted">Abbrechen</button>
            </div>
          </div>
        )}
        {loading ? (
          <p className="text-xs text-muted-foreground italic">Lädt…</p>
        ) : links.length === 0 ? (
          !formOffen && <p className="text-xs text-muted-foreground italic">Keine Links.</p>
        ) : (
          <div className="space-y-1">
            {links.map((l) => (
              <div key={l.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/20 text-sm">
                <Link2 className="h-4 w-4 text-muted-foreground shrink-0" />
                <a href={l.url} target="_blank" rel="noopener noreferrer" className="flex-1 min-w-0 hover:underline">
                  <span className="block truncate">{l.titel}</span>
                  <span className="block text-[10px] text-muted-foreground truncate">
                    {hostVon(l.url)} · {l.ersteller?.full_name ?? "—"} · {formatDateFull(l.created_at)}
                  </span>
                </a>
                <div className="flex items-center gap-1 shrink-0">
                  <a href={l.url} target="_blank" rel="noopener noreferrer" className="kasten kasten-blue !py-1 !px-2" data-tooltip="Öffnen" aria-label="Öffnen">
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                  {!nurLesen && (isAdmin || me === l.created_by) && (
                    <button onClick={() => loeschen(l)} className="kasten kasten-red !py-1 !px-2" data-tooltip="Entfernen" aria-label="Entfernen">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {ConfirmModalElement}
      </CardContent>
    </Card>
  );
}

/* ============================================================
   HISTORY
   ============================================================ */

function HistoryCard({ project, children_, audit }: { project: Project; children_: Child[]; audit: AuditEntry[] }) {
  const hasContent =
    project.parent || children_.length > 0 || audit.length > 0 ||
    project.decision_note || project.completion_note;
  if (!hasContent) return null;
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Historie</p>
        </div>

        {/* Genehmigungs- / Abschluss-Kommentare -- EINMAL, nur hier.
            decision_note traegt je nach Entscheid den Genehmigungs-Kommentar,
            den Ablehnungs- oder den Storno-Grund (cancel_project, Mig. 189). */}
        {project.decision_note && (
          <div className="p-2 rounded-lg bg-muted/20 text-[11px]">
            <p className="text-muted-foreground/70 mb-0.5">
              {project.status === "storniert"
                ? "Storno-Begründung:"
                : project.status === "abgelehnt"
                  ? "Begründung der Ablehnung:"
                  : "Genehmigungs-Kommentar:"}
            </p>
            <p>{project.decision_note}</p>
            {project.approver?.full_name && project.approved_at && (
              <p className="text-muted-foreground/60 mt-1">
                {project.approver.full_name} · {new Date(project.approved_at).toLocaleString("de-CH", { timeZone: "Europe/Zurich" })}
              </p>
            )}
          </div>
        )}
        {project.completion_note && (
          <div className="p-2 rounded-lg bg-muted/20 text-[11px]">
            <p className="text-muted-foreground/70 mb-0.5">Abschluss-Notiz:</p>
            <p>{project.completion_note}</p>
          </div>
        )}

        {project.parent && (
          <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/20 text-sm">
            <ArrowLeft className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] text-muted-foreground">Vorgänger</p>
              <Link href={`/projekte/${project.parent.id}`} className="font-medium truncate hover:underline">
                {formatProjectNumber(project.parent.project_number)} · {project.parent.title}
              </Link>
            </div>
          </div>
        )}
        {children_.length > 0 && (
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground">Folgeprojekte:</p>
            {children_.map((c) => {
              const s = PROJECT_STATUS_LABEL[c.status as keyof typeof PROJECT_STATUS_LABEL];
              return (
                <Link key={c.id} href={`/projekte/${c.id}`} className="flex items-center gap-2 p-2 rounded-lg bg-muted/20 text-sm hover:bg-muted/40 transition-colors">
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-mono text-[10px] text-muted-foreground">{formatProjectNumber(c.project_number)}</span>
                    <span className="mx-1">·</span>
                    <span className="font-medium">{c.title}</span>
                  </span>
                  <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded-full ${s?.color ?? ""}`}>{s?.label ?? c.status}</span>
                </Link>
              );
            })}
          </div>
        )}

        {audit.length > 0 && (
          <div className="space-y-1 pt-2 border-t border-border/60">
            <p className="text-[10px] text-muted-foreground">Änderungen:</p>
            {audit.map((a) => (
              <div key={a.id} className="p-2 rounded-lg bg-muted/20 text-xs">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold">
                    {a.kind === "budget" ? "Budget geändert" : a.kind === "status" ? "Status geändert" : "Zuweisung geändert"}
                  </span>
                  {a.old_value != null && (
                    <span className="text-muted-foreground tabular-nums">{a.old_value} → <strong>{a.new_value}</strong></span>
                  )}
                </div>
                {a.reason && <p className="text-muted-foreground mt-0.5">{a.reason}</p>}
                <p className="text-muted-foreground/60 text-[10px] mt-0.5">
                  {a.changer?.full_name ?? "—"} · {new Date(a.created_at).toLocaleString("de-CH", { timeZone: "Europe/Zurich" })}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================================================
   DOCS + HISTORIE TAB (Export)
   ============================================================ */

export function DocsHistoryTab({
  project, children_, audit, isAdmin, canEdit, nurLesen = false,
}: {
  project: Project;
  children_: Child[];
  audit: AuditEntry[];
  isAdmin: boolean;
  canEdit: boolean;
  /** Archiviertes Projekt (src/lib/archiv.ts) — Dokumente nur lesen. */
  nurLesen?: boolean;
}) {
  return (
    <div className="space-y-4">
      <LiveDocsSection projectId={project.id} canEdit={canEdit} />
      <ProjectDocuments projectId={project.id} isAdmin={isAdmin} canUpload={canEdit} nurLesen={nurLesen} />
      <ProjectLinks projectId={project.id} isAdmin={isAdmin} canEdit={canEdit} nurLesen={nurLesen} />
      <HistoryCard project={project} children_={children_} audit={audit} />
    </div>
  );
}
