"use client";

// Quick-Stempel-Button fuer die Auftrag-Detail-Page. Icon-only, rechts-
// buendig im Action-Row (ml-auto). Drei Zustaende:
//   1. nicht eingestempelt → gruener Kreis mit Clock-Icon → clockIn(jobId)
//   2. auf DIESEN Auftrag eingestempelt → roter Kreis mit Stop-Icon → clockOut
//   3. auf einen ANDEREN Auftrag eingestempelt → grauer Kreis, disabled,
//      Tooltip "Du bist auf INT-XX eingestempelt"

import { useState } from "react";
import { Clock, Square } from "lucide-react";
import { useStempel } from "@/lib/use-stempel";
import { usePermissions } from "@/lib/use-permissions";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";

interface Props {
  jobId: string;
  jobNumber: number | null;
}

export function JobStempelButton({ jobId, jobNumber }: Props) {
  const { active, clockIn, clockOut, loading } = useStempel();
  const { role } = usePermissions();
  const isAdmin = role === "admin";
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  if (loading) return null;

  // Admins stempeln nicht auf Auftraege — Auto-Stempel aus Rapport-
  // Abschluss erledigt das. Button wird komplett ausgeblendet.
  if (isAdmin && !active) return null;
  // Falls Admin doch noch eingestempelt ist (historisch): Ausstempeln
  // muss er trotzdem koennen.

  const onSameJob = active?.job_id === jobId;
  const onOtherJob = active && active.job_id !== jobId;

  async function handleClick() {
    if (onSameJob) {
      const r = await clockOut();
      if (r.success) toast.success("Ausgestempelt");
      else TOAST.stempelError(r.error);
    } else {
      if (isAdmin) {
        toast.error("Admins stempeln nicht auf Auftraege — die Stunden werden automatisch aus dem Rapport-Abschluss gestempelt.", { duration: 6000 });
        return;
      }
      const r = await clockIn({ jobId });
      if (r.success) toast.success(`Eingestempelt auf INT-${jobNumber}`);
      else TOAST.stempelError(r.error);
    }
  }

  // Disabled "schon woanders eingestempelt" — grau, klickt nichts.
  if (onOtherJob) {
    return (
      <button
        type="button"
        disabled
        data-tooltip="Du bist gerade auf einen anderen Auftrag eingestempelt"
        aria-label="Bereits auf anderen Auftrag eingestempelt"
        className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-muted text-muted-foreground/60 cursor-not-allowed"
      >
        <Clock className="h-4 w-4" />
      </button>
    );
  }

  // Style 1:1 wie kasten-red: 2px voller Akzent-Border, 12/22% Background-
  // Tint, Text in Tailwind-Akzent-Klasse. Aktiv (auf diesem Auftrag) = rot,
  // sonst teal — bewusst NICHT gruen, damit Stempel-Aktion sich optisch von
  // "Erledigt"-Status unterscheidet (sonst signal-doppelt belegt).
  const tones = onSameJob
    ? {
        bg: hovered ? "rgba(220,38,38,0.22)" : "rgba(220,38,38,0.12)",
        border: "2px solid var(--status-red, #dc2626)",
        text: "text-red-700 dark:text-red-300",
      }
    : {
        bg: hovered ? "rgba(20,184,166,0.22)" : "rgba(20,184,166,0.12)",
        border: "2px solid var(--stempel-color, #14b8a6)",
        text: "text-teal-700 dark:text-teal-300",
      };

  return (
    <button
      type="button"
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setPressed(false); }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      data-tooltip={onSameJob ? "Ausstempeln" : "Auf diesen Auftrag stempeln"}
      aria-label={onSameJob ? "Ausstempeln" : "Auf diesen Auftrag stempeln"}
      className={`inline-flex items-center justify-center w-9 h-9 rounded-full shrink-0 ${tones.text}`}
      style={{
        backgroundColor: tones.bg,
        border: tones.border,
        transform: pressed ? "scale(0.95)" : hovered ? "scale(1.05)" : "scale(1)",
        transition: "transform 180ms cubic-bezier(0.4,0,0.2,1), background-color 180ms",
      }}
    >
      {onSameJob ? <Square className="h-4 w-4" fill="currentColor" /> : <Clock className="h-4 w-4" />}
    </button>
  );
}
