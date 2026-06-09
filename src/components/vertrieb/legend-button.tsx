"use client";

import { useRef, useState } from "react";
import { HelpCircle, Flame, AlertTriangle, PartyPopper } from "lucide-react";

/**
 * Legende-Popover: erklaert die Karten-Icons + Stage-Farben + Text-Codes.
 *
 * Plaziert im Header der GeneralColumn rechts neben "Alle Leads".
 * Popover-Positionierung via position:fixed + Button-Rect — sonst wuerde
 * der overflow:hidden der Spalte (fuer rounded-corners) das Popover
 * cutten. Backdrop schliesst beim Klick ausserhalb.
 */
export function LegendButton() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    }
    setOpen((v) => !v);
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors"
        aria-label="Legende"
      >
        <HelpCircle className="h-3 w-3" />
        Legende
      </button>
      {open && pos && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
          <div
            className="fixed w-72 rounded-lg border border-border bg-card shadow-lg p-3 z-[70] space-y-2.5 text-xs"
            style={{ top: pos.top, right: pos.right }}
          >
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
    </>
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
