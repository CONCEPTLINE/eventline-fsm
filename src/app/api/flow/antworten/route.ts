// POST /api/flow/antworten — Antworten aus «Fragen an dich» für Trust flow (Migration 376).
//
// Körper: nur der Ausweis (kompaktes JWS, Content-Type application/jose), aud «erp-antworten»,
// Claims profil_ids (1–500 ERP-Profil-IDs) und fragen (Schlüssel aus src/lib/fragen/katalog.ts,
// z. B. ["ahv_geringfuegig"]). Prüfung, Einmal-Schutz (jti), Höchstzahl (Gruppe «abruf», 10/Min.),
// Wartung «lohn», Protokoll in flow_abrufe: src/lib/flow/ (wie /api/flow/stempel).
//
// Antwort 200 (keine Namen, keine anderen Daten):
//   { v: 1, antworten: [{ profil_id, frage, antwort, text_version, beantwortet_am (ISO-UTC) }] }
// Je Person und Frage nur die neueste Antwort; Personen/Fragen ohne Antwort fehlen.
// Fehler: 401 ausweis_ungueltig, 400 (Claims), 409 ausweis_verwendet, 413 zu_gross,
// 429 zu_viele (Retry-After), 503 nicht_eingerichtet | wartung, 500 fehler.

import { flowAbruf } from "@/lib/flow/server";
import { antwortenAntwort } from "@/lib/flow/daten";
import { pruefeAntwortenClaims } from "@/lib/flow/regeln";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return flowAbruf(
    request,
    "erp-antworten",
    (ausweis) => pruefeAntwortenClaims(ausweis.claims),
    (admin, anfrage) => antwortenAntwort(admin, anfrage),
  );
}
