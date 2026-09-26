"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { DATENSCHUTZ_VERSION } from "@/lib/datenschutz";
import { Shield, CheckCircle2, LogOut } from "lucide-react";

interface Props {
  onAccepted: () => void;
  onCancel: () => void;
  /** Portal-spezifische Texte — Default: Partnerportal (bestehende
   *  Aufrufer bleiben unveraendert). */
  portalName?: string;
  speicherPunkte?: string[];
}

const PARTNER_PUNKTE = [
  "Deinen Namen + E-Mail (Login)",
  "Deine zugewiesene Location",
  "Anfragen, Termine, Notizen, hochgeladene Dokumente",
  "Anmelde-Logs (Sicherheit)",
];

/**
 * Pflicht-Akzeptanz der Datenschutzerklaerung. Wird im Portal-Layout
 * (Partner/Lieferant) gezeigt wenn datenschutz_akzeptiert_at NULL ist
 * oder die Version nicht mehr aktuell ist.
 *
 * Cancel = signOut (User kann nicht ins Portal ohne Akzeptanz).
 */
export function DatenschutzAcceptModal({
  onAccepted, onCancel, portalName = "Partnerportal", speicherPunkte = PARTNER_PUNKTE,
}: Props) {
  const supabase = createClient();
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  async function handleAccept() {
    if (!confirmed) {
      toast.error("Bitte die Checkbox bestätigen");
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.rpc("accept_datenschutz", { p_version: DATENSCHUTZ_VERSION });
    setSubmitting(false);
    if (error) {
      TOAST.supabaseError(error, "Akzeptanz konnte nicht gespeichert werden");
      return;
    }
    toast.success("Danke — Akzeptanz gespeichert");
    onAccepted();
  }

  return (
    <Modal
      open={true}
      onClose={() => {}}
      title="Datenschutzerklärung"
      icon={<Shield className="h-5 w-5 text-blue-500" />}
      size="md"
      closable={false}
    >
      <div className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          Bevor du das {portalName} nutzen kannst, müssen wir dir kurz
          zeigen welche Daten wir verarbeiten und warum.
        </p>
        <div className="rounded-lg border bg-foreground/[0.02] dark:bg-foreground/[0.04] p-3 space-y-1 text-xs">
          <p className="font-medium text-foreground">Was wir speichern:</p>
          <ul className="list-disc pl-4 space-y-0.5">
            {speicherPunkte.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </div>
        <p>
          Die vollständige Erklärung mit allen Details (Sub-Auftrags-
          bearbeiter, Aufbewahrungsfristen, deine Rechte) findest du hier:
        </p>
        <a
          href="/datenschutz"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-blue-600 hover:underline text-sm font-medium"
        >
          → Datenschutzerklärung öffnen
        </a>
        <label className="flex items-start gap-2 cursor-pointer text-sm pt-2 border-t">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-input"
          />
          <span>
            Ich habe die Datenschutzerklärung gelesen und akzeptiere die
            beschriebene Verarbeitung meiner Daten.
          </span>
        </label>
        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="kasten kasten-muted flex-1"
          >
            <LogOut className="h-3.5 w-3.5" />
            Ablehnen + Abmelden
          </button>
          <button
            type="button"
            onClick={handleAccept}
            disabled={submitting || !confirmed}
            className="kasten kasten-blue flex-[2]"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            {submitting ? "Speichert…" : "Akzeptieren und fortfahren"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
