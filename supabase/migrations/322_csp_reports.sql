-- 322_csp_reports.sql
-- Sammelpunkt fuer CSP-Verstoss-Meldungen (Content-Security-Policy report-uri/report-to).
-- Der Browser POSTet Verstoesse an /api/csp-report; die Route schreibt sie hier rein
-- (via service_role, umgeht RLS). Nur Admins lesen die Tabelle fuers Sicherheits-Dashboard.
-- Idempotent, additiv. Einspielen: node scripts/apply-migration.mjs supabase/migrations/322_csp_reports.sql

create table if not exists public.csp_reports (
  id                  uuid primary key default gen_random_uuid(),
  occurred_at         timestamptz not null default now(),
  document_uri        text,
  blocked_uri         text,
  violated_directive  text,
  effective_directive text,
  disposition         text,
  status_code         integer,
  source_file         text,
  line_number         integer,
  user_agent          text,
  payload             jsonb not null default '{}'::jsonb
);

create index if not exists csp_reports_occurred_idx  on public.csp_reports (occurred_at desc);
create index if not exists csp_reports_directive_idx on public.csp_reports (effective_directive);

alter table public.csp_reports enable row level security;

-- Nur Admins lesen (Dashboard). Schreiben laeuft ausschliesslich ueber die API-Route
-- mit service_role (umgeht RLS). Alle 4 Verben explizit (CLAUDE.md §5): INSERT/UPDATE/
-- DELETE fuer normale Rollen bewusst verboten, damit niemand die Tabelle manipuliert.
drop policy if exists "csp_reports_select_admin" on public.csp_reports;
create policy "csp_reports_select_admin" on public.csp_reports
  for select to authenticated using (public.is_admin());

drop policy if exists "csp_reports_insert_none" on public.csp_reports;
create policy "csp_reports_insert_none" on public.csp_reports
  for insert to authenticated with check (false);

drop policy if exists "csp_reports_update_none" on public.csp_reports;
create policy "csp_reports_update_none" on public.csp_reports
  for update to authenticated using (false) with check (false);

drop policy if exists "csp_reports_delete_none" on public.csp_reports;
create policy "csp_reports_delete_none" on public.csp_reports
  for delete to authenticated using (false);

-- Default-Grants entziehen: anon gar nichts; authenticated nur SELECT (Rest via RLS dicht).
revoke all on table public.csp_reports from anon;
revoke insert, update, delete, truncate, references, trigger on table public.csp_reports from authenticated;
grant select on table public.csp_reports to authenticated;
