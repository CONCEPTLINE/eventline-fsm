"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { readImpersonationCookie } from "@/lib/impersonation";
import { PartnerBelegungsplan } from "@/components/partner-belegungsplan";

// Partner-Belegungsplan: Monats-Kalender + Buchungs-Liste fuer die
// zugewiesene Location. Eigene Anfragen status-gefaerbt (Entwurf,
// Wartet, Bestaetigt, Abgelehnt), EVENTLINE-Vermietungen als blaue
// "Vermietung"-Kategorie sichtbar (was_anfrage=true — Auftrag aus einer
// frueheren Vermietungs-Anfrage entstanden). Reine EVENTLINE-Auftraege
// ohne Vermietungs-Tag werden nicht angezeigt.

export default function PartnerBelegungsplanPage() {
  const supabase = createClient();
  const [locationId, setLocationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      // View-As: Location des impersonierten Partners (wie Portal-Layout).
      const profileId = readImpersonationCookie() || user.id;
      const { data } = await supabase
        .from("profiles")
        .select("partner_location_id")
        .eq("id", profileId)
        .maybeSingle();
      setLocationId(data?.partner_location_id ?? null);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return <div className="h-64 rounded-xl bg-foreground/10 dark:bg-foreground/15 animate-pulse" />;
  }

  if (!locationId) {
    return (
      <div className="rounded-xl border border-dashed bg-card p-6 text-center">
        <p className="text-sm text-muted-foreground">
          Deinem Profil ist keine Location zugewiesen. Wende dich an EVENTLINE.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Belegungsplan</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Übersicht deiner Location — eigene Anfragen und EVENTLINE-Vermietungen.
        </p>
      </div>
      <PartnerBelegungsplan locationId={locationId} />
    </div>
  );
}
