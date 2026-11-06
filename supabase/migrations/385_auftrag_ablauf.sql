-- 385_auftrag_ablauf.sql — Vermietungs-Ablauf (Etappe 2 Barakuba, docs/barakuba/VERTRAG-ABLAUF.md)
--
-- Eine Vermietung ist ein NORMALER Location-Auftrag. Allein eine Zeile in auftrag_ablauf schaltet
-- die Ablauf-Ansicht ein (5 Schritte: Anfrage & Konditionen · Bestätigung · Vertrag & Pollerformular ·
-- Vertrag unterschrieben · Übergabe erfolgt). Mails an auftrag@ setzen Schritte (KI-Einordnung),
-- jede Wirkung ist ein Ereignis mit «Rückgängig» (Spalte wirkung = was genau geändert wurde).
--
-- Rechte: intern wie Aufträge — lesen auftraege:view, schreiben auftraege:edit, jeweils nur für
-- Aufträge, die das Konto per RLS sehen darf (exists auf jobs). Partner: keine Policy.
-- anon: alles entzogen. Webhook schreibt mit der Service-Rolle.
--
-- auftrag_mails += cc (Erkennung + Anzeige); zuordnung += 'ablauf' (Auftrag aus Mail neu angelegt).
--
-- Einspielen: node scripts/apply-migration.mjs supabase/migrations/385_auftrag_ablauf.sql
-- Idempotent und nur additiv.

-- 1) Ablauf je Auftrag (1:1)
create table if not exists public.auftrag_ablauf (
  job_id uuid primary key references public.jobs(id) on delete cascade,
  schritt smallint not null default 1 check (schritt between 1 and 5),
  erledigt smallint[] not null default '{}',
  felder jsonb not null default '{}'::jsonb,
  fixiert_am timestamptz null,
  unterschrieben_am timestamptz null,
  uebergabe_person_id uuid null references public.profiles(id) on delete set null,
  uebergabe_start timestamptz null,
  vertrag_dokument_id uuid null references public.documents(id) on delete set null,
  abgeschlossen_am timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'auftrag_ablauf_erledigt_check') then
    alter table public.auftrag_ablauf
      add constraint auftrag_ablauf_erledigt_check check (erledigt <@ array[1,2,3,4,5]::smallint[]);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'auftrag_ablauf_felder_object') then
    alter table public.auftrag_ablauf
      add constraint auftrag_ablauf_felder_object check (jsonb_typeof(felder) = 'object');
  end if;
end $$;

comment on table public.auftrag_ablauf is
  'Vermietungs-Ablauf je Auftrag (Etappe 2). Vorhandensein = Ablauf-Ansicht. felder = AblaufFelder (+ _quelle: Herkunft je Feld).';

drop trigger if exists auftrag_ablauf_updated_at on public.auftrag_ablauf;
create trigger auftrag_ablauf_updated_at
  before update on public.auftrag_ablauf
  for each row execute function public.update_updated_at();

-- 2) Ereignisse (Verlauf + Rückgängig)
create table if not exists public.auftrag_ablauf_ereignisse (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  zeit timestamptz not null default now(),
  text text not null check (char_length(text) <= 1000),
  schritt smallint null check (schritt between 1 and 5),
  quelle text not null check (quelle in ('mail', 'manuell', 'system')),
  auftrag_mail_id uuid null references public.auftrag_mails(id) on delete set null,
  wirkung jsonb null,
  rueckgaengig_am timestamptz null,
  erstellt_von uuid null references public.profiles(id) on delete set null
);

create index if not exists auftrag_ablauf_ereignisse_job_idx
  on public.auftrag_ablauf_ereignisse (job_id, zeit desc);
create index if not exists auftrag_ablauf_ereignisse_mail_idx
  on public.auftrag_ablauf_ereignisse (auftrag_mail_id) where auftrag_mail_id is not null;

-- 3) RLS (alle vier Verben, nur interne Konten; Admin über has_permission)
alter table public.auftrag_ablauf enable row level security;
alter table public.auftrag_ablauf_ereignisse enable row level security;

drop policy if exists auftrag_ablauf_select on public.auftrag_ablauf;
create policy auftrag_ablauf_select on public.auftrag_ablauf
  for select to authenticated using (
    (select public.is_internal_user())
    and (select public.has_permission('auftraege:view'))
    and exists (select 1 from public.jobs j where j.id = auftrag_ablauf.job_id)
  );

drop policy if exists auftrag_ablauf_insert on public.auftrag_ablauf;
create policy auftrag_ablauf_insert on public.auftrag_ablauf
  for insert to authenticated with check (
    (select public.is_internal_user())
    and (select public.has_permission('auftraege:edit'))
    and exists (select 1 from public.jobs j where j.id = auftrag_ablauf.job_id)
  );

drop policy if exists auftrag_ablauf_update on public.auftrag_ablauf;
create policy auftrag_ablauf_update on public.auftrag_ablauf
  for update to authenticated using (
    (select public.is_internal_user())
    and (select public.has_permission('auftraege:edit'))
    and exists (select 1 from public.jobs j where j.id = auftrag_ablauf.job_id)
  ) with check (
    (select public.is_internal_user())
    and (select public.has_permission('auftraege:edit'))
    and exists (select 1 from public.jobs j where j.id = auftrag_ablauf.job_id)
  );

drop policy if exists auftrag_ablauf_delete on public.auftrag_ablauf;
create policy auftrag_ablauf_delete on public.auftrag_ablauf
  for delete to authenticated using (
    (select public.is_internal_user())
    and (select public.has_permission('auftraege:edit'))
    and exists (select 1 from public.jobs j where j.id = auftrag_ablauf.job_id)
  );

drop policy if exists auftrag_ablauf_ereignisse_select on public.auftrag_ablauf_ereignisse;
create policy auftrag_ablauf_ereignisse_select on public.auftrag_ablauf_ereignisse
  for select to authenticated using (
    (select public.is_internal_user())
    and (select public.has_permission('auftraege:view'))
    and exists (select 1 from public.jobs j where j.id = auftrag_ablauf_ereignisse.job_id)
  );

drop policy if exists auftrag_ablauf_ereignisse_insert on public.auftrag_ablauf_ereignisse;
create policy auftrag_ablauf_ereignisse_insert on public.auftrag_ablauf_ereignisse
  for insert to authenticated with check (
    (select public.is_internal_user())
    and (select public.has_permission('auftraege:edit'))
    and exists (select 1 from public.jobs j where j.id = auftrag_ablauf_ereignisse.job_id)
  );

drop policy if exists auftrag_ablauf_ereignisse_update on public.auftrag_ablauf_ereignisse;
create policy auftrag_ablauf_ereignisse_update on public.auftrag_ablauf_ereignisse
  for update to authenticated using (
    (select public.is_internal_user())
    and (select public.has_permission('auftraege:edit'))
    and exists (select 1 from public.jobs j where j.id = auftrag_ablauf_ereignisse.job_id)
  ) with check (
    (select public.is_internal_user())
    and (select public.has_permission('auftraege:edit'))
    and exists (select 1 from public.jobs j where j.id = auftrag_ablauf_ereignisse.job_id)
  );

drop policy if exists auftrag_ablauf_ereignisse_delete on public.auftrag_ablauf_ereignisse;
create policy auftrag_ablauf_ereignisse_delete on public.auftrag_ablauf_ereignisse
  for delete to authenticated using (
    (select public.is_internal_user())
    and (select public.has_permission('auftraege:edit'))
    and exists (select 1 from public.jobs j where j.id = auftrag_ablauf_ereignisse.job_id)
  );

revoke all on public.auftrag_ablauf from anon;
revoke all on public.auftrag_ablauf_ereignisse from anon;
revoke truncate, references, trigger on public.auftrag_ablauf from authenticated;
revoke truncate, references, trigger on public.auftrag_ablauf_ereignisse from authenticated;
grant select, insert, update, delete on public.auftrag_ablauf to authenticated;
grant select, insert, update, delete on public.auftrag_ablauf_ereignisse to authenticated;

-- 4) auftrag_mails: CC + Zuordnung 'ablauf'
alter table public.auftrag_mails add column if not exists cc text[] null;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'auftrag_mails_zuordnung_check'
      and pg_get_constraintdef(oid) not like '%ablauf%'
  ) then
    alter table public.auftrag_mails drop constraint auftrag_mails_zuordnung_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'auftrag_mails_zuordnung_check') then
    alter table public.auftrag_mails add constraint auftrag_mails_zuordnung_check
      check (zuordnung in ('nummer', 'verlauf', 'ki', 'manuell', 'ablauf'));
  end if;
end $$;

-- 5) Realtime: offene Ablauf-Ansicht lädt nach, wenn eine Mail einen Schritt setzt
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'auftrag_ablauf'
  ) then
    alter publication supabase_realtime add table public.auftrag_ablauf;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'auftrag_ablauf_ereignisse'
  ) then
    alter publication supabase_realtime add table public.auftrag_ablauf_ereignisse;
  end if;
end $$;

notify pgrst, 'reload schema';
