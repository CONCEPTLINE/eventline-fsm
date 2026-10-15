-- 324_security_audit.sql
-- Taeglicher automatischer Sicherheits-Check ("Einbruchmelder" in der ehrlichen
-- Form: Auto-Pentest + Auffaelligkeiten). Der Cron /api/cron/security-audit fuehrt
-- die Pruefungen aus und schreibt die Ergebnisse hierher; die Seite /sicherheit
-- zeigt den letzten Lauf. Die lokale KI fuellt spaeter das Klartext-Feld narrative.
-- Nur Admins lesen; Schreiben ausschliesslich der Cron (service_role).
-- Idempotent + additiv.

create table if not exists public.security_runs (
  id          uuid primary key default gen_random_uuid(),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,                         -- true = keine Auffaelligkeiten
  critical    integer not null default 0,
  warnings    integer not null default 0,
  checks      integer not null default 0,      -- wie viele Pruefungen gelaufen sind
  narrative   text,                            -- Klartext-Rapport (lokale KI)
  source      text not null default 'cron'     -- 'cron' | 'manuell'
);

create table if not exists public.security_findings (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid references public.security_runs(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  severity    text not null,                   -- 'critical' | 'warn' | 'info'
  category    text not null,                   -- 'anon-read' | 'anon-exec' | 'headers' | 'signup' | 'rollen'
  title       text not null,
  detail      jsonb not null default '{}'::jsonb
);

create index if not exists security_findings_run_idx on public.security_findings (run_id);
create index if not exists security_runs_started_idx on public.security_runs (started_at desc);

alter table public.security_runs enable row level security;
alter table public.security_findings enable row level security;

-- Nur Admins lesen; Schreiben nur via service_role (Cron, umgeht RLS). Kein
-- INSERT/UPDATE/DELETE fuer normale Rollen (keine Policy = verboten).
drop policy if exists "security_runs_select_admin" on public.security_runs;
create policy "security_runs_select_admin" on public.security_runs for select to authenticated using (public.is_admin());
drop policy if exists "security_findings_select_admin" on public.security_findings;
create policy "security_findings_select_admin" on public.security_findings for select to authenticated using (public.is_admin());

revoke all on table public.security_runs from anon;
revoke all on table public.security_findings from anon;
revoke insert, update, delete, truncate, references, trigger on table public.security_runs from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.security_findings from authenticated;
grant select on table public.security_runs to authenticated;
grant select on table public.security_findings to authenticated;

-- Hilfsfunktionen fuer den Auto-Check (nur service_role). Sie liefern dem Cron
-- die Liste ALLER public-Tabellen/Views (jede wird dann per anon-Key HTTP
-- getestet) und ALLER SECURITY-DEFINER-Funktionen, die anon ausfuehren darf
-- (= die gefaehrliche Leck-Klasse wie frueher get_assignable_users). So faellt
-- auch eine KUENFTIG neu angelegte Lücke automatisch auf.
create or replace function public.list_public_tables()
returns table(name text, kind text)
language sql security definer set search_path = public, information_schema stable
as $$
  select t.table_name::text, t.table_type::text
  from information_schema.tables t
  where t.table_schema = 'public' and t.table_type in ('BASE TABLE', 'VIEW');
$$;
revoke all on function public.list_public_tables() from public, anon, authenticated;
grant execute on function public.list_public_tables() to service_role;

create or replace function public.list_anon_definer_functions()
returns table(name text)
language sql security definer set search_path = public stable
as $$
  select distinct ro.routine_name::text
  from information_schema.routines ro
  join information_schema.role_routine_grants g
    on g.specific_schema = ro.specific_schema and g.specific_name = ro.specific_name
  where ro.routine_schema = 'public'
    and ro.security_type = 'DEFINER'
    and g.privilege_type = 'EXECUTE'
    and g.grantee in ('anon', 'PUBLIC');
$$;
revoke all on function public.list_anon_definer_functions() from public, anon, authenticated;
grant execute on function public.list_anon_definer_functions() to service_role;
