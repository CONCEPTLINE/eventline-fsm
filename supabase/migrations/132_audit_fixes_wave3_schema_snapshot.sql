-- Audit Wave 3: form_schema_snapshot auf jobs.
--
-- Problem: Partner submitet eine Anfrage mit Schema-Version A. Admin
-- publisht waehrenddessen Schema-Version B. Office-View laedt B fuer
-- den Lookup → Block-Labels stimmen nicht mehr; Antworten unter alten
-- IDs werden als "(Feld geloescht)" markiert.
--
-- Fix: beim Submit das aktuelle Schema als Snapshot mit dem Job
-- mitspeichern. Office-View nutzt diesen Snapshot fuer den Label-Lookup
-- statt das aktuelle Live-Schema → stabile Darstellung egal was der
-- Admin spaeter aendert.

alter table public.jobs
  add column if not exists form_schema_snapshot jsonb;
