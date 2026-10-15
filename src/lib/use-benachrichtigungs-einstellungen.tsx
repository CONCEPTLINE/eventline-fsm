"use client";

// Gemeinsame Daten-Schicht der Benachrichtigungs-Einstellungen (Mein Konto
// intern + Konto-Karte der Portale) ueber /api/notifications/einstellungen.
// Der Server nimmt das angesehene Konto — in der «Ansicht als» stehen hier
// die Einstellungen der Person. Schalten geht dort nur im Bearbeiten-Modus
// des Overlays (live aus dem Cookie), sonst ist alles gesperrt.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Eye } from "lucide-react";
import { readImpersonationWriteCookie } from "@/lib/impersonation";
import type { NotificationChannel } from "@/lib/notification-meta";

export type KanalBlob = Record<string, Partial<Record<NotificationChannel, boolean>>>;

export interface BenachrichtigungsStand {
  channels: KanalBlob;
  stille: { an: boolean; von: string; bis: string };
  ansichtAls: boolean;
  name: string | null;
}

export type EinstellungsAenderung =
  | { art: "kanal"; typ: string; kanal: NotificationChannel; an: boolean }
  | { art: "alle_in_app"; an: boolean }
  | { art: "stille"; an?: boolean; von?: string; bis?: string };

const PFAD = "/api/notifications/einstellungen";

/** Tooltip an gesperrten Schaltern in der «Ansicht als». */
export const ANSICHT_ALS_GESPERRT_TOOLTIP = "In der «Ansicht als» nur lesen — Bearbeitung im Overlay aktivieren";

/** Bearbeiten-Modus der «Ansicht als» — im Overlay jederzeit umschaltbar,
 *  darum live aus dem Cookie (nur waehrend der Ansicht als abgefragt). */
function useSchreibmodus(ansichtAls: boolean): boolean {
  const subscribe = useCallback((melden: () => void) => {
    if (!ansichtAls) return () => {};
    const t = window.setInterval(melden, 1000);
    return () => window.clearInterval(t);
  }, [ansichtAls]);
  const an = useSyncExternalStore(subscribe, readImpersonationWriteCookie, () => false);
  return ansichtAls && an;
}

function standAus(j: Record<string, unknown>): BenachrichtigungsStand {
  const s = (j.stille ?? {}) as { an?: unknown; von?: unknown; bis?: unknown };
  return {
    channels: (j.channels as KanalBlob) ?? {},
    stille: {
      an: s.an === true,
      von: typeof s.von === "string" ? s.von : "22:00",
      bis: typeof s.bis === "string" ? s.bis : "07:00",
    },
    ansichtAls: j.ansichtAls === true,
    name: (j.name as string | null) ?? null,
  };
}

export function useBenachrichtigungsEinstellungen() {
  const [laden, setLaden] = useState<"laedt" | "fehler" | "ok">("laedt");
  const [stand, setStand] = useState<BenachrichtigungsStand | null>(null);
  const [saving, setSaving] = useState(false);
  const ansichtAls = stand?.ansichtAls === true;
  const schreibmodus = useSchreibmodus(ansichtAls);
  const gesperrt = ansichtAls && !schreibmodus;

  // Setzt nur Ergebnis/Fehler; den Lade-Zustand setzt der Aufrufer (Start =
  // Initialwert, «Erneut laden» = erneutLaden).
  const ladeStand = useCallback(async () => {
    try {
      const res = await fetch(PFAD, { cache: "no-store" });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.success) throw new Error(j?.error ?? "Benachrichtigungen konnten nicht geladen werden");
      setStand(standAus(j));
      setLaden("ok");
    } catch (e) {
      setLaden("fehler");
      toast.error(e instanceof Error ? e.message : "Benachrichtigungen konnten nicht geladen werden");
    }
  }, []);
  useEffect(() => { void ladeStand(); }, [ladeStand]);

  const erneutLaden = useCallback(() => { setLaden("laedt"); void ladeStand(); }, [ladeStand]);

  /** Eine Aenderung speichern: sofort anzeigen (`vorschau`), dann den Stand
   *  des Servers uebernehmen; bei Fehler zurueck + Toast. Eine Aenderung
   *  nach der anderen — die Schalter sind waehrend des Speicherns gesperrt. */
  async function speichern(aenderung: EinstellungsAenderung, vorschau: (s: BenachrichtigungsStand) => BenachrichtigungsStand) {
    if (!stand || gesperrt || saving) return;
    const vorher = stand;
    setStand(vorschau(stand));
    setSaving(true);
    try {
      const res = await fetch(PFAD, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(aenderung),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.success) throw new Error(j?.error ?? "Speichern fehlgeschlagen");
      setStand(standAus(j));
    } catch (e) {
      setStand(vorher);
      toast.error(e instanceof Error ? e.message : "Speichern fehlgeschlagen");
    } finally {
      setSaving(false);
    }
  }

  return { laden, stand, saving, ansichtAls, schreibmodus, gesperrt, erneutLaden, speichern };
}

/** Hinweis in der «Ansicht als»: wessen Einstellungen hier stehen und ob
 *  Schalten geht (gleiche Optik wie der Datenschutz-Hinweis). */
export function AnsichtAlsHinweis({ name, schreibmodus }: { name: string | null; schreibmodus: boolean }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
      <Eye className="h-4 w-4 shrink-0 mt-0.5" />
      <p>
        <strong className="font-semibold">Ansicht als:</strong> Einstellungen von {name ?? "dieser Person"}.{" "}
        {schreibmodus
          ? "Bearbeitung aktiv — Änderungen gelten für diese Person."
          : "Nur lesen — zum Ändern im Overlay die Bearbeitung aktivieren."}
      </p>
    </div>
  );
}
