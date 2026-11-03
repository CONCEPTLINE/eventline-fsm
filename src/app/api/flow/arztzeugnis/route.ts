// POST /api/flow/arztzeugnis — Datei eines Arztzeugnisses für Trust flow (Migration 380).
//
// Körper: nur der Ausweis (kompaktes JWS, Content-Type application/jose),
// aud «erp-arztzeugnis», Claim time_off_id (ID der Abwesenheit aus /api/flow/abwesenheiten).
// Prüfung, Einmal-Schutz, Höchstzahl (Gruppe «abruf»), Protokoll: src/lib/flow/.
//
// Antwort: { ok: true, mime, dateiname, sha256, groesse, url, gueltig_bis } — url = signierter Link
// (60 s) auf die Datei im Bucket «arztzeugnisse» (≤ 10 MB). Nicht im Körper, weil Vercel nur ~4,5 MB
// Antwort annimmt; Trust flow lädt die Datei selbst und prüft die sha256. Vor dem Ausstellen prüft das
// ERP die Datei gegen die beim Hochladen gespeicherte sha256 (weicht sie ab → 500, kein Link).
// 404 abwesenheit_unbekannt | kein_arztzeugnis.
// 410 arztzeugnis_geloescht { an_flow_at } — an Trust flow übergeben und 30 Tage danach im ERP gelöscht
//     (ARZTZEUGNIS_LOESCHEN_NACH_TAGEN, lib/krank; Cron krank-tagesabschluss). Trust flow hat die Datei.
// Die erste Übergabe (Link ausgestellt) steht in time_off.arztzeugnis_an_flow_at (einmal je Datei;
// ein neues Zeugnis setzt sie zurück und wird wieder abgeholt).

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
