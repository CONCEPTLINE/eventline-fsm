"use client";

/**
 * GeneralColumn — alle aktiven Leads (status != gewonnen/abgesagt).
 *
 * Drag-Source: jeder Lead ist draggable. Sortiert nach Last-Touch
 * (aelteste zuerst — "vergessene" Leads stehen oben).
 *
 * Drop-Target: wenn jemand einen Lead aus der eigenen Spalte hierher
 * zurueck-droppt, wird er unassigned (assigned_to = null).
 *
 * Quick-Filter: Suche + 3 Toggle-Chips (Hot / Stale / Bald).
 */

import { useMemo, useState } from "react";
import { Search, Flame, AlertTriangle, PartyPopper } from "lucide-react";
import { Input } from "@/components/ui/input";
import { LeadRow } from "./lead-row";
import { LegendButton } from "@/components/vertrieb/legend-button";
import type { VertriebContact } from "@/types";
import { detectLeadAnomaly, daysSinceLastTouch, parseEventStart } from "@/lib/vertrieb-anomaly";

interface Props {
  contacts: VertriebContact[];
  selectedId: string | null;
  onSelect: (c: VertriebContact) => void;
  onUnassign: (leadId: string) => void;
  canReassign: boolean;
}

export function GeneralColumn({ contacts, selectedId, onSelect, onUnassign, canReassign }: Props) {
  const [search, setSearch] = useState("");
  const [filterHot, setFilterHot] = useState(false);
  const [filterStale, setFilterStale] = useState(false);
  const [filterSoon, setFilterSoon] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const nowMs = Date.now();

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return contacts
      // Pool-Sicht: nur nicht-zugewiesene Leads. Sobald jemand einen
      // Lead per Drag-Drop in seine Personal-Column zieht, verschwindet
      // er aus dieser Liste. Admins koennen via Personal-Column-Switcher
      // fremde Zuweisungen anschauen.
      .filter((c) => !c.assigned_to)
      .filter((c) => c.status !== "gewonnen" && c.status !== "abgesagt")
      .filter((c) => !q || c.firma.toLowerCase().includes(q) || (c.ansprechperson || "").toLowerCase().includes(q))
      .filter((c) => !filterHot || c.prioritaet === "top")
      .filter((c) => !filterStale || detectLeadAnomaly(c, nowMs).stale)
      .filter((c) => {
        if (!filterSoon) return true;
        const ev = parseEventStart(c);
        if (!ev) return false;
        const days = Math.floor((ev.getTime() - nowMs) / (1000 * 60 * 60 * 24));
        return days >= 0 && days <= 30;
      })
      .sort((a, b) => {
        const ad = daysSinceLastTouch(a, nowMs);
        const bd = daysSinceLastTouch(b, nowMs);
        if (ad === null && bd === null) return 0;
        if (ad === null) return 1;
        if (bd === null) return -1;
        return bd - ad; // groesserer days-Wert = aelter = oben
      });
  }, [contacts, search, filterHot, filterStale, filterSoon, nowMs]);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const data = e.dataTransfer.getData("text/plain");
    if (!data.startsWith("lead:")) return;
    const leadId = data.slice(5);
    // Drop hier = unassign. Berechtigung: jeder darf "zurueckgeben"
    // (eigene Leads aus persoenlicher Spalte abgeben). Reassign-Schutz
    // greift nur beim Drop in PERSONAL — hier nehmen wir alles.
    onUnassign(leadId);
  }

  return (
    <div
      className={`flex flex-col h-full min-h-0 ${dragOver ? "ring-2 ring-red-500 ring-inset" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="p-2 border-b border-border space-y-1.5 shrink-0">
        <div className="flex items-center justify-between px-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Alle Leads · {filtered.length}
          </p>
          <LegendButton />
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Suche…" className="pl-7 h-8 text-xs"
          />
        </div>
        <div className="flex gap-1 flex-wrap">
          <FilterChip icon={Flame} label="Hot" active={filterHot} onClick={() => setFilterHot((v) => !v)} />
          <FilterChip icon={AlertTriangle} label="Stale" active={filterStale} onClick={() => setFilterStale((v) => !v)} />
          <FilterChip icon={PartyPopper} label="Bald" active={filterSoon} onClick={() => setFilterSoon((v) => !v)} />
        </div>
      </div>

      {/* Liste */}
      <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-1">
        {filtered.length === 0 ? (
          <p className="text-center text-xs text-muted-foreground py-8">Keine Leads.</p>
        ) : filtered.map((c) => (
          <LeadRow
            key={c.id}
            contact={c}
            selected={selectedId === c.id}
            onClick={onSelect}
            draggable
          />
        ))}
      </div>

      {/* Hint fuer Drop-Target */}
      {!canReassign && (
        <p className="text-[9px] text-muted-foreground/70 p-2 border-t border-border shrink-0">
          Hierhin droppen = aus persoenlicher Spalte zurueckgeben.
        </p>
      )}
    </div>
  );
}

function FilterChip({ icon: Icon, label, active, onClick }: {
  icon: typeof Flame; label: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
        active
          ? "bg-red-500 text-white"
          : "bg-foreground/[0.06] dark:bg-foreground/[0.1] text-foreground hover:bg-foreground/[0.1] dark:hover:bg-foreground/[0.15]"
      }`}
    >
      <Icon className="h-2.5 w-2.5" />
      {label}
    </button>
  );
}
