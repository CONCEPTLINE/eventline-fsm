"use client";

/**
 * Tickets-Listenseite (drastisch vereinfacht 2026-09-06).
 *
 * Eine einzige Liste — RLS regelt was wer sieht (Mitarbeiter: eigene,
 * Manager: eigene + zu genehmigen + Rest via Rolle). Nur zwei Filter:
 * Search (Titel/Beschreibung/Nummer) und ein Offen|Erledigt-Toggle.
 *
 * Sortierung: fuer den User relevante Tickets zuerst — also alle, die
 * ihm zur Genehmigung zugewiesen sind (assigned_to = ich, status = offen)
 * ganz nach oben; danach nach created_at desc.
 *
 * Beide Filter reload-safe via localStorage (FSM-Regel §10).
 */

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { escapeForIlike } from "@/lib/search-escape";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StickyFilterBar } from "@/components/ui/sticky-filter-bar";
import { NewTicketModal } from "@/components/tickets/new-ticket-modal";
import {
  Plus, Search, Ticket as TicketIcon, Wrench, Receipt, Clock, Package,
} from "lucide-react";
import type { TicketWithRelations, TicketType, TicketStatus } from "@/types";

type StatusToggle = "offen" | "erledigt";

// Cursor-Pagination — 100 Rows pro Page, "Mehr laden"-Button am Ende.
const PAGE_SIZE = 100;

// LocalStorage-Keys — projekt-eindeutig, siehe FSM-Regel §10.
const LS = {
  status: "tickets-status",
  searchTitle: "tickets-search-title",
} as const;

const TYPE_META: Record<TicketType, { label: string; short: string; icon: React.ComponentType<{ className?: string }>; color: string }> = {
  it:               { label: "IT-Problem",       short: "IT",       icon: Wrench,  color: "text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-500/15" },
  beleg:            { label: "Beleg",             short: "Beleg",    icon: Receipt, color: "text-amber-600  dark:text-amber-400  bg-amber-50  dark:bg-amber-500/15"  },
  stempel_aenderung:{ label: "Stempel-Änderung", short: "Stempel",  icon: Clock,   color: "text-green-600  dark:text-green-400  bg-green-50  dark:bg-green-500/15"  },
  material:         { label: "Material",         short: "Material", icon: Package, color: "text-red-600    dark:text-red-400    bg-red-50    dark:bg-red-500/15"    },
};

const STATUS_META: Record<TicketStatus, { label: string; classes: string }> = {
  offen:     { label: "Offen",     classes: "bg-blue-100  text-blue-700  dark:bg-blue-500/20  dark:text-blue-300"  },
  erledigt:  { label: "Erledigt",  classes: "bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300" },
  abgelehnt: { label: "Abgelehnt", classes: "bg-red-100   text-red-700   dark:bg-red-500/20   dark:text-red-300"   },
};

function readLS(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeLS(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Private-Mode oder Storage voll — kein Halt fuer die UI. */
  }
}

// Formatiert Datum kompakt (dd.MM.yy) — timeZone Europe/Zurich zwingend
// (siehe CLAUDE.md §4: keine Datumsanzeige ohne timeZone).
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich",
    day: "2-digit", month: "2-digit", year: "2-digit",
  });
}

// Formatiert nur die Uhrzeit fuer die Vorher-/Nachher-Zeile (HH:mm).
function formatTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString("de-CH", {
    timeZone: "Europe/Zurich",
    hour: "2-digit", minute: "2-digit",
  });
}

// Formatiert nur den Tag als dd.MM. — wird in der Stempel-Zeile
// zusaetzlich zur Uhrzeit ausgewiesen, damit der Approver weiss um
// welchen Tag es geht (Ticket kann auch verspaetet eingereicht sein).
function formatDayShort(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich",
    day: "2-digit", month: "2-digit",
  });
}

// Payload-Shape der Stempel-Tickets — wird strikt so gelesen wie ihn
// new-ticket-modal.tsx schreibt (siehe TicketDataStempelAenderung).
type StempelData = {
  time_entry_id?: string;
  neu_start?: string;
  neu_end?: string;
  job_id?: string;
  beschreibung?: string;
  grund?: string;
};

/**
 * Wiederverwendbare Tickets-View — 1:1 der frueheren Page-Content,
 * extrahiert damit /hr sie als Tab einbetten kann. Die duenne Page unter
 * (app)/tickets/page.tsx haelt Deep-Links am Leben.
 */
export function TicketsView({ embedded = false }: { embedded?: boolean } = {}) {
  const supabase = createClient();

  const { can } = usePermissions();

  const [tickets, setTickets] = useState<TicketWithRelations[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  // Filter — Werte aus localStorage lazy laden (SSR-Guard drin), damit
  // Reload den vorherigen Stand wiederherstellt (FSM-Regel §10).
  const [searchTitle, setSearchTitle] = useState<string>(() => readLS(LS.searchTitle, ""));
  const [filterStatus, setFilterStatus] = useState<StatusToggle>(() => {
    const raw = readLS(LS.status, "offen");
    return raw === "erledigt" ? "erledigt" : "offen";
  });

  // Filter-Persistenz in localStorage.
  useEffect(() => { writeLS(LS.searchTitle, searchTitle); }, [searchTitle]);
  useEffect(() => { writeLS(LS.status, filterStatus); }, [filterStatus]);

  // Eigene User-ID laden — wird fuer die Client-Sortierung gebraucht
  // (Tickets die MIR zur Genehmigung zugewiesen sind ganz nach oben).
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      setCurrentUserId(user.id);
    })();
  }, [supabase]);

  // Query-Builder — beide Loader-Pfade (initial + load-more) bauen die
  // gleiche Query mit unterschiedlichem Cursor.
  const buildQuery = useCallback((cursor: { ts: string; id: string } | null) => {
    let q = supabase
      .from("tickets")
      .select(`
        *,
        creator:profiles!created_by(full_name),
        assignee:profiles!assigned_to(full_name),
        resolver:profiles!resolved_by(full_name),
        attachments:ticket_attachments(id, filename, storage_path, mime_type)
      `)
      // Belege leben jetzt auf /abrechnung — aus der Tickets-Liste raus,
      // damit IT/Material/Stempel-Tickets nicht mit Buchhaltungs-Krempel
      // gemischt sind.
      .neq("type", "beleg")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(PAGE_SIZE + 1);

    if (cursor !== null) {
      q = q.or(`created_at.lt.${cursor.ts},and(created_at.eq.${cursor.ts},id.lt.${cursor.id})`);
    }

    // Status-Toggle — server-seitig gefiltert (§4: Datenoperationen aus der DB).
    if (filterStatus === "offen") {
      q = q.eq("status", "offen");
    } else {
      // "Erledigt" = archiv-artig: erledigte + abgelehnte.
      q = q.in("status", ["erledigt", "abgelehnt"]);
    }

    const titleQ = searchTitle.trim();
    if (titleQ) {
      // Wenn die Eingabe eine reine Zahl ist (evtl. mit "T-"-Prefix),
      // zusaetzlich nach ticket_number matchen — Nutzer sollen einfach
      // "42" oder "T-42" tippen koennen. int4-Falle beachten (siehe
      // CLAUDE.md §15).
      const numRaw = titleQ.replace(/^T-?/i, "");
      const numMaybe = /^\d+$/.test(numRaw) ? parseInt(numRaw, 10) : NaN;
      const numOk = Number.isFinite(numMaybe) && numMaybe <= 2147483647;

      // Zentraler Escape-Helper (siehe src/lib/search-escape.ts):
      // eskaliert LIKE-Wildcards % _ und OR-Grammar-Zeichen , ( ) * \.
      const like = `"%${escapeForIlike(titleQ)}%"`;
      if (numOk) {
        q = q.or(`title.ilike.${like},description.ilike.${like},ticket_number.eq.${numMaybe}`);
      } else {
        q = q.or(`title.ilike.${like},description.ilike.${like}`);
      }
    }
    return q;
  }, [supabase, filterStatus, searchTitle]);

  // ------------------------------------------------------------------
  // Vorher-Werte fuer Stempel-Korrekturen — batched laden.
  //
  // Fuer Stempel-Tickets im Modus "Korrektur" (time_entry_id gesetzt) wollen
  // wir in der Liste "08:15 -> 08:00" zeigen. Der Vorher-Wert liegt auf
  // time_entries.clock_in/clock_out (echte Spaltennamen laut Migration 005
  // + 055) — mit einer .in()-Query (statt N+1) fuer die aktuell sichtbaren
  // Ticket-Rows batch-geladen.
  // ------------------------------------------------------------------
  const [entryBefore, setEntryBefore] = useState<Record<string, { clock_in: string | null; clock_out: string | null }>>({});
  const loadedEntryIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const needed: string[] = [];
    for (const t of tickets) {
      if (t.type !== "stempel_aenderung") continue;
      const d = (t.data ?? {}) as StempelData;
      if (!d.time_entry_id) continue;
      if (loadedEntryIdsRef.current.has(d.time_entry_id)) continue;
      needed.push(d.time_entry_id);
    }
    if (needed.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("time_entries")
        .select("id, clock_in, clock_out")
        .in("id", needed);
      if (cancelled) return;
      if (error) {
        // Query-Fehler NIE verschlucken (CLAUDE.md §15) — die Vorher-Zeile
        // fehlt sonst still und der Approver sieht keinen Diff.
        toast.error("Vorher-Werte konnten nicht geladen werden: " + error.message);
        return;
      }
      const additions: Record<string, { clock_in: string | null; clock_out: string | null }> = {};
      for (const row of (data ?? []) as { id: string; clock_in: string | null; clock_out: string | null }[]) {
        additions[row.id] = { clock_in: row.clock_in, clock_out: row.clock_out };
        loadedEntryIdsRef.current.add(row.id);
      }
      // IDs die nix zurueckgegeben haben trotzdem markieren, sonst
      // wiederholt der Effekt die Query bei jedem Render.
      for (const id of needed) loadedEntryIdsRef.current.add(id);
      setEntryBefore((prev) => ({ ...prev, ...additions }));
    })();
    return () => { cancelled = true; };
  }, [tickets, supabase]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await buildQuery(null);
    const rows = (data as unknown as TicketWithRelations[]) ?? [];
    setHasMore(rows.length > PAGE_SIZE);
    setTickets(rows.slice(0, PAGE_SIZE));
    setLoading(false);
  }, [buildQuery]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || tickets.length === 0) return;
    setLoadingMore(true);
    const last = tickets[tickets.length - 1];
    const { data } = await buildQuery({ ts: last.created_at, id: last.id });
    const rows = (data as unknown as TicketWithRelations[]) ?? [];
    setHasMore(rows.length > PAGE_SIZE);
    setTickets((prev) => [...prev, ...rows.slice(0, PAGE_SIZE)]);
    setLoadingMore(false);
  }, [buildQuery, loadingMore, hasMore, tickets]);

  useEffect(() => {
    // Kurzes Debounce fuer die Sucheingabe — Tastenschlaege loesen sonst
    // eine Query pro Zeichen aus.
    const t = setTimeout(() => { load(); }, 200);
    return () => clearTimeout(t);
  }, [load]);

  // Client-seitige Re-Sortierung: Tickets die MIR zur Genehmigung
  // zugewiesen sind (assigned_to = ich, status = offen) ganz nach oben —
  // stabil, alles andere behaelt die Server-Reihenfolge (created_at desc).
  const orderedTickets = useMemo(() => {
    if (!currentUserId || filterStatus !== "offen") return tickets;
    const mine: TicketWithRelations[] = [];
    const rest: TicketWithRelations[] = [];
    for (const t of tickets) {
      if (t.status === "offen" && t.assigned_to === currentUserId) mine.push(t);
      else rest.push(t);
    }
    if (mine.length === 0) return tickets;
    return [...mine, ...rest];
  }, [tickets, currentUserId, filterStatus]);


  return (
    <div className="space-y-6">
      {/* Kompletter Kopf (Titel + Aktionen + Filter) bleibt beim Scrollen stehen. */}
      <StickyFilterBar offset={embedded ? undefined : "app"} className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3 min-h-9">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Tickets</h1>
          <p className="text-sm text-muted-foreground mt-1">
            IT-Probleme · Stempel-Änderungen · Material-Anfragen
          </p>
        </div>
        {can("tickets:create") && (
          <button type="button" onClick={() => setShowNew(true)} className="kasten kasten-red">
            <Plus className="h-3.5 w-3.5" />Neues Ticket
          </button>
        )}
      </div>

      {/* Nur noch zwei Filter-Elemente: Search + Offen|Erledigt-Toggle. */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Suche — Titel, Beschreibung oder T-Nummer…"
            value={searchTitle}
            onChange={(e) => setSearchTitle(e.target.value)}
            className="pl-9 h-9 bg-card"
            aria-label="Suche"
          />
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setFilterStatus("offen")}
            className={filterStatus === "offen" ? "kasten-active" : "kasten-toggle-off"}
          >
            Offen
          </button>
          <button
            type="button"
            onClick={() => setFilterStatus("erledigt")}
            className={filterStatus === "erledigt" ? "kasten-active" : "kasten-toggle-off"}
          >
            Erledigt
          </button>
        </div>
      </div>
      </StickyFilterBar>

      {/* Liste */}
      {loading ? (
        <div className="space-y-2">{[1,2,3].map((i) => <Card key={i} className="animate-pulse bg-card"><CardContent className="p-4 h-20" /></Card>)}</div>
      ) : orderedTickets.length === 0 ? (
        <Card className="bg-card border-dashed">
          <CardContent className="py-16 text-center">
            <div className="mx-auto w-14 h-14 rounded-2xl bg-muted flex items-center justify-center mb-4">
              <TicketIcon className="h-7 w-7 text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-lg">
              {filterStatus === "offen" ? "Keine offenen Tickets" : "Keine erledigten Tickets"}
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              {searchTitle
                ? "Mit der aktuellen Suche wurde nichts gefunden."
                : filterStatus === "offen"
                  ? "Erstelle dein erstes Ticket über den Knopf oben."
                  : "Sobald Tickets abgeschlossen sind, tauchen sie hier auf."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {orderedTickets.map((t) => {
            const typeMeta = TYPE_META[t.type];
            const Icon = typeMeta.icon;
            // Vorher/Nachher-Zeile fuer Stempel-Tickets vorbereiten.
            let stempelDiff: React.ReactNode = null;
            if (t.type === "stempel_aenderung") {
              const d = (t.data ?? {}) as StempelData;
              const newStart = formatTime(d.neu_start);
              const newEnd = formatTime(d.neu_end);
              const day = formatDayShort(d.neu_start);
              if (d.time_entry_id) {
                // Modus Korrektur — Vorher-Werte aus geladenem time_entry.
                const before = entryBefore[d.time_entry_id];
                const oldStart = before ? formatTime(before.clock_in) : null;
                const oldEnd = before ? formatTime(before.clock_out) : null;
                // Nur die Werte zeigen die sich unterscheiden — wenn nur der
                // Start korrigiert wird ist die End-Zeile unnoetig laut.
                const startChanged = oldStart && newStart && oldStart !== newStart;
                const endChanged = oldEnd && newEnd && oldEnd !== newEnd;
                stempelDiff = (
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-foreground/80 whitespace-nowrap">
                    {day && <span className="text-muted-foreground">{day}</span>}
                    {startChanged || (!oldStart && newStart) ? (
                      <span className="font-mono">
                        {oldStart ? <span className="text-muted-foreground line-through decoration-red-400/70">{oldStart}</span> : null}
                        {oldStart ? <span className="mx-1 text-muted-foreground">→</span> : null}
                        <span className="text-foreground">{newStart}</span>
                      </span>
                    ) : (
                      oldStart && <span className="font-mono text-muted-foreground">{oldStart}</span>
                    )}
                    {(oldEnd || newEnd) && <span className="text-muted-foreground">·</span>}
                    {endChanged || (!oldEnd && newEnd) ? (
                      <span className="font-mono">
                        {oldEnd ? <span className="text-muted-foreground line-through decoration-red-400/70">{oldEnd}</span> : null}
                        {oldEnd ? <span className="mx-1 text-muted-foreground">→</span> : null}
                        <span className="text-foreground">{newEnd}</span>
                      </span>
                    ) : (
                      oldEnd && <span className="font-mono text-muted-foreground">{oldEnd}</span>
                    )}
                  </span>
                );
              } else if (newStart || newEnd) {
                // Modus Vergessen — kein Vorher, nur die neuen Werte.
                stempelDiff = (
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-foreground/80 whitespace-nowrap">
                    {day && <span className="text-muted-foreground">{day}</span>}
                    <span className="font-mono">{newStart ?? "—"}</span>
                    <span className="text-muted-foreground">→</span>
                    <span className="font-mono">{newEnd ?? "—"}</span>
                    <span className="text-muted-foreground">(neu)</span>
                  </span>
                );
              }
            }
            return (
              <Link key={t.id} href={`/tickets/${t.id}`} className="block">
                <Card className="card-hover bg-card">
                  <CardContent className="px-4 py-1.5 flex items-center gap-3">
                    <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${typeMeta.color}`}>
                      <Icon className="h-3.5 w-3.5" />
                    </div>
                    <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-[11px] font-semibold text-muted-foreground shrink-0">T-{t.ticket_number}</span>
                        <span
                          className={`inline-flex items-center gap-1 px-1.5 py-0 text-[10px] font-medium rounded-full shrink-0 ${typeMeta.color}`}
                          title={typeMeta.label}
                        >
                          {typeMeta.short}
                        </span>
                        <span className="font-medium text-sm truncate">{t.title}</span>
                        <span className={`inline-flex items-center px-1.5 py-0 text-[10px] font-medium rounded-full shrink-0 ${STATUS_META[t.status].classes}`}>
                          {STATUS_META[t.status].label}
                        </span>
                        {t.priority === "dringend" && (
                          <span className="inline-flex items-center px-1.5 py-0 text-[10px] font-semibold rounded-full bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300 shrink-0">
                            Dringend
                          </span>
                        )}
                        {t.filed_at && (
                          <span
                            className="inline-flex items-center px-1.5 py-0 text-[10px] font-medium rounded-full bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300 shrink-0"
                            data-tooltip={t.filed_reference ?? "Abgelegt"}
                          >
                            Abgelegt
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap">
                        <span>{t.creator?.full_name ?? "—"}</span>
                        <span>·</span>
                        <span>{formatDate(t.created_at)}</span>
                        {stempelDiff && (
                          <>
                            <span>·</span>
                            {stempelDiff}
                          </>
                        )}
                        {t.attachments.length > 0 && (
                          <>
                            <span>·</span>
                            <span>{t.attachments.length} Anhang{t.attachments.length === 1 ? "" : "e"}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
          {hasMore && (
            <div className="pt-2 text-center">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="kasten kasten-muted"
              >
                {loadingMore ? "Lade…" : "Mehr laden"}
              </button>
            </div>
          )}
        </div>
      )}

      <NewTicketModal open={showNew} onClose={() => setShowNew(false)} onCreated={load} />
    </div>
  );
}
