-- 362: Lohn-Umbau Phase 1 — Teil B: Lohndaten im Browser sperren.
--
-- !! Nummer beim Zusammenführen prüfen: höchste Nummer auf origin/main UND
-- !! allen Branches + 1.
--
-- ERST einspielen, wenn der Code mit den umgestellten Lesern live ist
-- (Kalender/Aufträge: BVG-Ampel über /api/hr/bvg-prognose, Projekte über
-- /api/hr/stundensaetze, Lohndokumente/Monatsstunden über den Server).
-- Vorher würden Kalender, Aufträge und Projekte keine Lohnwerte mehr sehen.
-- Reihenfolge: supabase/lokal/live-gang-phase1/LIVE-GANG.md.
--
-- Danach gilt wie bei den Finanzen: Lohndaten nur über den Server mit
-- Lohnrecht (lohn:manage) UND vertrautem Gerät. Die eigene Einwilligung
-- (get_my_wage_consent) bleibt für eingeloggte Mitarbeiter lesbar.
-- Idempotent. Rückweg: supabase/lokal/live-gang-phase1/362_rueckweg.sql.

-- Lohnzeilen
drop policy if exists emp_comp_select on public.employee_compensation;
drop policy if exists emp_comp_insert on public.employee_compensation;
drop policy if exists emp_comp_update on public.employee_compensation;
drop policy if exists emp_comp_delete on public.employee_compensation;
revoke all on public.employee_compensation from public, anon, authenticated;

-- Firmensätze
drop policy if exists payroll_defaults_select on public.payroll_defaults;
drop policy if exists payroll_defaults_insert on public.payroll_defaults;
drop policy if exists payroll_defaults_update on public.payroll_defaults;
drop policy if exists payroll_defaults_delete on public.payroll_defaults;
revoke all on public.payroll_defaults from public, anon, authenticated;

-- Lohndokumente (Liste/Download laufen über /api/hr/wage-documents)
drop policy if exists wage_documents_select on public.wage_documents;
drop policy if exists wage_documents_admin_write on public.wage_documents;
revoke all on public.wage_documents from public, anon, authenticated;

-- RLS bleibt eingeschaltet (ohne Policy = für Browser-Rollen gesperrt).
alter table public.employee_compensation enable row level security;
alter table public.payroll_defaults enable row level security;
alter table public.wage_documents enable row level security;

-- Lohnstatistik-Funktionen: nur noch der Server (service_role).
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.get_monthly_payroll_stats(date)',
    'public.get_current_bvg_threshold(date)',
    'public.get_location_stats(date, date, text)',
    'public.get_my_compensation()'
  ] loop
    if to_regprocedure(f) is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', f);
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
end $$;

-- Testfunktion (nur auf Live vorhanden, verweist auf eine echte Profil-ID).
drop function if exists public._test_payroll();
