"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { readImpersonationCookie } from "@/lib/impersonation";
import { BelegungsplanKalender } from "@/components/belegungsplan/belegungsplan-kalender";
import { kalenderApi } from "@/components/belegungsplan/kalender-api";

// Partner-Kalender: Monats-Kalender + Liste fuer die zugewiesene Location
// (frueher «Belegungsplan», /partner/belegungsplan leitet hierher um).
// Eigene Anfragen mit Status. An Standorten mit partner_kalender (vorerst
// Barakuba) dazu die eigenen Eintraege (Termine, Veranstaltungen, Programm),
// Uebernahme-Zeitraeume, die Verfuegbarkeit EVENTLINE und die EVENTLINE-
// Auftraege mit Titel, Kunde, Status; sonst bleibt alles andere nur
// «Belegt» ohne Details (Leo 2026-10-15). Daten ausschliesslich ueber
// /api/partner/** (kalender-api.ts).

const SKELETT = <div className="h-64 rounded-xl bg-foreground/10 dark:bg-foreground/15 animate-pulse" />;

export default function PartnerKalenderPage() {
  const supabase = createClient();
  const [location, setLocation] = useState<{ id: string; name: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const api = useMemo(() => kalenderApi("/api/partner"), []);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      // View-As: Location des impersonierten Partners (wie Portal-Layout).
      const profileId = readImpersonationCookie() || user.id;
      const { data } = await supabase
        .from("profiles")
        .select("partner_location_id, location:locations!profiles_partner_location_id_fkey(name)")
        .eq("id", profileId)
        .maybeSingle();
      const loc = Array.isArray(data?.location) ? data?.location[0] : data?.location;
      setLocation(data?.partner_location_id ? { id: data.partner_location_id, name: (loc as { name: string | null } | null)?.name ?? null } : null);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return SKELETT;

  if (!location) {
    return (
      <div className="rounded-xl border border-dashed bg-card p-6 text-center">
        <p className="text-sm text-muted-foreground">
          Deinem Profil ist keine Location zugewiesen. Wende dich an EVENTLINE.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 page-enter">
      {/* Am Handy steht der Titel im mobilen Kopf des Portals. */}
      <div className="max-md:hidden">
        <h1 className="text-2xl font-bold tracking-tight">Kalender</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Übersicht deiner Location — Termine, Veranstaltungen, Anfragen und EVENTLINE.
        </p>
      </div>
      {/* Suspense: der Kalender liest den Monat aus der URL (useSearchParams). */}
      <Suspense fallback={SKELETT}>
        <BelegungsplanKalender api={api} modus="partner" ortName={location.name} />
      </Suspense>
    </div>
  );
}
