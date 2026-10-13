"use client";

import { useState } from "react";
import { Laptop, Loader2, LogOut } from "lucide-react";
import { Logo } from "@/components/logo";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Lieferantenportal am Handy (< 768 px): statt der Portalseiten nur ein
 * ruhiger Hinweis, dass das Portal fuer den Computer gemacht ist — plus
 * Abmelden. Das Portal-Layout blendet diesen Baustein per CSS-Weiche ein
 * (md:hidden), die Desktop-Ansicht bleibt dadurch unberuehrt.
 *
 * Abmelden ruft onAbmelden des Portal-Layouts. Die navigiert danach zum
 * Login; der Spinner bleibt bis dahin stehen. Schlaegt die Abmeldung fehl
 * (onAbmelden wirft, z. B. ohne Netz), zeigt der Hinweis den Fehler direkt
 * an — der Toaster des Portals liegt am Handy in der ausgeblendeten
 * Desktop-Ansicht.
 */
export function NurComputerHinweis({
  onAbmelden,
}: {
  onAbmelden: () => Promise<void>;
}) {
  const [abmelden, setAbmelden] = useState(false);
  const [fehler, setFehler] = useState(false);

  async function handleAbmelden() {
    setAbmelden(true);
    setFehler(false);
    try {
      await onAbmelden();
    } catch {
      setAbmelden(false);
      setFehler(true);
    }
  }

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-4 py-10 bg-[#f5f5f7] dark:bg-[#0a0a0a]">
      <Logo size="lg" />
      <div className="mt-8 w-full max-w-sm rounded-2xl border bg-card px-5">
        <EmptyState
          icon={Laptop}
          title="Bitte am Computer öffnen"
          description="Das Lieferantenportal ist für den Laptop oder Computer gemacht. Auf dem Handy lässt es sich nicht sinnvoll bedienen."
          action={
            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={handleAbmelden}
                disabled={abmelden}
                className="kasten kasten-muted h-[34px] px-5 text-[13px]"
              >
                {abmelden ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
                {abmelden ? "Wird abgemeldet…" : "Abmelden"}
              </button>
              {fehler && (
                <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                  Abmelden hat nicht geklappt. Bitte nochmals versuchen.
                </p>
              )}
            </div>
          }
        />
      </div>
    </div>
  );
}
