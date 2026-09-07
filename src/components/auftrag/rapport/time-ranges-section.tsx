"use client";

// Einsatzzeiten-Sektion: Liste pro Tag mit Datum, Techniker, Von/Bis,
// Pause + Gesamt-Stunden-Anzeige. Selbstaendige UI-Komponente — die
// Berechnungen (Dauer pro Range / Total) leben hier weil sie nur fuer
// Anzeige sind. Das Parent kriegt nur die TimeRange[]-Liste via onChange.

import { Trash2, Plus, Ban, CheckCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { usePrompt } from "@/components/ui/use-prompt";
import { SearchableSelect } from "@/components/searchable-select";
import { iconForTier, colorForTier, type RateTier } from "@/components/stempel/rate-tier-chooser";
import type { TimeRange, ProfileOption } from "./types";

interface Props {
  timeRanges: TimeRange[];
  profiles: ProfileOption[];
  isReadOnly: boolean;
  onChange: (next: TimeRange[]) => void;
  /** Verfuegbare Verrechnungssatz-Tiers der Location (aus rapport-form-modal
   *  geladen). Wenn <= 1 Tier: kein Modus-Chip anzeigen (nichts zu waehlen). */
  rateTiers?: RateTier[];
  /** Default-Tier-ID der Location. Range mit rate_tier_id=null wird
   *  optisch als "Standard (X)" gezeigt — kein Ratespiel. */
  defaultTierId?: string | null;
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

export function TimeRangesSection({ timeRanges, profiles, isReadOnly, onChange, rateTiers = [], defaultTierId = null }: Props) {
  const { prompt, PromptModalElement } = usePrompt();
  const showTierPicker = rateTiers.length > 1;

  function addRange() {
    onChange([...timeRanges, { date: "", start: "", end: "", pause: 0, technician_id: "" }]);
  }
  function removeRange(i: number) {
    if (timeRanges.length <= 1) return;
    onChange(timeRanges.filter((_, idx) => idx !== i));
  }
  function updateRange(i: number, field: keyof TimeRange, value: string | number | boolean) {
    onChange(timeRanges.map((tr, idx) => idx === i ? { ...tr, [field]: value } : tr));
  }

  async function toggleNotBillable(i: number) {
    const tr = timeRanges[i];
    if (tr.not_billable) {
      // Aus: not_billable + reason loeschen
      onChange(timeRanges.map((t, idx) => idx === i ? { ...t, not_billable: false, not_billable_reason: undefined } : t));
      return;
    }
    const reason = await prompt({
      title: "Stunden nicht verrechnen",
      label: "Warum werden diese Stunden NICHT dem Kunden verrechnet?",
      hint: "Wird im Rapport-PDF und in der Abrechnung dokumentiert.",
      placeholder: "z.B. Kulanz, Eigenleistung, Fehler-Korrektur — kostenlos",
      confirmLabel: "Als nicht verrechnet markieren",
      variant: "red",
    });
    if (!reason) return;
    onChange(timeRanges.map((t, idx) => idx === i ? { ...t, not_billable: true, not_billable_reason: reason } : t));
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
          Achtung: zwei oder mehr Zeitbereiche für denselben Techniker am gleichen Tag überschneiden sich. Stunden werden doppelt gezählt.
        </div>
      )}
      {timeRanges.map((tr, i) => (
        <div
          key={i}
          id={`time-range-${i}`}
          className={`p-3 rounded-xl border space-y-3 ${
            tr.not_billable
              ? "bg-yellow-50/60 border-yellow-400/60 dark:bg-yellow-500/[0.08] dark:border-yellow-500/40"
              : overlapIdx.has(i)
                ? "bg-amber-50/60 border-amber-300 dark:bg-amber-500/[0.08] dark:border-amber-500/40"
                : "bg-muted/30"
          }`}
        >
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground">
                {timeRanges.length > 1 ? `Tag ${i + 1}` : "Einsatztag"}
              </span>
              {tr.not_billable && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-yellow-200/60 text-yellow-900 dark:bg-yellow-500/25 dark:text-yellow-200"
                  data-tooltip={tr.not_billable_reason ?? ""}
                >
                  <Ban className="h-2.5 w-2.5" />Nicht verrechnet
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium">{calcDuration(tr)}</span>
              {timeRanges.length > 1 && (
                <button type="button" onClick={() => removeRange(i)} className="icon-btn icon-btn-red" aria-label="Zeitbereich entfernen" data-tooltip="Entfernen">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
          {tr.not_billable && tr.not_billable_reason && (
            <div className="px-2 py-1.5 rounded-md bg-yellow-100/60 dark:bg-yellow-500/10 text-[11px] text-yellow-900 dark:text-yellow-200 italic">
              <span className="font-semibold not-italic">Grund:</span> {tr.not_billable_reason}
            </div>
          )}
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
              <div className="mt-1">
                {isReadOnly ? (
                  <div className="h-9 px-3 text-xs rounded-lg border bg-muted/40 flex items-center opacity-60">
                    {profiles.find((p) => p.id === tr.technician_id)?.full_name ?? "—"}
                  </div>
                ) : (
                  <SearchableSelect
                    value={tr.technician_id}
                    onChange={(v) => updateRange(i, "technician_id", v)}
                    items={profiles.map((p) => ({ id: p.id, label: p.full_name }))}
                    placeholder="Auswählen…"
                    required
                  />
                )}
              </div>
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
          {/* Modus-Auswahl pro Range — nur wenn Location > 1 Tier hat und
              die Range nicht als nicht-verrechnet markiert ist. Chip-Row
              statt Dropdown, weil visuell sofort klar was gewaehlt ist. */}
          {showTierPicker && !tr.not_billable && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Modus</span>
              {rateTiers.map((tier) => {
                const Icon = iconForTier(tier.key);
                const color = colorForTier(tier.key);
                // Aktiv wenn ausdruecklich gewaehlt ODER (nichts gewaehlt UND das ist der Default).
                const active = tr.rate_tier_id === tier.id
                  || (!tr.rate_tier_id && tier.id === defaultTierId);
                return (
                  <button
                    key={tier.id}
                    type="button"
                    onClick={() => updateRange(i, "rate_tier_id", tier.id)}
                    disabled={isReadOnly}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium disabled:opacity-60"
                    style={{
                      backgroundColor: active ? color.bgActive : color.bg,
                      color: active ? color.fgActive : color.fg,
                      border: `1.5px solid ${active ? color.borderActive : color.border}`,
                      transition: "background-color 120ms, border-color 120ms",
                    }}
                  >
                    <Icon className="h-3 w-3" />
                    {tier.label}
                    {tier.id === defaultTierId && !active && (
                      <span className="text-[9px] opacity-60 ml-0.5">Standard</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {!isReadOnly && (
            <button
              type="button"
              onClick={() => toggleNotBillable(i)}
              className={`w-full ${tr.not_billable ? "kasten kasten-green" : "kasten kasten-red"}`}
            >
              {tr.not_billable ? (
                <>
                  <CheckCircle className="h-3.5 w-3.5" />
                  Diese Stunden wieder verrechnen
                </>
              ) : (
                <>
                  <Ban className="h-3.5 w-3.5" />
                  Diese Stunden NICHT verrechnen
                </>
              )}
            </button>
          )}
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
      {PromptModalElement}
    </div>
  );
}
