// POST /api/flow/abwesenheiten — Abwesenheiten eines Monats für Trust flow (Migration 380).
//
// Körper: nur der Ausweis (kompaktes JWS, Content-Type application/jose),
// aud «erp-abwesenheiten», Claims jahr, monat, profile (≤ 50 ERP-Profil-IDs).
// Prüfung, Einmal-Schutz, Höchstzahl (Gruppe «abruf»), Protokoll: src/lib/flow/.
//
// Antwort (keine Namen, keine Notizen, kein Entscheid-Text):
//   { monat,
//     personen: [{ erp_profil_id, abwesenheiten: [{ id, typ, status, von, bis, ende_offen,
//       gemeldet_at, entschieden_at,
//       arztzeugnis: null | { id (= Abwesenheit), hochgeladen_at, dateiname, mime, groesse, sha256 } }] }] }
// Abwesenheiten: alle Einträge (jeder Typ und Status), die den Monat berühren — von/bis sind
// Zürcher Kalendertage (bis inklusiv). Offenes Ende (Krank «Weiss nicht»): bis = bisher bekannter
// letzter Tag, täglich nachgezogen. Die Datei selbst: POST /api/flow/arztzeugnis.
// Personen wie /stempel: jedes interne ERP-Profil aus `profile`; unbekannte IDs fallen weg.

import { flowAbruf } from "@/lib/flow/server";
import { abwesenheitenAntwort } from "@/lib/flow/daten";
import { pruefeAbwesenheitenClaims } from "@/lib/flow/regeln";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return flowAbruf(
    request,
    "erp-abwesenheiten",
    (ausweis) => pruefeAbwesenheitenClaims(ausweis.claims),
    (admin, anfrage) => abwesenheitenAntwort(admin, anfrage),
  );
}
