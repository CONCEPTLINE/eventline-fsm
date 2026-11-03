"use client";

/**
 * Location-Detail, Tab «Belegungsplan» — derselbe Kalender wie im
 * Partnerportal (Termine des Partners, Partner-Anfragen, EVENTLINE-
 * Auftraege). Nur sichtbar an Standorten mit partner_kalender = true
 * (page.tsx). Ob Termine eingetragen/bearbeitet werden duerfen, sagt die
 * API (`darfEintragen`/`bearbeitbar`, Admin bzw. locations:edit);
 * archivierte Locations sind hier zusaetzlich nur lesbar.
 */

import { useCallback } from "react";
import type { KalenderEintrag, TerminEingabeKalender } from "@/lib/standort-kalender";
import {
  BelegungsplanKalender,
  type KalenderAktion,
  type KalenderLadeErgebnis,
  type KalenderSpeicherErgebnis,
} from "@/components/belegungsplan/belegungsplan-kalender";

type Antwort<T> = { ok: true; daten: T } | { ok: false; fehler: string | null };

/** GET ohne `body`, sonst POST mit JSON; Antwortform { success, error, … }. */
async function api<T>(url: string, body?: unknown): Promise<Antwort<T>> {
  try {
    const res = await fetch(
      url,
      body === undefined
        ? undefined
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
    const json = (await res.json().catch(() => null)) as ({ success?: boolean; error?: string } & T) | null;
    if (!res.ok || !json?.success) return { ok: false, fehler: json?.error ?? null };
    return { ok: true, daten: json };
  } catch {
    return { ok: false, fehler: "Netzwerkfehler" };
  }
}

export function BelegungsplanTab({ locationId, nurLesen }: { locationId: string; nurLesen: boolean }) {
  const laden = useCallback(
    async (start: string, end: string): Promise<KalenderLadeErgebnis> => {
      const r = await api<{ eintraege: KalenderEintrag[]; darfEintragen: boolean }>(
        `/api/standorte/${locationId}/belegungsplan?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
      );
      if (!r.ok) return { ok: false, fehler: r.fehler };
      const eintraege = r.daten.eintraege ?? [];
      return {
        ok: true,
        // Archiv = nur lesen (src/lib/archiv.ts): nichts eintragen/bearbeiten.
        eintraege: nurLesen ? eintraege.map((e) => ({ ...e, bearbeitbar: false })) : eintraege,
        darfEintragen: !nurLesen && r.daten.darfEintragen === true,
      };
    },
    [locationId, nurLesen],
  );

  const speichern = useCallback(
    async (aktion: KalenderAktion, id?: string, eingabe?: TerminEingabeKalender): Promise<KalenderSpeicherErgebnis> => {
      const r = await api<{ id?: string }>(`/api/standorte/${locationId}/kalender-termine`, { aktion, id, ...eingabe });
      return r.ok ? { ok: true, id: r.daten.id } : { ok: false, fehler: r.fehler };
    },
    [locationId],
  );

  return <BelegungsplanKalender laden={laden} speichern={speichern} modus="intern" />;
}
