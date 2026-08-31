-- 200_location_hourly_rate_and_costs.sql
-- ============================================================
-- Analytics-Erweiterung: pro Location ein "verrechneter Stundensatz"
-- (was wir dem Kunden pro Personenstunde in Rechnung stellen).
-- Umsatz = Stempel × Satz. Vollkosten = Summe(Stempel_MA × Vollkosten_MA/h).
-- Marge = Umsatz - Vollkosten.
--
-- 1) locations.default_hourly_rate_chf: der Satz. NULL = nicht hinterlegt
--    (Umsatz/Marge werden dann in der UI ausgeblendet, keine Fantasie).
--
-- 2) get_location_stats erweitert:
--    - hourly_rate_chf: der Location-Satz (kopiert aus locations-Zeile)
--    - vollkosten_chf: aggregiert aus time_entries JOIN employee_compensation
--      × (1 + firmen-AG-Anteil zum Zeitpunkt des Stempels).
--
-- Die AG-Overrides pro-MA (employee_compensation.employer_*_pct) werden
-- fuer die AG-Anteil-Summe hier vereinfacht IGNORIERT — Location-Analytics
-- ist eine Uebersichts-Schaetzung, keine Lohnabrechnung. Der AG-Anteil kommt
-- aus payroll_defaults zum time_entry-Zeitpunkt (also historisch korrekt
-- bei Rate-Wechseln). Ferienanteil ebenfalls raus — der ist im Lohn schon
-- drin (Ferienanteil-Zuschlag).
-- ============================================================

-- 1) Spalte hinzufuegen
alter table public.locations
  add column if not exists default_hourly_rate_chf numeric(8,2);

comment on column public.locations.default_hourly_rate_chf is
  'Standard-Stundensatz den wir dem Kunden fuer Personenstunden an dieser Location verrechnen. NULL = nicht hinterlegt (Analytics blendet Umsatz/Marge aus).';

-- 2) RPC erweitern (drop + create wegen geaendertem RETURN)
drop function if exists public.get_location_stats(date, date);

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
  last_job_date date,
  hourly_rate_chf numeric(8,2),
  vollkosten_chf numeric(12,2)
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
    select j.id, j.location_id, j.start_date
    from public.jobs j
    where j.location_id is not null
      and j.start_date is not null
      and j.start_date >= p_from
      and j.start_date <= p_to
      and j.status not in ('storniert', 'entwurf', 'archiviert')
  ),
  geplant as (
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
           count(*)::int as cnt,
           max(j.start_date) as last_date
    from jobs_in_range j
    group by j.location_id
  ),
  -- Vollkosten pro Location: je time_entry den aktuellen comp-Row picken,
  -- Vollkosten = wage × (1 + AG-Pct-Summe/100). AG-Pct kommt aus payroll_defaults
  -- zum time_entry-Datum (historisch korrekt bei Rate-Wechsel).
  entries_with_cost as (
    select
      j.location_id,
      t.clock_in,
      extract(epoch from (t.clock_out - t.clock_in)) / 60.0 as minutes,
      c.hourly_wage_chf,
      -- AG-Anteil-Summe aus dem zum Stempel-Zeitpunkt gueltigen payroll_defaults
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
      -- min * (wage × (1 + agPct/100)) / 60 = Vollkosten in CHF
      coalesce(sum(
        (e.minutes / 60.0) * coalesce(e.hourly_wage_chf, 0) * (1 + coalesce(e.ag_pct, 0) / 100.0)
      ), 0)::numeric(12,2) as chf
    from entries_with_cost e
    group by e.location_id
  )
  select
    l.id,
    l.name,
    coalesce(c.cnt, 0),
    coalesce(g.minutes, 0),
    coalesce(s.minutes, 0),
    coalesce(rp.minutes, 0),
    c.last_date,
    l.default_hourly_rate_chf,
    coalesce(v.chf, 0::numeric(12,2))
  from public.locations l
  join counts c on c.location_id = l.id
  left join geplant    g  on g.location_id  = l.id
  left join stempel    s  on s.location_id  = l.id
  left join rapport    rp on rp.location_id = l.id
  left join vollkosten v  on v.location_id  = l.id
  order by s.minutes desc nulls last, c.cnt desc;
end;
$$;

revoke execute on function public.get_location_stats(date, date) from public, anon;
grant execute on function public.get_location_stats(date, date) to authenticated;
