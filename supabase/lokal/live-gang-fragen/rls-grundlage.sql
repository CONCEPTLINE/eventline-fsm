-- NUR LOKAL (Wegwerf-Container postgres:17-alpine): die Teile von Supabase und
-- früheren Migrationen, die 381 braucht — Rollen, auth.uid(), profiles/roles,
-- is_admin()/is_internal_user() (wie 338/329), lohn_schutz_nie_loeschen() (wie 360).
-- flow_abrufe/flow_abruf_* kommen aus 369 (Abschnitte 1–2), 371, 377 (2.) und 380 (3.) (Skript pruefen-rls.sh).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create table public.roles (slug text primary key, is_portal boolean not null default false);
insert into public.roles values ('admin', false), ('mitarbeiter', false), ('partner', true), ('lieferant', true);
create table public.profiles (
  id uuid primary key, role text references public.roles(slug), is_active boolean not null default true, full_name text
);
grant select on public.profiles to authenticated;

create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and is_active = true);
$$;
create or replace function public.is_internal_user() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p join public.roles r on r.slug = p.role
                  where p.id = auth.uid() and p.is_active = true and not r.is_portal);
$$;
create or replace function public.lohn_schutz_nie_loeschen() returns trigger language plpgsql as $$
begin
  raise exception '%: % ist gesperrt (Aufbewahrungspflicht) — archivieren statt löschen',
    tg_table_name, case tg_op when 'DELETE' then 'Löschen' else 'Ändern' end using errcode = 'P0001';
end;
$$;
