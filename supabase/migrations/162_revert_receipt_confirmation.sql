-- Revert von 161: received_confirmed_at war ein Missverstaendnis.
-- Der Nutzer braucht stattdessen eine sichtbare Anzeige der bereits
-- existierenden Einwilligung (profiles.lohndokumente_digital_accepted_*).
-- Spalte raus damit kein toter Datensatz im Hintergrund bleibt.

alter table public.wage_documents
  drop column if exists received_confirmed_at;
