"use client";

// Einsatzzeiten-Sektion: Liste pro Tag mit Datum, Techniker, Von/Bis,
// Pause + Gesamt-Stunden-Anzeige. Selbstaendige UI-Komponente — die
// Berechnungen (Dauer pro Range / Total) leben hier weil sie nur fuer
// Anzeige sind. Das Parent kriegt nur die TimeRange[]-Liste via onChange.

import { Trash2, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { TimeRange, ProfileOption } from "./types";

interface Props {
  timeRanges: TimeRange[];
  profiles: ProfileOption[];
  isReadOnly: boolean;
  onChange: (next: TimeRange[]) => void;
}

function trMinutes(tr: TimeRange): number {
  if (!tr.start || !tr.end) return 0;
  const [sh, sm] = tr.start.split(":").map(Number);
  const [eh, em] = tr.end.split(":").map(Number);
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return 0;
  const m = (eh * 60 + em) - (sh * 60 + sm) - (tr.pause || 0);
  return m > 0 ? m : 0;
}

function calcDuration(tr: TimeRange): string {
  const m = trMinutes(tr);
  if (m <= 0) return "–";
  return `${Math.floor(m / 60)}h ${m % 60 > 0 ? (m % 60) + "m" : ""}`.trim();
}

function calcTotalHours(timeRanges: TimeRange[]): string {
  const totalMin = timeRanges.reduce((sum, tr) => sum + trMinutes(tr), 0);
  if (totalMin <= 0) return "0h";
  return `${Math.floor(totalMin / 60)}h ${totalMin % 60 > 0 ? (totalMin % 60) + "m" : ""}`.trim();
}

// Findet Indizes von Zeitbereichen die sich mit anderen auf dem
// gleichen (Datum, Techniker)-Tupel ueberlappen. Nutzt einfache
// Pairwise-Pruefung — fuer < 100 Eintraege OK.
function findOverlapIndices(timeRanges: TimeRange[]): Set<number> {
  const conflicts = new Set<number>();
  const toMin = (t: string): number | null => {
    if (!t) return null;
    const [h, m] = t.split(":").map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
  };
  for (let i = 0; i < timeRanges.length; i++) {
    const a = timeRanges[i];
    if (!a.date || !a.technician_id) continue;
    const aStart = toMin(a.start);
    const aEnd = toMin(a.end);
    if (aStart === null || aEnd === null || aEnd <= aStart) continue;
    for (let j = i + 1; j < timeRanges.length; j++) {
      const b = timeRanges[j];
      if (b.date !== a.date || b.technician_id !== a.technician_id) continue;
      const bStart = toMin(b.start);
      const bEnd = toMin(b.end);
      if (bStart === null || bEnd === null || bEnd <= bStart) continue;
      // Overlap: a.start < b.end && b.start < a.end
      if (aStart < bEnd && bStart < aEnd) {
        conflicts.add(i);
        conflicts.add(j);
      }
    }
  }
  return conflicts;
}

export function TimeRangesSection({ timeRanges, profiles, isReadOnly, onChange }: Props) {
  function addRange() {
    onChange([...timeRanges, { date: "", start: "", end: "", pause: 0, technician_id: "" }]);
  }
  function removeRange(i: number) {
    if (timeRanges.length <= 1) return;
    onChange(timeRanges.filter((_, idx) => idx !== i));
  }
  function updateRange(i: number, field: keyof TimeRange, value: string | number) {
    onChange(timeRanges.map((tr, idx) => idx === i ? { ...tr, [field]: value } : tr));
  }

  const overlapIdx = findOverlapIndices(timeRanges);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Einsatzzeiten</p>
        <span className="text-xs font-semibold text-red-600">Total: {calcTotalHours(timeRanges)}</span>
      </div>
      {overlapIdx.size > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          Achtung: zwei oder mehr Zeitbereiche fuer denselben Techniker am gleichen Tag ueberschneiden sich. Stunden werden doppelt gezaehlt.
        </div>
      )}
      {timeRanges.map((tr, i) => (
        <div
          key={i}
          id={`time-range-${i}`}
          className={`p-3 rounded-xl border space-y-3 ${
            overlapIdx.has(i)
              ? "bg-amber-50/60 border-amber-300 dark:bg-amber-500/[0.08] dark:border-amber-500/40"
              : "bg-muted/30"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground">
              {timeRanges.length > 1 ? `Tag ${i + 1}` : "Einsatztag"}
            </span>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium">{calcDuration(tr)}</span>
              {timeRanges.length > 1 && (
                <button type="button" onClick={() => removeRange(i)} className="icon-btn icon-btn-red" aria-label="Zeitbereich entfernen" data-tooltip="Entfernen">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
          {/* Layout: Datum + Techniker oben (50/50), Von/Bis/Pause
              unten (3 Spalten). So hat das Datum-Feld genug Breite
              um die ganze "DD.MM.YYYY"-Anzeige zu zeigen. */}
          <div className="grid grid-cols-2 gap-3">
            <div id={`time-range-${i}-date`} className="min-w-0">
              <label className="text-[11px] font-medium text-muted-foreground">Datum *</label>
              <Input type="date" value={tr.date} onChange={(e) => updateRange(i, "date", e.target.value)} disabled={isReadOnly} required className="mt-1 h-9 text-xs" />
            </div>
            <div id={`time-range-${i}-technician`} className="min-w-0">
              <label className="text-[11px] font-medium text-muted-foreground">Techniker *</label>
              <select
                value={tr.technician_id}
                onChange={(e) => updateRange(i, "technician_id", e.target.value)}
                disabled={isReadOnly}
                required
                className="mt-1 w-full h-9 px-2 text-xs rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
              >
                <option value="">Auswählen…</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.full_name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div id={`time-range-${i}-start`} className="min-w-0">
              <label className="text-[11px] font-medium text-muted-foreground">Von *</label>
              <Input type="time" value={tr.start} onChange={(e) => updateRange(i, "start", e.target.value)} disabled={isReadOnly} required className="mt-1 h-9 text-xs" />
            </div>
            <div id={`time-range-${i}-end`} className="min-w-0">
              <label className="text-[11px] font-medium text-muted-foreground">Bis *</label>
              <Input type="time" value={tr.end} onChange={(e) => updateRange(i, "end", e.target.value)} disabled={isReadOnly} required className="mt-1 h-9 text-xs" />
            </div>
            <div className="min-w-0">
              <label className="text-[11px] font-medium text-muted-foreground">Pause (Min) *</label>
              <Input type="number" min={0} step={5} value={tr.pause} onChange={(e) => updateRange(i, "pause", parseInt(e.target.value) || 0)} disabled={isReadOnly} required className="mt-1 h-9 text-xs" />
            </div>
          </div>
        </div>
      ))}
      {!isReadOnly && (
        <button
          type="button"
          onClick={addRange}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-xl border-2 border-dashed text-sm font-medium text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Weitere Stunden hinzufügen
        </button>
      )}
    </div>
  );
}
