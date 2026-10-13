"use client";

/**
 * DeveloperModeCard — dezenter Admin-only Toggle fuer Developer-Mode / View-As.
 *
 * Aktiviert profiles.developer_mode_enabled fuer den eingeloggten Admin.
 * Wenn AN, erscheint global das ViewAsOverlay mit dem der Admin die
 * Perspektive anderer Mitarbeiter simulieren kann. Waehrend aktiver
 * Impersonation blockiert die Server-Middleware alle Schreibvorgaenge —
 * es kann nichts kaputt gehen.
 *
 * Design: bewusst SCHLICHT (nicht wie eine Marketing-Feature-Card).
 * Lebt unter Einstellungen › Sicherheit, Abschnitt Entwickler-Modus (vorher
 * am Ende der Team-Liste) — deshalb ein eigener, ruhiger Rahmen statt der
 * gestrichelten Trennlinie.
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { usePermissions } from "@/lib/use-permissions";
import { createClient } from "@/lib/supabase/client";

export function DeveloperModeCard() {
  const { profile, ready } = usePermissions();
  const supabase = createClient();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const isAdmin = profile?.role === "admin";

  useEffect(() => {
    if (!ready || !isAdmin || !profile?.id) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("developer_mode_enabled")
        .eq("id", profile.id)
        .maybeSingle();
      if (cancelled) return;
      setEnabled(Boolean(data?.developer_mode_enabled));
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, isAdmin, profile?.id, supabase]);

  if (!ready || !isAdmin) return null;

  async function toggle(next: boolean) {
    setSaving(true);
    try {
      const res = await fetch("/api/dev/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? "Fehler");
      setEnabled(next);
      toast.success(next ? "Entwickler-Modus aktiviert" : "Entwickler-Modus deaktiviert");
      window.dispatchEvent(new CustomEvent("developer-mode-changed"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Fehler");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground/85">
            Entwickler-Modus
            {saving && <Loader2 className="inline h-3 w-3 animate-spin ml-1.5 text-muted-foreground align-[-1px]" />}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
            Overlay unten rechts zum Simulieren anderer Mitarbeiter- oder Partner-Perspektiven. Schreibvorgänge sind während der Simulation gesperrt.
          </p>
        </div>
        <button
          type="button"
          disabled={saving || enabled === null}
          onClick={() => toggle(!enabled)}
          aria-pressed={enabled === true}
          aria-label={enabled ? "Entwickler-Modus deaktivieren" : "Entwickler-Modus aktivieren"}
          className="shrink-0"
          style={{
            width: 38,
            height: 22,
            borderRadius: 999,
            position: "relative",
            background: enabled
              ? "var(--accent)"
              : "color-mix(in oklab, var(--foreground) 18%, transparent)",
            cursor: saving ? "wait" : "pointer",
            transition: "background 160ms ease",
            border: "none",
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 2,
              left: enabled ? 18 : 2,
              width: 18,
              height: 18,
              borderRadius: 999,
              background: "white",
              transition: "left 180ms cubic-bezier(0.25, 1, 0.5, 1)",
              boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
            }}
          />
        </button>
      </div>
    </div>
  );
}
