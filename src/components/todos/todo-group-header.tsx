"use client";

/**
 * TodoGroupHeader — sticky Sub-Header "Ueberfaellig (3)" / "Heute (4)" ...
 *
 * Faltet die Gruppe ein/aus (localStorage-persisted via Parent).
 * Sticky top-0 damit der Header beim Scrollen an der Content-Kante bleibt
 * — der Auftrag-Detail-Header (sticky-header.tsx) nutzt genau dieses
 * Muster. Hintergrund matcht die App-Shell-Farbe damit unter dem
 * sticky-Header nichts durchflimmert.
 */

import { ChevronDown, ChevronRight } from "lucide-react";
import type { GroupBucket } from "@/lib/relative-date";

interface Props {
  bucket: GroupBucket;
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}

export function TodoGroupHeader({ bucket, label, count, collapsed, onToggle }: Props) {
  const overdue = bucket === "overdue";
  return (
    <button
      type="button"
      onClick={onToggle}
      className="sticky top-[var(--kopf-h,0px)] z-10 w-full flex items-center gap-2 px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground bg-[#f5f5f7]/85 dark:bg-[#0a0a0a]/85 backdrop-blur-md rounded-md hover:text-foreground transition-colors"
      aria-expanded={!collapsed}
    >
      {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      <span className={overdue ? "text-red-600 dark:text-red-400" : ""}>{label}</span>
      <span className="text-muted-foreground/70 normal-case tracking-normal">({count})</span>
    </button>
  );
}
