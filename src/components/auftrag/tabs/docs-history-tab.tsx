"use client";

/**
 * Auftrag-Detail: Tab "Dokumente & Historie".
 *
 * Vereint alle nicht-operativen Inhalte: Dokument-Upload/Vorschau/Download,
 * Partner-Antworten (Custom-Fields aus dem Location-Formular) und die
 * Storno-Section (nur bei storniertem Auftrag).
 *
 * Alle Storage-/DB-Interaktionen (Upload / Delete / Signed-URL / Preview)
 * leben hier — der Parent uebergibt nur die geladenen Dokumente + einen
 * onDocumentsChange-Setter. Upload und Delete pflegen die Liste lokal
 * (kein volles loadAll noetig — Perf-Audit).
 */

import { useEffect, useMemo, useState } from "react";
import { Upload, Camera, FileText, Trash2, Eye, Download, XCircle } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DocFolderBar,
  DocFolderMove,
  DocFolderTag,
  collectFolders,
  folderForUpload,
  matchesFolder,
  type ActiveFolder,
} from "@/components/ui/doc-folders";
import { PartnerFormAnswersCard } from "@/components/auftrag/partner-form-answers-card";
import { PdfPopup } from "@/components/pdf-popup";
import { createClient } from "@/lib/supabase/client";
import { deleteRow } from "@/lib/db-mutations";
import { validateFileList } from "@/lib/file-upload";
import { TOAST } from "@/lib/messages";
import { useConfirm } from "@/components/ui/use-confirm";
import type { Document as DocType, JobDetailWithRelations } from "@/types";

type Props = {
  jobId: string;
  job: JobDetailWithRelations;
  documents: DocType[];
  isArchivedJob: boolean;
  onDocumentsChange: (fn: (prev: DocType[]) => DocType[]) => void;
};

export function DocsHistoryTab({
  jobId,
  job,
  documents,
  isArchivedJob,
  onDocumentsChange,
}: Props) {
  const supabase = createClient();
  const { confirm, ConfirmModalElement } = useConfirm();
  const [uploading, setUploading] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<{ url: string; title: string } | null>(null);

  // Ordner (eine Ebene, Attribut pro Dokument — siehe doc-folders.tsx).
  // activeFolder: null = "Alle", "" = Hauptordner, sonst Ordnername.
  // extraFolders: frisch angelegte, noch leere Ordner (bis zum 1. Upload).
  const [activeFolder, setActiveFolder] = useState<ActiveFolder>(null);
  const [extraFolders, setExtraFolders] = useState<string[]>([]);

  const folders = useMemo(
    () => collectFolders(documents.map((d) => d.folder), extraFolders),
    [documents, extraFolders],
  );
  const mainCount = useMemo(() => documents.filter((d) => !d.folder).length, [documents]);
  const visibleDocs = useMemo(
    () => documents.filter((d) => matchesFolder(d.folder, activeFolder)),
    [documents, activeFolder],
  );

  // Verschwindet der aktive Ordner (letztes Dokument raus/geloescht,
  // Ordner war nicht frisch angelegt), zurueck auf "Alle".
  useEffect(() => {
    if (activeFolder && !folders.some((f) => f.name === activeFolder)) {
      setActiveFolder(null);
    }
  }, [activeFolder, folders]);

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    if (!validateFileList(files)) return;
    setUploading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setUploading(false);
      return;
    }
    let uploadedAny = false;
    for (const file of Array.from(files)) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `jobs/${jobId}/${Date.now()}_${safeName}`;
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("path", path);
        const res = await fetch("/api/upload", { method: "POST", body: formData });
        const json = await res.json();
        if (!json.success) {
          TOAST.uploadError(json.error);
          continue;
        }
        // Eingefuegte Row zurueckholen + lokal anhaengen (Muster deleteDoc)
        // — nur die documents-Liste aendert sich, kein volles loadAll
        // (6 Queries) noetig (Perf-Audit). Liste ist created_at-desc
        // sortiert → neue Docs vorne anfuegen.
        const { data: inserted, error: insErr } = await supabase
          .from("documents")
          .insert({
            name: file.name,
            storage_path: path,
            file_size: file.size,
            mime_type: file.type,
            job_id: jobId,
            uploaded_by: user.id,
            // Upload landet im aktiven Ordner (bei "Alle" → Hauptordner).
            folder: folderForUpload(activeFolder),
          })
          .select("*")
          .single();
        if (insErr || !inserted) {
          TOAST.uploadError(insErr?.message ?? "Dokument konnte nicht gespeichert werden");
          continue;
        }
        onDocumentsChange((prev) => [inserted as DocType, ...prev]);
        uploadedAny = true;
      } catch (err) {
        TOAST.uploadError(err instanceof Error ? err.message : "Netzwerkfehler");
        continue;
      }
    }
    if (uploadedAny) toast.success("Datei(en) hochgeladen");
    setUploading(false);
    e.target.value = "";
  }

  async function deleteDoc(docId: string, storagePath: string, name: string) {
    const ok = await confirm({
      title: "Dokument löschen?",
      message: `"${name}" wird unwiderruflich entfernt.`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    await supabase.storage.from("documents").remove([storagePath]);
    const result = await deleteRow("documents", docId);
    if (!result.ok) {
      TOAST.deleteError(result.error);
      return;
    }
    onDocumentsChange((prev) => prev.filter((d) => d.id !== docId));
    toast.success("Dokument gelöscht");
  }

  async function moveDoc(docId: string, folder: string | null) {
    const { error } = await supabase.from("documents").update({ folder }).eq("id", docId);
    if (error) {
      toast.error("Verschieben fehlgeschlagen: " + error.message);
      return;
    }
    onDocumentsChange((prev) => prev.map((d) => (d.id === docId ? { ...d, folder } : d)));
    toast.success(folder ? `In «${folder}» verschoben` : "In den Hauptordner verschoben");
  }

  async function openSigned(storagePath: string): Promise<string | null> {
    const { data, error } = await supabase.storage
      .from("documents")
      .createSignedUrl(storagePath, 3600);
    if (error || !data?.signedUrl) {
      toast.error(
        "Datei nicht verfügbar — eventuell aus altem Bestand vor 6.5.2026, im alten Storage zu finden",
      );
      return null;
    }
    return data.signedUrl;
  }

  async function previewDocument(storagePath: string, name: string) {
    const url = await openSigned(storagePath);
    if (!url) return;
    setPreviewDoc({ url, title: name });
  }

  async function downloadDocument(storagePath: string, name: string) {
    const url = await openSigned(storagePath);
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
  }

  return (
    <div className="space-y-4">
      {/* Dokumente / PDFs */}
      <Card className="bg-card">
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Upload className="h-3.5 w-3.5" />
            Dokumente ({documents.length})
          </CardTitle>
          <div className="flex items-center gap-2">
            <input
              type="file"
              id="jobFileUpload"
              multiple
              accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
              className="hidden"
              onChange={handleFileUpload}
            />
            <input
              type="file"
              id="jobPhotoUpload"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handleFileUpload}
            />
            <button
              type="button"
              className="kasten kasten-blue md:hidden"
              onClick={() => document.getElementById("jobPhotoUpload")?.click()}
              disabled={uploading}
            >
              <Camera className="h-3.5 w-3.5" />
              Foto
            </button>
            <button
              type="button"
              className="kasten kasten-blue"
              onClick={() => document.getElementById("jobFileUpload")?.click()}
              disabled={uploading}
            >
              <Upload className="h-3.5 w-3.5" />
              {uploading ? "Lädt…" : "Hochladen"}
            </button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <DocFolderBar
            folders={folders}
            mainCount={mainCount}
            totalCount={documents.length}
            active={activeFolder}
            onSelect={setActiveFolder}
            onCreate={(name) => {
              setExtraFolders((prev) => (prev.includes(name) ? prev : [...prev, name]));
              setActiveFolder(name);
            }}
          />
          {documents.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="Noch keine Dokumente"
              description={"Ziehe PDFs oder Bilder hier rein oder nutze „Hochladen“."}
            />
          ) : visibleDocs.length === 0 ? (
            <p className="text-xs text-muted-foreground italic py-2">
              Keine Dokumente in diesem Ordner — der nächste Upload landet hier.
            </p>
          ) : (
            <div className="space-y-2">
              {visibleDocs.map((doc) => {
                return (
                  <div
                    key={doc.id}
                    className="flex items-center justify-between p-3 rounded-xl bg-foreground/[0.03] dark:bg-foreground/[0.06] border border-foreground/10 dark:border-foreground/15"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <FileText className="h-5 w-5 text-red-500 shrink-0" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <p className="text-sm font-medium truncate">{doc.name}</p>
                          {/* In der "Alle"-Ansicht dezent den Ordner zeigen */}
                          {activeFolder === null && <DocFolderTag folder={doc.folder} />}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {doc.file_size ? (doc.file_size / 1024).toFixed(0) + " KB" : ""} ·{" "}
                          {new Date(doc.created_at).toLocaleDateString("de-CH", {
                            timeZone: "Europe/Zurich",
                          })}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <DocFolderMove
                        folders={folders.map((f) => f.name)}
                        current={doc.folder ?? null}
                        onMove={(folder) => moveDoc(doc.id, folder)}
                      />
                      <button
                        type="button"
                        onClick={() => deleteDoc(doc.id, doc.storage_path, doc.name)}
                        className={`kasten kasten-red ${isArchivedJob ? "invisible pointer-events-none" : ""}`}
                        data-tooltip="Löschen"
                        aria-hidden={isArchivedJob || undefined}
                        tabIndex={isArchivedJob ? -1 : undefined}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => previewDocument(doc.storage_path, doc.name)}
                        className="kasten kasten-blue"
                        data-tooltip="Vorschau"
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadDocument(doc.storage_path, doc.name)}
                        className="kasten kasten-muted"
                        data-tooltip="Herunterladen"
                      >
                        <Download className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Partner-Custom-Felder */}
      <PartnerFormAnswersCard
        formAnswers={job.form_answers}
        formSchemaSnapshot={job.form_schema_snapshot}
        locationId={job.location_id}
      />

      {/* Storno-Info — nur sichtbar wenn storniert */}
      {job.status === "storniert" && (job.cancelled_at || job.cancellation_reason) && (
        <Card className="bg-card border-destructive/30">
          <CardContent className="space-y-2">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-destructive">
              <XCircle className="h-3.5 w-3.5" />
              Storniert
            </div>
            <div className="text-sm text-muted-foreground">
              {job.cancelled_by_profile?.full_name && (
                <>
                  von{" "}
                  <span className="font-medium text-foreground">
                    {job.cancelled_by_profile.full_name}
                  </span>
                </>
              )}
              {job.cancelled_at && (
                <>
                  {" "}
                  am{" "}
                  <span className="font-medium text-foreground">
                    {new Date(job.cancelled_at).toLocaleDateString("de-CH", {
                      timeZone: "Europe/Zurich",
                    })}
                  </span>
                </>
              )}
            </div>
            {job.cancellation_reason && (
              <div className="pt-2 border-t">
                <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Grund</p>
                <p className="text-sm whitespace-pre-wrap">{job.cancellation_reason}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {ConfirmModalElement}
      {previewDoc && (
        <PdfPopup url={previewDoc.url} title={previewDoc.title} onClose={() => setPreviewDoc(null)} />
      )}
    </div>
  );
}
