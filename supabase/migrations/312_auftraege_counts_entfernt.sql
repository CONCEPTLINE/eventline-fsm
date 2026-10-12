-- Migration 312: Auftragszaehler komplett entfernt (Datenbank-Teil).
--
-- Auftrag Leo/Mischa 2026-10-12: «entferne auftragszähler, das bringt nichts».
-- Der Code (Commit 8c4e88bb, live) liest die Zaehlertabelle nicht mehr, und
-- der Cron /api/cron/refresh-counts ist geloescht. Erst danach — wie in der
-- Projektregel verlangt — verschwinden hier die Datenbank-Objekte aus 255:
--   * Funktion public.refresh_dashboard_counts() (einziger Nutzer der Tabelle)
--   * Materialized View public.auftraege_counts
-- Vorher live geprueft (read-only, 2026-10-12): keine abhaengigen Views,
-- keine weitere Funktion, kein pg_cron-Job (Erweiterung nicht installiert).
--
-- Idempotent: drop … if exists.
-- EINGESPIELT 2026-10-12 (Mobile-Session).

drop function if exists public.refresh_dashboard_counts();
drop materialized view if exists public.auftraege_counts;
