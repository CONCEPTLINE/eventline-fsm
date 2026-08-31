-- 203_location_stats_scope.sql
-- ============================================================
-- get_location_stats bekommt einen 'scope'-Parameter:
--   'all'    (default) — alle Auftraege im Zeitraum (Vergangenheit + Zukunft)
--   'past'   — nur mit start_date <= today
--   'future' — nur mit start_date > today
--
-- Zusaetzlich: Storno raus (immer). Entwurf/Archiv raus (immer).
--
-- Reverts 202 (das nur past erlaubte). Der Zeitraum-Filter (from/to)
-- bleibt orthogonal.
--
-- Semantik:
-- - job_count: gezaehlt gemaess scope
-- - geplant_minutes: alle Termine der Auftraege im scope
-- - stempel_minutes: alle abgeschlossenen Stempelungen (natur der Sache
--   Vergangenheit; bei scope='future' meist 0)
-- - rapport_minutes: alle abgeschlossenen Rapports (dito)
-- - vollkosten_chf: aus Ist-Stempeln (dito)
-- ============================================================

drop function if exists public.get_location_stats(date, date);
drop function if exists public.get_location_stats(date, date, text);

create or replace function public.get_location_stats(
  p_from  date default '2000-01-01',
  p_to    date default '9999-12-31',
  p_scope text default 'all'
)
returns table (
  location_id uuid,
  location_name text,
  job_count integer,
  geplant_minutes bigint,
  stempel_minutes bigint,
  rapport_minutes bigint,
  last_job_date date,
  hourly_rate_chf numeric,
  vollkosten_chf numeric
)
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Europe/Zurich')::date;
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;
  if p_scope not in ('all', 'past', 'future') then
    raise exception 'invalid scope: %', p_scope;
  end if;

  return query
  with jobs_in_range as (
    select j.id, j.location_id, j.start_date
    from public.jobs j
    where j.location_id is not null
      and j.start_date is not null
      and j.start_date >= p_from
      and j.start_date <= p_to
      and j.status not in ('storniert', 'entwurf', 'archiviert')
      and case p_scope
            when 'past'   then j.start_date <= v_today
            when 'future' then j.start_date >  v_today
            else true
          end
  ),
  geplant as (
    -- Termine der gefilterten Auftraege — keinen zusaetzlichen today-Cutoff
    -- (der scope-Filter erledigt das schon auf Job-Ebene).
    select j.location_id,
           coalesce(sum(extract(epoch from (a.end_time - a.start_time)) / 60), 0)::bigint as minutes
    from jobs_in_range j
    left join public.job_appointments a on a.job_id = j.id
    group by j.location_id
  ),
  stempel as (
    select j.location_id,
           coalesce(sum(extract(epoch from (t.clock_out - t.clock_in)) / 60), 0)::bigint as minutes
    from jobs_in_range j
    left join public.time_entries t on t.job_id = j.id and t.clock_out is not null
    group by j.location_id
  ),
  rapport as (
    select j.location_id,
           coalesce(sum(
             greatest(
               0,
               (
                 (split_part(r->>'end', ':', 1)::int * 60 + split_part(r->>'end', ':', 2)::int)
                 - (split_part(r->>'start', ':', 1)::int * 60 + split_part(r->>'start', ':', 2)::int)
                 + case
                     when (split_part(r->>'end', ':', 1)::int * 60 + split_part(r->>'end', ':', 2)::int)
                        < (split_part(r->>'start', ':', 1)::int * 60 + split_part(r->>'start', ':', 2)::int)
                     then 1440 else 0
                   end
                 - coalesce((r->>'pause')::int, 0)
               )
             )
           ), 0)::bigint as minutes
    from jobs_in_range j
    left join public.service_reports sr on sr.job_id = j.id and sr.status = 'abgeschlossen'
    left join lateral jsonb_array_elements(coalesce(sr.time_ranges, '[]'::jsonb)) as r on true
    where r->>'start' ~ '^\d{1,2}:\d{2}$'
      and r->>'end'   ~ '^\d{1,2}:\d{2}$'
    group by j.location_id
  ),
  counts as (
    select j.location_id,
           count(*)::integer as cnt,
           max(j.start_date) as last_date
    from jobs_in_range j
    group by j.location_id
  ),
  entries_with_cost as (
    select
      j.location_id,
      t.clock_in,
      extract(epoch from (t.clock_out - t.clock_in)) / 60.0 as minutes,
      c.hourly_wage_chf,
      (
        select pd.default_employer_ahv_pct + pd.default_employer_alv_pct
             + pd.default_employer_fak_pct + pd.default_employer_bu_pct
             + pd.default_employer_bvg_pct + pd.default_employer_verwaltung_pct
        from public.payroll_defaults pd
        where pd.effective_from <= t.clock_in::date
        order by pd.effective_from desc
        limit 1
      ) as ag_pct
    from jobs_in_range j
    join public.time_entries t on t.job_id = j.id and t.clock_out is not null
    left join lateral (
      select ec.hourly_wage_chf
      from public.employee_compensation ec
      where ec.profile_id = t.user_id
        and ec.effective_from <= t.clock_in::date
        and (ec.effective_to is null or ec.effective_to >= t.clock_in::date)
      order by ec.effective_from desc
      limit 1
    ) c on true
  ),
  vollkosten as (
    select
      e.location_id,
      coalesce(sum(
        (e.minutes / 60.0) * coalesce(e.hourly_wage_chf, 0) * (1 + coalesce(e.ag_pct, 0) / 100.0)
      ), 0)::numeric as chf
    from entries_with_cost e
    group by e.location_id
  )
  select
    l.id::uuid,
    l.name::text,
    coalesce(c.cnt, 0)::integer,
    coalesce(g.minutes, 0)::bigint,
    coalesce(s.minutes, 0)::bigint,
    coalesce(rp.minutes, 0)::bigint,
    c.last_date::date,
    l.default_hourly_rate_chf::numeric,
    coalesce(v.chf, 0::numeric)::numeric
  from public.locations l
  join counts c on c.location_id = l.id
  left join geplant    g  on g.location_id  = l.id
  left join stempel    s  on s.location_id  = l.id
  left join rapport    rp on rp.location_id = l.id
  left join vollkosten v  on v.location_id  = l.id
  order by s.minutes desc nulls last, c.cnt desc;
end;
$$;

revoke execute on function public.get_location_stats(date, date, text) from public, anon;
grant execute on function public.get_location_stats(date, date, text) to authenticated;
