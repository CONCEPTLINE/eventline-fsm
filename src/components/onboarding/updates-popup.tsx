"use client";

/**
 * "Neue Funktionen"-Popup beim Login.
 *
 * Erscheint fuer Nicht-Admins (und Nicht-Partner), wenn es in
 * src/lib/app-updates.ts Eintraege gibt, die neuer sind als
 * profiles.updates_seen_at. Zeigt die neuen Eintraege kompakt +
 * Link zur /anleitung-Seite. Schliessen (X oder Button) markiert
 * als gesehen — bis zum naechsten neuen Eintrag.
 *
 * Admins sehen KEIN Popup (Leo 2026-09-08): sie kennen die Features,
 * weil sie sie in Auftrag geben. Die /anleitung-Seite selbst steht
 * ihnen natuerlich offen.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, ArrowRight } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { usePermissions } from "@/lib/use-permissions";
import { APP_UPDATES, audienceLabel, type AppUpdate } from "@/lib/app-updates";

export function UpdatesPopup() {
  const router = useRouter();
  const { profile, role } = usePermissions();
  const [newUpdates, setNewUpdates] = useState<AppUpdate[]>([]);
  const [open, setOpen] = useState(false);
  const checkedRef = useRef(false);

  useEffect(() => {
    if (!profile) return;
    if (role === "admin" || role === "partner") return;
    if (checkedRef.current) return;
    checkedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/updates/seen");
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled || !json.success) return;
        const seenAt: string | null = json.seen_at;
        // Eintraege neuer als "gesehen" — Datum-Vergleich auf Tages-Ebene:
        // updates_seen_at ist ein voller Timestamp, u.date ein YYYY-MM-DD.
        // Ein Eintrag gilt als neu, wenn sein Tag NACH dem Gesehen-Tag liegt
        // ODER noch nie etwas gesehen wurde.
        const seenDay = seenAt ? seenAt.slice(0, 10) : null;
        const fresh = APP_UPDATES
          .filter((u) => (seenDay === null ? true : u.date > seenDay))
          .sort((a, b) => b.date.localeCompare(a.date));
        if (fresh.length > 0) {
          setNewUpdates(fresh);
          setOpen(true);
        }
      } catch {
        // still — Ambient-Feature, kein Toast bei Netzfehler.
      }
    })();
    return () => { cancelled = true; };
  }, [profile, role]);

  async function markSeen() {
    setOpen(false);
    try {
      await fetch("/api/updates/seen", { method: "POST" });
    } catch {
      // still — beim naechsten Login erscheint das Popup dann nochmal.
    }
  }

  function goToAnleitung() {
    markSeen();
    router.push("/anleitung");
  }

  if (!open || newUpdates.length === 0) return null;

  const shown = newUpdates.slice(0, 5);
  const more = newUpdates.length - shown.length;

  return (
    <Modal
      open={open}
      onClose={markSeen}
      title="Neue Funktionen in der App"
      icon={<Sparkles className="h-5 w-5 text-red-500" />}
      size="md"
    >
      <div className="space-y-3">
        <div className="space-y-2">
          {shown.map((u) => (
            <div key={u.id} className="p-3 rounded-xl border border-border bg-muted/30">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-semibold">{u.title}</p>
                {u.audience !== "alle" && (
                  <span className="inline-flex px-1.5 py-0 text-[10px] font-medium rounded-full bg-foreground/[0.08] text-muted-foreground">
                    {audienceLabel(u.audience)}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">{u.summary}</p>
            </div>
          ))}
          {more > 0 && (
            <p className="text-xs text-muted-foreground text-center">
              + {more} weitere Neuerung{more > 1 ? "en" : ""}
            </p>
          )}
        </div>

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={markSeen} className="kasten kasten-muted flex-1">
            Verstanden
          </button>
          <button type="button" onClick={goToAnleitung} className="kasten kasten-red flex-1">
            Zur Anleitung
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </Modal>
  );
}
