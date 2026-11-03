"use client";

/**
 * «Krank melden» — ohne Freigabe (POST /api/krank). Laptop + Handy (Modal,
 * am Handy Bottom-Sheet). Optik wie NewTicketModal (Beleg, Stempel).
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
import { Input } from "@/components/ui/input";
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

  // Optik wie das Geschwister-Formular NewTicketModal (Beleg, Stempel
  // korrigieren): kleine Feld-Labels, Input-Komponente, Kasten-Toggles,
  // Fusszeile Abbrechen | Senden. Am Handy Bottom-Sheet (Modal `sheet`).
  const label = "ml-1 text-[10px] text-muted-foreground/70";
  const wahl = (aktiv: boolean) => `${aktiv ? "kasten-active" : "kasten-toggle-off"} flex-1 justify-center`;

  return (
    <Modal
      open
      onClose={() => !sendet && onClose()}
      title="Krank melden"
      icon={<ThermometerSun className="h-5 w-5 text-red-500" />}
      sheet
      size="md"
      closable={!sendet}
    >
      <p className="text-sm text-muted-foreground">Gute Besserung. Wir informieren die Projektleitung deiner Einsätze.</p>

      <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">
        <Phone className="mt-0.5 h-4 w-4 shrink-0" />
        <span>Bitte ruf zusätzlich sofort deine vorgesetzte Person an.</span>
      </div>

      <div className="space-y-1">
        <p className={label}>Ab</p>
        <div className="flex gap-2">
          <button type="button" onClick={() => setAbWahl("heute")} aria-pressed={abWahl === "heute"} disabled={sendet} className={wahl(abWahl === "heute")}>Heute</button>
          <button type="button" onClick={() => setAbWahl("datum")} aria-pressed={abWahl === "datum"} disabled={sendet} className={wahl(abWahl === "datum")}>Anderes Datum</button>
        </div>
        {abWahl === "datum" && (
          <Input type="date" value={abDatum} max={plusTage(heute, 7)} min={plusTage(heute, -14)} onChange={(e) => setAbDatum(e.target.value)} disabled={sendet} aria-label="Krank ab" className="mt-1" />
        )}
      </div>

      <div className="space-y-1">
        <p className={label}>Voraussichtlich bis</p>
        <div className="flex gap-2">
          <button type="button" onClick={() => setBisWahl("offen")} aria-pressed={bisWahl === "offen"} disabled={sendet} className={wahl(bisWahl === "offen")}>Weiss nicht</button>
          <button type="button" onClick={() => setBisWahl("morgen")} aria-pressed={bisWahl === "morgen"} disabled={sendet || ab > morgen} className={wahl(bisWahl === "morgen")}>Morgen</button>
          <button type="button" onClick={() => setBisWahl("datum")} aria-pressed={bisWahl === "datum"} disabled={sendet} className={wahl(bisWahl === "datum")}>Datum</button>
        </div>
        {bisWahl === "datum" && (
          <Input type="date" value={bisDatum} min={ab} onChange={(e) => setBisDatum(e.target.value)} disabled={sendet} aria-label="Voraussichtlich bis" className="mt-1" />
        )}
        {!gueltig && <p className="ml-1 text-xs text-red-600 dark:text-red-400">«Bis» liegt vor «Ab».</p>}
      </div>

      <div className="space-y-1">
        <p className={label}>Betroffene Einsätze</p>
        {einsaetze === null ? (
          <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Wird geladen…
          </div>
        ) : einsaetze.length === 0 ? (
          <p className="rounded-lg bg-muted/40 px-3 py-2 text-sm text-muted-foreground">Keine Einsätze in diesem Zeitraum.</p>
        ) : (
          <>
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
              {einsaetze.map((e) => (
                <div key={e.id} className="flex min-h-[38px] items-center gap-2 px-3 py-1.5 text-sm">
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatDate(e.start)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">INT-{e.job_number} · {e.titel}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {formatTime(e.start)}{e.ende ? `–${formatTime(e.ende)}` : ""}
                  </span>
                </div>
              ))}
            </div>
            <p className="ml-1 text-[10px] text-muted-foreground/70">Die Projektleitung bekommt eine Nachricht.</p>
          </>
        )}
      </div>

      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>Arztzeugnis ab dem {ARZTZEUGNIS_AB_TAG}. Tag – du kannst es später unter «Meine Anfragen» nachreichen.</span>
      </div>

      <div className="flex gap-2 pt-2">
        <button type="button" onClick={onClose} disabled={sendet} className="kasten kasten-muted flex-1">Abbrechen</button>
        <button type="button" onClick={() => void senden()} disabled={sendet || !gueltig} className="kasten kasten-red flex-1">
          {sendet && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {sendet ? "Wird gesendet…" : "Krankmeldung senden"}
        </button>
      </div>
    </Modal>
  );
}
