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
  DocFolderBar,
  DocFolderMove,
  DocFolderTag,
  collectFolders,
  folderForUpload,
  matchesFolder,
  type ActiveFolder,
} from "@/components/ui/doc-folders";
import { PdfPopup } from "@/components/pdf-popup";
import {
  Paperclip, FileText, Loader2, Trash2, Eye, Download, History,
  ArrowLeft, ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import { validateFileList } from "@/lib/file-upload";
import { PROJECT_STATUS_LABEL, formatProjectNumber } from "@/lib/projekte-format";
import type { AuditEntry, Child, Project } from "../types";

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

function ProjectDocuments({ projectId, isAdmin, canUpload }: { projectId: string; isAdmin: boolean; canUpload: boolean }) {
  const supabase = createClient();
  const { confirm, ConfirmModalElement } = useConfirm();
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [me, setMe] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<{ url: string; title: string } | null>(null);

  // Ordner (eine Ebene, Attribut pro Dokument — siehe doc-folders.tsx).
  const [activeFolder, setActiveFolder] = useState<ActiveFolder>(null);
  const [extraFolders, setExtraFolders] = useState<string[]>([]);

  const folders = useMemo(
    () => collectFolders(docs.map((d) => d.folder), extraFolders),
    [docs, extraFolders],
  );
  const mainCount = useMemo(() => docs.filter((d) => !d.folder).length, [docs]);
  const visibleDocs = useMemo(
    () => docs.filter((d) => matchesFolder(d.folder, activeFolder)),
    [docs, activeFolder],
  );

  useEffect(() => {
    if (activeFolder && !folders.some((f) => f.name === activeFolder)) {
      setActiveFolder(null);
    }
  }, [activeFolder, folders]);

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
    setLoading(false);
  }, [supabase, projectId]);

  useEffect(() => { load(); }, [load]);

  async function handleFiles(files: FileList | null) {
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
          // Upload landet im aktiven Ordner (bei "Alle" → Hauptordner).
          folder: folderForUpload(activeFolder),
        });
        if (error) fail++; else ok++;
      } catch { fail++; }
    }
    setUploading(false);
    if (ok > 0) toast.success(`${ok} Datei(en) hochgeladen`);
    if (fail > 0) toast.error(`${fail} Datei(en) fehlgeschlagen`);
    load();
  }

  async function moveDoc(doc: DocRow, folder: string | null) {
    const { error } = await supabase.from("documents").update({ folder }).eq("id", doc.id);
    if (error) {
      toast.error("Verschieben fehlgeschlagen: " + error.message);
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
    await supabase.storage.from("documents").remove([doc.storage_path]);
    const { error } = await supabase.from("documents").delete().eq("id", doc.id);
    if (error) { toast.error("Löschen fehlgeschlagen: " + error.message); return; }
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
        {canUpload && (
          <label className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-dashed bg-muted/20 text-sm text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors cursor-pointer">
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
            {uploading ? "Lädt hoch…" : "Dateien auswählen…"}
            <input type="file" multiple className="sr-only" disabled={uploading} onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
          </label>
        )}
        {!loading && (
          <DocFolderBar
            folders={folders}
            mainCount={mainCount}
            totalCount={docs.length}
            active={activeFolder}
            onSelect={setActiveFolder}
            onCreate={(name) => {
              setExtraFolders((prev) => (prev.includes(name) ? prev : [...prev, name]));
              setActiveFolder(name);
            }}
            canCreate={canUpload}
          />
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
                  {(isAdmin || me === d.uploaded_by) && (
                    <button onClick={() => deleteDoc(d)} className="kasten kasten-red !py-1 !px-2" data-tooltip="Löschen" aria-label="Löschen">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {ConfirmModalElement}
        {previewDoc && (
          <PdfPopup url={previewDoc.url} title={previewDoc.title} onClose={() => setPreviewDoc(null)} />
        )}
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

        {/* Genehmigungs- / Abschluss-Kommentare -- EINMAL, nur hier. */}
        {project.decision_note && (
          <div className="p-2 rounded-lg bg-muted/20 text-[11px]">
            <p className="text-muted-foreground/70 mb-0.5">Genehmigungs-Kommentar:</p>
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
  project, children_, audit, isAdmin, canEdit,
}: {
  project: Project;
  children_: Child[];
  audit: AuditEntry[];
  isAdmin: boolean;
  canEdit: boolean;
}) {
  return (
    <div className="space-y-4">
      <ProjectDocuments projectId={project.id} isAdmin={isAdmin} canUpload={canEdit} />
      <HistoryCard project={project} children_={children_} audit={audit} />
    </div>
  );
}
