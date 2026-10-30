// POST /api/flow/vergleich — ERP-Momentaufnahme je Person für den Rappen-Vergleich
// im Parallelmonat (A1, aud «erp-vergleich»). Nur Lohnmonate bis und mit 2026-11:
// danach rechnet das ERP nicht mehr (lohn_einstellungen.lauf_bis).
//
// Körper: nur der Ausweis (kompaktes JWS), Claims jahr, monat, profile (≤ 50).
// Antwort: { monat, monat_gesperrt, personen: [{ erp_profil_id, momentaufnahme: null | {
//   fassung, art, kern_version, pruefsumme, auszahlungsdatum, brutto,
//   positionen: [{ lohnart, minuten, betrag }], ahv_lohn, alv_lohn, uvg_lohn, uvg_art,
//   nbu: { versichert, massgebend }, bisher: { ahv_lohn, alv_lohn, uvg_lohn } } }] }
// Keine Namen, keine Bezeichnungen, keine IDs ausser der ERP-Profil-ID. Personen: aus `profile` jene mit
// Lohn-Anstellung im ERP, die den Stempel-Bereich berührt (wie die ERP-Abrechnung bis November).

import { flowAbruf } from "@/lib/flow/server";
import { vergleichAntwort } from "@/lib/flow/daten";
import { pruefeMonatsClaims, VERGLEICH_BIS } from "@/lib/flow/regeln";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return flowAbruf(
    request,
    "erp-vergleich",
    (ausweis) => pruefeMonatsClaims(ausweis.claims, { bereich: false, bis: VERGLEICH_BIS }),
    (admin, anfrage) => vergleichAntwort(admin, anfrage),
  );
}
