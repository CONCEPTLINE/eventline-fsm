"use client";

/**
 * /vertrieb/archiv — Liste aller abgeschlossenen Leads (gewonnen + abgesagt).
 *
 * Layout: 2-Spalten (Liste links, Detail rechts) — analog zur Haupt-Page
 * /vertrieb mit Spalten 1+3, ohne Drag-Drop (archiviert = unveraenderbar).
 *
 * URL-Param ?lead=<id> oeffnet ein bestimmtes Archiv-Lead direkt.
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { BackButton } from "@/components/ui/back-button";
import { ArrowLeft, Search, Check, X } from "lucide-react";
import { LeadEditor } from "@/components/vertrieb/lead-editor";
import type { VertriebContact } from "@/types";

type StatusFilter = "all" | "gewonnen" | "abgesagt";

export default function VertriebArchivPage() {
  const supabase = createClient();
  const searchParams = useSearchParams();
  const [contacts, setContacts] = useState<VertriebContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(searchParams.get("lead"));

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("vertrieb_contacts")
      .select("*")
      .in("status", ["gewonnen", "abgesagt"])
      .order("updated_at", { ascending: false })
      .limit(2000);
    if (data) setContacts(data as VertriebContact[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedLeadId) url.searchParams.set("lead", selectedLeadId);
    else url.searchParams.delete("lead");
    window.history.replaceState({}, "", url.toString());
  }, [selectedLeadId]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const nowMs = Date.now();
    return contacts
      .filter((c) => statusFilter === "all" || c.status === statusFilter)
      .filter((c) => !q || c.firma.toLowerCase().includes(q) || (c.ansprechperson || "").toLowerCase().includes(q))
      .sort((a, b) => {
        // Im Archiv: neuestens-archiviert zuerst (updated_at desc).
        // updated_at-Vergleich als string ist sortier-OK weil ISO-8601.
        return (b.updated_at || "").localeCompare(a.updated_at || "");
      });
  }, [contacts, search, statusFilter]);

  const counts = useMemo(() => {
    let g = 0, a = 0;
    for (const c of contacts) {
      if (c.status === "gewonnen") g++;
      else if (c.status === "abgesagt") a++;
    }
    return { gewonnen: g, abgesagt: a, total: g + a };
  }, [contacts]);

  return (
    <div className="flex flex-col gap-3 sm:gap-4 h-[calc(100dvh-290px)] md:h-[calc(100vh-72px)]">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4 shrink-0">
        <div className="flex items-center gap-3">
          <BackButton fallbackHref="/vertrieb" size="sm" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Vertrieb-Archiv</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {counts.total} archiviert · {counts.gewonnen} gewonnen · {counts.abgesagt} abgesagt
            </p>
          </div>
        </div>
        <Link href="/vertrieb" className="kasten kasten-muted text-xs">
          <ArrowLeft className="h-3.5 w-3.5" />
          Aktive Leads
        </Link>
      </div>

      {/* 2-Spalten-Layout: Liste + Detail */}
      <div className="flex-1 min-h-0 flex gap-3 rounded-lg overflow-hidden">
        {/* Liste */}
        <div className="w-80 flex flex-col rounded-lg border border-border bg-card overflow-hidden shrink-0">
          <div className="p-2 border-b border-border space-y-1.5 shrink-0">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-1">
              Archiv · {filtered.length}
            </p>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Suche…" className="pl-7 h-8 text-xs"
              />
            </div>
            <div className="flex gap-1">
              <StatusChip
                label="Alle" active={statusFilter === "all"}
                onClick={() => setStatusFilter("all")}
              />
              <StatusChip
                label="Gewonnen" icon={<Check className="h-2.5 w-2.5" />}
                active={statusFilter === "gewonnen"} tone="green"
                onClick={() => setStatusFilter("gewonnen")}
              />
              <StatusChip
                label="Abgesagt" icon={<X className="h-2.5 w-2.5" />}
                active={statusFilter === "abgesagt"} tone="red"
                onClick={() => setStatusFilter("abgesagt")}
              />
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-1">
            {loading ? (
              <p className="text-center text-xs text-muted-foreground py-8">Lade…</p>
            ) : filtered.length === 0 ? (
              <p className="text-center text-xs text-muted-foreground py-8">Keine Eintraege.</p>
            ) : filtered.map((c) => (
              <ArchivRow
                key={c.id}
                contact={c}
                selected={selectedLeadId === c.id}
                onClick={() => setSelectedLeadId(c.id)}
              />
            ))}
          </div>
        </div>

        {/* Detail */}
        <div className="flex-1 min-w-0 rounded-lg border border-border bg-card overflow-hidden">
          {selectedLeadId ? (
            <div className="w-full h-full overflow-y-auto p-4">
              <LeadEditor contactId={selectedLeadId} onClose={() => setSelectedLeadId(null)} />
            </div>
          ) : (
            <div className="w-full h-full flex items-center justify-center text-center text-muted-foreground p-8">
              <div className="space-y-2">
                <p className="text-sm">Kein Lead ausgewählt.</p>
                <p className="text-xs opacity-70">Klick einen Lead links an um Details zu sehen.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusChip({ label, icon, active, onClick, tone }: {
  label: string; icon?: React.ReactNode; active: boolean; onClick: () => void;
  tone?: "green" | "red";
}) {
  const activeClass = !active
    ? "bg-foreground/[0.06] dark:bg-foreground/[0.1] text-foreground hover:bg-foreground/[0.1] dark:hover:bg-foreground/[0.15]"
    : tone === "green"
      ? "bg-green-500 text-white"
      : tone === "red"
        ? "bg-red-500 text-white"
        : "bg-foreground text-background";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${activeClass}`}
    >
      {icon}
      {label}
    </button>
  );
}

function ArchivRow({ contact: c, selected, onClick }: {
  contact: VertriebContact; selected: boolean; onClick: () => void;
}) {
  // Im Archiv: kein Drag, kein Anomalien-Layer, Status-Pill prominent.
  const isWon = c.status === "gewonnen";
  return (
    <Card
      onClick={onClick}
      className={`p-2 cursor-pointer transition-colors ${
        selected
          ? "bg-red-50 border-red-300 dark:bg-red-500/15 dark:border-red-500/40"
          : "bg-card hover:bg-muted/30"
      }`}
    >
      <div className="flex items-start gap-2 min-w-0">
        <div className={`w-1 self-stretch rounded-full shrink-0 ${isWon ? "bg-green-500" : "bg-red-500"}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[9px] font-mono text-muted-foreground bg-foreground/[0.06] dark:bg-foreground/[0.1] px-1 py-0 rounded shrink-0">
              {String(c.nr).padStart(4, "0")}
            </span>
            <p className="text-xs font-semibold truncate">{c.firma}</p>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap text-[10px]">
            <span className={`px-1 py-0 rounded text-[9px] font-medium border ${
              isWon
                ? "bg-green-100 text-green-700 border-green-200 dark:bg-green-500/20 dark:text-green-300 dark:border-green-500/30"
                : "bg-red-100 text-red-700 border-red-200 dark:bg-red-500/20 dark:text-red-300 dark:border-red-500/30"
            }`}>
              {isWon ? "Gewonnen" : "Abgesagt"}
            </span>
            {c.updated_at && (
              <span className="text-muted-foreground tabular-nums">
                {new Date(c.updated_at).toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit", year: "2-digit" })}
              </span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

