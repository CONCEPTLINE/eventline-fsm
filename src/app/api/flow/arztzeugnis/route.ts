// POST /api/flow/arztzeugnis — Datei eines Arztzeugnisses für Trust flow (Migration 380).
//
// Körper: nur der Ausweis (kompaktes JWS, Content-Type application/jose),
// aud «erp-arztzeugnis», Claim time_off_id (ID der Abwesenheit aus /api/flow/abwesenheiten).
// Prüfung, Einmal-Schutz, Höchstzahl (Gruppe «abruf»), Protokoll: src/lib/flow/.
//
// Antwort: { ok: true, mime, dateiname, sha256, groesse, datei_base64 } (Datei ≤ 10 MB, Bucket
// «arztzeugnisse»). 404 abwesenheit_unbekannt | kein_arztzeugnis.
// Die erste erfolgreiche Übergabe steht in time_off.arztzeugnis_an_flow_at (einmal je Datei).
// Gelöscht wird nichts (Lösch-Regel nach Übergabe noch offen).

import { flowAbruf } from "@/lib/flow/server";
import { arztzeugnisAntwort } from "@/lib/flow/daten";
import { pruefeArztzeugnisClaims } from "@/lib/flow/regeln";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return flowAbruf(
    request,
    "erp-arztzeugnis",
    (ausweis) => pruefeArztzeugnisClaims(ausweis.claims),
    (admin, anfrage) => arztzeugnisAntwort(admin, anfrage),
  );
}
