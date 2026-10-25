"use client";

/**
 * Auftrag-Detail: Tab "Dokumente & Historie".
 *
 * Vereint alle nicht-operativen Inhalte: Dokument-Upload/Vorschau/Download,
 * Partner-Antworten (Custom-Fields aus dem Location-Formular) und den
 * Änderungsverlauf der Stammdaten mit «letzte Änderung rückgängig»
 * (→ aenderungen-verlauf.tsx). Storno-Vermerk + Begründung stehen seit
 * 2026-10-15 im Archiv-Hinweis oben auf der Seite (alle Reiter).
 *
 * Archivierter Auftrag (isArchivedJob): Dokumente nur ansehen/herunterladen —
 * kein Hochladen, Verschieben, Ordner-Anlegen oder Löschen.
 *
 * Alle Storage-/DB-Interaktionen (Upload / Delete / Signed-URL / Preview)
 * leben hier — der Parent uebergibt nur die geladenen Dokumente + einen
 * onDocumentsChange-Setter. Upload und Delete pflegen die Liste lokal
 * (kein volles loadAll noetig — Perf-Audit).
 */

import { useEffect, useMemo, useState } from "react";
import { Upload, Camera, FileText, Trash2, Eye, Download, Link2, Loader2 } from "lucide-react";
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
import { AenderungenVerlauf } from "@/components/auftrag/aenderungen-verlauf";
import { PdfPopup } from "@/components/pdf-popup";
import { createClient } from "@/lib/supabase/client";
import { deleteRow, updateRow } from "@/lib/db-mutations";
import { validateFileList } from "@/lib/file-upload";
import { istHtml } from "@/lib/upload-regeln";
import { visualisierungLinkKopieren } from "@/lib/visualisierung-teilen";
import { TOAST } from "@/lib/messages";
import { useConfirm } from "@/components/ui/use-confirm";
import type { Document as DocType, JobDetailWithRelations } from "@/types";

type Props = {
  jobId: string;
  job: JobDetailWithRelations;
  documents: DocType[];
  /** Archivierter Auftrag (src/lib/archiv.ts) — Dokumente nur lesen. */
  isArchivedJob: boolean;
  onDocumentsChange: (fn: (prev: DocType[]) => DocType[]) => void;
  /** auftraege:edit und nicht archiviert — Rückgängig im Änderungsverlauf. */
  canEdit: boolean;
  /** Auftrag neu laden (nach Rückgängig). */
  onReload?: () => void | Promise<void>;
};

export function DocsHistoryTab({
  jobId,
  job,
  documents,
  isArchivedJob,
  onDocumentsChange,
  canEdit,
  onReload,
}: Props) {
  const supabase = createClient();
  const { confirm, ConfirmModalElement } = useConfirm();
  const [uploading, setUploading] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<{ url: string; title: string } | null>(null);
  // id des Dokuments, dessen Teilen-Link gerade erzeugt wird (Spinner).
  const [linkDocId, setLinkDocId] = useState<string | null>(null);

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
    // Erst die Zeile (die DB kann ablehnen, z.B. Archiv = nur lesen, wenn der
    // Auftrag inzwischen abgeschlossen wurde), dann die Datei — sonst bliebe
    // eine Zeile ohne Datei zurueck.
    const result = await deleteRow("documents", docId);
    if (!result.ok) {
      TOAST.deleteError(result.error);
      return;
    }
    await supabase.storage.from("documents").remove([storagePath]);
    onDocumentsChange((prev) => prev.filter((d) => d.id !== docId));
    toast.success("Dokument gelöscht");
  }

  async function moveDoc(docId: string, folder: string | null) {
    const result = await updateRow("documents", docId, { folder });
    if (!result.ok) {
      toast.error("Verschieben fehlgeschlagen: " + (result.error ?? "Unbekannter Fehler"));
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

  // HTML-Visualisierungen laufen nie ueber die Storage-URL (dort liegen sie als
  // Text), sondern ueber die abgeschottete Route /api/visualisierung/[id].
  async function previewDocument(doc: DocType) {
    if (istHtml(doc.mime_type)) {
      setPreviewDoc({ url: `/api/visualisierung/${doc.id}`, title: doc.name });
      return;
    }
    const url = await openSigned(doc.storage_path);
    if (!url) return;
    setPreviewDoc({ url, title: doc.name });
  }

  // Teilbarer Link ohne Login (HTML-Visualisierung) → Zwischenablage.
  async function copyShareLink(doc: DocType) {
    setLinkDocId(doc.id);
    try {
      await visualisierungLinkKopieren(doc.id);
    } finally {
      setLinkDocId(null);
    }
  }

  async function downloadDocument(doc: DocType) {
    const { storage_path: storagePath, name } = doc;
    const url = istHtml(doc.mime_type)
      ? `/api/visualisierung/${doc.id}?download=1`
      : await openSigned(storagePath);
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
          {!isArchivedJob && (
          <div className="flex items-center gap-2">
            <input
              type="file"
              id="jobFileUpload"
              multiple
              accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.html,.htm"
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
          )}
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
            canCreate={!isArchivedJob}
          />
          {documents.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="Noch keine Dokumente"
              description={isArchivedJob ? "An diesem Auftrag hängen keine Dokumente." : "Ziehe PDFs oder Bilder hier rein oder nutze „Hochladen“."}
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
                      {/* Archiviert: nur Vorschau + Herunterladen — Verschieben
                          und Loeschen ausgeblendet (hidden statt bedingt
                          gerendert, Muster wie zuvor beim Loeschen-Knopf). */}
                      <DocFolderMove
                        folders={folders.map((f) => f.name)}
                        current={doc.folder ?? null}
                        onMove={(folder) => moveDoc(doc.id, folder)}
                        disabled={isArchivedJob}
                        buttonClassName={isArchivedJob ? "hidden" : undefined}
                      />
                      <button
                        type="button"
                        onClick={() => deleteDoc(doc.id, doc.storage_path, doc.name)}
                        className={`kasten kasten-red ${isArchivedJob ? "hidden" : ""}`}
                        data-tooltip="Löschen"
                        disabled={isArchivedJob}
                        aria-hidden={isArchivedJob || undefined}
                        tabIndex={isArchivedJob ? -1 : undefined}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => previewDocument(doc)}
                        className="kasten kasten-blue"
                        data-tooltip="Vorschau"
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </button>
                      {istHtml(doc.mime_type) && (
                        <button
                          type="button"
                          onClick={() => copyShareLink(doc)}
                          className="kasten kasten-blue"
                          data-tooltip="Link zum Teilen kopieren (ohne Login)"
                          disabled={linkDocId === doc.id}
                        >
                          {linkDocId === doc.id
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <Link2 className="h-3.5 w-3.5" />}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => downloadDocument(doc)}
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

      {/* Änderungsverlauf der Stammdaten (Migration 319) */}
      <AenderungenVerlauf
        jobId={jobId}
        canEdit={canEdit}
        reloadKey={job.updated_at}
        onUndone={onReload}
      />

      {ConfirmModalElement}
      {previewDoc && (
        <PdfPopup url={previewDoc.url} title={previewDoc.title} onClose={() => setPreviewDoc(null)} />
      )}
    </div>
  );
}
