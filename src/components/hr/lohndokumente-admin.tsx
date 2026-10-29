"use client";

/**
 * Admin-Manager fuer Lohndokumente: pro Mitarbeiter eine Liste der
 * gueltigen Lohnabrechnungen + Lohnausweise. Aktionen:
 *   - PDF hochladen (manueller Upload — z.B. von Bexio generierter
 *     Jahres-Lohnausweis)
 *   - Monats-Abrechnung erzeugen (nur gesperrte Monate, ab dem 5. des
 *     Folgemonats; Vorgabe = letzter gesperrter Monat)
 *   - Herunterladen, in den Papierkorb legen, aus dem Papierkorb holen
 *
 * Lohn-Umbau Phase 1: nichts wird mehr ueberschrieben oder geloescht.
 * Gibt es fuer den Zeitraum schon ein Dokument, entsteht nach Rueckfrage eine
 * neue Fassung (die bisherige bleibt, Protokoll in der DB). Der Papierkorb
 * loescht nie endgueltig. «Alle neu erstellen» gibt es nicht mehr.
 * Oben steht der Status des automatischen Laufs (Fehler sichtbar).
 */

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/searchable-select";
import { Upload, Download, FileText, Sparkles, Plus, Archive, ArchiveRestore, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { Loading } from "@/components/ui/spinner";
import { useConfirm } from "@/components/ui/use-confirm";
import { istIntern } from "@/lib/roles";
import { formatDateTimeFull } from "@/lib/format";
import { todayLocalIso } from "@/lib/swiss-time";
import { letzteGesperrteMonate, monatLabel, monatSchluessel } from "@/lib/lohn/monate";

interface WageDoc {
  id: string;
  profile_id: string;
  doc_type: "lohnabrechnung" | "lohnausweis";
  year: number;
  period_month: number | null;
  file_size: number | null;
  uploaded_at: string;
  uploaded_by_name: string | null;
  notes: string | null;
  source: "auto" | "manual" | null;
  version: number | null;
  archived_at: string | null;
  archived_by_name: string | null;
  archive_reason: string | null;
}

interface Employee { id: string; full_name: string; role: string; }

interface LaufErgebnis { name: string; monat: string; ok: boolean; fehler?: string; uebersprungen?: string }
interface LaufHinweis { name: string; text: string }
interface Lauf {
  id: string;
  gestartet_at: string;
  beendet_at: string | null;
  status: "laeuft" | "ok" | "teilweise" | "fehler" | "abgebrochen" | "pausiert";
  erstellt: number;
  fehler: number;
  offen: number;
  ergebnisse: LaufErgebnis[];
  hinweise: LaufHinweis[];
  zusammenfassung: string | null;
}

const MONTH_NAMES = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

export function LohndokumenteAdmin() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState<string>("");
  const [docs, setDocs] = useState<WageDoc[]>([]);
  const [papierkorb, setPapierkorb] = useState(false);
  const [papierkorbAnzahl, setPapierkorbAnzahl] = useState(0);
  const [loading, setLoading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { confirm, ConfirmModalElement } = useConfirm();

  // Mitarbeiter-Liste via SECURITY-DEFINER-RPC (admin-only)
  useEffect(() => {
    const supabase = createClient();
    supabase.rpc("get_all_profiles_admin").then(({ data, error }) => {
      if (error) { toast.error(`Mitarbeiter konnten nicht geladen werden: ${error.message}`); return; }
      if (!data) return;
      const list = (data as { id: string; full_name: string; role: string; is_active: boolean }[])
        .filter((u) => istIntern(u.role) && u.is_active)
        .sort((a, b) => a.full_name.localeCompare(b.full_name));
      setEmployees(list);
    });
  }, []);

  const loadDocs = useCallback(async (employeeId: string, korb: boolean) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/hr/wage-documents?profile_id=${employeeId}${korb ? "&papierkorb=1" : ""}`);
      const j = await res.json().catch(() => ({}));
      if (j.success) {
        setDocs(j.documents as WageDoc[]);
        if (typeof j.papierkorb_anzahl === "number") setPapierkorbAnzahl(j.papierkorb_anzahl);
      } else {
        toast.error(j.error || "Fehler beim Laden");
      }
    } catch (e) {
      toast.error(`Fehler beim Laden: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedEmployee) loadDocs(selectedEmployee, papierkorb);
    else setDocs([]);
  }, [selectedEmployee, papierkorb, loadDocs]);

  const neuLaden = () => { if (selectedEmployee) loadDocs(selectedEmployee, papierkorb); };

  async function downloadDoc(id: string) {
    const res = await fetch(`/api/hr/wage-documents/${id}`);
    const j = await res.json().catch(() => ({}));
    if (!j.success) { toast.error(j.error || "Download-Link konnte nicht erzeugt werden"); return; }
    const a = document.createElement("a");
    a.href = j.url; a.download = j.filename; a.target = "_blank";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  async function archiveDoc(d: WageDoc) {
    const ok = await confirm({
      title: "In den Papierkorb legen?",
      message: `${docLabel(d)} wird ausgeblendet — auch für die Person selbst. Nichts wird gelöscht; Wiederherstellen ist jederzeit möglich. Die Aktion wird protokolliert.`,
      confirmLabel: "In den Papierkorb",
      variant: "red",
    });
    if (!ok) return;
    setBusyId(d.id);
    try {
      const res = await fetch(`/api/hr/wage-documents/${d.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!j.success) { TOAST.errorOr(j.error, "Konnte nicht in den Papierkorb gelegt werden"); return; }
      toast.success("Im Papierkorb");
      neuLaden();
    } finally {
      setBusyId(null);
    }
  }

  async function restoreDoc(d: WageDoc) {
    setBusyId(d.id);
    try {
      const res = await fetch(`/api/hr/wage-documents/${d.id}/wiederherstellen`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!j.success) { TOAST.errorOr(j.error, "Wiederherstellen fehlgeschlagen"); return; }
      toast.success("Wiederhergestellt");
      neuLaden();
    } finally {
      setBusyId(null);
    }
  }

  // Docs gruppieren: nach Jahr
  const byYear = docs.reduce<Record<number, WageDoc[]>>((acc, d) => {
    (acc[d.year] ??= []).push(d);
    return acc;
  }, {});
  const years = Object.keys(byYear).map(Number).sort((a, b) => b - a);

  return (
    <div className="space-y-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <FileText className="h-4 w-4" /> Lohndokumente
        </h2>
        <p className="text-xs text-muted-foreground">
          PDFs für Lohnabrechnungen (monatlich) + Lohnausweise (jährlich). Mitarbeiter sehen ihre eigenen Dokumente unter HR › Lohn.
        </p>
      </div>
      {ConfirmModalElement}

      <LaufStatus />

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex-1 min-w-[200px] max-w-sm">
              <SearchableSelect
                value={selectedEmployee}
                onChange={(v) => { setSelectedEmployee(v); setPapierkorb(false); }}
                items={employees.map((e) => ({ id: e.id, label: e.full_name, sub: e.role }))}
                placeholder="Mitarbeiter wählen…"
              />
            </div>
            {selectedEmployee && (
              <>
                <button type="button" onClick={() => setGenerateOpen(true)} className="kasten kasten-red">
                  <Sparkles className="h-3.5 w-3.5" /> Monats-Abrechnung erzeugen
                </button>
                <button type="button" onClick={() => setUploadOpen(true)} className="kasten kasten-muted">
                  <Upload className="h-3.5 w-3.5" /> PDF hochladen
                </button>
                <div className="flex gap-1 ml-auto">
                  <button type="button" onClick={() => setPapierkorb(false)} className={!papierkorb ? "kasten-active" : "kasten-toggle-off"}>
                    Gültig
                  </button>
                  <button type="button" onClick={() => setPapierkorb(true)} className={papierkorb ? "kasten-active" : "kasten-toggle-off"}>
                    <Archive className="h-3.5 w-3.5" /> Papierkorb{papierkorbAnzahl > 0 ? ` (${papierkorbAnzahl})` : ""}
                  </button>
                </div>
              </>
            )}
          </div>

          {!selectedEmployee ? (
            <p className="text-xs text-muted-foreground py-4 text-center">Mitarbeiter wählen um Dokumente zu sehen.</p>
          ) : loading ? (
            <Loading />
          ) : docs.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">
              {papierkorb ? "Der Papierkorb ist leer." : "Noch keine Dokumente für diesen Mitarbeiter."}
            </p>
          ) : (
            <div className="space-y-3">
              {years.map((y) => (
                <div key={y}>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">{y}</p>
                  <div className="space-y-1">
                    {byYear[y].sort(sortDocs).map((d) => (
                      <DocRow
                        key={d.id}
                        doc={d}
                        busy={busyId === d.id}
                        onDownload={() => downloadDoc(d.id)}
                        onArchive={() => archiveDoc(d)}
                        onRestore={() => restoreDoc(d)}
                      />
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
        onDone={() => { setUploadOpen(false); setPapierkorb(false); neuLaden(); }}
      />

      <GenerateModal
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        profileId={selectedEmployee}
        employee={employees.find((e) => e.id === selectedEmployee)}
        onDone={() => { setGenerateOpen(false); setPapierkorb(false); neuLaden(); }}
      />
    </div>
  );
}

/** Status des letzten automatischen Laufs (lohn_lauf) — Fehler sichtbar. */
function LaufStatus() {
  const [lauf, setLauf] = useState<Lauf | null | undefined>(undefined);
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    let aktiv = true;
    fetch("/api/hr/lohn-lauf")
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!aktiv) return;
        if (!ok || !j.success) { toast.error(`Status des Lohnlaufs: ${j.error ?? "Fehler"}`); setLauf(null); return; }
        setLauf(((j.laeufe as Lauf[]) ?? [])[0] ?? null);
      })
      .catch((e) => { if (aktiv) { toast.error(`Status des Lohnlaufs: ${String(e)}`); setLauf(null); } });
    return () => { aktiv = false; };
  }, []);

  if (lauf === undefined) return <div className="shimmer rounded-md h-5 w-72" />;
  if (lauf === null) {
    return <p className="text-xs text-muted-foreground">Automatischer Lauf: noch kein Lauf protokolliert.</p>;
  }
  const problem = lauf.status === "fehler" || lauf.status === "teilweise" || lauf.status === "abgebrochen";
  // Wartung «Lohn» (Migration 363): Lauf pausiert, Zusammenfassung «pausiert (Wartung)».
  const pausiert = lauf.status === "pausiert";
  const fehlerZeilen = lauf.ergebnisse.filter((e) => !e.ok);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {problem ? (
        <AlertTriangle className="h-3.5 w-3.5 text-red-600 dark:text-red-400 shrink-0" />
      ) : pausiert ? (
        <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
      ) : (
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
      )}
      <span className={problem ? "text-red-700 dark:text-red-300" : "text-muted-foreground"}>
        Automatischer Lauf {formatDateTimeFull(lauf.gestartet_at)}:{" "}
        {lauf.status === "laeuft" ? "läuft gerade" : lauf.status === "abgebrochen" ? "abgebrochen" : lauf.zusammenfassung ?? "—"}
      </span>
      {(fehlerZeilen.length > 0 || lauf.hinweise.length > 0) && (
        <button type="button" onClick={() => setDetailsOpen(true)} className="kasten kasten-muted">
          Details
        </button>
      )}
      <Modal open={detailsOpen} onClose={() => setDetailsOpen(false)} title="Automatischer Lohnlauf" size="md">
        <div className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Gestartet {formatDateTimeFull(lauf.gestartet_at)}{lauf.beendet_at ? `, beendet ${formatDateTimeFull(lauf.beendet_at)}` : ""} · {lauf.zusammenfassung ?? lauf.status}
          </p>
          {fehlerZeilen.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Fehler (betrifft nur diese Abrechnungen)</p>
              <ul className="space-y-1">
                {fehlerZeilen.map((f, i) => (
                  <li key={i} className="text-xs rounded-md border border-red-200 dark:border-red-500/30 bg-red-50/60 dark:bg-red-500/[0.08] px-2 py-1.5">
                    <span className="font-medium">{f.name} · {monatLabel({ jahr: Number(f.monat.slice(0, 4)), monat: Number(f.monat.slice(5, 7)) })}</span>
                    <span className="block text-muted-foreground">{f.fehler}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {lauf.hinweise.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Hinweise</p>
              <ul className="space-y-1">
                {lauf.hinweise.map((h, i) => (
                  <li key={i} className="text-xs">{h.name ? <span className="font-medium">{h.name}: </span> : null}{h.text}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

function sortDocs(a: WageDoc, b: WageDoc): number {
  // Lohnausweis zuerst, dann Lohnabrechnungen absteigend nach Monat
  if (a.doc_type !== b.doc_type) return a.doc_type === "lohnausweis" ? -1 : 1;
  return (b.period_month ?? 0) - (a.period_month ?? 0) || (b.version ?? 1) - (a.version ?? 1);
}

function docLabel(doc: WageDoc): string {
  return doc.doc_type === "lohnausweis"
    ? `Lohnausweis ${doc.year}`
    : `Lohnabrechnung ${MONTH_NAMES[(doc.period_month ?? 1) - 1]} ${doc.year}`;
}

function DocRow({ doc, busy, onDownload, onArchive, onRestore }: { doc: WageDoc; busy: boolean; onDownload: () => void; onArchive: () => void; onRestore: () => void }) {
  const sizeMb = doc.file_size ? (doc.file_size / 1024 / 1024).toFixed(2) : null;
  const herkunft = doc.source === "manual" ? "hochgeladen" : "erzeugt";
  const von = doc.uploaded_by_name ? ` von ${doc.uploaded_by_name}` : "";
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-border bg-foreground/[0.02] dark:bg-foreground/[0.04]">
      <div className="min-w-0 flex items-center gap-2">
        <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">
            {docLabel(doc)}
            {(doc.version ?? 1) > 1 && (
              <span className="ml-2 text-[10px] font-semibold rounded-full px-1.5 py-0.5 bg-foreground/[0.07] dark:bg-foreground/[0.15] text-muted-foreground align-middle">
                Fassung {doc.version}
              </span>
            )}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {doc.archived_at
              ? `Im Papierkorb seit ${formatDateTimeFull(doc.archived_at)}${doc.archived_by_name ? ` (${doc.archived_by_name})` : ""}${doc.archive_reason ? ` · ${doc.archive_reason}` : ""}`
              : `${herkunft[0].toUpperCase()}${herkunft.slice(1)} am ${new Date(doc.uploaded_at).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}${von}${sizeMb ? ` · ${sizeMb} MB` : ""}`}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button type="button" onClick={onDownload} className="kasten kasten-muted" data-tooltip="Herunterladen" aria-label="Herunterladen">
          <Download className="h-3.5 w-3.5" />
        </button>
        {doc.archived_at ? (
          <button type="button" onClick={onRestore} disabled={busy} className="kasten kasten-muted" data-tooltip="Wiederherstellen" aria-label="Wiederherstellen">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArchiveRestore className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <button type="button" onClick={onArchive} disabled={busy} className="kasten kasten-red" data-tooltip="In den Papierkorb (nie endgültig gelöscht)" aria-label="In den Papierkorb">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />}
          </button>
        )}
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
  // Rückfrage «neue Fassung», wenn es für den Zeitraum schon ein Dokument gibt.
  const [rueckfrage, setRueckfrage] = useState<string | null>(null);

  async function senden(neueFassung: boolean) {
    if (!file) { toast.error("PDF auswählen"); return; }
    if (file.type !== "application/pdf") { toast.error("Nur PDF erlaubt"); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("profile_id", profileId);
      fd.append("doc_type", docType);
      fd.append("year", year);
      if (docType === "lohnabrechnung") fd.append("period_month", month);
      if (notes) fd.append("notes", notes);
      if (neueFassung) fd.append("neue_fassung", "true");
      const res = await fetch("/api/hr/wage-documents", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!j.success) {
        if (j.requires_confirm === "neue_fassung") { setRueckfrage(j.error); return; }
        TOAST.errorOr(j.error);
        return;
      }
      toast.success(j.version > 1 ? `Hochgeladen als Fassung ${j.version}` : "Dokument hochgeladen");
      setFile(null); setNotes(""); setRueckfrage(null);
      onDone();
    } catch (e) {
      toast.error(`Hochladen fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUploading(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    void senden(false);
  }

  return (
    <Modal open={open} onClose={() => { if (!uploading) { setRueckfrage(null); onClose(); } }} title="Lohndokument hochladen" size="md">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-muted-foreground">Typ</label>
            <div className="mt-1">
              <SearchableSelect
                value={docType}
                onChange={(v) => { setDocType((v || "lohnabrechnung") as "lohnabrechnung" | "lohnausweis"); setRueckfrage(null); }}
                items={[
                  { id: "lohnabrechnung", label: "Lohnabrechnung (monatlich)" },
                  { id: "lohnausweis",    label: "Lohnausweis (jährlich)" },
                ]}
                searchable={false}
                clearable={false}
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground">Jahr</label>
            <Input type="number" value={year} onChange={(e) => { setYear(e.target.value); setRueckfrage(null); }} min={2020} max={2100} className="mt-1" />
          </div>
        </div>
        {docType === "lohnabrechnung" && (
          <div>
            <label className="text-[10px] text-muted-foreground">Monat</label>
            <div className="mt-1">
              <SearchableSelect
                value={month}
                onChange={(v) => { setMonth(v || String(new Date().getMonth() + 1)); setRueckfrage(null); }}
                items={MONTH_NAMES.map((m, i) => ({ id: String(i + 1), label: m }))}
                searchable={false}
                clearable={false}
              />
            </div>
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
        {rueckfrage && (
          <p className="text-xs rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/[0.08] px-2 py-1.5">{rueckfrage}</p>
        )}
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={() => { setRueckfrage(null); onClose(); }} disabled={uploading} className="kasten kasten-muted flex-1">Abbrechen</button>
          {rueckfrage ? (
            <button type="button" onClick={() => void senden(true)} disabled={uploading || !file} className="kasten kasten-red flex-1">
              {uploading ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Lädt…</> : "Als neue Fassung hochladen"}
            </button>
          ) : (
            <button type="submit" disabled={uploading || !file} className="kasten kasten-red flex-1">
              {uploading ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Lädt…</> : "Hochladen"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

function GenerateModal({ open, onClose, profileId, employee, onDone }: { open: boolean; onClose: () => void; profileId: string; employee: Employee | undefined; onDone: () => void }) {
  // Nur gesperrte Monate (ab dem 5. des Folgemonats); Vorgabe = letzter gesperrter.
  const [monate] = useState(() => letzteGesperrteMonate(todayLocalIso(), 24));
  const [wahl, setWahl] = useState(() => monatSchluessel(monate[0]));
  const [busy, setBusy] = useState(false);
  const [rueckfrage, setRueckfrage] = useState<string | null>(null);

  async function erzeugen(neueFassung: boolean) {
    const [year, month] = wahl.split("-").map(Number);
    setBusy(true);
    try {
      const res = await fetch("/api/hr/wage-documents/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile_id: profileId, year, month, neue_fassung: neueFassung }),
      });
      const j = await res.json().catch(() => ({}));
      if (!j.success) {
        if (j.requires_confirm === "neue_fassung") { setRueckfrage(j.error); return; }
        TOAST.errorOr(j.error);
        return;
      }
      toast.success(j.version > 1 ? `Lohnabrechnung als Fassung ${j.version} erzeugt` : "Lohnabrechnung erzeugt");
      setRueckfrage(null);
      onDone();
    } catch (e) {
      toast.error(`Erzeugen fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => { if (!busy) { setRueckfrage(null); onClose(); } }} title="Lohnabrechnung erzeugen" size="md">
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Erzeugt die PDF-Lohnabrechnung für <strong>{employee?.full_name ?? "—"}</strong> aus den erfassten Stunden + Lohndaten.
          Nur abgeschlossene Monate (gesperrt ab dem 5. des Folgemonats). Gibt es schon eine, wird nachgefragt — die bisherige bleibt erhalten.
        </p>
        <div>
          <label className="text-[10px] text-muted-foreground">Monat</label>
          <div className="mt-1">
            <SearchableSelect
              value={wahl}
              onChange={(v) => { if (v) setWahl(v); setRueckfrage(null); }}
              items={monate.map((m) => ({ id: monatSchluessel(m), label: monatLabel(m) }))}
              clearable={false}
            />
          </div>
        </div>
        {rueckfrage && (
          <p className="text-xs rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/[0.08] px-2 py-1.5">{rueckfrage}</p>
        )}
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={() => { setRueckfrage(null); onClose(); }} disabled={busy} className="kasten kasten-muted flex-1">Abbrechen</button>
          <button type="button" onClick={() => void erzeugen(!!rueckfrage)} disabled={busy} className="kasten kasten-red flex-1">
            {busy
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Erzeugt…</>
              : rueckfrage
              ? "Neue Fassung erzeugen"
              : <><Plus className="h-3.5 w-3.5" /> Erzeugen</>}
          </button>
        </div>
      </div>
    </Modal>
  );
}
