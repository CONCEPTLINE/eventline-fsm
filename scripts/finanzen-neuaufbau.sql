-- Finanzen: Bexio-Spiegel komplett neu aufbauen (Welle 1).
--
-- Bexio ist die Quelle der Wahrheit — der Spiegel im Schema `finanzen` darf
-- jederzeit geleert und neu geladen werden. Dieses Skript wird BEWUSST von
-- Hand eingespielt (Integrator/Mischa), nie automatisch:
--   node scripts/apply-migration.mjs scripts/finanzen-neuaufbau.sql
-- oder
--   node scripts/sql-once.mjs "$(cat scripts/finanzen-neuaufbau.sql)"
--
-- Danach POST /api/finanzen/sync mit { voll: true } (Button «Alles neu laden»
-- gibt es nicht — bewusst nur per API/Skript). Ein nacktes truncate reicht
-- NICHT: das Wasserzeichen in finanzen.sync_stand bliebe stehen, und alle
-- Objekte vor dem Wasserzeichen fehlten dauerhaft im Spiegel.
--
-- NICHT angefasst: finanzen.zugriffe (Lese-Protokoll, append-only),
-- finanzen.digest_versand (Versand-Nachweis), finanzen.sync_laeufe (Historie).
-- rechnung_zahlungen, mahnungen und lieferanten_zahlungen haengen per
-- on delete cascade an rechnungen bzw. lieferantenrechnungen — `cascade`
-- raeumt sie mit ab.

truncate
  finanzen.rechnungen,
  finanzen.offerten,
  finanzen.kontakte,
  finanzen.waehrungen,
  finanzen.lieferantenrechnungen,
  finanzen.journal_buchungen,
  finanzen.konten,
  finanzen.kontengruppen,
  finanzen.bankkonten
cascade;

update finanzen.sync_stand
set wasserzeichen = null,
    letzter_erfolg = null,
    hinweis = null,
    verfuegbar = true,
    updated_at = now();
