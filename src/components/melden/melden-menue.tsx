"use client";

/**
 * «+ Melden» in der Sidebar (Laptop), unter dem Stempel-Knopf: kleines Menue
 * mit Beleg · Krank · Abwesenheit · Stempel korrigieren · Anderes melden.
 * Jeder Eintrag oeffnet direkt das Formular (oeffneMelden → MeldenHost).
 * Oeffnet nach oben (Sidebar-Fuss); Esc und Klick ausserhalb schliessen.
 */

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { ANDERES_LABEL, MELDEN_KACHELN, darfMelden, oeffneMelden, type MeldenArt } from "@/lib/melden";
import { usePermissions } from "@/lib/use-permissions";
import { MELDEN_ICONS } from "./melden-kacheln";

const EINTRAEGE: Array<{ art: MeldenArt; label: string }> = [
  ...MELDEN_KACHELN.map((k) => ({ art: k.art, label: k.label })),
  { art: "anderes", label: ANDERES_LABEL },
];

export function MeldenMenue() {
  const { can } = usePermissions();
  const eintraege = EINTRAEGE.filter((e) => darfMelden(e.art, can));
  const [offen, setOffen] = useState(false);
  const [hover, setHover] = useState(false);
  const [aktiv, setAktiv] = useState<MeldenArt | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!offen) return;
    const weg = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOffen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOffen(false); };
    document.addEventListener("mousedown", weg);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", weg);
      document.removeEventListener("keydown", esc);
    };
  }, [offen]);

  function waehle(art: MeldenArt) {
    setOffen(false);
    oeffneMelden(art);
  }

  return (
    <div ref={ref} className="relative px-3 mb-2">
      <button
        type="button"
        onClick={() => setOffen((o) => !o)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        aria-haspopup="menu"
        aria-expanded={offen}
        className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-xl text-[13px] font-medium text-sidebar-foreground/80"
        style={{
          transition: "background-color 150ms",
          border: "1px solid var(--sidebar-border, rgba(127,127,127,0.25))",
          backgroundColor: hover || offen ? "rgba(127,127,127,0.12)" : "transparent",
        }}
      >
        <Plus className="h-4 w-4" />
        <span className="flex-1 text-left">Melden</span>
      </button>
      {offen && (
        <div
          role="menu"
          className="absolute bottom-full left-3 right-3 mb-1 z-50 overflow-hidden rounded-xl border border-border bg-card py-1 shadow-lg"
        >
          {eintraege.map((e) => {
            const Icon = MELDEN_ICONS[e.art];
            return (
              <button
                key={e.art}
                type="button"
                role="menuitem"
                onClick={() => waehle(e.art)}
                onMouseEnter={() => setAktiv(e.art)}
                onMouseLeave={() => setAktiv(null)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-left text-[13px] ${e.art === "anderes" ? "border-t border-border text-muted-foreground" : ""}`}
                style={{ backgroundColor: aktiv === e.art ? "rgba(127,127,127,0.12)" : "transparent" }}
              >
                {e.art !== "anderes" && <Icon className="h-4 w-4 shrink-0 text-red-500" />}
                {e.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
