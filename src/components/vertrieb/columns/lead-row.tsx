"use client";

/**
 * LeadRow — kompakte Zeile fuer die General/Personal-Spalte.
 *
 * Drag-Source via native HTML5 DnD. dataTransfer Format: "lead:<id>".
 * Drop-Targets sind die Spalten (siehe general-column / personal-column).
 *
 * Layout: ein Vertikalstreifen mit Stage-Farbe links als visueller Anker,
 * Firma als Bold, kleinem Status-Tag + Last-Touch + Anomalie-Icon.
 * Sehr kompakt damit viele Leads sichtbar bleiben.
 */

import { Card } from "@/components/ui/card";
import { PartyPopper, AlertTriangle, Flame } from "lucide-react";
import type { VertriebContact } from "@/types";
import { STATUS_OPTIONS, STEPS } from "@/app/(app)/vertrieb/constants";
import { detectLeadAnomaly, hasAnomaly, daysSinceLastTouch, parseEventStart } from "@/lib/vertrieb-anomaly";

interface Props {
  contact: VertriebContact;
  selected?: boolean;
  onClick?: (c: VertriebContact) => void;
  draggable?: boolean;
}

export function LeadRow({ contact: c, selected, onClick, draggable = true }: Props) {
  const nowMs = Date.now();
  const anomaly = detectLeadAnomaly(c, nowMs);
  const flagged = hasAnomaly(anomaly);
  const stepNr = c.step || 1;
  const stepConf = STEPS.find((s) => s.nr === stepNr);
  const statusConf = STATUS_OPTIONS.find((s) => s.value === c.status);
  const days = daysSinceLastTouch(c, nowMs);
  const eventStart = parseEventStart(c);
  const isHot = c.prioritaet === "top";

  return (
    <Card
      onClick={() => onClick?.(c)}
      draggable={draggable}
      onDragStart={(e) => {
        if (!draggable) return;
        e.dataTransfer.setData("text/plain", `lead:${c.id}`);
        e.dataTransfer.effectAllowed = "move";
      }}
      className={`p-2 cursor-pointer transition-colors group relative ${
        selected
          ? "bg-red-50 border-red-300 dark:bg-red-500/15 dark:border-red-500/40"
          : "bg-card hover:bg-muted/30"
      } ${draggable ? "active:cursor-grabbing" : ""}`}
    >
      <div className="flex items-start gap-2 min-w-0">
        {/* Vertikaler Stage-Streifen links als visueller Anker */}
        <div className={`w-1 self-stretch rounded-full shrink-0 ${stepColorClass(stepNr)}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <p className="text-xs font-semibold truncate">{c.firma}</p>
            {isHot && <Flame className="h-2.5 w-2.5 text-orange-500 shrink-0" data-tooltip="Top-Prio" />}
            {flagged && <AlertTriangle className="h-2.5 w-2.5 text-amber-500 shrink-0" data-tooltip="Auffaellig" />}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap text-[10px] text-muted-foreground">
            {statusConf && <span className={`px-1 py-0 rounded ${statusConf.color} text-[9px] font-medium border`}>{statusConf.label}</span>}
            <span className="tabular-nums">{stepNr}/4</span>
            {stepConf && <span className="opacity-50">·</span>}
            {days !== null && (
              <span className={anomaly.stale ? "text-red-600 dark:text-red-400 font-semibold" : ""}>
                {days === 0 ? "heute" : days === 1 ? "1d" : `${days}d`}
              </span>
            )}
            {eventStart && (
              <span className="inline-flex items-center gap-0.5 text-purple-600 dark:text-purple-400">
                <PartyPopper className="h-2 w-2" />
                {eventStart.toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit" })}
              </span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

function stepColorClass(step: number): string {
  switch (step) {
    case 1: return "bg-gray-400";
    case 2: return "bg-blue-500";
    case 3: return "bg-teal-500";
    case 4: return "bg-emerald-500";
    default: return "bg-gray-400";
  }
}
