-- 224_drop_maintenance_tasks.sql
-- ============================================================
-- Feature "Instandhaltung / Wartungs-Tasks pro Standort" wurde nie
-- produktiv genutzt (Standortdetail hatte eine Section, aber es
-- entstanden keine Auftraege daraus — echte Aufgaben laufen ueber
-- Auftraege mit Datum + Verantwortung).
--
-- Diese Migration entfernt maintenance_tasks komplett:
--   - Foreign-Key von jobs.from_maintenance_task_id (falls existiert)
--     wird gedropped, damit die Tabelle problemlos wegkann.
--   - Tabelle mit CASCADE — nimmt evtl. abhaengige RLS-Policies,
--     Triggers, Indices mit.
--
-- Storage-Bereinigung (maintenance/* im documents-Bucket) laeuft
-- separat als manueller Purge — SQL-Migrationen fassen Storage nicht an.
-- ============================================================

drop table if exists public.maintenance_tasks cascade;
