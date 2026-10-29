// Zustellung von Lohnabrechnungen an die Mitarbeitenden (Lohn-Umbau Phase 4).
//
// VERTRAG (von src/lib/lohn/abrechnung.ts nach jeder neuen Fassung aufgerufen):
//   meldeNeueAbrechnung(admin, { profileId, jahr, monat, wageDocumentId, art })
//   - hält in lohn_dokument_zustellung «bereitgestellt» fest (+ aktuelle Wahl digital/Papier)
//   - meldet der Person über den Benachrichtigungsdienst, dass eine neue Abrechnung
//     bereitliegt (Mail OHNE Beträge)
//   - wirft NIE (Fehler nur loggen) — die Abrechnung ist zu diesem Zeitpunkt gespeichert.
//
// TODO Phase 4 (Bereich Monatsabschluss): Umsetzung.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface NeueAbrechnung {
  profileId: string;
  jahr: number;
  monat: number;
  wageDocumentId: string;
  art: "regulaer" | "korrektur";
}

export async function meldeNeueAbrechnung(_admin: SupabaseClient, _a: NeueAbrechnung): Promise<void> {
  // Platzhalter — wird im Bereich Monatsabschluss umgesetzt.
}
