-- 373: Getränke-Catering — Auftraggeber/in und Anlass je Auftrag (Ergänzung zu 372).
--
-- Warum: Bei Standort-Aufträgen (job_type = 'location', z. B. Theater BAU3) ist der Kunde des Auftrags der
-- Verwaltungs-Kunde des Standorts; die eigentliche Veranstalterin steht nur als Kontaktperson im Auftrag
-- (INT-26404: Standort «Theater BAU3», Kontakt Michèle Thommen). Der Vertrag braucht aber die Veranstalterin
-- mit Adresse. Darum werden Auftraggeber/in, Adresse und Anlass beim Speichern der Kalkulation mitgespeichert
-- und im Vertrag verwendet (Vorschlag im Reiter: Kontaktperson bzw. Kunde bei externen Aufträgen).
--
-- NUR additiv (B1), idempotent. RLS und Archiv-Schutz gelten aus Migration 372 unverändert.

alter table public.job_catering add column if not exists auftraggeber text;
alter table public.job_catering add column if not exists auftraggeber_adresse text;
alter table public.job_catering add column if not exists anlass text;

alter table public.job_catering drop constraint if exists job_catering_texte_check;
alter table public.job_catering add constraint job_catering_texte_check check (
  (auftraggeber is null or char_length(btrim(auftraggeber)) between 1 and 120)
  and (auftraggeber_adresse is null or char_length(auftraggeber_adresse) <= 200)
  and (anlass is null or char_length(btrim(anlass)) between 1 and 120)
);
