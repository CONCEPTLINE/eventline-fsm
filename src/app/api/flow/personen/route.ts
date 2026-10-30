// POST /api/flow/personen — Mitarbeitende (ERP-Profil-ID + Name) für die
// Zuordnung in Trust flow («Personal bearbeiten» wählt erp_profil_id aus einer
// Liste statt eine UUID abzutippen). A1, aud «erp-personen».
//
// Körper: nur der Ausweis (kompaktes JWS). Antwort: { personen: [{ erp_profil_id, name, aktiv }] }
// (internes Konto — keine Partner-/Lieferanten-Zugänge): alle aktiven, dazu inaktive mit einer
// ERP-Anstellung, deren Austritt offen oder ≥ 2026-12-01 ist (aktiv: false). Ablauf: src/lib/flow/.

import { flowAbruf } from "@/lib/flow/server";
import { personenAntwort } from "@/lib/flow/daten";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return flowAbruf(
    request,
    "erp-personen",
    () => ({ ok: true, anfrage: null }),
    (admin) => personenAntwort(admin),
  );
}
