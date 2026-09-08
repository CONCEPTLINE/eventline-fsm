-- 228_drop_job_offer_analysis.sql
-- ============================================================
-- Offerten-Gewinn-Feature komplett entfernt (Leo 2026-09-08:
-- "baue das feature doch nicht, loesche allen toten code dazu").
--
-- Die Cache-Tabelle aus Migration 226 (KI-analysierte Offerten-
-- Arbeitspositionen) wird ersatzlos gedroppt. Die Kosten-Prognose-
-- Pill (job-costs.ts / /api/admin/job-costs) bleibt — sie braucht
-- keine Tabelle.
-- ============================================================

drop table if exists public.job_offer_analysis cascade;
