set client_min_messages = warning;
-- Lokale Testumgebung: Dinge, die auf Live NICHT über eine Migration entstanden sind
-- (im Supabase-Dashboard angelegt), damit das lokale Schema dem Live-Stand entspricht.
-- Quelle: Katalog-Abgleich mit Live (supabase/lokal/abgleich.mjs), Stand 2026-10-29.
-- Idempotent. Wird von supabase/lokal/aufbauen.sh nach den Migrationen eingespielt.
-- NIE auf Live einspielen (dort existiert das alles schon).

-- 1. Storage-Buckets, die auf Live per Dashboard angelegt wurden (Konfiguration wie Live, privat)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('documents',         'documents',         false, 26214400, null),
  ('lohndokumente',     'lohndokumente',     false, null,     null),
  ('personal-dossiers', 'personal-dossiers', false, null,     null)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 2. Realtime: auf Live ist public.jobs in der Publikation supabase_realtime
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'jobs'
  ) then
    alter publication supabase_realtime add table public.jobs;
  end if;
end $$;

-- ============================================================================
-- 3. Repo-Migrationen, die auf Live NICHT (oder anders) angekommen sind.
--    Lokal auf den Live-Stand zurücknehmen, damit Tests das echte Live-Verhalten
--    zeigen. Befund aus dem Katalog-Abgleich vom 2026-10-29 (Details TESTUMGEBUNG.md).
-- ============================================================================

-- 3a. Spalten, Trigger, Funktionen, Index, die nur das Repo kennt
drop trigger if exists company_settings_updated_at on public.company_settings;           -- 185
drop trigger if exists wage_documents_updated_at on public.wage_documents;               -- 135
drop trigger if exists profiles_notification_defaults_trg on public.profiles;            -- 217
drop function if exists public.handle_new_profile_notification_defaults();               -- 217
drop function if exists public.notification_settings_default_channels();                 -- 217
drop function if exists public.archive_stale_job_drafts();                               -- 216
drop function if exists public.get_my_compensation();                                    -- 114
drop index if exists public.job_drafts_archived_idx;                                     -- 216
alter table public.bexio_connection         drop column if exists feature_accounting;    -- 110
alter table public.company_settings         drop column if exists created_at;            -- 185
alter table public.job_drafts               drop column if exists archived_at;           -- 216
alter table public.user_notification_settings drop column if exists created_at;          -- 217
alter table public.wage_documents           drop column if exists created_at;            -- 135
alter table public.wage_documents           drop column if exists updated_at;            -- 135
alter table public.profiles drop constraint if exists profiles_id_fkey;                  -- 001 (Live: kein FK auf auth.users)

-- 3b. Policies, die es auf Live nicht gibt
drop policy if exists "Profiles sind für authentifizierte Benutzer sichtbar" on public.profiles;   -- 001
drop policy if exists "Profile: eigenes oder admin" on public.profiles;                         -- 053
drop policy if exists job_overdue_reminders_insert_none on public.job_overdue_reminders;         -- 205
drop policy if exists job_overdue_reminders_update_none on public.job_overdue_reminders;
drop policy if exists job_overdue_reminders_delete_none on public.job_overdue_reminders;
drop policy if exists permission_audit_insert_none on public.permission_audit_log;               -- 168
drop policy if exists permission_audit_update_none on public.permission_audit_log;
drop policy if exists permission_audit_delete_none on public.permission_audit_log;
drop policy if exists passkey_challenges_select_none on public.user_passkey_challenges;          -- 209
drop policy if exists passkey_challenges_insert_none on public.user_passkey_challenges;
drop policy if exists passkey_challenges_update_none on public.user_passkey_challenges;
drop policy if exists passkey_challenges_delete_none on public.user_passkey_challenges;

-- 3c. Policies mit anderer Definition auf Live (Live-Fassung übernommen)
drop policy if exists job_overdue_reminders_select_admin on public.job_overdue_reminders;
create policy job_overdue_reminders_select_admin on public.job_overdue_reminders
  as permissive for select to authenticated
  using (exists (select 1 from profiles where profiles.id = (select auth.uid() as uid) and profiles.role = 'admin'::text));
drop policy if exists permission_audit_select_admin on public.permission_audit_log;
create policy permission_audit_select_admin on public.permission_audit_log
  as permissive for select to public
  using ((select is_admin() as is_admin));

-- 3d. Funktionen in der Live-Fassung (pg_get_functiondef von Live, 2026-10-29).
--     get_all_time_entries: Live liefert (noch) keine Projekt-Spalten (Migration 213 dort nicht so angekommen).
drop function if exists public.get_all_time_entries(uuid, timestamptz, timestamptz);
CREATE OR REPLACE FUNCTION public.get_all_time_entries(filter_user_id uuid DEFAULT NULL::uuid, filter_from timestamp with time zone DEFAULT NULL::timestamp with time zone, filter_to timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(id uuid, user_id uuid, user_name text, job_id uuid, job_number integer, job_title text, clock_in timestamp with time zone, clock_out timestamp with time zone, description text, notes text, duration_minutes integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'forbidden: nur fuer Administratoren';
  end if;
  return query
    select
      t.id,
      t.user_id,
      p.full_name as user_name,
      t.job_id,
      j.job_number,
      j.title as job_title,
      t.clock_in,
      t.clock_out,
      t.description,
      t.notes,
      case
        when t.clock_out is null then null
        else (extract(epoch from (t.clock_out - t.clock_in)) / 60)::int
      end as duration_minutes
    from public.time_entries t
    join public.profiles p on p.id = t.user_id
    left join public.jobs j on j.id = t.job_id
    where (filter_user_id is null or t.user_id = filter_user_id)
      and (filter_from is null or t.clock_in >= filter_from)
      and (filter_to is null or t.clock_in < filter_to)
    order by t.clock_in desc;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_my_wage_consent()
 RETURNS TABLE(accepted_at timestamp with time zone, accepted_version text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select lohndokumente_digital_accepted_at, lohndokumente_digital_accepted_version from public.profiles where id = auth.uid() $function$
;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ BEGIN INSERT INTO public.profiles (id, email, full_name, role) VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email), COALESCE(NEW.raw_user_meta_data->>'role', 'techniker')) ON CONFLICT (id) DO NOTHING; RETURN NEW; END; $function$
;

CREATE OR REPLACE FUNCTION public.prevent_profile_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ BEGIN IF OLD.is_active = true AND (SELECT count(*) FROM public.profiles WHERE is_active = true) <= 1 THEN RAISE EXCEPTION 'Cannot delete the last active profile'; END IF; RETURN OLD; END; $function$
;

-- 3e. Spalten-Rechte auf profiles wie Live (dort zusätzlich zu den Tabellenrechten gesetzt)
grant select (id, full_name, avatar_url, role, is_active) on public.profiles to anon;
grant select (id, full_name, avatar_url, role, is_active, created_at, updated_at) on public.profiles to authenticated;
