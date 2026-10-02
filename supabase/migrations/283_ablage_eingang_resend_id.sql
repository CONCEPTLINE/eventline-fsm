-- 283: Idempotenz fuer Ablage-Mails — Resend wiederholt Webhooks bei
-- Timeouts; dieselbe Mail darf den Ablage-Eingang nur einmal fuellen.
alter table ablage_eingang
  add column if not exists resend_email_id text;
create index if not exists ablage_eingang_resend
  on ablage_eingang (resend_email_id) where resend_email_id is not null;
