"use client";

/**
 * Ladefehler am Handy — EIN Block fuer Einsaetze, Todos, Tickets und den
 * Heute-Screen statt dreimal derselbe Inline-Bau: AlertTriangle, Titel
 * «… konnten nicht geladen werden», Fehlertext, Knopf «Erneut versuchen»
 * (Spinner solange laeuft). Offline steht statt des Fehlertexts «Keine
 * Verbindung — …» (useOnline); das Nachladen beim online-Event macht die
 * jeweilige Seite selbst.
 *
 *   Standard   EmptyState — ganze Liste ohne Daten.
 *   kompakt    Icon + Text + Knopf ohne Aussenabstand — fuer Karten im
 *              Heute-Screen (Fit-to-Viewport); das Padding setzt die Karte.
 */

import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { useOnline } from "@/lib/offline/sync-trigger";

const OFFLINE_TEXT = "Keine Verbindung — sobald du wieder online bist, wird neu geladen.";

export function LadeFehler({
  titel,
  fehler,
  onRetry,
  laedt,
  kompakt = false,
}: {
  titel: string;
  /** Fehlertext des letzten Ladens — online als Beschreibung gezeigt. */
  fehler: string | null;
  onRetry: () => void;
  /** Neuladen laeuft → Spinner im Knopf, Knopf gesperrt. */
  laedt: boolean;
  kompakt?: boolean;
}) {
  const online = useOnline();
  const beschreibung = online ? fehler ?? undefined : OFFLINE_TEXT;
  const knopf = (
    <button
      type="button"
      disabled={laedt}
      onClick={onRetry}
      className="kasten kasten-muted h-11 px-5 text-[15px]"
    >
      {laedt ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
      {laedt ? "Wird geladen …" : "Erneut versuchen"}
    </button>
  );

  if (!kompakt) {
    return <EmptyState icon={AlertTriangle} title={titel} description={beschreibung} action={knopf} />;
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-semibold leading-snug">{titel}</p>
          {beschreibung && <p className="mt-0.5 text-[13px] text-muted-foreground">{beschreibung}</p>}
        </div>
      </div>
      {/* Block-Huelle: der inline-flex-Knopf soll in der Spalte nicht auf volle Breite gestreckt werden. */}
      <div>{knopf}</div>
    </div>
  );
}
