-- Duplikat-Schutz fuer Mail-Anhaenge UEBER Mails hinweg: dieselbe Datei
-- (gleicher Inhalt) wird pro Auftrag nur einmal abgelegt. SHA1 des
-- Datei-Inhalts, beim Ablegen im Webhook gesetzt.
alter table public.job_inbox_items add column if not exists inhalt_hash text;
create index if not exists job_inbox_items_hash_idx
  on public.job_inbox_items (job_id, inhalt_hash) where inhalt_hash is not null;
