"use client";

/**
 * MeldenHost — haengt EINMAL im (app)-Layout und oeffnet auf oeffneMelden()
 * (lib/melden.ts) direkt das passende kurze Formular:
 *   beleg       → NewTicketModal, fester Typ Beleg
 *   stempel     → NewTicketModal, fester Typ Stempel-Aenderung (optional
 *                 vorbelegt aus einer Stempelzeiten-Zeile)
 *   anderes     → NewTicketModal mit Chips IT | Material
 *   krank       → KrankModal (ohne Freigabe)
 *   abwesenheit → AbwesenheitModal
 *
 * Die Formulare laden erst beim ersten Oeffnen (next/dynamic) — sie ziehen
 * so nicht in den Layout-Chunk jeder Seite. Der Lade-Fallback zeigt sofort
 * einen Spinner (CLAUDE.md §7, kein toter Klick).
 */

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import { MELDEN_EVENT, type MeldenDetail } from "@/lib/melden";

function LadeFallback() {
  return (
    <div className="fixed inset-0 z-[1100] bg-black/60 backdrop-blur flex items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-white" />
    </div>
  );
}

const NewTicketModal = dynamic(
  () => import("@/components/tickets/new-ticket-modal").then((m) => m.NewTicketModal),
  { ssr: false, loading: LadeFallback },
);
const KrankModal = dynamic(
  () => import("@/components/melden/krank-modal").then((m) => m.KrankModal),
  { ssr: false, loading: LadeFallback },
);
const AbwesenheitModal = dynamic(
  () => import("@/components/melden/abwesenheit-modal").then((m) => m.AbwesenheitModal),
  { ssr: false, loading: LadeFallback },
);

export function MeldenHost() {
  const [offen, setOffen] = useState<MeldenDetail | null>(null);

  useEffect(() => {
    const onMelden = (e: Event) => {
      const detail = (e as CustomEvent<MeldenDetail>).detail;
      if (detail?.art) setOffen(detail);
    };
    window.addEventListener(MELDEN_EVENT, onMelden);
    return () => window.removeEventListener(MELDEN_EVENT, onMelden);
  }, []);

  if (!offen) return null;
  const schliessen = () => setOffen(null);

  if (offen.art === "krank") {
    return <KrankModal open onClose={schliessen} />;
  }
  if (offen.art === "abwesenheit") {
    return <AbwesenheitModal open onClose={schliessen} />;
  }
  if (offen.art === "beleg" || offen.art === "stempel" || offen.art === "anderes") {
    return (
      <NewTicketModal
        // key: ein neuer Aufruf (andere Art/Zeile) setzt das Formular frisch auf.
        key={`${offen.art}:${offen.stempel?.timeEntryId ?? ""}`}
        open
        sheet
        onClose={schliessen}
        onCreated={schliessen}
        initialType={offen.art === "beleg" ? "beleg" : offen.art === "stempel" ? "stempel_aenderung" : undefined}
        typen={offen.art === "anderes" ? ["it", "material"] : undefined}
        initialData={offen.stempel}
      />
    );
  }
  return null;
}
