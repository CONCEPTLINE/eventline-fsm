"use client";

/**
 * Einsatzrapport-Modal — Orchestrator. Zwei Speicher-Modi:
 *   - "Speichern" → Draft (status='entwurf'), Auftrag bleibt offen.
 *     Auto-Save-debounce schreibt Aenderungen waehrenddessen ins
 *     service_reports — verhindert Datenverlust bei Tab-Close.
 *   - "Auftrag abschliessen" → Final (status='abgeschlossen'), Auftrag
 *     wird auf 'abgeschlossen' gesetzt, PDF generiert + an Documents
 *     gepinnt. Nur sichtbar wenn End-Datum erreicht ist.
 *
 * Aufgeteilt in drei Sub-Komponenten (Ordner ./rapport/):
 *   - TimeRangesSection — Einsatzzeiten-Liste pro Tag
 *   - PhotosSection     — Live-Photo-Upload + Captions
 *   - SignaturesSection — Techniker + Kunde/Mieter
 *
 * Fotos werden LIVE hochgeladen sobald der User welche auswaehlt — der
 * Draft wird ggf. on-the-fly erstellt (siehe getOrCreateDraft). Signaturen
 * erst beim finalen Submit (sind typisch letzter Schritt vor Abschluss).
 */

import { useEffect, useState, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { validateFileList } from "@/lib/file-upload";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { Save } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { reportFormErrors, type FormError } from "@/lib/scroll-to-error";
import { todayLocalDateString } from "@/lib/format";
import { logError } from "@/lib/log";
import { TimeRangesSection } from "./rapport/time-ranges-section";
import { PhotosSection } from "./rapport/photos-section";
import { SignaturesSection } from "./rapport/signatures-section";
import type { TimeRange, ProfileOption, UploadedPhoto } from "./rapport/types";
import { useConfirm } from "@/components/ui/use-confirm";

interface JobMeta {
  id: string;
  title: string;
  job_number: number | null;
  customer_name: string | null;
  location_name: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  job: JobMeta;
  /** Wird gerufen wenn Rapport finalisiert + Auftrag geschlossen wurde —
   *  Parent reloaded dann die Detail-Page. Bei reinem Draft-Save NICHT. */
  onCompleted: () => void;
  /** True wenn End-Datum erreicht — sonst ist nur Draft-Save moeglich,
   *  "Auftrag abschliessen" ist disabled mit Tooltip-Reason. */
  canFinish: boolean;
  finishBlockReason?: string;
  /** Optionale Pre-Close-Validation vom Parent (z.B. Termine-Warnung).
   *  Returns true → fortfahren, false → abbrechen. */
  onBeforeFinalSubmit?: () => Promise<boolean>;
  /** Auftrag stammt aus einer Instandhaltungsarbeit. Dann wird die
   *  Kunden-Unterschrift komplett ausgeblendet — bei einer technischen
   *  Arbeit am Standort gibt es keinen Veranstalter zum Gegenzeichnen. */
  isMaintenance?: boolean;
}

export function RapportFormModal({ open, onClose, job, onCompleted, canFinish, finishBlockReason, onBeforeFinalSubmit, isMaintenance = false }: Props) {
  const supabase = createClient();
  const { confirm, ConfirmModalElement } = useConfirm();
  const [saving, setSaving] = useState<"draft" | "final" | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<"entwurf" | "abgeschlossen" | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipAutoSave = useRef(false);
  // Ref-Spiegel von draftId: useState-Updates sind async, mehrere parallele
  // async-Funktionen wuerden alle den alten state-Wert sehen. Mit dem Ref
  // greift jeder Caller sofort auf den aktuellsten draftId zu und vermeidet
  // doppelte Inserts. Wird zusammen mit setDraftId gesetzt (siehe Helper).
  const draftIdRef = useRef<string | null>(null);
  // In-flight-Guard: solange ein Insert laeuft, warten andere Caller bis
  // der Insert fertig ist und benutzen dann denselben Draft.
  const draftPromise = useRef<Promise<string | null> | null>(null);

  // Eigen-Verwaltete-Standorte: bei denen ist "Mieter vor Ort" Default,
  // sonst "Kunde / Auftraggeber".
  const isOwnVenue = (() => {
    const n = job.location_name?.toLowerCase() || "";
    return ["scala", "bau3", "barakuba"].some((v) => n.includes(v));
  })();

  const [form, setForm] = useState({
    work_description: "",
    equipment_used: "",
    issues: "",
    client_name: isOwnVenue ? "" : (job.customer_name || ""),
    technician_id: "",
    technician_name: "",
  });
  const [timeRanges, setTimeRanges] = useState<TimeRange[]>([
    { date: "", start: "", end: "", pause: 0, technician_id: "" },
  ]);
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [uploadedPhotos, setUploadedPhotos] = useState<UploadedPhoto[]>([]);
  const [photoUploadCount, setPhotoUploadCount] = useState(0);
  const captionTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [clientSignature, setClientSignature] = useState("");
  const [techSignature, setTechSignature] = useState("");
  const [signerType, setSignerType] = useState<"kunde" | "mieter">(isOwnVenue ? "mieter" : "kunde");
  const [signerRole, setSignerRole] = useState("");

  // Profile-Liste fuer Dropdowns (Service-Techniker + per-Tag-Techniker)
  // sowie Self-Default beim ersten Open.
  useEffect(() => {
    if (!open) return;
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name")
        .eq("is_active", true)
        .neq("role", "partner")
        .order("full_name");
      setProfiles((data as ProfileOption[]) ?? []);

      if (!form.technician_id) {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const me = (data as ProfileOption[] | null)?.find((p) => p.id === user.id);
          if (me) {
            setForm((f) => ({ ...f, technician_id: me.id, technician_name: me.full_name }));
          }
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Beim Oeffnen: existierenden Draft (oder finalisierten Rapport) laden,
  // sodass der User dort weitermacht wo er aufgehoert hat.
  useEffect(() => {
    if (!open) {
      // Reset zwischen Open-Cycles damit beim naechsten Aufruf der Lade-
      // Block frisch aus der DB liest statt stale draftId-Ref zu nutzen.
      draftIdRef.current = null;
      draftPromise.current = null;
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("service_reports")
        .select("id, work_description, equipment_used, issues, client_name, technician_name, time_ranges, status")
        .eq("job_id", job.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled || !data) return;
      // skipAutoSave verhindert dass das Setzen der Form-Werte gleich
      // einen Auto-Save-Loop triggert.
      skipAutoSave.current = true;
      draftIdRef.current = data.id;
      setDraftId(data.id);
      setDraftStatus(data.status as "entwurf" | "abgeschlossen");
      setForm((f) => ({
        ...f,
        work_description: data.work_description ?? "",
        equipment_used: data.equipment_used ?? "",
        issues: data.issues ?? "",
        client_name: data.client_name ?? f.client_name,
        technician_name: data.technician_name ?? f.technician_name,
      }));
      if (Array.isArray(data.time_ranges) && data.time_ranges.length > 0) {
        setTimeRanges(data.time_ranges as TimeRange[]);
      }
      await loadPhotos(data.id);
      // Naechster Tick: Auto-Save wieder erlauben
      setTimeout(() => { skipAutoSave.current = false; }, 0);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, job.id]);

  // Auto-Save: 1.5s Debounce nach letzter Aenderung. Nur Text-Felder +
  // time_ranges — Fotos/Signaturen erst beim finalen Submit.
  useEffect(() => {
    if (!open || skipAutoSave.current || draftStatus === "abgeschlossen") return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      if (!form.work_description.trim()) return;
      // Sicherstellen dass ein Draft existiert (race-safe via Ref+Promise),
      // dann nur noch UPDATE — nie wieder INSERT-mit-Fallback hier.
      const id = await getOrCreateDraft();
      if (!id) return;
      const payload = {
        report_date: timeRanges[0]?.date || todayLocalDateString(),
        work_description: form.work_description,
        equipment_used: form.equipment_used || null,
        issues: form.issues || null,
        client_name: form.client_name || null,
        technician_name: form.technician_name || null,
        time_ranges: timeRanges,
      };
      const { error } = await supabase.from("service_reports").update(payload).eq("id", id);
      if (handleDupError(error)) return;
      // Eigenes 2-Sekunden-Flash-Popup zentral im Modal — sichtbarer als
      // ein Sonner-Toast in der Ecke. Re-Trigger setzt den Timer zurueck
      // damit's bei schneller Eingabe nicht flackert.
      setSavedFlash(true);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setSavedFlash(false), 2000);
    }, 1500);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, timeRanges, open, draftStatus]);

  function update(field: keyof typeof form, value: string) {
    setForm((p) => ({ ...p, [field]: value }));
  }

  // Trigger prevent_dup_abgeschlossen_report blockiert weitere Writes wenn
  // schon ein abgeschlossener Rapport fuer den Job existiert (Stale-State-
  // Race-Schutz, siehe Migration 106). Hier zentral abfangen: Toast +
  // Modal schliessen + Parent reloaden, damit der User den existierenden
  // Rapport sieht.
  function handleDupError(error: { code?: string; message?: string } | null): boolean {
    if (!error) return false;
    const isDupRapport = error.code === "23505" && /Rapport/i.test(error.message ?? "");
    if (!isDupRapport) return false;
    toast.error(error.message ?? "Rapport schon abgeschlossen — bitte Seite neu laden");
    onCompleted();
    onClose();
    return true;
  }

  // Garantiert dass genau EIN Draft fuer diesen Job existiert. Alle
  // Save-Pfade (Auto-Save, Photo-Upload, manueller Save, Final-Submit)
  // gehen hierdurch.
  //
  // Race-Sicher via:
  //  1. draftIdRef — sync-Read auf den aktuellsten Wert (kein async-state-Lag)
  //  2. draftPromise.current — wenn schon ein Insert laeuft, warten alle
  //     weiteren Caller auf den gleichen Promise statt selber zu inserten
  //  3. DB-Unique-Index service_reports_one_entwurf_per_job (Migration 122)
  //     — falls Promises trotzdem rennen, lehnt die DB den 2. Insert ab und
  //     wir fetchen stattdessen den existierenden Entwurf
  async function getOrCreateDraft(): Promise<string | null> {
    if (draftIdRef.current) return draftIdRef.current;
    if (draftPromise.current) return draftPromise.current;
    draftPromise.current = (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const { data, error } = await supabase.from("service_reports").insert({
        job_id: job.id,
        created_by: user?.id,
        report_date: timeRanges[0]?.date || todayLocalDateString(),
        work_description: form.work_description || "",
        time_ranges: timeRanges,
        status: "entwurf" as const,
      }).select("id").single();
      if (error?.code === "23505") {
        // Unique-Index hat zugeschlagen — Entwurf existiert schon, hol ihn.
        const { data: existing } = await supabase
          .from("service_reports")
          .select("id")
          .eq("job_id", job.id)
          .eq("status", "entwurf")
          .maybeSingle();
        if (existing?.id) {
          draftIdRef.current = existing.id;
          setDraftId(existing.id);
          setDraftStatus("entwurf");
          return existing.id;
        }
      }
      if (handleDupError(error)) return null;
      if (error || !data) {
        TOAST.supabaseError(error, "Draft konnte nicht erstellt werden");
        return null;
      }
      draftIdRef.current = data.id;
      setDraftId(data.id);
      setDraftStatus("entwurf");
      return data.id;
    })();
    try {
      return await draftPromise.current;
    } finally {
      draftPromise.current = null;
    }
  }

  async function signPhotoUrl(storagePath: string): Promise<string> {
    const { data } = await supabase.storage.from("documents").createSignedUrl(storagePath, 3600);
    return data?.signedUrl ?? "";
  }

  async function loadPhotos(reportId: string) {
    const { data } = await supabase
      .from("report_photos")
      .select("id, storage_path, caption, sort_order")
      .eq("report_id", reportId)
      .order("sort_order");
    if (!data) return;
    const withUrls = await Promise.all(
      data.map(async (p) => ({
        id: p.id as string,
        storage_path: p.storage_path as string,
        preview_url: await signPhotoUrl(p.storage_path as string),
        caption: (p.caption as string) ?? "",
        sort_order: (p.sort_order as number) ?? 0,
      })),
    );
    setUploadedPhotos(withUrls);
  }

  async function handlePhotoSelect(files: FileList) {
    if (!validateFileList(files)) return;

    const reportId = await getOrCreateDraft();
    if (!reportId) return;

    setPhotoUploadCount((c) => c + files.length);
    const baseSort = uploadedPhotos.length;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = file.name.split(".").pop() || "jpg";
      const path = `rapport-photos/${reportId}/${Date.now()}_${i}.${ext}`;
      const { error: upErr } = await supabase.storage.from("documents").upload(path, file, {
        contentType: file.type,
      });
      if (upErr) {
        logError("rapport.modal.photo-upload", upErr, { fileName: file.name });
        toast.error(`Foto "${file.name}" konnte nicht hochgeladen werden`);
        continue;
      }
      const { data: row } = await supabase.from("report_photos").insert({
        report_id: reportId,
        storage_path: path,
        caption: null,
        sort_order: baseSort + i,
      }).select("id, storage_path, caption, sort_order").single();
      if (row) {
        const previewUrl = await signPhotoUrl(path);
        setUploadedPhotos((prev) => [...prev, {
          id: row.id as string,
          storage_path: row.storage_path as string,
          preview_url: previewUrl,
          caption: (row.caption as string) ?? "",
          sort_order: (row.sort_order as number) ?? 0,
        }]);
      }
    }
    setPhotoUploadCount((c) => Math.max(0, c - files.length));
  }

  async function removePhoto(photo: UploadedPhoto) {
    // Storage + DB-Row entfernen — Reihenfolge egal, beide best-effort.
    await supabase.storage.from("documents").remove([photo.storage_path]);
    await supabase.from("report_photos").delete().eq("id", photo.id);
    setUploadedPhotos((prev) => prev.filter((p) => p.id !== photo.id));
  }

  function updateCaption(photo: UploadedPhoto, caption: string) {
    // Optimistisches Update + debounced DB-Save pro Foto.
    setUploadedPhotos((prev) => prev.map((p) => p.id === photo.id ? { ...p, caption } : p));
    const existing = captionTimers.current.get(photo.id);
    if (existing) clearTimeout(existing);
    const t = setTimeout(async () => {
      await supabase.from("report_photos").update({ caption: caption || null }).eq("id", photo.id);
      captionTimers.current.delete(photo.id);
    }, 800);
    captionTimers.current.set(photo.id, t);
  }

  async function uploadSignature(dataUrl: string, folder: string): Promise<string | null> {
    if (!dataUrl) return null;
    const blob = await (await fetch(dataUrl)).blob();
    const path = `${folder}/${Date.now()}.png`;
    const { error } = await supabase.storage.from("documents").upload(path, blob, { contentType: "image/png" });
    if (error) return null;
    return path;
  }

  // Manuelles "Speichern" — schliesst das Modal, Auftrag bleibt offen.
  // Der Auto-Save hat schon alles geschrieben; das hier bestaetigt nur.
  async function handleSaveDraft() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (form.work_description.trim()) {
      setSaving("draft");
      const id = await getOrCreateDraft();
      if (!id) { setSaving(null); return; }
      const payload = {
        report_date: timeRanges[0]?.date || todayLocalDateString(),
        work_description: form.work_description,
        equipment_used: form.equipment_used || null,
        issues: form.issues || null,
        client_name: form.client_name || null,
        technician_name: form.technician_name || null,
        time_ranges: timeRanges,
      };
      const { error } = await supabase.from("service_reports").update(payload).eq("id", id);
      if (handleDupError(error)) return;
      setSaving(null);
      toast.success("Rapport zwischengespeichert");
    }
    onClose();
  }

  // Finaler Submit — Rapport wird als abgeschlossen markiert, Auftrag
  // wird auf 'abgeschlossen' gesetzt, Photos+Signaturen hochgeladen,
  // PDF generiert (per API, kein Mail-Versand mehr).
  async function handleFinalSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Alle Fehler in einem Rutsch sammeln statt nur ersten zu melden —
    // der User soll auf einen Blick sehen was ihm fehlt.
    const missing: FormError[] = [];
    if (!form.work_description.trim()) {
      missing.push({ id: "work_description", label: "Arbeitsbeschreibung" });
    }
    for (let i = 0; i < timeRanges.length; i++) {
      const tr = timeRanges[i];
      const tag = timeRanges.length > 1 ? `Tag ${i + 1} ` : "";
      if (!tr.date)          missing.push({ id: `time-range-${i}-date`,       label: `${tag}Datum` });
      if (!tr.start)         missing.push({ id: `time-range-${i}-start`,      label: `${tag}Von-Zeit` });
      if (!tr.end)           missing.push({ id: `time-range-${i}-end`,        label: `${tag}Bis-Zeit` });
      if (!tr.technician_id) missing.push({ id: `time-range-${i}-technician`, label: `${tag}Techniker` });
    }
    if (missing.length > 0) {
      reportFormErrors({ missing, toastTitle: "Rapport unvollstaendig" });
      return;
    }
    if (!canFinish) {
      toast.error(finishBlockReason || "Auftrag kann noch nicht abgeschlossen werden");
      return;
    }
    if (onBeforeFinalSubmit) {
      const ok = await onBeforeFinalSubmit();
      if (!ok) return;
    }
    // Letzter-Techniker-Bestaetigung — nach dem Abschliessen blockiert
    // der DB-Trigger weitere Rapport-Writes auf diesen Job. Confirm-Button
    // ist 8s lang disabled, damit der User die Warnung tatsaechlich liest.
    const ok = await confirm({
      title: "Bist du der letzte Techniker?",
      message:
        "Nach dem Abschliessen ist der Rapport endgültig — kein anderer Techniker kann mehr einen Rapport für diesen Auftrag erstellen oder bearbeiten.\n\nNur bestätigen, wenn KEINE weiteren Mitarbeiter an diesem Auftrag arbeiten.",
      confirmLabel: "Ja, abschliessen",
      cancelLabel: "Abbrechen",
      variant: "red",
      confirmDelaySec: 8,
    });
    if (!ok) return;
    setSaving("final");
    if (saveTimer.current) clearTimeout(saveTimer.current);

    const { data: { user } } = await supabase.auth.getUser();

    const [clientSigPath, techSigPath] = await Promise.all([
      uploadSignature(clientSignature, "signatures/client"),
      uploadSignature(techSignature, "signatures/tech"),
    ]);

    const finalPayload = {
      job_id: job.id,
      created_by: user?.id,
      report_date: timeRanges[0]?.date || todayLocalDateString(),
      work_description: form.work_description,
      equipment_used: form.equipment_used || null,
      issues: form.issues || null,
      client_name: form.client_name
        ? (signerType === "mieter" && signerRole ? `${form.client_name} (${signerRole})` : form.client_name)
        : null,
      signature_url: clientSigPath,
      technician_name: form.technician_name || null,
      technician_signature_url: techSigPath,
      time_ranges: timeRanges,
      status: "abgeschlossen" as const,
    };

    // Finalisieren via UPDATE auf den existierenden Entwurf — wenn der
    // User noch keinen hat (z.B. direkt-finalisieren ohne Zwischenspeicher),
    // wird er hier on-the-fly erstellt. Dadurch entsteht NIE ein neuer
    // 'abgeschlossen'-INSERT der einen lingering Entwurf zuruecklassen
    // wuerde.
    const reportId = await getOrCreateDraft();
    if (!reportId) { setSaving(null); return; }
    const { error } = await supabase.from("service_reports").update(finalPayload).eq("id", reportId);
    if (handleDupError(error)) { setSaving(null); return; }
    if (error) {
      TOAST.supabaseError(error, "Rapport konnte nicht gespeichert werden");
      setSaving(null);
      return;
    }
    // Lokalen State auf abgeschlossen ziehen damit der Auto-Save-Effect
    // nicht nochmal feuert nachdem der Status DB-seitig gewechselt hat.
    setDraftStatus("abgeschlossen");

    // Auftrag schliessen via Server-Route — direkter Supabase-Update aus
    // dem Client hat silent failed wenn der User nicht in job_assignments
    // stand (RLS) und liess Job auf 'offen' obwohl der Rapport
    // 'abgeschlossen' war. Server-Route nutzt Admin-Client und gibt jetzt
    // einen Fehler zurueck statt ihn zu schlucken.
    const finishRes = await fetch(`/api/jobs/${job.id}/finish-from-rapport`, { method: "POST" });
    const finishJson = await finishRes.json().catch(() => null);
    if (!finishRes.ok || !finishJson?.success) {
      toast.error(finishJson?.error || "Auftrag konnte nicht geschlossen werden");
      setSaving(null);
      return;
    }
    window.dispatchEvent(new Event("jobs:invalidate"));

    toast.success("Rapport abgeschlossen – PDF wird generiert...");

    if (reportId) {
      try {
        await fetch(`/api/reports/${reportId}/send-invoice`, { method: "POST" });
        toast.success("PDF am Auftrag gespeichert");
      } catch (err) {
        logError("rapport.modal.pdf", err, { reportId });
        toast.info("Rapport abgeschlossen, PDF-Generierung wird nachgeholt");
      }
    }

    setSaving(null);
    onCompleted();
    onClose();
  }

  const isReadOnly = draftStatus === "abgeschlossen";

  return (
    <>
      {/* Zentrales Flash-Popup nach Auto-Save — ueber Modal-Panel (z-[1110]).
          pointer-events-none damit der User waehrenddessen weitertippen
          kann ohne dass das Popup blockt. */}
      {savedFlash && (
        <div className="fixed inset-0 z-[1120] flex items-center justify-center pointer-events-none">
          <div className="bg-green-600 text-white px-5 py-3 rounded-2xl shadow-2xl text-sm font-semibold flex items-center gap-2 animate-in fade-in zoom-in-95 duration-200">
            <span className="text-base leading-none">✓</span>
            Zwischengespeichert
          </div>
        </div>
      )}
      <Modal
        open={open}
        onClose={() => { if (!saving) onClose(); }}
        title={isReadOnly ? "Einsatzrapport (abgeschlossen)" : "Einsatzrapport"}
        icon={<Save className="h-5 w-5 text-red-500" />}
        size="lg"
        closable={!saving}
      >
        <form onSubmit={handleFinalSubmit} className="space-y-5">
          {/* Auftrag-Info als Banner */}
          <div className="p-3 rounded-xl bg-muted/40 border space-y-1 text-xs">
            {job.job_number && <div><span className="font-medium">Auftrag:</span> INT-{job.job_number} – {job.title}</div>}
            <div><span className="font-medium">Kunde:</span> {job.customer_name || "—"}</div>
            <div><span className="font-medium">Standort:</span> {job.location_name || "—"}</div>
          </div>

          <TimeRangesSection
            timeRanges={timeRanges}
            profiles={profiles}
            isReadOnly={isReadOnly}
            onChange={setTimeRanges}
          />

          {/* Arbeit */}
          <div className="space-y-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Ausgeführte Arbeiten</p>
            <div>
              <Label>Arbeitsbeschreibung *</Label>
              <textarea
                id="work_description"
                placeholder="Was wurde gemacht?"
                value={form.work_description}
                onChange={(e) => update("work_description", e.target.value)}
                disabled={isReadOnly}
                className="mt-1.5 w-full px-3 py-2 text-sm rounded-lg border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
                rows={5}
                required
              />
            </div>
            <div>
              <Label>Eingesetztes Material / Equipment</Label>
              <textarea
                placeholder="Welche Geräte/Material wurden verwendet?"
                value={form.equipment_used}
                onChange={(e) => update("equipment_used", e.target.value)}
                disabled={isReadOnly}
                className="mt-1.5 w-full px-3 py-2 text-sm rounded-lg border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
                rows={3}
              />
            </div>
            <div>
              <Label>Probleme / Bemerkungen</Label>
              <textarea
                placeholder="Gab es Probleme oder besondere Vorkommnisse?"
                value={form.issues}
                onChange={(e) => update("issues", e.target.value)}
                disabled={isReadOnly}
                className="mt-1.5 w-full px-3 py-2 text-sm rounded-lg border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
                rows={3}
              />
            </div>
          </div>

          <PhotosSection
            photos={uploadedPhotos}
            uploadCount={photoUploadCount}
            isReadOnly={isReadOnly}
            onSelectFiles={handlePhotoSelect}
            onRemove={removePhoto}
            onCaptionChange={updateCaption}
          />

          <SignaturesSection
            technicianId={form.technician_id}
            technicianName={form.technician_name}
            clientName={form.client_name}
            signerType={signerType}
            signerRole={signerRole}
            profiles={profiles}
            isReadOnly={isReadOnly}
            isMaintenance={isMaintenance}
            onTechnicianChange={(id, name) => setForm((f) => ({ ...f, technician_id: id, technician_name: name }))}
            onClientNameChange={(name) => update("client_name", name)}
            onSignerTypeChange={setSignerType}
            onSignerRoleChange={setSignerRole}
            onTechSignature={setTechSignature}
            onClientSignature={setClientSignature}
          />

          {/* Wenn Rapport schon abgeschlossen: nur "Schliessen"-Button.
              Sonst: Draft-Save + Final-Submit Side-by-Side. */}
          {isReadOnly ? (
            <div className="flex pt-2">
              <button type="button" onClick={onClose} className="kasten kasten-muted flex-1">
                Schliessen
              </button>
            </div>
          ) : (
            <>
              {!canFinish && finishBlockReason && (
                <p className="text-xs text-muted-foreground -mb-2">
                  {finishBlockReason}
                </p>
              )}
              <div className="flex gap-3 pt-2 flex-wrap">
                <button
                  type="button"
                  onClick={handleSaveDraft}
                  disabled={saving !== null}
                  className="kasten kasten-muted flex-1"
                >
                  {saving === "draft" ? "Speichert…" : "Speichern"}
                </button>
                <button
                  type="submit"
                  disabled={!form.work_description || saving !== null || !canFinish}
                  data-tooltip={!canFinish ? finishBlockReason : undefined}
                  className="kasten kasten-red flex-[2]"
                >
                  <Save className="h-3.5 w-3.5" />
                  {saving === "final" ? "Speichert…" : "Auftrag abschliessen"}
                </button>
              </div>
            </>
          )}
        </form>
      </Modal>
      {ConfirmModalElement}
    </>
  );
}
