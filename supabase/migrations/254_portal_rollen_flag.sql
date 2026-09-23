-- Skalierbarkeits-Audit Teil 2: Portal-Rollen als DB-Flag statt
-- hartkodierter Slug-Listen. Eine neue Portal-Rolle (z.B. 'kunde') ist
-- damit EIN Insert mit is_portal=true — keine Funktions-/Policy-Sweeps
-- mehr (Gegenstueck im Frontend: src/lib/roles.ts).

alter table public.roles add column if not exists is_portal boolean not null default false;
update public.roles set is_portal = true where slug in ('partner', 'lieferant');

-- Ist der Rollen-Slug eine Portal-Rolle? Unbekannte Slugs = intern
-- (gleiche Semantik wie das bisherige "not in ('partner','lieferant')").
create or replace function public.is_portal_role(p_slug text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select r.is_portal from public.roles r where r.slug = p_slug), false);
$$;

-- Ist der eingeloggte User ein Portal-User?
create or replace function public.is_portal_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    join public.roles r on r.slug = p.role
    where p.id = auth.uid() and r.is_portal
  );
$$;

-- ── Bestehende Funktionen von Slug-Listen auf das Flag umstellen ──

create or replace function public.get_assignable_users()
returns table(id uuid, full_name text, role text, is_active boolean, avatar_url text)
language sql stable security definer set search_path to 'public' as $$
  select id, full_name, role, is_active, avatar_url
  from public.profiles
  where is_active = true
    and not public.is_portal_role(role)
  order by full_name;
$$;

create or replace function public.is_eventline_email(p_email text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from public.profiles
    where lower(email) = lower(trim(p_email))
      and not public.is_portal_role(role)
      and is_active = true
  );
$$;

create or replace function public.get_anwesenheit_users()
returns table(id uuid, full_name text)
language sql stable security definer set search_path to 'public' as $$
  select p.id, p.full_name
  from public.profiles p
  join public.roles r on r.slug = p.role
  where p.is_active = true
    and not r.is_portal
    and (p.role = 'admin' or r.permissions ? 'anwesenheit:view')
  order by p.full_name;
$$;

-- get_monthly_payroll_stats: gleiche Logik, Portal-Filter via Flag.
CREATE OR REPLACE FUNCTION public.get_monthly_payroll_stats(p_month_start date)
 RETURNS TABLE(profile_id uuid, full_name text, role text, is_active boolean, stempel_minutes integer, geplant_minutes integer, rapport_minutes integer, hourly_wage_chf numeric, uses_standard_lohn boolean, employer_ahv_pct numeric, employer_alv_pct numeric, employer_fak_pct numeric, employer_bu_pct numeric, employer_bvg_pct numeric, employer_verwaltung_pct numeric, ahv_iv_eo_pct numeric, alv_pct numeric, nbu_pct numeric, bvg_pct numeric, ktg_pct numeric, quellensteuer_pct numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_month_end date := (p_month_start + interval '1 month')::date;
begin
  if not public.is_admin() then
    raise exception 'forbidden: nur fuer Administratoren';
  end if;

  return query
  with stempel as (
    select t.user_id,
      sum(greatest(0, extract(epoch from (t.clock_out - t.clock_in)) / 60))::int as minutes
    from public.time_entries t
    where t.clock_in >= p_month_start
      and t.clock_in < v_month_end
      and t.clock_out is not null
    group by t.user_id
  ),
  geplant as (
    select a.assigned_to as user_id,
      sum(greatest(0, extract(epoch from (a.end_time - a.start_time)) / 60))::int as minutes
    from public.job_appointments a
    where a.assigned_to is not null
      and a.start_time >= p_month_start
      and a.start_time < v_month_end
    group by a.assigned_to
  ),
  rapport as (
    select (range->>'technician_id')::uuid as user_id,
      sum(greatest(
        0,
        case
          when (range->>'end')::time < (range->>'start')::time
            then 1440 + (extract(epoch from ((range->>'end')::time - (range->>'start')::time))::int / 60)
          else extract(epoch from ((range->>'end')::time - (range->>'start')::time))::int / 60
        end
        - coalesce(nullif(range->>'pause', '')::int, 0)
      ))::int as minutes
    from public.service_reports r
    cross join lateral jsonb_array_elements(r.time_ranges) as range
    where r.report_date >= p_month_start
      and r.report_date < v_month_end
      and r.status = 'abgeschlossen'
      and coalesce(range->>'technician_id', '') <> ''
      and coalesce(range->>'start', '') <> ''
      and coalesce(range->>'end', '') <> ''
    group by (range->>'technician_id')::uuid
  ),
  comp as (
    select distinct on (c.profile_id)
      c.profile_id,
      c.hourly_wage_chf,
      c.uses_standard_lohn,
      c.employer_ahv_pct,
      c.employer_alv_pct,
      c.employer_fak_pct,
      c.employer_bu_pct,
      c.employer_bvg_pct,
      c.employer_verwaltung_pct,
      c.ahv_iv_eo_pct,
      c.alv_pct,
      c.nbu_pct,
      c.bvg_pct,
      c.ktg_pct,
      c.quellensteuer_pct
    from public.employee_compensation c
    where c.effective_from <= p_month_start
      and (c.effective_to is null or c.effective_to >= p_month_start)
    order by c.profile_id, c.effective_from desc
  )
  select
    p.id,
    p.full_name,
    p.role,
    p.is_active,
    coalesce(s.minutes, 0),
    coalesce(g.minutes, 0),
    coalesce(r.minutes, 0),
    c.hourly_wage_chf,
    c.uses_standard_lohn,
    c.employer_ahv_pct,
    c.employer_alv_pct,
    c.employer_fak_pct,
    c.employer_bu_pct,
    c.employer_bvg_pct,
    c.employer_verwaltung_pct,
    c.ahv_iv_eo_pct,
    c.alv_pct,
    c.nbu_pct,
    c.bvg_pct,
    c.ktg_pct,
    c.quellensteuer_pct
  from public.profiles p
  left join stempel s on s.user_id = p.id
  left join geplant g on g.user_id = p.id
  left join rapport r on r.user_id = p.id
  left join comp c on c.profile_id = p.id
  where not public.is_portal_role(p.role)
    and (
      p.is_active = true
      or coalesce(s.minutes, 0) > 0
      or coalesce(g.minutes, 0) > 0
      or coalesce(r.minutes, 0) > 0
    )
  order by p.is_active desc, p.full_name;
end;
$function$
;

-- partner_submit_anfrage: Anfrage-Benachrichtigung an alle mit auftraege:see-all
-- (vorher nur role=admin — Rollen wie Disposition erfuhren nichts).
CREATE OR REPLACE FUNCTION public.partner_submit_anfrage(p_job_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_role text;
  v_caller_loc uuid;
  v_caller_name text;
  v_job_status text;
  v_job_creator uuid;
  v_job_location uuid;
  v_job_title text;
  v_job_snapshot jsonb;
  v_template_schema jsonb;
  v_appointment_required boolean;
  v_termin_count int;
  v_admin_id uuid;
begin
  select role, partner_location_id, full_name
  into v_caller_role, v_caller_loc, v_caller_name
  from public.profiles where id = auth.uid();

  if v_caller_role is distinct from 'partner' then
    raise exception 'forbidden: only partner role can submit anfragen';
  end if;

  select status, created_by, location_id, title, form_schema_snapshot
  into v_job_status, v_job_creator, v_job_location, v_job_title, v_job_snapshot
  from public.jobs where id = p_job_id;

  if v_job_status is null then
    raise exception 'job not found';
  end if;

  if v_job_creator <> auth.uid()
     and (v_caller_loc is null or v_caller_loc <> v_job_location) then
    raise exception 'forbidden: not your job';
  end if;

  if v_job_status <> 'partner_entwurf' then
    raise exception 'can only submit from partner_entwurf state, current: %', v_job_status;
  end if;

  -- Schema-Aware-Termin-Pflicht. Reihenfolge: snapshot -> location-template
  -- -> global-template -> default (true).
  v_appointment_required := null;

  if v_job_snapshot is not null then
    v_appointment_required := (v_job_snapshot -> 'submit' ->> 'appointment_required')::boolean;
  end if;

  if v_appointment_required is null and v_job_location is not null then
    select (live_schema -> 'submit' ->> 'appointment_required')::boolean
    into v_appointment_required
    from public.partner_form_template
    where scope = 'location' and location_id = v_job_location
    limit 1;
  end if;

  if v_appointment_required is null then
    select (live_schema -> 'submit' ->> 'appointment_required')::boolean
    into v_appointment_required
    from public.partner_form_template
    where scope = 'global'
    limit 1;
  end if;

  -- Default: Termin Pflicht (= altes Verhalten).
  if v_appointment_required is null then
    v_appointment_required := true;
  end if;

  if v_appointment_required then
    select count(*) into v_termin_count from public.job_appointments where job_id = p_job_id;
    if v_termin_count = 0 then
      raise exception 'mindestens ein Termin erforderlich vor dem Absenden';
    end if;
  end if;

  -- Status-Guard temporaer umgehen
  perform set_config('app.partner_status_change_ok', 'on', true);

  update public.jobs
  set status = 'partner_anfrage',
      submitted_at = now(),
      submitted_by = auth.uid()
  where id = p_job_id;

  perform set_config('app.partner_status_change_ok', 'off', true);

  -- In-App-Notification an alle aktiven Admins (keine Mail per Leos Wunsch).
  for v_admin_id in
    select p.id from public.profiles p join public.roles r on r.slug = p.role where p.is_active = true and (r.slug = 'admin' or r.permissions ? 'auftraege:see-all')
  loop
    insert into public.notifications (user_id, title, message, link)
    values (
      v_admin_id,
      'Neue Partner-Anfrage: ' || coalesce(v_job_title, 'Anfrage'),
      coalesce(v_caller_name, 'Partner') || ' hat eine Anfrage abgeschickt.',
      '/auftraege/' || p_job_id::text
    );
  end loop;
end;
$function$
;
