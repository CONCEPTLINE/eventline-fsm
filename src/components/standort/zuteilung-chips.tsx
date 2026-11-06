"use client";

/**
 * Chips fuer die Zuteilung Mitarbeiter ↔ Location (Tabelle standort_mitarbeiter):
 * Chip mit × zum Entfernen und ein SearchableSelect «hinzufügen», das nach
 * jeder Auswahl wieder leer ist. Genutzt in Einstellungen › Mitarbeiter
 * (Bearbeiten-Modal) und auf der Location (Übersicht › «Eingeteilt»).
 * Vorlage: Skizze /skizze/personal (freigegeben 05.11.2026).
 * Hover state-driven per inline-style (§3).
 */

import { useState } from "react";
import { X } from "lucide-react";
import { SearchableSelect, type SelectItem } from "@/components/searchable-select";

export function EntfernbarChip({
  label,
  icon,
  onEntfernen,
  entfernenText,
  disabled = false,
}: {
  label: string;
  icon?: React.ReactNode;
  onEntfernen?: () => void;
  entfernenText?: string;
  /** true = Entfernen gesperrt (z. B. waehrend gespeichert wird). */
  disabled?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const aktiv = hover && !disabled;
  return (
    <span
      className={`inline-flex items-center gap-1 ${onEntfernen ? "pl-2 pr-0.5" : "px-2"} py-0.5 text-[12px] font-medium rounded-full border border-foreground/10 dark:border-foreground/20 bg-foreground/[0.04] dark:bg-foreground/[0.10] text-foreground/85`}
    >
      {icon}
      {label}
      {onEntfernen && (
        <button
          type="button"
          onClick={onEntfernen}
          disabled={disabled}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          aria-label={entfernenText}
          data-tooltip={entfernenText}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full disabled:opacity-50"
          style={{
            color: aktiv ? "var(--status-red)" : undefined,
            backgroundColor: aktiv ? "rgba(220, 38, 38, 0.12)" : "transparent",
            transition: "background-color 150ms, color 150ms",
          }}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

export function HinzufuegenSelect({
  items,
  placeholder,
  onWahl,
}: {
  items: SelectItem[];
  placeholder: string;
  onWahl: (id: string) => void;
}) {
  // Nach jeder Wahl neu aufbauen, damit das Feld wieder leer ist.
  const [runde, setRunde] = useState(0);
  return (
    <SearchableSelect
      key={runde}
      value=""
      onChange={(id) => {
        if (!id) return;
        onWahl(id);
        setRunde((r) => r + 1);
      }}
      items={items}
      placeholder={items.length === 0 ? "Alle bereits eingeteilt" : placeholder}
      clearable={false}
    />
  );
}
