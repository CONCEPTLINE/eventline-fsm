"use client";

/**
 * Modal um einen neuen Termin direkt aus dem Kalender heraus zu erstellen.
 * Die Logik ist analog zu AppointmentsSection.addAppointment(), aber mit
 * einem Auftrag-Picker statt fixem jobId — User waehlt im Kalender erst
 * den Auftrag, dann die Termin-Details.
 *
 * Nicht reused mit AppointmentsSection weil dort der Kontext (Job +
 * Mail-Notify-Logik mit jobTitle) anders ist. Sauberer als den Form
 * auszubauen damit er beide Use-Cases abdeckt.
 */

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { logError } from "@/lib/log";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import type { Profile, TimeOffType } from "@/types";
import type { CalendarItem } from "./types";
import { useTimeOffConflicts, buildConflictMap } from "@/lib/use-time-off-conflicts";
import { AlertTriangle } from "lucide-react";
import { toLocalIsoString } from "@/lib/format";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Kalender-Items als Auftrag-Picker-Source — schon im Parent geladen. */
  items: CalendarItem[];
  /** Nach erfolgreichem Speichern: Kalender neu laden. */
  onCreated: () => void;
  /** Vorausgefuelltes Datum (Klick auf eine Cell → Termin fuer den Tag). */
  initialDate?: Date | null;
}

// Sentinel-Wert fuer "Nicht Auftrag bezogen" — Auftrag-Auswahl ist Pflicht,
// aber der User kann explizit waehlen dass der Termin keinem Job zugeordnet
// ist (Schulung, internes Meeting). In der DB landet dann job_id=null.
const NO_JOB = "none" as const;

// YYYY-MM-DD im LOKALEN Timezone — Date.toISOString() konvertiert in UTC was
// in CET/CEST oft den Tag zurueckrolllt (z.B. lokal 00:00 am 17. = 22:00 UTC
// am 16.). Date-Inputs erwarten lokales Datum, also lokal bauen.
function toLocalDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function NeuerTerminModal({ open, onClose, items, onCreated, initialDate }: Props) {
  const supabase = createClient();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Auftrag-Auswahl ist Pflicht, mit NO_JOB ("none") als expliziter Opt-Out-Wahl
  // ("Nicht Auftrag bezogen" — z.B. fuer Buero-/Schulungs-Termine die nicht
  // an einen Job haengen). null = nichts gewaehlt → Submit blockiert.
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobSearch, setJobSearch] = useState("");
  const [title, setTitle] = useState("");
  // YYYY-MM-DD lokal, NICHT via toISOString() — das konvertiert in UTC und
  // rollt in CET/CEST den Tag zurueck (z.B. 17. → 16.).
  const [date, setDate] = useState(() => toLocalDateString(new Date()));
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [assignedTo, setAssignedTo] = useState<string[]>([]);
  const [description, setDescription] = useState("");

  // Profiles lazy laden — erst wenn Modal geoeffnet wird, einmalig.
  useEffect(() => {
    if (!open || profilesLoaded) return;
    (async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, email, full_name, phone, role, avatar_url, is_active, created_at, updated_at")
        .eq("is_active", true)
        .neq("role", "partner")
        .order("full_name");
      if (error) {
        logError("kalender.neuer-termin.load-profiles", error);
        return;
      }
      setProfiles((data ?? []) as Profile[]);
      setProfilesLoaded(true);
    })();
  }, [open, profilesLoaded, supabase]);

  // Beim Oeffnen: Datum aus initialDate uebernehmen wenn gegeben.
  useEffect(() => {
    if (open && initialDate) {
      setDate(toLocalDateString(initialDate));
    }
  }, [open, initialDate]);

  // Ferien-Konflikte am gewaehlten Datum
  const timeOffConflicts = useTimeOffConflicts(open ? date : null);
  const conflictByUser = buildConflictMap(timeOffConflicts);

  const TYPE_LABEL: Record<TimeOffType, string> = {
    ferien: "Ferien",
    krank: "Krank",
    kompensation: "Kompensation",
    frei: "Frei",
  };

  function formatDateShort(iso: string): string {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d, 12).toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit" });
  }

  function reset() {
    setJobId(null);
    setJobSearch("");
    setTitle("");
    setDate(toLocalDateString(new Date()));
    setStartTime("09:00");
    setEndTime("17:00");
    setAssignedTo([]);
    setDescription("");
  }

  const filteredJobs = useMemo(() => {
    if (!jobSearch.trim()) return items.slice(0, 30);
    const q = jobSearch.toLowerCase();
    return items.filter((it) => it.title.toLowerCase().includes(q) || (it.customerName?.toLowerCase().includes(q) ?? false)).slice(0, 30);
  }, [items, jobSearch]);

  const selectedJob = jobId && jobId !== NO_JOB ? items.find((it) => it.id === jobId) ?? null : null;
  const isNoJobSelected = jobId === NO_JOB;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("Titel fehlt");
      return;
    }
    if (jobId === null) {
      toast.error("Bitte Auftrag wählen oder „Nicht Auftrag bezogen“");
      return;
    }
    setSubmitting(true);
    try {
      const startISO = toLocalIsoString(date, startTime || "00:00");
      const endISO = toLocalIsoString(date, endTime || startTime || "00:00");

      const { data: { user } } = await supabase.auth.getUser();
      const assignees = assignedTo.length > 0 ? assignedTo : [user?.id || ""];

      // NO_JOB → null in der DB; sonst echte Job-UUID.
      const dbJobId = jobId === NO_JOB ? null : jobId;
      const rows = assignees.map((personId) => ({
        job_id: dbJobId,
        title: title.trim(),
        start_time: startISO,
        end_time: endISO,
        assigned_to: personId,
        description: description.trim() || null,
      }));
      const { error } = await supabase.from("job_appointments").insert(rows);
      if (error) throw error;

      toast.success(`Termin erstellt${assignees.length > 1 ? ` (${assignees.length} Personen)` : ""}`);
      reset();
      onCreated();
      onClose();
    } catch (e) {
      logError("kalender.neuer-termin.submit", e);
      TOAST.supabaseError(e, "Termin konnte nicht erstellt werden");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!submitting) { reset(); onClose(); } }}
      title="Neuer Termin"
      size="md"
      closable={!submitting}
    >
      <form onSubmit={submit} className="space-y-4">
        {/* Auftrag-Picker — Pflichtfeld. Entweder echter Auftrag oder
            explizit "Nicht Auftrag bezogen" (NO_JOB-Sentinel). */}
        <div>
          <label className="text-xs font-medium text-muted-foreground">Auftrag *</label>
          {selectedJob ? (
            <div className="mt-1.5 flex items-center justify-between gap-2 px-3 py-2 rounded-lg border bg-muted/30">
              <span className="text-sm font-medium truncate">{selectedJob.title}</span>
              <button type="button" onClick={() => { setJobId(null); setJobSearch(""); }} className="text-xs text-muted-foreground hover:text-foreground">
                Entfernen
              </button>
            </div>
          ) : isNoJobSelected ? (
            <div className="mt-1.5 flex items-center justify-between gap-2 px-3 py-2 rounded-lg border bg-muted/30">
              <span className="text-sm font-medium italic text-muted-foreground">Nicht Auftrag bezogen</span>
              <button type="button" onClick={() => { setJobId(null); setJobSearch(""); }} className="text-xs text-muted-foreground hover:text-foreground">
                Entfernen
              </button>
            </div>
          ) : (
            // Outer relative wrapper damit das Dropdown absolute ueber den
            // anderen Form-Feldern schwebt statt sie zu verdraengen.
            <div className="relative">
              <div className="mt-1.5 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Auftrag suchen..."
                  value={jobSearch}
                  onChange={(e) => setJobSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
              <div className="absolute left-0 right-0 top-full mt-1.5 max-h-56 overflow-y-auto rounded-lg border bg-card shadow-xl z-50 p-1 space-y-0.5">
                {/* "Nicht Auftrag bezogen"-Option ist immer sichtbar — auch
                    ohne Such-Eingabe, damit der User die Opt-Out-Wahl ohne
                    Tipperei findet. */}
                <button
                  type="button"
                  onClick={() => { setJobId(NO_JOB); setJobSearch(""); }}
                  className="auftrag-dropdown-item block w-full text-left px-3 py-2 text-sm rounded-md cursor-pointer transition-all duration-150 ease-out italic text-muted-foreground"
                >
                  Nicht Auftrag bezogen
                </button>
                {jobSearch.trim() && filteredJobs.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-muted-foreground">Keine Treffer</p>
                ) : (
                  filteredJobs.map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => { setJobId(it.id); setJobSearch(""); }}
                      className="auftrag-dropdown-item block w-full text-left px-3 py-2 text-sm rounded-md cursor-pointer transition-all duration-150 ease-out"
                    >
                      <span className="font-semibold truncate block">{it.title}</span>
                      {it.customerName && (
                        <span className="text-xs opacity-70">{it.customerName}</span>
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <Input placeholder="Termin-Titel *" value={title} onChange={(e) => setTitle(e.target.value)} required />

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-xs font-medium">Datum *</label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1" required />
          </div>
          <div>
            <label className="text-xs font-medium">Von *</label>
            <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="mt-1" required />
          </div>
          <div>
            <label className="text-xs font-medium">Bis *</label>
            <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="mt-1" required />
          </div>
        </div>

        <div>
          <label className="text-xs font-medium">
            Zuweisen an {assignedTo.length > 0 && <span className="text-red-500">({assignedTo.length})</span>}
          </label>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {profiles.map((p) => {
              const selected = assignedTo.includes(p.id);
              const conflict = conflictByUser.get(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setAssignedTo(selected ? assignedTo.filter((pid) => pid !== p.id) : [...assignedTo, p.id])}
                  className={selected ? "kasten-active" : "kasten-toggle-off"}
                  title={conflict ? `${TYPE_LABEL[conflict.type]} ${formatDateShort(conflict.start_date)}–${formatDateShort(conflict.end_date)} (${conflict.status})` : undefined}
                >
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${selected ? "bg-background/20" : "bg-foreground/10 text-muted-foreground"}`}>
                    {p.full_name.charAt(0)}
                  </div>
                  {p.full_name.split(" ")[0]}
                  {conflict && (
                    <AlertTriangle className={`h-3.5 w-3.5 ${conflict.status === "genehmigt" ? "text-red-500" : "text-amber-500"}`} />
                  )}
                </button>
              );
            })}
          </div>
          {assignedTo.length === 0 && <p className="text-[11px] text-muted-foreground mt-1">Keine Auswahl = mir selbst</p>}

          {timeOffConflicts.length > 0 && (
            <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 px-3 py-2">
              <p className="text-[11px] font-semibold text-amber-800 dark:text-amber-200 mb-1">
                Abwesend am {formatDateShort(date)}
              </p>
              <ul className="space-y-0.5 text-[11px] text-amber-900 dark:text-amber-200">
                {timeOffConflicts.map((c) => {
                  const isSelected = assignedTo.includes(c.user_id);
                  return (
                    <li key={c.id} className="flex items-center gap-1.5">
                      <AlertTriangle className={`h-3 w-3 shrink-0 ${c.status === "genehmigt" ? "text-red-500" : "text-amber-500"}`} />
                      <span className={isSelected ? "font-semibold" : ""}>
                        {c.user?.full_name ?? "Unbekannt"}
                      </span>
                      <span className="opacity-75">
                        · {TYPE_LABEL[c.type]} {formatDateShort(c.start_date)}–{formatDateShort(c.end_date)}
                        {c.status === "beantragt" ? " (Antrag offen)" : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        <textarea
          placeholder="Beschreibung..."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full px-3 py-2 text-sm rounded-lg border bg-card resize-none"
          rows={2}
        />

        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={() => { reset(); onClose(); }}
            disabled={submitting}
            className="kasten kasten-muted flex-1"
          >
            Abbrechen
          </button>
          <button type="submit" disabled={submitting} className="kasten kasten-red flex-1">
            {submitting ? "Speichern…" : "Termin erstellen"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
