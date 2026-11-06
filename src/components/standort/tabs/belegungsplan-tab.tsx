"use client";

/**
 * Location-Detail, Tab «Kalender» (URL-Key bleibt ?tab=belegungsplan) —
 * derselbe Kalender wie im Partnerportal (eigene Eintraege des Partners,
 * Partner-Anfragen, EVENTLINE-Auftraege, Uebernahme-Zeitraeume), dazu die
 * Verfuegbarkeit EVENTLINE mit Namen und Gruenden. Nur sichtbar an
 * Standorten mit partner_kalender = true (page.tsx). Ob eingetragen/
 * bearbeitet werden darf, sagt die API (`darfEintragen`/`bearbeitbar`,
 * Admin bzw. locations:edit); archivierte Locations sind hier zusaetzlich
 * nur lesbar.
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { PrefetchLink } from "@/components/shell/prefetch-link";
import { BelegungsplanKalender } from "@/components/belegungsplan/belegungsplan-kalender";
import { kalenderApi, type KalenderApi } from "@/components/belegungsplan/kalender-api";

export function BelegungsplanTab({ locationId, nurLesen }: { locationId: string; nurLesen: boolean }) {
  const api = useMemo<KalenderApi>(() => {
    const basis = kalenderApi(`/api/standorte/${locationId}`);
    if (!nurLesen) return basis;
    // Archiv = nur lesen (src/lib/archiv.ts): nichts eintragen/bearbeiten.
    return {
      ...basis,
      async laden(start, end) {
        const r = await basis.laden(start, end);
        if (!r.ok) return r;
        return {
          ok: true,
          darfEintragen: false,
          antwort: { ...r.antwort, eintraege: r.antwort.eintraege.map((e) => ({ ...e, bearbeitbar: false })) },
        };
      },
    };
  }, [locationId, nurLesen]);

  // Wer bei dieser Location eingeteilt ist (standort_mitarbeiter) — fuer die
  // Kopfzeile der Verfuegbarkeit. Bearbeitet wird in «Übersicht».
  const [ortName, setOrtName] = useState<string | null>(null);
  const [eingeteilt, setEingeteilt] = useState<string[] | null>(null);
  useEffect(() => {
    let ab = false;
    (async () => {
      try {
        const supabase = createClient();
        const [res, ort] = await Promise.all([
          fetch(`/api/standorte/${locationId}/mitarbeiter`, { cache: "no-store" }),
          supabase.from("locations").select("name").eq("id", locationId).maybeSingle(),
        ]);
        const json = await res.json().catch(() => null);
        if (!res.ok || !Array.isArray(json?.profileIds)) throw new Error(json?.error ?? "laden");
        const ids = json.profileIds as string[];
        let namen: string[] = [];
        if (ids.length > 0) {
          const { data, error } = await supabase.from("profiles").select("full_name").in("id", ids).order("full_name");
          if (error) throw error;
          namen = ((data ?? []) as { full_name: string | null }[]).map((p) => p.full_name ?? "").filter(Boolean);
        }
        if (ab) return;
        setOrtName((ort.data as { name: string | null } | null)?.name ?? null);
        setEingeteilt(namen);
      } catch (err) {
        if (ab) return;
        console.error("standort-kalender.eingeteilt", err);
        toast.error("Eingeteilte Mitarbeiter konnten nicht geladen werden");
      }
    })();
    return () => { ab = true; };
  }, [locationId]);

  const bei = ortName ? ` bei ${ortName}` : "";
  const hinweis = eingeteilt === null ? null : (
    <>
      {eingeteilt.length > 0
        ? `Eingeteilt${bei}: ${eingeteilt.join(", ")} · alle übrigen Tage: mindestens zwei Personen frei`
        : `${ortName ? `Bei ${ortName}` : "Hier"} ist niemand eingeteilt — ohne Einteilung keine Angabe`}
      {" · "}
      <PrefetchLink href={`/standorte/${locationId}?tab=uebersicht`} className="underline underline-offset-2 text-foreground/70">
        Einteilung ändern
      </PrefetchLink>
    </>
  );

  return <BelegungsplanKalender api={api} modus="intern" ortName={ortName} einteilungHinweis={hinweis} />;
}
