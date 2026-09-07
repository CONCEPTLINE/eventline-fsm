"use client";

/**
 * Modus-Auswahl beim Stempeln — idiotensicher.
 *
 * Zwei Varianten:
 *   <RateTierPicker>  — grosse Kacheln fuer Vor-dem-Stempeln (im Modal).
 *   <RateTierSwitcher> — kleine Chips fuer Wechsel-waehrend-laufend.
 *
 * Regel: wenn eine Location nur 1 aktiven Tier hat, werden BEIDE
 * Komponenten NICHTS rendern — dann gibt's keine Wahl, nichts zu klicken.
 * Der grosse Einstempel-Button bleibt der Haupt-Fluss.
 *
 * Icon-Zuordnung ist fest nach `key` — Nutzer-Presets (normal/pikett/
 * admin/aufbau) bekommen ein passendes Icon; Custom-Tiers das Fallback
 * (Clock). Farb-Kodierung: Default = neutral, andere haben eine dezente
 * Akzent-Farbe pro Key damit sie im Kopf unterscheidbar bleiben.
 */

import { useEffect, useState } from "react";
import { Clock, PhoneCall, FileText, Wrench, Check } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export interface RateTier {
  id: string;
  location_id: string;
  key: string;
  label: string;
  /** Aktueller Preis (aus v_location_rate_tiers_current), heute gueltig. */
  current_chf_per_hour: number | null;
  current_effective_from: string | null;
  next_chf_per_hour: number | null;
  next_effective_from: string | null;
  is_default: boolean;
  sort_order: number;
  is_archived: boolean;
}

const ICON_MAP: Record<string, LucideIcon> = {
  normal: Clock,
  pikett: PhoneCall,
  admin: FileText,
  aufbau: Wrench,
};

// Sanfter Akzent pro Preset. Custom → neutral (kein Akzent, damit Chaos
// mit vielen Farben vermieden wird).
interface TierColor {
  bg: string;
  bgActive: string;
  border: string;
  borderActive: string;
  fg: string;
  fgActive: string;
}
const NEUTRAL: TierColor = {
  bg: "var(--muted)",
  bgActive: "rgba(0,0,0,0.06)",
  border: "var(--border)",
  borderActive: "var(--foreground)",
  fg: "var(--foreground)",
  fgActive: "var(--foreground)",
};
const COLOR_MAP: Record<string, TierColor> = {
  normal: NEUTRAL,
  pikett: {
    bg: "rgba(245,158,11,0.08)",
    bgActive: "rgba(245,158,11,0.20)",
    border: "rgba(245,158,11,0.35)",
    borderActive: "rgba(245,158,11,0.70)",
    fg: "rgb(154,90,10)",
    fgActive: "rgb(120,70,10)",
  },
  admin: {
    bg: "rgba(37,99,235,0.06)",
    bgActive: "rgba(37,99,235,0.18)",
    border: "rgba(37,99,235,0.30)",
    borderActive: "rgba(37,99,235,0.70)",
    fg: "rgb(29,78,180)",
    fgActive: "rgb(29,78,180)",
  },
  aufbau: {
    bg: "rgba(124,58,237,0.06)",
    bgActive: "rgba(124,58,237,0.18)",
    border: "rgba(124,58,237,0.30)",
    borderActive: "rgba(124,58,237,0.70)",
    fg: "rgb(88,28,180)",
    fgActive: "rgb(88,28,180)",
  },
};

export function iconForTier(key: string): LucideIcon {
  return ICON_MAP[key] ?? Clock;
}
export function colorForTier(key: string): TierColor {
  return COLOR_MAP[key] ?? NEUTRAL;
}

/**
 * Laedt aktive Tiers fuer eine Location. Ergebnis leer, wenn Location
 * keine Tiers hinterlegt hat (dann UI nichts anzeigen).
 * Gibt zusaetzlich `defaultId` zurueck fuer Auto-Preselect.
 */
export function useLocationRateTiers(locationId: string | null | undefined) {
  const supabase = createClient();
  const [tiers, setTiers] = useState<RateTier[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!locationId) { setTiers([]); return; }
    setLoading(true);
    (async () => {
      const { data } = await supabase
        .from("v_location_rate_tiers_current")
        .select("*")
        .eq("location_id", locationId)
        .eq("is_archived", false)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });
      if (!cancelled) {
        setTiers((data as RateTier[]) ?? []);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [locationId, supabase]);

  const defaultId = tiers.find((t) => t.is_default)?.id ?? tiers[0]?.id ?? null;
  return { tiers, defaultId, loading };
}

/* ============================================================
 * PICKER — grosse Kacheln vor dem Einstempeln.
 * ============================================================ */
export function RateTierPicker({
  tiers,
  value,
  onChange,
}: {
  tiers: RateTier[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  if (tiers.length <= 1) return null;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Was für ein Einsatz?
        </label>
        <span className="text-[10px] text-muted-foreground">
          Wähle den Modus für die Verrechnung
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {tiers.map((t) => {
          const Icon = iconForTier(t.key);
          const color = colorForTier(t.key);
          const active = value === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(t.id)}
              className="relative flex flex-col items-start p-3 rounded-xl border-2 text-left"
              style={{
                backgroundColor: active ? color.bgActive : color.bg,
                borderColor: active ? color.borderActive : color.border,
                color: active ? color.fgActive : color.fg,
                transition: "background-color 160ms, border-color 160ms, transform 160ms",
                transform: active ? "translateY(-1px)" : "translateY(0)",
                boxShadow: active ? "0 4px 12px -4px rgba(0,0,0,0.15)" : "none",
              }}
            >
              {active && (
                <span
                  className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full flex items-center justify-center"
                  style={{ backgroundColor: color.borderActive }}
                >
                  <Check className="h-2.5 w-2.5 text-white" />
                </span>
              )}
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center mb-1.5"
                style={{ backgroundColor: "rgba(0,0,0,0.06)" }}
              >
                <Icon className="h-4 w-4" />
              </div>
              <p className="font-semibold text-sm leading-tight">{t.label}</p>
              <p className="text-[11px] opacity-70 tabular-nums mt-0.5">
                {t.current_chf_per_hour !== null ? `CHF ${Number(t.current_chf_per_hour).toFixed(0)}/h` : "—"}
              </p>
              {t.is_default && !active && (
                <span className="mt-1 text-[9px] font-bold uppercase tracking-wider opacity-60">
                  Standard
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ============================================================
 * SWITCHER — kompakte Chip-Row zum Wechseln waehrend laufend.
 * Aktueller Tier ist prominent, andere sind klickbar mit Pfeil.
 * ============================================================ */
export function RateTierSwitcher({
  tiers,
  currentId,
  onSwitch,
  disabled,
}: {
  tiers: RateTier[];
  currentId: string | null | undefined;
  onSwitch: (id: string) => void;
  disabled?: boolean;
}) {
  if (tiers.length <= 1) return null;
  const others = tiers.filter((t) => t.id !== currentId);
  const current = tiers.find((t) => t.id === currentId);
  return (
    <div className="flex items-center gap-1.5 flex-wrap text-xs">
      <span className="text-muted-foreground text-[10px] uppercase tracking-wider font-semibold mr-0.5">
        Modus:
      </span>
      {current && (
        <span
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-semibold"
          style={{
            backgroundColor: colorForTier(current.key).bgActive,
            color: colorForTier(current.key).fgActive,
            border: `1px solid ${colorForTier(current.key).borderActive}`,
          }}
        >
          {(() => { const Icon = iconForTier(current.key); return <Icon className="h-3 w-3" />; })()}
          {current.label}
        </span>
      )}
      {others.length > 0 && (
        <span className="text-muted-foreground text-[10px]">wechseln →</span>
      )}
      {others.map((t) => {
        const Icon = iconForTier(t.key);
        const color = colorForTier(t.key);
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onSwitch(t.id)}
            disabled={disabled}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium hover:brightness-95 disabled:opacity-50"
            style={{
              backgroundColor: color.bg,
              color: color.fg,
              border: `1px solid ${color.border}`,
            }}
          >
            <Icon className="h-3 w-3" />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
