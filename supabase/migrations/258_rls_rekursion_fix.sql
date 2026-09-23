-- HOTFIX zu 257: infinite recursion. jobs_select prueft job_appointments
-- (RLS) und appointments_select prueft jetzt jobs (RLS) -> Zyklus.
-- Bruchstelle: der "mir zugewiesene Termine"-Zweig in jobs_select laeuft
-- ueber eine SECURITY-DEFINER-Funktion (RLS-frei, statement-cachebar
-- als Array) — damit referenziert jobs_select job_appointments nicht
-- mehr ueber RLS und der Kreis ist offen.

create or replace function public.my_assigned_job_ids()
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct job_id), '{}')
  from public.job_appointments
  where assigned_to = auth.uid() and job_id is not null;
$$;

drop policy if exists "jobs_select" on public.jobs;
create policy "jobs_select" on public.jobs for select using (
  (select public.is_admin_or_lead())
  or project_lead_id = (select auth.uid())
  or id = any ((select public.my_assigned_job_ids())::uuid[])
  or ((select public.is_partner())
      and exists (select 1 from public.profiles p
                  where p.id = (select auth.uid())
                    and p.partner_location_id is not null
                    and p.partner_location_id = jobs.location_id)
      and ((select public.has_permission('partner:auftraege:view'))
           or (select public.has_permission('partner:belegungsplan:view'))))
);
