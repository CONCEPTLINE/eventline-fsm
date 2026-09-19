"use client";

/**
 * Filter-Leiste der Todos-Seite (drastisch reduziert 2026-09).
 *
 * Vorher: Scope-Segment (4) + Zeit-Segment (3) + Status-Segment (3) +
 * Suche + Prio-Toggle + Personen-Filter — insgesamt 7+ Filter-Elemente,
 * der User war ueberfordert.
 *
 * Jetzt: EIN Scope-Segment links (mine / delegated [/ all wenn canSeeAll])
 * mit Live-Counts + rechts Search + "Erledigte anzeigen"-Toggle. Fertig.
 *
 * Rationale:
 *  - Zeit-Filter weg — die Sortierung (dringend > ueberfaellig > heute >
 *    Rest) macht das eh sichtbar.
 *  - "Nur dringend"-Filter weg — Dringend-Chips sind in der Liste
 *    sichtbar, Sortierung stellt sie oben.
 *  - "Geloescht"-View weg — geloeschte Todos sind soft-deleted und in
 *    der UI komplett unsichtbar. Wer wiederherstellen will: Admin/DB.
 *  - Personen-Filter weg — kommt zurueck wenn Bedarf da ist.
 */

import { Search, X, Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { StickyFilterBar } from "@/components/ui/sticky-filter-bar";
import type { TodoScope } from "@/lib/todos-query";

export interface FilterState {
  scope: TodoScope;
  showCompleted: boolean;
  search: string;
}

export interface ScopeCounts { mine: number; delegated: number; all: number }

interface Props {
  state: FilterState;
  counts: ScopeCounts;
  canSeeAll: boolean;
  onChange: (patch: Partial<FilterState>) => void;
}

function Seg<T extends string>({
  value, current, label, onClick, badge,
}: { value: T; current: T; label: string; onClick: (v: T) => void; badge?: number }) {
  const active = value === current;
  return (
    <button
      type="button"
      onClick={() => onClick(value)}
      className={active ? "kasten-active" : "kasten-toggle-off"}
    >
      {label}
      {badge !== undefined && badge > 0 && (
        <span className={`ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full text-[10px] font-semibold px-1 ${
          active ? "bg-foreground/20" : "bg-foreground/[0.08] text-muted-foreground"
        }`}>
          {badge}
        </span>
      )}
    </button>
  );
}

export function TodoFilters({ state, counts, canSeeAll, onChange }: Props) {
  return (
    <StickyFilterBar className="flex flex-col sm:flex-row sm:items-center gap-2">
      {/* Links: Scope-Segment mit Counts. Bei canSeeAll dazu "Alle". */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Seg value="mine"      current={state.scope} label="Für mich" onClick={(v) => onChange({ scope: v })} badge={counts.mine} />
        <Seg value="delegated" current={state.scope} label="Delegiert" onClick={(v) => onChange({ scope: v })} badge={counts.delegated} />
        {canSeeAll && (
          <Seg value="all" current={state.scope} label="Alle" onClick={(v) => onChange({ scope: v })} badge={counts.all} />
        )}
      </div>

      {/* Rechts: Suche + "Erledigte anzeigen"-Toggle (Kasten). */}
      <div className="flex items-center gap-2 sm:ml-auto sm:flex-1 sm:max-w-md">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Suchen ..."
            value={state.search}
            onChange={(e) => onChange({ search: e.target.value })}
            className="pl-9 h-9"
          />
          {state.search && (
            <button
              type="button"
              onClick={() => onChange({ search: "" })}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground rounded transition-colors"
              data-tooltip="Suche zurücksetzen"
              aria-label="Suche zurücksetzen"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => onChange({ showCompleted: !state.showCompleted })}
          className={state.showCompleted ? "kasten-active" : "kasten-toggle-off"}
          data-tooltip="Auch erledigte Todos in der Liste anzeigen"
        >
          <Check className="h-3.5 w-3.5" />
          Erledigte
        </button>
      </div>
    </StickyFilterBar>
  );
}
