-- 349_auftrag_mails.sql — Protokoll + Wartebereich fuer Mails an
-- auftrag@in.eventline-basel.com (Resend-Webhook /api/inbound/mail).
--
-- Vorher: Mails ohne Auftragsnummer, die auch die KI nicht eindeutig
-- zuordnen konnte, erzeugten nur eine Glocke «… konnte nicht zugeordnet
-- werden» — Inhalt und Anhaenge lagen danach nirgends in der App, Leo
-- musste die Mail mit Nummer neu weiterleiten.
--
-- Jetzt bekommt JEDE eingehende Auftrags-Mail genau eine Zeile:
--  - resend_email_id UNIQUE = Idempotenz (Webhook-Wiederholungen erzeugen
--    weder doppelte Eingang-Elemente noch doppelte Mitteilungen).
--  - message_id / referenzen (In-Reply-To + References) / konversation
--    (Outlook Thread-Index) / betreff_norm = Verlauf erkennen: Folgemails
--    eines Verlaufs landen automatisch im Auftrag, dem der Verlauf schon
--    zugeordnet ist.
--  - status 'wartet' = nicht zuordenbar; inhalt + anhaenge (Bucket
--    auftrag-mails) bleiben erhalten, bis ein Admin unter /auftraege/mails
--    den Auftrag waehlt (oder die Mail verwirft). Danach werden inhalt und
--    die Dateien im Bucket wieder geleert (Inhalt liegt dann im Eingang).
--  - status 'eingang' = Webhook arbeitet gerade (Sperre gegen parallele
--    Wiederholungen; nach 10 Min. darf eine Wiederholung uebernehmen).
--
-- Rechte: LESEN nur interne Konten mit auftraege:see-all (Admin immer).
-- Schreiben ausschliesslich serverseitig (Service-Rolle in Webhook und
-- /api/auftrag-mails) — authenticated hat kein INSERT/UPDATE/DELETE,
-- anon gar nichts. Bucket auftrag-mails privat, ohne Policies (nur
-- Service-Rolle; Anzeige ueber signierte URLs der API).
--
-- Einspielen: node scripts/apply-migration.mjs supabase/migrations/349_auftrag_mails.sql
-- Idempotent.

create table if not exists public.auftrag_mails (
  id uuid primary key default gen_random_uuid(),
  resend_email_id text not null,
  status text not null default 'eingang'
    check (status in ('eingang', 'wartet', 'zugeordnet', 'verworfen')),
  job_id uuid references public.jobs(id) on delete set null,
  zuordnung text check (zuordnung in ('nummer', 'verlauf', 'ki', 'manuell')),
  absender text,
  betreff text,
  betreff_norm text,
  message_id text,
  referenzen text[] not null default '{}',
  konversation text,
  inhalt text,
  anhaenge jsonb not null default '[]'::jsonb,
  vorschlaege jsonb not null default '[]'::jsonb,
  empfangen_am timestamptz not null default now(),
  erledigt_von uuid references public.profiles(id) on delete set null,
  erledigt_am timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.auftrag_mails is
  'Jede Mail an auftrag@in.…: Idempotenz (resend_email_id), Verlauf (message_id/referenzen/konversation/betreff_norm), Wartebereich (status wartet).';

create unique index if not exists auftrag_mails_resend_uidx on public.auftrag_mails (resend_email_id);
create index if not exists auftrag_mails_message_idx on public.auftrag_mails (message_id) where message_id is not null;
create index if not exists auftrag_mails_konversation_idx on public.auftrag_mails (konversation) where konversation is not null;
create index if not exists auftrag_mails_betreff_idx on public.auftrag_mails (betreff_norm, empfangen_am desc) where job_id is not null;
create index if not exists auftrag_mails_wartet_idx on public.auftrag_mails (empfangen_am desc) where status = 'wartet';
create index if not exists auftrag_mails_job_idx on public.auftrag_mails (job_id) where job_id is not null;

alter table public.auftrag_mails enable row level security;

-- SELECT: interne Konten mit auftraege:see-all (has_permission: Admin immer).
drop policy if exists auftrag_mails_select on public.auftrag_mails;
create policy auftrag_mails_select on public.auftrag_mails
  for select to authenticated
  using ((select public.is_internal_user()) and (select public.has_permission('auftraege:see-all')));

-- INSERT/UPDATE/DELETE: keine Policy fuer authenticated = verboten; die
-- Rechte zusaetzlich auf Tabellenebene entziehen (doppelt haelt besser).
revoke all on public.auftrag_mails from anon;
revoke insert, update, delete, truncate, references, trigger on public.auftrag_mails from authenticated;
grant select on public.auftrag_mails to authenticated;

-- Privater Bucket fuer Anhaenge wartender Mails (nur Service-Rolle).
insert into storage.buckets (id, name, public)
values ('auftrag-mails', 'auftrag-mails', false)
on conflict (id) do nothing;
