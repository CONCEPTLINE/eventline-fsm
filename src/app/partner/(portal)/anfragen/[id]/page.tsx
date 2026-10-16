"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ZeitFeld } from "@/components/ui/zeit-feld";
import { ArrowLeft, Calendar, Clock, Plus, Trash2, StickyNote, Check, XCircle, AlertCircle, FileText, Upload, Eye, Download, Pencil, Send, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { localDateIso } from "@/lib/swiss-time";
import { useConfirm } from "@/components/ui/use-confirm";
import { toLocalIsoString } from "@/lib/format";
import { validateFileList } from "@/lib/file-upload";
import { PdfPopup } from "@/components/pdf-popup";
import { ZEIT_MODI, zeitModusDef, type TerminZeitModus } from "@/lib/termin-zeitfenster";
import { partnerApi } from "@/lib/partner-api";
import { partnerAnhangHochladen } from "@/lib/partner-upload";
import { AENDERUNG_SPERRFRIST_TAGE, aenderungGesperrt as sperrfristErreicht } from "@/lib/partner-anfrage";

// Alle Daten kommen von /api/partner/anfragen/[id] (nur eigene Anfragen,
// feste Feld-Liste); alle Aktionen laufen ueber die Server-Routen darunter.

interface AnfrageDetail {
  id: string;
  job_number: number | null;
  title: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string;
  notes: string | null;
  partner_response_message: string | null;
  accepted_at: string | null;
  rejected_at: string | null;
  contact_person: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  /** true, wenn eine bestaetigte Anfrage gerade geaendert wird (Aenderung
   *  wartet auf EVENTLINE). */
  partner_aenderung: boolean;
}

interface Termin {
  id: string;
  title: string;
  start_time: string;
  end_time: string | null;
  description: string | null;
  /** Zeitfenster-Art (fix / verschiebbar / deadline), siehe lib/termin-zeitfenster. */
  zeit_modus: TerminZeitModus;
  /** Name der zugeteilten EVENTLINE-Person (null = nicht zugeteilt). */
  zugewiesen: string | null;
}

interface DocRow {
  id: string;
  name: string;
  file_size: number | null;
  created_at: string;
}

export default function PartnerAnfrageDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { confirm, ConfirmModalElement } = useConfirm();

  const [job, setJob] = useState<AnfrageDetail | null>(null);
  const [termine, setTermine] = useState<Termin[]>([]);
  const [documents, setDocuments] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notesText, setNotesText] = useState("");
  const [savedNotesText, setSavedNotesText] = useState("");
  const [showTerminForm, setShowTerminForm] = useState(false);
  const LEERES_TERMIN_FORM = { title: "", date: "", time: "", end_time: "", description: "", zeit_modus: "fix" as TerminZeitModus };
  const [terminForm, setTerminForm] = useState(LEERES_TERMIN_FORM);
  /** Termin-ID im Bearbeiten-Modus — null = neuen Termin anlegen. */
  const [editTerminId, setEditTerminId] = useState<string | null>(null);
  const [savingTermin, setSavingTermin] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [previewDoc, setPreviewDoc] = useState<{ url: string; title: string } | null>(null);
  // Titel bearbeiten (Inline im Kopf). Gleiche Grenze wie die RPC
  // partner_update_title (Migration 315).
  const TITEL_MAX = 200;
  const [titelEdit, setTitelEdit] = useState(false);
  const [titelEntwurf, setTitelEntwurf] = useState("");
  const [titelSaving, setTitelSaving] = useState(false);
  const titelSpeichernRef = useRef<HTMLButtonElement | null>(null);

  // Strukturelle Aktionen (Termin hinzufuegen/loeschen, Anfrage zurueckziehen)
  // sind verfuegbar solange die Anfrage noch beim Partner liegt
  // (partner_entwurf, partner_anfrage). Nach EVENTLINE-Annahme gesperrt.
  const isEditable = job ? (job.status === "partner_entwurf" || job.status === "partner_anfrage") : false;
  const isReadOnly = !isEditable;
  // Titel: gleiche Regel — direkt aenderbar solange noch nicht bestaetigt
  // (auch im Aenderungsmodus einer bestaetigten Anfrage, dort sieht
  // EVENTLINE alt -> neu). Bestaetigt ('offen'): nur ueber «Änderungen
  // vornehmen». Die RPC prueft dasselbe serverseitig.
  // Notizen und Dokumente bleiben kollaborativ — auch nach Annahme darf
  // der Partner noch nachreichen (z.B. geaenderter Ablauf, neue Files).
  // Bei "abgeschlossen"/"storniert" ist die Beziehung zu Ende → keine
  // Aenderungen mehr.
  const canEditNotesAndDocs = job ? (job.status === "partner_entwurf" || job.status === "partner_anfrage" || job.status === "offen") : false;
  // Absende-Button nur bei Entwurf + min. 1 Termin sichtbar.
  const isDraft = job?.status === "partner_entwurf";
  const canSubmit = isDraft && termine.length > 0;
  const [submitting, setSubmitting] = useState(false);
  const [aendernBusy, setAendernBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  // Aenderungs-Sperrfrist: ab 3 Tage vor der Veranstaltung laufen
  // Aenderungen nur noch direkt ueber EVENTLINE (Server prueft ebenfalls,
  // gleiche Regel aus src/lib/partner-anfrage.ts).
  const aenderungGesperrt = sperrfristErreicht(job?.start_date);

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function loadAll() {
    const r = await partnerApi<{ anfrage: AnfrageDetail; termine: Termin[]; dokumente: DocRow[] }>(`/api/partner/anfragen/${id}`);
    if (!r.ok) {
      // Fremde und nicht vorhandene Anfragen sind fuer den Server gleich
      // («nicht gefunden»); andere Fehler mit ihrer Meldung.
      toast.error(r.status === 404 || !r.fehler ? "Anfrage nicht gefunden" : r.fehler);
      router.push("/partner/anfragen");
      return;
    }
    const { anfrage, termine: termineDaten, dokumente } = r.daten;
    setJob(anfrage);
    // Notizen-Parser: ältere Aufträge tragen das Firmenportal-_notes-JSON
    // (`{"_notes":[{content,author,created_at}, ...]}`) als String. Wir
    // rendern die History mit "[Author, Datum]"-Headern pro Eintrag, damit
    // der Partner Audit-Trail sieht bevor er drüber schreibt. Plain-Text-
    // Notes bleiben as-is.
    let initialNotes = "";
    if (anfrage.notes) {
      try {
        const parsed = JSON.parse(anfrage.notes);
        if (parsed && Array.isArray(parsed._notes)) {
          initialNotes = parsed._notes
            .map((n: { content: string; author?: string; created_at?: string }) => {
              const header: string[] = [];
              if (n.author) header.push(n.author);
              if (n.created_at) {
                try { header.push(new Date(n.created_at).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric" })); } catch { /* ignore */ }
              }
              return header.length > 0 ? `[${header.join(", ")}]\n${n.content}` : n.content;
            })
            .join("\n\n");
        } else {
          initialNotes = anfrage.notes;
        }
      } catch {
        initialNotes = anfrage.notes;
      }
    }
    setNotesText(initialNotes);
    setSavedNotesText(initialNotes);
    setTermine(termineDaten);
    setDocuments(dokumente);
    setLoading(false);
  }

  // Autosave Notizen — Server-Route (eigene Anfrage, Recht partner:anfragen:
  // edit), auch in status='offen' (Nachreichen nach Annahme). Titel und
  // Status aendert der Partner nie ueber diesen Weg.
  useEffect(() => {
    if (!canEditNotesAndDocs) return;
    if (notesText === savedNotesText) return;
    const handle = setTimeout(async () => {
      const r = await partnerApi(`/api/partner/anfragen/${id}`, { aktion: "notizen", notizen: notesText });
      if (!r.ok) {
        TOAST.supabaseError(r.fehler, "Notizen konnten nicht gespeichert werden");
        return;
      }
      setSavedNotesText(notesText);
    }, 800);
    return () => clearTimeout(handle);
  }, [notesText, savedNotesText, id, canEditNotesAndDocs]);

  async function onFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const validated = validateFileList(files);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!validated || validated.length === 0) return;
    setUploadBusy(true);
    let okCount = 0;
    for (const file of validated) {
      // Direkt in den Storage (signierte URL vom Server), danach legt der
      // Server die Dokument-Zeile an — src/lib/partner-upload.ts.
      const fehler = await partnerAnhangHochladen(String(id), file);
      if (fehler) { TOAST.uploadError(fehler); continue; }
      okCount++;
    }
    setUploadBusy(false);
    if (okCount > 0) toast.success(`${okCount} Dokument${okCount > 1 ? "e" : ""} hochgeladen`);
    loadAll();
  }

  /** Signierte URL vom Server (1 h) — nur fuer Dokumente, die der Partner
   *  sehen darf. */
  async function dokUrl(doc: DocRow): Promise<string | null> {
    const r = await partnerApi<{ url: string }>(`/api/partner/anfragen/${id}/dokumente?dok=${doc.id}`);
    if (!r.ok || !r.daten.url) {
      toast.error("Datei nicht verfügbar");
      return null;
    }
    return r.daten.url;
  }

  async function openDocPreview(doc: DocRow) {
    const url = await dokUrl(doc);
    if (url) setPreviewDoc({ url, title: doc.name });
  }

  async function downloadDoc(doc: DocRow) {
    const url = await dokUrl(doc);
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.name;
    a.click();
  }

  function startTitelEdit() {
    if (!job) return;
    setTitelEntwurf(job.title);
    setTitelEdit(true);
  }

  async function saveTitel() {
    if (!job || titelSaving) return;
    // Gleiche Normalisierung wie die RPC: Leerraum zusammenfassen + trimmen.
    const neu = titelEntwurf.replace(/\s+/g, " ").trim();
    if (!neu) {
      toast.error("Titel darf nicht leer sein");
      return;
    }
    if (neu.length > TITEL_MAX) {
      toast.error(`Titel ist zu lang (höchstens ${TITEL_MAX} Zeichen)`);
      return;
    }
    if (neu === job.title) {
      setTitelEdit(false);
      return;
    }
    setTitelSaving(true);
    // Server-Route → RPC partner_update_title (Migration 315) im Namen des
    // Partners: prueft Standort, Recht und Status und aendert nur den Titel.
    const r = await partnerApi<{ titel: string | null }>(`/api/partner/anfragen/${id}`, { aktion: "titel", titel: neu });
    setTitelSaving(false);
    if (!r.ok) {
      TOAST.supabaseError(r.fehler, "Titel konnte nicht gespeichert werden");
      // Status kann sich inzwischen geaendert haben (z.B. EVENTLINE hat
      // bestaetigt) — neu laden, dann verschwindet das Feld ggf.
      loadAll();
      return;
    }
    setJob((j) => (j ? { ...j, title: r.daten.titel ?? neu } : j));
    setTitelEdit(false);
    toast.success("Titel geändert");
  }

  async function submitAnfrage() {
    if (!canSubmit) return;
    const ok = await confirm({
      title: "Anfrage an EVENTLINE absenden?",
      message: "Nach dem Absenden kannst du den Termin nicht mehr selbst ändern — EVENTLINE prüft die Anfrage und meldet sich.",
      confirmLabel: "Absenden",
      variant: "red",
    });
    if (!ok) return;
    setSubmitting(true);
    const r = await partnerApi(`/api/partner/anfragen/${id}`, { aktion: "absenden" });
    setSubmitting(false);
    if (!r.ok) {
      TOAST.supabaseError(r.fehler, "Anfrage konnte nicht abgeschickt werden");
      return;
    }
    toast.success("Anfrage abgeschickt — EVENTLINE schaut sie an");
    loadAll();
  }

  /** Formular vorbefuellt im Bearbeiten-Modus oeffnen. */
  function startEditTermin(t: Termin) {
    setEditTerminId(t.id);
    setTerminForm({
      title: t.title,
      date: localDateIso(new Date(t.start_time)),
      time: new Date(t.start_time).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" }),
      end_time: t.end_time
        ? new Date(t.end_time).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" })
        : "",
      description: t.description ?? "",
      zeit_modus: t.zeit_modus ?? "fix",
    });
    setShowTerminForm(true);
  }

  function closeTerminForm() {
    setShowTerminForm(false);
    setEditTerminId(null);
    setTerminForm(LEERES_TERMIN_FORM);
  }

  async function saveTermin(e: React.FormEvent) {
    e.preventDefault();
    const istDeadline = terminForm.zeit_modus === "deadline";
    if (!terminForm.title.trim() || !terminForm.date || !terminForm.time) {
      toast.error(istDeadline ? "Titel, Datum und Zeitpunkt sind Pflicht" : "Titel, Datum und Startzeit sind Pflicht");
      return;
    }
    // Termin muss im Event-Zeitraum liegen (Datums-Vergleich auf YYYY-MM-DD).
    // job.start_date/end_date sind timestamptz — via localDateIso ins
    // Europe/Zurich-Datum, sonst kippt der Vergleich bei Events kurz nach
    // Mitternacht auf den falschen UTC-Tag.
    const startDay = job?.start_date ? localDateIso(new Date(job.start_date)) : undefined;
    const endDay = job?.end_date ? localDateIso(new Date(job.end_date)) : undefined;
    if (startDay && terminForm.date < startDay) {
      toast.error("Termin liegt vor dem Veranstaltungsbeginn");
      return;
    }
    if (endDay && terminForm.date > endDay) {
      toast.error("Termin liegt nach dem Veranstaltungsende");
      return;
    }
    setSavingTermin(true);
    // Bei "Fertig bis" ist die eine Zeitangabe die Deadline (start_time),
    // ein Bis-Feld gibt es nicht.
    const startISO = toLocalIsoString(terminForm.date, terminForm.time);
    const endISO = !istDeadline && terminForm.end_time
      ? toLocalIsoString(terminForm.date, terminForm.end_time)
      : null;
    // Anlegen und Bearbeiten ueber die Server-Route (nur solange die Anfrage
    // noch beim Partner liegt; gleiche Pruefungen wie bisher).
    const r = await partnerApi(`/api/partner/anfragen/${id}/termine`, {
      aktion: editTerminId ? "aendern" : "anlegen",
      ...(editTerminId ? { terminId: editTerminId } : {}),
      titel: terminForm.title.trim(),
      start: startISO,
      ende: endISO,
      beschreibung: terminForm.description.trim() || null,
      zeit_modus: terminForm.zeit_modus,
    });
    setSavingTermin(false);
    if (!r.ok) {
      TOAST.supabaseError(r.fehler, editTerminId ? "Termin konnte nicht gespeichert werden" : "Termin konnte nicht erstellt werden");
      return;
    }
    toast.success(editTerminId ? "Termin angepasst" : "Termin hinzugefügt");
    closeTerminForm();
    loadAll();
  }

  async function deleteTermin(termin: Termin) {
    const ok = await confirm({
      title: "Termin löschen?",
      message: `"${termin.title}" wird entfernt.`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    const r = await partnerApi(`/api/partner/anfragen/${id}/termine`, { aktion: "loeschen", terminId: termin.id });
    if (!r.ok) {
      TOAST.deleteError(r.fehler);
      return;
    }
    toast.success("Termin gelöscht");
    loadAll();
  }

  async function deleteAnfrage() {
    const ok = await confirm({
      title: "Anfrage löschen?",
      message: "Die Anfrage und alle zugehörigen Termine + Anhänge werden entfernt. Dies kann nicht rückgängig gemacht werden.",
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    // Server-Route: RPC partner_withdraw_anfrage im Namen des Partners
    // (Status-/Standort-Pruefung, Cascade in einer Transaktion), danach
    // entfernt der Server die Anhaenge aus dem Storage. Partner duerfen im
    // Bucket documents selbst nichts loeschen (Migration 308).
    setWithdrawing(true);
    const r = await partnerApi<{ warnung?: string }>(`/api/partner/anfragen/${id}/zurueckziehen`, {});
    if (!r.ok) {
      setWithdrawing(false);
      toast.error(r.fehler || "Anfrage konnte nicht zurückgezogen werden");
      return;
    }
    if (r.daten.warnung) toast.warning(r.daten.warnung);
    toast.success("Anfrage zurückgezogen");
    router.push("/partner/anfragen");
  }

  if (loading || !job) {
    return (
      <div className="space-y-4 max-w-3xl mx-auto">
        <div className="h-8 w-40 rounded bg-foreground/10 dark:bg-foreground/15 animate-pulse" />
        <div className="h-32 rounded-xl bg-foreground/10 dark:bg-foreground/15 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      <div className="flex items-center gap-3">
        {/* Am Handy liefert der mobile Kopf den Zurueck-Pfeil */}
        <button
          type="button"
          onClick={() => router.push("/partner/anfragen")}
          className="p-2 rounded-lg hover:bg-foreground/5 dark:hover:bg-foreground/10 transition-colors max-md:hidden"
          aria-label="Zurück"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1 min-w-0">
          {job.job_number && (
            <span className="text-[10px] font-mono text-muted-foreground bg-foreground/[0.05] dark:bg-foreground/10 px-1.5 py-0.5 rounded">
              INT-{String(job.job_number).padStart(4, "0")}
            </span>
          )}
          {titelEdit && isEditable ? (
            // Am Handy: Feld ueber die ganze Breite, Knoepfe darunter.
            <div className="mt-1 flex items-center gap-2 max-md:flex-wrap">
              <Input
                value={titelEntwurf}
                onChange={(e) => setTitelEntwurf(e.target.value)}
                onKeyDown={(e) => {
                  // Enter schickt nie ab — springt auf «Speichern» weiter
                  // (preventDefault: der globale Enter-als-Tab-Hook greift dann nicht).
                  if (e.key === "Enter") {
                    e.preventDefault();
                    titelSpeichernRef.current?.focus();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setTitelEdit(false);
                  }
                }}
                maxLength={TITEL_MAX}
                disabled={titelSaving}
                autoFocus
                aria-label="Titel der Anfrage"
                placeholder="Titel der Anfrage"
                className="flex-1 font-semibold max-md:basis-full"
              />
              <button
                type="button"
                onClick={() => setTitelEdit(false)}
                disabled={titelSaving}
                className="kasten kasten-muted shrink-0 max-md:flex-1"
              >
                Abbrechen
              </button>
              <button
                ref={titelSpeichernRef}
                type="button"
                onClick={saveTitel}
                disabled={titelSaving}
                className="kasten kasten-blue shrink-0 max-md:flex-1"
              >
                {titelSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                {titelSaving ? "Speichert…" : "Speichern"}
              </button>
            </div>
          ) : (
            <div className="mt-1 flex items-center gap-2 max-md:items-start">
              {/* Am Handy bricht der Titel um statt abgeschnitten zu werden */}
              <h1 className="min-w-0 text-2xl font-bold tracking-tight md:truncate max-md:text-xl max-md:break-words">{job.title}</h1>
              {isEditable && (
                <button
                  type="button"
                  onClick={startTitelEdit}
                  className="kasten kasten-blue shrink-0"
                  aria-label="Titel ändern"
                  data-tooltip="Titel ändern"
                  data-tooltip-side="bottom"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Status-Banner */}
      {job.status === "partner_entwurf" && (
        <Card className="bg-foreground/[0.04] dark:bg-foreground/10 border-foreground/15 dark:border-foreground/20">
          {/* Am Handy rutscht der Senden-Knopf in voller Breite unter den Text */}
          <CardContent className="p-4 flex items-start gap-3 max-md:flex-wrap">
            <Pencil className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
            <div className="text-sm flex-1">
              <p className="font-semibold text-foreground">Entwurf — noch nicht abgeschickt</p>
              <p className="text-muted-foreground mt-0.5">
                {canSubmit
                  ? "Du kannst die Anfrage jetzt an EVENTLINE absenden."
                  : "Trag mindestens einen Termin ein, dann kannst du die Anfrage an EVENTLINE absenden."}
              </p>
            </div>
            {canSubmit && (
              <button
                type="button"
                onClick={submitAnfrage}
                disabled={submitting}
                className="kasten kasten-red shrink-0 max-md:w-full"
              >
                <Send className="h-3.5 w-3.5" />
                {submitting ? "Sendet…" : "Anfrage senden"}
              </button>
            )}
          </CardContent>
        </Card>
      )}
      {job.status === "partner_anfrage" && (
        <Card className="bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30">
          <CardContent className="p-4 flex items-start gap-3">
            <Clock className="h-5 w-5 text-amber-700 dark:text-amber-300 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-semibold text-amber-800 dark:text-amber-200">
                {job.partner_aenderung ? "Änderung wartet auf EVENTLINE" : "Wartet auf EVENTLINE"}
              </p>
              <p className="text-amber-700 dark:text-amber-300 mt-0.5">
                {job.partner_aenderung
                  ? "Deine Änderungen sind bei EVENTLINE gemeldet. Du kannst Termine und Angaben weiter anpassen, bis EVENTLINE die Änderung bestätigt."
                  : "EVENTLINE prüft die Anfrage und meldet sich. Du kannst Titel, Termine und Notizen jetzt noch anpassen."}
              </p>
            </div>
          </CardContent>
        </Card>
      )}
      {(job.status === "offen" || job.status === "abgeschlossen") && (
        <Card className="bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/30">
          <CardContent className="p-4 flex items-start gap-3">
            <Check className="h-5 w-5 text-green-700 dark:text-green-300 shrink-0 mt-0.5" />
            <div className="text-sm flex-1">
              <p className="font-semibold text-green-800 dark:text-green-200">
                {job.status === "offen" ? "Bestätigt — EVENTLINE kümmert sich" : "Abgeschlossen"}
              </p>
              <p className="text-green-700 dark:text-green-300 mt-0.5">
                {job.status === "offen"
                  ? aenderungGesperrt
                    ? `Weniger als ${AENDERUNG_SPERRFRIST_TAGE} Tage bis zur Veranstaltung — Änderungen jetzt bitte direkt mit EVENTLINE besprechen (Telefon), damit die Planung sicher ankommt.`
                    : "Hat sich etwas geändert (Titel, Zeiten, Ablauf, Termine)? Nimm die Änderung direkt hier vor — EVENTLINE wird sofort informiert."
                  : "Änderungen bitte direkt an EVENTLINE melden."}
              </p>
              {job.status === "offen" && !aenderungGesperrt && (
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Änderungen vornehmen?",
                      message:
                        "Die Anfrage geht zurück in die Bearbeitung: Du kannst Titel, Termine und Angaben anpassen, EVENTLINE wird sofort informiert und bestätigt die Änderung neu. Bis dahin gilt der Stand als ausstehend.",
                      confirmLabel: "Änderungen vornehmen",
                      variant: "blue",
                    });
                    if (!ok) return;
                    setAendernBusy(true);
                    try {
                      const r = await partnerApi(`/api/partner/anfragen/${job.id}/aendern`, {});
                      if (!r.ok) {
                        toast.error(r.fehler ?? "Aktion fehlgeschlagen");
                        return;
                      }
                      toast.success("Anfrage ist wieder bearbeitbar — EVENTLINE wurde informiert");
                      await loadAll();
                    } finally {
                      setAendernBusy(false);
                    }
                  }}
                  disabled={aendernBusy}
                  className="kasten kasten-blue mt-2 max-md:w-full"
                >
                  {aendernBusy ? <Clock className="h-3.5 w-3.5 animate-spin" /> : <Pencil className="h-3.5 w-3.5" />}
                  Änderungen vornehmen
                </button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
      {job.status === "storniert" && (
        <Card className="bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30">
          <CardContent className="p-4 flex items-start gap-3">
            <XCircle className="h-5 w-5 text-red-700 dark:text-red-300 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-semibold text-red-800 dark:text-red-200">Anfrage abgelehnt</p>
              {job.partner_response_message && (
                <p className="text-red-700 dark:text-red-300 mt-0.5">
                  Grund: {job.partner_response_message}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Anfrage-Details */}
      <Card className="bg-card">
        <CardHeader className="pb-3 max-md:pb-0">
          <CardTitle className="text-sm font-medium text-muted-foreground">Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {(job.start_date || job.end_date) && (
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <span>
                {job.start_date && new Date(job.start_date).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric" })}
                {job.end_date && job.end_date !== job.start_date && ` – ${new Date(job.end_date).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric" })}`}
              </span>
            </div>
          )}
          {job.description && (
            <div className="pt-2 border-t border-border">
              <p className="text-xs text-muted-foreground mb-1">Beschreibung</p>
              <p className="whitespace-pre-wrap">{job.description}</p>
            </div>
          )}
          {(job.contact_person || job.contact_phone || job.contact_email) && (
            <div className="pt-2 border-t border-border">
              <p className="text-xs text-muted-foreground mb-1">Veranstalter-Kontakt</p>
              {job.contact_person && <p>{job.contact_person}</p>}
              <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5 flex-wrap">
                {job.contact_phone && <span>{job.contact_phone}</span>}
                {job.contact_email && <span>{job.contact_email}</span>}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Termine */}
      <Card className="bg-card">
        <CardHeader className="pb-3 max-md:pb-0 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Clock className="h-4 w-4" />Termine ({termine.length})
          </CardTitle>
          {!isReadOnly && (
            <button
              type="button"
              onClick={() => {
                if (showTerminForm) closeTerminForm();
                else { setEditTerminId(null); setTerminForm(LEERES_TERMIN_FORM); setShowTerminForm(true); }
              }}
              className="kasten kasten-blue"
            >
              <Plus className="h-3.5 w-3.5" />
              Termin
            </button>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {showTerminForm && !isReadOnly && (
            <form onSubmit={saveTermin} className="p-3 rounded-lg bg-foreground/[0.03] border border-foreground/10 dark:bg-foreground/5 dark:border-foreground/15 space-y-3">
              {editTerminId && (
                <p className="text-xs font-semibold text-muted-foreground">Termin bearbeiten</p>
              )}
              <Input
                placeholder="Termin-Titel *"
                value={terminForm.title}
                onChange={(e) => setTerminForm({ ...terminForm, title: e.target.value })}
                required
              />
              {/* Zeitfenster-Art — bestimmt wie hart die Zeitangabe ist
                  (fix / nach Absprache verschiebbar / nur Deadline). */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium">Zeitfenster *</label>
                {ZEIT_MODI.map((m) => {
                  const aktiv = terminForm.zeit_modus === m.key;
                  return (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => setTerminForm({ ...terminForm, zeit_modus: m.key })}
                      className={`w-full text-left p-2.5 rounded-lg border transition-colors ${
                        aktiv
                          ? "border-foreground/50 bg-foreground/[0.06] dark:bg-foreground/10"
                          : "border-border bg-card"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${aktiv ? "border-foreground bg-foreground" : "border-muted-foreground/40"}`} />
                        <span className="text-sm font-medium">{m.label}</span>
                      </span>
                      <span className="block text-[11px] text-muted-foreground mt-0.5 ml-[22px]">{m.hint}</span>
                    </button>
                  );
                })}
              </div>
              {/* Am Handy: Datum ueber die ganze Breite, darunter Von/Bis
                  bzw. "Fertig bis" — dreispaltig wird das Datumsfeld zu schmal. */}
              <div className={terminForm.zeit_modus === "deadline" ? "grid grid-cols-2 gap-2" : "grid grid-cols-3 gap-2 max-md:grid-cols-2"}>
                <div className="max-md:col-span-2">
                  <label className="text-[11px] font-medium">Datum *</label>
                  <Input
                    type="date"
                    value={terminForm.date}
                    onChange={(e) => setTerminForm({ ...terminForm, date: e.target.value })}
                    min={job?.start_date ? localDateIso(new Date(job.start_date)) : undefined}
                    max={job?.end_date ? localDateIso(new Date(job.end_date)) : undefined}
                    className="mt-1"
                    required
                  />
                </div>
                {terminForm.zeit_modus === "deadline" ? (
                  <div className="max-md:col-span-2">
                    <label className="text-[11px] font-medium">Fertig bis *</label>
                    <ZeitFeld value={terminForm.time} onChange={(v) => setTerminForm({ ...terminForm, time: v })} className="mt-1" required />
                  </div>
                ) : (
                  <>
                    <div>
                      <label className="text-[11px] font-medium">Von *</label>
                      <ZeitFeld value={terminForm.time} onChange={(v) => setTerminForm({ ...terminForm, time: v })} className="mt-1" required />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium">Bis</label>
                      <ZeitFeld value={terminForm.end_time} onChange={(v) => setTerminForm({ ...terminForm, end_time: v })} className="mt-1" />
                    </div>
                  </>
                )}
              </div>
              <textarea
                placeholder="Beschreibung (optional)"
                value={terminForm.description}
                onChange={(e) => setTerminForm({ ...terminForm, description: e.target.value })}
                rows={2}
                className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-card resize-none"
                style={{ fieldSizing: "content" } as React.CSSProperties}
              />
              <div className="flex gap-2">
                <button type="button" onClick={closeTerminForm} className="kasten kasten-muted flex-1">Abbrechen</button>
                <button type="submit" disabled={savingTermin} className="kasten kasten-blue flex-1">
                  {savingTermin ? "Speichern…" : editTerminId ? "Speichern" : "Hinzufügen"}
                </button>
              </div>
            </form>
          )}
          {termine.length === 0 ? (
            isReadOnly ? (
              <div className="flex items-center gap-3 p-3 rounded-lg border border-dashed bg-muted/20">
                <AlertCircle className="h-4 w-4 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Keine Termine.</p>
              </div>
            ) : (
              // Amber Aufmerksamkeits-Banner — gleiches Pattern wie im
              // Firmenportal /auftraege/[id]. Bei Entwurf-Status ohne Termin
              // soll der Partner sofort sehen dass hier was zu tun ist.
              <div className="flex items-center gap-3 p-3 rounded-xl border tinted-amber">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-amber-500/20 shrink-0">
                  <Calendar className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium">Kein Termin geplant</p>
                  <p className="text-xs opacity-80 mt-0.5">
                    {job.start_date ? (() => {
                      const days = Math.ceil((new Date(job.start_date).getTime() - Date.now()) / 86400000);
                      return days > 0 ? `Veranstaltung in ${days} Tag${days === 1 ? "" : "en"}` : days === 0 ? "Veranstaltung ist heute" : `Veranstaltung war vor ${Math.abs(days)} Tag${Math.abs(days) === 1 ? "" : "en"}`;
                    })() : "Kein Startdatum gesetzt"}
                    {isDraft
                      ? " · oben rechts „Termin“ anlegen — Anfrage kann erst danach abgeschickt werden"
                      : " · oben rechts „Termin“ anlegen"}
                  </p>
                </div>
              </div>
            )
          ) : (
            termine.map((t) => (
              <div key={t.id} className="flex items-start justify-between gap-3 p-3 rounded-lg bg-foreground/[0.02] dark:bg-foreground/[0.04] border border-foreground/10 dark:border-foreground/15">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium text-sm">{t.title}</p>
                    {t.zeit_modus !== "fix" && (
                      <span
                        className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-800 dark:bg-sky-500/25 dark:text-sky-200"
                        data-tooltip={zeitModusDef(t.zeit_modus).hint}
                        data-tooltip-side="top"
                      >
                        {zeitModusDef(t.zeit_modus).label}
                      </span>
                    )}
                    {t.zugewiesen && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-foreground/10 dark:bg-foreground/15 text-foreground">
                        {t.zugewiesen}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t.zeit_modus === "deadline" && "Fertig bis "}
                    {new Date(t.start_time).toLocaleString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    {t.zeit_modus !== "deadline" && t.end_time && ` – ${new Date(t.end_time).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" })}`}
                  </p>
                  {t.description && <p className="text-xs mt-1 whitespace-pre-wrap">{t.description}</p>}
                </div>
                {!isReadOnly && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => startEditTermin(t)}
                      className="kasten kasten-blue"
                      aria-label="Termin bearbeiten"
                      data-tooltip="Bearbeiten"
                      data-tooltip-side="top"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteTermin(t)}
                      className="kasten kasten-red"
                      aria-label="Termin löschen"
                      data-tooltip="Löschen"
                      data-tooltip-side="top"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Notizen */}
      <Card className="bg-card">
        <CardHeader className="pb-3 max-md:pb-0">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <StickyNote className="h-4 w-4" />Notizen
          </CardTitle>
        </CardHeader>
        <CardContent>
          <textarea
            value={notesText}
            onChange={(e) => setNotesText(e.target.value)}
            placeholder={canEditNotesAndDocs ? "Was EVENTLINE noch wissen sollte… (wird automatisch gespeichert)" : "Keine Notizen."}
            disabled={!canEditNotesAndDocs}
            rows={4}
            style={{ fieldSizing: "content" } as React.CSSProperties}
            className="w-full px-3 py-2 text-sm rounded-xl border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:bg-muted/30 disabled:cursor-not-allowed"
          />
        </CardContent>
      </Card>

      {/* Dokumente */}
      <Card className="bg-card">
        <CardHeader className="pb-3 max-md:pb-0 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <FileText className="h-4 w-4" />Dokumente ({documents.length})
          </CardTitle>
          {canEditNotesAndDocs && (
            <>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadBusy}
                className="kasten kasten-blue"
              >
                <Upload className="h-3.5 w-3.5" />
                {uploadBusy ? "Lädt hoch…" : "Hochladen"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
                className="hidden"
                onChange={onFilesPicked}
              />
            </>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {documents.length === 0 ? (
            <div className="flex items-center gap-3 p-3 rounded-lg border border-dashed bg-muted/20">
              <AlertCircle className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {canEditNotesAndDocs ? "Noch keine Dokumente. Klick auf „Hochladen“ um eines anzuhängen." : "Keine Dokumente."}
              </p>
            </div>
          ) : (
            documents.map((doc) => (
              <div key={doc.id} className="flex items-center justify-between gap-3 p-3 rounded-lg bg-foreground/[0.02] dark:bg-foreground/[0.04] border border-foreground/10 dark:border-foreground/15">
                <div className="flex items-center gap-3 min-w-0">
                  <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{doc.name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {doc.file_size ? (doc.file_size / 1024).toFixed(0) + " KB · " : ""}
                      {new Date(doc.created_at).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => openDocPreview(doc)}
                    className="kasten kasten-blue"
                    data-tooltip="Vorschau"
                    data-tooltip-side="top"
                    aria-label="Vorschau"
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadDoc(doc)}
                    className="kasten kasten-muted"
                    data-tooltip="Herunterladen"
                    data-tooltip-side="top"
                    aria-label="Herunterladen"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Anfrage loeschen — nur solange noch nicht bearbeitet */}
      {!isReadOnly && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={deleteAnfrage}
            disabled={withdrawing}
            className="kasten kasten-red max-md:w-full"
          >
            {withdrawing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            {withdrawing ? "Wird zurückgezogen…" : "Anfrage zurückziehen"}
          </button>
        </div>
      )}

      {previewDoc && (
        <PdfPopup
          url={previewDoc.url}
          title={previewDoc.title}
          onClose={() => setPreviewDoc(null)}
        />
      )}

      {ConfirmModalElement}
    </div>
  );
}
