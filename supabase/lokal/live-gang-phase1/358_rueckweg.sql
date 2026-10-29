-- RÜCKWEG zu Migration 358 (Lohndaten im Browser sperren).
--
-- Nur nötig, wenn der Code auf einen Stand VOR Phase 1 zurückgerollt wird
-- (alte Seiten lesen Lohnzeilen/Firmensätze/Lohndokumente direkt im Browser).
-- Stellt die Policies und Rechte für eingeloggte Benutzer (authenticated)
-- wieder her — exakt wie vor 358 (Stand Live 29.10.2026, Abgleich 0 Abweichungen).
-- NICHT wiederhergestellt (gewollt): Rechte für nicht eingeloggte Zugriffe
-- (anon/public) und die Testfunktion _test_payroll (Definition steht in der
-- Sicherung: <sicherung>/funktionen.sql, falls doch nötig).
-- Idempotent. Einspielen: node scripts/apply-migration.mjs supabase/lokal/live-gang-phase1/358_rueckweg.sql

grant select, insert, update, delete on public.employee_compensation to authenticated;
grant select, insert, update, delete on public.payroll_defaults to authenticated;
grant select, insert, update, delete on public.wage_documents to authenticated;

drop policy if exists emp_comp_select on public.employee_compensation;
create policy emp_comp_select on public.employee_compensation for select to authenticated
  using ((select public.has_permission('lohn:manage'::text)));
drop policy if exists emp_comp_insert on public.employee_compensation;
create policy emp_comp_insert on public.employee_compensation for insert to authenticated
  with check ((select public.has_permission('lohn:manage'::text)));
drop policy if exists emp_comp_update on public.employee_compensation;
create policy emp_comp_update on public.employee_compensation for update to authenticated
  using ((select public.has_permission('lohn:manage'::text)));
drop policy if exists emp_comp_delete on public.employee_compensation;
create policy emp_comp_delete on public.employee_compensation for delete to authenticated
  using ((select public.has_permission('lohn:manage'::text)));

drop policy if exists payroll_defaults_select on public.payroll_defaults;
create policy payroll_defaults_select on public.payroll_defaults for select
  using ((select public.has_permission('lohn:manage'::text)));
drop policy if exists payroll_defaults_insert on public.payroll_defaults;
create policy payroll_defaults_insert on public.payroll_defaults for insert
  with check ((select public.has_permission('lohn:manage'::text)));
drop policy if exists payroll_defaults_update on public.payroll_defaults;
create policy payroll_defaults_update on public.payroll_defaults for update
  using ((select public.has_permission('lohn:manage'::text)))
  with check ((select public.has_permission('lohn:manage'::text)));
drop policy if exists payroll_defaults_delete on public.payroll_defaults;
create policy payroll_defaults_delete on public.payroll_defaults for delete
  using ((select public.has_permission('lohn:manage'::text)));

drop policy if exists wage_documents_admin_write on public.wage_documents;
create policy wage_documents_admin_write on public.wage_documents for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists wage_documents_select on public.wage_documents;
create policy wage_documents_select on public.wage_documents for select to authenticated
  using (((profile_id = (select auth.uid())) or (select public.is_admin())));

grant execute on function public.get_monthly_payroll_stats(date) to authenticated;
grant execute on function public.get_current_bvg_threshold(date) to authenticated;
grant execute on function public.get_location_stats(date, date, text) to authenticated;
