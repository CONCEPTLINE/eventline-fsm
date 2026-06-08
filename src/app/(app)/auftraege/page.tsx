"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { JOB_STATUS, REQUEST_STEPS, REQUEST_MAIL_STEPS } from "@/lib/constants";
import type { JobStatus, Profile, JobWithRelations } from "@/types";
import Link from "next/link";
import { RequestStepTracker } from "@/components/request-step-tracker";
import {
  Plus,
  Search,
  ClipboardList,
  CalendarPlus,
  AlertCircle,
  Archive,
  X,
  Pencil,
  Check,
  Send,
  ChevronDown,
  ExternalLink,
  UserPlus,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

// Kleinere Page-Size = "Mehr laden" wird sichtbar, schnellerer initial-Load.
// Beide Listen jetzt server-seitig nach start_date sortiert damit Pagination
// bei wachsendem Datenvolumen die Datums-Reihenfolge nicht durcheinanderbringt.
const ARCHIVE_PAGE_SIZE = 30;
const ACTIVE_PAGE_SIZE = 30;
// Location wird mit dem Verwaltungs-Kunden gejoint, sodass Standort-Auftraege
// (jobs.customer_id = null) trotzdem einen Kundennamen anzeigen koennen.
// Room wird ebenfalls gejoint fuer extern-Auftraege mit bekanntem Raum.
const JOBS_SELECT = "*, customer:customers(name, email), location:locations(name, customer:customers(id, name)), room:rooms(id, name), project_lead_id, assignments:job_assignments(profile_id), appointments:job_appointments(id, start_time, assigned_to)";
import { useRouter } from "next/navigation";
import { SearchableSelect } from "@/components/searchable-select";
import { JobNumber } from "@/components/job-number";
import { DonutChart } from "@/components/donut-chart";
import { SendStepModal } from "@/components/send-step-modal";
import { toast } from "sonner";
import { usePermissions } from "@/lib/use-permissions";
import { TOAST } from "@/lib/messages";

type DonutCounts = {
  anfrage: number;
  offen: number;
  offenVermietung: number;
  abgeschlossen: number;
  storniert: number;
  entwurf: number;
};

const EMPTY_COUNTS: DonutCounts = {
  anfrage: 0,
  offen: 0,
  offenVermietung: 0,
  abgeschlossen: 0,
  storniert: 0,
  entwurf: 0,
};

export default function AuftraegePage() {
  const { can } = usePermissions();
  // Active + Archive: beide cursor-paginiert. Active war frueher voll geladen
  // mit limit(500) als Sicherung — bei Wachstum in Eventline-Skala braucht es
  // echte Pagination, sonst werden initial 5MB+ geladen sobald die Liste
  // dichter wird. Die Donut-Counts kommen unabhaengig aus auftraege_counts
  // (View) — der angezeigte/geladene Subset bleibt also stets vergleichbar
  // mit dem Total.
  const [activeJobs, setActiveJobs] = useState<JobWithRelations[]>([]);
  const [activeHasMore, setActiveHasMore] = useState(false);
  const [activeLoadingMore, setActiveLoadingMore] = useState(false);
  const [archiveJobs, setArchiveJobs] = useState<JobWithRelations[]>([]);
  const [archiveHasMore, setArchiveHasMore] = useState(false);
  const [archiveLoadingMore, setArchiveLoadingMore] = useState(false);
  // Counts kommen ausschliesslich aus der DB — entkoppelt vom geladenen State,
  // damit der Donut auch bei paginierter Archive-Liste korrekt bleibt.
  const [counts, setCounts] = useState<DonutCounts>(EMPTY_COUNTS);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [searchNumber, setSearchNumber] = useState(() => typeof window !== "undefined" ? localStorage.getItem("auftraege-search-number") || "" : "");
  const [searchTitle, setSearchTitle] = useState(() => typeof window !== "undefined" ? localStorage.getItem("auftraege-search-title") || "" : "");
  const [filterStatus, setFilterStatus] = useState<JobStatus | "all">(() => typeof window !== "undefined" ? (localStorage.getItem("auftraege-status") as JobStatus | "all") || "all" : "all");
  const [filterLocation, setFilterLocation] = useState<"all" | "scala" | "barakuba" | "bau3" | "sonstige">(() => typeof window !== "undefined" ? (localStorage.getItem("auftraege-location") as "all" | "scala" | "barakuba" | "bau3" | "sonstige" | null) || "all" : "all");
  const [showArchive, setShowArchive] = useState(() => typeof window !== "undefined" ? localStorage.getItem("auftraege-archive") === "true" : false);
  const [loading, setLoading] = useState(true);
  // Inline-Step-Aktion: welche Anfrage-Karte hat aktuell das Mail-Modal offen?
  const [activeStepJobId, setActiveStepJobId] = useState<string | null>(null);
  // Doppelklick-Schutz: schneller Re-Klick auf "Naechster Schritt" sonst
  // zwei parallele UPDATEs gegen die jobs-Row, dazwischen Realtime-Refresh
  // mit unklarer Endposition. Disabled solange der eine Call lauft.
  const [advancingId, setAdvancingId] = useState<string | null>(null);
  const supabase = createClient();
  const router = useRouter();

  // Race-Guard fuer Archive-Queries (alte Antworten verwerfen, wenn neuere unterwegs sind)
  const archiveQueryIdRef = useRef(0);
  // Debounce-Timer fuer Suche (Tippen feuert nicht jede Query sofort)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Filter in localStorage speichern
  useEffect(() => { if (typeof window !== "undefined") localStorage.setItem("auftraege-search-number", searchNumber); }, [searchNumber]);
  useEffect(() => { if (typeof window !== "undefined") localStorage.setItem("auftraege-search-title", searchTitle); }, [searchTitle]);
  useEffect(() => { if (typeof window !== "undefined") localStorage.setItem("auftraege-status", filterStatus); }, [filterStatus]);
  useEffect(() => { if (typeof window !== "undefined") localStorage.setItem("auftraege-location", filterLocation); }, [filterLocation]);
  useEffect(() => { if (typeof window !== "undefined") localStorage.setItem("auftraege-archive", String(showArchive)); }, [showArchive]);

  // Active + Counts + Profiles: filter-unabhaengig, wird bei Mount und Invalidate geladen.
  // Archive: filter-abhaengig, eigener Effect mit Debounce (siehe weiter unten).
  useEffect(() => {
    loadActiveAndCounts();
    const handler = () => {
      loadActiveAndCounts();
      // Bei Datenaenderung im Archive-Modus auch die Archive-Liste neu ziehen.
      if (showArchive) reloadArchive();
    };
    window.addEventListener("jobs:invalidate", handler);
    return () => window.removeEventListener("jobs:invalidate", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchive]);

  // Step-Advance fuer eine Anfrage. Bei Mail-Schritten oeffnet das Modal das selber.
  // Bei Warte-Schritten (2, 4) direkter UPDATE.
  // Nach Schritt 4 (Angebot bestaetigt) -> direkt umwandeln in Auftrag
  // (status='offen', kein Entwurf-Zwischenschritt). was_anfrage bleibt true.
  async function advanceAnfrageStep(jobId: string) {
    if (advancingId) return; // bereits ein Advance im Flug
    const job = activeJobs.find((j) => j.id === jobId);
    if (!job?.request_step) return;
    setAdvancingId(jobId);
    try {
      const nextStep = job.request_step + 1;
      if (nextStep > 4) {
        // Schritt 4 erledigt -> Vermietentwurf -> Auftrag (offen)
        const { error } = await supabase
          .from("jobs")
          .update({ status: "offen", request_step: null })
          .eq("id", jobId);
        if (error) {
          TOAST.supabaseError(error);
          return;
        }
        toast.success("Vermietentwurf in Auftrag umgewandelt");
        window.dispatchEvent(new Event("jobs:invalidate"));
        return;
      }
      const { error } = await supabase
        .from("jobs")
        .update({ request_step: nextStep })
        .eq("id", jobId);
      if (error) {
        TOAST.supabaseError(error);
        return;
      }
      toast.success(REQUEST_STEPS[nextStep - 1].label);
      window.dispatchEvent(new Event("jobs:invalidate"));
    } finally {
      setAdvancingId(null);
    }
  }

  async function handleAnfrageNext(jobId: string) {
    const job = activeJobs.find((j) => j.id === jobId);
    if (!job?.request_step) return;
    if (REQUEST_MAIL_STEPS.has(job.request_step)) {
      setActiveStepJobId(jobId);
      return;
    }
    await advanceAnfrageStep(jobId);
  }

  // Counts kommen aus 6 parallelen Count-Queries (head:true, kein Datenbody).
  // Damit ist der Donut entkoppelt vom geladenen State und auch bei paginierter
  // Archive-Liste korrekt — und skaliert auf beliebig viele Jobs in der DB.
  // Counts kommen aus der DB-View `auftraege_counts` — ein einziger
  // Round-Trip mit count(*) filter (...) statt 6 parallelen HEAD-Queries.
  // Definition: supabase/migrations/040_auftraege_counts_view.sql.
  async function loadCounts(): Promise<DonutCounts> {
    const { data } = await supabase.from("auftraege_counts").select("*").single();
    return {
      anfrage: data?.anfrage ?? 0,
      offen: data?.offen ?? 0,
      offenVermietung: data?.offen_vermietung ?? 0,
      abgeschlossen: data?.abgeschlossen ?? 0,
      storniert: data?.storniert ?? 0,
      entwurf: data?.entwurf ?? 0,
    };
  }

  // Active-Query: cursor-basiert auf start_date ASC (älteste/heute zuerst,
  // dann weiter in die Zukunft). Composite cursor (start_date, id) gegen
  // doppelte Datums-Werte. ACTIVE_PAGE_SIZE+1 fuer hasMore via n+1-Trick.
  const buildActiveQuery = useCallback((cursor: { start_date: string | null; id: string } | null) => {
    const cancelledFilter = "cancelled_as_anfrage.is.null,cancelled_as_anfrage.eq.false";
    let q = supabase
      .from("jobs")
      .select(JOBS_SELECT)
      .neq("is_deleted", true)
      .or(cancelledFilter)
      // partner_entwurf raus: Partner-Entwuerfe (vor dem Absenden) gehoeren
      // nur ins Partnerportal — EVENTLINE sieht sie erst wenn der Partner
      // den Status zu partner_anfrage promoted.
      .not("status", "in", '("abgeschlossen","storniert","partner_entwurf")');
    if (cursor !== null) {
      // Composite-cursor: (start_date > c.start) OR (start_date = c.start AND id > c.id).
      // start_date null = Entwuerfe ohne Datum — kommen zuletzt (NULLS LAST).
      if (cursor.start_date) {
        q = q.or(`start_date.gt.${cursor.start_date},and(start_date.eq.${cursor.start_date},id.gt.${cursor.id})`);
      } else {
        q = q.is("start_date", null).gt("id", cursor.id);
      }
    }
    return q
      .order("start_date", { ascending: true, nullsFirst: false })
      .order("id", { ascending: true })
      .limit(ACTIVE_PAGE_SIZE + 1);
  }, [supabase]);

  async function loadActiveAndCounts() {
    const [activeRes, profRes, freshCounts] = await Promise.all([
      buildActiveQuery(null),
      supabase.rpc("get_assignable_users"),
      loadCounts(),
    ]);
    if (activeRes.data) {
      const rows = activeRes.data as unknown as JobWithRelations[];
      setActiveHasMore(rows.length > ACTIVE_PAGE_SIZE);
      setActiveJobs(rows.slice(0, ACTIVE_PAGE_SIZE));
    }
    if (profRes.data) setProfiles(profRes.data as Profile[]);
    setCounts(freshCounts);
    setLoading(false);
  }

  async function loadActiveMore() {
    if (activeLoadingMore || activeJobs.length === 0) return;
    setActiveLoadingMore(true);
    const last = activeJobs[activeJobs.length - 1];
    const { data } = await buildActiveQuery({ start_date: last.start_date, id: last.id });
    if (data) {
      const rows = data as unknown as JobWithRelations[];
      setActiveHasMore(rows.length > ACTIVE_PAGE_SIZE);
      setActiveJobs((prev) => [...prev, ...rows.slice(0, ACTIVE_PAGE_SIZE)]);
    }
    setActiveLoadingMore(false);
  }

  // Archive-Query mit Filtern: status, title, exakte Nummer — alles server-seitig.
  // Location bleibt client-seitig (joined-table-Filter wuerde die Datenform aendern).
  // job_number ist Integer — partial-Match nicht via PostgREST moeglich, daher
  // nur bei vollstaendiger Eingabe (6 Ziffern) als exact-Filter.
  // Sort: start_date DESC (juengste-past zuerst), composite cursor (start_date, id).
  const buildArchiveQuery = useCallback((cursor: { start_date: string | null; id: string } | null) => {
    const cancelledFilter = "cancelled_as_anfrage.is.null,cancelled_as_anfrage.eq.false";
    let q = supabase
      .from("jobs")
      .select(JOBS_SELECT)
      .neq("is_deleted", true)
      .or(cancelledFilter);

    if (filterStatus === "abgeschlossen" || filterStatus === "storniert") {
      q = q.eq("status", filterStatus);
    } else {
      q = q.in("status", ["abgeschlossen", "storniert"]);
    }

    const titleQ = searchTitle.trim();
    if (titleQ) q = q.ilike("title", `%${titleQ}%`);

    const numQ = searchNumber.trim();
    if (numQ.length === 6 && /^\d+$/.test(numQ)) {
      q = q.eq("job_number", parseInt(numQ, 10));
    }

    if (cursor !== null) {
      if (cursor.start_date) {
        q = q.or(`start_date.lt.${cursor.start_date},and(start_date.eq.${cursor.start_date},id.gt.${cursor.id})`);
      } else {
        q = q.is("start_date", null).gt("id", cursor.id);
      }
    }
    return q
      .order("start_date", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .limit(ARCHIVE_PAGE_SIZE + 1);
  }, [supabase, filterStatus, searchTitle, searchNumber]);

  const reloadArchive = useCallback(async () => {
    const myId = ++archiveQueryIdRef.current;
    const { data } = await buildArchiveQuery(null);
    if (myId !== archiveQueryIdRef.current) return; // ueberholt — verwerfen
    if (data) {
      const rows = data as unknown as JobWithRelations[];
      setArchiveHasMore(rows.length > ARCHIVE_PAGE_SIZE);
      setArchiveJobs(rows.slice(0, ARCHIVE_PAGE_SIZE));
    }
  }, [buildArchiveQuery]);

  // Archive: erst-laden bei Mount/Modus-Wechsel; bei Filter/Suche-Aenderung
  // mit 250ms Debounce neu ziehen (nicht jeden Tastenanschlag).
  // Auch in der Aktiv-Ansicht laden wenn Such-Term getippt wurde — dann
  // werden archivierte Auftraege im Resultat mitgemixt damit man sie nicht
  // verpasst (Leo-Anfrage 2026-05-06).
  const hasSearchTerm = searchTitle.trim().length > 0 || searchNumber.trim().length > 0;
  useEffect(() => {
    if (!showArchive && !hasSearchTerm) return;
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => { reloadArchive(); }, 250);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [showArchive, hasSearchTerm, reloadArchive]);

  async function loadArchiveMore() {
    if (archiveLoadingMore || archiveJobs.length === 0) return;
    setArchiveLoadingMore(true);
    const last = archiveJobs[archiveJobs.length - 1];
    const { data } = await buildArchiveQuery({ start_date: last.start_date, id: last.id });
    if (data) {
      const rows = data as unknown as JobWithRelations[];
      setArchiveHasMore(rows.length > ARCHIVE_PAGE_SIZE);
      setArchiveJobs((prev) => [...prev, ...rows.slice(0, ARCHIVE_PAGE_SIZE)]);
    }
    setArchiveLoadingMore(false);
  }

  // Anfang von heute (00:00) - Aufträge die heute stattfinden zählen noch als "kommend"
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  // Quelle haengt vom Modus ab — Active ist voll geladen, Archive ist paginiert.
  // Wenn ein Such-Term aktiv ist, mixen wir auch im Aktiv-Modus die archivierten
  // Auftraege rein damit der User nicht aktiv vs archiv toggeln muss.
  const sourceJobs = showArchive
    ? archiveJobs
    : hasSearchTerm
      ? [...activeJobs, ...archiveJobs.filter((a) => !activeJobs.some((b) => b.id === a.id))]
      : activeJobs;
  const totalForSource = showArchive ? counts.abgeschlossen + counts.storniert : counts.anfrage + counts.offen + counts.entwurf;
  const filtered = sourceJobs.filter((j) => {
    const numQ = searchNumber.trim();
    const titleQ = searchTitle.trim().toLowerCase();
    const matchesNumber = !numQ ? true : String(j.job_number ?? "").includes(numQ);
    const matchesTitle = !titleQ ? true : j.title.toLowerCase().includes(titleQ);
    const matchesSearch = matchesNumber && matchesTitle;
    const matchesStatus = filterStatus === "all" || j.status === filterStatus;
    const locName = (j.location?.name || "").toLowerCase();
    const isScala = locName.includes("scala");
    const isBarakuba = locName.includes("barakuba");
    const isBau3 = locName.includes("bau3");
    let matchesLocation = true;
    if (filterLocation === "scala") matchesLocation = isScala;
    else if (filterLocation === "barakuba") matchesLocation = isBarakuba;
    else if (filterLocation === "bau3") matchesLocation = isBau3;
    else if (filterLocation === "sonstige") matchesLocation = !isScala && !isBarakuba && !isBau3;
    return matchesSearch && matchesStatus && matchesLocation;
  }).sort((a, b) => {
    // Referenz-Datum: wenn Enddatum vorhanden, nutze das (damit mehrtägige Events heute noch als kommend gelten)
    const aRef = a.end_date ? new Date(a.end_date).getTime() : a.start_date ? new Date(a.start_date).getTime() : Infinity;
    const bRef = b.end_date ? new Date(b.end_date).getTime() : b.start_date ? new Date(b.start_date).getTime() : Infinity;
    const aPast = aRef < todayMs;
    const bPast = bRef < todayMs;
    if (aPast && !bPast) return 1;
    if (!aPast && bPast) return -1;
    const aSort = a.start_date ? new Date(a.start_date).getTime() : Infinity;
    const bSort = b.start_date ? new Date(b.start_date).getTime() : Infinity;
    if (!aPast && !bPast) return aSort - bSort;
    return bSort - aSort;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3 min-h-9">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{showArchive ? "Operations Archiv" : "Operations"}</h1>
          {/* Leerer Subtitle-Platzhalter — sorgt dafuer dass die Header-Hoehe
              identisch zu /kunden etc. ist, sodass die Action-Buttons rechts
              auf gleicher Linie sitzen wie auf den anderen Seiten. */}
          <p className="text-sm text-muted-foreground mt-1" aria-hidden="true">&nbsp;</p>
        </div>
        {/* Action-Buttons: auf Mobile Icon-only fuer die "+ Neu"-Aktionen
            damit alle drei Buttons in eine Zeile passen. Desktop bleibt
            beschriftet. Archiv hat seinen Count im Label, auch auf Mobile
            sichtbar. */}
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setShowArchive(!showArchive)} className={showArchive ? "kasten-active" : "kasten-toggle-off"}>
            <Archive className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{showArchive ? "Aktive anzeigen" : `Archiv (${counts.abgeschlossen + counts.storniert})`}</span>
            <span className="sm:hidden">{showArchive ? "Aktiv" : `Archiv (${counts.abgeschlossen + counts.storniert})`}</span>
          </button>
          {!showArchive && can("auftraege:create") && (
            <>
              <Link href="/auftraege/vermietentwurf/neu" className="kasten kasten-purple" data-tooltip="Neuer Vermietentwurf">
                <Plus className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Neuer Vermietentwurf</span>
                <span className="sm:hidden">Vermietung</span>
              </Link>
              <Link href="/auftraege/neu" className="kasten kasten-red" data-tooltip="Neuer Auftrag">
                <Plus className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Neuer Auftrag</span>
                <span className="sm:hidden">Auftrag</span>
              </Link>
            </>
          )}
        </div>
      </div>

      {/* Kreis-Diagramm — nur in der Aktiv-Ansicht. Im Archiv-Modus
          waere es nur "Abgeschlossen + Storniert"-Aufteilung, die ist
          in der Liste eh sichtbar (Status-Tag pro Card). Counts kommen
          aus DB-Count-Queries (entkoppelt vom geladenen State). */}
      {!showArchive && (counts.anfrage + counts.offen + counts.abgeschlossen + counts.storniert + counts.entwurf) > 0 && (() => {
        // Drafts gemeinsam: Vermietentwuerfe (anfrage) + Auftrag-Entwuerfe (entwurf)
        // gelten app-weit als WIP/lila und zaehlen als eigenes Donut-Segment.
        const draftCount = counts.anfrage + counts.entwurf;
        const segments = [
          {
            label: "Bevorstehend",
            count: counts.offen,
            color: "var(--status-gray)",
            // Untersegment: Aufträge die aus einer Vermietung kommen — hellblau,
            // sitzt als schmalerer Innenring innerhalb des Bevorstehend-Segments.
            sub: {
              label: "Vermietung",
              count: counts.offenVermietung,
              color: "#38bdf8",
            },
          },
          { label: "Entwürfe", count: draftCount, color: "var(--status-purple)" },
          { label: "Abgeschlossen", count: counts.abgeschlossen, color: "var(--status-green)" },
          { label: "Storniert", count: counts.storniert, color: "var(--status-red)" },
        ];
        return (
          // Auf Mobile ausgeblendet — Diagramm braucht zu viel Platz auf
          // kleinen Screens, die Status-Tags pro Card geben dieselbe Info.
          <div className="hidden md:block">
            <DonutChart
              segments={segments}
              centerLabel="Aufträge"
              emptyMessage="Keine Aufträge vorhanden."
            />
          </div>
        );
      })()}

      {/* Such- und Filter-Bar — kompakt, getrennte Felder fuer Nummer und Titel */}
      <div className="flex flex-col sm:flex-row gap-2">
        {/* Suche Nummer */}
        <div className="relative w-full sm:w-44">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-mono text-muted-foreground/60 pointer-events-none">
            INT-
          </span>
          <Input
            placeholder="000000"
            value={searchNumber}
            onChange={(e) => setSearchNumber(e.target.value.replace(/\D/g, ""))}
            inputMode="numeric"
            pattern="[0-9]*"
            className="pl-[3rem] h-9 font-mono"
            aria-label="Auftragsnummer"
          />
        </div>

        {/* Suche Titel */}
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Titel suchen…"
            value={searchTitle}
            onChange={(e) => setSearchTitle(e.target.value)}
            className="pl-9 h-9"
            aria-label="Titel"
          />
        </div>

        {/* Status-Filter */}
        <div className="w-full sm:w-44">
          <SearchableSelect
            value={filterStatus}
            onChange={(v) => setFilterStatus(v as JobStatus | "all")}
            items={[
              { id: "all", label: "Alle Status" },
              ...(Object.keys(JOB_STATUS) as JobStatus[]).map((s) => ({
                id: s,
                label: JOB_STATUS[s].label,
              })),
            ]}
            searchable={false}
            clearable={false}
            active={filterStatus !== "all"}
          />
        </div>

        {/* Location-Filter */}
        <div className="w-full sm:w-44">
          <SearchableSelect
            value={filterLocation}
            onChange={(v) =>
              setFilterLocation(
                v as "all" | "scala" | "barakuba" | "bau3" | "sonstige"
              )
            }
            items={[
              { id: "all", label: "Alle Locations" },
              { id: "scala", label: "SCALA Basel" },
              { id: "barakuba", label: "Barakuba" },
              { id: "bau3", label: "Theater BAU3" },
              { id: "sonstige", label: "Sonstige" },
            ]}
            searchable={false}
            clearable={false}
            active={filterLocation !== "all"}
          />
        </div>

        {/* Reset (nur wenn ein Filter aktiv) */}
        {(searchNumber || searchTitle || filterStatus !== "all" || filterLocation !== "all") && (
          <button
            type="button"
            onClick={() => {
              setSearchNumber("");
              setSearchTitle("");
              setFilterStatus("all");
              setFilterLocation("all");
            }}
            className="h-9 px-3 text-xs text-muted-foreground hover:text-foreground rounded-lg flex items-center gap-1.5 transition-colors"
            data-tooltip="Alle Filter zurücksetzen"
          >
            <X className="h-3.5 w-3.5" />
            Reset
          </button>
        )}
      </div>

      {/* Job List */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse bg-card">
              <CardContent className="p-5">
                <div className="h-5 bg-foreground/10 dark:bg-foreground/15 rounded w-1/2 mb-3" />
                <div className="h-4 bg-foreground/[0.06] dark:bg-foreground/10 rounded w-1/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        (() => {
          const hasFilter = !!searchNumber || !!searchTitle || filterStatus !== "all" || filterLocation !== "all";
          return (
            <Card className="border-dashed bg-card">
              <CardContent className="py-16 text-center">
                <div className="mx-auto w-14 h-14 rounded-2xl bg-gray-100 flex items-center justify-center mb-4">
                  <ClipboardList className="h-7 w-7 text-gray-400" />
                </div>
                <h3 className="font-semibold text-gray-900 text-lg">
                  {hasFilter ? "Keine Ergebnisse mit diesen Filtern" : "Noch keine Aufträge"}
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  {hasFilter
                    ? `${totalForSource} Auftrag${totalForSource === 1 ? "" : "e"} insgesamt — passt nichts auf deine Filter.`
                    : "Erstelle deinen ersten Auftrag."}
                </p>
                {hasFilter ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchNumber("");
                      setSearchTitle("");
                      setFilterStatus("all");
                      setFilterLocation("all");
                    }}
                    className="kasten kasten-muted mt-5"
                  >
                    Filter zurücksetzen
                  </button>
                ) : (
                  <div className="mt-5 flex items-center justify-center gap-2 flex-wrap">
                    <Link href="/auftraege/vermietentwurf/neu" className="kasten kasten-purple">
                      <Plus className="h-3.5 w-3.5" />
                      Neuer Vermietentwurf
                    </Link>
                    <Link href="/auftraege/neu" className="kasten kasten-red">
                      <Plus className="h-3.5 w-3.5" />
                      Neuer Auftrag
                    </Link>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })()
      ) : (
        <div className="space-y-1.5">
          {filtered.map((job) => {
            const appointments = job.appointments ?? null;
            const hasAppointment = !!(appointments && appointments.length > 0);
            // Zugewiesen = irgendein Termin hat einen assigned_to. Bei
            // Partner-Anfragen die akzeptiert wurden gibt's anfangs einen
            // Termin OHNE Zuweisung — Team-Lead muss erst einen Mitarbeiter
            // zuteilen bevor's als "alles bereit" zaehlt.
            const hasAssignedAppointment = !!(appointments && appointments.some((a) => a.assigned_to));
            const isActive = !["abgeschlossen", "storniert"].includes(job.status);
            const isAnfrage = job.status === "anfrage";
            // Kunde-Fallback: Standort-Auftraege haben jobs.customer_id = NULL,
            // weil der Kunde implizit der Verwaltungs-Kunde des Standorts ist.
            const displayCustomerName = job.customer?.name ?? job.location?.customer?.name ?? null;
            const placeLabel = job.location?.name ?? job.room?.name ?? job.external_address ?? null;
            const currentStep = Math.min(Math.max(job.request_step ?? 1, 1), REQUEST_STEPS.length);
            const stepInfo = REQUEST_STEPS[currentStep - 1];
            const isMailStep = REQUEST_MAIL_STEPS.has(currentStep);
            const noTermin = isActive && !hasAppointment && job.status !== "entwurf" && !isAnfrage;
            const terminUnassigned = isActive && hasAppointment && !hasAssignedAppointment && job.status !== "entwurf" && !isAnfrage;
            const allGood = isActive && hasAppointment && hasAssignedAppointment && job.status !== "entwurf" && !isAnfrage;
            const detailHref = isAnfrage ? `/auftraege/vermietentwurf/${job.id}` : `/auftraege/${job.id}`;
            const dateText = job.start_date
              ? new Date(job.start_date).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })
                + (job.end_date && job.end_date !== job.start_date ? " – " + new Date(job.end_date).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" }) : "")
              : "";

            // Action-Icon-Logik: kleines Icon in der Compact-Zeile.
            // Volle Action-Behandlung (Send-Modal, Bearbeiten-Page, Termin-Plan)
            // bleibt identisch zum vorherigen Verhalten.
            function renderActionIcon(size: "sm") {
              const iconCls = size === "sm" ? "h-4 w-4" : "h-5 w-5";
              const padCls = size === "sm" ? "p-1.5" : "p-2.5";
              if (isAnfrage) {
                if (isMailStep) return (
                  <button type="button"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleAnfrageNext(job.id); }}
                    disabled={advancingId === job.id}
                    className={`${padCls} rounded-lg text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-500/20 transition-colors disabled:opacity-40 disabled:pointer-events-none`}
                    aria-label={stepInfo.label}
                  >
                    <Send className={iconCls} />
                  </button>
                );
                return null;
              }
              if (job.status === "entwurf") return (
                <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); router.push(`/auftraege/${job.id}/bearbeiten`); }}
                  className={`${padCls} rounded-lg text-purple-600 dark:text-purple-400 hover:bg-purple-100 dark:hover:bg-purple-500/20 transition-colors`} aria-label="Bearbeiten">
                  <Pencil className={iconCls} />
                </button>
              );
              if (noTermin) return (
                <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); router.push(`/auftraege/${job.id}?termin=neu`); }}
                  className={`${padCls} rounded-lg text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-500/20 transition-colors`} aria-label="Termin planen">
                  <CalendarPlus className={iconCls} />
                </button>
              );
              if (terminUnassigned) return (
                <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); router.push(`/auftraege/${job.id}#termin-form`); }}
                  className={`${padCls} rounded-lg text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-500/20 transition-colors`} aria-label="Termin zuweisen">
                  <UserPlus className={iconCls} />
                </button>
              );
              if (allGood) return (
                <span className={`${padCls} rounded-lg text-emerald-600 dark:text-emerald-400 inline-flex`} aria-label="Alles bereit">
                  <Check className={iconCls} strokeWidth={3} />
                </span>
              );
              return null;
            }


            return (
            <Link key={job.id} href={detailHref} className="block group">
              <Card className={`auftrag-card-hover relative bg-card cursor-pointer ${
                job.status === "entwurf" ? "border-dashed opacity-80" : ""
              }`}>
                {/* Mobile-Variante: 2-Zeilen-Stack damit nichts horizontal
                    rausragt. Zeile 1: Nr | Titel | Action-Icon.
                    Zeile 2: Kunde · Datum + Status-Tags + ggf. Rechnungs-Pille
                    + Step-Tracker. */}
                <div className="md:hidden px-3 py-2.5 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <JobNumber number={job.job_number} />
                    <span className="auftrag-card-title font-medium text-sm truncate transition-colors flex-1 min-w-0">{job.title}</span>
                    <div className="shrink-0">{renderActionIcon("sm")}</div>
                  </div>
                  <div className="flex items-center justify-between gap-2 flex-wrap text-xs">
                    <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                      <span className="text-muted-foreground truncate">{displayCustomerName ?? "—"}</span>
                      {dateText && <span className="text-muted-foreground/70 text-[11px] whitespace-nowrap">{dateText}</span>}
                    </div>
                    <div className={`flex items-center gap-1 flex-wrap shrink-0 ${showArchive ? "grayscale opacity-60" : ""}`}>
                      {job.priority === "dringend" && isActive && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0 text-[10px] font-semibold rounded-full bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300">
                          <AlertCircle className="h-2.5 w-2.5" />
                        </span>
                      )}
                      {job.status !== "offen" && JOB_STATUS[job.status] && (
                        <span className={`inline-flex px-1.5 py-0 text-[10px] font-medium rounded-full ${JOB_STATUS[job.status].color}`}>
                          {JOB_STATUS[job.status].label}
                        </span>
                      )}
                      {job.was_anfrage && job.status !== "anfrage" && (
                        <span className="inline-flex px-1.5 py-0 text-[10px] font-medium rounded-full bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">
                          Vermietung
                        </span>
                      )}
                      {job.invoiced_at && job.invoice_number && (
                        <span className="inline-flex items-center gap-0.5 font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded text-[rgb(132,152,0)] dark:text-[rgb(196,214,0)] bg-[rgba(196,214,0,0.12)]">
                          RE {job.invoice_number}
                        </span>
                      )}
                    </div>
                  </div>
                  {isAnfrage && (
                    <div className="flex justify-end mt-0.5">
                      <RequestStepTracker currentStep={currentStep} size="sm" />
                    </div>
                  )}
                </div>

                {/* Desktop Drei-Zonen-Layout (wie Leo's Skizze):
                    LINKS  : Nr + Title eng zusammen
                    MITTE  : Kunde Ort Datum Status, gruppiert
                    RECHTS : Rechnungs-Pille / Aktion */}
                <div
                  className="hidden md:grid px-4 py-2 items-center gap-x-3"
                  // Adaptive Spalten via minmax(min, max): jede Spalte hat
                  // ein Min (Inhalt MUSS hineinpassen, sonst wird abgeschnitten)
                  // und ein Max (kein unnoetiges Auseinanderziehen). Bei
                  // engem Viewport schrumpfen die Spalten auf ihr Minimum,
                  // bei breitem Viewport waechsen sie bis zum Maximum.
                  //
                  // Cross-Card-Alignment funktioniert weil alle Cards dieselbe
                  // Container-Breite und denselben Template-String haben —
                  // CSS Grid resolved die Spalten daher in jeder Card identisch.
                  //
                  // Ort/Standort-Spalte raus (Leo: "vollgestopft" — Datum
                  // + Kunde reicht, Standort steht eh im Detail-View).
                  // Min-Summe: 80+140+0+100+110+90+0+120 = 640px + 7*12 (gap) = 724
                  // -> fits locker ab Card-Inner-Breite ~750px (Browser ~1050px).
                  style={{ gridTemplateColumns: "minmax(80px, 92px) minmax(140px, 260px) minmax(0, 1fr) minmax(100px, 150px) minmax(110px, 150px) minmax(90px, 130px) minmax(0, 1fr) minmax(120px, 170px)" }}
                >
                  {/* LINKS — Col 1: Nr-Badge */}
                  <JobNumber number={job.job_number} />

                  {/* LINKS — Col 2: Titel (fixed width, truncate) */}
                  <span className="auftrag-card-title font-medium text-sm truncate transition-colors min-w-0">{job.title}</span>

                  {/* Col 3: Spacer (1fr) — leer */}
                  <div />

                  {/* MITTE — Col 4: Kunde */}
                  <span className="text-xs text-muted-foreground truncate">
                    {displayCustomerName ?? "—"}
                  </span>

                  {/* MITTE — Col 5: Datum */}
                  <span className="text-xs text-muted-foreground whitespace-nowrap truncate">
                    {dateText ?? "—"}
                  </span>

                  {/* MITTE — Col 6: Status-Tags. Reihenfolge: Dringend,
                      Status (Storniert/Abgeschlossen/...), dann Vermietung
                      ganz rechts. Im Archiv gemuted (grayscale + opacity)
                      damit die Liste ruhiger wirkt — wichtige Info ist da
                      eh die Rechnungsnummer in der Actions-Spalte. */}
                  <div className={`flex items-center gap-1 min-w-0 flex-wrap ${showArchive ? "grayscale opacity-60" : ""}`}>
                    {job.priority === "dringend" && isActive && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0 text-[10px] font-semibold rounded-full bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300 shrink-0">
                        <AlertCircle className="h-2.5 w-2.5" />
                      </span>
                    )}
                    {job.status !== "offen" && JOB_STATUS[job.status] && (
                      <span className={`inline-flex px-1.5 py-0 text-[10px] font-medium rounded-full shrink-0 ${JOB_STATUS[job.status].color}`}>
                        {JOB_STATUS[job.status].label}
                      </span>
                    )}
                    {job.was_anfrage && job.status !== "anfrage" && (
                      <span className="inline-flex px-1.5 py-0 text-[10px] font-medium rounded-full bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300 shrink-0">
                        Vermietung
                      </span>
                    )}
                  </div>

                  {/* Col 8: Spacer (1fr) — leer */}
                  <div />

                  {/* RECHTS — Col 9: Rechnungs-Pille / Hint / Aktion-Icon
                      + bei Anfragen darunter direkt der Step-Tracker
                      (vorher in eigener Zeile mit Luecke — jetzt eng
                      gestackt). */}
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <div className="flex items-center gap-1.5 justify-end">
                      {job.invoiced_at && job.invoice_number && (
                        <button
                          type="button"
                          // <button> statt <a> weil die ganze Card schon
                          // in einem <Link> verpackt ist — verschachtelte
                          // <a>-Tags sind invalides HTML.
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            window.open(
                              `/api/bexio/open-invoice?nr=${encodeURIComponent(job.invoice_number!)}`,
                              "_blank",
                              "noopener,noreferrer",
                            );
                          }}
                          // Bexio-Lime-Pill — selbe Styling-Familie wie die
                          // Kunden-Bexio-Nr in /kunden, damit "lime = Bexio"
                          // app-weit eindeutig bleibt.
                          className="inline-flex items-center gap-1 font-mono text-xs font-semibold px-1.5 py-0.5 rounded text-[rgb(132,152,0)] dark:text-[rgb(196,214,0)] bg-[rgba(196,214,0,0.12)] dark:bg-[rgba(196,214,0,0.18)] hover:bg-[rgba(196,214,0,0.22)] dark:hover:bg-[rgba(196,214,0,0.26)] transition-colors"
                          data-tooltip="In Bexio öffnen"
                        >
                          Rechnung {job.invoice_number}
                          <ExternalLink className="h-3 w-3 opacity-60" />
                        </button>
                      )}
                      {isAnfrage && isMailStep && (
                        <span className="text-xs font-medium whitespace-nowrap text-purple-700 dark:text-purple-300">
                          {stepInfo.label}
                        </span>
                      )}
                      {isAnfrage && !isMailStep && (
                        <span className="text-xs font-medium whitespace-nowrap text-purple-700 dark:text-purple-300">
                          Manuell in Details bestätigen
                        </span>
                      )}
                      {!isAnfrage && noTermin && (
                        <span className="text-xs font-medium whitespace-nowrap text-amber-700 dark:text-amber-300">
                          Kein Termin geplant
                        </span>
                      )}
                      {!isAnfrage && terminUnassigned && (
                        <span className="text-xs font-medium whitespace-nowrap text-amber-700 dark:text-amber-300">
                          Termin nicht zugewiesen
                        </span>
                      )}
                      {renderActionIcon("sm")}
                    </div>
                    {isAnfrage && (
                      <RequestStepTracker currentStep={currentStep} size="sm" />
                    )}
                  </div>
                </div>
              </Card>
            </Link>
            );
          })}
          {showArchive && archiveHasMore && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                onClick={loadArchiveMore}
                disabled={archiveLoadingMore}
                className="kasten kasten-muted"
              >
                {archiveLoadingMore ? <Spinner size={14} /> : <ChevronDown className="h-3.5 w-3.5" />}
                {archiveLoadingMore ? "Lade…" : "Mehr laden"}
              </button>
            </div>
          )}
          {!showArchive && activeHasMore && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                onClick={loadActiveMore}
                disabled={activeLoadingMore}
                className="kasten kasten-muted"
              >
                {activeLoadingMore ? <Spinner size={14} /> : <ChevronDown className="h-3.5 w-3.5" />}
                {activeLoadingMore ? "Lade…" : "Mehr aktive Aufträge laden"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Inline-Mail-Modal fuer Vermietentwuerfe — wird vom "Nächster Schritt"-Button auf jeder
          Anfrage-Karte gefuettert. Beim Bestaetigen ruft onAdvance den entsprechenden
          Step-+1 (oder oeffnet den Convert-Modal) auf. */}
      {(() => {
        // Nur Active-Anfragen bekommen das Mail-Modal — Anfragen sind nie im Archiv.
        const activeJob = activeStepJobId ? activeJobs.find((j) => j.id === activeStepJobId) ?? null : null;
        if (!activeJob) return null;
        const customer = activeJob.customer;
        const location = activeJob.location;
        return (
          <SendStepModal
            open={true}
            jobId={activeJob.id}
            step={(activeJob.request_step ?? 1) as 1 | 2 | 3 | 4}
            customerEmail={customer?.email ?? ""}
            customerName={customer?.name ?? null}
            locationName={location?.name ?? null}
            eventDate={activeJob.start_date}
            eventEndDate={activeJob.end_date}
            onClose={() => setActiveStepJobId(null)}
            onAdvance={() => advanceAnfrageStep(activeJob.id)}
          />
        );
      })()}

    </div>
  );
}
