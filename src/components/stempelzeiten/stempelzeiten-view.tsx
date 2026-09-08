"use client";

/**
 * Stempelzeiten-Portal (vereinfacht — 2026-09-02, User-Dropdown 2026-09-06).
 *
 * Zeigt Stempeleintraege als flache, nach Tag gruppierte Liste — kein
 * Datums-Picker, keine Quick-Chips, kein Heatmap-/Pivot-Toggle, kein
 * Anomalien-Only-Filter mehr. Anomalien (lange Schicht > 10h,
 * Mitternacht-Uebergang, vergessener Stempel-Out > 18h) erscheinen als
 * kleine Chips pro Zeile.
 *
 * Ansicht-Modi ("Letzte 30 Tage" | "Archiv" — 2026-09-06): der Default lautet
 * "Recent" (Fenster DEFAULT_RANGE_DAYS Tage, ein Roundtrip, schnell — seit
 * 2026-09-08 zusaetzlich auf RECENT_PAGE_SIZE Zeilen je Seite gedeckelt,
 * damit "Alle Personen" bei wachsender Firma nicht unbounded tausende Rows
 * zieht). Klick auf "Archiv" laedt cursor-paginiert je ARCHIVE_PAGE_SIZE
 * Eintraege. In BEIDEN Modi erscheint ein "Mehr laden"-Button, solange
 * weitere Seiten existieren; die KPI-Kacheln rechnen dann page-basiert
 * ueber die geladenen Zeilen (identische Semantik wie bisher im Archiv).
 * Persistenz via `?mode=archive` (URL) + localStorage `stempelzeiten-view-mode`.
 * Auftrags-Filter dominiert wie bisher — dessen Query kennt kein Zeitfenster
 * und braucht keinen Modus, daher wird der Toggle dort ausgeblendet.
 *
 * KPIs oben (3 Kacheln): Diese Woche / Dieser Monat / Ø pro Arbeitstag Monat.
 * "Heute" faellt weg — steht ohnehin ganz oben in der Liste.
 *
 * Ansichts-Wechsel ("Eigene" + User-Dropdown) — ersetzt den vorherigen
 * Team/Alle-Segment-Toggle (2026-09-06). Statt drei Buttons gibt es einen
 * "Eigene"-Button (Default) plus einen SearchableSelect fuer die Person-
 * Auswahl. Sichtbarkeit des Dropdowns haengt an den Rechten:
 *   - Admin (Permission 'stempelzeiten:see-all'): alle aktiven Mitarbeiter
 *     (ausser Partner, via get_assignable_users RPC).
 *   - Teamleiter (roles.scope='team'|'all'): nur die eigenen Team-Mitglieder
 *     (profiles.team_lead_id = current_user).
 *   - Normal-User (scope='self'): kein Dropdown, nur eigene Ansicht.
 * Erste Dropdown-Option ist "Alle Personen" (Sentinel-Id ALL_USERS_SENTINEL,
 * URL-Value `?user=all`) — laesst die time_entries-Query ohne user_id-Filter
 * los und ueberlaesst die Sichtbarkeit strikt RLS: Admin sieht alle Rows,
 * Teamleiter nur eigenes Team (sees_user()), Normal-User nur eigene.
 * Sobald ein Fremd-User gewaehlt ist, filtert die Query strikt auf
 * `user_id = selectedUserId`. RLS (time_entries_select_team via sees_user())
 * haerte das serverseitig ab; ein Teamleiter, der jemanden ausserhalb seines
 * Teams anfragt, bekommt eine leere Liste. Fremd-User-Zeilen zeigen den
 * Namen des MA (Avatar + Farbcode) — im "Alle"-Modus gilt das analog fuer
 * jede Row.
 *
 * Persistenz: URL `?user=<uuid|all>` + localStorage `stempelzeiten-user`.
 * Eigene hat kein URL-Param (Default). Legacy `?scope=team|alle` wird
 * toleriert (ignoriert). Ein sanitizer-Effect entfernt ungueltige
 * selectedUserId-Werte (z.B. alte Links ohne aktuelle Rechte), sobald die
 * Rolle geladen ist — sonst wuerde der User auf einer leeren Liste ohne
 * Ausweg festhaengen (kein Dropdown-Button zum Zurueckwechseln). "Alle"
 * ohne canSelectOther-Recht wird ebenso ausgemistet.
 *
 * DST-Safety: KPI-Tages-Buckets via per-Minute-Bucketize (Europe/Zurich),
 * damit Nacht-Schichten korrekt auf zwei Tage verteilt werden. Die
 * Listen-Gruppierung selbst haengt die volle Schicht ans clock_in-Datum.
 */

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  Briefcase, FileText, Clock, Calendar, Trash2,
  AlertTriangle, Moon, Search, Users, Edit3, Lock, Download,
  Archive, ChevronDown,
} from "lucide-react";
import { isTimeEntryLocked, TIME_ENTRY_LOCK_MESSAGE } from "@/lib/time-lock";
import { useStempel, formatStempelDuration } from "@/lib/use-stempel";
import { useConfirm } from "@/components/ui/use-confirm";
import { Input } from "@/components/ui/input";
import { NewTicketModal } from "@/components/tickets/new-ticket-modal";
import { JobNumber } from "@/components/job-number";
import { SearchableSelect, type SelectItem } from "@/components/searchable-select";
import { formatProjectNumber } from "@/lib/projekte-format";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import {
  ZRH_TZ, localDateIso, todayLocalIso, weekdayForDateIso,
} from "@/lib/swiss-time";
import Link from "next/link";
import { useSearchParams, usePathname, useRouter } from "next/navigation";
import { BackButton } from "@/components/ui/back-button";

interface OwnEntry {
  id: string;
  job_id: string | null;
  /** Seit Migration 212: Projekt-Stempel liegen ebenfalls in time_entries
   *  (statt in der Legacy-Tabelle project_time_entries). project_id gesetzt
   *  + job_id NULL → Projekt-Stempel; wird als "PROJ-XX · Titel" gelabelt. */
  project_id: string | null;
  clock_in: string;
  clock_out: string | null;
  description: string | null;
  notes: string | null;
  job: { job_number: number; title: string } | null;
  project: { project_number: number | null; title: string } | null;
}

/** Zeile fuer Team- und Alle-Scope. Wie OwnEntry, aber mit user_id — der
 *  Mitarbeiter-Name wird per usersMap (get_assignable_users) aufgeloest,
 *  weil profiles-RLS einen direkten Join fuer Nicht-Admins blockiert. */
interface ScopedEntry extends OwnEntry {
  user_id: string;
}

/** Payload fuer den Row-"Korrigieren"-Button — wandert 1:1 in
 *  NewTicketModal.initialData rein und belegt das Stempel-Form vor. */
interface CorrectPayload {
  timeEntryId: string;
  clockIn: string;
  clockOut: string | null;
  jobId: string | null;
}

/** Ergebniszeile fuer den Auftragsnummer-Filter (Join zu profiles). */
interface JobFilterEntry {
  id: string;
  user_id: string;
  job_id: string | null;
  project_id: string | null;
  clock_in: string;
  clock_out: string | null;
  description: string | null;
  notes: string | null;
  user: { full_name: string | null } | null;
  project: { project_number: number | null; title: string } | null;
}

/** Header-Info fuer den gefundenen Auftrag beim Auftragsnummer-Filter. */
interface JobFilterHeader {
  id: string;
  job_number: number;
  title: string;
  customer: { name: string } | null;
}

interface NormalizedEntry {
  id: string;
  /** user_id des Eintrag-Owners — wird gebraucht um zu entscheiden, ob der
   *  Row-"Korrigieren"-Button gezeigt wird (nur eigene Eintraege). */
  userId: string | null;
  userName: string | null;
  jobId: string | null;
  jobLabel: string | null;
  jobHref: string | null;
  description: string | null;
  clockIn: string;
  clockOut: string | null;
  durationMinutes: number | null;
}

/** Range-Fenster in Tagen fuer den "Recent"-Mode (Default). Der Archiv-Mode
 *  hebelt das Fenster ab und laedt cursor-basiert paginiert alle Eintraege. */
const DEFAULT_RANGE_DAYS = 30;

/** Seitengroesse im Archiv-Mode. Erst-Ladung + jeder "Mehr laden"-Klick lauft
 *  ueber diesen Wert. Composite-Cursor (clock_in, id) fuer Tie-Break bei
 *  gleichzeitigen Stempel-Ins. n+1-Trick zur hasMore-Erkennung analog zu
 *  /auftraege-Archiv (siehe `buildArchiveQuery` in auftraege/page.tsx). */
const ARCHIVE_PAGE_SIZE = 100;

/** Seitengroesse im Recent-Mode (letzte 30 Tage). Vorher unbounded — die
 *  "Alle Personen"-Ansicht skaliert damit mit der Firmengroesse (100+ MA →
 *  tausende Rows mit 2 Joins pro Aufruf). Bewusst grosszuegiger als das
 *  Archiv: die "Eigene"-Ansicht (Default fuer alle) bleibt mit typ. 2-3
 *  Stempeln/Arbeitstag praktisch immer unter einer Seite → dort aendert
 *  sich nichts und die KPI-Kacheln bleiben exakt. Laeuft eine Seite voll,
 *  greift derselbe Cursor-"Mehr laden"-Flow wie im Archiv. */
const RECENT_PAGE_SIZE = 200;

/** Sentinel-Id fuer "Alle Personen" im Person-Dropdown. Kein UUID → kann
 *  nicht mit einem realen Profil kollidieren. Der URL-Param verwendet den
 *  kompakten Alias `all` (schoenere Shareable-Links: `?user=all`). */
const ALL_USERS_SENTINEL = "__all__";
const ALL_USERS_URL_VALUE = "all";

function pad2(n: number): string { return String(n).padStart(2, "0"); }

function formatDuration(minutes: number | null): string {
  if (minutes === null || minutes <= 0) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("de-CH", {
    timeZone: ZRH_TZ,
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatLongDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("de-CH", {
    timeZone: ZRH_TZ, weekday: "long", day: "2-digit", month: "long", year: "numeric",
  });
}

/** ISO-Wochen-Start: Montag der Woche fuer ein YYYY-MM-DD. */
function isoWeekStart(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  const wd = date.getUTCDay(); // 0=Sun
  const mondayOffset = wd === 0 ? -6 : 1 - wd;
  date.setUTCDate(date.getUTCDate() + mondayOffset);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function monthFirstIso(iso: string): string {
  const [y, m] = iso.split("-");
  return `${y}-${m}-01`;
}
function monthLastIso(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return `${y}-${pad2(m)}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

/** Baut Label + Href fuer eine Stempel-Zeile aus job/project-Feldern.
 *  Priorisiert Auftrag vor Projekt (bewusst — falls beide gesetzt sind, ist
 *  der Auftrag der Haupt-Kontext; Projekt-Zeit auf einem Auftrag ist der
 *  seltene Fall). Fallback null → Row zeigt Description bzw. "Andere Arbeit". */
function labelHrefFor(e: {
  job_id: string | null;
  project_id: string | null;
  job: { job_number: number; title: string } | null;
  project: { project_number: number | null; title: string } | null;
}): { jobId: string | null; jobLabel: string | null; jobHref: string | null } {
  if (e.job_id && e.job) {
    return {
      jobId: e.job_id,
      jobLabel: `INT-${e.job.job_number} · ${e.job.title}`,
      jobHref: `/auftraege/${e.job_id}`,
    };
  }
  if (e.project_id && e.project) {
    return {
      jobId: e.project_id,
      jobLabel: `${formatProjectNumber(e.project.project_number)} · ${e.project.title}`,
      jobHref: `/projekte/${e.project_id}`,
    };
  }
  // FK ohne geladenes Objekt (RLS blockiert z.B. Team-Leiter am Projekt) →
  // wenigstens die ID beibehalten damit anomaly/link-Logik nicht kippt,
  // aber kein Label (Row faellt auf description/"Andere Arbeit" zurueck).
  return { jobId: e.job_id ?? e.project_id, jobLabel: null, jobHref: null };
}

function normalizeOwn(e: OwnEntry, currentUserId: string | null): NormalizedEntry {
  const dur = e.clock_out
    ? Math.max(0, Math.floor((new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 60000))
    : null;
  const lh = labelHrefFor(e);
  return {
    id: e.id,
    userId: currentUserId, // eigene Sicht -> per Definition der eingeloggte User
    userName: null,
    jobId: lh.jobId,
    jobLabel: lh.jobLabel,
    jobHref: lh.jobHref,
    description: e.description,
    clockIn: e.clock_in,
    clockOut: e.clock_out,
    durationMinutes: dur,
  };
}

/** Scoped-Zeile (Team/Alle) — Name kommt aus der usersMap. Wenn die Map
 *  den User nicht kennt (z.B. deaktivierter Mitarbeiter, dessen Eintraege
 *  aber noch da sind), Fallback "Unbekannt" damit die Row lesbar bleibt. */
function normalizeScoped(e: ScopedEntry, usersMap: Map<string, string>): NormalizedEntry {
  const dur = e.clock_out
    ? Math.max(0, Math.floor((new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 60000))
    : null;
  const lh = labelHrefFor(e);
  return {
    id: e.id,
    userId: e.user_id,
    userName: usersMap.get(e.user_id) ?? "Unbekannt",
    jobId: lh.jobId,
    jobLabel: lh.jobLabel,
    jobHref: lh.jobHref,
    description: e.description,
    clockIn: e.clock_in,
    clockOut: e.clock_out,
    durationMinutes: dur,
  };
}

/** Auftragsnummer-Filter: Job-Header ist bereits im State — pro Zeile braucht
 *  es keine Job-Info nochmal. userName kommt aus dem profiles-Join. */
function normalizeJobFilter(e: JobFilterEntry, jobHeader: JobFilterHeader): NormalizedEntry {
  const dur = e.clock_out
    ? Math.max(0, Math.floor((new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 60000))
    : null;
  // Der Auftrags-Filter fragt strikt nach job_id, ergo ist jobHeader hier
  // per Definition der passende Auftrags-Label — project_id-Fallback nicht
  // noetig (das waere ein separater "Projekt-Filter", den es (noch) nicht gibt).
  return {
    id: e.id,
    userId: e.user_id,
    userName: e.user?.full_name ?? "Unbekannt",
    jobId: e.job_id,
    jobLabel: `INT-${jobHeader.job_number} · ${jobHeader.title}`,
    jobHref: e.job_id ? `/auftraege/${e.job_id}` : null,
    description: e.description,
    clockIn: e.clock_in,
    clockOut: e.clock_out,
    durationMinutes: dur,
  };
}

/** Nutzer-Eingabe "INT-26268", "int 26268", "26268" → geparste int oder null.
 *  int4-Schutz (>2^31-1) fuer versehentliche Telefonnummer-Eingaben. */
function parseJobNumber(raw: string): number | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, "");
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 2147483647) return null; // int4-Overflow-Guard
  return n;
}

interface Anomaly {
  longShift: boolean;
  crossesMidnight: boolean;
  forgotten: boolean;
}
function detectAnomaly(e: NormalizedEntry, nowMs: number): Anomaly {
  const longShift = e.durationMinutes !== null && e.durationMinutes > 10 * 60;
  const crossesMidnight = !!e.clockOut && localDateIso(new Date(e.clockIn)) !== localDateIso(new Date(e.clockOut));
  const forgotten = !e.clockOut && (nowMs - new Date(e.clockIn).getTime()) > 18 * 60 * 60 * 1000;
  return { longShift, crossesMidnight, forgotten };
}

/** 1-2 Initialen aus einem Namen ("Mathis Berger" -> "MB"). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Stabile HSL-Farbe pro Name (gleicher Name -> gleiche Farbe). */
function colorForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}

interface DayBucket {
  date: string;
  totalMin: number;
}

/** Verteilt eine Liste Eintraege per-Minute auf Lokal-Datums-Buckets fuer
 *  die KPIs — splittet auch Mitternacht-Uebergaenge korrekt (DST-safe). */
function buildDayBuckets(entries: NormalizedEntry[]): Map<string, DayBucket> {
  const out = new Map<string, DayBucket>();
  for (const e of entries) {
    if (!e.clockOut) continue;
    const start = new Date(e.clockIn).getTime();
    const end = new Date(e.clockOut).getTime();
    if (end <= start) continue;
    for (let t = start; t < end; t += 60_000) {
      const date = localDateIso(new Date(t));
      let b = out.get(date);
      if (!b) {
        b = { date, totalMin: 0 };
        out.set(date, b);
      }
      b.totalMin++;
    }
  }
  return out;
}

/**
 * Wiederverwendbare Stempelzeiten-View. Wird sowohl von /hr?tab=stempelzeiten
 * als auch vom /stempelzeiten-Deep-Link-Wrapper gerendert.
 */
export function StempelzeitenView() {
  const supabase = createClient();
  const { active } = useStempel();
  // Deep-Link-Route /stempelzeiten kann via Dashboard aufgerufen werden
  // (?from=dashboard). In /hr eingebettet regelt der HR-Header den Zurueck-
  // Pfeil — hier dann keinen zusaetzlichen zeigen (sonst 2 Pfeile).
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const showBackButton =
    pathname === "/stempelzeiten" && searchParams.get("from") === "dashboard";
  const { confirm, ConfirmModalElement } = useConfirm();
  const [showStempelTicket, setShowStempelTicket] = useState(false);
  /** Inline-Context: Payload fuer den Row-"Korrigieren"-Button (oder den
   *  "Vergessen auszustempeln?"-Link im Aktiv-Banner). Ist gesetzt →
   *  Modal oeffnet mit vorbelegten Feldern; null → normaler Fallback-
   *  Aufruf (leeres Form). */
  const [correctPayload, setCorrectPayload] = useState<CorrectPayload | null>(null);
  // User-ID + Rolle aus dem PermissionsProvider (/api/me) statt via eigenem
  // auth.getUser() + profiles.role-Query — spart 2 serielle Roundtrips beim
  // Mount (etabliertes Muster, vgl. ferien-view). Bei Dev-Mode-Impersonation
  // ist profile.id/role die EFFEKTIVE Perspektive — genau die Sicht, die
  // diese View zeigen soll (identisch zur can()-Gating-Semantik daneben).
  const { can, role, ready, profile } = usePermissions();
  const currentUserId = profile?.id ?? null;
  // "Alle"-Scope gated ueber Permission, nicht ueber die admin-Rolle direkt —
  // so kann HR/Team-Leitung ebenfalls per Rechte-Matrix Zugriff bekommen ohne
  // Voll-Admin zu sein. Admin ist implizit durch (hasPermission-Bypass).
  const canSeeAll = can("stempelzeiten:see-all");
  const [ownEntries, setOwnEntries] = useState<OwnEntry[]>([]);
  const [scopedEntries, setScopedEntries] = useState<ScopedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // Users-Map (id -> full_name) fuer Fremd-User-Zeilen und die
  // Dropdown-Options (inkl. eigener Name mit "(du)"-Marker). Wird bei
  // Bedarf via get_assignable_users (SECURITY DEFINER) geladen — die
  // Profile-RLS wuerde einen direkten Join fuer Nicht-Admins blockieren.
  const [usersMap, setUsersMap] = useState<Map<string, string>>(() => new Map());
  const [now, setNow] = useState(() => Date.now());
  // Excel-Export: gleicher Style wie im Lohn-Timesheet (Blob → temporaerer
  // Anchor). `exporting`-Guard verhindert Doppelklicks + zeigt Spinner-Text.
  const [exporting, setExporting] = useState(false);

  // Rolle-Scope + Team-Members steuern die Dropdown-Sichtbarkeit.
  // Rolle-Scope kommt aus roles.scope (Migration 208), Admin ist implizit
  // 'all'. Team-Members = profiles.team_lead_id = current_user.
  // `roleLoaded` flankiert den Sanitizer-Effect fuer selectedUserId — solange
  // die Rolle noch nicht geladen ist, darf kein legitimer ?user=…-Link
  // vorschnell geloescht werden.
  const [roleScope, setRoleScope] = useState<"self" | "team" | "all">("self");
  const [roleLoaded, setRoleLoaded] = useState(false);
  const [teamMemberIds, setTeamMemberIds] = useState<string[]>([]);
  /** Dropdown-Sichtbarkeit: Admin (see-all) ODER Teamleiter mit MA. */
  const canSelectOther = canSeeAll
    || ((roleScope === "team" || roleScope === "all") && teamMemberIds.length > 0);

  // URL-Param `?user=<uuid|all>`, Fallback localStorage, Default null (= eigene).
  // `useState`-Initializer lest die URL SYNCHRON, damit der erste Load
  // gleich die richtige Query feuert (kein Flicker "eigen → Fremd").
  // Legacy `?scope=team|alle` wird ignoriert — der User-Dropdown loest die
  // frueheren Segmente ab.
  // Sentinel `__all__` (URL: `all`) → "Alle Personen"-Modus: kein user_id-
  // Filter in der Query, RLS entscheidet welche Rows sichtbar sind.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const [selectedUserId, setSelectedUserId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const fromUrl = searchParams.get("user");
    if (fromUrl === ALL_USERS_URL_VALUE) return ALL_USERS_SENTINEL;
    if (fromUrl && UUID_RE.test(fromUrl)) return fromUrl;
    try {
      const stored = localStorage.getItem("stempelzeiten-user");
      if (stored === ALL_USERS_SENTINEL) return ALL_USERS_SENTINEL;
      if (stored && UUID_RE.test(stored)) return stored;
    } catch { /* SSR/private mode → ignorieren */ }
    return null;
  });

  // isAllUsersView: Sentinel gewaehlt → RLS-basierte "alle sichtbaren".
  // isOwnView: keine Fremd-Auswahl (oder man selbst gewaehlt → normalisiert).
  // Sentinel ist per Definition weder currentUserId noch null → isOwnView=false.
  const isAllUsersView = selectedUserId === ALL_USERS_SENTINEL;
  const isOwnView = !isAllUsersView && (!selectedUserId || selectedUserId === currentUserId);

  // Ansicht-Modus: "recent" (Default, letzte 30 Tage) oder "archive" (paginiert,
  // alle Eintraege). URL `?mode=archive` + localStorage `stempelzeiten-view-mode`;
  // Default (recent) haelt die URL clean.
  const [viewMode, setViewMode] = useState<"recent" | "archive">(() => {
    if (typeof window === "undefined") return "recent";
    const fromUrl = searchParams.get("mode");
    if (fromUrl === "archive") return "archive";
    if (fromUrl === "recent") return "recent";
    try {
      const stored = localStorage.getItem("stempelzeiten-view-mode");
      if (stored === "archive") return "archive";
    } catch { /* SSR/private mode → ignorieren */ }
    return "recent";
  });
  // Pagination-State (gilt fuer Archiv UND Recent-Mode): hasMore triggert
  // den "Mehr laden"-Button; loadingMore verhindert Doppelklicks und zeigt
  // Spinner-Text.
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Race-Guard: alte load()/loadMore()-Antworten verwerfen, wenn
  // zwischenzeitlich eine neuere Query gefeuert wurde (User wechselt schnell
  // Mode/User/Filter → sonst mixed-scope-Rows in der Liste).
  const loadIdRef = useRef(0);

  const setViewModeAndPersist = useCallback((next: "recent" | "archive") => {
    setViewMode(next);
    try {
      if (next === "archive") localStorage.setItem("stempelzeiten-view-mode", next);
      else localStorage.removeItem("stempelzeiten-view-mode");
    } catch { /* private mode */ }
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (next === "archive") url.searchParams.set("mode", "archive");
    else url.searchParams.delete("mode");
    // history.replaceState statt router.replace — rein visueller URL-Update,
    // KEIN Next.js Route-Transition (spart Re-Mount und respektiert den
    // HR-Tab-Kontext, in dem diese View eingebettet laufen kann).
    window.history.replaceState({}, "", url.toString());
  }, []);

  // Auftragsnummer-Filter (URL-persistent via ?auftrag=XXXXX). Der Text im
  // Input ist entkoppelt vom "committeten" Filter — Live-Suche mit 300ms
  // Debounce (Enter committed sofort). Wenn gesetzt, zeigt die Ansicht alle
  // time_entries auf diesem Auftrag (RLS filtert fuer Nicht-Admins auf eigene).
  const [jobFilterInput, setJobFilterInput] = useState<string>(
    () => searchParams.get("auftrag") ?? "",
  );
  const [jobFilterNumber, setJobFilterNumber] = useState<number | null>(
    () => parseJobNumber(searchParams.get("auftrag") ?? ""),
  );
  const [jobFilterHeader, setJobFilterHeader] = useState<JobFilterHeader | null>(null);
  const [jobFilterEntries, setJobFilterEntries] = useState<JobFilterEntry[]>([]);
  const [jobLookupState, setJobLookupState] = useState<"idle" | "loading" | "not_found">("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jobFilterActive = jobFilterNumber !== null;

  // Live-Tick nur wenn aktiv eingestempelt (fuer laufende Zeit-Anzeige).
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  // Rolle-Scope + Team-Members einmalig fuer den eingeloggten User laden.
  // Beides braucht der Toggle um zu entscheiden welche Segments sichtbar sind.
  // Die Rolle selbst kommt aus dem PermissionsProvider (kein erneuter
  // getUser-/profiles.role-Roundtrip); nur roles.scope (steckt nicht in
  // /api/me) und die Team-Members brauchen die DB — beide unabhaengig →
  // EIN paralleler Roundtrip via Promise.all statt des frueheren
  // 4-stufigen Wasserfalls (getUser → profiles.role → roles.scope → team).
  // Laeuft parallel zur time_entries-Query von load() (die haengt nur an
  // currentUserId, das synchron aus dem Provider kommt).
  // Admin ist implizit 'all' — nicht abhaengig von der roles.scope-Spalte
  // (sonst koennte sich ein Admin durch versehentliches Setzen aussperren).
  useEffect(() => {
    if (!ready || !currentUserId) return;
    let cancelled = false;
    (async () => {
      const [scopeRes, membersRes] = await Promise.all([
        // roles.scope nur fuer Nicht-Admin-Rollen noetig. Bei leerer Rolle,
        // Fehler oder unbekanntem Wert konservativ 'self' (wie bisher);
        // Admin-Fall wird ueber canSeeAll separat abgedeckt.
        role && role !== "admin"
          ? supabase.from("roles").select("scope").eq("slug", role).maybeSingle()
          : null,
        // Team-Members = Profiles mit team_lead_id = ich. Auch fuer Nicht-
        // Team-Rollen laden — laeuft parallel mit, macht die Dropdown-Logik
        // aber deterministisch (Anzahl aus dem State ablesbar).
        supabase.from("profiles").select("id").eq("team_lead_id", currentUserId),
      ]);
      if (cancelled) return;
      let s: "self" | "team" | "all" = "self";
      if (role === "admin") {
        s = "all";
      } else if (scopeRes) {
        const raw = (scopeRes.data as { scope?: unknown } | null)?.scope;
        if (raw === "team" || raw === "all" || raw === "self") s = raw;
      }
      setRoleScope(s);
      const ids = ((membersRes.data ?? []) as { id: string }[]).map((r) => r.id);
      setTeamMemberIds(ids);
      // Erst NACH beiden Queries als "geladen" markieren — der Sanitizer
      // fuer selectedUserId braucht beide Werte, um korrekt zu entscheiden.
      setRoleLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [supabase, ready, role, currentUserId]);

  // Users-Map fuer Zeilen-Darstellung UND Dropdown-Labels — laden wenn:
  //  - Fremd-Ansicht aktiv (Row-Avatar/Name),
  //  - Auftrags-Filter aktiv (Row-Name pro MA),
  //  - User Dropdown-Rechte hat (Options + eigener Name mit "(du)").
  // get_assignable_users ist SECURITY DEFINER und liefert Namen unabhaengig
  // von profiles-RLS.
  const needsUsersMap = !isOwnView || jobFilterActive || canSelectOther;
  useEffect(() => {
    if (!needsUsersMap) return;
    if (usersMap.size > 0) return; // einmal pro Session reicht
    (async () => {
      const { data } = await supabase.rpc("get_assignable_users");
      const list = (data as { id: string; full_name: string }[] | null) ?? [];
      const map = new Map<string, string>();
      for (const u of list) map.set(u.id, u.full_name);
      setUsersMap(map);
    })();
  }, [needsUsersMap, supabase, usersMap.size]);

  // User-Auswahl setzen + persistieren (URL + localStorage).
  // - null / self → kein URL-Param (haelt die URL clean, "Eigene" ist default).
  // - Sentinel (Alle) → URL-Param `?user=all`, localStorage = Sentinel.
  // - `history.replaceState` (nicht router.replace) — reiner visueller Update,
  //   kein Next.js Route-Transition (spart Re-Mount und respektiert den
  //   Ticket-System-Workflow der parallel laufen kann).
  // - Legacy `?scope=`-Param wird bei jedem Wechsel gleich mitentfernt.
  const setSelectedUserIdAndPersist = useCallback((next: string | null) => {
    // Selbst gewaehlt = eigene Ansicht → auf null normalisieren.
    // Sentinel (Alle) bleibt als-is (kein Normalisierungs-Fall).
    const normalized = next === ALL_USERS_SENTINEL
      ? ALL_USERS_SENTINEL
      : next && next !== currentUserId ? next : null;
    setSelectedUserId(normalized);
    try {
      if (normalized) localStorage.setItem("stempelzeiten-user", normalized);
      else localStorage.removeItem("stempelzeiten-user");
    } catch { /* private mode */ }
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (normalized === ALL_USERS_SENTINEL) {
      url.searchParams.set("user", ALL_USERS_URL_VALUE);
    } else if (normalized) {
      url.searchParams.set("user", normalized);
    } else {
      url.searchParams.delete("user");
    }
    url.searchParams.delete("scope"); // Legacy-Param mitentfernen.
    window.history.replaceState({}, "", url.toString());
  }, [currentUserId]);

  // Sanitizer: ungueltige selectedUserId aufraeumen, sobald Rolle geladen ist.
  //  - Sentinel (Alle) → nur behalten wenn User Fremd-Ansicht darf, sonst raus.
  //  - self → auf null normalisieren (isOwnView deckt das ohnehin ab, aber
  //    URL/Storage sauber halten).
  //  - Admin: alle usersMap-Ids OK (wenn usersMap noch leer, warten).
  //  - Teamleiter: nur teamMemberIds erlaubt.
  //  - Sonst (Normal-User): raus → sonst wuerde der User in einer leeren
  //    Ansicht ohne Dropdown festhaengen.
  useEffect(() => {
    if (!roleLoaded) return;
    if (!selectedUserId) return;
    if (selectedUserId === ALL_USERS_SENTINEL) {
      if (!canSelectOther) setSelectedUserIdAndPersist(null);
      return;
    }
    if (selectedUserId === currentUserId) {
      setSelectedUserIdAndPersist(null);
      return;
    }
    if (canSeeAll) {
      if (usersMap.size > 0 && !usersMap.has(selectedUserId)) {
        setSelectedUserIdAndPersist(null);
      }
      return;
    }
    if ((roleScope === "team" || roleScope === "all")
        && teamMemberIds.includes(selectedUserId)) {
      return;
    }
    setSelectedUserIdAndPersist(null);
  }, [roleLoaded, selectedUserId, currentUserId, canSeeAll, canSelectOther,
      roleScope, teamMemberIds, usersMap, setSelectedUserIdAndPersist]);

  // 30-Tage-Cutoff hart — kein UI-Umschalter. Aus dem Render heraus stabil.
  const fromIso = useMemo(
    () => addDaysIso(todayLocalIso(), -DEFAULT_RANGE_DAYS),
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    const myLoadId = ++loadIdRef.current;
    const fromTs = new Date(fromIso + "T00:00:00").toISOString();

    // Auftragsnummer-Filter aktiv → eigenstaendiger Pfad. Kein 30-Tage-
    // Cutoff (der Sinn ist "alles was auf diesem Auftrag gestempelt wurde").
    // Archiv-Modus greift hier nicht — der Auftrag zeigt sowieso alles.
    if (jobFilterActive && jobFilterNumber !== null) {
      setJobLookupState("loading");
      // 1) Auftrag per job_number aufloesen. maybeSingle → null wenn nicht da.
      const { data: job, error: jobErr } = await supabase
        .from("jobs")
        .select("id, job_number, title, customer:customers(name)")
        .eq("job_number", jobFilterNumber)
        .maybeSingle();
      if (myLoadId !== loadIdRef.current) return;
      if (jobErr) TOAST.supabaseError(jobErr, "Auftrag konnte nicht geladen werden");
      const jobHeader = (job as unknown as JobFilterHeader | null) ?? null;
      setJobFilterHeader(jobHeader);
      if (!jobHeader) {
        setJobFilterEntries([]);
        setJobLookupState("not_found");
        setOwnEntries([]);
        setScopedEntries([]);
        setHasMore(false);
        setLoading(false);
        return;
      }
      setJobLookupState("idle");
      // 2) Alle time_entries fuer diesen Auftrag. RLS: Admins sehen alle,
      //    Nicht-Admins nur eigene bzw. Team (per _select_team-Policy).
      const { data, error } = await supabase
        .from("time_entries")
        .select("id, user_id, job_id, project_id, clock_in, clock_out, description, notes, user:profiles(full_name), project:projects(project_number, title)")
        .eq("job_id", jobHeader.id)
        .order("clock_in", { ascending: false });
      if (myLoadId !== loadIdRef.current) return;
      if (error) TOAST.supabaseError(error, "Stempel-Einträge konnten nicht geladen werden");
      setJobFilterEntries((data as unknown as JobFilterEntry[]) ?? []);
      setOwnEntries([]);
      setScopedEntries([]);
      setHasMore(false);
      setLoading(false);
      return;
    }

    // Kein Auftrags-Filter → User-Auswahl + Modus steuern die Query.
    setJobFilterHeader(null);
    setJobFilterEntries([]);
    setJobLookupState("idle");
    setHasMore(false);

    const isArchive = viewMode === "archive";
    // Beide Modi seiten-gedeckelt (n+1-Trick fuer hasMore). Recent hat
    // zusaetzlich das 30-Tage-Fenster — die Seite ist dort grosszuegiger,
    // damit der Standardfall (Eigene) praktisch nie paginiert.
    const pageSize = isArchive ? ARCHIVE_PAGE_SIZE : RECENT_PAGE_SIZE;

    // "Alle Personen" — Sentinel gewaehlt. Query bewusst OHNE user_id-Filter:
    // RLS entscheidet welche Rows sichtbar sind (Admin=alle, Teamleiter=Team
    // + self via sees_user(), Normal-User=nur eigene — letzterer landet hier
    // faktisch nicht, weil Sanitizer + canSelectOther-Gate den Sentinel-Modus
    // fuer scope='self' unterbinden). user_id kommt mit, damit die Row-
    // Darstellung ueber usersMap wie im Fremd-User-Modus den MA-Namen zeigt.
    if (isAllUsersView) {
      let q = supabase
        .from("time_entries")
        .select("id, user_id, job_id, project_id, clock_in, clock_out, description, notes, job:jobs(job_number, title), project:projects(project_number, title)");
      if (!isArchive) q = q.gte("clock_in", fromTs);
      q = q.order("clock_in", { ascending: false }).order("id", { ascending: true }).limit(pageSize + 1);
      const { data, error } = await q;
      if (myLoadId !== loadIdRef.current) return;
      if (error) TOAST.supabaseError(error, "Stempel-Einträge konnten nicht geladen werden");
      const rows = (data as unknown as ScopedEntry[]) ?? [];
      setHasMore(rows.length > pageSize);
      setScopedEntries(rows.slice(0, pageSize));
      setOwnEntries([]);
      setLoading(false);
      return;
    }

    // Eigene Ansicht (Default oder Selbst-Auswahl im Dropdown).
    // RLS-Bug-Schutz: Admins haetten via RLS Zugriff auf ALLE time_entries —
    // ohne expliziten user_id-Filter zeigt "Eigene Sicht" auch fremde.
    // Daher zwingend nach currentUserId filtern.
    if (isOwnView) {
      if (!currentUserId) { setLoading(false); return; }
      let q = supabase
        .from("time_entries")
        .select("id, job_id, project_id, clock_in, clock_out, description, notes, job:jobs(job_number, title), project:projects(project_number, title)")
        .eq("user_id", currentUserId);
      if (!isArchive) q = q.gte("clock_in", fromTs);
      q = q.order("clock_in", { ascending: false }).order("id", { ascending: true }).limit(pageSize + 1);
      const { data, error } = await q;
      if (myLoadId !== loadIdRef.current) return;
      if (error) TOAST.supabaseError(error, "Stempel-Einträge konnten nicht geladen werden");
      const rows = (data as unknown as OwnEntry[]) ?? [];
      setHasMore(rows.length > pageSize);
      setOwnEntries(rows.slice(0, pageSize));
      setScopedEntries([]);
      setLoading(false);
      return;
    }

    // Fremd-User im Dropdown gewaehlt → nur DIESER User. RLS erlaubt
    // Admin/see-all alles; Teamleiter (via sees_user()) nur eigene
    // Team-Mitglieder — ist der gewaehlte User ausserhalb, liefert die
    // Query eine leere Liste (Empty-State greift, Sanitizer raeumt
    // beim naechsten Render auf).
    if (!selectedUserId) { setLoading(false); return; }
    let q = supabase
      .from("time_entries")
      .select("id, user_id, job_id, project_id, clock_in, clock_out, description, notes, job:jobs(job_number, title), project:projects(project_number, title)")
      .eq("user_id", selectedUserId);
    if (!isArchive) q = q.gte("clock_in", fromTs);
    q = q.order("clock_in", { ascending: false }).order("id", { ascending: true }).limit(pageSize + 1);
    const { data, error } = await q;
    if (myLoadId !== loadIdRef.current) return;
    if (error) TOAST.supabaseError(error, "Stempel-Einträge konnten nicht geladen werden");
    const rows = (data as unknown as ScopedEntry[]) ?? [];
    setHasMore(rows.length > pageSize);
    setScopedEntries(rows.slice(0, pageSize));
    setOwnEntries([]);
    setLoading(false);
  }, [
    supabase, currentUserId, fromIso, jobFilterActive, jobFilterNumber,
    isAllUsersView, isOwnView, selectedUserId, viewMode,
  ]);

  /** Naechste Seite nachladen (Archiv UND Recent-Mode, wenn eine Seite voll
   *  war). Cursor = letztes clock_in+id der aktuell angezeigten Liste
   *  (composite fuer Tie-Break). Filter/User-Kontext muss mit der load()-
   *  Query uebereinstimmen — deshalb saemtliche User-Pfade hier gespiegelt,
   *  inkl. des 30-Tage-Fensters im Recent-Mode (haelt hasMore am Fenster-
   *  Rand automatisch bei false). Der Race-Guard (loadIdRef) verhindert
   *  stale-appends wenn der User waehrend des Requests Mode/User wechselt
   *  (dann feuert load() eine neue Query, hebt myLoadId hoch und verwirft
   *  das alte Ergebnis). */
  const loadMore = useCallback(async () => {
    if (jobFilterActive) return; // Auftrags-Filter kennt kein Paging
    if (loadingMore || !hasMore) return;

    const isArchive = viewMode === "archive";
    const pageSize = isArchive ? ARCHIVE_PAGE_SIZE : RECENT_PAGE_SIZE;
    const fromTs = new Date(fromIso + "T00:00:00").toISOString();

    const currentList: { clock_in: string; id: string }[] = isOwnView
      ? ownEntries
      : scopedEntries;
    if (currentList.length === 0) return;
    const last = currentList[currentList.length - 1];
    const cursorClockIn = last.clock_in;
    const cursorId = last.id;

    setLoadingMore(true);
    const myLoadId = ++loadIdRef.current;

    // Cursor-Filter: (clock_in < c.clock_in) OR (clock_in = c.clock_in AND id > c.id)
    // Reihenfolge in der Query bleibt clock_in DESC, id ASC — Tie-Break bei
    // gleichzeitigen Stempel-Ins deterministisch. Kein NULL-Fall — clock_in ist NOT NULL.
    // Im Recent-Mode ANDet PostgREST das gte-Fenster zum or() dazu.
    const cursorOr = `clock_in.lt.${cursorClockIn},and(clock_in.eq.${cursorClockIn},id.gt.${cursorId})`;

    if (isAllUsersView) {
      let q = supabase
        .from("time_entries")
        .select("id, user_id, job_id, project_id, clock_in, clock_out, description, notes, job:jobs(job_number, title), project:projects(project_number, title)")
        .or(cursorOr);
      if (!isArchive) q = q.gte("clock_in", fromTs);
      q = q.order("clock_in", { ascending: false }).order("id", { ascending: true }).limit(pageSize + 1);
      const { data, error } = await q;
      if (myLoadId !== loadIdRef.current) { setLoadingMore(false); return; }
      if (error) TOAST.supabaseError(error, "Stempel-Einträge konnten nicht geladen werden");
      const rows = (data as unknown as ScopedEntry[]) ?? [];
      setHasMore(rows.length > pageSize);
      setScopedEntries((prev) => [...prev, ...rows.slice(0, pageSize)]);
    } else if (isOwnView) {
      if (!currentUserId) { setLoadingMore(false); return; }
      let q = supabase
        .from("time_entries")
        .select("id, job_id, project_id, clock_in, clock_out, description, notes, job:jobs(job_number, title), project:projects(project_number, title)")
        .eq("user_id", currentUserId)
        .or(cursorOr);
      if (!isArchive) q = q.gte("clock_in", fromTs);
      q = q.order("clock_in", { ascending: false }).order("id", { ascending: true }).limit(pageSize + 1);
      const { data, error } = await q;
      if (myLoadId !== loadIdRef.current) { setLoadingMore(false); return; }
      if (error) TOAST.supabaseError(error, "Stempel-Einträge konnten nicht geladen werden");
      const rows = (data as unknown as OwnEntry[]) ?? [];
      setHasMore(rows.length > pageSize);
      setOwnEntries((prev) => [...prev, ...rows.slice(0, pageSize)]);
    } else {
      if (!selectedUserId) { setLoadingMore(false); return; }
      let q = supabase
        .from("time_entries")
        .select("id, user_id, job_id, project_id, clock_in, clock_out, description, notes, job:jobs(job_number, title), project:projects(project_number, title)")
        .eq("user_id", selectedUserId)
        .or(cursorOr);
      if (!isArchive) q = q.gte("clock_in", fromTs);
      q = q.order("clock_in", { ascending: false }).order("id", { ascending: true }).limit(pageSize + 1);
      const { data, error } = await q;
      if (myLoadId !== loadIdRef.current) { setLoadingMore(false); return; }
      if (error) TOAST.supabaseError(error, "Stempel-Einträge konnten nicht geladen werden");
      const rows = (data as unknown as ScopedEntry[]) ?? [];
      setHasMore(rows.length > pageSize);
      setScopedEntries((prev) => [...prev, ...rows.slice(0, pageSize)]);
    }
    setLoadingMore(false);
  }, [
    supabase, viewMode, jobFilterActive, loadingMore, hasMore, fromIso,
    isAllUsersView, isOwnView, selectedUserId, currentUserId,
    ownEntries, scopedEntries,
  ]);

  // Legitimer cascading-Effect: `load` haengt an isOwnView + selectedUserId
  // (die aus State und den vorgelagerten Effekten kommen) — sobald der User
  // im Dropdown wechselt (oder eine Auswahl vom Sanitizer verworfen wird),
  // muss die Query neu feuern. (Die frueher noetige set-state-in-effect-
  // Suppression entfiel, seit currentUserId synchron aus dem
  // PermissionsProvider kommt statt aus einem getUser-Effect.)
  useEffect(() => { load(); }, [load]);

  // Auftragsnummer-Filter mit URL sync + Debounce. Der Input triggert erst nach
  // 300ms den commit-State (der wiederum die Query aufloest) — plus schreibt
  // ?auftrag=... in die URL fuer Reload-Persist + Teilbarkeit. Leerer Input
  // → param loeschen. Andere URL-Params (z.B. tab=stempelzeiten im HR-Hub)
  // bleiben erhalten.
  //
  // Zwei Fallen die dieser Effekt bewusst vermeidet:
  //  1. Initial-Mount-Guard: jobFilterInput ist beim Mount auf den URL-Wert
  //     initialisiert (bereits synchron). Der Effekt darf NICHT beim ersten
  //     Render feuern — sonst wuerde nach 300ms unnoetig die URL neu-geschrieben
  //     und dabei ein via `history.replaceState` gerade gesetzter tab-Param
  //     (z.B. "?tab=stempelzeiten" nach HR-Tab-Klick) aus dem stale searchParams-
  //     Closure heraus wieder ueberschrieben → Tab springt zurueck.
  //  2. `window.history.replaceState` statt `router.replace()`: rein visueller
  //     URL-Update, KEIN Next.js Route-Transition. So triggert der Filter-Rewrite
  //     nicht die URL-Sync-useEffects auf der HR-Seite (die sonst den Tab-State
  //     aus alten Params rekonstruieren wuerden).
  const jobFilterDidMount = useRef(false);
  useEffect(() => {
    if (!jobFilterDidMount.current) {
      jobFilterDidMount.current = true;
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const parsed = parseJobNumber(jobFilterInput);
      setJobFilterNumber(parsed);
      if (typeof window === "undefined") return;
      const url = new URL(window.location.href);
      if (parsed !== null) {
        url.searchParams.set("auftrag", String(parsed));
      } else {
        url.searchParams.delete("auftrag");
      }
      window.history.replaceState({}, "", url.toString());
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [jobFilterInput]);

  /** Oeffnet das Ticket-Modal fuer eine Stempel-Korrektur mit vorbelegten
   *  Feldern. Kombi aus: Payload merken + Modal aufmachen. `payload` kann null
   *  sein — dann ist es der Fallback ohne Prefill (klassischer Top-Button). */
  const openCorrect = useCallback((payload: CorrectPayload | null) => {
    setCorrectPayload(payload);
    setShowStempelTicket(true);
  }, []);

  /** Excel-Download der aktuell sichtbaren Timesheets. Uebergibt genau die
   *  Filter, die die View auch anzeigt: 30-Tage-Range (Recent) oder alle
   *  Eintraege (Archiv, `mode=archive`), User-Auswahl, Auftrags-Nummer.
   *  Der Endpoint erzwingt RLS zusaetzlich serverseitig (Teamleiter/Normal-
   *  User sehen nur ihren Scope). Dateiname reflektiert den Modus. */
  const downloadExcel = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const to = todayLocalIso();
      const isArchive = viewMode === "archive" && !jobFilterActive;
      const params = new URLSearchParams();
      if (isArchive) {
        // Kein from/to → Endpoint laedt alles was der User via RLS sehen darf.
        params.set("mode", "archive");
      } else {
        params.set("from", fromIso);
        params.set("to", to);
      }
      if (jobFilterActive && jobFilterNumber !== null) {
        params.set("auftrag", String(jobFilterNumber));
      } else if (isAllUsersView) {
        params.set("user", "all");
      } else if (!isOwnView && selectedUserId) {
        params.set("user", selectedUserId);
      }
      const res = await fetch(`/api/stempelzeiten/export?${params.toString()}`);
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        toast.error(j?.error || "Excel-Export fehlgeschlagen");
        return;
      }
      const blob = await res.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = isArchive
        ? `stempelzeiten_archiv_${to}.xlsx`
        : `stempelzeiten_${fromIso}_${to}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Excel-Export fehlgeschlagen");
    } finally {
      setExporting(false);
    }
  }, [exporting, fromIso, jobFilterActive, jobFilterNumber, isAllUsersView, isOwnView, selectedUserId, viewMode]);

  async function deleteEntry(id: string, clockIn: string) {
    // Client-side Lock-Check: erspart Roundtrip + zeigt sofortige Meldung.
    // RLS haerte das serverseitig ohnehin ab (Migration 214).
    if (isTimeEntryLocked(clockIn)) {
      toast.error(TIME_ENTRY_LOCK_MESSAGE);
      return;
    }
    const ok = await confirm({
      title: "Eintrag löschen?",
      message: "Der Stempel-Eintrag wird unwiderruflich entfernt.",
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    const { error } = await supabase.from("time_entries").delete().eq("id", id);
    if (error) {
      TOAST.supabaseError(error, "Eintrag konnte nicht gelöscht werden");
      return;
    }
    toast.success("Eintrag gelöscht");
    load();
  }

  const normalized: NormalizedEntry[] = useMemo(() => {
    if (jobFilterActive) {
      if (!jobFilterHeader) return [];
      return jobFilterEntries.map((e) => normalizeJobFilter(e, jobFilterHeader));
    }
    if (isOwnView) {
      return ownEntries.map((e) => normalizeOwn(e, currentUserId));
    }
    return scopedEntries.map((e) => normalizeScoped(e, usersMap));
  }, [jobFilterActive, jobFilterHeader, jobFilterEntries, isOwnView, ownEntries, scopedEntries, usersMap, currentUserId]);

  // Aggregat fuer den Auftrags-Header: Total-Minuten + Anzahl unique
  // Mitarbeiter, die auf dem Auftrag gestempelt haben.
  const jobFilterSummary = useMemo(() => {
    if (!jobFilterActive) return { totalMin: 0, userCount: 0 };
    let total = 0;
    const users = new Set<string>();
    for (const e of jobFilterEntries) {
      users.add(e.user_id);
      if (e.clock_out) {
        total += Math.max(
          0,
          Math.floor((new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 60000),
        );
      }
    }
    return { totalMin: total, userCount: users.size };
  }, [jobFilterActive, jobFilterEntries]);

  const dayBuckets = useMemo(() => buildDayBuckets(normalized), [normalized]);

  // KPI: Diese Woche / Dieser Monat / Ø pro Arbeitstag im Monat.
  // "Heute" faellt bewusst weg — steht ohnehin in der Liste ganz oben.
  const kpi = useMemo(() => {
    const today = todayLocalIso();
    const weekStart = isoWeekStart(today);
    const weekEnd = addDaysIso(weekStart, 6);
    const monthFirst = monthFirstIso(today);
    const monthLast = monthLastIso(today);
    let weekMin = 0, monthMin = 0;
    const daysWithEntries = new Set<string>();
    for (const [date, b] of dayBuckets) {
      if (date >= weekStart && date <= weekEnd) weekMin += b.totalMin;
      if (date >= monthFirst && date <= monthLast) {
        monthMin += b.totalMin;
        daysWithEntries.add(date);
      }
    }
    const avgPerDay = daysWithEntries.size > 0 ? Math.round(monthMin / daysWithEntries.size) : 0;
    return { weekMin, monthMin, avgPerDay, daysWorked: daysWithEntries.size };
  }, [dayBuckets]);

  // Sub-Header-Text pro Ansicht. Aussagekraeftig genug, dass der Nutzer beim
  // Aufmachen sofort weiss "was schaue ich hier gerade an".
  const viewedUserName: string | null = !isOwnView && !isAllUsersView && selectedUserId
    ? (usersMap.get(selectedUserId) ?? null)
    : null;
  const scopeSubLabel: string = isAllUsersView
    ? "Alle Personen"
    : viewedUserName
      ? `Einträge von ${viewedUserName}`
      : "Deine Einträge";

  // Dropdown-Options: Erste Option "Alle Personen" (Sentinel-Id) — zeigt
  // dann alle Rows die der User via RLS sehen darf. Danach der eigene Name
  // mit "(du)"-Marker (Auswahl normalisiert auf null / isOwnView, s.o.
  // setSelectedUserIdAndPersist). Danach die Kollegen: Admin bekommt alle
  // aktiven MA (ausser Partner) via usersMap, Teamleiter nur die eigenen
  // Team-Mitglieder.
  const dropdownItems = useMemo<SelectItem[]>(() => {
    if (!currentUserId || !canSelectOther) return [];
    const items: SelectItem[] = [];
    items.push({
      id: ALL_USERS_SENTINEL,
      label: "Alle Personen",
      sub: canSeeAll ? "Alle Mitarbeiter" : "Dein Team",
    });
    const selfName = usersMap.get(currentUserId);
    if (selfName) items.push({ id: currentUserId, label: `${selfName} (du)` });
    const others: SelectItem[] = [];
    if (canSeeAll) {
      for (const [id, name] of usersMap) {
        if (id !== currentUserId) others.push({ id, label: name });
      }
    } else {
      for (const id of teamMemberIds) {
        if (id === currentUserId) continue;
        const name = usersMap.get(id);
        if (name) others.push({ id, label: name });
      }
    }
    others.sort((a, b) => a.label.localeCompare(b.label, "de-CH"));
    return [...items, ...others];
  }, [currentUserId, canSelectOther, canSeeAll, teamMemberIds, usersMap]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3 min-h-9">
        <div className="flex items-center gap-3 min-w-0">
          {showBackButton && <BackButton fallbackHref="/dashboard" />}
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Stempelzeiten</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {jobFilterActive
                ? (jobFilterHeader
                    ? `Auftrag INT-${jobFilterHeader.job_number} · alle Stempeleinträge`
                    : `Auftragsnummer INT-${jobFilterNumber}`)
                : `${scopeSubLabel} · ${viewMode === "archive"
                    ? "Archiv (alle Einträge)"
                    : `letzte ${DEFAULT_RANGE_DAYS} Tage`}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {can("stempelzeiten:view") && (
            <button
              type="button"
              onClick={downloadExcel}
              disabled={exporting}
              className="kasten kasten-muted"
              data-tooltip="Sichtbare Stempelzeiten als Excel herunterladen"
              data-tooltip-align="end"
            >
              <Download className="h-3.5 w-3.5" />
              {exporting ? "Wird exportiert…" : "Excel"}
            </button>
          )}
          {can("tickets:create") && (
            <button
              type="button"
              onClick={() => openCorrect(null)}
              className="kasten kasten-green"
              data-tooltip="Stempel-Änderung anfragen"
              data-tooltip-align="end"
            >
              <Clock className="h-3.5 w-3.5" />
              Stempel-Änderung
            </button>
          )}
        </div>
      </div>

      {/* Aktiver Eintrag-Banner */}
      {active && (
        <Card className="bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/30">
          <CardContent className="p-4 flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
              </span>
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-green-700 dark:text-green-400">Aktuell eingestempelt</p>
                <p className="text-sm font-medium">
                  {active.job_id ? "Auf einem Auftrag" : (active.description || "Andere Arbeit")}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {/* Inline-Context: falls dieser laufende Stempel-In eigentlich
                  laengst haette out-gestempelt werden sollen — 1-Klick-Weg
                  ins Ticket-Formular mit vorbelegtem time_entry + Start-Zeit.
                  User tippt nur noch die Endzeit + den Grund. */}
              {can("tickets:create") && (
                <button
                  type="button"
                  onClick={() => openCorrect({
                    timeEntryId: active.id,
                    clockIn: active.clock_in,
                    clockOut: null,
                    jobId: active.job_id ?? null,
                  })}
                  className="text-xs font-medium text-green-700 dark:text-green-400 underline underline-offset-2 hover:text-green-800 dark:hover:text-green-300"
                  data-tooltip="Ticket mit vorbelegten Zeiten öffnen"
                >
                  Vergessen auszustempeln?
                </button>
              )}
              <span className="font-mono text-lg font-semibold tabular-nums text-green-700 dark:text-green-400">
                {formatStempelDuration(active.clock_in, now)}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* KPI-Header (3 Kacheln) — bei aktivem Auftrags-Filter verstecken,
          weil "Diese Woche/Monat" auf einen einzelnen Auftrag keinen Sinn ergibt.
          Stattdessen erscheint der Auftrags-Header (siehe unten). */}
      {!jobFilterActive && <KpiHeader kpi={kpi} />}

      {/* Filter-Zeile: Auftragsnummer-Suche + (Admin) Mitarbeiter-Selector */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Auftragsnummer-Filter — 1:1 wie im /auftraege-Filter (fixes "INT-"-Prefix
            als absolute span + shadcn Input, digits-only), fuer app-weite Konsistenz. */}
        <div className="relative w-full sm:w-44">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-mono text-muted-foreground/60 pointer-events-none">
            INT-
          </span>
          <Input
            placeholder="00000"
            value={jobFilterInput}
            onChange={(e) => setJobFilterInput(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (debounceRef.current) clearTimeout(debounceRef.current);
                const parsed = parseJobNumber(jobFilterInput);
                setJobFilterNumber(parsed);
                const params = new URLSearchParams(searchParams.toString());
                if (parsed !== null) params.set("auftrag", String(parsed));
                else params.delete("auftrag");
                const qs = params.toString();
                router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
                e.preventDefault();
              }
              if (e.key === "Escape" && jobFilterInput) {
                setJobFilterInput("");
                e.preventDefault();
              }
            }}
            inputMode="numeric"
            pattern="[0-9]*"
            className="pl-[3rem] h-9 font-mono"
            aria-label="Auftragsnummer"
          />
        </div>

        {/* Modus-Toggle: Recent (letzte 30 Tage, Default) vs Archiv (alles,
            paginiert). Bei aktivem Auftrags-Filter versteckt — der zeigt
            ohnehin alle Eintraege auf dem Auftrag, ein Modus-Toggle waere
            redundant. Kasten-Toggle-Off/Active spiegelt Rest der App. */}
        {!jobFilterActive && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setViewModeAndPersist("recent")}
              className={viewMode === "recent" ? "kasten-active" : "kasten-toggle-off"}
              data-tooltip="Nur die letzten 30 Tage anzeigen"
              aria-pressed={viewMode === "recent"}
            >
              Letzte {DEFAULT_RANGE_DAYS} Tage
            </button>
            <button
              type="button"
              onClick={() => setViewModeAndPersist("archive")}
              className={viewMode === "archive" ? "kasten-active" : "kasten-toggle-off"}
              data-tooltip="Alle Stempeleinträge — paginiert"
              aria-pressed={viewMode === "archive"}
            >
              <Archive className="h-3.5 w-3.5" />
              Archiv
            </button>
          </div>
        )}

        {/* Ansichts-Wechsel — bei Auftrags-Filter ausgeblendet (die Auftrags-
            Ansicht zeigt bewusst alle MA auf dem Auftrag; ein zusaetzlicher
            Person-Filter waere redundant). Nur sichtbar wenn der User
            ueberhaupt jemand anderen sehen darf (Admin oder Teamleiter mit
            Team-Mitgliedern) — Normal-User bekommen nur den Hinweistext. */}
        {!jobFilterActive && canSelectOther && (
          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={() => setSelectedUserIdAndPersist(null)}
              className={isOwnView ? "kasten-active" : "kasten"}
              data-tooltip="Nur eigene Stempel-Einträge"
            >
              Eigene
            </button>
            <div className="w-56">
              <SearchableSelect
                value={isOwnView ? "" : (selectedUserId ?? "")}
                onChange={(id) => setSelectedUserIdAndPersist(id || null)}
                items={dropdownItems}
                placeholder="Person wählen…"
                active={!isOwnView}
              />
            </div>
          </div>
        )}

      </div>

      {/* Auftrags-Header — bei aktivem Auftrags-Filter + gefundenem Auftrag */}
      {jobFilterActive && jobFilterHeader && !loading && (
        <JobFilterSummaryCard
          job={jobFilterHeader}
          totalMin={jobFilterSummary.totalMin}
          userCount={jobFilterSummary.userCount}
          entryCount={jobFilterEntries.length}
        />
      )}

      {/* Body */}
      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <Card key={i} className="animate-pulse bg-card"><CardContent className="p-4 h-16" /></Card>)}</div>
      ) : jobFilterActive && jobLookupState === "not_found" ? (
        <Card className="bg-card border-dashed">
          <CardContent className="py-16 text-center">
            <div className="mx-auto w-14 h-14 rounded-2xl bg-muted flex items-center justify-center mb-4">
              <Search className="h-7 w-7 text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-lg">Kein Auftrag gefunden</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Es gibt keinen Auftrag mit Nummer INT-{jobFilterNumber}.
            </p>
          </CardContent>
        </Card>
      ) : normalized.length === 0 ? (
        <Card className="bg-card border-dashed">
          <CardContent className="py-16 text-center">
            <div className="mx-auto w-14 h-14 rounded-2xl bg-muted flex items-center justify-center mb-4">
              <Clock className="h-7 w-7 text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-lg">Keine Einträge</h3>
            <p className="text-sm text-muted-foreground mt-1">
              {jobFilterActive
                ? `Auf INT-${jobFilterNumber} wurde bisher nicht gestempelt.`
                : viewMode === "archive"
                  ? isAllUsersView
                    ? "Es gibt keine Stempeleinträge."
                    : isOwnView
                      ? "Du hast bisher nicht gestempelt."
                      : `${viewedUserName ?? "Dieser Mitarbeiter"} hat bisher nicht gestempelt.`
                  : isAllUsersView
                    ? `In den letzten ${DEFAULT_RANGE_DAYS} Tagen wurde nicht gestempelt.`
                    : isOwnView
                      ? `Du hast in den letzten ${DEFAULT_RANGE_DAYS} Tagen nicht gestempelt.`
                      : `${viewedUserName ?? "Dieser Mitarbeiter"} hat in den letzten ${DEFAULT_RANGE_DAYS} Tagen nicht gestempelt.`}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <GroupedList
            entries={normalized}
            now={now}
            currentUserId={currentUserId}
            canCreateTicket={can("tickets:create")}
            onDelete={deleteEntry}
            onCorrect={openCorrect}
          />
          {/* "Mehr laden" — wenn mehr Seiten da sind (Archiv ODER volle
              Recent-Seite) und die Liste nicht gerade neu-geladen wird.
              Klick fordert die naechste Seite via Cursor an. */}
          {!jobFilterActive && hasMore && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="kasten kasten-muted"
                aria-label="Weitere Stempel-Einträge laden"
              >
                {loadingMore ? <Spinner size={14} /> : <ChevronDown className="h-3.5 w-3.5" />}
                {loadingMore ? "Lade…" : "Mehr laden"}
              </button>
            </div>
          )}
        </>
      )}

      {ConfirmModalElement}

      <NewTicketModal
        open={showStempelTicket}
        onClose={() => { setShowStempelTicket(false); setCorrectPayload(null); }}
        onCreated={() => {
          setShowStempelTicket(false);
          setCorrectPayload(null);
          toast.success("Ticket erstellt — Admin wurde benachrichtigt");
        }}
        initialType="stempel_aenderung"
        initialData={correctPayload ? {
          timeEntryId: correctPayload.timeEntryId,
          clockIn: correctPayload.clockIn,
          clockOut: correctPayload.clockOut,
          jobId: correctPayload.jobId,
        } : undefined}
      />
    </div>
  );
}

// ------------------ KPI-Header ------------------

interface KpiData {
  weekMin: number;
  monthMin: number;
  avgPerDay: number;
  daysWorked: number;
}
function KpiHeader({ kpi }: { kpi: KpiData }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
      <KpiCard label="Diese Woche" value={formatDuration(kpi.weekMin)} />
      <KpiCard
        label="Dieser Monat"
        value={formatDuration(kpi.monthMin)}
        sub={`${kpi.daysWorked} ${kpi.daysWorked === 1 ? "Arbeitstag" : "Arbeitstage"}`}
      />
      <KpiCard
        label="Ø pro Arbeitstag"
        value={formatDuration(kpi.avgPerDay)}
        sub="im aktuellen Monat"
      />
    </div>
  );
}
function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="bg-card">
      <CardContent className="p-3">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{label}</p>
        <p className="text-xl font-bold tabular-nums mt-0.5">{value}</p>
        {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// ------------------ Auftrags-Header (Summary) ------------------

/**
 * Kopf-Karte fuer den Auftragsnummer-Filter:
 * INT-XX · Titel · Kunde · Total-Stunden · Anzahl MA · Anzahl Eintraege.
 * Bewusst kompakt, single-row auf Desktop. Klick auf INT-Pill fuehrt in den
 * Auftrag rein.
 */
function JobFilterSummaryCard({
  job, totalMin, userCount, entryCount,
}: {
  job: JobFilterHeader;
  totalMin: number;
  userCount: number;
  entryCount: number;
}) {
  return (
    <Card className="bg-card border-red-200 dark:border-red-500/30">
      <CardContent className="p-3 sm:p-4 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-9 h-9 rounded-md bg-red-50 dark:bg-red-500/15 text-red-600 dark:text-red-400 flex items-center justify-center shrink-0">
            <Briefcase className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                href={`/auftraege/${job.id}`}
                className="hover:opacity-80 transition-opacity"
                data-tooltip="Auftrag öffnen"
              >
                <JobNumber number={job.job_number} size="md" />
              </Link>
              <span className="font-semibold text-sm truncate">{job.title}</span>
            </div>
            {job.customer?.name && (
              <p className="text-xs text-muted-foreground truncate mt-0.5">
                {job.customer.name}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4 sm:gap-6 sm:ml-auto tabular-nums">
          <div className="flex flex-col items-end">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Total</span>
            <span className="text-lg font-bold">{formatDuration(totalMin)}</span>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1">
              <Users className="h-2.5 w-2.5" />Mitarbeiter
            </span>
            <span className="text-lg font-bold">{userCount}</span>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Einträge</span>
            <span className="text-lg font-bold">{entryCount}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ------------------ Grouped List ------------------

function GroupedList({
  entries, now, currentUserId, canCreateTicket, onDelete, onCorrect,
}: {
  entries: NormalizedEntry[];
  now: number;
  currentUserId: string | null;
  canCreateTicket: boolean;
  onDelete: (id: string, clockIn: string) => void;
  onCorrect: (payload: CorrectPayload) => void;
}) {
  // Gruppieren nach clock_in.localDate. Sortiert: neueste Tage zuerst.
  const groups = useMemo(() => {
    const map = new Map<string, NormalizedEntry[]>();
    for (const e of entries) {
      const d = localDateIso(new Date(e.clockIn));
      const arr = map.get(d) ?? [];
      arr.push(e);
      map.set(d, arr);
    }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [entries]);

  return (
    <div className="space-y-4">
      {groups.map(([date, list]) => {
        const total = list.reduce((s, e) => s + (e.durationMinutes ?? 0), 0);
        const wd = weekdayForDateIso(date);
        const isWeekend = wd === 0 || wd === 6;
        return (
          <div key={date}>
            <div className={`flex items-center justify-between gap-2 mb-2 sticky top-0 z-10 bg-background/95 backdrop-blur py-1 border-b ${isWeekend ? "border-amber-200 dark:border-amber-500/30" : "border-border"}`}>
              <div className="flex items-center gap-2">
                <Calendar className={`h-3.5 w-3.5 ${isWeekend ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`} />
                <span className="text-xs font-semibold uppercase tracking-wider">{formatLongDate(date)}</span>
                {isWeekend && <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">Wochenende</span>}
              </div>
              <span className="text-xs font-bold tabular-nums">{formatDuration(total)}</span>
            </div>
            <div className="rounded-xl border border-border bg-card divide-y divide-border [&>*:first-child]:rounded-t-xl [&>*:last-child]:rounded-b-xl">
              {list.map((e) => (
                <EntryCard
                  key={e.id}
                  entry={e}
                  anomaly={detectAnomaly(e, now)}
                  isOwn={!!currentUserId && e.userId === currentUserId}
                  canCreateTicket={canCreateTicket}
                  onDelete={() => onDelete(e.id, e.clockIn)}
                  onCorrect={() => onCorrect({
                    timeEntryId: e.id,
                    clockIn: e.clockIn,
                    clockOut: e.clockOut,
                    jobId: e.jobId,
                  })}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ------------------ Entry-Card (mit Anomalien-Chips inline) ------------------

function EntryCard({
  entry, anomaly, isOwn, canCreateTicket, onDelete, onCorrect,
}: {
  entry: NormalizedEntry;
  anomaly: Anomaly;
  /** True wenn dieser Eintrag dem eingeloggten User gehoert — nur dann darf
   *  der Row-"Korrigieren"-Button erscheinen (Ticket-Erstellung fuer fremde
   *  Eintraege macht keinen Sinn, das Ticket landet immer auf created_by). */
  isOwn: boolean;
  canCreateTicket: boolean;
  onDelete: () => void;
  onCorrect: () => void;
}) {
  const isRunning = !entry.clockOut;
  // Lock-Check: nach 5. des Folgemonats ist der Eintrag abgerechnet und
  // darf weder korrigiert noch geloescht werden (spiegelt Migration 214-RLS).
  const locked = isTimeEntryLocked(entry.clockIn);
  return (
    <div className={`px-3 py-2 flex items-center gap-2.5 transition-colors ${locked
      ? "bg-muted/20 opacity-70"
      : "hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]"
    }`}>
      {entry.userName ? (
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold text-white"
          style={{ backgroundColor: colorForName(entry.userName) }}
          data-tooltip={entry.userName}
        >
          {initials(entry.userName)}
        </div>
      ) : (
        <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
          entry.jobLabel ? "bg-red-50 dark:bg-red-500/15 text-red-600 dark:text-red-400"
                         : "bg-amber-50 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400"
        }`}>
          {entry.jobLabel ? <Briefcase className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          {entry.userName && (
            <span className="text-xs font-bold shrink-0" style={{ color: colorForName(entry.userName) }}>
              {entry.userName}
            </span>
          )}
          {entry.jobLabel ? (
              entry.jobHref ? (
                <Link href={entry.jobHref} className="font-medium text-sm hover:underline truncate">{entry.jobLabel}</Link>
              ) : (
                <span className="font-medium text-sm truncate">{entry.jobLabel}</span>
              )
            ) : (
              <span className="font-medium text-sm truncate">{entry.description || "Andere Arbeit"}</span>
            )}
          {isRunning && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0 text-[10px] font-semibold rounded-full bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300 shrink-0">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500" />Läuft
            </span>
          )}
          {anomaly.longShift && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0 text-[10px] font-semibold rounded-full bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300 shrink-0" data-tooltip="Schicht ueber 10 Stunden">
              <AlertTriangle className="h-2.5 w-2.5" />Lang
            </span>
          )}
          {anomaly.crossesMidnight && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0 text-[10px] font-semibold rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300 shrink-0" data-tooltip="Geht ueber Mitternacht">
              <Moon className="h-2.5 w-2.5" />Nacht
            </span>
          )}
          {anomaly.forgotten && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0 text-[10px] font-semibold rounded-full bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300 shrink-0" data-tooltip="Kein Stempel-Out seit >18h — vermutlich vergessen">
              <AlertTriangle className="h-2.5 w-2.5" />Vergessen?
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground tabular-nums truncate flex items-center gap-1">
          {locked && (
            <Lock
              className="h-3 w-3 text-muted-foreground/70 shrink-0"
              data-tooltip={TIME_ENTRY_LOCK_MESSAGE}
            />
          )}
          <span className="truncate">
            {formatDateTime(entry.clockIn)}{entry.clockOut ? ` – ${formatDateTime(entry.clockOut)}` : ""}
            {entry.jobLabel && entry.description ? <span className="ml-2 italic">· {entry.description}</span> : null}
          </span>
        </p>
      </div>
      <span className="font-mono font-semibold text-sm tabular-nums shrink-0">
        {entry.durationMinutes !== null ? formatDuration(entry.durationMinutes) : "läuft…"}
      </span>
      {/* Row-"Korrigieren" — Inline-Context, oeffnet Stempel-Aenderungs-Ticket
          mit vorbelegtem time_entry + Start + Ende. Nur bei eigenen Eintraegen
          (fremde Korrekturen sind nicht Sinn der Sache), nur wenn User Rechte
          fuer Ticket-Erstellung hat. Bei abgerechneten Eintraegen disabled +
          Tooltip — apply_ticket wuerde eh mit HTTP 423 abbrechen. */}
      {isOwn && canCreateTicket && (
        <button
          type="button"
          onClick={locked ? undefined : onCorrect}
          disabled={locked}
          className={`p-1 rounded transition-colors shrink-0 ${locked
            ? "text-muted-foreground/25 cursor-not-allowed"
            : "text-muted-foreground/40 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-500/10"
          }`}
          aria-label="Eintrag korrigieren"
          data-tooltip={locked ? TIME_ENTRY_LOCK_MESSAGE : "Korrigieren — Ticket mit vorbelegten Zeiten öffnen"}
          data-tooltip-align="end"
        >
          <Edit3 className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        type="button"
        onClick={locked ? undefined : onDelete}
        disabled={locked}
        className={`p-1 rounded transition-colors shrink-0 ${locked
          ? "text-muted-foreground/25 cursor-not-allowed"
          : "text-muted-foreground/40 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10"
        }`}
        aria-label="Eintrag löschen"
        data-tooltip={locked ? TIME_ENTRY_LOCK_MESSAGE : undefined}
        data-tooltip-align="end"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
