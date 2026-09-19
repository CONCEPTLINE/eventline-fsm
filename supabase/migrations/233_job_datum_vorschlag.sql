-- 233_job_datum_vorschlag.sql
-- KI-Datumsvorschlag PERSISTENT statt fluechtigem Dialog (Leo 2026-09-19:
-- "ich habe kein popup bekommen"): der Vorschlag lebt am Auftrag, bis ein
-- Mensch ihn auf der Uebersicht bestaetigt (Umdatieren) oder verwirft.
-- Shape: { start_datum, end_datum, grund, item_id, created_at }
-- Schreiben: Service-Role (KI-Route) bzw. jobs-UPDATE-RLS (Entscheidung).
-- Idempotent.

alter table public.jobs add column if not exists ai_datum_vorschlag jsonb;

comment on column public.jobs.ai_datum_vorschlag is
  'Offener KI-Vorschlag fuer neues Event-Datum ({start_datum,end_datum,grund,item_id,created_at}); null = keiner. Wird NIE automatisch angewendet.';
