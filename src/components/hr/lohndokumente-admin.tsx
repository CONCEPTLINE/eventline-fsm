"use client";

/**
 * Admin-Manager fuer Lohndokumente: pro Mitarbeiter eine Liste der
 * gespeicherten Lohnabrechnungen + Lohnausweise. Aktionen:
 *   - PDF hochladen (manueller Upload — z.B. von Bexio generierter
 *     Jahres-Lohnausweis)
 *   - PDF auto-generieren (monatliche Lohnabrechnung, aus den Stunden-
 *     daten der App-internen Tabelle)
 *   - Existierende Dokumente herunterladen / loeschen
 */

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/searchable-select";
import { Upload, Trash2, Download, FileText, Sparkles, Plus } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { Loading } from "@/components/ui/spinner";

interface WageDoc {
  id: string;
  profile_id: string;
  doc_type: "lohnabrechnung" | "lohnausweis";
  year: number;
  period_month: number | null;
  file_size: number | null;
  uploaded_at: string;
  notes: string | null;
  profile?: { full_name: string };
}

interface Employee { id: string; full_name: string; role: string; }

const MONTH_NAMES = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

export function LohndokumenteAdmin() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState<string>("");
  const [docs, setDocs] = useState<WageDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);

  // Mitarbeiter-Liste via SECURITY-DEFINER-RPC (admin-only)
  useEffect(() => {
    const supabase = createClient();
    supabase.rpc("get_all_profiles_admin").then(({ data }) => {
      if (!data) return;
      const list = (data as { id: string; full_name: string; role: string; is_active: boolean }[])
        .filter((u) => u.role !== "partner" && u.is_active)
        .sort((a, b) => a.full_name.localeCompare(b.full_name));
      setEmployees(list);
    });
  }, []);

  const loadDocs = useCallback(async (employeeId: string) => {
    setLoading(true);
    try {
      const url = employeeId ? `/api/hr/wage-documents?profile_id=${employeeId}` : "/api/hr/wage-documents";
      const res = await fetch(url);
      const j = await res.json();
      if (j.success) setDocs(j.documents as WageDoc[]);
      else toast.error(j.error || "Fehler beim Laden");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedEmployee) loadDocs(selectedEmployee);
    else setDocs([]);
  }, [selectedEmployee, loadDocs]);

  async function downloadDoc(id: string) {
    const res = await fetch(`/api/hr/wage-documents/${id}`);
    const j = await res.json();
    if (!j.success) { toast.error(j.error || "Download-Link konnte nicht erzeugt werden"); return; }
    // Direkter Download via blob, damit der Filename gesetzt wird
    const a = document.createElement("a");
    a.href = j.url; a.download = j.filename; a.target = "_blank";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  async function deleteDoc(id: string) {
    if (!confirm("Lohndokument löschen? Kann nicht rückgängig gemacht werden.")) return;
    const res = await fetch(`/api/hr/wage-documents/${id}`, { method: "DELETE" });
    const j = await res.json();
    if (!j.success) { toast.error(j.error || "Löschen fehlgeschlagen"); return; }
    toast.success("Gelöscht");
    if (selectedEmployee) loadDocs(selectedEmployee);
  }

  // Docs gruppieren: nach Jahr
  const byYear = docs.reduce<Record<number, WageDoc[]>>((acc, d) => {
    (acc[d.year] ??= []).push(d);
    return acc;
  }, {});
  const years = Object.keys(byYear).map(Number).sort((a, b) => b - a);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <FileText className="h-4 w-4" /> Lohndokumente verwalten
        </h2>
        <p className="text-xs text-muted-foreground">
          PDFs für Lohnabrechnungen (monatlich) + Lohnausweise (jährlich). Mitarbeiter sehen ihre eigenen Dokumente im HR → Löhne.
        </p>
      </div>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex-1 min-w-[200px] max-w-sm">
              <SearchableSelect
                value={selectedEmployee}
                onChange={setSelectedEmployee}
                items={employees.map((e) => ({ id: e.id, label: e.full_name, sub: e.role }))}
                placeholder="Mitarbeiter wählen…"
              />
            </div>
            {selectedEmployee && (
              <>
                <button type="button" onClick={() => setGenerateOpen(true)} className="kasten kasten-blue">
                  <Sparkles className="h-3.5 w-3.5" /> Monats-Abrechnung generieren
                </button>
                <button type="button" onClick={() => setUploadOpen(true)} className="kasten kasten-muted">
                  <Upload className="h-3.5 w-3.5" /> PDF hochladen
                </button>
              </>
            )}
          </div>

          {!selectedEmployee ? (
            <p className="text-xs text-muted-foreground py-4 text-center">Mitarbeiter wählen um Dokumente zu sehen.</p>
          ) : loading ? (
            <Loading />
          ) : docs.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">Noch keine Dokumente für diesen Mitarbeiter.</p>
          ) : (
            <div className="space-y-3">
              {years.map((y) => (
                <div key={y}>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">{y}</p>
                  <div className="space-y-1">
                    {byYear[y].sort(sortDocs).map((d) => (
                      <DocRow key={d.id} doc={d} onDownload={() => downloadDoc(d.id)} onDelete={() => deleteDoc(d.id)} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <UploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        profileId={selectedEmployee}
        onDone={() => { setUploadOpen(false); loadDocs(selectedEmployee); }}
      />

      <GenerateModal
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        profileId={selectedEmployee}
        employee={employees.find((e) => e.id === selectedEmployee)}
        onDone={() => { setGenerateOpen(false); loadDocs(selectedEmployee); }}
      />
    </div>
  );
}

function sortDocs(a: WageDoc, b: WageDoc): number {
  // Lohnausweis zuerst, dann Lohnabrechnungen absteigend nach Monat
  if (a.doc_type !== b.doc_type) return a.doc_type === "lohnausweis" ? -1 : 1;
  return (b.period_month ?? 0) - (a.period_month ?? 0);
}

function DocRow({ doc, onDownload, onDelete }: { doc: WageDoc; onDownload: () => void; onDelete: () => void }) {
  const label = doc.doc_type === "lohnausweis"
    ? `Lohnausweis ${doc.year}`
    : `Lohnabrechnung ${MONTH_NAMES[(doc.period_month ?? 1) - 1]} ${doc.year}`;
  const sizeMb = doc.file_size ? (doc.file_size / 1024 / 1024).toFixed(2) : null;
  const uploaded = new Date(doc.uploaded_at).toLocaleDateString("de-CH");
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-border bg-foreground/[0.02] dark:bg-foreground/[0.04]">
      <div className="min-w-0 flex items-center gap-2">
        <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{label}</p>
          <p className="text-[10px] text-muted-foreground">
            Hochgeladen am {uploaded}{sizeMb && ` · ${sizeMb} MB`}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button type="button" onClick={onDownload} className="kasten kasten-muted" data-tooltip="Herunterladen">
          <Download className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={onDelete} className="kasten kasten-red" data-tooltip="Löschen">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function UploadModal({ open, onClose, profileId, onDone }: { open: boolean; onClose: () => void; profileId: string; onDone: () => void }) {
  const thisYear = new Date().getFullYear();
  const [docType, setDocType] = useState<"lohnabrechnung" | "lohnausweis">("lohnabrechnung");
  const [year, setYear] = useState(String(thisYear));
  const [month, setMonth] = useState(String(new Date().getMonth() + 1));
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [uploading, setUploading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) { toast.error("PDF auswählen"); return; }
    if (file.type !== "application/pdf") { toast.error("Nur PDF erlaubt"); return; }
    setUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("profile_id", profileId);
    fd.append("doc_type", docType);
    fd.append("year", year);
    if (docType === "lohnabrechnung") fd.append("period_month", month);
    if (notes) fd.append("notes", notes);
    const res = await fetch("/api/hr/wage-documents", { method: "POST", body: fd });
    const j = await res.json();
    setUploading(false);
    if (!j.success) { TOAST.errorOr(j.error); return; }
    toast.success(j.mode === "updated" ? "Dokument aktualisiert" : "Dokument hochgeladen");
    setFile(null); setNotes("");
    onDone();
  }

  return (
    <Modal open={open} onClose={() => !uploading && onClose()} title="Lohndokument hochladen" size="md">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-muted-foreground">Typ</label>
            <select value={docType} onChange={(e) => setDocType(e.target.value as "lohnabrechnung" | "lohnausweis")} className="w-full h-9 px-3 text-sm rounded-xl border border-border bg-card mt-1">
              <option value="lohnabrechnung">Lohnabrechnung (monatlich)</option>
              <option value="lohnausweis">Lohnausweis (jährlich)</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground">Jahr</label>
            <Input type="number" value={year} onChange={(e) => setYear(e.target.value)} min={2020} max={2100} className="mt-1" />
          </div>
        </div>
        {docType === "lohnabrechnung" && (
          <div>
            <label className="text-[10px] text-muted-foreground">Monat</label>
            <select value={month} onChange={(e) => setMonth(e.target.value)} className="w-full h-9 px-3 text-sm rounded-xl border border-border bg-card mt-1">
              {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="text-[10px] text-muted-foreground">PDF-Datei</label>
          <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="mt-1 block w-full text-xs file:mr-2 file:px-3 file:py-1.5 file:rounded-lg file:border file:border-border file:bg-foreground/[0.05] file:text-foreground file:text-xs file:cursor-pointer" />
          {file && <p className="text-[10px] text-muted-foreground mt-1">{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB</p>}
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground">Notiz (optional)</label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} className="mt-1" />
        </div>
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={uploading} className="kasten kasten-muted flex-1">Abbrechen</button>
          <button type="submit" disabled={uploading || !file} className="kasten kasten-red flex-1">{uploading ? "Lädt…" : "Hochladen"}</button>
        </div>
      </form>
    </Modal>
  );
}

function GenerateModal({ open, onClose, profileId, employee, onDone }: { open: boolean; onClose: () => void; profileId: string; employee: Employee | undefined; onDone: () => void }) {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    const res = await fetch("/api/hr/wage-documents/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile_id: profileId, year, month }),
    });
    const j = await res.json();
    setBusy(false);
    if (!j.success) { TOAST.errorOr(j.error); return; }
    toast.success(j.mode === "regenerated" ? "Lohnabrechnung neu generiert" : "Lohnabrechnung generiert");
    onDone();
  }

  return (
    <Modal open={open} onClose={() => !busy && onClose()} title="Lohnabrechnung generieren" size="md">
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Generiert eine PDF-Lohnabrechnung für <strong>{employee?.full_name ?? "—"}</strong> aus den im System erfassten Stunden + Lohndaten.
          Existiert schon eine für diesen Monat, wird sie überschrieben.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-muted-foreground">Monat</label>
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className="w-full h-9 px-3 text-sm rounded-xl border border-border bg-card mt-1">
              {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground">Jahr</label>
            <Input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} min={2020} max={2100} className="mt-1" />
          </div>
        </div>
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={busy} className="kasten kasten-muted flex-1">Abbrechen</button>
          <button type="button" onClick={submit} disabled={busy} className="kasten kasten-blue flex-1">
            {busy ? "Generiert…" : <><Plus className="h-3.5 w-3.5" /> Generieren</>}
          </button>
        </div>
      </div>
    </Modal>
  );
}
