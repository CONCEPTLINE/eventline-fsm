-- 267: Partner darf bestaetigte Anfragen aendern (Vorfall Barakuba
-- 2026-09: Zeiten aenderten sich, Partner konnte die bestaetigte Anfrage
-- nicht bearbeiten, Mail ging unter, Techniker kam zu spaet).
--
-- jobs.partner_aenderung (jsonb, null = keine offene Aenderung):
--   {
--     von_status: 'offen',            -- wohin "Aenderung bestaetigen" zurueckfuehrt
--     vorher: { title, description, start_date, end_date,
--               contact_person, contact_phone, contact_email },
--     termine_vorher: [{ title, start_time, end_time }],
--     eingereicht_at, eingereicht_von  -- Anzeige im internen Banner
--   }
-- Snapshot dient dem Vorher/Nachher-Diff im Firmenportal; nach
-- "Aenderung bestaetigen" wird das Feld geleert.

alter table public.jobs add column if not exists partner_aenderung jsonb;
