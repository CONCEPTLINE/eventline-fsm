-- Cleanup: Budget-Bexio-Anbindung komplett entkoppeln.
--
-- Hintergrund: Bexio's /2.0/accounting/journal-Endpoint ist mit unserem
-- OAuth-Setup nicht erreichbar (404 trotz accounting-Scope). Wir geben
-- die Ist-Anbindung an Bexio auf — Budget bleibt rein manuell + Personal-
-- Auto-Berechnung aus Stempel-Stunden.
--
-- Entfernt:
--  - budget_account_snapshot Tabelle (war Ziel der Bexio-Buchungs-
--    Aggregation, leer und ungenutzt)
--  - bexio_connection.feature_accounting Spalte (Modul-Toggle obsolet)
--
-- Behalten:
--  - budget_categories inkl. bexio_account_no-Spalten (Leo sortiert
--    manuell aus, Strukturwert bleibt)
--  - budget_entries (manuelle Soll-Werte)
--  - budget_access_log (Audit fuer Soll-Aenderungen + Trusted-Device)

drop table if exists public.budget_account_snapshot cascade;

alter table public.bexio_connection
  drop column if exists feature_accounting;
