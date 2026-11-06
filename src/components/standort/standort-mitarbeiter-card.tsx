"use client";

/**
 * Location › Übersicht: «Eingeteilt bei <Location>» — welche EVENTLINE-
 * Mitarbeiter dieser Location zugeteilt sind (standort_mitarbeiter, n:m).
 * Gegenansicht zu Einstellungen › Mitarbeiter › Bearbeiten › «Locations».
 * Vorlage: Skizze /skizze/personal, Teil «Location › Übersicht».
 *
 * Lesen: alle, die die Location sehen (GET /api/standorte/[id]/mitarbeiter).
 * Bearbeiten: wer Personal bearbeiten darf (heute Admin, wie
 * Einstellungen › Mitarbeiter) — jede Änderung speichert sofort die ganze
 * Liste per PUT { profileIds }.
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";
import { TOAST } from "@/lib/messages";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EntfernbarChip, HinzufuegenSelect } from "@/components/standort/zuteilung-chips";

type Person = { id: string; full_name: string; is_active: boolean };

export function StandortMitarbeiterCard({
  locationId,
  locationName,
  canEdit,
  kalenderAn,
}: {
  locationId: string;
  locationName: string;
  /** Darf Zuteilungen ändern (Personal-Bearbeiten-Recht, nicht archiviert). */
  canEdit: boolean;
  /** Kalender der Location freigeschaltet → Verfügbarkeits-Hinweis zeigen. */
  kalenderAn: boolean;
}) {
  const [ids, setIds] = useState<string[] | null>(null);
  const [personen, setPersonen] = useState<Person[]>([]);
  const [saving, setSaving] = useState(false);
  /** Laden fehlgeschlagen → eigener Zustand, nie «niemand eingeteilt» annehmen
   *  (ein Speichern auf leerer Basis loeschte sonst alle Zuteilungen). */
  const [ladeFehler, setLadeFehler] = useState(false);

  useEffect(() => {
    let ab = false;
    (async () => {
      try {
        const [res, prof] = await Promise.all([
          fetch(`/api/standorte/${locationId}/mitarbeiter`, { cache: "no-store" }),
          createClient()
            .from("profiles")
            .select("id, full_name, is_active")
            .not("role", "in", PORTAL_ROLLEN_IN)
            .order("full_name"),
        ]);
        const json = await res.json().catch(() => null);
        if (ab) return;
        if (!res.ok || !Array.isArray(json?.profileIds)) throw new Error(json?.error ?? "laden");
        if (prof.error) throw prof.error;
        setPersonen(((prof.data ?? []) as Person[]).filter((p) => p.full_name));
        setIds(json.profileIds as string[]);
      } catch (err) {
        if (ab) return;
        console.error("standort-mitarbeiter.load", err);
        toast.error("Eingeteilte Mitarbeiter konnten nicht geladen werden");
        setLadeFehler(true);
      }
    })();
    return () => { ab = true; };
  }, [locationId]);

  const nameVon = useMemo(() => {
    const m = new Map(personen.map((p) => [p.id, p.full_name]));
    return (id: string) => m.get(id) ?? "Unbekannt";
  }, [personen]);

  async function speichern(neu: string[], erfolg: string) {
    setSaving(true);
    try {
      const res = await fetch(`/api/standorte/${locationId}/mitarbeiter`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileIds: neu }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.success === false) { TOAST.errorOr(json?.error, "Speichern fehlgeschlagen"); return; }
      setIds(Array.isArray(json?.profileIds) ? (json.profileIds as string[]) : neu);
      toast.success(erfolg);
    } catch {
      toast.error("Speichern fehlgeschlagen");
    } finally {
      setSaving(false);
    }
  }

  const eingeteilt = ids ?? [];
  const kandidaten = personen.filter((p) => p.is_active && !eingeteilt.includes(p.id));

  return (
    <Card className="bg-card">
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-3 flex-wrap">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <Users className="h-4 w-4" />
          Eingeteilt bei {locationName}
          {ids && <span className="text-[10px] font-normal text-muted-foreground">({eingeteilt.length})</span>}
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-label="Speichert…" />}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {ladeFehler ? (
          <p className="text-xs text-red-600 dark:text-red-400">
            Eingeteilte Mitarbeiter konnten nicht geladen werden — Bearbeiten gesperrt (Seite neu laden).
          </p>
        ) : ids === null ? (
          <div className="flex gap-1.5">
            {[1, 2].map((i) => <div key={i} className="shimmer h-6 w-24 rounded-full" />)}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              {eingeteilt.length === 0 ? (
                <span className="text-xs text-muted-foreground">
                  {kalenderAn
                    ? "Niemand eingeteilt — der Kalender zeigt dann keine Verfügbarkeit von EVENTLINE."
                    : "Niemand eingeteilt."}
                </span>
              ) : (
                eingeteilt.map((pid) => (
                  <EntfernbarChip
                    key={pid}
                    label={nameVon(pid)}
                    disabled={saving}
                    entfernenText={`${nameVon(pid)} entfernen`}
                    onEntfernen={
                      canEdit
                        ? () => speichern(
                            eingeteilt.filter((x) => x !== pid),
                            `${nameVon(pid)} bei ${locationName} entfernt`,
                          )
                        : undefined
                    }
                  />
                ))
              )}
            </div>
            {canEdit && (
              <div
                className="w-64 max-md:w-full"
                style={saving ? { pointerEvents: "none", opacity: 0.6 } : undefined}
                aria-disabled={saving}
              >
                <HinzufuegenSelect
                  items={kandidaten.map((p) => ({ id: p.id, label: p.full_name }))}
                  placeholder="Person einteilen…"
                  onWahl={(id) => speichern([...eingeteilt, id], `${nameVon(id)} bei ${locationName} eingeteilt`)}
                />
              </div>
            )}
            {kalenderAn && (
              <p className="text-[11px] text-muted-foreground">
                Eine freie Person genügt. Ist nur eine frei, steht der Tag im Kalender als «knapp»; ist niemand frei
                (Ferien, krank, Einsatz woanders), als «nicht verfügbar».
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
