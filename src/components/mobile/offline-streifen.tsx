"use client";

/**
 * Offline-Streifen (Handy, 36 px) unter dem mobilen Kopf:
 *   ohne Netz   → amber «Ohne Netz · 2 Aktionen warten»
 *   mit Netz    → blau «Wird übertragen…» (Reihe laeuft) bzw. amber
 *                 «2 Aktionen warten · antippen», wenn eine Entscheidung
 *                 (Konflikt/Fehler/abgelehnt) noetig ist
 * Rendert nichts, wenn online und nichts wartet. Tippen oeffnet das
 * Uebertragungen-Sheet; dessen Zustand lebt hier lokal.
 *
 * Der Manager mountet den Streifen im Layout (im Fluss, nicht fixed).
 */

import { useState } from "react";
import { CloudOff, Loader2 } from "lucide-react";
import { useStempel } from "@/lib/use-stempel";
import { UebertragungenSheet } from "./uebertragungen-sheet";

export function OfflineStreifen() {
  const { online, ausstehend, queue } = useStempel();
  const [offen, setOffen] = useState(false);

  if (online && ausstehend === 0) return null;

  const entscheidung = queue.some((o) => o.status === "konflikt" || o.status === "fehler" || o.status === "abgelehnt");
  const aktionen = ausstehend === 1 ? "1 Aktion wartet" : `${ausstehend} Aktionen warten`;

  let text: string;
  let ton: "amber" | "blau";
  if (!online) {
    text = ausstehend === 0 ? "Ohne Netz" : `Ohne Netz · ${aktionen}`;
    ton = "amber";
  } else if (entscheidung) {
    text = `${aktionen} · antippen`;
    ton = "amber";
  } else {
    text = "Wird übertragen…";
    ton = "blau";
  }

  const farben = ton === "amber"
    ? { bg: "rgba(245,158,11,0.14)", cls: "text-amber-800 dark:text-amber-200" }
    : { bg: "rgba(37,99,235,0.12)", cls: "text-blue-800 dark:text-blue-200" };

  return (
    <>
      <button
        type="button"
        onClick={() => setOffen(true)}
        className={`md:hidden flex h-9 w-full items-center justify-center gap-2 px-4 text-[13px] font-medium ${farben.cls}`}
        style={{ backgroundColor: farben.bg }}
      >
        {ton === "blau" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudOff className="h-4 w-4" />}
        <span className="truncate">{text}</span>
      </button>
      <UebertragungenSheet open={offen} onClose={() => setOffen(false)} />
    </>
  );
}
