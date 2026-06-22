"use client";

// Stempel-Einstempeln-Modal: zwei Wege.
//   "Auf Auftrag": Auftrag aus Liste der aktiven (offen+anfrage+entwurf)
//     suchen und auswaehlen — description optional.
//   "Andere Arbeit": ohne Auftrag, description PFLICHT (sonst weiss
//     der Admin spaeter nicht wofuer die Zeit gestempelt wurde).
//
// Bei direktem Klick auf "Auf Auftrag stempeln" auf einer Auftrag-Detail-
// Seite wird das Modal uebersprungen — dort ruft die Page direkt
// clockIn({jobId}) auf.

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import { useStempel } from "@/lib/use-stempel";
import { usePermissions } from "@/lib/use-permissions";
import { Briefcase, FileText, Clock, Info } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";

interface JobOption {
  id: string;
  job_number: number;
  title: string;
  start_date: string | null;
  end_date: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function StempelModal({ open, onClose }: Props) {
  const supabase = createClient();
  const { clockIn } = useStempel();
  const { role } = usePermissions();
  const isAdmin = role === "admin";
  const [mode, setMode] = useState<"choose" | "job" | "other">("choose");
  const [jobs, setJobs] = useState<JobOption[]>([]);
  const [search, setSearch] = useState("");
  const [selectedJob, setSelectedJob] = useState<JobOption | null>(null);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  // Hover-States per JS — Tailwind-Hover-Variants greifen bei diesen
  // Buttons aus dem gleichen Grund nicht wie bei der Stempel-Pille.
  const [hoveredCard, setHoveredCard] = useState<"job" | "other" | null>(null);
  const [pressedCard, setPressedCard] = useState<"job" | "other" | null>(null);

  // Beim Modal-Open: aktive Auftraege laden (offen + anfrage + entwurf —
  // also alles was nicht abgeschlossen oder storniert ist).
  useEffect(() => {
    if (!open) return;
    setMode("choose");
    setSearch("");
    setSelectedJob(null);
    setDescription("");
    (async () => {
      // Naechste anstehende Auftraege zuerst — sortiert nach start_date
      // aufsteigend (nullsLast), damit der Tech den Auftrag der heute/morgen
      // laeuft direkt oben sieht. Aufträge ohne Datum landen unten.
      // Filter: nur aktive Stati (kein abgeschlossen/storniert) UND nicht
      // soft-deleted.
      const { data } = await supabase
        .from("jobs")
        .select("id, job_number, title, start_date, end_date")
        .in("status", ["offen", "anfrage", "entwurf"])
        .neq("is_deleted", true)
        .order("start_date", { ascending: true, nullsFirst: false })
        .order("job_number", { ascending: false })
        .limit(50);
      setJobs((data as JobOption[]) ?? []);
    })();
  }, [open, supabase]);

  const filteredJobs = jobs.filter((j) => {
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return (
      j.title.toLowerCase().includes(term) ||
      String(j.job_number).includes(term)
    );
  });

  async function submitJob() {
    // Admins stempeln nicht auf Auftraege — der Auto-Stempel aus dem
    // Rapport-Abschluss legt die Stempelzeiten an. Doppel-Stempelung
    // verhindern.
    if (isAdmin) {
      toast.error("Admins stempeln nicht auf Auftraege — die Stunden werden automatisch aus dem Rapport-Abschluss gestempelt.", { duration: 6000 });
      return;
    }
    if (!selectedJob) {
      toast.error("Bitte einen Auftrag auswählen");
      return;
    }
    setSaving(true);
    const res = await clockIn({ jobId: selectedJob.id, description: description || null });
    setSaving(false);
    if (!res.success) {
      TOAST.stempelError(res.error || "Einstempeln fehlgeschlagen");
      return;
    }
    toast.success(`Eingestempelt auf INT-${selectedJob.job_number}`);
    onClose();
  }

  async function submitOther() {
    if (!description.trim()) {
      toast.error("Beschreibung ist Pflicht");
      return;
    }
    setSaving(true);
    const res = await clockIn({ description });
    setSaving(false);
    if (!res.success) {
      TOAST.stempelError(res.error || "Einstempeln fehlgeschlagen");
      return;
    }
    toast.success("Eingestempelt");
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={() => !saving && onClose()}
      title="Einstempeln"
      icon={<Clock className="h-5 w-5 text-teal-500" />}
      size="md"
      closable={!saving}
    >
      {mode === "choose" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Was machst du jetzt?</p>
          {isAdmin && (
            <div className="flex items-start gap-2 p-3 rounded-lg border border-blue-500/30 bg-blue-500/5 text-xs">
              <Info className="h-4 w-4 text-blue-600 dark:text-blue-300 mt-0.5 shrink-0" />
              <p className="text-foreground/80">
                <span className="font-medium">Auftrag-Stempel ist fuer Admins deaktiviert.</span>
                {" "}Deine Stunden werden automatisch beim Abschliessen des Rapports gestempelt.
                „Andere Arbeit" geht weiter (z.B. Buero-Zeit).
              </p>
            </div>
          )}
          <button
            type="button"
            onClick={() => isAdmin ? toast.error("Auftrag-Stempel ist fuer Admins deaktiviert — Stunden kommen aus dem Rapport-Abschluss.", { duration: 6000 }) : setMode("job")}
            onMouseEnter={() => !isAdmin && setHoveredCard("job")}
            onMouseLeave={() => { setHoveredCard(null); setPressedCard(null); }}
            onMouseDown={() => !isAdmin && setPressedCard("job")}
            onMouseUp={() => setPressedCard(null)}
            className={`w-full flex items-center gap-3 p-4 rounded-xl border bg-card text-left ${isAdmin ? "opacity-50 cursor-not-allowed" : ""}`}
            style={{
              transform: pressedCard === "job" ? "scale(0.99) translateY(0)" : hoveredCard === "job" ? "scale(1.01) translateY(-2px)" : "scale(1) translateY(0)",
              transition: "transform 180ms cubic-bezier(0.4,0,0.2,1), box-shadow 180ms, border-color 180ms, background-color 180ms",
              boxShadow: hoveredCard === "job" ? "0 8px 20px -6px rgba(220,38,38,0.25)" : "0 1px 2px rgba(0,0,0,0.05)",
              borderColor: hoveredCard === "job" ? "rgb(248,113,113)" : "var(--border)",
              backgroundColor: hoveredCard === "job" ? "rgba(220,38,38,0.04)" : "var(--card)",
            }}
          >
            <div
              className="w-10 h-10 rounded-xl bg-red-50 dark:bg-red-500/15 text-red-600 dark:text-red-400 flex items-center justify-center shrink-0"
              style={{
                transform: hoveredCard === "job" ? "scale(1.1) rotate(-4deg)" : "scale(1) rotate(0)",
                transition: "transform 180ms cubic-bezier(0.4,0,0.2,1)",
              }}
            >
              <Briefcase className="h-5 w-5" />
            </div>
            <div>
              <p className="font-medium text-sm">Auf einen Auftrag</p>
              <p className="text-xs text-muted-foreground">{isAdmin ? "Fuer Admins deaktiviert — Auto-Stempel aus Rapport" : "Zeit auf einen offenen Auftrag stempeln"}</p>
            </div>
          </button>
          <button
            type="button"
            onClick={() => setMode("other")}
            onMouseEnter={() => setHoveredCard("other")}
            onMouseLeave={() => { setHoveredCard(null); setPressedCard(null); }}
            onMouseDown={() => setPressedCard("other")}
            onMouseUp={() => setPressedCard(null)}
            className="w-full flex items-center gap-3 p-4 rounded-xl border bg-card text-left"
            style={{
              transform: pressedCard === "other" ? "scale(0.99) translateY(0)" : hoveredCard === "other" ? "scale(1.01) translateY(-2px)" : "scale(1) translateY(0)",
              transition: "transform 180ms cubic-bezier(0.4,0,0.2,1), box-shadow 180ms, border-color 180ms, background-color 180ms",
              boxShadow: hoveredCard === "other" ? "0 8px 20px -6px rgba(245,158,11,0.25)" : "0 1px 2px rgba(0,0,0,0.05)",
              borderColor: hoveredCard === "other" ? "rgb(251,191,36)" : "var(--border)",
              backgroundColor: hoveredCard === "other" ? "rgba(245,158,11,0.04)" : "var(--card)",
            }}
          >
            <div
              className="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0"
              style={{
                transform: hoveredCard === "other" ? "scale(1.1) rotate(-4deg)" : "scale(1) rotate(0)",
                transition: "transform 180ms cubic-bezier(0.4,0,0.2,1)",
              }}
            >
              <FileText className="h-5 w-5" />
            </div>
            <div>
              <p className="font-medium text-sm">Andere Arbeit</p>
              <p className="text-xs text-muted-foreground">Adminarbeit, Büro, Reisezeit — Beschreibung Pflicht</p>
            </div>
          </button>
        </div>
      )}

      {mode === "job" && (
        <div className="space-y-3">
          <Input
            placeholder="Auftrag suchen (Nummer oder Titel)…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <div className="max-h-64 overflow-y-auto space-y-1">
            {filteredJobs.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">Keine offenen Aufträge gefunden.</p>
            ) : (
              filteredJobs.map((job) => {
                // Datum-Anzeige: jobs.start_date ist timestamptz, also ISO-
                // String — direkt in Date stecken. Single-Day → "12.05.",
                // Range → "12.05.–14.05.". Ohne Daten: dezentes "—".
                const dateLabel = (() => {
                  if (!job.start_date) return null;
                  const start = new Date(job.start_date);
                  if (Number.isNaN(start.getTime())) return null;
                  const fmt: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", timeZone: "Europe/Zurich" };
                  const startStr = start.toLocaleDateString("de-CH", fmt); // tz-ok: fmt enthaelt timeZone (siehe oben)
                  if (!job.end_date || job.end_date === job.start_date) return startStr;
                  const end = new Date(job.end_date);
                  if (Number.isNaN(end.getTime())) return startStr;
                  const endStr = end.toLocaleDateString("de-CH", fmt); // tz-ok
                  return `${startStr}–${endStr}`;
                })();
                return (
                  <button
                    key={job.id}
                    type="button"
                    onClick={() => setSelectedJob(job)}
                    className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-all duration-150 ${
                      selectedJob?.id === job.id
                        ? "border-red-300 bg-red-50 dark:bg-red-500/10 dark:border-red-500/40 shadow-sm"
                        : "border-border hover:border-foreground/30 hover:bg-foreground/[0.03] hover:translate-x-0.5"
                    }`}
                  >
                    <span className="font-mono text-xs font-semibold text-muted-foreground shrink-0">INT-{job.job_number}</span>
                    <span className="text-sm truncate flex-1">{job.title}</span>
                    {dateLabel ? (
                      <span className="text-[11px] font-medium tabular-nums text-muted-foreground shrink-0">{dateLabel}</span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground/40 shrink-0">—</span>
                    )}
                  </button>
                );
              })
            )}
          </div>
          <div>
            <Label className="text-xs">Notiz (optional)</Label>
            <Input
              placeholder="Was machst du genau?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={() => setMode("choose")} className="kasten kasten-muted flex-1">Zurück</button>
            <button
              type="button"
              onClick={submitJob}
              disabled={saving || !selectedJob}
              className="kasten kasten-red flex-1"
            >
              {saving ? "Stempelt…" : "Einstempeln"}
            </button>
          </div>
        </div>
      )}

      {mode === "other" && (
        <div className="space-y-3">
          <div>
            <Label>Was machst du? *</Label>
            <textarea
              autoFocus
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="z.B. Buchhaltung, Materialeinkauf, Reisezeit zum Kunden…"
              rows={4}
              className="mt-1.5 w-full px-3 py-2 text-sm rounded-lg border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={() => setMode("choose")} className="kasten kasten-muted flex-1">Zurück</button>
            <button
              type="button"
              onClick={submitOther}
              disabled={saving || !description.trim()}
              className="kasten kasten-red flex-1"
            >
              {saving ? "Stempelt…" : "Einstempeln"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
