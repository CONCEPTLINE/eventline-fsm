-- RPC get_monthly_payroll_stats anpassen: liefert employer_pct statt
-- employer_costs_chf_per_hour (das wurde in 154 gedroppt).

drop function if exists public.get_monthly_payroll_stats(date);

create or replace function public.get_monthly_payroll_stats(p_month_start date)
returns table (
  profile_id uuid,
  full_name text,
  role text,
  is_active boolean,
  stempel_minutes integer,
  geplant_minutes integer,
  rapport_minutes integer,
  hourly_wage_chf numeric,
  employer_pct numeric,
  ahv_iv_eo_pct numeric,
  alv_pct numeric,
  nbu_pct numeric,
  bvg_pct numeric,
  ktg_pct numeric,
  quellensteuer_pct numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
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
      c.employer_pct,
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
    c.employer_pct,
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
  where p.role <> 'partner'
    and (
      p.is_active = true
      or coalesce(s.minutes, 0) > 0
      or coalesce(g.minutes, 0) > 0
      or coalesce(r.minutes, 0) > 0
    )
  order by p.is_active desc, p.full_name;
end;
$$;

grant execute on function public.get_monthly_payroll_stats(date) to authenticated;
