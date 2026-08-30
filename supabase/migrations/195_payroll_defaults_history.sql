-- 195_payroll_defaults_history.sql
-- ============================================================
-- Firmenweite Lohn-Standardwerte MIT effective_from-Historie.
--
-- Motivation: Bisher lagen die 12 Prozentsaetze + bvg_threshold direkt
-- auf app_settings (Singleton id=1) — OHNE Historie. Jede SUVA-Praemien-
-- Anpassung ueberschrieb den Wert; alte Lohnabrechnungen wurden bei
-- Regenerate retroaktiv mit dem NEUEN Satz berechnet (Bug).
--
-- Neu: eigene Tabelle payroll_defaults, Multi-Row, jeder Datensatz gilt
-- ab effective_from. Lesen: WHERE effective_from <= :asOf ORDER BY
-- effective_from DESC LIMIT 1. Damit:
--   - historisch korrekt (alte Abrechnungen bleiben stabil)
--   - Jahreswechsel: einfach neue Zeile mit effective_from='2027-01-01'
--     anlegen — greift am 1.1. automatisch, kein Cron noetig
--   - Historie = SELECT * FROM payroll_defaults ORDER BY effective_from
--
-- Idempotent: bei erneuter Ausfuehrung wird die Tabelle nicht neu
-- angelegt, der Seed nur wenn leer.
-- ============================================================

-- 1. Tabelle anlegen
create table if not exists public.payroll_defaults (
  id uuid primary key default gen_random_uuid(),
  effective_from date not null unique,

  -- Mitarbeiter-Abzuege (% vom Brutto)
  default_ahv_iv_eo_pct numeric(7,4) not null,
  default_alv_pct numeric(7,4) not null,
  default_nbu_pct numeric(7,4) not null,
  default_bvg_pct numeric(7,4) not null,
  default_ktg_pct numeric(7,4) not null,
  default_quellensteuer_pct numeric(7,4) not null,

  -- Arbeitgeber-Anteil (% vom Brutto)
  default_employer_ahv_pct numeric(7,4) not null,
  default_employer_alv_pct numeric(7,4) not null,
  default_employer_fak_pct numeric(7,4) not null,
  default_employer_bu_pct numeric(7,4) not null,
  default_employer_bvg_pct numeric(7,4) not null,
  default_employer_verwaltung_pct numeric(7,4) not null,

  -- BVG-Eintrittsschwelle (CHF/Monat) — Migration 148/160
  bvg_threshold_chf numeric(10,2) not null default 1837.50,

  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payroll_defaults_pcts_range check (
    default_ahv_iv_eo_pct between 0 and 100
    and default_alv_pct between 0 and 100
    and default_nbu_pct between 0 and 100
    and default_bvg_pct between 0 and 100
    and default_ktg_pct between 0 and 100
    and default_quellensteuer_pct between 0 and 100
    and default_employer_ahv_pct between 0 and 100
    and default_employer_alv_pct between 0 and 100
    and default_employer_fak_pct between 0 and 100
    and default_employer_bu_pct between 0 and 100
    and default_employer_bvg_pct between 0 and 100
    and default_employer_verwaltung_pct between 0 and 100
    and bvg_threshold_chf >= 0
  )
);

create index if not exists payroll_defaults_effective_from_desc_idx
  on public.payroll_defaults (effective_from desc);

-- updated_at Trigger
create or replace function public.payroll_defaults_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists payroll_defaults_updated_at on public.payroll_defaults;
create trigger payroll_defaults_updated_at
  before update on public.payroll_defaults
  for each row execute function public.payroll_defaults_touch_updated_at();

-- 2. RLS: gleiche Semantik wie app_settings — nur Admin/lohn:manage
alter table public.payroll_defaults enable row level security;

drop policy if exists payroll_defaults_select on public.payroll_defaults;
create policy payroll_defaults_select on public.payroll_defaults
  for select using (public.has_permission('lohn:manage'));

drop policy if exists payroll_defaults_insert on public.payroll_defaults;
create policy payroll_defaults_insert on public.payroll_defaults
  for insert with check (public.has_permission('lohn:manage'));

drop policy if exists payroll_defaults_update on public.payroll_defaults;
create policy payroll_defaults_update on public.payroll_defaults
  for update using (public.has_permission('lohn:manage'))
             with check (public.has_permission('lohn:manage'));

drop policy if exists payroll_defaults_delete on public.payroll_defaults;
create policy payroll_defaults_delete on public.payroll_defaults
  for delete using (public.has_permission('lohn:manage'));

-- 3. Seed: aktuelle app_settings-Werte als Baseline uebernehmen mit
--    effective_from='2020-01-01' (weit in Vergangenheit — deckt alle
--    bestehenden Lohnabrechnungen ab). Nur wenn Tabelle leer.
insert into public.payroll_defaults (
  effective_from,
  default_ahv_iv_eo_pct, default_alv_pct, default_nbu_pct,
  default_bvg_pct, default_ktg_pct, default_quellensteuer_pct,
  default_employer_ahv_pct, default_employer_alv_pct, default_employer_fak_pct,
  default_employer_bu_pct, default_employer_bvg_pct, default_employer_verwaltung_pct,
  bvg_threshold_chf,
  notes
)
select
  '2020-01-01'::date,
  coalesce(a.default_ahv_iv_eo_pct, 5.3),
  coalesce(a.default_alv_pct, 1.1),
  coalesce(a.default_nbu_pct, 1.4),
  coalesce(a.default_bvg_pct, 0),
  coalesce(a.default_ktg_pct, 0),
  coalesce(a.default_quellensteuer_pct, 0),
  coalesce(a.default_employer_ahv_pct, 5.3),
  coalesce(a.default_employer_alv_pct, 1.1),
  coalesce(a.default_employer_fak_pct, 1.5),
  coalesce(a.default_employer_bu_pct, 0.5),
  coalesce(a.default_employer_bvg_pct, 3.0),
  coalesce(a.default_employer_verwaltung_pct, 0.5),
  coalesce(a.bvg_threshold_chf, 1837.50),
  'Baseline aus app_settings (Migration 195)'
from public.app_settings a
where a.id = 1
  and not exists (select 1 from public.payroll_defaults);

-- Falls app_settings-Row fehlt (Fresh-Install), Fallback-Baseline:
insert into public.payroll_defaults (
  effective_from,
  default_ahv_iv_eo_pct, default_alv_pct, default_nbu_pct,
  default_bvg_pct, default_ktg_pct, default_quellensteuer_pct,
  default_employer_ahv_pct, default_employer_alv_pct, default_employer_fak_pct,
  default_employer_bu_pct, default_employer_bvg_pct, default_employer_verwaltung_pct,
  bvg_threshold_chf,
  notes
)
select
  '2020-01-01'::date,
  5.3, 1.1, 1.4, 0, 0, 0,
  5.3, 1.1, 1.5, 0.5, 3.0, 0.5,
  1837.50,
  'Fallback-Baseline (Migration 195, kein app_settings-Row gefunden)'
where not exists (select 1 from public.payroll_defaults);

-- 4. Alte Spalten auf app_settings droppen — Source of Truth ist nun
--    payroll_defaults. bvg_threshold_chf ebenfalls raus (jetzt in
--    payroll_defaults, historisierbar).
alter table public.app_settings
  drop column if exists default_ahv_iv_eo_pct,
  drop column if exists default_alv_pct,
  drop column if exists default_nbu_pct,
  drop column if exists default_bvg_pct,
  drop column if exists default_ktg_pct,
  drop column if exists default_quellensteuer_pct,
  drop column if exists default_employer_ahv_pct,
  drop column if exists default_employer_alv_pct,
  drop column if exists default_employer_fak_pct,
  drop column if exists default_employer_bu_pct,
  drop column if exists default_employer_bvg_pct,
  drop column if exists default_employer_verwaltung_pct,
  drop column if exists bvg_threshold_chf;

-- 5. Helper-RPC: die zum Datum gueltigen Defaults holen. Genutzt vom
--    Backend-Code (loadLohnDefaults) statt Client-side query.
create or replace function public.get_payroll_defaults_as_of(p_as_of date)
returns setof public.payroll_defaults
language sql stable security definer
set search_path = public
as $$
  select *
  from public.payroll_defaults
  where effective_from <= p_as_of
  order by effective_from desc
  limit 1;
$$;

grant execute on function public.get_payroll_defaults_as_of(date) to authenticated;

comment on table public.payroll_defaults is
  'Firmen-Lohn-Standardwerte mit effective_from-Historie. Neuer Datensatz = neue Zeile mit dem Datum ab dem die Werte gelten. Aktueller Stand = latest row where effective_from <= today. Zukunft = rows where effective_from > today (greifen automatisch).';
