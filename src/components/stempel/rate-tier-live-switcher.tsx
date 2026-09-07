"use client";

/**
 * Wechsel-des-Modus-waehrend-laufender-Stempelung.
 *
 * Nutzung: <RateTierLiveSwitcher jobId={active.job_id} /> im
 * Stempel-Widget / SidebarStempel. Laedt selbst die Tiers ueber die
 * job → location-Chain und rendert den Switcher NUR wenn:
 *   - Job hat eine Location
 *   - Location hat > 1 aktiven Tier
 *
 * Klick auf anderen Tier → useStempel.switchRateTier(). Das schliesst
 * die aktuelle Stempelung + startet eine neue mit dem neuen Tier —
 * so ergibt der Report zwei sauber getrennte Zeit-Bloecke.
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useStempel } from "@/lib/use-stempel";
import { RateTierSwitcher, useLocationRateTiers } from "./rate-tier-chooser";

export function RateTierLiveSwitcher({ jobId }: { jobId: string | null | undefined }) {
  const supabase = createClient();
  const { active, switchRateTier } = useStempel();
  const [locationId, setLocationId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!jobId) { setLocationId(null); return; }
    (async () => {
      const { data } = await supabase
        .from("jobs")
        .select("location_id")
        .eq("id", jobId)
        .maybeSingle();
      if (!cancelled) setLocationId((data?.location_id as string | null) ?? null);
    })();
    return () => { cancelled = true; };
  }, [jobId, supabase]);

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
    toast.success(`Modus gewechselt auf „${newTier?.label ?? "…"}"`);
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
