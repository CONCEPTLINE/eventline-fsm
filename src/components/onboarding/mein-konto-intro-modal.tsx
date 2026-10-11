"use client";

/**
 * Welcome-Modal das beim naechsten Login die Mein-Konto-Seite vorstellt.
 *
 * Sichtbarkeit: solange `intro_dismissed_at` NULL ist. Klick auf
 * "Verstanden" oder "Direkt oeffnen" setzt das Flag — danach erscheint
 * das Modal nie wieder fuer diesen User.
 *
 * Wird in (app)/layout gemountet — also app-weit aktiv, nicht nur auf
 * einer bestimmten Seite. Der User soll's spaetestens nach 2 Sekunden
 * sehen egal wo er nach dem Login landet.
 *
 * FEATURES-Liste ist im Sync mit den echten Tabs unter /mein-konto:
 * Profil / Sicherheit / Benachrichtigungen / Kalender. "Dokumente" ist
 * unter /hr → Lohn umgezogen (2026-09) und "Admin-Space" wurde entfernt
 * — beide sind bewusst NICHT mehr in dieser Liste.
 */

import Link from "next/link";
import { Modal } from "@/components/ui/modal";
import { useMeinKontoOnboarding } from "@/lib/use-mein-konto-onboarding";
import { User, Bell, Fingerprint, Calendar, ArrowRight, Check } from "lucide-react";

interface Feature {
  icon: React.ReactNode;
  label: string;
  desc: string;
}

const FEATURES: Feature[] = [
  { icon: <User className="h-4 w-4" />,        label: "Profil",             desc: "Name, Email, Datenexport (DSG)" },
  { icon: <Fingerprint className="h-4 w-4" />, label: "Sicherheit",         desc: "Passkeys / Face-ID / Passwort" },
  { icon: <Bell className="h-4 w-4" />,        label: "Benachrichtigungen", desc: "Push, Sound, Ruhezeiten" },
  { icon: <Calendar className="h-4 w-4" />,    label: "Kalender",           desc: "iCal-Feed für Google/Apple/Outlook" },
];

export function MeinKontoIntroModal() {
  const { introDismissedAt, ready, dismissIntro } = useMeinKontoOnboarding();
  const open = ready && !introDismissedAt;

  function close() { void dismissIntro(); }

  return (
    <Modal open={open} onClose={close} title="Willkommen in „Mein Konto“" size="md" sheet>
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Alles Persönliche liegt jetzt an einem Ort. Hier eine kurze Übersicht
          was du dort findest:
        </p>

        <div className="space-y-1.5">
          {FEATURES.map((f) => (
            <div key={f.label} className="flex items-start gap-2.5 p-2.5 rounded-lg bg-foreground/[0.03] dark:bg-foreground/[0.05]">
              <div className="w-8 h-8 rounded-lg bg-card border border-border flex items-center justify-center text-foreground/70 shrink-0">
                {f.icon}
              </div>
              <div className="flex-1 min-w-0 pt-0.5">
                <p className="text-sm font-medium leading-tight">{f.label}</p>
                <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col-reverse sm:flex-row gap-2 pt-1">
          <button type="button" onClick={close} className="kasten kasten-muted sm:flex-1 justify-center">
            <Check className="h-3.5 w-3.5" /> Verstanden
          </button>
          <Link
            href="/mein-konto"
            onClick={close}
            className="kasten kasten-red sm:flex-1 justify-center"
          >
            Direkt öffnen <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </Modal>
  );
}
