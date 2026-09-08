"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { JOB_STATUS } from "@/lib/constants";
import type { JobStatus, Profile, JobWithRelations } from "@/types";
import Link from "next/link";
import {
  Plus,
  Search,
  ClipboardList,
  CalendarPlus,
  AlertCircle,
  Archive,
  X,
  Check,
  ChevronDown,
  ExternalLink,
  UserPlus,
  Download,
  PhoneCall,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { BackButton } from "@/components/ui/back-button";

// Kleinere Page-Size = "Mehr laden" wird sichtbar, schnellerer initial-Load.
// Beide Listen jetzt server-seitig nach start_date sortiert damit Pagination
// bei wachsendem Datenvolumen die Datums-Reihenfolge nicht durcheinanderbringt.
const ARCHIVE_PAGE_SIZE = 30;
const ACTIVE_PAGE_SIZE = 30;
// Location wird mit dem Verwaltungs-Kunden gejoint, sodass Standort-Auftraege
// (jobs.customer_id = null) trotzdem einen Kundennamen anzeigen koennen.
// Room wird ebenfalls gejoint fuer extern-Auftraege mit bekanntem Raum.
// `*` deckt bereits `customer_contacted_at` mit ab (jobs-Spalte, Migration 211) —
// wird fuer den "Kontaktiert"-Chip in der Liste verwendet.
const JOBS_SELECT = "*, customer:customers(name, email), location:locations(name, customer:customers(id, name)), room:rooms(id, name), project_lead_id, appointments:job_appointments(id, start_time, assigned_to), service_reports(status)";
import { SearchableSelect } from "@/components/searchable-select";
import { JobNumber } from "@/components/job-number";
import { toast } from "sonner";
import { usePermissions } from "@/lib/use-permissions";
import { localDateIso } from "@/lib/swiss-time";

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
  // Location-Filter: "all" | "sonstige" (kein location_id gesetzt) | <location_id>.
  // Vorher hardcoded scala/barakuba/bau3 mit Substring-Match auf location.name —
  // jetzt dynamisch aus der DB (siehe activeLocations useEffect) und per
  // location_id server-seitig gefiltert (§4 CLAUDE.md).
  const [filterLocation, setFilterLocation] = useState<string>(() => typeof window !== "undefined" ? (localStorage.getItem("auftraege-location") || "all") : "all");
  const [activeLocations, setActiveLocations] = useState<{ id: string; name: string }[]>([]);
  // Segment-Toggle. Zwei disjunkte Ansichten:
  //   aktiv:  freigegebene Auftraege (status=offen)
  //   archiv: abgeschlossen + storniert
  // Zustand lebt in ?segment=... (URL-persist + teilbar) mit localStorage-
  // Fallback fuer die naechste Session; Default=aktiv.
  const searchParams = useSearchParams();
  const router = useRouter();
  type Segment = "aktiv" | "archiv";
  function resolveInitialSegment(): Segment {
    if (typeof window === "undefined") return "aktiv";
    const fromUrl = searchParams.get("segment");
    if (fromUrl === "aktiv" || fromUrl === "archiv") return fromUrl;
    const fromLs = localStorage.getItem("auftraege-segment");
    if (fromLs === "aktiv" || fromLs === "archiv") return fromLs;
    // Kompatibilitaet: alter localStorage-Key "auftraege-archive"=true → archiv.
    if (localStorage.getItem("auftraege-archive") === "true") return "archiv";
    return "aktiv";
  }
  const [segment, setSegment] = useState<Segment>(resolveInitialSegment);
  const showArchive = segment === "archiv";
  function selectSegment(next: Segment) {
    setSegment(next);
    if (typeof window !== "undefined") {
      localStorage.setItem("auftraege-segment", next);
      const params = new URLSearchParams(searchParams.toString());
      params.set("segment", next);
      router.replace(`/auftraege?${params.toString()}`, { scroll: false });
    }
  }
  // Rapport-ZIP-Download im Archiv
  const [showRapportExport, setShowRapportExport] = useState(false);
  const [exportFrom, setExportFrom] = useState<string>("");
  const [exportTo, setExportTo] = useState<string>("");
  const [exportInProgress, setExportInProgress] = useState(false);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  // Race-Guard fuer Archive-Queries (alte Antworten verwerfen, wenn neuere unterwegs sind)
  const archiveQueryIdRef = useRef(0);
  // Debounce-Timer fuer Suche (Tippen feuert nicht jede Query sofort)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Filter in localStorage speichern
  useEffect(() => { if (typeof window !== "undefined") localStorage.setItem("auftraege-search-number", searchNumber); }, [searchNumber]);
  useEffect(() => { if (typeof window !== "undefined") localStorage.setItem("auftraege-search-title", searchTitle); }, [searchTitle]);
  useEffect(() => { if (typeof window !== "undefined") localStorage.setItem("auftraege-status", filterStatus); }, [filterStatus]);
  useEffect(() => { if (typeof window !== "undefined") localStorage.setItem("auftraege-location", filterLocation); }, [filterLocation]);
  // Active + Counts + Profiles: bei Mount, Segment-Wechsel, Filter-Wechsel
  // und Invalidate neu geladen (Filter jetzt server-seitig → §4).
  // Archive: eigener Effect mit Debounce (siehe weiter unten).
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
  }, [segment, filterStatus, filterLocation]);

  // Locations-Liste einmalig laden (aktive Locations mit id+name), damit
  // der Location-Filter dynamisch aus der DB kommt. Vorher hardcoded
  // scala/barakuba/bau3 im JSX + Substring-Match — jetzt data-driven.
  useEffect(() => {
    let alive = true;
    supabase
      .from("locations")
      .select("id, name")
      .eq("is_active", true)
      .order("name")
      .then(({ data }) => {
        if (!alive) return;
        const rows = (data as { id: string; name: string }[] | null) ?? [];
        setActiveLocations(rows);
        // Stale-localStorage-Cleanup: alte Werte "scala"/"barakuba"/"bau3"
        // (oder inaktiv gewordene IDs) auf "all" zuruecksetzen, sonst
        // liefert die Query dauerhaft 0 Ergebnisse.
        setFilterLocation((cur) => {
          if (cur === "all" || cur === "sonstige") return cur;
          if (rows.some((r) => r.id === cur)) return cur;
          return "all";
        });
      });
    return () => {
      alive = false;
    };
  }, [supabase]);

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
    // is_deleted-Nullguard: .neq('is_deleted', true) filtert NULL raus (SQL 3-valued
    // logic), also Rows aus Migrationen vor is_deleted-Default gehen verloren.
    // Explizit "IS NULL OR FALSE" — konsistent zur Archiv-Query unten.
    let q = supabase
      .from("jobs")
      .select(JOBS_SELECT)
      .or("is_deleted.is.null,is_deleted.eq.false")
      .or(cancelledFilter);
    // aktiv-Segment: freigegebene Auftraege (partner_entwurf gehoert nur
    // ins Partnerportal, Anfragen/Entwuerfe/Partner-Anfragen laufen ausserhalb
    // dieser Liste). Status-Filter server-seitig (§4): filterStatus "all"
    // → nur offen; ein konkreter Status ueberschreibt (gibt ggf. leere Liste,
    // z.B. wenn "storniert" waehrend Aktiv-Segment).
    if (filterStatus === "all") {
      q = q.eq("status", "offen");
    } else {
      q = q.eq("status", filterStatus);
    }
    // Location-Filter server-seitig auf location_id (statt Substring-Match
    // auf location.name im Client). "sonstige" = jobs ohne location_id
    // (Kunden-/externe Auftraege).
    if (filterLocation === "sonstige") {
      q = q.is("location_id", null);
    } else if (filterLocation !== "all") {
      q = q.eq("location_id", filterLocation);
    }
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
  }, [supabase, filterStatus, filterLocation]);

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

  // Archive-Query mit Filtern: status, title, exakte Nummer, location — alles server-seitig.
  // job_number ist Integer — partial-Match nicht via PostgREST moeglich, daher
  // nur bei vollstaendiger Eingabe (6 Ziffern) als exact-Filter.
  // Sort: start_date DESC (juengste-past zuerst), composite cursor (start_date, id).
  const buildArchiveQuery = useCallback((cursor: { start_date: string | null; id: string } | null) => {
    const cancelledFilter = "cancelled_as_anfrage.is.null,cancelled_as_anfrage.eq.false";
    // is_deleted-Nullguard analog zur Active-Query (siehe oben).
    let q = supabase
      .from("jobs")
      .select(JOBS_SELECT)
      .or("is_deleted.is.null,is_deleted.eq.false")
      .or(cancelledFilter);

    if (filterStatus === "abgeschlossen" || filterStatus === "storniert") {
      q = q.eq("status", filterStatus);
    } else if (filterStatus === "all") {
      q = q.in("status", ["abgeschlossen", "storniert"]);
    } else {
      // Nicht-archiv-Status im Archiv-Segment → bewusst leere Ergebnisliste.
      q = q.eq("status", filterStatus);
    }

    // Location-Filter server-seitig, identisch zur Active-Query (§4).
    if (filterLocation === "sonstige") {
      q = q.is("location_id", null);
    } else if (filterLocation !== "all") {
      q = q.eq("location_id", filterLocation);
    }

    const titleQ = searchTitle.trim();
    // ILIKE-Escape: %/_ waeren sonst Wildcards und ein Backslash im Suchbegriff
    // wuerde die Escape-Sequenz zerbrechen — alle drei backslash-quoten.
    if (titleQ) q = q.ilike("title", `%${titleQ.replace(/[\\%_]/g, "\\$&")}%`);

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
  }, [supabase, filterStatus, filterLocation, searchTitle, searchNumber]);

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

  // Anfang von heute (00:00) im Lokal-Kalender Europe/Zurich — Aufträge die
  // heute stattfinden zählen noch als "kommend". Ueber swiss-time-Helper
  // damit User in anderer Browser-TZ nicht falsche past/future-Buckets
  // sehen (Datums-Bug 2026-06-15, CLAUDE.md §4).
  const todayIsoZrh = localDateIso(new Date());
  const [ty, tm, td] = todayIsoZrh.split("-").map(Number);
  const todayMs = Date.UTC(ty, tm - 1, td, 0, 0, 0);
  // Quelle haengt vom Modus ab — Active ist voll geladen, Archive ist paginiert.
  // Wenn ein Such-Term aktiv ist, mixen wir auch im Aktiv-Modus die archivierten
  // Auftraege rein damit der User nicht aktiv vs archiv toggeln muss.
  const sourceJobs = showArchive
    ? archiveJobs
    : hasSearchTerm
      ? [...activeJobs, ...archiveJobs.filter((a) => !activeJobs.some((b) => b.id === a.id))]
      : activeJobs;
  const totalForSource = segment === "archiv"
    ? counts.abgeschlossen + counts.storniert
    : counts.offen;
  // Status- und Location-Filter laufen jetzt server-seitig in buildActive-/
  // buildArchiveQuery (§4). Der verbleibende Client-Filter deckt nur noch
  // Titel- und Nummer-Substring-Matching ab (Titel: fallback wenn ein Job
  // aus der activeJobs-Liste in der ilike-Archive-Query nicht auftauchte;
  // Nummer: Partial-Match, da die DB-Query nur bei voller 6-stelliger
  // Nummer greift).
  const filtered = sourceJobs.filter((j) => {
    const numQ = searchNumber.trim();
    const titleQ = searchTitle.trim().toLowerCase();
    const matchesNumber = !numQ ? true : String(j.job_number ?? "").includes(numQ);
    const matchesTitle = !titleQ ? true : j.title.toLowerCase().includes(titleQ);
    return matchesNumber && matchesTitle;
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

  // BackButton zeigen wenn User vom Dashboard hierhergekommen ist
  // (Dashboard-Link setzt ?from=dashboard). Bei normaler Sidebar-Navigation
  // kein Zurueck-Pfeil, damit Header nicht unnoetig zugestellt wird.
  const fromDashboard = searchParams.get("from") === "dashboard";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3 min-h-9">
        <div className="flex items-center gap-3 min-w-0">
          {fromDashboard && <BackButton fallbackHref="/dashboard" />}
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              {segment === "archiv" ? "Aufträge — Archiv" : "Aufträge"}
            </h1>
            {/* Leerer Subtitle-Platzhalter — sorgt dafuer dass die Header-Hoehe
                identisch zu /kunden etc. ist, sodass die Action-Buttons rechts
                auf gleicher Linie sitzen wie auf den anderen Seiten. */}
            <p className="text-sm text-muted-foreground mt-1" aria-hidden="true">&nbsp;</p>
          </div>
        </div>
        {/* Action-Buttons — EIN Toggle-Button (zeigt das jeweils andere
            Segment), dann kontext-spezifische Aktionen. "Neuer Auftrag" ist
            EVENTLINE-Brand-Primaeraktion und daher rot (Rot ist hier
            Brand-Farbe, nicht destruktiv). */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Ein Toggle-Button: klickt zwischen Aktiv- und Archiv-View um.
              Label + Icon zeigen das jeweils *andere* Segment, in das der
              Klick fuehrt. Zaehler kommt aus der counts-View. */}
          <button
            type="button"
            onClick={() => selectSegment(segment === "aktiv" ? "archiv" : "aktiv")}
            className="kasten kasten-muted"
            aria-label={segment === "aktiv" ? "Zum Archiv wechseln" : "Zu aktiven Aufträgen wechseln"}
          >
            {segment === "aktiv" ? (
              <>
                <Archive className="h-3.5 w-3.5" />
                Archiv ({counts.abgeschlossen + counts.storniert})
              </>
            ) : (
              <>
                <ClipboardList className="h-3.5 w-3.5" />
                Aktiv ({counts.offen})
              </>
            )}
          </button>
          {segment === "archiv" && can("auftraege:see-all") && (
            <button
              onClick={() => {
                // Default-Range: ganzes letztes Monat (häufigster Buchhaltungs-Use-Case).
                if (!exportFrom || !exportTo) {
                  const now = new Date();
                  const firstThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
                  const lastMonthEnd = new Date(firstThisMonth.getTime() - 24 * 60 * 60 * 1000);
                  const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);
                  const pad = (n: number) => String(n).padStart(2, "0");
                  setExportFrom(`${lastMonthStart.getFullYear()}-${pad(lastMonthStart.getMonth() + 1)}-${pad(lastMonthStart.getDate())}`);
                  setExportTo(`${lastMonthEnd.getFullYear()}-${pad(lastMonthEnd.getMonth() + 1)}-${pad(lastMonthEnd.getDate())}`);
                }
                setShowRapportExport(true);
              }}
              className="kasten kasten-red"
              data-tooltip="Alle abgeschlossenen Rapporte im Zeitraum als ZIP herunterladen"
            >
              <Download className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Rapporte-ZIP</span>
            </button>
          )}
          {segment !== "archiv" && can("auftraege:create") && (
            <>
              {/* Entwuerfe wandern seit 2026-09 in einen eigenen Bereich —
                  Link fuehrt zu /entwuerfe/neu (Migration 206, job_drafts). */}
              <Link href="/entwuerfe/neu" className="kasten kasten-purple" data-tooltip="Neuer Entwurf">
                <Plus className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Neuer Entwurf</span>
                <span className="sm:hidden">Entwurf</span>
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
      {/* Such- und Filter-Bar — kompakt, getrennte Felder fuer Nummer und Titel */}
      <div className="flex flex-col sm:flex-row gap-2">
        {/* Suche Nummer */}
        <div className="relative w-full sm:w-44">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-mono text-muted-foreground/60 pointer-events-none">
            INT-
          </span>
          <Input
            placeholder="00000"
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

        {/* Location-Filter — dynamisch aus aktiven Locations (§1 CLAUDE.md).
            "Sonstige" = jobs ohne location_id (Kunden-/externe Auftraege). */}
        <div className="w-full sm:w-44">
          <SearchableSelect
            value={filterLocation}
            onChange={(v) => setFilterLocation(v)}
            items={[
              { id: "all", label: "Alle Locations" },
              ...activeLocations.map((l) => ({ id: l.id, label: l.name })),
              { id: "sonstige", label: "Sonstige" },
            ]}
            searchable={activeLocations.length > 8}
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
              <CardContent className="p-0">
                <EmptyState
                  icon={ClipboardList}
                  title={hasFilter ? "Keine Ergebnisse mit diesen Filtern" : "Noch keine Aufträge"}
                  description={
                    hasFilter
                      ? `${totalForSource} Auftrag${totalForSource === 1 ? "" : "e"} insgesamt — passt nichts auf deine Filter.`
                      : "Erstelle deinen ersten Auftrag."
                  }
                  action={
                    hasFilter ? (
                      <button
                        type="button"
                        onClick={() => {
                          setSearchNumber("");
                          setSearchTitle("");
                          setFilterStatus("all");
                          setFilterLocation("all");
                        }}
                        className="kasten kasten-muted"
                      >
                        Filter zuruecksetzen
                      </button>
                    ) : (
                      <div className="flex items-center justify-center gap-2 flex-wrap">
                        <Link href="/entwuerfe/neu" className="kasten kasten-purple">
                          <Plus className="h-3.5 w-3.5" />
                          Neuer Entwurf
                        </Link>
                        <Link href="/auftraege/neu" className="kasten kasten-red">
                          <Plus className="h-3.5 w-3.5" />
                          Neuer Auftrag
                        </Link>
                      </div>
                    )
                  }
                />
              </CardContent>
            </Card>
          );
        })()
      ) : (
        <div className="space-y-1.5">
          {filtered.map((job, idx) => {
            // Trennmarker zwischen zukuenftigen und vergangenen Auftraegen —
            // die Sortierung setzt !past-Jobs (heute + Zukunft) vor past-Jobs.
            // Beim Wechsel !past -> past zeichnen wir eine dezente Linie
            // mit "Vergangen"-Label, sodass die visuelle Zaesur klar ist.
            const prev = idx > 0 ? filtered[idx - 1] : null;
            const jobRef = job.end_date ? new Date(job.end_date).getTime() : job.start_date ? new Date(job.start_date).getTime() : Infinity;
            const prevRef = prev ? (prev.end_date ? new Date(prev.end_date).getTime() : prev.start_date ? new Date(prev.start_date).getTime() : Infinity) : Infinity;
            const jobPast = jobRef < todayMs;
            const prevPast = prev ? prevRef < todayMs : false;
            const showDivider = !showArchive && prev && jobPast && !prevPast;
            const appointments = job.appointments ?? null;
            const hasAppointment = !!(appointments && appointments.length > 0);
            // Zugewiesen = irgendein Termin hat einen assigned_to. Bei
            // Partner-Anfragen die akzeptiert wurden gibt's anfangs einen
            // Termin OHNE Zuweisung — Team-Lead muss erst einen Mitarbeiter
            // zuteilen bevor's als "alles bereit" zaehlt.
            const hasAssignedAppointment = !!(appointments && appointments.some((a) => a.assigned_to));
            const isActive = !["abgeschlossen", "storniert"].includes(job.status);
            // Kunde-Fallback: Standort-Auftraege haben jobs.customer_id = NULL,
            // weil der Kunde implizit der Verwaltungs-Kunde des Standorts ist.
            const displayCustomerName = job.customer?.name ?? job.location?.customer?.name ?? null;
            const noTermin = isActive && !hasAppointment;
            const terminUnassigned = isActive && hasAppointment && !hasAssignedAppointment;
            const allGood = isActive && hasAppointment && hasAssignedAppointment;
            const detailHref = `/auftraege/${job.id}`;
            // "Rapport-Entwurf"-Pille: nur wenn ein offener Entwurf existiert
            // und der Auftrag noch nicht abgeschlossen ist (Entwurf auf einem
            // abgeschlossenen Auftrag ist unmoeglich per DB-Trigger, aber wir
            // filtern trotzdem defensiv).
            const hasRapportDraft = isActive && !!job.service_reports?.some((r) => r.status === "entwurf");
            // "Kontaktiert"-Chip: Kunde wurde von Team bereits kontaktiert
            // (Follow-up-Tracking, Migration 211). Tooltip zeigt Zeitpunkt
            // in CH-Zeit (§4 CLAUDE.md — nie ohne timeZone).
            const contactedAt = job.customer_contacted_at;
            const contactedTooltip = contactedAt
              ? "Kontaktiert am " + new Date(contactedAt).toLocaleString("de-CH", { timeZone: "Europe/Zurich" })
              : "";
            const dateText = job.start_date
              ? new Date(job.start_date).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })
                + (job.end_date && job.end_date !== job.start_date ? " – " + new Date(job.end_date).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" }) : "")
              : "";

            // Action-Icon-Logik: kleines Icon in der Compact-Zeile —
            // Termin-Zustand des Auftrags (kein Termin / nicht zugewiesen /
            // alles bereit). Anfrage- und Entwurf-Jobs erscheinen nicht in
            // dieser Liste (Aktiv=offen, Archiv=abgeschlossen+storniert).
            function renderActionIcon(size: "sm") {
              const iconCls = size === "sm" ? "h-4 w-4" : "h-5 w-5";
              const padCls = size === "sm" ? "p-1.5" : "p-2.5";
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


            // Warnings (Audit Thema 5, Regel 2): "Kein Termin" /
            // "Termin nicht zugewiesen" wandern aus der Inline-Textzeile in
            // einen WarningCard-Wrapper (3px amber Left-Border + Info-Icon
            // mit Tooltip oben rechts). Die textuelle Info-Zeile darunter
            // wird entsprechend nicht mehr gerendert.
            const warnings: { label: string }[] = [];
            if (noTermin) warnings.push({ label: "Kein Termin geplant" });
            else if (terminUnassigned) warnings.push({ label: "Termin nicht zugewiesen" });
            // Storniert/Abgeschlossen (Audit Thema 5, Regel 3): abgeschlossene
            // und stornierte Karten laufen im Archiv-Segment; wir setzen
            // opacity-70 damit sie visuell zurueckgenommen wirken.
            const isDoneOrCancelled = job.status === "abgeschlossen" || job.status === "storniert";
            return (
            <div key={job.id}>
              {showDivider && (
                <div className="flex items-center gap-3 pt-3 pb-2 select-none">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-medium">Vergangen</span>
                  <div className="h-px flex-1 bg-border" />
                </div>
              )}
            <Link href={detailHref} className="block group">
              <Card className={`auftrag-card-hover relative bg-card cursor-pointer ${isDoneOrCancelled ? "opacity-70" : ""}`}>
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
                      {job.invoice_skipped_at && (
                        <span
                          className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300"
                          data-tooltip={job.invoice_skipped_reason ?? "Keine Rechnung gestellt"}
                        >
                          Keine Rechnung
                        </span>
                      )}
                      {hasRapportDraft && (
                        <span
                          className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300"
                          data-tooltip="Es existiert ein Rapport-Entwurf für diesen Auftrag"
                        >
                          Rapport-Entwurf
                        </span>
                      )}
                      {contactedAt && (
                        <span
                          className="inline-flex items-center px-1 py-0.5 text-[10px] font-medium rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                          data-tooltip={contactedTooltip}
                          aria-label={contactedTooltip}
                        >
                          <PhoneCall className="h-2.5 w-2.5" />
                        </span>
                      )}
                    </div>
                  </div>
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
                  {/* LINKS — Col 1: Nr-Badge (Warning-Icon sitzt absolute
                      auf der Card selbst, damit die Nummer hier immer an
                      derselben Position steht). */}
                  <div className="flex items-center min-w-0">
                    <JobNumber number={job.job_number} />
                  </div>

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
                    {hasRapportDraft && (
                      <span
                        className="inline-flex px-1.5 py-0 text-[10px] font-medium rounded-full bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300 shrink-0"
                        data-tooltip="Es existiert ein Rapport-Entwurf für diesen Auftrag"
                      >
                        Rapport-Entwurf
                      </span>
                    )}
                    {contactedAt && (
                      <span
                        className="inline-flex items-center px-1 py-0.5 text-[10px] font-medium rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300 shrink-0"
                        data-tooltip={contactedTooltip}
                        aria-label={contactedTooltip}
                      >
                        <PhoneCall className="h-2.5 w-2.5" />
                      </span>
                    )}
                  </div>

                  {/* Col 8: Spacer (1fr) — leer */}
                  <div />

                  {/* RECHTS — Col 9: Rechnungs-Pille / Hint / Aktion-Icon. */}
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
                      {job.invoice_skipped_at && (
                        <span
                          className="inline-flex items-center gap-1 text-xs font-semibold px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300"
                          data-tooltip={job.invoice_skipped_reason ?? "Keine Rechnung gestellt"}
                        >
                          Keine Rechnung
                        </span>
                      )}
                      {/* Termin-Warnungen ("Kein Termin", "Nicht zugewiesen")
                          werden ab Audit Thema 5 Regel 2 als WarningCard-
                          Border oben angezeigt — die Textzeile hier wuerde
                          die Warnung ein zweites Mal rendern. */}
                      {renderActionIcon("sm")}
                    </div>
                  </div>
                </div>
              </Card>
            </Link>
            </div>
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

      <Modal
        open={showRapportExport}
        onClose={() => !exportInProgress && setShowRapportExport(false)}
        title="Rapporte als ZIP herunterladen"
        size="sm"
        closable={!exportInProgress}
      >
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Lädt alle <strong>abgeschlossenen</strong> Rapporte mit Report-Datum im
            Zeitraum als ZIP herunter. Entwürfe werden ignoriert. Max. 500 Rapporte pro Export.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Von</label>
              <Input type="date" value={exportFrom} onChange={(e) => setExportFrom(e.target.value)} disabled={exportInProgress} className="mt-1" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Bis</label>
              <Input type="date" value={exportTo} onChange={(e) => setExportTo(e.target.value)} disabled={exportInProgress} className="mt-1" />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowRapportExport(false)}
              className="kasten kasten-muted flex-1"
              disabled={exportInProgress}
            >
              Abbrechen
            </button>
            <button
              type="button"
              onClick={async () => {
                if (!exportFrom || !exportTo) { toast.error("Von/Bis ausfüllen"); return; }
                if (exportFrom > exportTo) { toast.error("'Von' liegt nach 'Bis'"); return; }
                setExportInProgress(true);
                try {
                  const url = `/api/reports/export-zip?from=${exportFrom}&to=${exportTo}`;
                  const res = await fetch(url);
                  if (!res.ok) {
                    const j = await res.json().catch(() => null);
                    toast.error(j?.error || `Download fehlgeschlagen (${res.status})`);
                    return;
                  }
                  const blob = await res.blob();
                  const dlUrl = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = dlUrl;
                  a.download = `Rapporte_${exportFrom}_bis_${exportTo}.zip`;
                  document.body.appendChild(a); a.click(); document.body.removeChild(a);
                  URL.revokeObjectURL(dlUrl);
                  toast.success("ZIP heruntergeladen");
                  setShowRapportExport(false);
                } finally {
                  setExportInProgress(false);
                }
              }}
              disabled={exportInProgress}
              className="kasten kasten-red flex-1"
            >
              <Download className="h-3.5 w-3.5" />
              {exportInProgress ? "Generiere…" : "Download"}
            </button>
          </div>
          {exportInProgress && (
            <p className="text-[11px] text-center text-muted-foreground italic">
              PDFs werden serverseitig generiert — das kann bei vielen Rapporten 10-30 Sekunden dauern.
            </p>
          )}
        </div>
      </Modal>

    </div>
  );
}
