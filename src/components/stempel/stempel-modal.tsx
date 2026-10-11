"use client";

// Stempel-Einstempeln-Modal: drei Wege.
//   "Auf Auftrag": Auftrag aus Liste der aktiven (offen+anfrage+entwurf)
//     suchen und auswaehlen — description optional.
//   "Auf Projekt": internes Projekt auswaehlen — description optional.
//     Wenn User noch nicht Mitglied ist, wird er beim Stempeln automatisch
//     dem Projekt beigefuegt (project_members-Insert), analog zum bisherigen
//     Detail-Seiten-Flow. Gestempelt wird dann direkt in time_entries mit
//     gesetzter project_id (siehe Migration 212), nicht mehr in der alten
//     project_time_entries-Tabelle.
//   "Andere Arbeit": ohne Auftrag/Projekt, description PFLICHT (sonst weiss
//     der Admin spaeter nicht wofuer die Zeit gestempelt wurde).
//
// Bei direktem Klick auf "Auf Auftrag stempeln" auf einer Auftrag-Detail-
// Seite wird das Modal uebersprungen — dort ruft die Page direkt
// clockIn({jobId}) auf.

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import { useStempel, type StempelErgebnis } from "@/lib/use-stempel";
import { usePermissions } from "@/lib/use-permissions";
import { Briefcase, FileText, Clock, Info, FolderKanban, CheckCircle2, CloudOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { formatProjectNumber } from "@/lib/projekte-format";
import { formatJobNumber } from "@/lib/nummern-format";
import { JOB_STATUS_VORSTUFEN } from "@/lib/constants";
import { ladeMeineEinsaetze, heuteTag, plusTage, aktuellerEinsatz, zuerichTag } from "@/lib/einsaetze";
import { cacheLesen, cacheSchreiben } from "@/lib/offline/db";
import { RateTierPicker, useLocationRateTiers } from "./rate-tier-chooser";

interface JobOption {
  id: string;
  job_number: number;
  title: string;
  start_date: string | null;
  end_date: string | null;
  location_id: string | null;
}

// Offline-Cache: Auftragsliste + heutige Zuteilungen vom letzten Online-Laden
// (IndexedDB, je Nutzer). Das Uebertragungen-Sheet liest «auftraege_aktiv»
// fuer den Kontext wartender Aktionen.
const CACHE_AUFTRAEGE = "auftraege_aktiv";
const CACHE_HEUTE = "auftraege_heute";

interface ProjectOption {
  id: string;
  project_number: number | null;
  title: string;
  is_member: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Am Handy als Bottom-Sheet (Mobile-Nav). Desktop-Aufrufer lassen es weg. */
  sheet?: boolean;
}

export function StempelModal({ open, onClose, sheet = false }: Props) {
  const supabase = createClient();
  const { clockIn, online } = useStempel();
  const { role, meId } = usePermissions();
  // Bewusst rollen-basiert: Admins haben einen anderen Zeit-Erfassungs-
  // Workflow (Auto-Stempel aus Rapport-Abschluss), nicht weniger Rechte.
  // Kein Permission-Slug — das ist eine Workflow-Weiche, keine Zugriffs-
  // Frage. Falls in Zukunft granularer noetig (z.B. andere Rollen sollen
  // auch auto-gestempelt werden), Permission-Slug einfuehren.
  const isAdmin = role === "admin";
  const [mode, setMode] = useState<"choose" | "job" | "projekt" | "other">("choose");
  const [jobs, setJobs] = useState<JobOption[]>([]);
  // «Heute zugeteilt»: eigene Einsaetze heute (ladeMeineEinsaetze), als
  // erste Eintraege ueber der Suchliste; der laufende/naechste ist vorgewaehlt.
  const [heuteJobs, setHeuteJobs] = useState<JobOption[]>([]);
  const [ladeJobs, setLadeJobs] = useState(false);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [search, setSearch] = useState("");
  const [selectedJob, setSelectedJob] = useState<JobOption | null>(null);
  const [selectedProject, setSelectedProject] = useState<ProjectOption | null>(null);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [hoveredCard, setHoveredCard] = useState<"job" | "projekt" | "other" | null>(null);
  const [pressedCard, setPressedCard] = useState<"job" | "projekt" | "other" | null>(null);
  const [selectedTierId, setSelectedTierId] = useState<string | null>(null);
  // Rate-Tiers werden erst nach Job-Auswahl geladen (haengen an location_id).
  const { tiers, defaultId } = useLocationRateTiers(selectedJob?.location_id ?? null);

  // Vorwahl: solange der Nutzer nichts gewaehlt hat, gilt der Default-Tier.
  // So kann er sofort einstempeln, wenn "Normal" der richtige Modus ist —
  // keine extra Aktion noetig. Abgeleitet statt per Effekt gesetzt; beim
  // Auftragswechsel wird die Wahl zurueckgesetzt (anderer Standort).
  const effectiveTierId = selectedTierId ?? defaultId;

  // Beim Modal-Open: aktive Auftraege laden (offen + anfrage + entwurf —
  // also alles was nicht abgeschlossen oder storniert ist). Ohne Netz aus
  // dem Offline-Cache des letzten Online-Ladens.
  // Zuruecksetzen beim Oeffnen (getrennt vom Laden, damit ein Netzwechsel
  // waehrend des offenen Modals die Auswahl nicht loescht).
  useEffect(() => {
    if (!open) return;
    (async () => {
      setMode("choose");
      setSearch("");
      setSelectedJob(null);
      setSelectedProject(null);
      setDescription("");
      setSelectedTierId(null);
    })();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLadeJobs(true);

      // Ohne Netz: Cache statt Abfrage (Projekte werden nicht gecacht — der
      // Auto-Beitritt braucht ohnehin Netz). «Heute zugeteilt» nur, wenn der
      // Stand von heute ist (Zuerich-Kalendertag).
      if (!online) {
        if (meId) {
          try {
            const [cJobs, cHeute] = await Promise.all([
              cacheLesen<JobOption[]>(meId, CACHE_AUFTRAEGE),
              cacheLesen<JobOption[]>(meId, CACHE_HEUTE),
            ]);
            if (cancelled) return;
            setJobs(cJobs?.data ?? []);
            const heute = cHeute && zuerichTag(cHeute.stand_at) === heuteTag() ? cHeute.data : [];
            setHeuteJobs(heute);
            if (heute.length > 0) setSelectedJob((prev) => prev ?? heute[0]);
          } catch {
            if (!cancelled) toast.error("Offline-Speicher nicht lesbar");
          }
        }
        if (!cancelled) {
          setProjects([]);
          setLadeJobs(false);
        }
        return;
      }

      // Naechste anstehende Auftraege zuerst — sortiert nach start_date
      // aufsteigend (nullsLast), damit der Tech den Auftrag der heute/morgen
      // laeuft direkt oben sieht. Aufträge ohne Datum landen unten.
      // Filter: nur aktive Stati (kein abgeschlossen/storniert) UND nicht
      // soft-deleted.
      const [{ data, error: jobsErr }, heuteRes] = await Promise.all([
        supabase
          .from("jobs")
          .select("id, job_number, title, start_date, end_date, location_id")
          .in("status", [...JOB_STATUS_VORSTUFEN])
          .neq("is_deleted", true)
          .order("start_date", { ascending: true, nullsFirst: false })
          .order("job_number", { ascending: false })
          .limit(50),
        meId
          ? ladeMeineEinsaetze(supabase, meId, heuteTag(), plusTage(heuteTag(), 1)).catch((e: unknown) => {
              toast.error("Heutige Einsätze konnten nicht geladen werden: " + (e instanceof Error ? e.message : String(e)));
              return [];
            })
          : Promise.resolve([]),
      ]);
      if (cancelled) return;
      if (jobsErr) toast.error("Aufträge konnten nicht geladen werden: " + jobsErr.message);
      const geladen = (data as JobOption[]) ?? [];
      setJobs(geladen);

      // Heute zugeteilt: je Auftrag ein Eintrag (mehrere Termine → einer),
      // Reihenfolge nach Einsatzbeginn; der laufende/naechste ist vorgewaehlt.
      const heute: JobOption[] = [];
      const auftragEinsaetze = heuteRes.filter((e) => e.art === "auftrag" && e.job);
      for (const e of auftragEinsaetze) {
        const job = e.job;
        if (!job || heute.some((h) => h.id === job.id)) continue;
        heute.push({
          id: job.id,
          job_number: job.job_number ?? 0,
          title: job.title,
          start_date: e.start,
          end_date: e.ende,
          location_id: job.location_id,
        });
      }
      setHeuteJobs(heute);
      const aktuellJobId = aktuellerEinsatz(auftragEinsaetze)?.job?.id ?? null;
      const vorwahl = (aktuellJobId ? heute.find((h) => h.id === aktuellJobId) : null) ?? heute[0] ?? null;
      if (vorwahl) setSelectedJob((prev) => prev ?? vorwahl);
      setLadeJobs(false);

      if (meId) {
        // Fuer das naechste Mal ohne Netz (und den Kontext im Uebertragungen-Sheet).
        void Promise.all([
          cacheSchreiben(meId, CACHE_AUFTRAEGE, geladen),
          cacheSchreiben(meId, CACHE_HEUTE, heute),
        ]).catch(() => { /* Cache ist Beschleunigung, kein Muss */ });
      }

      // Projekte laden: alle genehmigten sichtbaren; jeder darf sich einloggen.
      // Anders als bei Auftraegen KEINE Zuteilungs-Filterung — Team-Modell.
      const [{ data: projs, error: projErr }, { data: memb }] = await Promise.all([
        supabase.from("projects")
          .select("id, project_number, title")
          .eq("status", "genehmigt")
          .eq("is_deleted", false)
          .order("project_number", { ascending: false })
          .limit(50),
        meId ? supabase.from("project_members").select("project_id").eq("user_id", meId) : Promise.resolve({ data: [] as { project_id: string }[] }),
      ]);
      if (cancelled) return;
      if (projErr) toast.error("Projekte konnten nicht geladen werden: " + projErr.message);
      const memberProjectIds = new Set((memb ?? []).map((m) => m.project_id as string));
      setProjects((projs ?? []).map((p) => ({
        id: p.id as string,
        project_number: p.project_number as number | null,
        title: p.title as string,
        is_member: memberProjectIds.has(p.id as string),
      })));
    })();
    return () => { cancelled = true; };
  }, [open, supabase, meId, online]);

  const heuteIds = new Set(heuteJobs.map((h) => h.id));

  // Suchliste ohne die «Heute zugeteilt»-Eintraege (die stehen darueber).
  const filteredJobs = jobs.filter((j) => {
    if (heuteIds.has(j.id)) return false;
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return (
      j.title.toLowerCase().includes(term) ||
      String(j.job_number).includes(term)
    );
  });

  /** Erfolgs-Toast: direkt am Server oder gespeichert und wartend. */
  function meldeErfolg(res: StempelErgebnis, text: string) {
    if (res.wartet) {
      toast.success(online ? `${text} — wird übertragen` : `${text} — gespeichert, wird gesendet, sobald Netz da ist`);
    } else {
      toast.success(text);
    }
  }

  const filteredProjects = projects.filter((p) => {
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return p.title.toLowerCase().includes(term) || String(p.project_number ?? "").includes(term);
  });

  async function submitJob() {
    // Admins stempeln nicht auf Auftraege — der Auto-Stempel aus dem
    // Rapport-Abschluss legt die Stempelzeiten an. Doppel-Stempelung
    // verhindern.
    if (isAdmin) {
      toast.error("Admins stempeln nicht auf Aufträge — die Stunden werden automatisch aus dem Rapport-Abschluss gestempelt.", { duration: 6000 });
      return;
    }
    if (!selectedJob) {
      toast.error("Bitte einen Auftrag auswählen");
      return;
    }
    // Wenn Tiers existieren, muss einer gewaehlt sein (Default wird
    // auto-preselected — aber falls User bewusst deselektiert hat, blocken).
    if (tiers.length > 1 && !effectiveTierId) {
      toast.error("Bitte den Modus (Normal/Pikett/…) wählen");
      return;
    }
    setSaving(true);
    const res = await clockIn({
      jobId: selectedJob.id,
      description: description || null,
      rateTierId: effectiveTierId,
    });
    setSaving(false);
    if (!res.success) {
      TOAST.stempelError(res.error || "Einstempeln fehlgeschlagen");
      return;
    }
    meldeErfolg(res, `Eingestempelt auf ${formatJobNumber(selectedJob.job_number)}`);
    onClose();
  }

  async function submitProject() {
    if (!selectedProject) {
      toast.error("Bitte ein Projekt auswählen");
      return;
    }
    setSaving(true);
    // Auto-join: wer noch nicht Mitglied ist, wird beim Stempeln in
    // project_members aufgenommen (identisches Verhalten wie im Detail-
    // Seiten-Flow, damit das RLS-Guard „nur Mitglieder duerfen sehen" fuer
    // die Zeit-Ansicht des Projekts sofort greift).
    if (!selectedProject.is_member && meId) {
      const { error: joinError } = await supabase
        .from("project_members")
        .insert({ project_id: selectedProject.id, user_id: meId });
      if (joinError && joinError.code !== "23505") {
        setSaving(false);
        toast.error("Beitritt zum Projekt fehlgeschlagen: " + joinError.message);
        return;
      }
    }
    const res = await clockIn({ projectId: selectedProject.id, description: description || null });
    setSaving(false);
    if (!res.success) {
      TOAST.stempelError(res.error || "Einstempeln fehlgeschlagen");
      return;
    }
    meldeErfolg(res, `Eingestempelt auf ${formatProjectNumber(selectedProject.project_number)}`);
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
    meldeErfolg(res, "Eingestempelt");
    onClose();
  }

  // Ohne Netz: eine Zeile, die sagt, was mit der Aktion passiert.
  const offlineHinweis = !online ? (
    <p className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-amber-800 dark:text-amber-200" style={{ backgroundColor: "rgba(245,158,11,0.14)" }}>
      <CloudOff className="h-4 w-4 shrink-0" />
      Ohne Netz — wird gesendet, sobald Netz da ist
    </p>
  ) : null;

  function jobZeile(job: JobOption) {
    // Datum-Anzeige: jobs.start_date ist timestamptz, also ISO-
    // String — direkt in Date stecken. Single-Day → "12.05.",
    // Range → "12.05.–14.05.". Ohne Daten: dezentes "—".
    const dateLabel = (() => {
      if (!job.start_date) return null;
      const start = new Date(job.start_date);
      if (Number.isNaN(start.getTime())) return null;
      const fmt = new Intl.DateTimeFormat("de-CH", { day: "2-digit", month: "2-digit", timeZone: "Europe/Zurich" });
      const startStr = fmt.format(start);
      if (!job.end_date || job.end_date === job.start_date) return startStr;
      const end = new Date(job.end_date);
      if (Number.isNaN(end.getTime())) return startStr;
      return `${startStr}–${fmt.format(end)}`;
    })();
    return (
      <button
        key={job.id}
        type="button"
        onClick={() => { setSelectedJob(job); setSelectedTierId(null); }}
        className={`w-full flex items-center gap-3 p-3 min-h-[44px] rounded-lg border text-left transition-all duration-150 ${
          selectedJob?.id === job.id
            ? "border-red-300 bg-red-50 dark:bg-red-500/10 dark:border-red-500/40 shadow-sm"
            : "border-border hover:border-foreground/30 hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.06] hover:translate-x-0.5"
        }`}
      >
        <span className="font-mono text-xs font-semibold text-muted-foreground shrink-0">{formatJobNumber(job.job_number)}</span>
        <span className="text-sm truncate flex-1">{job.title}</span>
        {dateLabel ? (
          <span className="text-[11px] font-medium tabular-nums text-muted-foreground shrink-0">{dateLabel}</span>
        ) : (
          <span className="text-[11px] text-muted-foreground/40 shrink-0">—</span>
        )}
      </button>
    );
  }

  return (
    <Modal
      open={open}
      onClose={() => !saving && onClose()}
      title="Einstempeln"
      icon={<Clock className="h-5 w-5 text-teal-500" />}
      size="md"
      closable={!saving}
      sheet={sheet}
    >
      {mode === "choose" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Was machst du jetzt?</p>
          {isAdmin && (
            <div className="flex items-start gap-2 p-3 rounded-lg border border-blue-500/30 bg-blue-500/5 text-xs">
              <Info className="h-4 w-4 text-blue-600 dark:text-blue-300 mt-0.5 shrink-0" />
              <p className="text-foreground/80">
                <span className="font-medium">Auftrag-Stempel ist für Admins deaktiviert.</span>
                {" "}Deine Stunden werden automatisch beim Abschliessen des Rapports gestempelt.
                «Andere Arbeit» geht weiter (z.B. Büro-Zeit).
              </p>
            </div>
          )}
          <button
            type="button"
            onClick={() => isAdmin ? toast.error("Auftrag-Stempel ist für Admins deaktiviert — Stunden kommen aus dem Rapport-Abschluss.", { duration: 6000 }) : setMode("job")}
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
              <p className="text-xs text-muted-foreground">{isAdmin ? "Für Admins deaktiviert — Auto-Stempel aus Rapport" : "Zeit auf einen offenen Auftrag stempeln"}</p>
            </div>
          </button>
          {/* Auf ein Projekt — jeder darf, kein isAdmin-Block. */}
          <button
            type="button"
            onClick={() => setMode("projekt")}
            onMouseEnter={() => setHoveredCard("projekt")}
            onMouseLeave={() => { setHoveredCard(null); setPressedCard(null); }}
            onMouseDown={() => setPressedCard("projekt")}
            onMouseUp={() => setPressedCard(null)}
            className="w-full flex items-center gap-3 p-4 rounded-xl border bg-card text-left"
            style={{
              transform: pressedCard === "projekt" ? "scale(0.99) translateY(0)" : hoveredCard === "projekt" ? "scale(1.01) translateY(-2px)" : "scale(1) translateY(0)",
              transition: "transform 180ms cubic-bezier(0.4,0,0.2,1), box-shadow 180ms, border-color 180ms, background-color 180ms",
              boxShadow: hoveredCard === "projekt" ? "0 8px 20px -6px rgba(16,185,129,0.25)" : "0 1px 2px rgba(0,0,0,0.05)",
              borderColor: hoveredCard === "projekt" ? "rgb(52,211,153)" : "var(--border)",
              backgroundColor: hoveredCard === "projekt" ? "rgba(16,185,129,0.04)" : "var(--card)",
            }}
          >
            <div
              className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0"
              style={{
                transform: hoveredCard === "projekt" ? "scale(1.1) rotate(-4deg)" : "scale(1) rotate(0)",
                transition: "transform 180ms cubic-bezier(0.4,0,0.2,1)",
              }}
            >
              <FolderKanban className="h-5 w-5" />
            </div>
            <div>
              <p className="font-medium text-sm">Auf ein Projekt</p>
              <p className="text-xs text-muted-foreground">Einloggen und Zeit auf ein internes Projekt stempeln</p>
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
            {ladeJobs ? (
              <>
                <Skeleton className="h-11 w-full" />
                <Skeleton className="h-11 w-full" />
                <Skeleton className="h-11 w-full" />
              </>
            ) : (
              <>
                {/* Heute zugeteilt — eigene Einsaetze heute, immer zuoberst
                    (unabhaengig von der Suche); der laufende/naechste ist
                    vorgewaehlt. */}
                {heuteJobs.length > 0 && (
                  <>
                    <p className="px-1 pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Heute zugeteilt</p>
                    {heuteJobs.map(jobZeile)}
                    {filteredJobs.length > 0 && (
                      <p className="px-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Weitere Aufträge</p>
                    )}
                  </>
                )}
                {filteredJobs.length === 0 && heuteJobs.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">
                    {online ? "Keine offenen Aufträge gefunden." : "Ohne Netz keine gespeicherte Auftragsliste — bitte einmal mit Netz öffnen."}
                  </p>
                ) : (
                  filteredJobs.map(jobZeile)
                )}
              </>
            )}
          </div>
          {offlineHinweis}
          {/* Modus-Auswahl — nur wenn Job ausgewaehlt UND Standort >1 Tier
              hat. Standard ist automatisch preselected → 90% der MA muessen
              nichts anklicken. Andere Tiers als grosse Kachel-Buttons. */}
          {selectedJob && tiers.length > 1 && (
            <div className="pt-1">
              <RateTierPicker
                tiers={tiers}
                value={effectiveTierId}
                onChange={setSelectedTierId}
              />
            </div>
          )}
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
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {saving ? "Stempelt…" : "Einstempeln"}
            </button>
          </div>
        </div>
      )}

      {mode === "projekt" && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Wähle ein Projekt. Wenn du noch nicht eingeloggt bist, wirst du beim Stempeln automatisch beigetreten.
          </p>
          <Input
            placeholder="Projekt suchen (Nummer oder Titel)…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <div className="max-h-64 overflow-y-auto space-y-1">
            {filteredProjects.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                {online ? "Keine genehmigten Projekte gefunden." : "Projekte sind ohne Netz nicht verfügbar."}
              </p>
            ) : (
              filteredProjects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedProject(p)}
                  className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-all duration-150 ${
                    selectedProject?.id === p.id
                      ? "border-emerald-300 bg-emerald-50 dark:bg-emerald-500/10 dark:border-emerald-500/40 shadow-sm"
                      : "border-border hover:border-emerald-300 hover:bg-emerald-50/40 dark:hover:bg-emerald-500/10"
                  }`}
                >
                  <FolderKanban className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <span className="font-mono text-xs font-semibold text-muted-foreground shrink-0">{formatProjectNumber(p.project_number)}</span>
                  <span className="text-sm truncate flex-1">{p.title}</span>
                  {p.is_member ? (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-300 shrink-0">
                      <CheckCircle2 className="h-3 w-3" /> eingeloggt
                    </span>
                  ) : (
                    <span className="text-[10px] font-medium text-muted-foreground shrink-0">Auto-Beitritt</span>
                  )}
                </button>
              ))
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
              onClick={submitProject}
              disabled={saving || !selectedProject}
              className="kasten kasten-green flex-1"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
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
          {offlineHinweis}
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={() => setMode("choose")} className="kasten kasten-muted flex-1">Zurück</button>
            <button
              type="button"
              onClick={submitOther}
              disabled={saving || !description.trim()}
              className="kasten kasten-red flex-1"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {saving ? "Stempelt…" : "Einstempeln"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
