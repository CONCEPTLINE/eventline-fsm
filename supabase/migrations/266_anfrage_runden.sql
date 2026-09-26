-- 266: Anfrage-Runden am Lieferanten-Auftrag (Audit-Punkt D).
-- "Erneut anfragen" ueberschrieb bisher nur angefragt_at — jetzt zaehlt
-- jede gesendete Anfrage hoch, damit sichtbar bleibt, in welcher Runde
-- die Planung steckt (Details je Runde stehen in job_technik_aktivitaet).

alter table public.job_lieferanten
  add column if not exists anfrage_runden int not null default 0;

-- Bestehende Zuweisungen mit gesendeter Anfrage = mindestens Runde 1.
update public.job_lieferanten set anfrage_runden = 1
  where angefragt_at is not null and anfrage_runden = 0;
