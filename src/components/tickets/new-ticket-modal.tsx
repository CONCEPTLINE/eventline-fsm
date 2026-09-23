"use client";

/**
 * Modal zum Erstellen eines neuen Tickets.
 *
 * Hero + Sekundaer: Modal oeffnet direkt im Stempel-Aenderungs-Formular,
 * weil ~90% aller Tickets Stempel-Korrekturen sind. Oben ein schmaler
 * Chip-Toggle (Stempel-Aenderung | IT | Beleg | Material) statt eines
 * vollen Picker-Screens — 0 Klicks fuer den 90%-Fall, 1 Klick fuer die 10%.
 *
 * Wird der Modal mit initialType geoeffnet (z.B. aus /stempelzeiten Row-
 * "Korrigieren"), entfaellt der Chip-Toggle — der Kontext ist eindeutig.
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
import type { TypePickerTone } from "@/components/ui/type-picker-card";
import { createClient } from "@/lib/supabase/client";
import { localDateIso, localTimeHM } from "@/lib/swiss-time";
import { toast } from "sonner";
import { Wrench, Receipt, Clock, Package, Upload, X, CheckCircle2, AlertCircle, Loader2, AlertTriangle, Sparkles, Plus, Lock } from "lucide-react";
import { isTimeEntryLocked, TIME_ENTRY_LOCK_MESSAGE } from "@/lib/time-lock";
import type { TicketType } from "@/types";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";

/** Kontext-Typ fuer den gestempelten Zeitraum: externer Auftrag, internes
 *  Projekt (Zeit-Budget), oder freie "Andere Arbeit" (kein Kontext-Objekt).
 *
 *  Seit Migration 212 traegt time_entries eine optionale project_id, und
 *  apply_ticket (Migration 213) schreibt/updated die time_entries-Row je
 *  nach data.context automatisch mit project_id — Admin muss nur noch
 *  approven, keine Handarbeit mehr in project_time_entries. */
type StempelContext = "auftrag" | "projekt" | "andere_arbeit";

/** Sentinel-Value fuer den Eintrag-Picker: 'Neuer Eintrag (nachtragen)'.
 *  Wenn der User das waehlt, wird time_entry_id leer geschrieben und der
 *  Submit macht ein Vergessen-Ticket (kein bestehender Eintrag) statt einer
 *  Korrektur. Kein separates Preset noetig. */
const NEW_ENTRY_ID = "__new__";

/** Klick-Vorschlaege fuer das Grund-Textfeld — decken die 3 haeufigsten
 *  Faelle ab (Vergessen einzustempeln / Zeit falsch / laenger gedauert). */
const STEMPEL_TEXTBAUSTEINE: string[] = [
  "Vergessen einzustempeln",
  "Vergessen auszustempeln",
  "Zeit falsch eingegeben",
  "Schicht länger gedauert",
  "Pause nicht abgezogen",
];

/** ISO-timestamptz (UTC) → 'YYYY-MM-DDTHH:MM' in Europe/Zurich, kompatibel
 *  mit den datetime-local-Helpers (dtDate/dtTime) im Stempel-Form. Wird zum
 *  Vorbelegen beim Inline-"Korrigieren"-Button genutzt — nach Zurich lokal,
 *  damit der User exakt "seine" Zeiten sieht wie in der Liste. */
function isoToZurichDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-CA", { timeZone: "Europe/Zurich" }); // YYYY-MM-DD
  const time = d.toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit", hour12: false }); // HH:MM
  return `${date}T${time}`;
}

/** 'YYYY-MM-DDTHH:MM' aus <input type="datetime-local"> → ISO-timestamptz.
 *
 *  KRITISCH (§4 CLAUDE.md): `new Date("2026-06-15T09:30")` interpretiert
 *  den String in der TZ des Endgeraets. Bei Nutzern ausserhalb der Schweiz
 *  (z.B. Support-Handy in DE mit anderer System-TZ, Windows-Laptop mit
 *  falsch gesetzter Zone) wird die vom Mitarbeiter gewaehlte Wall-Clock-
 *  Zeit als lokale UTC-Konversion in die DB geschrieben — die Stempel-
 *  Korrektur landet dann verschoben (1-2h daneben je nach Offset).
 *
 *  Wir interpretieren das datetime-local IMMER als Zurich-Wall-Clock und
 *  konvertieren zwei-Pass ueber Intl.DateTimeFormat nach UTC — DST-safe,
 *  keine externe Library. Muster identisch zu zurichWallToUtcMs in
 *  src/app/api/hr/anfragen/route.ts. */
function zurichDatetimeLocalToIso(local: string): string {
  const [datePart, timePart = "00:00"] = local.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  const [h, mi] = timePart.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi, 0);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const gh = get("hour");
  const seen = Date.UTC(
    get("year"), get("month") - 1, get("day"),
    gh === 24 ? 0 : gh, get("minute"), get("second"),
  );
  const offset = seen - guess;
  return new Date(guess - offset).toISOString();
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** Optional: Type direkt vorauswaehlen und den Chip-Toggle oben
   *  ausblenden — der Kontext ist damit eindeutig (kein Wechsel
   *  moeglich/gewollt). Wird z.B. von /stempelzeiten und dem Sidebar-/
   *  Widget-"Stempelticket"-Button benutzt. Ohne initialType oeffnet
   *  das Modal im Stempel-Aenderungs-Default (90%-Fall) und zeigt die
   *  Typ-Chips oben zum Wechseln. */
  initialType?: TicketType;
  /** Optional: Stempel-Aenderung-Form direkt mit einem bestehenden
   *  time_entry vorbelegen (Inline-Context von /stempelzeiten aus dem
   *  Row-"Korrigieren"-Button). Setzt mode='korrektur', waehlt den
   *  Eintrag, und legt clock_in/clock_out als vorgeschlagene
   *  Start-/End-Zeit ins Formular. User aendert nur die falschen
   *  Minuten und tippt den Grund. */
  initialData?: {
    timeEntryId?: string;
    clockIn?: string;         // ISO
    clockOut?: string | null; // ISO oder null (Preset='no_out': Ende leer)
    jobId?: string | null;
  };
}

const TYPES: { id: TicketType; label: string; description: string; icon: React.ComponentType<{ className?: string }>; tone: TypePickerTone }[] = [
  { id: "it",                label: "IT-Problem",       description: "Drucker, Software, Login, Hardware", icon: Wrench,  tone: "purple" },
  { id: "beleg",             label: "Beleg",            description: "Quittung einreichen für Erstattung", icon: Receipt, tone: "amber"  },
  { id: "stempel_aenderung", label: "Stempel-Änderung", description: "Korrektur oder Nacherfassung",       icon: Clock,   tone: "green"  },
  { id: "material",          label: "Material",         description: "Etwas einkaufen — Genehmigung",      icon: Package, tone: "red"    },
];

/** Default-Titel je Typ — Stempel/Beleg/Material bekommen den Titel
 *  vorbelegt, damit der User nicht jedes Mal tippen muss. IT bleibt leer,
 *  weil der Titel dort tatsaechlich das Problem beschreibt. */
function defaultTitleFor(t: TicketType): string {
  if (t === "beleg") return "Beleg-Erstattung";
  if (t === "stempel_aenderung") return "Stempelzeit-Änderung";
  if (t === "material") return "Material-Anfrage";
  return "";
}

export function NewTicketModal({ open, onClose, onCreated, initialType, initialData }: Props) {
  const supabase = createClient();
  // Hero-Default: Stempel-Aenderung (90%-Fall). initialType, wenn gesetzt,
  // hat Vorrang (z.B. Sidebar-/Widget-/Row-Trigger).
  const defaultType: TicketType = initialType ?? "stempel_aenderung";
  const [type, setType] = useState<TicketType>(defaultType);
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

  // Stempel-Aenderung-spezifisch. Kein separater Modus-State mehr — der
  // Modus (Korrektur vs Nachtrag) wird aus stempel.time_entry_id abgeleitet:
  // gesetzte ID = Korrektur eines bestehenden Eintrags; leer/NEW_ENTRY_ID =
  // Nachtrag (Vergessen).
  const [stempelContext, setStempelContext] = useState<StempelContext>("auftrag");
  const [timeEntries, setTimeEntries] = useState<Array<{ id: string; clock_in: string; clock_out: string | null; job_id: string | null; job_label: string | null }>>([]);
  const [stempel, setStempel] = useState({
    time_entry_id: "",
    neu_start: "",        // datetime-local
    neu_end: "",          // datetime-local
    job_id: "",
    project_id: "",       // nur genutzt wenn stempelContext === 'projekt'
    beschreibung: "",
    grund: "",
  });
  const [jobs, setJobs] = useState<{ id: string; job_number: number; title: string; start_date: string | null; end_date: string | null }[]>([]);
  // Genehmigte, nicht-geloeschte Projekte fuer den Projekt-Kontext-Picker.
  // status='genehmigt' weil Zeit nur auf genehmigte Projekte gestempelt
  // werden darf (siehe Migration 186_projekte.sql — Budget-Kontrolle).
  const [projects, setProjects] = useState<Array<{ id: string; title: string }>>([]);

  // Material-spezifisch — pro Anfrage koennen mehrere Positionen rein
  // (Warenkorb mit mehreren Artikeln). Mindestens 1 leeres Item beim
  // Start damit das Form sofort ausfuellbar ist.
  const [materialItems, setMaterialItems] = useState<Array<{ artikel: string; menge: string; betrag_chf: string }>>(
    [{ artikel: "", menge: "1", betrag_chf: "" }],
  );
  const [materialAuftrag, setMaterialAuftrag] = useState("");

  // IT-spezifisch.
  const [device, setDevice] = useState("");

  // Beim Oeffnen/Schliessen Reset auf den Default-Typ (Stempel-Aenderung im
  // generischen Fall, initialType wenn ein Kontext-Trigger den Modal aufmacht).
  // Wenn initialData einen time_entry mitliefert (Inline-Context von
  // /stempelzeiten Row-"Korrigieren"), wird der Korrektur-Modus vorausgewaehlt
  // und Start/Ende bereits mit den bestehenden Zeiten befuellt — User muss nur
  // die falschen Minuten korrigieren und den Grund tippen.
  useEffect(() => {
    if (!open) {
      setType(defaultType);
      setSaving(false);
      setFiles([]);
      setTitle(defaultTitleFor(defaultType));
      setDescription("");
      setUrgent(false);
      setBeleg({ betrag_chf: "", kaufdatum: "", lieferant: "" });
      setBelegApprovalSource("person");
      setBelegApprovalUserId("");
      setBelegApprovalTicketId("");
      setAnalyzing(false);
      setAnalysisIssues([]);
      setAnalysisDone(false);
      setStempelContext("auftrag");
      setStempel({ time_entry_id: "", neu_start: "", neu_end: "", job_id: "", project_id: "", beschreibung: "", grund: "" });
      setMaterialItems([{ artikel: "", menge: "1", betrag_chf: "" }]);
      setMaterialAuftrag("");
      setDevice("");
      return;
    }
    // open===true — Prefill fuer Stempel-Aenderung wenn initialData mitkommt.
    // Ein direkt uebergebener time_entry ist per Definition ein "Zeit war
    // falsch"-Flow (Inline-Row-Button in /stempelzeiten). Preset markieren
    // damit die Preset-Kachel oben visuell aktiv ist und der User sofort
    // in den Ende-Zeit-Feldern anpasst.
    if (initialType === "stempel_aenderung" && initialData?.timeEntryId) {
      // Kontext aus dem vorbelegten Eintrag ableiten: mit job_id → Auftrag,
      // ohne → Andere Arbeit. Projekt-Zeit-Eintraege leiten wir hier
      // absichtlich NICHT auf 'projekt' um — der Prefill-Pfad kommt vom
      // /stempelzeiten-Row-Button und liefert nur jobId; project_id-Prefill
      // liesse sich ergaenzen sobald der Aufrufer sie mitschickt.
      setStempelContext(initialData.jobId ? "auftrag" : "andere_arbeit");
      setStempel({
        time_entry_id: initialData.timeEntryId,
        neu_start: initialData.clockIn ? isoToZurichDatetimeLocal(initialData.clockIn) : "",
        neu_end: initialData.clockOut ? isoToZurichDatetimeLocal(initialData.clockOut) : "",
        job_id: initialData.jobId ?? "",
        project_id: "",
        beschreibung: "",
        grund: "",
      });
    }
    // initialData?.timeEntryId in Deps: sonst haengt bei einem Kontext-
    // Wechsel (z.B. User klickt in /stempelzeiten von Row A auf Row B ohne
    // Modal-Close dazwischen) noch der Prefill von Row A im Formular. Ohne
    // Deps-Eintrag reagiert der Effect nur auf open→false→true, aber nicht
    // auf einen wechselnden Prefill-Datensatz waehrend offener Modal-Session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialData?.timeEntryId]);

  // Stempel-Eintraege laden wenn Typ Stempel-Aenderung gewaehlt wird.
  // Separate Queries fuer time_entries und jobs — der nested join
  // (job:jobs(...)) hatte still failende Probleme bei manchen Usern.
  //
  // WICHTIG: explizit .eq('user_id', currentUserId) — sonst leakt fuer
  // Admins die RLS-Policy 'Admins sehen alle Zeiteintraege' saemtliche
  // Eintraege rein und das limit(...) schneidet die eigenen aelteren
  // Eintraege weg. Limit hoch auf 100 — bei eigenen Eintraegen reicht
  // das fuer ~3 Monate auch bei sehr aktiven Usern.
  useEffect(() => {
    if (type !== "stempel_aenderung") return;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: entries, error: entriesErr } = await supabase
        .from("time_entries")
        .select("id, clock_in, clock_out, description, job_id")
        .eq("user_id", user.id)
        .order("clock_in", { ascending: false })
        .limit(100);
      if (entriesErr) {
        toast.error("Stempel-Einträge konnten nicht geladen werden: " + entriesErr.message);
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
            job_id: e.job_id ?? null,
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
        .not("role", "in", PORTAL_ROLLEN_IN)
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

  // Projekte fuer Stempel-Form laden — nur genehmigte, nicht-geloeschte.
  // Genehmigt: weil nur auf genehmigte Projekte Zeit gestempelt werden darf
  // (Budget-Kontrolle). Nach Titel sortieren fuer stabile alphabetische
  // Reihenfolge im Picker.
  useEffect(() => {
    if (type !== "stempel_aenderung") return;
    (async () => {
      const { data, error } = await supabase
        .from("projects")
        .select("id, title")
        .eq("status", "genehmigt")
        .eq("is_deleted", false)
        .order("title", { ascending: true });
      if (error) {
        toast.error("Projekte konnten nicht geladen werden: " + error.message);
        return;
      }
      setProjects(data ?? []);
    })();
  }, [type, supabase]);

  function pickType(t: TicketType) {
    if (t === type) return; // Chip auf aktivem Typ tut nichts.
    setType(t);
    // Default-Title vorbelegen — aber nur wenn der User noch nichts eigenes
    // getippt hat oder gerade den default eines anderen Typs stehen hat.
    // Wir setzen bewusst hart auf den neuen Default: der Chip-Wechsel ist
    // ein Kontext-Wechsel, das alte Titel-Feld ist meistens ohnehin nur
    // der Auto-Default.
    setTitle(defaultTitleFor(t));
    // Files/Analyse-State stehen lassen — der User koennte einen Beleg
    // hochgeladen haben und versehentlich zu 'IT' gewechselt sein; besser
    // nicht wortlos zerstoeren.
  }

  /** Modus wird aus stempel.time_entry_id abgeleitet — kein separater
   *  State. Leere/NEW_ENTRY_ID = Nachtrag ('vergessen'), gesetzte UUID =
   *  Korrektur eines bestehenden Eintrags. Der Submit-Handler nutzt das,
   *  um data-Payload und apply_ticket-Verhalten zu bestimmen. */
  const stempelMode: "korrektur" | "vergessen" =
    stempel.time_entry_id && stempel.time_entry_id !== NEW_ENTRY_ID
      ? "korrektur"
      : "vergessen";

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
      // Sowohl bei Korrektur als auch bei Nachtrag brauchen wir Start + Ende
      // — bei Korrektur werden sie beim Auswaehlen des Eintrags vorbelegt,
      // bei Nachtrag muss der User sie tippen.
      if (!stempel.neu_start || !stempel.neu_end) return "Start- und End-Zeit fehlen";
      // Lock-Check: bei Nachtrag prueft der Client den neu_start; bei
      // Korrektur haerte apply_ticket serverseitig ab (Alt-Row-Info ist
      // dort verfuegbar). Warnung im Client erspart dem User das
      // Absenden + Ablehnen-Toast.
      if (stempelMode === "vergessen" && isTimeEntryLocked(zurichDatetimeLocalToIso(stempel.neu_start))) {
        return TIME_ENTRY_LOCK_MESSAGE;
      }
      // Kontext-Pflichtfelder — je nach Segment-Toggle.
      if (stempelContext === "auftrag" && stempelMode === "vergessen" && !stempel.job_id) return "Auftrag auswählen";
      if (stempelContext === "projekt" && !stempel.project_id) return "Projekt auswählen";
      if (stempelContext === "andere_arbeit" && !stempel.beschreibung.trim()) return "Beschreibung der Arbeit ist Pflicht";
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
        // Kontext-abhaengige Felder — in data steht IMMER 'context', damit
        // der Approver sofort weiss ob Auftrag / Projekt / Andere Arbeit
        // gemeint war. job_id gilt nur fuer context='auftrag',
        // project_id nur fuer 'projekt', beschreibung nur fuer
        // 'andere_arbeit'. Der apply_ticket-RPC (Migration 213) verarbeitet
        // alle drei Kontexte end-to-end und schreibt project_id direkt in
        // die time_entries-Row — keine Handarbeit mehr noetig.
        const contextFields: Record<string, unknown> = { context: stempelContext };
        if (stempelContext === "auftrag") {
          contextFields.job_id = stempel.job_id || undefined;
        } else if (stempelContext === "projekt") {
          contextFields.project_id = stempel.project_id || undefined;
        } else if (stempelContext === "andere_arbeit") {
          contextFields.beschreibung = stempel.beschreibung.trim() || undefined;
        }

        // datetime-local IMMER als Zurich-Wall-Clock interpretieren
        // (siehe zurichDatetimeLocalToIso). Ein naives new Date(...) wuerde
        // die vom Mitarbeiter gewaehlte Zeit in der TZ des Endgeraets lesen
        // und bei nicht-CH-Zonen verschoben in die DB schreiben.
        if (stempelMode === "korrektur") {
          data = {
            ...contextFields,
            time_entry_id: stempel.time_entry_id,
            neu_start: stempel.neu_start ? zurichDatetimeLocalToIso(stempel.neu_start) : undefined,
            neu_end: stempel.neu_end ? zurichDatetimeLocalToIso(stempel.neu_end) : undefined,
            grund: stempel.grund,
          };
        } else {
          data = {
            ...contextFields,
            neu_start: zurichDatetimeLocalToIso(stempel.neu_start),
            neu_end: zurichDatetimeLocalToIso(stempel.neu_end),
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

  // Header-Titel: bei initialType (Kontext-Trigger) den spezifischen Typ-
  // Label zeigen, sonst neutral "Neues Ticket" — die Chips oben zeigen,
  // welcher Typ aktiv ist.
  const modalTitle = initialType
    ? (TYPES.find((t) => t.id === type)?.label ?? "Neues Ticket")
    : "Neues Ticket";

  // datetime-local-Strings ('YYYY-MM-DDTHH:MM') in Datum + Uhrzeit
  // splitten — fuer separate <input type=date> und <input type=time>.
  // Vorteil ggue. type=datetime-local: Datum direkt tippbar (DD.MM.YYYY)
  // oder via Calendar-Picker, Zeit ohne den klobigen kombinierten Picker.
  // tz-ok: s ist datetime-local-String "YYYY-MM-DDTHH:MM" ohne TZ-Offset
  // (User-Input aus <input type="date"> + <input type="time">), nicht
  // timestamptz aus der DB. Split ist hier korrekt.
  const dtDate = (s: string) => (s ? s.split("T")[0] ?? "" : ""); // tz-ok
  const dtTime = (s: string) => (s ? (s.split("T")[1] ?? "").slice(0, 5) : ""); // tz-ok
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
      <div className="space-y-4">
          {/* Chip-Toggle: nur zeigen wenn der Modal generisch geoeffnet
              wurde (nicht ueber einen Kontext-Trigger mit initialType).
              Aktiver Typ ist visuell hervorgehoben (rote Akzent-Border),
              Klick wechselt das Formular ohne Zwischen-Screen. */}
          {!initialType && (
            <div className="flex flex-wrap gap-1.5">
              {TYPES.map((t) => {
                const Icon = t.icon;
                const active = type === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => pickType(t.id)}
                    aria-pressed={active}
                    disabled={saving}
                    className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[11px] font-medium border transition-all ${
                      active
                        ? "border-red-500/50 bg-red-500/[0.08] text-red-700 dark:text-red-300"
                        : "border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {t.label}
                  </button>
                );
              })}
            </div>
          )}

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
              {/* EIN flacher Flow: Eintrag waehlen (bestehender oder neu),
                  Zeiten korrigieren/eintragen, Kontext bestaetigen, Grund
                  tippen. Keine Preset-Kacheln, keine bedingten Sub-Sections
                  — der Nutzer sieht immer die gleichen Felder und weiss was
                  er tut. Modus (Korrektur vs Nachtrag) wird aus der Eintrag-
                  Auswahl abgeleitet. */}

              {/* Eintrag-Picker: bestehende Eintraege + "Neu (nachtragen)"-
                  Option ganz oben. Auswahl fuellt Zeiten + Kontext vor. */}
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground/70 ml-1">Eintrag *</p>
                <SearchableSelect
                  value={stempel.time_entry_id || NEW_ENTRY_ID}
                  onChange={(v) => {
                    if (v === NEW_ENTRY_ID) {
                      // Nachtrag: heute vorbelegen, Rest leer.
                      const todayIso = localDateIso(new Date());
                      setStempel((prev) => ({
                        ...prev,
                        time_entry_id: "",
                        neu_start: `${todayIso}T00:00`,
                        neu_end: `${todayIso}T00:00`,
                        job_id: "",
                      }));
                      setStempelContext("auftrag");
                      return;
                    }
                    // Bestehender Eintrag: Zeiten + Kontext uebernehmen —
                    // User aendert nur was falsch ist.
                    const entry = timeEntries.find((e) => e.id === v);
                    if (!entry) return;
                    setStempel((prev) => ({
                      ...prev,
                      time_entry_id: v,
                      neu_start: isoToZurichDatetimeLocal(entry.clock_in),
                      neu_end: entry.clock_out
                        ? isoToZurichDatetimeLocal(entry.clock_out)
                        : isoToZurichDatetimeLocal(new Date().toISOString()),
                      job_id: entry.job_id ?? "",
                    }));
                    setStempelContext(entry.job_id ? "auftrag" : "andere_arbeit");
                  }}
                  items={[
                    { id: NEW_ENTRY_ID, label: "+ Neuer Eintrag (nachtragen)" },
                    ...timeEntries.map((e) => {
                      const inLabel = new Date(e.clock_in).toLocaleString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
                      const outLabel = e.clock_out
                        ? " – " + new Date(e.clock_out).toLocaleString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" })
                        : " (noch offen)";
                      return {
                        id: e.id,
                        // timeZone Europe/Zurich zwingend — SSR (UTC) wuerde
                        // sonst Schichten kurz nach Mitternacht als Vortag
                        // labeln, was die Stempel-Auswahl irrefuehrt.
                        label: `${inLabel}${outLabel} — ${e.job_label ?? "—"}`,
                      };
                    }),
                  ]}
                  placeholder="Eintrag auswählen oder neu…"
                  clearable={false}
                />
              </div>

              {/* Start / Ende — immer sichtbar, immer editierbar. Bei
                  bestehendem Eintrag mit dessen Zeiten vorbelegt. */}
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

              {/* Lock-Warnung: nur bei Nachtrag (Korrektur wird serverseitig
                  gegen die Alt-Row gepueft). Erspart User Absenden + Ablehn. */}
              {stempelMode === "vergessen" && stempel.neu_start && isTimeEntryLocked(zurichDatetimeLocalToIso(stempel.neu_start)) && (
                <div className="flex items-start gap-2 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-2.5">
                  <Lock className="h-4 w-4 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
                  <div className="text-xs text-amber-800 dark:text-amber-200">
                    <p className="font-semibold">Zeitraum bereits abgerechnet</p>
                    <p className="mt-0.5">
                      Der gewählte Tag liegt nach der Abrechnungs-Deadline
                      (5. des Folgemonats). Nachträge sind hier nicht mehr
                      möglich — bitte an die Buchhaltung wenden.
                    </p>
                  </div>
                </div>
              )}

              {/* Kontext-Segment (Auftrag | Projekt | Andere Arbeit) — immer
                  sichtbar. Vorbelegt aus dem gewaehlten Eintrag, User kann
                  wechseln (z.B. wenn Kontext falsch war). */}
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground/70 ml-1">Kontext *</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setStempelContext("auftrag")}
                    aria-pressed={stempelContext === "auftrag"}
                    className={stempelContext === "auftrag" ? "kasten-active flex-1" : "kasten-toggle-off flex-1"}
                  >
                    Auftrag
                  </button>
                  <button
                    type="button"
                    onClick={() => setStempelContext("projekt")}
                    aria-pressed={stempelContext === "projekt"}
                    className={stempelContext === "projekt" ? "kasten-active flex-1" : "kasten-toggle-off flex-1"}
                  >
                    Projekt
                  </button>
                  <button
                    type="button"
                    onClick={() => setStempelContext("andere_arbeit")}
                    aria-pressed={stempelContext === "andere_arbeit"}
                    className={stempelContext === "andere_arbeit" ? "kasten-active flex-1" : "kasten-toggle-off flex-1"}
                  >
                    Andere Arbeit
                  </button>
                </div>
              </div>

              {stempelContext === "auftrag" && (
                <div className="space-y-1">
                  <p className="text-[10px] text-muted-foreground/70 ml-1">
                    Auftrag {stempelMode === "vergessen" ? "*" : "(optional — wenn Neu-Zuordnung)"}
                  </p>
                  <SearchableSelect
                    value={stempel.job_id}
                    onChange={(v) => setStempel({ ...stempel, job_id: v })}
                    items={(() => {
                      const stempelDate = dtDate(stempel.neu_start);
                      const relevant = stempelDate
                        ? jobs.filter((j) => {
                            if (!j.start_date) return true;
                            const start = localDateIso(new Date(j.start_date));
                            const end = localDateIso(new Date(j.end_date ?? j.start_date));
                            return start <= stempelDate && stempelDate <= end;
                          })
                        : jobs;
                      return relevant.map((j) => ({ id: j.id, label: `INT-${j.job_number} — ${j.title}` }));
                    })()}
                    placeholder="Auftrag auswählen…"
                    clearable={false}
                  />
                </div>
              )}

              {stempelContext === "projekt" && (
                <div className="space-y-1">
                  <p className="text-[10px] text-muted-foreground/70 ml-1">Projekt *</p>
                  {projects.length === 0 ? (
                    <div className="px-3 py-2 text-sm rounded-lg border border-border bg-muted/30 text-muted-foreground">
                      Keine genehmigten Projekte vorhanden — wähle stattdessen Auftrag oder Andere Arbeit.
                    </div>
                  ) : (
                    <SearchableSelect
                      value={stempel.project_id}
                      onChange={(v) => setStempel({ ...stempel, project_id: v })}
                      items={projects.map((p) => ({ id: p.id, label: p.title }))}
                      placeholder="Projekt auswählen…"
                      clearable={false}
                    />
                  )}
                </div>
              )}

              {stempelContext === "andere_arbeit" && (
                <div className="space-y-1">
                  <p className="text-[10px] text-muted-foreground/70 ml-1">Beschreibung der Arbeit *</p>
                  <Input
                    value={stempel.beschreibung}
                    onChange={(e) => setStempel({ ...stempel, beschreibung: e.target.value })}
                    placeholder="kurz: was wurde gemacht"
                  />
                </div>
              )}

              {/* Grund + Textbausteine — immer sichtbar. */}
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground/70 ml-1">Grund der Änderung *</p>
                <textarea
                  value={stempel.grund}
                  onChange={(e) => setStempel({ ...stempel, grund: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 text-sm rounded-xl border border-border bg-card resize-none"
                  placeholder="warum gehört das angepasst…"
                />
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {STEMPEL_TEXTBAUSTEINE.map((tb) => (
                    <button
                      key={tb}
                      type="button"
                      onClick={() => setStempel((prev) => ({ ...prev, grund: tb }))}
                      className="px-2 py-0.5 rounded-md border border-border bg-muted/30 text-[10px] text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
                    >
                      {tb}
                    </button>
                  ))}
                </div>
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
            {/* Kein "Zurueck" mehr — der Chip-Toggle oben ersetzt den
                Picker-Screen. Immer "Abbrechen". */}
            <button type="button" onClick={onClose} disabled={saving} className="kasten kasten-muted flex-1">
              Abbrechen
            </button>
            <button type="button" onClick={submit} disabled={saving} className="kasten kasten-red flex-1">
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {saving
                ? "Wird gesendet…"
                : type === "stempel_aenderung"
                  ? "Ticket senden"
                  : "Ticket einreichen"}
            </button>
          </div>
        </div>
    </Modal>
  );
}
