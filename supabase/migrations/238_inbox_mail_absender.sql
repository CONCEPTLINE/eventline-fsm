-- 238_inbox_mail_absender.sql
-- Auftrag-Eingang per E-Mail (auftrag@in.eventline-basel.com): weiter-
-- geleitete Mails landen via Resend-Webhook direkt im Eingang des
-- passenden Auftrags. Solche Elemente haben keinen App-User als Ersteller
-- (created_by wird nullable) und tragen stattdessen den Mail-Absender.
-- Idempotent.

alter table public.job_inbox_items alter column created_by drop not null;
alter table public.job_inbox_items add column if not exists absender text;

comment on column public.job_inbox_items.absender is
  'Mail-Absender bei per E-Mail eingegangenen Elementen (created_by ist dann NULL).';
