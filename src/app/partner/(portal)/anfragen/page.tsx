"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/searchable-select";
import { Plus, Clock, Check, XCircle, FileText, Search, Pencil, Archive } from "lucide-react";

interface PartnerAnfrage {
  id: string;
  job_number: number | null;
  title: string;
  start_date: string | null;
  end_date: string | null;
  status: string;
  created_at: string;
  partner_response_message: string | null;
  appointments: { id: string; assigned_to: string | null }[] | null;
}

function statusStyle(status: string) {
  switch (status) {
    case "partner_entwurf":
      // Grau / neutral — soll klar "noch nicht abgeschickt" kommunizieren.
      return { label: "Entwurf", icon: Pencil, bg: "bg-foreground/[0.05] dark:bg-foreground/10", text: "text-muted-foreground", border: "border-foreground/15 dark:border-foreground/20" };
    case "partner_anfrage":
      return { label: "Anfrage offen", icon: Clock, bg: "bg-amber-50 dark:bg-amber-500/15", text: "text-amber-800 dark:text-amber-300", border: "border-amber-200 dark:border-amber-500/30" };
    case "offen":
    case "abgeschlossen":
      return { label: status === "offen" ? "Bestätigt" : "Abgeschlossen", icon: Check, bg: "bg-green-50 dark:bg-green-500/15", text: "text-green-800 dark:text-green-300", border: "border-green-200 dark:border-green-500/30" };
    case "storniert":
      return { label: "Abgelehnt", icon: XCircle, bg: "bg-red-50 dark:bg-red-500/15", text: "text-red-800 dark:text-red-300", border: "border-red-200 dark:border-red-500/30" };
    default:
      return { label: status, icon: Clock, bg: "bg-muted/30", text: "text-foreground/70", border: "border-border" };
  }
}

type StatusFilter = "all" | "partner_entwurf" | "partner_anfrage" | "offen" | "storniert" | "abgeschlossen";
const STATUS_FILTER_ITEMS = [
  { id: "all" as StatusFilter, label: "Alle Status" },
  { id: "partner_entwurf" as StatusFilter, label: "Entwurf" },
  { id: "partner_anfrage" as StatusFilter, label: "Wartet" },
  { id: "offen" as StatusFilter, label: "Bestätigt" },
  { id: "abgeschlossen" as StatusFilter, label: "Abgeschlossen" },
  { id: "storniert" as StatusFilter, label: "Abgelehnt" },
];

function todayIsoDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function PartnerAnfragenPage() {
  const router = useRouter();
  const supabase = createClient();
  const [anfragen, setAnfragen] = useState<PartnerAnfrage[]>([]);
  const [assigneeNameById, setAssigneeNameById] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  // Filter-State — alle persistent in localStorage damit der Partner beim
  // Tab-Wechsel nicht den Filter verliert.
  const [filterStatus, setFilterStatus] = useState<StatusFilter>(() =>
    typeof window !== "undefined"
      ? ((localStorage.getItem("partner-anfragen-status") as StatusFilter | null) || "all")
      : "all"
  );
  const [searchNumber, setSearchNumber] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem("partner-anfragen-search-number") || "" : ""
  );
  const [searchTitle, setSearchTitle] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem("partner-anfragen-search-title") || "" : ""
  );
  // Archiv-Toggle: zeigt Anfragen deren Veranstaltungs-Datum vorbei ist
  // (start_date < heute), egal welcher Status. Standard = false (Aktive).
  const [showArchive, setShowArchive] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem("partner-anfragen-archive") === "true" : false
  );

  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("partner-anfragen-status", filterStatus);
  }, [filterStatus]);
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("partner-anfragen-search-number", searchNumber);
  }, [searchNumber]);
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("partner-anfragen-search-title", searchTitle);
  }, [searchTitle]);
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("partner-anfragen-archive", String(showArchive));
  }, [showArchive]);

  // Debounce: bei Tipp-Suche nicht jeden Tastenanschlag eine DB-Query.
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // DB-Query reagiert auf alle drei Filter — server-seitig damit es bei
  // wachsendem Datenvolumen skaliert (siehe /auftraege im Firmenportal).
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(async () => {
      setLoading(true);
      // RLS laesst den Partner alle Jobs an seiner Location sehen (damit
      // der Belegungsplan funktioniert). In "Meine Anfragen" wollen wir
      // alle Partner-originierten Jobs der Location — sodass alle Partner-
      // Mitarbeiter derselben Location dieselbe Anfragen-Liste sehen (Team-
      // Setup statt 1-User-pro-Location). Eventline-interne Auftraege/
      // Vermietentwuerfe an der gleichen Location bleiben raus.
      //
      // "Partner-originiert" = entweder noch im partner-Status (Entwurf/
      // Anfrage) ODER bereits angenommen/abgelehnt (accepted_at oder
      // rejected_at gesetzt — die werden von /api/jobs/[id]/partner-decision
      // gesetzt wenn EVENTLINE entscheidet).
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }
      const { data: profileRow } = await supabase
        .from("profiles")
        .select("partner_location_id")
        .eq("id", user.id)
        .maybeSingle();
      const locId = profileRow?.partner_location_id ?? null;
      if (!locId) { setAnfragen([]); setLoading(false); return; }
      let q = supabase
        .from("jobs")
        .select("id, job_number, title, start_date, end_date, status, created_at, partner_response_message, appointments:job_appointments(id, assigned_to)")
        .eq("location_id", locId)
        .or("status.in.(partner_entwurf,partner_anfrage),accepted_at.not.is.null,rejected_at.not.is.null");
      // Aktiv- vs Archiv-Split nach Datum: vergangene = Archiv. Anfragen
      // OHNE start_date bleiben aktiv (Entwurf ohne Datum gehoert in den
      // aktiven Bereich, damit man sie noch ausfuellen kann).
      const today = todayIsoDate();
      if (showArchive) {
        q = q.not("start_date", "is", null).lt("start_date", today);
      } else {
        q = q.or(`start_date.is.null,start_date.gte.${today}`);
      }
      if (filterStatus !== "all") q = q.eq("status", filterStatus);
      const titleQ = searchTitle.trim();
      if (titleQ) q = q.ilike("title", `%${titleQ}%`);
      // INT-Nr-Filter wird unten client-seitig gemacht (auf job_number::text
      // ilike funktioniert die PostgREST-Cast-Syntax im Query-Builder nicht
      // zuverlaessig; Partner hat eh max ~100 Anfragen → instant).
      const [jobsRes, usersRes] = await Promise.all([
        q
          // Aktiv: naechstes Event zuerst. Archiv: juengstes vergangenes zuerst.
          .order("start_date", { ascending: !showArchive, nullsFirst: false })
          .limit(100),
        // SECURITY DEFINER-Funktion: liefert id/full_name aller aktiven
        // EVENTLINE-Mitarbeiter. Partner braucht das um assigned_to-UUIDs
        // in lesbare Namen aufzuloesen — direkter Profile-Join scheitert an
        // der profiles-RLS (eigenes Profil + Admin only).
        supabase.rpc("get_assignable_users"),
      ]);
      setAnfragen((jobsRes.data ?? []) as PartnerAnfrage[]);
      const map = new Map<string, string>();
      for (const u of (usersRes.data as { id: string; full_name: string }[] | null) ?? []) {
        map.set(u.id, u.full_name);
      }
      setAssigneeNameById(map);
      setLoading(false);
    }, 250);
    return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStatus, searchTitle, showArchive]);

  // INT-Nummer-Suche: client-seitig auf job_number per substring/prefix.
  // Reaktion instant (kein Reload bei jedem Tastenanschlag).
  const visibleAnfragen = useMemo(() => {
    const numQ = searchNumber.trim();
    if (!numQ) return anfragen;
    return anfragen.filter((a) =>
      a.job_number !== null && String(a.job_number).includes(numQ)
    );
  }, [anfragen, searchNumber]);

  const hasSearch = searchTitle.trim().length > 0 || searchNumber.trim().length > 0 || filterStatus !== "all";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Meine Anfragen</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Erstelle Anfragen für Veranstaltungen an deinem Standort. EVENTLINE bestätigt oder lehnt ab.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowArchive((v) => !v)}
            className={showArchive ? "kasten-active" : "kasten-toggle-off"}
            data-tooltip={showArchive ? "Aktive Anfragen anzeigen" : "Vergangene Anfragen anzeigen"}
          >
            <Archive className="h-3.5 w-3.5" />
            {showArchive ? "Archiv" : "Archiv"}
          </button>
          <button
            type="button"
            onClick={() => router.push("/partner/anfragen/neu")}
            className="kasten kasten-red"
          >
            <Plus className="h-3.5 w-3.5" />
            Neue Anfrage
          </button>
        </div>
      </div>

      {/* Such- und Filter-Bar — exakt gleiche Struktur wie /auftraege im
          Firmenportal: INT-Nr-Feld (numerisch, mono), Titel-Feld (flex-1),
          Status-Dropdown (SearchableSelect). */}
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
            aria-label="Anfragen-Nummer"
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
            onChange={(v) => setFilterStatus(v as StatusFilter)}
            items={STATUS_FILTER_ITEMS}
            searchable={false}
            clearable={false}
            active={filterStatus !== "all"}
          />
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse bg-card">
              <CardContent className="p-4">
                <div className="h-5 bg-foreground/10 dark:bg-foreground/15 rounded w-1/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : visibleAnfragen.length === 0 ? (
        <Card className="bg-card border-dashed">
          <CardContent className="py-16 text-center">
            <div className="mx-auto w-14 h-14 rounded-2xl bg-foreground/10 dark:bg-foreground/15 flex items-center justify-center mb-4">
              <FileText className="h-7 w-7 text-foreground/40" />
            </div>
            <h3 className="font-semibold text-lg">
              {hasSearch ? "Keine Treffer" : showArchive ? "Archiv ist leer" : "Noch keine Anfragen"}
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              {hasSearch
                ? "Versuch einen anderen Filter oder Suchbegriff."
                : showArchive
                  ? "Vergangene Anfragen landen automatisch hier."
                  : "Klick auf „Neue Anfrage“ um zu starten."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {visibleAnfragen.map((a) => {
            const s = statusStyle(a.status);
            const Icon = s.icon;
            // Termin-Zuweisungs-Anzeige nur fuer angenommene/laufende
            // Anfragen sinnvoll. partner_anfrage = noch nicht angenommen;
            // storniert = abgelehnt. abgeschlossen darf weiter Namen zeigen.
            const showAssignmentInfo = a.status === "offen" || a.status === "abgeschlossen";
            const appts = a.appointments ?? [];
            const hasAppt = appts.length > 0;
            const assignedIds = Array.from(new Set(appts.map((x) => x.assigned_to).filter((x): x is string => !!x)));
            const assigneeNames = assignedIds.map((id) => assigneeNameById.get(id)).filter((n): n is string => !!n);
            const isUnassigned = showAssignmentInfo && hasAppt && assigneeNames.length === 0;
            const isAssigned = showAssignmentInfo && assigneeNames.length > 0;
            const dateText = a.start_date
              ? new Date(a.start_date).toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric" })
                + (a.end_date && a.end_date !== a.start_date ? " – " + new Date(a.end_date).toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric" }) : "")
              : "";
            // Rechts-Inhalt zentral pro Karte — einmal definiert, in Mobile-
            // und Desktop-Branch identisch wiederverwendet.
            const rightSide = isUnassigned ? (
              <span className="text-xs font-medium whitespace-nowrap text-amber-700 dark:text-amber-300">Termin nicht zugewiesen</span>
            ) : isAssigned ? (
              <span className="text-xs font-medium whitespace-nowrap text-emerald-700 dark:text-emerald-300 truncate max-w-[180px]" title={assigneeNames.join(", ")}>
                {assigneeNames.join(", ")}
              </span>
            ) : null;
            return (
              <Link key={a.id} href={`/partner/anfragen/${a.id}`} className="block group">
                <Card className="auftrag-card-hover relative bg-card cursor-pointer">
                  {/* Mobile: 2-Zeilen-Stack. INT-Nr bewusst ausgeblendet —
                      ist EVENTLINE-interne Job-Nummer, fuer Partner-Sicht
                      nicht relevant. Bleibt nur auf Detail-Page sichtbar. */}
                  <div className="md:hidden px-3 py-2.5 flex flex-col gap-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md border shrink-0 ${s.bg} ${s.text} ${s.border}`}>
                        <Icon className="h-3 w-3" />
                        {s.label}
                      </span>
                      <span className="auftrag-card-title font-medium text-sm truncate transition-colors flex-1 min-w-0">{a.title}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {dateText && <span className="text-muted-foreground/70 text-[11px] whitespace-nowrap truncate">{dateText}</span>}
                      </div>
                      {rightSide && <div className="shrink-0">{rightSide}</div>}
                    </div>
                    {a.status === "storniert" && a.partner_response_message && (
                      <p className="text-[11px] text-red-700 dark:text-red-300 truncate" title={a.partner_response_message}>
                        Grund: {a.partner_response_message}
                      </p>
                    )}
                  </div>

                  {/* Desktop: Grid-Layout. INT-Spalte gegenueber dem
                      Firmenportal weggelassen (Partner-Sicht). */}
                  <div
                    className="hidden md:grid px-4 py-2 items-center gap-x-3"
                    style={{ gridTemplateColumns: "minmax(110px, 130px) minmax(140px, 260px) minmax(0, 1fr) minmax(110px, 180px) minmax(0, 1fr) minmax(120px, 200px)" }}
                  >
                    {/* Col 1: Status-Pille */}
                    <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md border w-fit ${s.bg} ${s.text} ${s.border}`}>
                      <Icon className="h-3 w-3" />
                      {s.label}
                    </span>

                    {/* Col 2: Titel + ggf. Grund bei Stornierung */}
                    <div className="min-w-0">
                      <span className="auftrag-card-title font-medium text-sm truncate transition-colors block">{a.title}</span>
                      {a.status === "storniert" && a.partner_response_message && (
                        <span className="text-[11px] text-red-700 dark:text-red-300 truncate block" title={a.partner_response_message}>
                          Grund: {a.partner_response_message}
                        </span>
                      )}
                    </div>

                    {/* Col 3: Spacer */}
                    <div />

                    {/* Col 4: Datum */}
                    <span className="text-xs text-muted-foreground whitespace-nowrap truncate">
                      {dateText || "—"}
                    </span>

                    {/* Col 5: Spacer */}
                    <div />

                    {/* Col 6: Rechts — Termin-Status */}
                    <div className="flex justify-end">
                      {rightSide}
                    </div>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
