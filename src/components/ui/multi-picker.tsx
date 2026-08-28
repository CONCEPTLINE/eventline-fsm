"use client";

/**
 * MultiPicker — kompaktes Multi-Select mit integriertem Suchfeld oben.
 * Für Fälle wo mehrere Personen ausgewählt werden (Termin-Teilnehmer,
 * Zuweisungen, etc.). Kategorien-basiert (z.B. "Mitarbeiter" +
 * "Kunden") mit Gruppen-Trennung in der Liste.
 *
 * Ausgewählte werden als Chip-Reihe oben angezeigt, Klick auf X entfernt.
 */

import { useMemo, useState } from "react";
import { X, Search } from "lucide-react";

export interface MultiPickerItem {
  id: string;
  label: string;
  /** Optionaler Gruppen-Header über der Zeile — z.B. "Mitarbeiter" / "Kunden". */
  group?: string;
  /** Kleine Zweitzeile — z.B. Rolle, E-Mail. Wird auch in der Suche verwendet. */
  sublabel?: string;
}

interface Props {
  items: MultiPickerItem[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  emptyLabel?: string;
  /** Max-Höhe der Liste in px (default 224 = h-56). */
  maxListHeight?: number;
}

export function MultiPicker({
  items,
  selectedIds,
  onChange,
  placeholder = "Suchen …",
  emptyLabel = "Keine Treffer",
  maxListHeight = 224,
}: Props) {
  const [q, setQ] = useState("");
  const selectedSet = new Set(selectedIds);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return items;
    return items.filter((it) => (
      it.label.toLowerCase().includes(term) ||
      (it.sublabel?.toLowerCase().includes(term) ?? false) ||
      (it.group?.toLowerCase().includes(term) ?? false)
    ));
  }, [items, q]);

  // Nach Gruppen unterteilen (Reihenfolge erhalten via Map)
  const grouped = useMemo(() => {
    const map = new Map<string, MultiPickerItem[]>();
    for (const it of filtered) {
      const g = it.group ?? "";
      const list = map.get(g) ?? [];
      list.push(it);
      map.set(g, list);
    }
    return Array.from(map.entries());
  }, [filtered]);

  function toggle(id: string) {
    if (selectedSet.has(id)) onChange(selectedIds.filter((x) => x !== id));
    else onChange([...selectedIds, id]);
  }

  const selectedItems = items.filter((it) => selectedSet.has(it.id));

  return (
    <div className="space-y-2">
      {selectedItems.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selectedItems.map((it) => (
            <span key={it.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/10 text-red-700 dark:text-red-300 text-[11px] font-medium">
              {it.label}
              <button type="button" onClick={() => toggle(it.id)} className="hover:text-red-800 dark:hover:text-red-200" aria-label="Entfernen">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="rounded-lg border border-border bg-background overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border px-2 py-1.5 bg-muted/30">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={placeholder}
            className="w-full bg-transparent border-0 focus:outline-none focus:ring-0 text-sm placeholder:text-muted-foreground/60"
          />
          {q && (
            <button type="button" onClick={() => setQ("")} className="text-muted-foreground hover:text-foreground shrink-0">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="overflow-y-auto" style={{ maxHeight: maxListHeight }}>
          {filtered.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground text-center italic">{emptyLabel}</p>
          ) : (
            grouped.map(([group, list]) => (
              <div key={group}>
                {group && (
                  <p className="sticky top-0 bg-card/95 backdrop-blur px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b border-border/40">
                    {group}
                  </p>
                )}
                {list.map((it) => {
                  const checked = selectedSet.has(it.id);
                  return (
                    <label
                      key={it.id}
                      className={`flex items-center gap-2 px-2 py-1.5 cursor-pointer text-sm transition-colors ${checked ? "bg-red-500/[0.08]" : "hover:bg-muted/40"}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(it.id)}
                        className="h-3.5 w-3.5 accent-red-500"
                      />
                      <span className="flex-1 min-w-0">
                        <span className="block truncate">{it.label}</span>
                        {it.sublabel && <span className="block text-[10px] text-muted-foreground truncate">{it.sublabel}</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
