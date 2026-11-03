"use client";

/**
 * «Abwesenheit melden» — EIN Formular fuer Laptop und Handy (Modal, am Handy
 * Bottom-Sheet). Genutzt von Melden (Mein Konto, Sidebar, Palette), der Seite
 * Abwesenheit (Desktop) und ferien-mobil. POST /api/time-off → Status
 * «beantragt», die Freigabe passiert unter Freigaben (/antraege).
 *
 * Masse «Dicht» (docs/mobile/HANDY-WISSEN.md): Knoepfe 34 px, gross 40 px,
 * Eingabefelder 16 px Schrift.
 */

import { useState } from "react";
import { Loader2, Palmtree } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "@/components/ui/modal";
import { TOAST } from "@/lib/messages";
import { anfragenGeaendert } from "@/lib/melden";
import { todayLocalIso } from "@/lib/swiss-time";
import type { TimeOffType } from "@/types";

/** Arten im allgemeinen Abwesenheits-Formular. */
export const ABWESENHEIT_ARTEN: ReadonlyArray<{ typ: TimeOffType; label: string }> = [
  { typ: "ferien", label: "Ferien" },
  { typ: "krank", label: "Krank" },
  { typ: "kompensation", label: "Kompensation" },
  { typ: "frei", label: "Frei" },
  { typ: "militaer", label: "Militär" },
];

function tage(start: string, ende: string): number {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = ende.split("-").map(Number);
  return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86400000) + 1;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Nach erfolgreichem Senden (Liste neu laden). */
  onGesendet?: () => void;
}

/** Nur offen gemountet: jedes Oeffnen startet frisch (Ferien, heute–heute). */
export function AbwesenheitModal(props: Props) {
  if (!props.open) return null;
  return <AbwesenheitFormular {...props} />;
}

function AbwesenheitFormular({ onClose, onGesendet }: Props) {
  const [typ, setTyp] = useState<TimeOffType>("ferien");
  const [start, setStart] = useState(() => todayLocalIso());
  const [ende, setEnde] = useState(() => todayLocalIso());
  const [notiz, setNotiz] = useState("");
  const [sendet, setSendet] = useState(false);

  const gueltig = !!start && !!ende && start <= ende;

  async function senden() {
    if (!gueltig || sendet) return;
    setSendet(true);
    try {
      const res = await fetch("/api/time-off", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: start, end_date: ende, type: typ, note: notiz.trim() || null }),
      });
      const json = await res.json().catch(() => ({}));
      if (!json.success) {
        TOAST.errorOr(json.error, "Senden fehlgeschlagen");
        return;
      }
      toast.success("Abwesenheit gemeldet — wartet auf Freigabe");
      // Freigaben-Punkt (use-nav-counts) und Anfragen-Listen sofort nachziehen.
      window.dispatchEvent(new Event("time_off:invalidate"));
      anfragenGeaendert();
      onGesendet?.();
      onClose();
    } catch (e) {
      TOAST.error(e instanceof Error ? e.message : "Netzwerk-Fehler");
    } finally {
      setSendet(false);
    }
  }

  const label = "px-1 text-[12px] font-bold uppercase tracking-wider text-muted-foreground";
  const feld = "h-[36px] w-full rounded-xl border border-border bg-background px-3 text-base focus:outline-none focus:ring-2 focus:ring-ring/40";

  return (
    <Modal
      open
      onClose={() => !sendet && onClose()}
      title="Abwesenheit melden"
      icon={<Palmtree className="h-5 w-5 text-blue-500" />}
      sheet
      size="md"
      closable={!sendet}
      bodyClassName="p-[10px] md:p-6 space-y-4"
    >
      <div className="space-y-2">
        <p className={label}>Art</p>
        <div className="grid grid-cols-3 gap-2">
          {ABWESENHEIT_ARTEN.map((a) => (
            <button
              key={a.typ}
              type="button"
              onClick={() => setTyp(a.typ)}
              aria-pressed={typ === a.typ}
              disabled={sendet}
              className={`${typ === a.typ ? "kasten-active" : "kasten-toggle-off"} h-[34px] justify-center px-2 text-[12px]`}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className={label}>Von</span>
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} disabled={sendet} className={feld} />
        </label>
        <label className="space-y-1">
          <span className={label}>Bis</span>
          <input type="date" value={ende} min={start || undefined} onChange={(e) => setEnde(e.target.value)} disabled={sendet} className={feld} />
        </label>
      </div>
      <p className={`px-1 text-[12px] ${gueltig ? "text-muted-foreground" : "text-red-600 dark:text-red-400"}`}>
        {gueltig ? (tage(start, ende) === 1 ? "1 Tag" : `${tage(start, ende)} Tage`) : "Start muss vor dem Ende liegen"}
      </p>

      <textarea
        value={notiz}
        onChange={(e) => setNotiz(e.target.value.slice(0, 500))}
        placeholder="Notiz (optional), z. B. Reise, Hochzeit"
        rows={2}
        maxLength={500}
        disabled={sendet}
        className="w-full resize-none rounded-xl border border-border bg-background px-3 py-[7px] text-base placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
      />

      <div className="flex gap-2">
        <button type="button" onClick={onClose} disabled={sendet} className="kasten kasten-muted h-[40px] flex-1 justify-center">
          Abbrechen
        </button>
        <button type="button" onClick={() => void senden()} disabled={sendet || !gueltig} className="kasten kasten-red h-[40px] flex-1 justify-center">
          {sendet && <Loader2 className="h-4 w-4 animate-spin" />}
          {sendet ? "Wird gesendet…" : "Abwesenheit senden"}
        </button>
      </div>
    </Modal>
  );
}
