"use client";

/**
 * «Abwesenheit melden» — EIN Formular fuer Laptop und Handy (Modal, am Handy
 * Bottom-Sheet). Genutzt von Melden (Mein Konto, Sidebar, Palette), der Seite
 * Abwesenheit (Desktop) und ferien-mobil. POST /api/time-off → Status
 * «beantragt», die Freigabe passiert unter Freigaben (/antraege).
 *
 * Optik wie NewTicketModal (Beleg, Stempel korrigieren); Eingabefelder am
 * Handy 16 px Schrift (Input-Komponente, docs/mobile/HANDY-WISSEN.md).
 */

import { useState } from "react";
import { Loader2, Palmtree } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { TOAST } from "@/lib/messages";
import { anfragenGeaendert } from "@/lib/melden";
import { todayLocalIso } from "@/lib/swiss-time";
import type { TimeOffType } from "@/types";

/** Arten im allgemeinen Abwesenheits-Formular. «Krank» hat ein eigenes
 *  Formular ohne Freigabe (krank-modal.tsx, /api/krank). */
export const ABWESENHEIT_ARTEN: ReadonlyArray<{ typ: TimeOffType; label: string }> = [
  { typ: "ferien", label: "Ferien" },
  { typ: "frei", label: "Frei" },
  { typ: "kompensation", label: "Kompensation" },
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

  // Optik wie das Geschwister-Formular NewTicketModal (Beleg, Stempel
  // korrigieren): kleine Feld-Labels, Input-Komponente, Kasten-Toggles,
  // Fusszeile Abbrechen | Senden. Am Handy Bottom-Sheet (Modal `sheet`).
  const label = "ml-1 text-[10px] text-muted-foreground/70";

  return (
    <Modal
      open
      onClose={() => !sendet && onClose()}
      title="Abwesenheit melden"
      icon={<Palmtree className="h-5 w-5 text-blue-500" />}
      sheet
      size="md"
      closable={!sendet}
    >
      <div className="space-y-1">
        <p className={label}>Art</p>
        <div className="grid grid-cols-2 gap-2">
          {ABWESENHEIT_ARTEN.map((a) => (
            <button
              key={a.typ}
              type="button"
              onClick={() => setTyp(a.typ)}
              aria-pressed={typ === a.typ}
              disabled={sendet}
              className={`${typ === a.typ ? "kasten-active" : "kasten-toggle-off"} justify-center`}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className={`block ${label}`}>Von</span>
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} disabled={sendet} />
          </label>
          <label className="space-y-1">
            <span className={`block ${label}`}>Bis</span>
            <Input type="date" value={ende} min={start || undefined} onChange={(e) => setEnde(e.target.value)} disabled={sendet} />
          </label>
        </div>
        <p className={`ml-1 text-xs ${gueltig ? "text-muted-foreground" : "text-red-600 dark:text-red-400"}`}>
          {gueltig ? (tage(start, ende) === 1 ? "1 Tag" : `${tage(start, ende)} Tage`) : "Start muss vor dem Ende liegen"}
        </p>
      </div>

      <div className="space-y-1">
        <p className={label}>Notiz (optional)</p>
        <textarea
          value={notiz}
          onChange={(e) => setNotiz(e.target.value.slice(0, 500))}
          placeholder="z. B. Reise, Hochzeit"
          rows={2}
          maxLength={500}
          disabled={sendet}
          className="w-full resize-none rounded-xl border border-border bg-card px-3 py-2 text-base placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 md:text-sm"
        />
      </div>

      <div className="flex gap-2 pt-2">
        <button type="button" onClick={onClose} disabled={sendet} className="kasten kasten-muted flex-1">
          Abbrechen
        </button>
        <button type="button" onClick={() => void senden()} disabled={sendet || !gueltig} className="kasten kasten-red flex-1">
          {sendet && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {sendet ? "Wird gesendet…" : "Abwesenheit senden"}
        </button>
      </div>
    </Modal>
  );
}
