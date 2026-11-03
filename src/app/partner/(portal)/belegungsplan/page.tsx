"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { readImpersonationCookie } from "@/lib/impersonation";
import { partnerApi } from "@/lib/partner-api";
import type { KalenderEintrag, TerminEingabeKalender } from "@/lib/standort-kalender";
import {
  BelegungsplanKalender,
  type KalenderAktion,
  type KalenderLadeErgebnis,
  type KalenderSpeicherErgebnis,
} from "@/components/belegungsplan/belegungsplan-kalender";

// Partner-Belegungsplan: Monats-Kalender + Liste fuer die zugewiesene
// Location. Eigene Anfragen status-gefaerbt (Entwurf, Wartet, Bestaetigt,
// Abgelehnt). An Standorten mit partner_kalender (vorerst Barakuba) dazu
// die eigenen Termine (eintragen/aendern/loeschen) und die EVENTLINE-
// Auftraege mit Titel, Kunde, Status; sonst bleibt alles andere nur
// «Belegt» ohne Details (Leo 2026-10-15). Daten ausschliesslich ueber
// /api/partner/belegungsplan und /api/partner/kalender-termine.

const SKELETT = <div className="h-64 rounded-xl bg-foreground/10 dark:bg-foreground/15 animate-pulse" />;

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

  const laden = useCallback(async (start: string, end: string): Promise<KalenderLadeErgebnis> => {
    const r = await partnerApi<{ eintraege: KalenderEintrag[]; darfEintragen: boolean }>(
      `/api/partner/belegungsplan?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
    );
    if (!r.ok) return { ok: false, fehler: r.fehler };
    return { ok: true, eintraege: r.daten.eintraege ?? [], darfEintragen: r.daten.darfEintragen === true };
  }, []);

  const speichern = useCallback(
    async (aktion: KalenderAktion, id?: string, eingabe?: TerminEingabeKalender): Promise<KalenderSpeicherErgebnis> => {
      const r = await partnerApi<{ id?: string }>("/api/partner/kalender-termine", { aktion, id, ...eingabe });
      return r.ok ? { ok: true, id: r.daten.id } : { ok: false, fehler: r.fehler };
    },
    [],
  );

  if (loading) return SKELETT;

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
      {/* Am Handy steht der Titel im mobilen Kopf des Portals. */}
      <div className="max-md:hidden">
        <h1 className="text-2xl font-bold tracking-tight">Belegungsplan</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Übersicht deiner Location — Termine, Anfragen und belegte Tage.
        </p>
      </div>
      {/* Suspense: der Kalender liest den Monat aus der URL (useSearchParams). */}
      <Suspense fallback={SKELETT}>
        <BelegungsplanKalender laden={laden} speichern={speichern} modus="partner" />
      </Suspense>
    </div>
  );
}
