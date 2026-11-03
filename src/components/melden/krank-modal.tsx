"use client";

/**
 * «Krank melden» — ohne Freigabe (POST /api/krank). Laptop + Handy (Modal,
 * am Handy Bottom-Sheet; Masse «Dicht»).
 *
 *   Ab                   Heute | Anderes Datum
 *   Voraussichtlich bis  Weiss nicht | Morgen | Datum
 *   Betroffene Einsaetze (GET /api/krank) — die Projektleitung bekommt eine
 *                        Nachricht «… ist krank gemeldet vom … bis …»
 *   Hinweise             sofort die vorgesetzte Person anrufen (Firmenregel);
 *                        Arztzeugnis ab dem 3. Tag (lib/krank.ts), spaeter
 *                        unter Meine Anfragen nachreichen
 *
 * Kein Freitext: Gesundheitsdaten (DSG Art. 5) gehoeren nicht ins System.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Phone, ThermometerSun } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "@/components/ui/modal";
import { TOAST } from "@/lib/messages";
import { anfragenGeaendert } from "@/lib/melden";
import { ARZTZEUGNIS_AB_TAG } from "@/lib/krank";
import { plusTage, todayLocalIso } from "@/lib/swiss-time";
import { formatDate, formatTime } from "@/lib/format";

interface Einsatz {
  id: string;
  start: string;
  ende: string | null;
  job_number: number;
  titel: string;
}

type AbWahl = "heute" | "datum";
type BisWahl = "offen" | "morgen" | "datum";

export function KrankModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <KrankFormular onClose={onClose} />;
}

function KrankFormular({ onClose }: { onClose: () => void }) {
  const heute = todayLocalIso();
  const morgen = plusTage(heute, 1);
  const [abWahl, setAbWahl] = useState<AbWahl>("heute");
  const [abDatum, setAbDatum] = useState(heute);
  const [bisWahl, setBisWahl] = useState<BisWahl>("offen");
  const [bisDatum, setBisDatum] = useState(morgen);
  const [einsaetze, setEinsaetze] = useState<Einsatz[] | null>(null);
  const [sendet, setSendet] = useState(false);

  const ab = abWahl === "heute" ? heute : abDatum;
  const bis: string | null = bisWahl === "offen" ? null : bisWahl === "morgen" ? morgen : bisDatum;
  const gueltig = !!ab && (bis === null || bis >= ab);

  // Betroffene Einsaetze nachladen, wenn sich der Zeitraum aendert.
  useEffect(() => {
    if (!gueltig) return;
    let weg = false;
    const q = new URLSearchParams({ ab });
    if (bis) q.set("bis", bis);
    fetch(`/api/krank?${q}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (weg) return;
        if (!j.success) {
          toast.error(j.error ?? "Einsätze konnten nicht geladen werden");
          setEinsaetze([]);
          return;
        }
        setEinsaetze(j.einsaetze as Einsatz[]);
      })
      .catch(() => { if (!weg) setEinsaetze([]); });
    return () => { weg = true; };
  }, [ab, bis, gueltig]);

  async function senden() {
    if (!gueltig || sendet) return;
    setSendet(true);
    try {
      const res = await fetch("/api/krank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ab, bis }),
      });
      const json = await res.json().catch(() => ({}));
      if (!json.success) {
        TOAST.errorOr(json.error, "Krankmeldung fehlgeschlagen");
        return;
      }
      toast.success("Krank gemeldet — gute Besserung!");
      anfragenGeaendert();
      onClose();
    } catch (e) {
      TOAST.error(e instanceof Error ? e.message : "Netzwerk-Fehler");
    } finally {
      setSendet(false);
    }
  }

  const label = "px-1 text-[12px] font-bold uppercase tracking-wider text-muted-foreground";
  const feld = "h-[36px] w-full rounded-xl border border-border bg-background px-3 text-base focus:outline-none focus:ring-2 focus:ring-ring/40";
  const wahl = (aktiv: boolean) => `${aktiv ? "kasten-active" : "kasten-toggle-off"} h-[34px] justify-center px-2 text-[13px]`;

  return (
    <Modal
      open
      onClose={() => !sendet && onClose()}
      title="Krank melden"
      icon={<ThermometerSun className="h-5 w-5 text-red-500" />}
      sheet
      size="md"
      closable={!sendet}
      bodyClassName="p-[10px] md:p-6 space-y-4"
    >
      <p className="px-1 text-[14px]">Gute Besserung. Wir informieren die Projektleitung deiner Einsätze.</p>

      <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-2.5 text-[13px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
        <Phone className="mt-0.5 h-4 w-4 shrink-0" />
        <span>Bitte ruf zusätzlich sofort deine vorgesetzte Person an.</span>
      </div>

      <div className="space-y-2">
        <p className={label}>Ab</p>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setAbWahl("heute")} aria-pressed={abWahl === "heute"} disabled={sendet} className={wahl(abWahl === "heute")}>Heute</button>
          <button type="button" onClick={() => setAbWahl("datum")} aria-pressed={abWahl === "datum"} disabled={sendet} className={wahl(abWahl === "datum")}>Anderes Datum</button>
        </div>
        {abWahl === "datum" && (
          <input type="date" value={abDatum} max={plusTage(heute, 7)} min={plusTage(heute, -14)} onChange={(e) => setAbDatum(e.target.value)} disabled={sendet} className={feld} aria-label="Krank ab" />
        )}
      </div>

      <div className="space-y-2">
        <p className={label}>Voraussichtlich bis</p>
        <div className="grid grid-cols-3 gap-2">
          <button type="button" onClick={() => setBisWahl("offen")} aria-pressed={bisWahl === "offen"} disabled={sendet} className={wahl(bisWahl === "offen")}>Weiss nicht</button>
          <button type="button" onClick={() => setBisWahl("morgen")} aria-pressed={bisWahl === "morgen"} disabled={sendet || ab > morgen} className={wahl(bisWahl === "morgen")}>Morgen</button>
          <button type="button" onClick={() => setBisWahl("datum")} aria-pressed={bisWahl === "datum"} disabled={sendet} className={wahl(bisWahl === "datum")}>Datum</button>
        </div>
        {bisWahl === "datum" && (
          <input type="date" value={bisDatum} min={ab} onChange={(e) => setBisDatum(e.target.value)} disabled={sendet} className={feld} aria-label="Voraussichtlich bis" />
        )}
        {!gueltig && <p className="px-1 text-[12px] text-red-600 dark:text-red-400">«Bis» liegt vor «Ab».</p>}
      </div>

      <div className="space-y-2">
        <p className={label}>Betroffene Einsätze</p>
        {einsaetze === null ? (
          <div className="flex h-[42px] items-center gap-2 px-1 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Wird geladen…
          </div>
        ) : einsaetze.length === 0 ? (
          <p className="px-1 text-[13px] text-muted-foreground">Keine Einsätze in diesem Zeitraum.</p>
        ) : (
          <>
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {einsaetze.map((e) => (
                <div key={e.id} className="flex min-h-[42px] items-center gap-2 border-t border-border px-3 text-[13px] first:border-t-0">
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatDate(e.start)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">INT-{e.job_number} · {e.titel}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatTime(e.start)}{e.ende ? `–${formatTime(e.ende)}` : ""}
                  </span>
                </div>
              ))}
            </div>
            <p className="px-1 text-[12px] text-muted-foreground">Die Projektleitung bekommt eine Nachricht.</p>
          </>
        )}
      </div>

      <div className="flex items-start gap-2 px-1 text-[12px] text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>Arztzeugnis ab dem {ARZTZEUGNIS_AB_TAG}. Tag – du kannst es später unter «Meine Anfragen» nachreichen.</span>
      </div>

      <div className="flex gap-2">
        <button type="button" onClick={onClose} disabled={sendet} className="kasten kasten-muted h-[40px] flex-1 justify-center">Abbrechen</button>
        <button type="button" onClick={() => void senden()} disabled={sendet || !gueltig} className="kasten kasten-red h-[40px] flex-1 justify-center">
          {sendet && <Loader2 className="h-4 w-4 animate-spin" />}
          {sendet ? "Wird gesendet…" : "Krankmeldung senden"}
        </button>
      </div>
    </Modal>
  );
}
