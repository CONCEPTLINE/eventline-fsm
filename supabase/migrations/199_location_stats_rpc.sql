-- 199_location_stats_rpc.sql
-- ============================================================
-- Aggregation pro Location fuer Analytics-Uebersicht:
--   • Anzahl Auftraege
--   • Geplante Stunden (aus job_appointments)
--   • Gestempelte Stunden (aus time_entries)
--   • Rapportierte Stunden (aus service_reports.time_ranges JSONB)
--   • Letzter Auftrag (Datum)
--
-- Zeitraum-gefiltert per (p_from, p_to). Locations ohne Auftrag im
-- Zeitraum werden NICHT zurueckgegeben. Storno-Auftraege werden nicht
-- gezaehlt (keine Stunden geleistet).
--
-- Admin-only via is_admin()-Guard.
-- ============================================================

create or replace function public.get_location_stats(
  p_from date default '2000-01-01',
  p_to   date default '9999-12-31'
)
returns table (
  location_id uuid,
  location_name text,
  job_count int,
  geplant_minutes bigint,
  stempel_minutes bigint,
  rapport_minutes bigint,
  last_job_date date
)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;

  return query
  with jobs_in_range as (
    -- Auftraege mit Location + Datum im gewaehlten Fenster; storniert
    -- (jobs.status = 'storniert' oder 'entwurf') ausgeschlossen.
    select j.id, j.location_id, j.start_date, j.end_date
    from public.jobs j
    where j.location_id is not null
      and j.start_date is not null
      and j.start_date >= p_from
      and j.start_date <= p_to
      and j.status not in ('storniert', 'entwurf', 'archiviert')
  ),
  loc as (
    select l.id, l.name
    from public.locations l
  ),
  geplant as (
    -- Geplante Minuten pro Location: sum(end_time - start_time) aller
    -- job_appointments zu Auftraegen in Range.
    select j.location_id,
           coalesce(sum(extract(epoch from (a.end_time - a.start_time)) / 60), 0)::bigint as minutes
    from jobs_in_range j
    left join public.job_appointments a on a.job_id = j.id
    group by j.location_id
  ),
  stempel as (
    -- Gestempelte Minuten pro Location: sum(clock_out - clock_in) aller
    -- time_entries zu Auftraegen in Range. Nur abgeschlossene Stempel.
    select j.location_id,
           coalesce(sum(extract(epoch from (t.clock_out - t.clock_in)) / 60), 0)::bigint as minutes
    from jobs_in_range j
    left join public.time_entries t on t.job_id = j.id and t.clock_out is not null
    group by j.location_id
  ),
  rapport as (
    -- Rapport-Minuten aus JSONB extrahieren. Range-Elemente haben
    -- 'start'/'end' als HH:MM plus optional 'pause' (Minuten).
    -- Overnight (end < start) durch +1440min ausgleichen.
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
           count(*)::int as cnt,
           max(j.start_date) as last_date
    from jobs_in_range j
    group by j.location_id
  )
  select
    l.id,
    l.name,
    coalesce(c.cnt, 0),
    coalesce(g.minutes, 0),
    coalesce(s.minutes, 0),
    coalesce(rp.minutes, 0),
    c.last_date
  from loc l
  join counts c on c.location_id = l.id
  left join geplant  g  on g.location_id  = l.id
  left join stempel  s  on s.location_id  = l.id
  left join rapport  rp on rp.location_id = l.id
  order by s.minutes desc nulls last, c.cnt desc;
end;
$$;

revoke execute on function public.get_location_stats(date, date) from public, anon;
grant execute on function public.get_location_stats(date, date) to authenticated;

comment on function public.get_location_stats(date, date) is
  'Analytics: pro Location Auftraegge + Geplant/Stempel/Rapport-Stunden in einem Zeitraum. Admin-only via is_admin()-Guard. Sortiert nach Stempel-Minuten desc.';
