"use client";

/**
 * Stempel-Platz der Bottom-Nav (nur Handy).
 *   ausgestempelt → das bestehende Einstempeln-Modal als Bottom-Sheet
 *                   (gleiche Wege wie am Desktop: Auftrag / Projekt / Andere).
 *   eingestempelt → Sheet mit Dauer, Kontext, Modus-Wechsel, Ausstempeln.
 *
 * Teal fuer Ein- UND Ausstempeln (Ausstempeln ist nicht destruktiv).
 * Nutzt den StempelProvider des Layouts — keine eigenen Lade-Queries ausser
 * dem Auftrags-Label.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Clock, Loader2, Square } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "@/components/ui/modal";
import { StempelModal } from "@/components/stempel/stempel-modal";
import { RateTierLiveSwitcher } from "@/components/stempel/rate-tier-live-switcher";
import { UebertragungenSheet } from "@/components/mobile/uebertragungen-sheet";
import { useStempel, formatStempelDuration, stempelErfolgText } from "@/lib/use-stempel";
import { createClient } from "@/lib/supabase/client";
import { formatJobNumber } from "@/lib/nummern-format";
import { formatTime } from "@/lib/format";

/** Window-Event, mit dem Seiten (z. B. die Einsatz-Karte auf dem Handy-
 *  Dashboard) das Stempel-Sheet des Layouts oeffnen — gleiche Mechanik wie
 *  CMDK_OPEN_EVENT fuer die Suche. */
export const STEMPEL_OPEN_EVENT = "stempel:open";
export function oeffneStempelSheet() {
  window.dispatchEvent(new Event(STEMPEL_OPEN_EVENT));
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function StempelNavSheet({ open, onClose }: Props) {
  const { active, clockOut, ausstehend, online } = useStempel();
  const supabase = createClient();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [uebertragungenOffen, setUebertragungenOffen] = useState(false);
  // Label gehoert zu einer Job-ID — so zeigt ein Wechsel des Auftrags nie
  // kurz das alte Label (und der Effekt braucht kein synchrones Reset).
  const [jobLabel, setJobLabel] = useState<{ jobId: string; label: string } | null>(null);

  // Sekunden-Tick nur solange das Sheet offen und eine Stempelung aktiv ist.
  // Erster Tick als Callback (nicht synchron im Effekt).
  useEffect(() => {
    if (!open || !active) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [open, active]);

  const jobId = active?.job_id ?? null;
  useEffect(() => {
    if (!open || !jobId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("jobs")
        .select("job_number, title")
        .eq("id", jobId)
        .maybeSingle();
      if (!cancelled && data) {
        setJobLabel({ jobId, label: `${formatJobNumber(data.job_number)} · ${data.title}` });
      }
    })();
    return () => { cancelled = true; };
  }, [open, jobId, supabase]);

  if (!active) return <StempelModal open={open} onClose={onClose} sheet />;

  async function stop() {
    setBusy(true);
    const res = await clockOut();
    setBusy(false);
    if (res.success) {
      toast.success(stempelErfolgText(res, "Ausgestempelt", online));
      onClose();
    } else {
      toast.error(res.error || "Ausstempeln fehlgeschlagen");
    }
  }

  const seit = formatTime(active.clock_in);
  const kontext = active.job_id
    ? (jobLabel?.jobId === active.job_id ? jobLabel.label : "Auftrag laden…")
    : active.project_id
      ? (active.description || "Projekt")
      : (active.description || "Andere Arbeit");

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      sheet
      size="md"
      title="Eingestempelt"
      icon={<Clock className="h-5 w-5 text-teal-500" />}
      closable={!busy}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-3xl font-semibold tabular-nums text-teal-700 dark:text-teal-300">
          {formatStempelDuration(active.clock_in, now)}
        </span>
        <span className="text-sm text-muted-foreground">seit {seit}</span>
      </div>
      <p className="text-base leading-snug">{kontext}</p>
      <RateTierLiveSwitcher jobId={active.job_id} />
      <button
        type="button"
        onClick={stop}
        disabled={busy}
        className="flex h-14 w-full items-center justify-center gap-2 rounded-xl text-[17px] font-bold text-teal-700 disabled:opacity-60 dark:text-teal-300"
        style={{
          border: "2px solid var(--stempel-color, #14b8a6)",
          backgroundColor: "rgba(20,184,166,0.16)",
        }}
      >
        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Square className="h-4 w-4" fill="currentColor" />}
        {busy ? "Wird ausgestempelt…" : "Ausstempeln"}
      </button>
      {(ausstehend > 0 || !online) && (
        <button
          type="button"
          onClick={() => setUebertragungenOffen(true)}
          className="flex min-h-[44px] w-full items-center justify-between rounded-xl bg-amber-50 px-3 text-left text-[14px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-200"
        >
          <span>
            {!online ? "Ohne Netz" : "Übertragung"}
            {ausstehend > 0 ? ` · ${ausstehend === 1 ? "1 Aktion wartet" : `${ausstehend} Aktionen warten`}` : ""}
          </span>
          <span className="text-[13px]">ansehen</span>
        </button>
      )}
      <Link
        href="/stempelzeiten"
        onClick={onClose}
        className="flex min-h-[44px] w-full items-center justify-center text-sm font-medium text-muted-foreground"
      >
        Meine Stempelzeiten
      </Link>
      <UebertragungenSheet open={uebertragungenOffen} onClose={() => setUebertragungenOffen(false)} />
    </Modal>
  );
}
