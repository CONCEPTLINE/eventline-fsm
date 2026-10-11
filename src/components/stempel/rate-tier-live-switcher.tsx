"use client";

/**
 * Wechsel-des-Modus-waehrend-laufender-Stempelung.
 *
 * Nutzung: <RateTierLiveSwitcher jobId={active.job_id} /> im
 * Stempel-Sheet (Handy) / SidebarStempel (Desktop). Laedt selbst die Tiers ueber die
 * job → location-Chain und rendert den Switcher NUR wenn:
 *   - Job hat eine Location
 *   - Location hat > 1 aktiven Tier
 *
 * Klick auf anderen Tier → useStempel.switchRateTier(). Das schliesst
 * die aktuelle Stempelung + startet eine neue mit dem neuen Tier —
 * so ergibt der Report zwei sauber getrennte Zeit-Bloecke.
 *
 * Offline: location_id je Auftrag geht online write-through in den
 * IndexedDB-Cache `job_location:<jobId>` (je meId) und kommt bei Netzfehler
 * von dort — erst damit greift der Tarif-Cache in useLocationRateTiers und
 * der Wechsel kann ohne Netz in die Reihe.
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { useStempel, stempelErfolgText } from "@/lib/use-stempel";
import { cacheLesen, cacheSchreiben, istIdbVerfuegbar } from "@/lib/offline/db";
import { istNetzfehler } from "@/lib/offline/stempel-outbox";
import { RateTierSwitcher, useLocationRateTiers } from "./rate-tier-chooser";

export function RateTierLiveSwitcher({ jobId }: { jobId: string | null | undefined }) {
  const supabase = createClient();
  const { meId } = usePermissions();
  const { active, switchRateTier, online } = useStempel();
  // Standort gehoert zu einer Job-ID — so zeigt ein Auftragswechsel nie kurz
  // die Tiers des alten Standorts, und der Effekt braucht kein synchrones Reset.
  const [stand, setStand] = useState<{ jobId: string; locationId: string | null } | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    const schluessel = `job_location:${jobId}`;
    (async () => {
      const { data, error, status } = await supabase
        .from("jobs")
        .select("location_id")
        .eq("id", jobId)
        .maybeSingle();
      if (cancelled) return;
      if (!error) {
        const locationId = (data?.location_id as string | null) ?? null;
        setStand({ jobId, locationId });
        if (meId && istIdbVerfuegbar()) {
          void cacheSchreiben(meId, schluessel, locationId).catch(() => { /* Cache ist Beschleunigung, kein Muss */ });
        }
        return;
      }
      // Netzfehler → letzter Standort aus dem Cache. Andere Fehler oder kein
      // Eintrag → kein Standort; ein schon geladener Stand desselben Auftrags bleibt.
      let ausCache: string | null = null;
      if (istNetzfehler(error, status) && meId && istIdbVerfuegbar()) {
        ausCache = (await cacheLesen<string | null>(meId, schluessel).catch(() => null))?.data ?? null;
        if (cancelled) return;
      }
      setStand((prev) =>
        ausCache === null && prev?.jobId === jobId ? prev : { jobId, locationId: ausCache },
      );
    })();
    return () => { cancelled = true; };
  }, [jobId, supabase, meId]);

  const locationId = jobId && stand?.jobId === jobId ? stand.locationId : null;
  const { tiers } = useLocationRateTiers(locationId);
  if (!jobId || tiers.length <= 1 || !active) return null;

  async function handleSwitch(newTierId: string) {
    setSwitching(true);
    const res = await switchRateTier(newTierId);
    setSwitching(false);
    if (!res.success) {
      toast.error("Modus-Wechsel fehlgeschlagen: " + (res.error ?? "unbekannt"));
      return;
    }
    const newTier = tiers.find((t) => t.id === newTierId);
    // wartet = gespeichert, noch nicht am Server — nicht als «erledigt» melden
    toast.success(stempelErfolgText(res, `Modus gewechselt auf „${newTier?.label ?? "…"}"`, online));
  }

  return (
    <div className="pt-2 mt-2 border-t border-border/60">
      <RateTierSwitcher
        tiers={tiers}
        currentId={active.rate_tier_id ?? null}
        onSwitch={handleSwitch}
        disabled={switching}
      />
    </div>
  );
}
