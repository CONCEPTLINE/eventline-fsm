"use client";

/**
 * Modal zum Erstellen eines neuen Tickets.
 *
 * Phase 1: Typ-Picker — Mitarbeiter waehlt zwischen IT, Beleg,
 *          Stempel-Aenderung, Material.
 * Phase 2: Typ-spezifisches Formular mit allen Pflicht-Feldern und
 *          optionalem File-Upload (mehrere Dateien).
 *
 * Beim Submit:
 *   1. INSERT in tickets (mit type, title, description, priority, data)
 *   2. Upload aller Files in storage-bucket "documents" unter
 *      tickets/{ticket_id}/{filename}
 *   3. INSERT-Rows in ticket_attachments
 *   4. POST /api/tickets/notify-admins triggert In-App-Notification
 */

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/searchable-select";
import { TypePickerCard, type TypePickerTone } from "@/components/ui/type-picker-card";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Wrench, Receipt, Clock, Package, Upload, X, CheckCircle2, AlertCircle, Loader2, AlertTriangle, Sparkles, Plus } from "lucide-react";
import type { TicketType } from "@/types";

type Step = "pick" | "form";
type StempelMode = "korrektur" | "vergessen";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** Optional: Type direkt vorauswaehlen und Picker ueberspringen.
   *  Wird z.B. von /stempelzeiten benutzt um direkt ins Stempel-
   *  Aenderung-Form zu springen, ohne dass der User erst die Karte
   *  klicken muss. */
  initialType?: TicketType;
}

const TYPES: { id: TicketType; label: string; description: string; icon: React.ComponentType<{ className?: string }>; tone: TypePickerTone }[] = [
  { id: "it",                label: "IT-Problem",       description: "Drucker, Software, Login, Hardware", icon: Wrench,  tone: "purple" },
  { id: "beleg",             label: "Beleg",            description: "Quittung einreichen für Erstattung", icon: Receipt, tone: "amber"  },
  { id: "stempel_aenderung", label: "Stempel-Änderung", description: "Korrektur oder Nacherfassung",       icon: Clock,   tone: "green"  },
  { id: "material",          label: "Material",         description: "Etwas einkaufen — Genehmigung",      icon: Package, tone: "red"    },
];

export function NewTicketModal({ open, onClose, onCreated, initialType }: Props) {
  const supabase = createClient();
  const [step, setStep] = useState<Step>(initialType ? "form" : "pick");
  const [type, setType] = useState<TicketType | null>(initialType ?? null);
  const [saving, setSaving] = useState(false);
  const [files, setFiles] = useState<File[]>([]);

  // Gemeinsame Felder.
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [urgent, setUrgent] = useState(false);

  // Beleg-spezifisch.
  const [beleg, setBeleg] = useState({ betrag_chf: "", kaufdatum: "", lieferant: "" });
  // Genehmigungs-Quelle fuer Belege: 'person' (User hat verbal/per Mail OK
  // gegeben) oder 'ticket' (vorheriges Material-Ticket war approved).
  const [belegApprovalSource, setBelegApprovalSource] = useState<"person" | "ticket">("person");
  const [belegApprovalUserId, setBelegApprovalUserId] = useState("");
  const [belegApprovalTicketId, setBelegApprovalTicketId] = useState("");
  // Profile-Liste fuer Person-Picker, Material-Tickets fuer Ticket-Picker.
  const [profilesForApproval, setProfilesForApproval] = useState<Array<{ id: string; full_name: string; role: string }>>([]);
  const [erledigteMaterialTickets, setErledigteMaterialTickets] = useState<Array<{ id: string; ticket_number: number; title: string }>>([]);
  // KI-Analyse-State fuer Beleg: laeuft beim ersten File-Pick.
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisIssues, setAnalysisIssues] = useState<string[]>([]);
  const [analysisDone, setAnalysisDone] = useState(false);

  // Stempel-Aenderung-spezifisch.
  const [stempelMode, setStempelMode] = useState<StempelMode>("korrektur");
  const [timeEntries, setTimeEntries] = useState<Array<{ id: string; clock_in: string; clock_out: string | null; job_label: string | null }>>([]);
  const [stempel, setStempel] = useState({
    time_entry_id: "",
    neu_start: "",        // datetime-local
    neu_end: "",          // datetime-local
    job_id: "",
    beschreibung: "",
    grund: "",
  });
  const [jobs, setJobs] = useState<{ id: string; job_number: number; title: string; start_date: string | null; end_date: string | null }[]>([]);

  // Material-spezifisch — pro Anfrage koennen mehrere Positionen rein
  // (Warenkorb mit mehreren Artikeln). Mindestens 1 leeres Item beim
  // Start damit das Form sofort ausfuellbar ist.
  const [materialItems, setMaterialItems] = useState<Array<{ artikel: string; menge: string; betrag_chf: string }>>(
    [{ artikel: "", menge: "1", betrag_chf: "" }],
  );
  const [materialAuftrag, setMaterialAuftrag] = useState("");

  // IT-spezifisch.
  const [device, setDevice] = useState("");

  // Beim Oeffnen Reset; bei Stempel-Auswahl die letzten Stempel-Eintraege laden.
  // Wenn initialType gesetzt ist, ueberspringen wir den Picker und landen
  // direkt im Form fuer den Type.
  useEffect(() => {
    if (!open) {
      setStep(initialType ? "form" : "pick");
      setType(initialType ?? null);
      setSaving(false);
      setFiles([]);
      setTitle("");
      setDescription("");
      setUrgent(false);
      setBeleg({ betrag_chf: "", kaufdatum: "", lieferant: "" });
      setBelegApprovalSource("person");
      setBelegApprovalUserId("");
      setBelegApprovalTicketId("");
      setAnalyzing(false);
      setAnalysisIssues([]);
      setAnalysisDone(false);
      setStempelMode("korrektur");
      setStempel({ time_entry_id: "", neu_start: "", neu_end: "", job_id: "", beschreibung: "", grund: "" });
      setMaterialItems([{ artikel: "", menge: "1", betrag_chf: "" }]);
      setMaterialAuftrag("");
      setDevice("");
    }
  }, [open]);

  // Stempel-Eintraege laden wenn Typ Stempel-Aenderung gewaehlt wird.
  // Separate Queries fuer time_entries und jobs — der nested join
  // (job:jobs(...)) hatte still failende Probleme bei manchen Usern.
  useEffect(() => {
    if (type !== "stempel_aenderung") return;
    (async () => {
      const { data: entries, error: entriesErr } = await supabase
        .from("time_entries")
        .select("id, clock_in, clock_out, description, job_id")
        .order("clock_in", { ascending: false })
        .limit(30);
      if (entriesErr) {
        toast.error("Stempel-Eintraege konnten nicht geladen werden: " + entriesErr.message);
        return;
      }
      if (!entries || entries.length === 0) {
        setTimeEntries([]);
        return;
      }

      // Job-Daten fuer die referenzierten Jobs nachladen.
      const jobIds = Array.from(new Set(
        entries.map((e) => e.job_id).filter((id): id is string => !!id),
      ));
      const jobsById = new Map<string, { job_number: number; title: string }>();
      if (jobIds.length > 0) {
        const { data: jobsData } = await supabase
          .from("jobs")
          .select("id, job_number, title")
          .in("id", jobIds);
        for (const j of jobsData ?? []) {
          jobsById.set(j.id, { job_number: j.job_number, title: j.title });
        }
      }

      setTimeEntries(
        entries.map((e) => {
          const job = e.job_id ? jobsById.get(e.job_id) : null;
          return {
            id: e.id,
            clock_in: e.clock_in,
            clock_out: e.clock_out,
            job_label: job ? `INT-${job.job_number}` : (e.description || "Andere Arbeit"),
          };
        }),
      );
    })();
  }, [type, supabase]);

  // Beleg: Profile-Liste + erledigte Material-Tickets fuer Genehmigung-Picker.
  useEffect(() => {
    if (type !== "beleg") return;
    (async () => {
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, full_name, role")
        .eq("is_active", true)
        .order("full_name");
      if (profs) setProfilesForApproval(profs as typeof profilesForApproval);

      const { data: mats } = await supabase
        .from("tickets")
        .select("id, ticket_number, title")
        .eq("type", "material")
        .eq("status", "erledigt")
        .order("created_at", { ascending: false })
        .limit(50);
      if (mats) setErledigteMaterialTickets(mats as typeof erledigteMaterialTickets);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, supabase]);

  // Jobs fuer Stempel-/Material-Form laden.
  // Stempel-Aenderung: alle Stati inkl. abgeschlossen/storniert (=archiviert),
  //   damit auch Korrekturen fuer alte Auftraege moeglich sind.
  // Material: nur aktive Stati — Einkauf fuer abgeschlossene/stornierte
  //   Auftraege macht keinen Sinn.
  useEffect(() => {
    if (type !== "stempel_aenderung" && type !== "material") return;
    (async () => {
      let q = supabase
        .from("jobs")
        .select("id, job_number, title, start_date, end_date")
        .order("start_date", { ascending: false, nullsFirst: false })
        .limit(50);
      if (type === "material") {
        q = q.in("status", ["offen", "anfrage", "entwurf"]);
      }
      const { data } = await q;
      if (data) setJobs(data);
    })();
  }, [type, supabase]);

  function pickType(t: TicketType) {
    setType(t);
    setStep("form");
    // Default-Title je nach Typ vorbelegen damit der User nicht jedes Mal tippen muss.
    if (t === "it") setTitle("");
    if (t === "beleg") setTitle("Beleg-Erstattung");
    if (t === "stempel_aenderung") setTitle("Stempelzeit-Änderung");
    if (t === "material") setTitle("Material-Anfrage");
  }

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (!list) return;
    const newFiles = Array.from(list);
    setFiles((prev) => [...prev, ...newFiles]);
    e.target.value = "";

    // Bei Beleg/Material: erste Datei automatisch via KI analysieren.
    // Wir analysieren NUR die erste Datei, weitere Dateien bleiben unangetastet.
    if ((type === "beleg" || type === "material") && newFiles.length > 0 && !analysisDone) {
      const first = newFiles[0];
      if (!first.type.startsWith("image/")) {
        // PDFs analysieren wir nicht — User soll selbst eintragen.
        return;
      }
      if (type === "beleg") analyzeReceipt(first);
      if (type === "material") analyzeMaterial(first);
    }
  }

  async function analyzeReceipt(file: File) {
    setAnalyzing(true);
    setAnalysisIssues([]);
    try {
      const base64 = await fileToBase64(file);
      const res = await fetch("/api/tickets/analyze-receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_base64: base64, mime_type: file.type }),
      });
      const json = await res.json();
      if (!json.success) {
        setAnalysisIssues([`Analyse fehlgeschlagen: ${json.error ?? "Unbekannt"}`]);
        return;
      }
      const r = json.result as {
        ok?: boolean;
        issues?: string[];
        extracted?: { betrag_chf?: number | null; kaufdatum?: string | null; lieferant?: string | null };
      };
      // Felder vorausfuellen wenn KI was erkannt hat — User kann jederzeit ueberschreiben.
      const ex = r.extracted ?? {};
      setBeleg((prev) => ({
        betrag_chf: prev.betrag_chf || (typeof ex.betrag_chf === "number" ? ex.betrag_chf.toFixed(2) : ""),
        kaufdatum: prev.kaufdatum || (typeof ex.kaufdatum === "string" ? ex.kaufdatum : ""),
        lieferant: prev.lieferant || (typeof ex.lieferant === "string" ? ex.lieferant : ""),
      }));
      setAnalysisIssues(Array.isArray(r.issues) ? r.issues : []);
      setAnalysisDone(true);
    } catch (err) {
      setAnalysisIssues([err instanceof Error ? err.message : "Analyse fehlgeschlagen"]);
    } finally {
      setAnalyzing(false);
    }
  }

  async function analyzeMaterial(file: File) {
    setAnalyzing(true);
    setAnalysisIssues([]);
    try {
      const base64 = await fileToBase64(file);
      const res = await fetch("/api/tickets/analyze-material", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_base64: base64, mime_type: file.type }),
      });
      const json = await res.json();
      if (!json.success) {
        setAnalysisIssues([`Analyse fehlgeschlagen: ${json.error ?? "Unbekannt"}`]);
        return;
      }
      const r = json.result as {
        ok?: boolean;
        issues?: string[];
        extracted?: {
          items?: Array<{ artikel?: string | null; menge?: number | null; betrag_chf?: number | null }>;
        };
      };
      const items = r.extracted?.items ?? [];
      if (items.length > 0) {
        setMaterialItems(
          items.map((it) => ({
            artikel: typeof it.artikel === "string" ? it.artikel : "",
            menge: typeof it.menge === "number" ? String(it.menge) : "1",
            betrag_chf: typeof it.betrag_chf === "number" ? it.betrag_chf.toFixed(2) : "",
          })),
        );
      }
      setAnalysisIssues(Array.isArray(r.issues) ? r.issues : []);
      setAnalysisDone(true);
    } catch (err) {
      setAnalysisIssues([err instanceof Error ? err.message : "Analyse fehlgeschlagen"]);
    } finally {
      setAnalyzing(false);
    }
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== "string") {
          reject(new Error("Konnte Bild nicht lesen"));
          return;
        }
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(reader.error ?? new Error("FileReader-Fehler"));
      reader.readAsDataURL(file);
    });
  }

  function removeFile(idx: number) {
    setFiles((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      // Wenn alle Files weg, Analyse-State zuruecksetzen.
      if (next.length === 0) {
        setAnalysisIssues([]);
        setAnalysisDone(false);
      }
      return next;
    });
  }

  function validate(): string | null {
    if (!type) return "Typ fehlt";
    if (!title.trim()) return "Titel fehlt";
    if (type === "it" && !description.trim()) return "Problem-Beschreibung fehlt";
    if (type === "beleg") {
      if (files.length === 0) return "Beleg-Foto oder PDF ist Pflicht — bitte Datei hochladen";
      if (!beleg.betrag_chf || isNaN(parseFloat(beleg.betrag_chf))) return "Betrag fehlt";
      if (!beleg.kaufdatum) return "Kaufdatum fehlt";
      if (belegApprovalSource === "person" && !belegApprovalUserId) return "Wer hat den Kauf genehmigt? Bitte Person auswählen.";
      if (belegApprovalSource === "ticket" && !belegApprovalTicketId) return "Bitte das Material-Ticket auswählen das den Kauf genehmigt hat.";
    }
    if (type === "stempel_aenderung") {
      if (!stempel.grund.trim()) return "Grund ist Pflicht";
      if (stempelMode === "korrektur" && !stempel.time_entry_id) return "Stempel-Eintrag auswählen";
      if (stempelMode === "vergessen" && (!stempel.neu_start || !stempel.neu_end)) return "Neue Start/End-Zeit fehlt";
      if (stempelMode === "vergessen" && !stempel.job_id) return "Auftrag oder 'Andere Arbeit' auswählen";
      if (stempelMode === "vergessen" && stempel.job_id === "ANDERE_ARBEIT" && !stempel.beschreibung.trim()) return "Beschreibung der Arbeit ist Pflicht bei 'Andere Arbeit'";
    }
    if (type === "material") {
      if (files.length === 0) return "Warenkorb-Screenshot ist Pflicht — bitte Datei hochladen";
      if (materialItems.length === 0) return "Mindestens eine Position eintragen";
      for (let i = 0; i < materialItems.length; i++) {
        const it = materialItems[i];
        if (!it.artikel.trim()) return `Artikel ${i + 1}: Name fehlt`;
        if (!it.menge || parseInt(it.menge) < 1) return `Artikel ${i + 1}: Menge muss mindestens 1 sein`;
      }
    }
    return null;
  }

  async function submit() {
    const err = validate();
    if (err) { toast.error(err); return; }
    if (!type) return;

    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Nicht eingeloggt");

      // Typ-spezifisches data-Object zusammenbauen.
      let data: Record<string, unknown> = {};
      if (type === "it") {
        data = { device: device || undefined };
      } else if (type === "beleg") {
        data = {
          betrag_chf: parseFloat(beleg.betrag_chf),
          kaufdatum: beleg.kaufdatum,
          lieferant: beleg.lieferant || undefined,
          genehmigt_von_user_id: belegApprovalSource === "person" ? belegApprovalUserId : undefined,
          genehmigt_via_ticket_id: belegApprovalSource === "ticket" ? belegApprovalTicketId : undefined,
        };
      } else if (type === "stempel_aenderung") {
        if (stempelMode === "korrektur") {
          data = {
            time_entry_id: stempel.time_entry_id,
            neu_start: stempel.neu_start ? new Date(stempel.neu_start).toISOString() : undefined,
            neu_end: stempel.neu_end ? new Date(stempel.neu_end).toISOString() : undefined,
            grund: stempel.grund,
          };
        } else {
          // 'ANDERE_ARBEIT' ist der UI-Sentinel fuer 'kein Auftrag' — in
          // der DB landet job_id=undefined.
          const jobId = stempel.job_id === "ANDERE_ARBEIT" ? undefined : stempel.job_id;
          data = {
            neu_start: new Date(stempel.neu_start).toISOString(),
            neu_end: new Date(stempel.neu_end).toISOString(),
            job_id: jobId,
            beschreibung: stempel.beschreibung || undefined,
            grund: stempel.grund,
          };
        }
      } else if (type === "material") {
        data = {
          items: materialItems.map((it) => ({
            artikel: it.artikel.trim(),
            menge: parseInt(it.menge),
            betrag_chf: it.betrag_chf ? parseFloat(it.betrag_chf) : undefined,
          })),
          auftrag_id: materialAuftrag || undefined,
        };
      }

      // Ticket erstellen.
      const { data: created, error: insErr } = await supabase
        .from("tickets")
        .insert({
          type,
          title: title.trim(),
          description: description.trim() || null,
          priority: urgent ? "dringend" : "normal",
          data,
          created_by: user.id,
        })
        .select("id")
        .single();
      if (insErr || !created) throw new Error(insErr?.message || "Insert fehlgeschlagen");

      // Files hochladen.
      for (const file of files) {
        const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `tickets/${created.id}/${Date.now()}_${safe}`;
        const { error: upErr } = await supabase.storage.from("documents").upload(path, file);
        if (upErr) {
          // Soft-fail — Ticket ist schon angelegt, Datei fehlt eben.
          toast.error(`Datei "${file.name}" konnte nicht hochgeladen werden: ${upErr.message}`);
          continue;
        }
        await supabase.from("ticket_attachments").insert({
          ticket_id: created.id,
          storage_path: path,
          filename: file.name,
          mime_type: file.type || null,
          size_bytes: file.size,
          uploaded_by: user.id,
        });
      }

      // In-App-Notification an Admins triggern.
      await fetch("/api/tickets/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket_id: created.id, event: "created" }),
      }).catch(() => {});

      toast.success("Ticket eingereicht");
      onCreated();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Fehler beim Anlegen");
    } finally {
      setSaving(false);
    }
  }

  const modalTitle = step === "pick" ? "Neues Ticket" : `${TYPES.find((t) => t.id === type)?.label}`;
  const typeMeta = type ? TYPES.find((t) => t.id === type) : null;

  // datetime-local-Strings ('YYYY-MM-DDTHH:MM') in Datum + Uhrzeit
  // splitten — fuer separate <input type=date> und <input type=time>.
  // Vorteil ggue. type=datetime-local: Datum direkt tippbar (DD.MM.YYYY)
  // oder via Calendar-Picker, Zeit ohne den klobigen kombinierten Picker.
  const dtDate = (s: string) => (s ? s.split("T")[0] ?? "" : "");
  const dtTime = (s: string) => (s ? (s.split("T")[1] ?? "").slice(0, 5) : "");
  const combineDT = (date: string, time: string): string => {
    if (!date) return "";
    return `${date}T${time || "00:00"}`;
  };
  function setStempelDateTime(field: "neu_start" | "neu_end", part: "date" | "time", value: string) {
    setStempel((prev) => {
      const current = prev[field];
      const next = part === "date"
        ? combineDT(value, dtTime(current))
        : combineDT(dtDate(current), value);
      return { ...prev, [field]: next };
    });
  }

  // File-Upload-Block — wird fuer Beleg nach OBEN gerendert (nach Title)
  // damit die KI-Analyse die Felder vorausfuellen kann bevor der User
  // ueberhaupt was eintippen muss. Fuer alle anderen Types unten.
  const fileUploadBlock = (
    <div className="space-y-1">
      <p className="text-[10px] text-muted-foreground/70 ml-1">
        {type === "beleg"
          ? "Beleg-Foto oder PDF *"
          : type === "material"
            ? "Warenkorb-Screenshot *"
            : "Anhänge"}
      </p>
      <label className="kasten kasten-muted cursor-pointer w-full justify-center">
        <Upload className="h-3.5 w-3.5" />
        Datei wählen (Bild oder PDF)
        <input
          type="file"
          multiple
          accept="image/*,application/pdf"
          onChange={handleFiles}
          className="hidden"
        />
      </label>
      {files.length > 0 && (
        <div className="space-y-1.5 mt-2">
          {files.map((f, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/40">
              <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400 shrink-0" />
              <span className="text-xs flex-1 truncate">{f.name}</span>
              <span className="text-[10px] text-muted-foreground">{(f.size / 1024).toFixed(0)} KB</span>
              <button type="button" onClick={() => removeFile(i)} className="text-muted-foreground hover:text-red-600">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* KI-Analyse-Status fuer Beleg/Material */}
      {(type === "beleg" || type === "material") && analyzing && (
        <div className="mt-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/[0.08] border border-blue-500/20 text-blue-700 dark:text-blue-300">
          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
          <span className="text-xs">{type === "beleg" ? "Beleg" : "Warenkorb"} wird analysiert…</span>
        </div>
      )}
      {(type === "beleg" || type === "material") && !analyzing && analysisDone && analysisIssues.length === 0 && (
        <div className="mt-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-green-500/[0.08] border border-green-500/20 text-green-700 dark:text-green-300">
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
          <span className="text-xs">{type === "beleg" ? "Beleg" : "Warenkorb"} ist klar lesbar — Felder vorausgefüllt, gerne anpassen.</span>
        </div>
      )}
      {(type === "beleg" || type === "material") && !analyzing && analysisIssues.length > 0 && (
        <div className="mt-2 px-3 py-2 rounded-lg bg-amber-500/[0.08] border border-amber-500/30">
          <div className="flex items-start gap-2 text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <div className="text-xs space-y-0.5 flex-1">
              <p className="font-medium">KI-Hinweis:</p>
              {analysisIssues.map((iss, i) => (
                <p key={i}>· {iss}</p>
              ))}
              <p className="text-[10px] opacity-75 mt-1">
                Du kannst die Felder manuell ausfüllen oder ein besseres Foto hochladen.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <Modal open={open} onClose={() => !saving && onClose()} title={modalTitle} size="lg" closable={!saving}>
      {step === "pick" && (
        <div className="grid grid-cols-2 gap-3">
          {TYPES.map((t) => (
            <TypePickerCard
              key={t.id}
              icon={t.icon}
              tone={t.tone}
              label={t.label}
              description={t.description}
              onClick={() => pickType(t.id)}
            />
          ))}
        </div>
      )}

      {step === "form" && type && typeMeta && (
        <div className="space-y-4">
          {/* Titel + Dringend-Toggle (gleicher Stil wie Auftrag-Form). */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-muted-foreground/70 ml-1">Titel *</p>
              <button
                type="button"
                onClick={() => setUrgent((u) => !u)}
                aria-pressed={urgent}
                aria-label="Dringend markieren"
                className={`inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-[11px] font-medium transition-all ${
                  urgent
                    ? "bg-red-500 text-white shadow-sm shadow-red-500/30"
                    : "text-muted-foreground/60 hover:text-red-500 hover:bg-red-500/10"
                }`}
              >
                <AlertCircle className="h-3.5 w-3.5" strokeWidth={urgent ? 2.5 : 2} />
                Dringend
              </button>
            </div>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>

          {/* Beleg/Material: File-Upload zuerst, damit KI-Analyse die
              Felder ausfuellen kann bevor der User selbst tippt. */}
          {(type === "beleg" || type === "material") && fileUploadBlock}

          {/* Typ-spezifische Felder */}
          {type === "it" && (
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/70 ml-1">Betroffenes Gerät / Bereich</p>
              <Input
                value={device}
                onChange={(e) => setDevice(e.target.value)}
                placeholder="z.B. Drucker Büro, Outlook, WLAN-Halle"
              />
            </div>
          )}

          {type === "beleg" && files.length === 0 && (
            <div className="px-4 py-4 rounded-xl border border-dashed bg-muted/20 text-center">
              <Receipt className="h-6 w-6 text-muted-foreground/50 mx-auto mb-2" />
              <p className="text-sm font-medium">Beleg zuerst hochladen</p>
              <p className="text-xs text-muted-foreground mt-1">
                Sobald der Beleg hochgeladen ist, werden Betrag, Datum und Lieferant<br />automatisch ausgefüllt.
              </p>
            </div>
          )}
          {type === "beleg" && files.length > 0 && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <p className="text-[10px] text-muted-foreground/70 ml-1">Betrag (CHF) *</p>
                  <Input type="number" step="0.05" value={beleg.betrag_chf} onChange={(e) => setBeleg({ ...beleg, betrag_chf: e.target.value })} disabled={analyzing} />
                </div>
                <div className="space-y-1">
                  <p className="text-[10px] text-muted-foreground/70 ml-1">Kaufdatum *</p>
                  <Input type="date" value={beleg.kaufdatum} onChange={(e) => setBeleg({ ...beleg, kaufdatum: e.target.value })} disabled={analyzing} />
                </div>
                <div className="space-y-1 col-span-2">
                  <p className="text-[10px] text-muted-foreground/70 ml-1">Lieferant / Geschäft</p>
                  <Input value={beleg.lieferant} onChange={(e) => setBeleg({ ...beleg, lieferant: e.target.value })} placeholder="z.B. Conrad, Migros" disabled={analyzing} />
                </div>
              </div>

              {/* Genehmigung — Person ODER Material-Ticket. */}
              <div className="space-y-2">
                <p className="text-[10px] text-muted-foreground/70 ml-1">Genehmigung *</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setBelegApprovalSource("person")}
                    className={belegApprovalSource === "person" ? "kasten-active flex-1" : "kasten-toggle-off flex-1"}
                  >
                    Person
                  </button>
                  <button
                    type="button"
                    onClick={() => setBelegApprovalSource("ticket")}
                    className={belegApprovalSource === "ticket" ? "kasten-active flex-1" : "kasten-toggle-off flex-1"}
                  >
                    Material-Ticket
                  </button>
                </div>
                {belegApprovalSource === "person" && (
                  <SearchableSelect
                    value={belegApprovalUserId}
                    onChange={setBelegApprovalUserId}
                    items={profilesForApproval.map((p) => ({ id: p.id, label: p.full_name }))}
                    placeholder="Wer hat den Kauf genehmigt?"
                    clearable={false}
                  />
                )}
                {belegApprovalSource === "ticket" && (
                  erledigteMaterialTickets.length === 0 ? (
                    <div className="px-3 py-2 rounded-lg bg-muted/40 text-xs text-muted-foreground">
                      Keine erledigten Material-Tickets vorhanden — wähle stattdessen eine Person.
                    </div>
                  ) : (
                    <SearchableSelect
                      value={belegApprovalTicketId}
                      onChange={setBelegApprovalTicketId}
                      items={erledigteMaterialTickets.map((t) => ({
                        id: t.id,
                        label: `T-${t.ticket_number} · ${t.title}`,
                      }))}
                      placeholder="Welches Material-Ticket?"
                      clearable={false}
                    />
                  )
                )}
              </div>
            </>
          )}

          {type === "stempel_aenderung" && (
            <div className="space-y-3">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setStempelMode("korrektur")}
                  className={stempelMode === "korrektur" ? "kasten-active flex-1" : "kasten-toggle-off flex-1"}
                >
                  Bestehenden Eintrag korrigieren
                </button>
                <button
                  type="button"
                  onClick={() => setStempelMode("vergessen")}
                  className={stempelMode === "vergessen" ? "kasten-active flex-1" : "kasten-toggle-off flex-1"}
                >
                  Vergessen einzustempeln
                </button>
              </div>

              {stempelMode === "korrektur" && (
                <>
                  <div className="space-y-1">
                    <p className="text-[10px] text-muted-foreground/70 ml-1">Welcher Eintrag? *</p>
                    <SearchableSelect
                      value={stempel.time_entry_id}
                      onChange={(v) => setStempel({ ...stempel, time_entry_id: v })}
                      items={timeEntries.map((e) => ({
                        id: e.id,
                        label: `${new Date(e.clock_in).toLocaleString("de-CH", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} — ${e.job_label ?? "—"}`,
                      }))}
                      placeholder="Stempel-Eintrag auswählen…"
                      clearable={false}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <p className="text-[10px] text-muted-foreground/70 ml-1">Korrigiertes Start</p>
                      <div className="flex gap-2">
                        <Input type="date" value={dtDate(stempel.neu_start)} onChange={(e) => setStempelDateTime("neu_start", "date", e.target.value)} className="flex-1" />
                        <Input type="time" value={dtTime(stempel.neu_start)} onChange={(e) => setStempelDateTime("neu_start", "time", e.target.value)} className="w-28" />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] text-muted-foreground/70 ml-1">Korrigiertes Ende</p>
                      <div className="flex gap-2">
                        <Input type="date" value={dtDate(stempel.neu_end)} onChange={(e) => setStempelDateTime("neu_end", "date", e.target.value)} className="flex-1" />
                        <Input type="time" value={dtTime(stempel.neu_end)} onChange={(e) => setStempelDateTime("neu_end", "time", e.target.value)} className="w-28" />
                      </div>
                    </div>
                  </div>
                </>
              )}

              {stempelMode === "vergessen" && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <p className="text-[10px] text-muted-foreground/70 ml-1">Start *</p>
                      <div className="flex gap-2">
                        <Input type="date" value={dtDate(stempel.neu_start)} onChange={(e) => setStempelDateTime("neu_start", "date", e.target.value)} className="flex-1" />
                        <Input type="time" value={dtTime(stempel.neu_start)} onChange={(e) => setStempelDateTime("neu_start", "time", e.target.value)} className="w-28" />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] text-muted-foreground/70 ml-1">Ende *</p>
                      <div className="flex gap-2">
                        <Input type="date" value={dtDate(stempel.neu_end)} onChange={(e) => setStempelDateTime("neu_end", "date", e.target.value)} className="flex-1" />
                        <Input type="time" value={dtTime(stempel.neu_end)} onChange={(e) => setStempelDateTime("neu_end", "time", e.target.value)} className="w-28" />
                      </div>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] text-muted-foreground/70 ml-1">Auftrag *</p>
                    <SearchableSelect
                      value={stempel.job_id}
                      onChange={(v) => setStempel({ ...stempel, job_id: v })}
                      items={(() => {
                        // Filter Auftraege auf solche die am Stempel-Datum
                        // laufen (start_date <= datum <= end_date). So muss
                        // der User nicht durch alle Auftraege scrollen.
                        // Auftraege ohne start_date bleiben drin (Default-
                        // sicher). Wenn kein Stempel-Datum getippt: alle.
                        const stempelDate = dtDate(stempel.neu_start);
                        const relevant = stempelDate
                          ? jobs.filter((j) => {
                              if (!j.start_date) return true;
                              const start = j.start_date.slice(0, 10);
                              const end = (j.end_date ?? j.start_date).slice(0, 10);
                              return start <= stempelDate && stempelDate <= end;
                            })
                          : jobs;
                        return [
                          { id: "ANDERE_ARBEIT", label: "Keinem Auftrag (Andere Arbeit)" },
                          ...relevant.map((j) => ({ id: j.id, label: `INT-${j.job_number} — ${j.title}` })),
                        ];
                      })()}
                      placeholder="Auftrag oder 'Andere Arbeit' auswählen…"
                      clearable={false}
                    />
                  </div>
                  {stempel.job_id === "ANDERE_ARBEIT" && (
                    <div className="space-y-1">
                      <p className="text-[10px] text-muted-foreground/70 ml-1">Beschreibung der Arbeit *</p>
                      <Input value={stempel.beschreibung} onChange={(e) => setStempel({ ...stempel, beschreibung: e.target.value })} placeholder="kurz: was wurde gemacht" />
                    </div>
                  )}
                </>
              )}

              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground/70 ml-1">Grund der Änderung *</p>
                <textarea
                  value={stempel.grund}
                  onChange={(e) => setStempel({ ...stempel, grund: e.target.value })}
                  rows={3}
                  className="w-full px-3 py-2 text-sm rounded-xl border border-border bg-card resize-none"
                  placeholder="warum gehört das angepasst…"
                />
              </div>
            </div>
          )}

          {type === "material" && files.length === 0 && (
            <div className="px-4 py-4 rounded-xl border border-dashed bg-muted/20 text-center">
              <Package className="h-6 w-6 text-muted-foreground/50 mx-auto mb-2" />
              <p className="text-sm font-medium">Screenshot vom Warenkorb zuerst hochladen</p>
              <p className="text-xs text-muted-foreground mt-1">
                z.B. von digitec.ch oder galaxus.ch — sobald hochgeladen werden<br />
                Artikel, Menge und Betrag automatisch ausgefüllt.
              </p>
            </div>
          )}
          {type === "material" && files.length > 0 && (
            <div className="space-y-3">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-muted-foreground/70 ml-1">Positionen *</p>
                  {materialItems.length > 1 && (
                    <p className="text-[10px] text-muted-foreground/60">
                      Total: CHF {materialItems
                        .reduce((sum, it) => sum + (parseFloat(it.betrag_chf) || 0) * (parseInt(it.menge) || 0), 0)
                        .toFixed(2)}
                    </p>
                  )}
                </div>
                {materialItems.map((it, i) => (
                  <div key={i} className="grid grid-cols-12 gap-2 items-start">
                    <div className="col-span-6">
                      <Input
                        value={it.artikel}
                        onChange={(e) => setMaterialItems((prev) => prev.map((x, idx) => idx === i ? { ...x, artikel: e.target.value } : x))}
                        placeholder={`Artikel ${i + 1}`}
                        disabled={analyzing}
                      />
                    </div>
                    <div className="col-span-2">
                      <Input
                        type="number"
                        min="1"
                        value={it.menge}
                        onChange={(e) => setMaterialItems((prev) => prev.map((x, idx) => idx === i ? { ...x, menge: e.target.value } : x))}
                        placeholder="Menge"
                        disabled={analyzing}
                      />
                    </div>
                    <div className="col-span-3">
                      <Input
                        type="number"
                        step="0.05"
                        value={it.betrag_chf}
                        onChange={(e) => setMaterialItems((prev) => prev.map((x, idx) => idx === i ? { ...x, betrag_chf: e.target.value } : x))}
                        placeholder="Stk-Preis"
                        disabled={analyzing}
                      />
                    </div>
                    <div className="col-span-1 flex items-center justify-center h-9">
                      {materialItems.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setMaterialItems((prev) => prev.filter((_, idx) => idx !== i))}
                          className="p-1.5 rounded text-muted-foreground/50 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
                          aria-label="Position entfernen"
                          disabled={analyzing}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setMaterialItems((prev) => [...prev, { artikel: "", menge: "1", betrag_chf: "" }])}
                  className="kasten kasten-muted w-full justify-center"
                  disabled={analyzing}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Weitere Position
                </button>
              </div>

              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground/70 ml-1">Auftrag (optional)</p>
                <SearchableSelect
                  value={materialAuftrag}
                  onChange={setMaterialAuftrag}
                  items={[
                    { id: "", label: "Kein Auftrag" },
                    ...jobs.map((j) => ({ id: j.id, label: `INT-${j.job_number} — ${j.title}` })),
                  ]}
                  clearable={false}
                />
              </div>
            </div>
          )}

          {/* Beschreibung / Notiz — universal, ausser bei Stempel-Aenderung
              (dort gibt's schon das Pflicht-Feld 'Grund der Aenderung'). */}
          {type !== "stempel_aenderung" && (
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/70 ml-1">
                {type === "it" ? "Problem-Beschreibung *" : "Beschreibung / Notiz"}
              </p>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 text-sm rounded-xl border border-border bg-card resize-none"
              />
            </div>
          )}

          {/* File-Upload — nur fuer Types wo er optional ist (IT/Stempel).
              Beleg + Material rendern den Block schon weiter oben. */}
          {type !== "beleg" && type !== "material" && fileUploadBlock}

          <div className="flex gap-2 pt-2">
            {/* "Zurück" zur Type-Auswahl macht nur Sinn wenn der User
                ueber den Picker reingekommen ist. Wenn das Modal mit
                initialType direkt aufgerufen wurde (z.B. von /stempelzeiten),
                dann zeigt "Zurück" auf "Abbrechen" stattdessen. */}
            {initialType ? (
              <button type="button" onClick={onClose} disabled={saving} className="kasten kasten-muted flex-1">
                Abbrechen
              </button>
            ) : (
              <button type="button" onClick={() => setStep("pick")} disabled={saving} className="kasten kasten-muted flex-1">
                Zurück
              </button>
            )}
            <button type="button" onClick={submit} disabled={saving} className="kasten kasten-red flex-1">
              {saving ? "Erstellt…" : "Ticket einreichen"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
