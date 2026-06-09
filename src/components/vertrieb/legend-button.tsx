"use client";

import { useState } from "react";
import { HelpCircle, Flame, AlertTriangle, PartyPopper } from "lucide-react";

/**
 * Legende-Popover: erklaert die Karten-Icons + Stage-Farben + Text-Codes.
 *
 * Plaziert im Header der GeneralColumn rechts neben "Alle Leads".
 * Klick toggled das Popover; Backdrop schliesst beim Klick ausserhalb.
 */
export function LegendButton() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors"
        aria-label="Legende"
      >
        <HelpCircle className="h-3 w-3" />
        Legende
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 w-72 rounded-lg border border-border bg-card shadow-lg p-3 z-50 space-y-2.5 text-xs">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Was bedeuten die Zeichen?</p>
            <Section title="Stage-Streifen (links der Karte)">
              <Item swatch={<span className="w-1 h-3.5 rounded-full bg-gray-400" />} label="1 — Offen" />
              <Item swatch={<span className="w-1 h-3.5 rounded-full bg-blue-500" />} label="2 — Kontaktiert" />
              <Item swatch={<span className="w-1 h-3.5 rounded-full bg-teal-500" />} label="3 — Finalisierung" />
              <Item swatch={<span className="w-1 h-3.5 rounded-full bg-emerald-500" />} label="4 — Operations" />
            </Section>
            <Section title="Icons">
              <Item swatch={<Flame className="h-3 w-3 text-orange-500" />} label="Top-Prioritaet" />
              <Item swatch={<AlertTriangle className="h-3 w-3 text-amber-500" />} label="Auffaellig (Stale, Hot+Offen, Event-bald, Vergessen)" />
              <Item swatch={<PartyPopper className="h-3 w-3 text-purple-500" />} label="Event-Datum" />
            </Section>
            <Section title="Text">
              <Item swatch={<span className="text-[10px] tabular-nums">3d</span>} label="Tage seit letztem Kontakt" />
              <Item swatch={<span className="text-[10px] tabular-nums text-red-600 dark:text-red-400 font-semibold">15d</span>} label="Rot bold = stale (>14 Tage)" />
              <Item swatch={<span className="text-[10px] tabular-nums">2/4</span>} label="Aktuelle Stage / Total" />
            </Section>
          </div>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-muted-foreground mb-1">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Item({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-5 flex justify-center items-center shrink-0">{swatch}</div>
      <span className="text-[11px]">{label}</span>
    </div>
  );
}
