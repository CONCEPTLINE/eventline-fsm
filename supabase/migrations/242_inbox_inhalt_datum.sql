-- 242_inbox_inhalt_datum.sql
-- Sendedatum des INHALTS (KI-extrahiert, z.B. aus 'Sent:'-Zeilen eines
-- weitergeleiteten Verlaufs) — damit die Zusammenfassung den NEUSTEN
-- Stand abbildet, auch wenn Mails in beliebiger Reihenfolge eintreffen.
alter table public.job_inbox_items add column if not exists inhalt_datum timestamptz;
