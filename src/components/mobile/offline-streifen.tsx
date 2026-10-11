"use client";

/**
 * Offline-Streifen (Handy, Tastflaeche min. 44 px) unter dem mobilen Kopf:
 *   ohne Netz   → amber «Ohne Netz · 2 Aktionen warten»
 *   mit Netz    → blau «Wird übertragen…» (Reihe laeuft) bzw. amber
 *                 «2 Aktionen warten · prüfen», wenn eine Entscheidung
 *                 (Konflikt/Fehler/abgelehnt) noetig ist; amber ohne Spinner
 *                 «Sitzung abgelaufen · neu anmelden» / «… · Netz instabil»,
 *                 wenn die Reihe haengt und gerade nichts gesendet wird
 * Zaehlt neben den Stempel-Aktionen auch wartende Rapport-Entwuerfe
 * (rapport-outbox): «2 Aktionen · 1 Rapport warten», «Rapport wird
 * übertragen…», «Rapport: Konflikt prüfen». Eine Zeile, kein zweiter Streifen.
 * Rendert nichts, wenn online und nichts wartet. Tippen oeffnet das
 * Uebertragungen-Sheet; dessen Zustand lebt hier lokal.
 *
 * Gemountet in src/app/(app)/layout.tsx (im Fluss, nicht fixed).
 */

import { useState } from "react";
import { CloudOff, Loader2 } from "lucide-react";
import { useStempel } from "@/lib/use-stempel";
import { usePermissions } from "@/lib/use-permissions";
import { SESSION_ABGELAUFEN } from "@/lib/offline/stempel-outbox";
import { UebertragungenSheet, useWartendeRapporte } from "./uebertragungen-sheet";

/** «2 Aktionen · 1 Rapport warten» / «1 Aktion wartet» / «1 Rapport wartet»; leer, wenn nichts wartet. */
function zaehlText(aktionen: number, rapporte: number): string {
  const teile: string[] = [];
  if (aktionen > 0) teile.push(aktionen === 1 ? "1 Aktion" : `${aktionen} Aktionen`);
  if (rapporte > 0) teile.push(rapporte === 1 ? "1 Rapport" : `${rapporte} Rapporte`);
  if (teile.length === 0) return "";
  return `${teile.join(" · ")} ${aktionen + rapporte === 1 ? "wartet" : "warten"}`;
}

export function OfflineStreifen() {
  const { online, ausstehend, queue } = useStempel();
  const { meId } = usePermissions();
  const rapporte = useWartendeRapporte(meId, true);
  const [offen, setOffen] = useState(false);

  if (online && ausstehend === 0 && rapporte.length === 0) return null;

  const entscheidung =
    queue.some((o) => o.status === "konflikt" || o.status === "fehler" || o.status === "abgelehnt") ||
    rapporte.some((r) => r.status === "konflikt" || r.status === "fehler");
  const sendet = queue.some((o) => o.status === "sendet") || rapporte.some((r) => r.status === "sendet");
  // «wartet» mit Fehlversuch = Reihe haengt (Backoff / Sitzung weg) — dann
  // kein Spinner, der etwas Laufendes vortaeuscht.
  const haengende = queue.filter((o) => o.status === "wartet" && o.attempts > 0 && !!o.last_error);
  const sitzungWeg = haengende.some((o) => o.last_error === SESSION_ABGELAUFEN);
  const zaehl = zaehlText(ausstehend, rapporte.length);
  const nurEinRapport = ausstehend === 0 && rapporte.length === 1;

  let text: string;
  let ton: "amber" | "blau";
  if (!online) {
    text = zaehl ? `Ohne Netz · ${zaehl}` : "Ohne Netz";
    ton = "amber";
  } else if (entscheidung) {
    text = nurEinRapport
      ? `Rapport: ${rapporte[0].status === "konflikt" ? "Konflikt" : "Fehler"} prüfen`
      : `${zaehl} · prüfen`;
    ton = "amber";
  } else if (sitzungWeg) {
    text = "Sitzung abgelaufen · neu anmelden";
    ton = "amber";
  } else if (haengende.length > 0 && !sendet) {
    text = `${zaehl} · Netz instabil`;
    ton = "amber";
  } else {
    text = ausstehend === 0
      ? (rapporte.length === 1 ? "Rapport wird übertragen…" : "Rapporte werden übertragen…")
      : "Wird übertragen…";
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
        className={`md:hidden flex min-h-[44px] w-full items-center justify-center gap-2 px-4 text-[13px] font-medium ${farben.cls}`}
        style={{ backgroundColor: farben.bg }}
      >
        {ton === "blau" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudOff className="h-4 w-4" />}
        <span className="truncate">{text}</span>
      </button>
      <UebertragungenSheet open={offen} onClose={() => setOffen(false)} />
    </>
  );
}
