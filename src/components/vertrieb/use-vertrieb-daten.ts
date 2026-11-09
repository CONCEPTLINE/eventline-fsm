"use client";

/**
 * Daten für /vertrieb (Vertrieb neu, Leo 09.11.2026), einmal geladen und
 * von allen Reitern geteilt:
 *   - Häuser (vertrieb_raeume, ganz — kurze Liste, siehe HAEUSER_MAX)
 *   - Mail-Einträge aller Häuser (Takt pro Woche, nur haus_id/datum/art)
 *   - Antworten von Häusern der letzten 14 Tage (Reiter «Heute»)
 *   - Wochenpaket-Mails, die noch nicht gesendet sind
 *   - Kampagnen-Zahlen über /api/vertrieb/uebersicht (wie Büro-Bildschirm)
 * PGRST205/42703 (Tabelle/Spalte fehlt, Migration 387 noch nicht
 * eingespielt) werden still als «leer» behandelt, damit die Seite lädt.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { plusTage, todayLocalIso } from "@/lib/swiss-time";
import { HAEUSER_MAX } from "@/lib/vertrieb/haeuser";
import type { BildschirmVertrieb } from "@/lib/bildschirm-typen";
import type { HausVerlauf, VertriebRaum, WochenpaketMail } from "@/types/vertrieb";

export const HAUS_SPALTEN =
  "id, name, ort, ansprechperson, email, telefon, website, infos, erstmail, datum, aufgabe, dokumente, "
  + "stufe, gebiet, prio, gruppe, bedarf, bedarf_beleg, bedarf_belegt, created_at, updated_at";

const PAKET_SPALTEN =
  "id, kw, haus_id, an, betreff, text, anhang_name, anhang_bucket_pfad, versand_ab, kundenblatt, pruefungen, status, freigegeben_am, eingeplant_am";

export type MailEintrag = Pick<HausVerlauf, "haus_id" | "datum" | "art">;
export type AntwortEintrag = Pick<HausVerlauf, "id" | "haus_id" | "datum" | "titel" | "text">;

/** Fehler, die nur «Migration noch nicht eingespielt» bedeuten. */
function fehltNoch(code: string | undefined): boolean {
  return code === "PGRST205" || code === "42P01" || code === "42703" || code === "PGRST204";
}

export function useVertriebDaten() {
  const [haeuser, setHaeuser] = useState<VertriebRaum[] | null>(null);
  const [mails, setMails] = useState<MailEintrag[]>([]);
  const [antworten, setAntworten] = useState<AntwortEintrag[]>([]);
  const [pakete, setPakete] = useState<WochenpaketMail[]>([]);
  const [uebersicht, setUebersicht] = useState<BildschirmVertrieb | null>(null);
  const [migrationFehlt, setMigrationFehlt] = useState(false);
  const [zuViele, setZuViele] = useState(false);

  const ladeHaeuser = useCallback(async () => {
    const supabase = createClient();
    const seit = plusTage(todayLocalIso(), -14);
    const [h, m, a, p] = await Promise.all([
      supabase.from("vertrieb_raeume").select(HAUS_SPALTEN).order("name").limit(HAEUSER_MAX),
      supabase.from("vertrieb_haus_verlauf").select("haus_id, datum, art").eq("art", "mail").limit(5000),
      supabase.from("vertrieb_haus_verlauf").select("id, haus_id, datum, titel, text").eq("art", "antwort")
        .gte("datum", seit).order("datum", { ascending: false }).limit(50),
      supabase.from("vertrieb_wochenpaket_mails").select(PAKET_SPALTEN)
        .in("status", ["offen", "freigegeben", "eingeplant"]).order("kw").order("an").limit(200),
    ]);
    if (h.error) {
      if (fehltNoch(h.error.code)) setMigrationFehlt(true);
      else toast.error(`Häuser laden fehlgeschlagen: ${h.error.message}`);
      setHaeuser([]);
    } else {
      setHaeuser((h.data ?? []) as unknown as VertriebRaum[]);
      setZuViele((h.data ?? []).length >= HAEUSER_MAX);
    }
    for (const r of [m, a, p]) {
      if (r.error && !fehltNoch(r.error.code)) toast.error(`Vertrieb laden fehlgeschlagen: ${r.error.message}`);
      if (r.error && fehltNoch(r.error.code)) setMigrationFehlt(true);
    }
    setMails((m.data ?? []) as MailEintrag[]);
    setAntworten((a.data ?? []) as AntwortEintrag[]);
    setPakete((p.data ?? []) as unknown as WochenpaketMail[]);
  }, []);

  useEffect(() => {
    // Erster Ladevorgang beim Mount; setState passiert erst nach dem await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void ladeHaeuser();
  }, [ladeHaeuser]);

  useEffect(() => {
    let aktiv = true;
    fetch("/api/vertrieb/uebersicht", { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok || !json?.success) throw new Error(json?.error ?? `HTTP ${res.status}`);
        if (aktiv) setUebersicht(json as BildschirmVertrieb);
      })
      .catch((e: unknown) => {
        if (aktiv) toast.error(`Kampagnen-Zahlen laden fehlgeschlagen: ${e instanceof Error ? e.message : "Verbindung unterbrochen"}`);
      });
    return () => { aktiv = false; };
  }, []);

  /** Lokale Änderung eines Hauses (nach erfolgreichem Speichern). */
  const aendereLokal = useCallback((id: string, patch: Partial<VertriebRaum>) => {
    setHaeuser((prev) => prev?.map((h) => (h.id === id ? { ...h, ...patch } : h)) ?? prev);
  }, []);

  return { haeuser, setHaeuser, mails, antworten, pakete, uebersicht, migrationFehlt, zuViele, neuLaden: ladeHaeuser, aendereLokal };
}
