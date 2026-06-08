-- "Rechnung nicht gestellt"-Flag fuer Auftraege.
--
-- Use-Case: Auftrag ist abgeschlossen, aber aus Gruenden (Garantie,
-- Kulanz, intern, Doppel-Erfassung etc.) wird KEINE Rechnung gestellt.
-- Vorher landeten solche Jobs ewig in der Abrechnungs-Liste rum.
--
-- Semantisch GETRENNT von invoiced_at — ein Job ist entweder
--   (a) noch offen: invoiced_at IS NULL AND invoice_skipped_at IS NULL
--   (b) abgerechnet: invoiced_at IS NOT NULL
--   (c) bewusst nicht abgerechnet: invoice_skipped_at IS NOT NULL
--
-- (b) und (c) sind exklusiv per CHECK damit ein Job nicht gleichzeitig
-- "abgerechnet" und "nicht zu stellen" markiert wird.

alter table public.jobs
  add column if not exists invoice_skipped_at timestamptz,
  add column if not exists invoice_skipped_reason text,
  add column if not exists invoice_skipped_by uuid references public.profiles(id) on delete set null;

-- Exklusivitaet: nicht beide gleichzeitig.
alter table public.jobs
  drop constraint if exists jobs_invoice_state_exclusive;
alter table public.jobs
  add constraint jobs_invoice_state_exclusive
  check (invoiced_at is null or invoice_skipped_at is null);

-- Reason ist Pflicht wenn skipped_at gesetzt ist (UI erzwingt es
-- bereits, DB als Sicherheits-Netz).
alter table public.jobs
  drop constraint if exists jobs_invoice_skipped_needs_reason;
alter table public.jobs
  add constraint jobs_invoice_skipped_needs_reason
  check (invoice_skipped_at is null or (invoice_skipped_reason is not null and length(trim(invoice_skipped_reason)) > 0));

-- Index fuer Abrechnungs-Liste (filtert auf beide Spalten gleichzeitig).
create index if not exists jobs_unbilled_idx
  on public.jobs (status, invoiced_at, invoice_skipped_at)
  where is_deleted = false;
