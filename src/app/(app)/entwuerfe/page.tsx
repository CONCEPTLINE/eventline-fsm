"use client";

/**
 * /entwuerfe — Auftrags-Entwuerfe (job_drafts).
 *
 * Getrennt von /auftraege weil andere Beduerfnisse:
 *   - viele Kunden-Kontakte, Notizen-Historie
 *   - EIN Owner (verantwortliche Person)
 *   - Datum oft Jahre in Zukunft (unklar, tentativ)
 *   - Umwandlung in Auftrag ist bewusster Schritt
 *
 * Layout analog zu /auftraege: h1 + Neuer-Entwurf-Button rechts,
 * Segment-Toggle EIN Button (Aktiv <-> Storniert), Suchfeld, Kartenliste.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, Search, X, ClipboardEdit, Archive, User as UserIcon, MapPin, Calendar, MessageSquare, ArrowRightCircle, List, LayoutGrid } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StickyFilterBar } from "@/components/ui/sticky-filter-bar";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchableSelect } from "@/components/searchable-select";
import { toast } from "sonner";

type Segment = "active_group" | "storniert";
type View = "liste" | "karten";

interface DraftListRow {
  id: string;
  draft_number: number;
  title: string;
  status: "aktiv" | "wartet_auf_kunde" | "storniert" | "umgewandelt";
  source: string;
  expected_start_date: string | null;
  expected_end_date: string | null;
  guest_count: number | null;
  owner_id: string | null;
  customer_id: string | null;
  customer_name: string | null;
  location_name: string | null;
  contact_person: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  location_id: string | null;
  created_at: string;
  updated_at: string;
  converted_to_job_id: string | null;
  converted_at: string | null;
  customer: { id: string; name: string } | null;
  location: { id: string; name: string } | null;
  owner: { id: string; full_name: string } | null;
  // Supabase count-aggregate kommt als [{ count: N }].
  notes_count: { count: number }[] | null;
}

interface OwnerOption {
  id: string;
  full_name: string;
}

// LS-Keys projekt-eindeutig — sonst Kollision mit /auftraege
const LS_SEGMENT = "entwuerfe-segment";
const LS_SEARCH = "entwuerfe-search";
const LS_OWNER = "entwuerfe-owner";
const LS_VIEW = "entwuerfe-view";

const STATUS_CHIP: Record<DraftListRow["status"], { label: string; color: string }> = {
  aktiv: { label: "Aktiv", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300" },
  wartet_auf_kunde: { label: "Wartet auf Kunde", color: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300" },
  storniert: { label: "Storniert", color: "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300" },
  umgewandelt: { label: "Umgewandelt", color: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300" },
};

function formatDateRange(from: string | null, to: string | null): string {
  if (!from && !to) return "";
  const fmt = (iso: string) =>
    new Date(iso + "T12:00:00").toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" });
  if (from && to && from !== to) return `${fmt(from)} – ${fmt(to)}`;
  return fmt(from ?? to!);
}

export default function EntwuerfePage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Segment: URL first, sonst LS, sonst active_group.
  function resolveInitialSegment(): Segment {
    if (typeof window === "undefined") return "active_group";
    const fromUrl = searchParams.get("segment");
    if (fromUrl === "aktiv" || fromUrl === "active_group") return "active_group";
    if (fromUrl === "storniert") return "storniert";
    const fromLs = localStorage.getItem(LS_SEGMENT);
    if (fromLs === "storniert") return "storniert";
    return "active_group";
  }
  const [segment, setSegment] = useState<Segment>(resolveInitialSegment);
  const [search, setSearch] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem(LS_SEARCH) ?? "" : "",
  );
  const [filterOwner, setFilterOwner] = useState<string>(() =>
    typeof window !== "undefined" ? localStorage.getItem(LS_OWNER) ?? "" : "",
  );
  const [view, setView] = useState<View>(() => {
    if (typeof window === "undefined") return "liste";
    const v = localStorage.getItem(LS_VIEW);
    return v === "karten" ? "karten" : "liste";
  });
  const [drafts, setDrafts] = useState<DraftListRow[]>([]);
  const [owners, setOwners] = useState<OwnerOption[]>([]);
  const [loading, setLoading] = useState(true);

  // Persist filter/segment. §10: Reload landet wieder im gleichen Zustand.
  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(LS_SEGMENT, segment);
    const params = new URLSearchParams(searchParams.toString());
    params.set("segment", segment === "active_group" ? "aktiv" : "storniert");
    router.replace(`/entwuerfe?${params.toString()}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment]);
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem(LS_SEARCH, search);
  }, [search]);
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem(LS_OWNER, filterOwner);
  }, [filterOwner]);
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem(LS_VIEW, view);
  }, [view]);

  const loadDrafts = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    params.set("status", segment);
    if (search.trim()) params.set("search", search.trim());
    if (filterOwner) params.set("owner_id", filterOwner);
    try {
      const res = await fetch(`/api/entwuerfe?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!json.success) {
        toast.error(json.error ?? "Konnte Entwürfe nicht laden");
        setDrafts([]);
        return;
      }
      setDrafts(json.drafts as DraftListRow[]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Netzwerk-Fehler");
      setDrafts([]);
    } finally {
      setLoading(false);
    }
  }, [segment, search, filterOwner]);

  // Debounce nur fuer Suche.
  useEffect(() => {
    const t = setTimeout(() => {
      loadDrafts();
    }, 200);
    return () => clearTimeout(t);
  }, [loadDrafts]);

  // Team-Mitglieder fuer Owner-Filter. RPC bestehend seit /auftraege.
  useEffect(() => {
    let alive = true;
    (async () => {
      // Wir nutzen dieselbe RPC wie /auftraege/[id] (get_assignable_users).
      // Fallback: falls RPC nicht existiert, Dropdown zeigt "Alle" only.
      try {
        const { createClient } = await import("@/lib/supabase/client");
        const supabase = createClient();
        const { data } = await supabase.rpc("get_assignable_users");
        if (!alive) return;
        setOwners((data as OwnerOption[]) ?? []);
      } catch {
        /* still functional ohne Owner-Filter */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const anyFilter = search.trim().length > 0 || !!filterOwner;
  const total = drafts.length;

  const ownerOptions = useMemo(
    () => [
      { id: "", label: "Alle Verantwortlichen" },
      ...owners.map((o) => ({ id: o.id, label: o.full_name })),
    ],
    [owners],
  );

  return (
    <div className="space-y-6 page-enter">
      {/* Kompletter Kopf (Titel + Aktionen + Filter) bleibt beim Scrollen stehen. */}
      <StickyFilterBar className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3 min-h-9">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Entwürfe</h1>
          <p className="text-sm text-muted-foreground mt-1">Anfragen die noch nicht fix sind</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Toggle: EIN Button, wechselt zwischen Aktiv und Storniert.
              Label zeigt das *andere* Segment (klick fuehrt dorthin) —
              gleiches Muster wie /auftraege. */}
          <button
            type="button"
            onClick={() => setSegment(segment === "active_group" ? "storniert" : "active_group")}
            className="kasten kasten-muted"
            aria-label={segment === "active_group" ? "Zu stornierten Entwürfen wechseln" : "Zu aktiven Entwürfen wechseln"}
          >
            {segment === "active_group" ? (
              <>
                <Archive className="h-3.5 w-3.5" />
                Storniert
              </>
            ) : (
              <>
                <ClipboardEdit className="h-3.5 w-3.5" />
                Aktiv
              </>
            )}
          </button>
          <Link href="/entwuerfe/neu" className="kasten kasten-red" data-tooltip="Neuer Entwurf">
            <Plus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Neuer Entwurf</span>
            <span className="sm:hidden">Entwurf</span>
          </Link>
        </div>
      </div>

      {/* Suche + Filter */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Titel, Kunde oder Ansprechperson suchen…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
            aria-label="Suche"
          />
        </div>
        <div className="w-full sm:w-64">
          <SearchableSelect
            value={filterOwner}
            onChange={setFilterOwner}
            items={ownerOptions}
            searchable={owners.length > 8}
            clearable={false}
            active={!!filterOwner}
            placeholder="Alle Verantwortlichen"
          />
        </div>
        {anyFilter && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setFilterOwner("");
            }}
            className="h-9 px-3 text-xs text-muted-foreground hover:text-foreground rounded-lg flex items-center gap-1.5 transition-colors"
            data-tooltip="Filter zurücksetzen"
          >
            <X className="h-3.5 w-3.5" />
            Reset
          </button>
        )}
        {/* Ansicht-Toggle: Liste (default, kompakt) vs. Karten (Grid wie /projekte).
            Persistiert in localStorage (LS_VIEW). */}
        <div className="flex items-center gap-1 ml-auto sm:ml-0">
          <button
            type="button"
            onClick={() => setView("liste")}
            className={view === "liste" ? "kasten-active" : "kasten-toggle-off"}
            data-tooltip="Listen-Ansicht"
            aria-pressed={view === "liste"}
            aria-label="Listen-Ansicht"
          >
            <List className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Liste</span>
          </button>
          <button
            type="button"
            onClick={() => setView("karten")}
            className={view === "karten" ? "kasten-active" : "kasten-toggle-off"}
            data-tooltip="Karten-Ansicht"
            aria-pressed={view === "karten"}
            aria-label="Karten-Ansicht"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Karten</span>
          </button>
        </div>
      </div>
      </StickyFilterBar>

      {/* Liste ODER Karten (Toggle) */}
      {loading ? (
        view === "karten" ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-16 rounded-xl" />
            ))}
          </div>
        )
      ) : total === 0 ? (
        <Card className="border-dashed bg-card">
          <CardContent className="p-0">
            <EmptyState
              icon={ClipboardEdit}
              title={
                anyFilter
                  ? "Keine Ergebnisse mit diesen Filtern"
                  : segment === "storniert"
                    ? "Keine stornierten Entwürfe"
                    : "Noch keine Entwürfe. Erster wartet auf dich."
              }
              description={
                anyFilter
                  ? "Filter zurücksetzen um alle Entwürfe zu sehen."
                  : segment === "storniert"
                    ? "Stornierte Entwürfe erscheinen hier — bisher keiner."
                    : "Anfragen, Ideen, tentative Termine — alles was noch nicht als Auftrag festgezurrt ist."
              }
              action={
                anyFilter ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch("");
                      setFilterOwner("");
                    }}
                    className="kasten kasten-muted"
                  >
                    Filter zurücksetzen
                  </button>
                ) : segment === "active_group" ? (
                  <Link href="/entwuerfe/neu" className="kasten kasten-red">
                    <Plus className="h-3.5 w-3.5" />
                    Neuer Entwurf
                  </Link>
                ) : null
              }
            />
          </CardContent>
        </Card>
      ) : view === "karten" ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {drafts.map((d) => (
            <DraftCard key={d.id} d={d} />
          ))}
        </div>
      ) : (
        <div className="space-y-1.5">
          {drafts.map((d) => {
            const kundeName = d.customer?.name ?? d.customer_name ?? d.contact_person ?? "—";
            const location = d.location?.name ?? d.location_name ?? null;
            const dateText = formatDateRange(d.expected_start_date, d.expected_end_date);
            const notesCount = d.notes_count?.[0]?.count ?? 0;
            const statusChip = STATUS_CHIP[d.status];
            const isConverted = d.status === "umgewandelt";
            const isCancelled = d.status === "storniert";
            const muted = isConverted || isCancelled;
            return (
              <Link
                key={d.id}
                href={`/entwuerfe/${d.id}`}
                className={`block group ${muted ? "opacity-70" : ""}`}
              >
                <Card className="auftrag-card-hover bg-card cursor-pointer">
                  <CardContent className="px-4 py-2.5 flex flex-col md:flex-row md:items-center gap-2 md:gap-4">
                    {/* Nummer + Titel */}
                    <div className="flex items-center gap-2 min-w-0 md:w-[280px] md:shrink-0">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-foreground/[0.08] text-[11px] font-mono font-semibold tabular-nums shrink-0">
                        ENT-{d.draft_number}
                      </span>
                      <span className="font-medium text-sm truncate">{d.title}</span>
                    </div>

                    {/* Meta-Zeile: Kunde | Location | Datum */}
                    <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap text-xs text-muted-foreground min-w-0 flex-1">
                      <span className="inline-flex items-center gap-1 min-w-0">
                        <UserIcon className="h-3 w-3 shrink-0" />
                        <span className="truncate">{kundeName}</span>
                      </span>
                      {location && (
                        <span className="inline-flex items-center gap-1 min-w-0">
                          <MapPin className="h-3 w-3 shrink-0" />
                          <span className="truncate">{location}</span>
                        </span>
                      )}
                      {dateText && (
                        <span className="inline-flex items-center gap-1">
                          <Calendar className="h-3 w-3 shrink-0" />
                          <span className="tabular-nums whitespace-nowrap">{dateText}</span>
                        </span>
                      )}
                    </div>

                    {/* Rechts: Owner + Status-Chip + Notiz-Count */}
                    <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                      {d.owner && (
                        <span
                          className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
                          data-tooltip={`Verantwortlich: ${d.owner.full_name}`}
                        >
                          <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-foreground/[0.08] text-[10px] font-semibold">
                            {d.owner.full_name
                              .split(/\s+/)
                              .filter(Boolean)
                              .slice(0, 2)
                              .map((s) => s[0]?.toUpperCase() ?? "")
                              .join("")}
                          </span>
                          <span className="hidden lg:inline">{d.owner.full_name}</span>
                        </span>
                      )}
                      {notesCount > 0 && (
                        <span
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground"
                          data-tooltip={`${notesCount} Notiz${notesCount === 1 ? "" : "en"}`}
                        >
                          <MessageSquare className="h-3 w-3" />
                          {notesCount}
                        </span>
                      )}
                      <span
                        className={`inline-flex items-center px-1.5 py-0 text-[10px] font-medium rounded-full ${statusChip.color}`}
                      >
                        {statusChip.label}
                      </span>
                      {isConverted && d.converted_to_job_id && (
                        <span
                          className="inline-flex items-center text-[11px] text-blue-600 dark:text-blue-400"
                          data-tooltip="Zum Auftrag umgewandelt"
                        >
                          <ArrowRightCircle className="h-3.5 w-3.5" />
                        </span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * DraftCard — Karten-Ansicht als Grid-Zelle, aber visuell IDENTISCH zur
 * Liste-Row (gleicher Card-Wrapper, gleiche Chip-Styles, gleiche Icons,
 * gleicher ENT-Badge). Unterschied nur: Felder stacken vertikal statt
 * horizontal, damit sie in die Zelle passen. KEIN eigener Projekt-Card-Look
 * (kein Status-Chip-oben, kein Grosstitel, keine Status-Border-Tints).
 */
function DraftCard({ d }: { d: DraftListRow }) {
  const kundeName = d.customer?.name ?? d.customer_name ?? d.contact_person ?? "—";
  const location = d.location?.name ?? d.location_name ?? null;
  const dateText = formatDateRange(d.expected_start_date, d.expected_end_date);
  const notesCount = d.notes_count?.[0]?.count ?? 0;
  const statusChip = STATUS_CHIP[d.status];
  const isConverted = d.status === "umgewandelt";
  const isCancelled = d.status === "storniert";
  const muted = isConverted || isCancelled;

  return (
    <Link
      href={`/entwuerfe/${d.id}`}
      className={`block group h-full ${muted ? "opacity-70" : ""}`}
    >
      <Card className="auftrag-card-hover bg-card cursor-pointer h-full">
        <CardContent className="px-4 py-2.5 flex flex-col gap-2">
          {/* Nummer + Titel — identisch zur Liste-Row */}
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-foreground/[0.08] text-[11px] font-mono font-semibold tabular-nums shrink-0">
              ENT-{d.draft_number}
            </span>
            <span className="font-medium text-sm truncate">{d.title}</span>
          </div>

          {/* Meta-Zeile: Kunde | Location | Datum — identisch zur Liste-Row */}
          <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap text-xs text-muted-foreground min-w-0">
            <span className="inline-flex items-center gap-1 min-w-0">
              <UserIcon className="h-3 w-3 shrink-0" />
              <span className="truncate">{kundeName}</span>
            </span>
            {location && (
              <span className="inline-flex items-center gap-1 min-w-0">
                <MapPin className="h-3 w-3 shrink-0" />
                <span className="truncate">{location}</span>
              </span>
            )}
            {dateText && (
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3 w-3 shrink-0" />
                <span className="tabular-nums whitespace-nowrap">{dateText}</span>
              </span>
            )}
          </div>

          {/* Bottom: Owner (links) + Notiz-Count + Status-Chip (rechts) —
              gleiche Chips wie Liste-Row, nur mit justify-between statt
              justify-end weil Zelle keinen langen Freiraum davor hat. */}
          <div className="mt-auto flex items-center gap-2 flex-wrap pt-1">
            {d.owner ? (
              <span
                className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0 mr-auto"
                data-tooltip={`Verantwortlich: ${d.owner.full_name}`}
              >
                <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-foreground/[0.08] text-[10px] font-semibold shrink-0">
                  {d.owner.full_name
                    .split(/\s+/)
                    .filter(Boolean)
                    .slice(0, 2)
                    .map((s) => s[0]?.toUpperCase() ?? "")
                    .join("")}
                </span>
                <span className="truncate">{d.owner.full_name}</span>
              </span>
            ) : (
              <span className="text-[11px] text-muted-foreground/60 italic mr-auto">niemand zugeteilt</span>
            )}
            {notesCount > 0 && (
              <span
                className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground"
                data-tooltip={`${notesCount} Notiz${notesCount === 1 ? "" : "en"}`}
              >
                <MessageSquare className="h-3 w-3" />
                {notesCount}
              </span>
            )}
            <span
              className={`inline-flex items-center px-1.5 py-0 text-[10px] font-medium rounded-full ${statusChip.color}`}
            >
              {statusChip.label}
            </span>
            {isConverted && d.converted_to_job_id && (
              <span
                className="inline-flex items-center text-[11px] text-blue-600 dark:text-blue-400"
                data-tooltip="Zum Auftrag umgewandelt"
              >
                <ArrowRightCircle className="h-3.5 w-3.5" />
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
