"use client";

/**
 * Kunden-Liste — kompakte Tabellen-Ansicht, skaliert auf 1000+ Eintraege.
 *
 * Drei-Zustand-Modell:
 *  - Aktiv (archived_at IS NULL)            — Standardansicht
 *  - Archiviert (archived_at IS NOT NULL)   — versteckt, ueber Toggle sichtbar
 *  - Hart geloescht                          — nur ohne Verknuepfungen moeglich
 *
 * Aktion pro Zeile:
 *  - Mit Auftraegen/Dokumenten/Locations: Archiv-Symbol  → /api/customers/archive
 *  - Ohne Verknuepfungen:                  Trash-Symbol  → /api/customers/delete
 *  - Im Archiv-Modus:                      Reaktivieren  → /api/customers/unarchive
 *
 * Auto-Archiv: Beim Mounten POST /api/customers/auto-archive — verschiebt Kunden
 * mit mindestens einem Auftrag aber ohne neuen Auftrag in den letzten 12 Monaten
 * automatisch ins Archiv (ausgenommen Verwaltungs-Customers).
 */

import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { CUSTOMER_TYPES } from "@/lib/constants";
import type { Customer, CustomerType } from "@/types";
import Link from "next/link";
import { Spinner } from "@/components/ui/spinner";
import {
  Plus, Search, Building2, User, Globe, Users, Trash2, X, ChevronDown, RefreshCw, Archive, ArchiveRestore,
} from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { usePermissions } from "@/lib/use-permissions";
import { Modal } from "@/components/ui/modal";
import dynamic from "next/dynamic";

// flag-icons CSS ist ~80kb — lazy laden damit /kunden zuerst rendert.
const CustomerWorldMap = dynamic(
  () => import("@/components/customer-world-map").then((m) => m.CustomerWorldMap),
  { ssr: false, loading: () => null },
);

const PAGE_SIZE = 50;

const TYPE_ICONS: Record<CustomerType, typeof Building2> = {
  company: Building2,
  individual: User,
  organization: Globe,
};

// PostgREST-Aggregat: zaehlt verknuepfte Zeilen pro Tabelle. Gibt
// `[{ count: N }]` zurueck — leer wenn keine Verknuepfungen.
type RelationCount = { count: number }[];
type CustomerRow = Customer & {
  jobs: RelationCount;
  documents: RelationCount;
  locations: RelationCount;
  rental_requests: RelationCount;
};

function relCount(arr: RelationCount | undefined | null): number {
  return arr?.[0]?.count ?? 0;
}

type ActionTarget =
  | { kind: "delete"; customer: CustomerRow }
  | { kind: "archive"; customer: CustomerRow }
  | { kind: "unarchive"; customer: CustomerRow };

export default function KundenPage() {
  const { can } = usePermissions();
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<CustomerType | "all">("all");
  // Bexio-Filter: "all" zeigt alle, "linked" nur die mit bexio_contact_id,
  // "unlinked" nur die ohne. Hilft beim manuellen Bexio-Sync.
  const [filterBexio, setFilterBexio] = useState<"all" | "linked" | "unlinked">("all");
  const [showArchive, setShowArchive] = useState(false);
  const [archiveCount, setArchiveCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [actionTarget, setActionTarget] = useState<ActionTarget | null>(null);
  const [actionRunning, setActionRunning] = useState(false);

  // Bexio-Nr-Backfill
  const [unsyncedCount, setUnsyncedCount] = useState(0);
  const [syncing, setSyncing] = useState(false);

  const supabase = createClient();
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryIdRef = useRef(0);

  // Server-seitige Suche + Filter, composite cursor (name+id) gegen Doppelnamen.
  const buildQuery = useCallback((cursor: { name: string; id: string } | null) => {
    let q = supabase
      .from("customers")
      .select(
        "*, jobs(count), documents(count), locations(count), rental_requests(count)",
        { count: "exact" },
      );

    // Archiv-Toggle
    if (showArchive) {
      q = q.not("archived_at", "is", null);
    } else {
      q = q.is("archived_at", null);
    }

    if (filterType !== "all") q = q.eq("type", filterType);
    if (filterBexio === "linked") q = q.not("bexio_contact_id", "is", null);
    else if (filterBexio === "unlinked") q = q.is("bexio_contact_id", null);
    const term = search.trim();
    if (term.length > 0) {
      const like = `%${term}%`;
      q = q.or(`name.ilike.${like},email.ilike.${like},bexio_nr.ilike.${like}`);
    }
    if (cursor !== null) {
      q = q.or(`and(name.eq.${cursor.name},id.gt.${cursor.id}),name.gt.${cursor.name}`);
    }
    return q.order("name", { ascending: true }).order("id", { ascending: true }).limit(PAGE_SIZE + 1);
  }, [supabase, filterType, filterBexio, search, showArchive]);

  const loadCustomers = useCallback(async () => {
    const myId = ++queryIdRef.current;
    setLoading(true);
    const { data, count } = await buildQuery(null);
    if (myId !== queryIdRef.current) return;
    if (data) {
      const rows = data as CustomerRow[];
      setHasMore(rows.length > PAGE_SIZE);
      setCustomers(rows.slice(0, PAGE_SIZE));
    }
    if (typeof count === "number") setTotalCount(count);
    setLoading(false);
  }, [buildQuery]);

  // Auto-Archive laeuft jetzt als Daily-Cron (siehe vercel.json) — nicht
  // mehr bei jedem Kunden-Mount. Der Mount-Trigger hat bei 100+ Mitarbeitern
  // jedes Mal alle Customers + alle Jobs in JS-Memory gepullt → MB-Response
  // pro Visit. Cron laeuft einmal taeglich serverseitig.

  // Initial + bei Filter-/Modus-Aenderung neu laden, mit 250ms Debounce auf Suche.
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => { loadCustomers(); }, 250);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [loadCustomers]);

  // Archiv-Count fuer den Toggle-Badge — entkoppelt von der Liste.
  const refreshArchiveCount = useCallback(async () => {
    const { count } = await supabase
      .from("customers")
      .select("*", { count: "exact", head: true })
      .not("archived_at", "is", null);
    setArchiveCount(count ?? 0);
  }, [supabase]);

  useEffect(() => { refreshArchiveCount(); }, [refreshArchiveCount, customers.length]);

  // Bexio-Nr-Backfill-Banner
  const checkUnsynced = useCallback(async () => {
    const { count } = await supabase
      .from("customers")
      .select("*", { count: "exact", head: true })
      .not("bexio_contact_id", "is", null)
      .is("bexio_nr", null)
      .is("archived_at", null);
    setUnsyncedCount(count ?? 0);
  }, [supabase]);

  useEffect(() => { checkUnsynced(); }, [checkUnsynced]);

  async function syncBexioNrs() {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await fetch("/api/bexio/contacts/sync-nrs", { method: "POST" });
      const json = await res.json();
      if (!json.success) {
        toast.error("Sync fehlgeschlagen: " + (json.error || "Unbekannt"));
        return;
      }
      const parts = [
        json.updated > 0 ? `${json.updated} aktualisiert` : null,
        json.skipped > 0 ? `${json.skipped} ohne Nr in Bexio` : null,
        json.failed > 0 ? `${json.failed} Fehler` : null,
      ].filter(Boolean);
      toast.success("Bexio-Nrn synchronisiert" + (parts.length ? ` — ${parts.join(", ")}` : ""));
      await Promise.all([loadCustomers(), checkUnsynced()]);
    } catch (e) {
      toast.error("Netzwerkfehler: " + (e instanceof Error ? e.message : "unbekannt"));
    } finally {
      setSyncing(false);
    }
  }

  async function loadMore() {
    if (loadingMore || customers.length === 0) return;
    setLoadingMore(true);
    const last = customers[customers.length - 1];
    const { data } = await buildQuery({ name: last.name, id: last.id });
    if (data) {
      const rows = data as CustomerRow[];
      setHasMore(rows.length > PAGE_SIZE);
      setCustomers((prev) => [...prev, ...rows.slice(0, PAGE_SIZE)]);
    }
    setLoadingMore(false);
  }

  async function runAction() {
    if (!actionTarget || actionRunning) return;
    setActionRunning(true);
    const { kind, customer } = actionTarget;
    try {
      const endpoint =
        kind === "delete" ? "/api/customers/delete"
        : kind === "archive" ? "/api/customers/archive"
        : "/api/customers/unarchive";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: customer.id }),
      });
      const json = await res.json();
      if (!json.success) {
        // Wenn Hard-Delete vom Server abgelehnt wird wegen Verknuepfungen,
        // verstaendliches Feedback geben statt rohem Fehler.
        if (json.reason === "has-references") {
          toast.error(`${customer.name} hat noch Verknüpfungen — bitte archivieren statt löschen.`);
        } else {
          TOAST.errorOr(json.error);
        }
        return;
      }
      const verb = kind === "delete" ? "gelöscht" : kind === "archive" ? "archiviert" : "reaktiviert";
      toast.success(`${customer.name} ${verb}`);
      // Lokal entfernen — Liste filtert je nach showArchive
      setCustomers((prev) => prev.filter((c) => c.id !== customer.id));
      setTotalCount((c) => Math.max(0, c - 1));
      // Archiv-Count + Bexio-Banner ggf. anpassen
      refreshArchiveCount();
      checkUnsynced();
    } catch (e) {
      TOAST.supabaseError(e);
    } finally {
      setActionRunning(false);
      setActionTarget(null);
    }
  }

  const hasFilter = !!search.trim() || filterType !== "all" || filterBexio !== "all";

  // Aktions-Modal-Texte
  const actionLabel = !actionTarget ? "" :
    actionTarget.kind === "delete" ? "Kunde unwiderruflich löschen?" :
    actionTarget.kind === "archive" ? "Kunde ins Archiv verschieben?" :
    "Kunde reaktivieren?";
  const actionBody = !actionTarget ? "" :
    actionTarget.kind === "delete"
      ? `Möchtest du ${actionTarget.customer.name} unwiderruflich löschen? Es gibt keine Aufträge oder anderen Daten, die an diesem Kunden hängen.`
    : actionTarget.kind === "archive"
      ? `${actionTarget.customer.name} verschwindet aus der aktiven Liste. Bestehende Aufträge und Dokumente bleiben erhalten.`
    : `${actionTarget.customer.name} wird wieder als aktiver Kunde geführt.`;
  // Archive nutzt kasten-archive (2px Border + grauer Tint) damit die Optik
  // mit den anderen kasten-X-Buttons fluchtet ohne so hart wie schwarz/weiss
  // (kasten-active) zu wirken.
  const actionButtonClass = actionTarget?.kind === "delete" ? "kasten kasten-red"
    : actionTarget?.kind === "archive" ? "kasten-archive"
    : "kasten kasten-green";
  const actionButtonLabel = actionTarget?.kind === "delete" ? "Löschen"
    : actionTarget?.kind === "archive" ? "Archivieren"
    : "Reaktivieren";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{showArchive ? "Kunden-Archiv" : "Kunden"}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {totalCount} {totalCount === 1 ? "Kunde" : "Kunden"}
            {hasFilter ? " (gefiltert)" : showArchive ? " im Archiv" : " gesamt"}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => setShowArchive(!showArchive)}
            className={showArchive ? "kasten-active" : "kasten-toggle-off"}
          >
            <Archive className="h-3.5 w-3.5" />
            {showArchive ? "Aktive anzeigen" : `Archiv (${archiveCount})`}
          </button>
          {!showArchive && can("kunden:create") && (
            <Link href="/kunden/neu" className="kasten kasten-red">
              <Plus className="h-3.5 w-3.5" />
              Neuer Kunde
            </Link>
          )}
        </div>
      </div>

      {/* Laender-Auflistung — zeigt aktive UND archivierte Kunden, also die
          gesamte geographische Historie. Steht oben in beiden Ansichten. */}
      <CustomerWorldMap />

      {/* Bexio-Nr-Backfill-Banner — nur in Aktiv-Ansicht relevant */}
      {!showArchive && unsyncedCount > 0 && (
        <div className="rounded-xl border bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-blue-500/30 px-4 py-3 flex items-center gap-3 flex-wrap">
          <RefreshCw className="h-4 w-4 text-blue-700 dark:text-blue-300 shrink-0" />
          <p className="text-sm text-blue-900 dark:text-blue-100 flex-1 min-w-0">
            <strong>{unsyncedCount}</strong> {unsyncedCount === 1 ? "Kunde ist" : "Kunden sind"} mit Bexio verknüpft, aber ohne Kundennummer im FSM.
          </p>
          <button
            type="button"
            onClick={syncBexioNrs}
            disabled={syncing}
            className="kasten kasten-bexio shrink-0"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Synchronisiere…" : "Jetzt synchronisieren"}
          </button>
        </div>
      )}

      {/* Such- + Filter-Bar */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Name, E-Mail oder Kundennummer suchen…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 h-9"
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          {(["all", "company", "individual", "organization"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setFilterType(t)}
              className={filterType === t ? "kasten-active" : "kasten-toggle-off"}
            >
              {t === "all" ? "Alle" : CUSTOMER_TYPES[t]}
            </button>
          ))}
          {/* Visueller Trenner zwischen Type-Filter und Bexio-Filter */}
          <span className="w-px self-stretch bg-border mx-0.5" aria-hidden="true" />
          {/* Bexio-Filter — drei Zustaende: Alle / Mit / Ohne. "Mit" nutzt
              kasten-bexio (Lime) damit der Bezug zu Bexio sofort sichtbar ist. */}
          <button
            type="button"
            onClick={() => setFilterBexio(filterBexio === "linked" ? "all" : "linked")}
            className={filterBexio === "linked" ? "kasten kasten-bexio" : "kasten-toggle-off"}
          >
            Mit Bexio
          </button>
          <button
            type="button"
            onClick={() => setFilterBexio(filterBexio === "unlinked" ? "all" : "unlinked")}
            className={filterBexio === "unlinked" ? "kasten-active" : "kasten-toggle-off"}
          >
            Ohne Bexio
          </button>
        </div>
        {hasFilter && (
          <button
            type="button"
            onClick={() => { setSearch(""); setFilterType("all"); setFilterBexio("all"); }}
            className="h-9 px-3 text-xs text-muted-foreground hover:text-foreground rounded-lg flex items-center gap-1.5 transition-colors"
          >
            <X className="h-3.5 w-3.5" />
            Reset
          </button>
        )}
      </div>

      {loading ? (
        <div className="rounded-xl border bg-card divide-y">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-11 px-4 flex items-center">
              <div className="h-3 w-16 bg-muted rounded animate-pulse mr-4" />
              <div className="h-3 w-48 bg-muted rounded animate-pulse" />
            </div>
          ))}
        </div>
      ) : customers.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-card py-16 text-center">
          <div className="mx-auto w-12 h-12 rounded-2xl bg-muted flex items-center justify-center mb-4">
            <Users className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="font-semibold text-lg">
            {hasFilter ? "Keine Treffer" : showArchive ? "Archiv ist leer" : "Noch keine Kunden"}
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            {hasFilter
              ? "Andere Suche oder Filter zurücksetzen."
              : showArchive
                ? "Es sind keine Kunden archiviert."
                : "Lege deinen ersten Kunden an."}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="hidden md:grid grid-cols-[88px_1fr_240px_140px_120px_36px] gap-4 px-4 py-2.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b bg-muted/30">
            <span>Nr.</span>
            <span>Name</span>
            <span>E-Mail</span>
            <span>Telefon</span>
            <span>Ort</span>
            <span aria-hidden />
          </div>
          {/* Rows-Container mit p-1.5 Inset. Zwischen den Zeilen kommt eine
              dezente Linie via after-Pseudo (10px vom Rand abgesetzt) — bei
              der letzten Zeile via last:after:hidden ausgeblendet. */}
          <div className="p-1.5">
            {customers.map((c) => {
              const Icon = TYPE_ICONS[c.type];
              const totalRel = relCount(c.jobs) + relCount(c.documents) + relCount(c.locations) + relCount(c.rental_requests);
              const canHardDelete = totalRel === 0;
              // Action-Definition: in Archiv-Mode kann nur reaktiviert werden;
              // in Aktiv-Mode entweder hard-delete (keine Refs) oder archive.
              const action: ActionTarget = showArchive
                ? { kind: "unarchive", customer: c }
                : canHardDelete
                  ? { kind: "delete", customer: c }
                  : { kind: "archive", customer: c };
              const ActionIcon = action.kind === "delete" ? Trash2
                : action.kind === "archive" ? Archive
                : ArchiveRestore;
              const actionTitle = action.kind === "delete" ? "Endgültig löschen"
                : action.kind === "archive" ? "Ins Archiv verschieben"
                : "Reaktivieren";
              const hoverColor = action.kind === "delete" ? "hover:!text-red-500"
                : action.kind === "archive" ? "hover:!text-foreground"
                : "hover:!text-green-500";
              // Gating: delete = kunden:delete, archive/unarchive = kunden:archive
              // (eigene Permission damit Admin "Archivieren" separat von "Bearbeiten"
              // erteilen kann).
              const actionAllowed = action.kind === "delete"
                ? can("kunden:delete")
                : can("kunden:archive");
              return (
                <div key={c.id} className="group relative after:absolute after:bottom-0 after:left-2.5 after:right-2.5 after:h-px after:bg-foreground/10 dark:after:bg-foreground/15 last:after:hidden">
                  <div className="kunden-row hidden md:grid grid-cols-[88px_1fr_240px_140px_120px_36px] gap-4 items-center px-2.5 py-2 rounded-lg">
                    <span className="font-mono text-xs">
                      {c.bexio_nr ? (
                        // Bexio-Lime-Pill — gleicher tinted Stil wie kasten-bexio
                        // Buttons. Im Light-Mode hebt der lime-Hintergrund die
                        // Nummer klar vom weissen Card-Background ab; im Dark-Mode
                        // genauso konsistent zum Bexio-Button.
                        <span className="font-semibold px-1.5 py-0.5 rounded text-[rgb(132,152,0)] dark:text-[rgb(196,214,0)] bg-[rgba(196,214,0,0.15)] dark:bg-[rgba(196,214,0,0.2)]">
                          {c.bexio_nr}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </span>
                    <Link href={`/kunden/${c.id}`} className="flex items-center gap-2 min-w-0">
                      <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-label={CUSTOMER_TYPES[c.type]} />
                      <span className="kunden-name font-medium text-sm truncate">{c.name}</span>
                    </Link>
                    {c.email ? (
                      <a href={`mailto:${c.email}`} className="text-sm text-muted-foreground hover:text-foreground truncate transition-colors">{c.email}</a>
                    ) : <span className="text-sm text-muted-foreground/40">—</span>}
                    {c.phone ? (
                      <a href={`tel:${c.phone}`} className="text-sm text-muted-foreground hover:text-foreground transition-colors">{c.phone}</a>
                    ) : <span className="text-sm text-muted-foreground/40">—</span>}
                    <span className="text-sm text-muted-foreground truncate">
                      {c.address_city || <span className="opacity-40">—</span>}
                    </span>
                    {actionAllowed ? (
                      <button
                        type="button"
                        onClick={() => setActionTarget(action)}
                        className={`p-1 rounded text-muted-foreground/50 ${hoverColor} transition-colors`}
                        aria-label={`${c.name}: ${actionTitle}`}
                        data-tooltip={actionTitle}
                        data-tooltip-align="end"
                      >
                        <ActionIcon className="h-3.5 w-3.5" />
                      </button>
                    ) : <span />}
                  </div>
                  <div className="kunden-row md:hidden flex items-center gap-3 px-2.5 py-3 rounded-lg">
                    <Link href={`/kunden/${c.id}`} className="flex items-center gap-3 min-w-0 flex-1">
                      <span className="font-mono text-[10px] shrink-0">
                        {c.bexio_nr ? (
                          <span className="font-semibold px-1.5 py-0.5 rounded text-[rgb(132,152,0)] dark:text-[rgb(196,214,0)] bg-[rgba(196,214,0,0.15)] dark:bg-[rgba(196,214,0,0.2)]">{c.bexio_nr}</span>
                        ) : (
                          <span className="text-muted-foreground/40 w-12 inline-block">—</span>
                        )}
                      </span>
                      <Icon className="h-4 w-4 text-muted-foreground shrink-0" aria-label={CUSTOMER_TYPES[c.type]} />
                      <div className="min-w-0 flex-1">
                        <p className="kunden-name text-sm font-medium truncate">{c.name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {[c.email, c.address_city].filter(Boolean).join(" · ") || "—"}
                        </p>
                      </div>
                    </Link>
                    {actionAllowed && (
                      <button
                        type="button"
                        onClick={() => setActionTarget(action)}
                        className="p-2 rounded-lg text-muted-foreground/40"
                        aria-label={`${c.name}: ${actionTitle}`}
                      >
                        <ActionIcon className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {hasMore && (
            <div className="border-t flex justify-center py-2">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="kasten kasten-muted"
              >
                {loadingMore ? <Spinner size={14} /> : <ChevronDown className="h-3.5 w-3.5" />}
                {loadingMore ? "Lade…" : "Mehr laden"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Aktions-Modal — eine Komponente fuer alle drei Aktionen, Wording haengt
          vom Target-Kind ab. Code-Bestaetigung gibt's nicht mehr (ersetzen wir
          spaeter durch User-Rollen). */}
      <Modal
        open={!!actionTarget}
        onClose={() => !actionRunning && setActionTarget(null)}
        title={actionLabel}
      >
        <p className="text-sm text-muted-foreground">{actionBody}</p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setActionTarget(null)}
            disabled={actionRunning}
            className="kasten kasten-muted flex-1"
          >
            Abbrechen
          </button>
          <button
            type="button"
            onClick={runAction}
            disabled={actionRunning}
            className={`${actionButtonClass} flex-1`}
          >
            {actionRunning ? "Bitte warten…" : actionButtonLabel}
          </button>
        </div>
      </Modal>
    </div>
  );
}
