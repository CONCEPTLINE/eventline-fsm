-- 329_sicherheit_grundlagen.sql — Sicherheit & Datenbank-Grenzen, Teil 1 (NUR additiv)
--
-- Datum: 2026-10-15. Teil 2 (restriktive Policies) = 329b, erst nach dem Deploy des
-- Codes, der die neuen RPCs/Tabellen nutzt. Teil 3 = 330 (Drop profiles.calendar_feed_token).
--
-- Dieser Teil aendert fuer aktive Konten NICHTS am Verhalten — er legt nur die Bausteine an:
--
--  1) Kalender-Schluessel aus profiles herausloesen: neue Tabelle profile_calendar_tokens
--     (eine Zeile je Profil, RLS nur eigene Zeile, anon gesperrt). Bestehende Tokens werden
--     1:1 KOPIERT (nicht neu erzeugt) — laufende Kalender-Abos bleiben gueltig. Bis 330
--     haelt ein Trigger die neue Tabelle synchron (neue Profile, Rotation durch den alten
--     Code in der Zeit zwischen Einspielen und Deploy).
--  2) RPCs fuer die Portale (Profile werden in 329b fuer Portal-Konten gesperrt):
--       portal_personen()       — id/full_name/avatar_url der fachlich relevanten Personen
--                                 (Partner: Verantwortliche + zugeteilte Mitarbeiter der
--                                 Auftraege am eigenen Standort; Lieferant: dasselbe fuer die
--                                 zugewiesenen Auftraege der eigenen Firma; intern: alle
--                                 internen Mitarbeiter, wie bisher ueber profiles lesbar).
--       lieferant_firma(uuid)   — id/name der Firma eines Lieferanten-Kontos (eigenes Konto
--                                 oder intern mit lieferanten:view, fuer View-As). Ersetzt den
--                                 Embed lieferanten!profiles_lieferant_id_fkey im Portal;
--                                 die Firmenzeile selbst (interne Notizen) wird in 329b gesperrt.
--       profil_ist_portal(uuid) — hat dieses Profil eine Portal-Rolle? Fuer die Storage-
--                                 Policies (siehe 3).
--  3) Storage-Bucket documents: die Partner-Zweige von storage_documents_select und
--     storage_documents_grenze lasen die Rolle des Hochladenden per Join auf profiles —
--     unter der RLS des Partners. Sobald profiles fuer Partner gesperrt ist (329b), waere der
--     Join leer und Lieferanten-Angebote (uploaded_by = Lieferant) fuer Partner herunterladbar.
--     Jetzt prueft profil_ist_portal() (SECURITY DEFINER) die Rolle — Ergebnis heute identisch.
--  4) Helfer: is_internal_user() zaehlt deaktivierte Profile nicht mehr als intern;
--     is_lieferant_email() prueft is_active (+ trim) wie is_partner_email(). Anon-Execute
--     bleibt: der Login-Vorcheck (/login, portals.ts emailCheckRpc) ruft sie VOR dem Login.
--  5) handle_new_user(): SET search_path = public (Verhalten unveraendert).
--  6) Bucket documents: file_size_limit 10 MB -> 25 MB (App verspricht 25 MB:
--     src/lib/file-upload.ts MAX_UPLOAD_SIZE_MB, /api/upload; Lieferanten-Angebote 20 MB).
--  7) lieferanten.created_by: FK partners_created_by_fkey ohne ON DELETE blockierte das
--     Loeschen von Benutzern, die einen Lieferanten angelegt haben -> ON DELETE SET NULL,
--     neu als lieferanten_created_by_fkey (Ziel bleibt auth.users — ein FK auf profiles
--     wuerde die PostgREST-Embeds profiles<->lieferanten mehrdeutig machen). Restliche
--     partners_*-Namen (Check-Constraint, Trigger) auf lieferanten_* umbenannt.
--  8) Fehlende FK-Indizes der Technik-Tabellen.
--
-- Idempotent (create or replace / if not exists / Existenz-Pruefungen).
-- Einspielen: node scripts/apply-migration.mjs supabase/migrations/329_sicherheit_grundlagen.sql

-- ============================================================================
-- 1) Kalender-Schluessel
-- ============================================================================
create table if not exists public.profile_calendar_tokens (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  constraint profile_calendar_tokens_token_key unique (token)
);

comment on table public.profile_calendar_tokens is
  'Persoenlicher Kalender-Abo-Schluessel (/api/calendar.ics?token=…). Nur die eigene Zeile ist lesbar/schreibbar; die ICS-Route sucht per Admin-Client.';

alter table public.profile_calendar_tokens enable row level security;

revoke all on table public.profile_calendar_tokens from anon, authenticated;
grant select, insert, update, delete on table public.profile_calendar_tokens to authenticated;

drop policy if exists "profile_calendar_tokens_select" on public.profile_calendar_tokens;
create policy "profile_calendar_tokens_select" on public.profile_calendar_tokens
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "profile_calendar_tokens_insert" on public.profile_calendar_tokens;
create policy "profile_calendar_tokens_insert" on public.profile_calendar_tokens
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "profile_calendar_tokens_update" on public.profile_calendar_tokens;
create policy "profile_calendar_tokens_update" on public.profile_calendar_tokens
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "profile_calendar_tokens_delete" on public.profile_calendar_tokens;
create policy "profile_calendar_tokens_delete" on public.profile_calendar_tokens
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- Bestehende Tokens 1:1 kopieren (on conflict: schon kopierte / inzwischen rotierte bleiben).
insert into public.profile_calendar_tokens (user_id, token)
select p.id, p.calendar_feed_token
from public.profiles p
where p.calendar_feed_token is not null
on conflict (user_id) do nothing;

-- Synchron halten bis 330: neue Profile bekommen ihren Schluessel (gleicher Wert wie in
-- profiles), eine Rotation durch den alten Code wird nachgezogen.
create or replace function public.profile_calendar_token_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profile_calendar_tokens (user_id, token)
  values (new.id, coalesce(new.calendar_feed_token, gen_random_uuid()))
  on conflict (user_id) do update set token = excluded.token;
  return null;
end;
$$;

revoke execute on function public.profile_calendar_token_sync() from public, anon, authenticated;

drop trigger if exists profile_calendar_token_insert on public.profiles;
create trigger profile_calendar_token_insert
  after insert on public.profiles
  for each row execute function public.profile_calendar_token_sync();

drop trigger if exists profile_calendar_token_update on public.profiles;
create trigger profile_calendar_token_update
  after update of calendar_feed_token on public.profiles
  for each row
  when (old.calendar_feed_token is distinct from new.calendar_feed_token)
  execute function public.profile_calendar_token_sync();

-- ============================================================================
-- 2) RPCs fuer die Portale
-- ============================================================================
create or replace function public.profil_ist_portal(p_profil uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.profiles p
      join public.roles r on r.slug = p.role
      where p.id = p_profil and r.is_portal
    );
$$;

-- anon braucht Execute: die restriktive Storage-Policy storage_documents_grenze gilt auch
-- fuer anon und referenziert die Funktion (Rechte werden beim Planen geprueft, auch wenn der
-- Zweig nie ausgewertet wird). Fuer anon liefert sie false.
revoke execute on function public.profil_ist_portal(uuid) from public;
grant execute on function public.profil_ist_portal(uuid) to anon, authenticated;

create or replace function public.portal_personen()
returns table (id uuid, full_name text, avatar_url text)
language sql
stable
security definer
set search_path = public
as $$
  with ich as (
    select p.id, p.role, p.partner_location_id, p.lieferant_id
    from public.profiles p
    where p.id = (select auth.uid()) and p.is_active = true
  ),
  relevante_jobs as (
    -- Partner: Auftraege am eigenen Standort (gleiche Bedingung wie jobs_select).
    select j.id, j.project_lead_id
    from public.jobs j
    join ich on ich.role = 'partner'
            and ich.partner_location_id is not null
            and j.location_id = ich.partner_location_id
    where (select public.is_partner())
      and ((select public.has_permission('partner:auftraege:view'))
           or (select public.has_permission('partner:belegungsplan:view')))
    union
    -- Lieferant: Auftraege, denen die eigene Firma zugewiesen ist.
    select j.id, j.project_lead_id
    from public.jobs j
    join public.job_lieferanten jl on jl.job_id = j.id
    join ich on ich.role = 'lieferant' and jl.lieferant_id = ich.lieferant_id
    where (select public.is_lieferant())
  ),
  personen as (
    select rj.project_lead_id as pid from relevante_jobs rj where rj.project_lead_id is not null
    union
    select a.assigned_to from public.job_appointments a
    join relevante_jobs rj on rj.id = a.job_id
    where a.assigned_to is not null
  )
  select p.id, p.full_name, p.avatar_url
  from public.profiles p
  where not public.is_portal_role(p.role)
    and (
      (select public.is_internal_user())
      or p.id in (select pid from personen)
    )
  order by p.full_name;
$$;

revoke execute on function public.portal_personen() from public, anon;
grant execute on function public.portal_personen() to authenticated;

create or replace function public.lieferant_firma(p_profil uuid)
returns table (id uuid, name text)
language sql
stable
security definer
set search_path = public
as $$
  select l.id, l.name
  from public.profiles p
  join public.lieferanten l on l.id = p.lieferant_id
  where p.id = p_profil
    and (p_profil = (select auth.uid()) or (select public.has_permission('lieferanten:view')));
$$;

revoke execute on function public.lieferant_firma(uuid) from public, anon;
grant execute on function public.lieferant_firma(uuid) to authenticated;

-- ============================================================================
-- 3) Storage documents: Rolle des Hochladenden per Helfer statt profiles-Join
--    (sonst Partner-Zweig nach 329b offen). Rest identisch zu 309.
-- ============================================================================
drop policy if exists "storage_documents_grenze" on storage.objects;
create policy "storage_documents_grenze" on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (
    bucket_id <> 'documents'
    or (select public.is_internal_user())
    or (
      (select public.is_partner())
      and (
        (
          split_part(storage.objects.name, '/', 1) = 'partner-anfragen'
          and exists (
            select 1 from public.jobs j
            where j.id = case
              when split_part(storage.objects.name, '/', 2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(storage.objects.name, '/', 2)::uuid
            end
          )
        )
        or exists (
          select 1
          from public.documents d
          join public.jobs j on j.id = d.job_id
          where d.storage_path = storage.objects.name
            and (
              not public.profil_ist_portal(d.uploaded_by)
              or (
                d.storage_path like 'partner-anfragen/' || d.job_id::text || '/%'
                and position('..' in d.storage_path) = 0
              )
            )
        )
      )
    )
  )
  with check (
    bucket_id <> 'documents'
    or (select public.is_internal_user())
  );

drop policy if exists "storage_documents_select" on storage.objects;
create policy "storage_documents_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and (
      (select public.is_internal_user())
      or (
        (select public.is_partner())
        and (
          (
            split_part(storage.objects.name, '/', 1) = 'partner-anfragen'
            and exists (
              select 1 from public.jobs j
              where j.id = case
                when split_part(storage.objects.name, '/', 2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then split_part(storage.objects.name, '/', 2)::uuid
              end
            )
          )
          or exists (
            select 1
            from public.documents d
            join public.jobs j on j.id = d.job_id
            where d.storage_path = storage.objects.name
              and (
                not public.profil_ist_portal(d.uploaded_by)
                or (
                  d.storage_path like 'partner-anfragen/' || d.job_id::text || '/%'
                  and position('..' in d.storage_path) = 0
                )
              )
          )
        )
      )
    )
  );

-- ============================================================================
-- 4) Helfer
-- ============================================================================
-- Intern = aktives Profil mit Nicht-Portal-Rolle (deaktivierte Konten nicht mehr intern).
create or replace function public.is_internal_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    join public.roles r on r.slug = p.role
    where p.id = auth.uid()
      and p.is_active = true
      and not r.is_portal
  );
$$;

-- Login-Vorcheck: nur aktive Lieferanten-Konten (wie is_partner_email).
create or replace function public.is_lieferant_email(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where lower(email) = lower(trim(p_email))
      and role = 'lieferant'
      and is_active = true
  );
$$;

-- ============================================================================
-- 5) handle_new_user: fester search_path (Rumpf unveraendert)
-- ============================================================================
alter function public.handle_new_user() set search_path = public;

-- ============================================================================
-- 6) Bucket documents: 25 MB je Datei
-- ============================================================================
update storage.buckets
set file_size_limit = 26214400
where id = 'documents'
  and file_size_limit is distinct from 26214400;

-- ============================================================================
-- 7) lieferanten: FK created_by ON DELETE SET NULL + partners_*-Namen
-- ============================================================================
alter table public.lieferanten
  drop constraint if exists partners_created_by_fkey,
  drop constraint if exists lieferanten_created_by_fkey,
  add constraint lieferanten_created_by_fkey
    foreign key (created_by) references auth.users(id) on delete set null;

do $$
begin
  if exists (select 1 from pg_constraint
             where conrelid = 'public.lieferanten'::regclass and conname = 'partners_type_check')
     and not exists (select 1 from pg_constraint
             where conrelid = 'public.lieferanten'::regclass and conname = 'lieferanten_type_check') then
    alter table public.lieferanten rename constraint partners_type_check to lieferanten_type_check;
  end if;
  if exists (select 1 from pg_trigger
             where tgrelid = 'public.lieferanten'::regclass and tgname = 'partners_updated_at')
     and not exists (select 1 from pg_trigger
             where tgrelid = 'public.lieferanten'::regclass and tgname = 'lieferanten_updated_at') then
    alter trigger partners_updated_at on public.lieferanten rename to lieferanten_updated_at;
  end if;
end $$;

-- ============================================================================
-- 8) FK-Indizes der Technik-Tabellen
-- ============================================================================
create index if not exists job_technik_positionen_artikel_idx on public.job_technik_positionen (artikel_id);
create index if not exists job_technik_reviews_position_idx on public.job_technik_reviews (position_id);
create index if not exists job_technik_kommentare_position_idx on public.job_technik_kommentare (position_id);
create index if not exists job_technik_kommentare_review_idx on public.job_technik_kommentare (review_id);
