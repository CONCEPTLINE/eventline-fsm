"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { createClient } from "@/lib/supabase/client";
import { readImpersonationCookie } from "@/lib/impersonation";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { DATENSCHUTZ_VERSION } from "@/lib/datenschutz";
import { Shield, CheckCircle2, LogOut, Eye, X, Loader2 } from "lucide-react";

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

/** "pruefen" solange unklar ist, ob ein Admin das Portal per «Ansicht als»
 *  sieht; "selbst" = die Person selbst; "ansicht" = Admin im View-As. */
type Modus = "pruefen" | "selbst" | "ansicht";

/**
 * Pflicht-Akzeptanz der Datenschutzerklaerung. Wird im Portal-Layout
 * (Partner/Lieferant) gezeigt wenn datenschutz_akzeptiert_at NULL ist
 * oder die Version nicht mehr aktuell ist.
 *
 * Cancel = signOut (User kann nicht ins Portal ohne Akzeptanz).
 *
 * «Ansicht als»: Die Akzeptanz ist eine persoenliche Erklaerung der Person
 * selbst. accept_datenschutz wuerde aber fuer den eingeloggten Admin
 * speichern (RPCs laufen am Nur-Lesen-Schutz vorbei) und «Ablehnen» meldete
 * den Admin ab. Darum sind in dieser Ansicht beide Knoepfe gesperrt; das
 * Fenster laesst sich nur schliessen (nur fuer diese Ansicht, nichts wird
 * gespeichert). Erkannt wie auf dem Server (resolveImpersonation): Cookie
 * gesetzt, zeigt auf jemand anderen UND der echte User ist Admin mit
 * Entwickler-Modus — ein liegengebliebenes Cookie bei einem Portal-User
 * sperrt also nichts.
 */
export function DatenschutzAcceptModal({
  onAccepted, onCancel, portalName = "Partnerportal", speicherPunkte = PARTNER_PUNKTE,
}: Props) {
  const supabase = createClient();
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [modus, setModus] = useState<Modus>("pruefen");
  const [geschlossen, setGeschlossen] = useState(false);

  useEffect(() => {
    let aktiv = true;
    (async () => {
      const ziel = readImpersonationCookie();
      const { data: { user } } = await supabase.auth.getUser();
      if (!ziel || !user || ziel === user.id) {
        if (aktiv) setModus("selbst");
        return;
      }
      const { data: echt } = await supabase
        .from("profiles")
        .select("role, developer_mode_enabled")
        .eq("id", user.id)
        .maybeSingle();
      if (aktiv) setModus(echt?.role === "admin" && echt.developer_mode_enabled === true ? "ansicht" : "selbst");
    })();
    return () => { aktiv = false; };
  }, [supabase]);

  async function handleAccept() {
    if (modus !== "selbst") return;
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

  const ansicht = modus === "ansicht";
  const gesperrt = modus !== "selbst";

  return (
    <Modal
      open={!geschlossen}
      onClose={() => { if (ansicht) setGeschlossen(true); }}
      title="Datenschutzerklärung"
      icon={<Shield className="h-5 w-5 text-blue-500" />}
      size="md"
      closable={ansicht}
    >
      <div className="space-y-4 text-sm">
        {ansicht && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-200">
            <Eye className="h-4 w-4 shrink-0 mt-0.5" />
            <p>
              <strong className="font-semibold">Ansicht als:</strong> So sieht die Person das Fenster beim Öffnen.
              Akzeptieren oder ablehnen kann nur sie selbst — hier wird nichts gespeichert.
            </p>
          </div>
        )}
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
        <label className={`flex items-start gap-2 text-sm pt-2 border-t ${gesperrt ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`}>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            disabled={gesperrt}
            className="mt-0.5 h-4 w-4 rounded border-input"
          />
          <span>
            Ich habe die Datenschutzerklärung gelesen und akzeptiere die
            beschriebene Verarbeitung meiner Daten.
          </span>
        </label>
        {/* Kasten-Buttons sind whitespace-nowrap und schrumpfen nicht unter
            ihre Textbreite. flex-wrap-reverse: passen beide nebeneinander,
            bleibt die Reihe; sonst (Handy) stapeln sie sich in voller Breite,
            die Primaeraktion oben — statt rechts aus dem Modal zu ragen. */}
        <div className="flex flex-wrap-reverse gap-2 pt-2">
          {ansicht ? (
            <button
              type="button"
              onClick={() => setGeschlossen(true)}
              className="kasten kasten-muted flex-1"
            >
              <X className="h-3.5 w-3.5" />
              Schliessen (nur Ansicht)
            </button>
          ) : (
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting || gesperrt}
              className="kasten kasten-muted flex-1"
            >
              <LogOut className="h-3.5 w-3.5" />
              Ablehnen + Abmelden
            </button>
          )}
          <button
            type="button"
            onClick={handleAccept}
            disabled={submitting || !confirmed || gesperrt}
            className="kasten kasten-blue flex-[2]"
            data-tooltip={ansicht ? "In der Ansicht als gesperrt" : undefined}
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            {submitting ? "Wird gespeichert…" : "Akzeptieren und fortfahren"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
