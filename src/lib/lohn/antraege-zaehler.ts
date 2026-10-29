// Zähler «Rechte & Lohndaten» — offene Vier-Augen-Anträge, die DIESE Person
// jetzt bestätigen kann. Nur Server, nur für Admins aufrufen (der Reiter auf
// /antraege und die Dashboard-Zeile sind Admin-only; Admins haben das Lohnrecht).
//
// Gezählt wird genau, wofür der Reiter einen «Bestätigen»-Knopf zeigt
// (darf_bestaetigen in /api/admin/rechte-antraege bzw. /api/hr/lohn-antraege,
// gleiche Regeln rechteHinderungsgrund / lohnHinderungsgrund):
//   - offen und nicht abgelaufen, nicht der eigene Antrag, nicht die eigenen
//     Rechte bzw. der eigene Lohn, nicht in «Ansicht als»;
//   - nur auf einem vertrauten Gerät (ohne Gerät gibt es nichts zu bestätigen,
//     Lohndaten-Anträge zeigt der Reiter dann gar nicht);
//   - Bereich «Rechte» in Wartung → 0 (der Reiter zeigt den Hinweis);
//     Bereich «Lohn» in Wartung → ohne Lohndaten-Anträge.
// Verwendet von /api/admin/rechte-antraege/zaehler (Reiter) und
// ladeAufmerksamkeit (Dashboard «Braucht Aufmerksamkeit»).

import type { SupabaseClient } from "@supabase/supabase-js";
import { pruefeVertrautesGeraet } from "@/lib/api-auth";
import { ladeWartung } from "@/lib/wartung-server";
import { wartungZugang } from "@/lib/wartung";
import { rechteHinderungsgrund } from "./rechte-antraege";
import { lohnHinderungsgrund } from "./aenderungen";

export interface ZaehlerBetrachter {
  /** ECHTES Konto (nicht das in «Ansicht als» angesehene). */
  ich: string;
  ansichtAls: boolean;
}

/** Wirft bei Ladefehlern — ein Zähler, der nicht laden kann, sagt nie «0». */
export async function zaehleBestaetigbareAntraege(admin: SupabaseClient, b: ZaehlerBetrachter): Promise<number> {
  if (b.ansichtAls) return 0;
  const [stand, geraet] = await Promise.all([ladeWartung(), pruefeVertrautesGeraet(b.ich)]);
  if (wartungZugang(stand, "rechte", b.ich) === "gesperrt") return 0;
  if (geraet !== "vertraut") return 0;
  const mitLohn = wartungZugang(stand, "lohn", b.ich) !== "gesperrt";

  const jetzt = new Date().toISOString();
  const [rechte, lohn] = await Promise.all([
    admin
      .from("rechte_antraege")
      .select("status, gueltig_bis, beantragt_von, gewaehrt, ziel_profile_id")
      .eq("status", "offen")
      .gt("gueltig_bis", jetzt),
    mitLohn
      ? admin
          .from("lohn_aenderungs_antraege")
          .select("status, gueltig_bis, beantragt_von, profile_id")
          .eq("status", "offen")
          .gt("gueltig_bis", jetzt)
      : null,
  ]);
  const err = rechte.error ?? lohn?.error;
  if (err) throw new Error(`Anträge konnten nicht gezählt werden: ${err.message}`);

  type RechteZeile = Parameters<typeof rechteHinderungsgrund>[0];
  type LohnZeile = Parameters<typeof lohnHinderungsgrund>[0];
  const nRechte = ((rechte.data ?? []) as RechteZeile[]).filter((a) => rechteHinderungsgrund(a, b.ich, true, false) === null).length;
  const nLohn = ((lohn?.data ?? []) as LohnZeile[]).filter((a) => lohnHinderungsgrund(a, b.ich, false) === null).length;
  return nRechte + nLohn;
}
