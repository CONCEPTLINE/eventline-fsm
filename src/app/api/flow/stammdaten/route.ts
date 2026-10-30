// POST /api/flow/stammdaten — Stammdaten je Person für den Import in Trust flow (A6, aud «flow-stammdaten»).
//
// Körper: nur der Ausweis (kompaktes JWS, Content-Type application/jose), Claims wie A1, aber nur
// profile (≤ 50 ERP-Profil-IDs); jahr/monat/von/bis dürfen fehlen und werden ignoriert. Einmal-Schutz,
// Höchstzahl (Gruppe «Abruf», 10/Min. zusammen mit Stempel/Personen/Vergleich), Protokoll: src/lib/flow/.
// Vertrag: supabase/lokal/live-gang-a6/VERTRAG.md.
//
// Antwort (Form wie der Import in Trust flow): { personen: [{ erp_profil_id, name, vorname, geburtsdatum,
//   anstellungen: [{ firma, eintritt, austritt, vertragsart: "stundenlohn" | "monatslohn" | null }],
//   lohnzeilen: [{ gueltig_ab, ansatz, standard, quellensteuer_pct, nbu_pct, bvg_pct (nur bei standard=false
//                  befüllt, sonst null), ansatz_art: "inkl_ferien", ferien_pct (festes Ferien-% oder null) }] }] }
// Personen: jedes interne ERP-Profil aus `profile` (auch ausgetretene/inaktive); Partner-/Lieferanten-Zugänge
// und unbekannte IDs fallen weg (wie /stempel). Keine AHV-Nr., IBAN, Adresse, übrige Sätze, Arbeitgebersätze, Notizen.

import { flowAbruf } from "@/lib/flow/server";
import { stammdatenAntwort } from "@/lib/flow/daten";
import { pruefeStammdatenClaims } from "@/lib/flow/regeln";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return flowAbruf(
    request,
    "flow-stammdaten",
    (ausweis) => pruefeStammdatenClaims(ausweis.claims),
    (admin, anfrage) => stammdatenAntwort(admin, anfrage),
  );
}
