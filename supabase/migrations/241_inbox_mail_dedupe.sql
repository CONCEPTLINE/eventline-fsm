-- 241_inbox_mail_dedupe.sql
-- Resend wiederholt Webhooks bei Timeouts — ohne Idempotenz landen
-- dieselben Mails mehrfach im Eingang (Vorfall INT-26309, 3x identisch).
-- resend_email_id macht den Webhook idempotent.
alter table public.job_inbox_items add column if not exists resend_email_id text;
create index if not exists jii_resend_idx on public.job_inbox_items (resend_email_id) where resend_email_id is not null;
