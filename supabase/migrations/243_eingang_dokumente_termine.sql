-- Eingang-Dateien landen zusaetzlich als Dokument am Auftrag; Mail-Anhaenge
-- haben keinen App-User als Uploader.
alter table public.documents alter column uploaded_by drop not null;

-- Persistente KI-Termin-Vorschlaege am Auftrag (analog ai_datum_vorschlag):
-- die KI legt NIE selbst Termine an — das Team entscheidet im Banner.
alter table public.jobs add column if not exists ai_termin_vorschlaege jsonb;
