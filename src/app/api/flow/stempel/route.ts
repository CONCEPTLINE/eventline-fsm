// POST /api/flow/stempel — Stempel eines Lohnmonats für Trust flow (A1).
//
// Körper: nur der Ausweis (kompaktes JWS, Content-Type application/jose),
// aud «erp-stempel», Claims jahr, monat, von/bis (= stempelBereich() des Kerns),
// profile (≤ 50 ERP-Profil-IDs). Prüfung, Einmal-Schutz, Höchstzahl, Protokoll:
// src/lib/flow/ (Vertrag: _backoffice-uebergabe/10_Schnittstelle_Stunden.md).
//
// Antwort (keine Namen, keine Stempel-IDs):
//   { monat_gesperrt,
//     personen: [{ erp_profil_id, stempel: [{ start, ende }], probleme: { offen, ueberlappend, lang_ungeprueft } }],
//     nachtraeglich_geaendert: [{ erp_profil_id, monat, geaendert_at }] }
// Personen: jedes interne ERP-Profil aus `profile` (auch ausgetretene; Trust flow bestimmt die Liste aus
// seinen Anstellungen). Partner-/Lieferanten-Zugänge und unbekannte IDs fallen weg.

import { flowAbruf } from "@/lib/flow/server";
import { stempelAntwort } from "@/lib/flow/daten";
import { pruefeMonatsClaims } from "@/lib/flow/regeln";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return flowAbruf(
    request,
    "erp-stempel",
    (ausweis) => pruefeMonatsClaims(ausweis.claims, { bereich: true }),
    (admin, anfrage) => stempelAntwort(admin, anfrage),
  );
}
