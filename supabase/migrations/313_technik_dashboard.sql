-- 313: Technik-Dashboard «digitaler Zwilling» (docs/technik-dashboard/VERTRAG.md §3).
-- Das Rig meldet alle 60 s ein Messpaket (POST /api/technik/messwerte, Rig-Anmeldung
-- ueber KI_SYNC_TOKEN). Gespeichert werden der letzte Stand je Quelle, Minutenwerte
-- (48 h), Stundenwerte (90 Tage), Ereignisse (90 Tage) und die Ampel-Zustaende fuer
-- Hysterese und Alarm-Drossel. Lesen nur Admins; geschrieben wird ausschliesslich
-- ueber Server-Routen mit service_role. Alle 4 Verben explizit (Muster 274).
-- Idempotent: mehrfach ausfuehrbar ohne Schaden. Nur additiv.

-- ---- Tabellen ---------------------------------------------------------------

-- Letzter Stand je Quelle (3 Zeilen): validierter Block aus dem Paket.
create table if not exists public.technik_stand (
  quelle text primary key check (quelle in ('rig', 'ki', 'nas')),
  werte jsonb not null,
  gemessen_am timestamptz not null,
  empfangen_am timestamptz not null default now()
);

-- Minutenwerte, flach {schluessel: zahl}. Upsert je (quelle, minute) = idempotent.
create table if not exists public.technik_messwerte (
  quelle text not null check (quelle in ('rig', 'ki', 'nas')),
  minute timestamptz not null,
  werte jsonb not null,
  primary key (quelle, minute)
);

-- Stundenwerte {schluessel: {avg, min, max, n}}, aus technik_verdichten().
create table if not exists public.technik_stunden (
  quelle text not null check (quelle in ('rig', 'ki', 'nas')),
  stunde timestamptz not null,
  werte jsonb not null,
  primary key (quelle, stunde)
);

-- Ereignisse: Texte erzeugt das FSM aus Vorlagen, nie Text vom Rig.
create table if not exists public.technik_ereignisse (
  id uuid primary key default gen_random_uuid(),
  zeitpunkt timestamptz not null default now(),
  art text not null check (art in ('zustand', 'neustart', 'absturz', 'alarm', 'entwarnung', 'hinweis')),
  stufe text not null check (stufe in ('gut', 'warnung', 'kritisch', 'hinweis')),
  bauteil text,
  schluessel text,
  text text not null check (char_length(text) <= 300)
);

create index if not exists idx_technik_ereignisse_zeitpunkt
  on public.technik_ereignisse (zeitpunkt desc);
-- Abstuerze der letzten 24 h je Dienst und Rig-Neustarts fuer die Kurven.
create index if not exists idx_technik_ereignisse_art_zeitpunkt
  on public.technik_ereignisse (art, zeitpunkt desc);

-- Ampel-Zustaende (eine Zeile je Ampel): Hysterese, «seit», Alarm-Drossel.
create table if not exists public.technik_zustaende (
  schluessel text primary key,
  stufe text not null check (stufe in ('gut', 'warnung', 'kritisch', 'neutral')),
  seit timestamptz not null,
  kritisch_seit timestamptz,
  alarm_gesendet_am timestamptz,
  alarm_offen boolean not null default false,
  aktualisiert timestamptz not null default now()
);

-- Frische-Abfrage «Datei-Index» (max(aktualisiert)) ohne Seq-Scan.
create index if not exists idx_ablage_datei_index_aktualisiert
  on public.ablage_datei_index (aktualisiert desc);

-- ---- RLS: lesen nur Admins, schreiben nur service_role -------------------------

alter table public.technik_stand enable row level security;
alter table public.technik_messwerte enable row level security;
alter table public.technik_stunden enable row level security;
alter table public.technik_ereignisse enable row level security;
alter table public.technik_zustaende enable row level security;

drop policy if exists "technik_stand_select" on public.technik_stand;
create policy "technik_stand_select" on public.technik_stand for select using ((select public.is_admin()));
drop policy if exists "technik_stand_insert" on public.technik_stand;
create policy "technik_stand_insert" on public.technik_stand for insert with check (false);
drop policy if exists "technik_stand_update" on public.technik_stand;
create policy "technik_stand_update" on public.technik_stand for update using (false);
drop policy if exists "technik_stand_delete" on public.technik_stand;
create policy "technik_stand_delete" on public.technik_stand for delete using (false);

drop policy if exists "technik_messwerte_select" on public.technik_messwerte;
create policy "technik_messwerte_select" on public.technik_messwerte for select using ((select public.is_admin()));
drop policy if exists "technik_messwerte_insert" on public.technik_messwerte;
create policy "technik_messwerte_insert" on public.technik_messwerte for insert with check (false);
drop policy if exists "technik_messwerte_update" on public.technik_messwerte;
create policy "technik_messwerte_update" on public.technik_messwerte for update using (false);
drop policy if exists "technik_messwerte_delete" on public.technik_messwerte;
create policy "technik_messwerte_delete" on public.technik_messwerte for delete using (false);

drop policy if exists "technik_stunden_select" on public.technik_stunden;
create policy "technik_stunden_select" on public.technik_stunden for select using ((select public.is_admin()));
drop policy if exists "technik_stunden_insert" on public.technik_stunden;
create policy "technik_stunden_insert" on public.technik_stunden for insert with check (false);
drop policy if exists "technik_stunden_update" on public.technik_stunden;
create policy "technik_stunden_update" on public.technik_stunden for update using (false);
drop policy if exists "technik_stunden_delete" on public.technik_stunden;
create policy "technik_stunden_delete" on public.technik_stunden for delete using (false);

drop policy if exists "technik_ereignisse_select" on public.technik_ereignisse;
create policy "technik_ereignisse_select" on public.technik_ereignisse for select using ((select public.is_admin()));
drop policy if exists "technik_ereignisse_insert" on public.technik_ereignisse;
create policy "technik_ereignisse_insert" on public.technik_ereignisse for insert with check (false);
drop policy if exists "technik_ereignisse_update" on public.technik_ereignisse;
create policy "technik_ereignisse_update" on public.technik_ereignisse for update using (false);
drop policy if exists "technik_ereignisse_delete" on public.technik_ereignisse;
create policy "technik_ereignisse_delete" on public.technik_ereignisse for delete using (false);

drop policy if exists "technik_zustaende_select" on public.technik_zustaende;
create policy "technik_zustaende_select" on public.technik_zustaende for select using ((select public.is_admin()));
drop policy if exists "technik_zustaende_insert" on public.technik_zustaende;
create policy "technik_zustaende_insert" on public.technik_zustaende for insert with check (false);
drop policy if exists "technik_zustaende_update" on public.technik_zustaende;
create policy "technik_zustaende_update" on public.technik_zustaende for update using (false);
drop policy if exists "technik_zustaende_delete" on public.technik_zustaende;
create policy "technik_zustaende_delete" on public.technik_zustaende for delete using (false);

-- ---- technik_verdichten(): Minuten → Stunden, dann aufraeumen -----------------
-- Verdichtet die vollstaendigen Stunden, die noch in technik_messwerte liegen
-- (je Quelle und Schluessel avg/min/max/n; bei Schluesseln mit Endung «.max»
-- liest technik_reihe das «max» = Maximum der Maxima). Erst danach werden
-- Minuten, Stunden > 90 Tage und Ereignisse > 90 Tage geloescht.
-- Minuten werden nur stundenweise geloescht (Grenze = volle Stunde vor 48 h),
-- deshalb liegt jede Stunde ab dieser Grenze noch vollstaendig vor und darf neu
-- verdichtet werden. Aeltere Stunden werden nie ueberschrieben, nur ergaenzt,
-- falls sie fehlen (z. B. nach einem ausgefallenen Lauf) — so kann eine
-- angeschnittene Stunde nie eine vollstaendige Zeile ersetzen.
-- Laeuft schon eine Verdichtung (Stunden-Cron und db-retention gleichzeitig),
-- kehrt der zweite Aufruf sofort zurueck (Advisory-Lock, kein Deadlock).
-- Mehrfach ausfuehrbar.

create or replace function public.technik_verdichten()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grenze timestamptz := date_trunc('hour', now());
  v_vollstaendig_ab timestamptz := date_trunc('hour', now() - interval '48 hours');
  v_stunden int := 0;
  v_minuten int := 0;
  v_alte_stunden int := 0;
  v_ereignisse int := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('public.technik_verdichten')) then
    return jsonb_build_object('uebersprungen', true);
  end if;

  with werte as (
    select m.quelle, date_trunc('hour', m.minute) as stunde, e.key as schluessel, (e.value #>> '{}')::double precision as wert
    from public.technik_messwerte m
    cross join lateral jsonb_each(m.werte) e
    where m.minute < v_grenze
      and jsonb_typeof(e.value) = 'number'
  ),
  je_schluessel as (
    select quelle, stunde, schluessel,
           jsonb_build_object('avg', avg(wert), 'min', min(wert), 'max', max(wert), 'n', count(*)) as agg
    from werte
    group by quelle, stunde, schluessel
  ),
  je_stunde as (
    select quelle, stunde, jsonb_object_agg(schluessel, agg) as werte
    from je_schluessel
    group by quelle, stunde
  )
  insert into public.technik_stunden (quelle, stunde, werte)
  select quelle, stunde, werte from je_stunde
  on conflict (quelle, stunde) do update set werte = excluded.werte
    where excluded.stunde >= v_vollstaendig_ab;
  get diagnostics v_stunden = row_count;

  delete from public.technik_messwerte where minute < v_vollstaendig_ab;
  get diagnostics v_minuten = row_count;
  delete from public.technik_stunden where stunde < now() - interval '90 days';
  get diagnostics v_alte_stunden = row_count;
  delete from public.technik_ereignisse where zeitpunkt < now() - interval '90 days';
  get diagnostics v_ereignisse = row_count;

  return jsonb_build_object(
    'stunden_verdichtet', v_stunden,
    'minuten_geloescht', v_minuten,
    'stunden_geloescht', v_alte_stunden,
    'ereignisse_geloescht', v_ereignisse
  );
end;
$$;

revoke all on function public.technik_verdichten() from public, anon, authenticated;
grant execute on function public.technik_verdichten() to service_role;

-- ---- technik_reihe(): Kurven in Buckets zu p_schritt_s Sekunden ---------------
-- mittel = Mittel des Schluessels, spitze = Maximum des «.max»-Schluessels
-- (falls vorhanden, sonst Maximum des Mittels). Buckets < 1 h aus den
-- Minutenwerten; Buckets ≥ 1 h aus technik_stunden (gewichtet mit n),
-- ergaenzt um die noch nicht verdichteten Stunden aus technik_messwerte.

create or replace function public.technik_reihe(
  p_quelle text,
  p_von timestamptz,
  p_bis timestamptz,
  p_schritt_s int,
  p_schluessel text[]
)
returns table (t timestamptz, schluessel text, mittel double precision, spitze double precision)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_schritt int := greatest(60, coalesce(p_schritt_s, 60));
begin
  if p_quelle not in ('rig', 'ki', 'nas') or p_von is null or p_bis is null or p_bis <= p_von then
    return;
  end if;

  if v_schritt < 3600 then
    return query
      select to_timestamp(floor(extract(epoch from m.minute) / v_schritt) * v_schritt) as t,
             k.s as schluessel,
             avg(case when jsonb_typeof(m.werte -> k.s) = 'number' then (m.werte ->> k.s)::double precision end) as mittel,
             coalesce(
               max(case when jsonb_typeof(m.werte -> (k.s || '.max')) = 'number' then (m.werte ->> (k.s || '.max'))::double precision end),
               max(case when jsonb_typeof(m.werte -> k.s) = 'number' then (m.werte ->> k.s)::double precision end)
             ) as spitze
      from public.technik_messwerte m
      cross join unnest(p_schluessel) as k(s)
      where m.quelle = p_quelle
        and m.minute >= p_von
        and m.minute < p_bis
        and (m.werte ? k.s or m.werte ? (k.s || '.max'))
      group by 1, 2
      order by 1, 2;
    return;
  end if;

  return query
    with stunden as (
      -- verdichtete Stunden
      select st.stunde,
             k.s,
             case when jsonb_typeof(st.werte -> k.s -> 'avg') = 'number' then (st.werte -> k.s ->> 'avg')::double precision end as avg_wert,
             case when jsonb_typeof(st.werte -> k.s -> 'n') = 'number' then (st.werte -> k.s ->> 'n')::double precision end as n,
             coalesce(
               case when jsonb_typeof(st.werte -> (k.s || '.max') -> 'max') = 'number' then (st.werte -> (k.s || '.max') ->> 'max')::double precision end,
               case when jsonb_typeof(st.werte -> k.s -> 'max') = 'number' then (st.werte -> k.s ->> 'max')::double precision end
             ) as max_wert
      from public.technik_stunden st
      cross join unnest(p_schluessel) as k(s)
      where st.quelle = p_quelle
        and st.stunde >= date_trunc('hour', p_von)
        and st.stunde < p_bis
        and (st.werte ? k.s or st.werte ? (k.s || '.max'))
      union all
      -- noch nicht verdichtete Stunden direkt aus den Minutenwerten
      select date_trunc('hour', m.minute) as stunde,
             k.s,
             avg(case when jsonb_typeof(m.werte -> k.s) = 'number' then (m.werte ->> k.s)::double precision end),
             count(case when jsonb_typeof(m.werte -> k.s) = 'number' then 1 end)::double precision,
             coalesce(
               max(case when jsonb_typeof(m.werte -> (k.s || '.max')) = 'number' then (m.werte ->> (k.s || '.max'))::double precision end),
               max(case when jsonb_typeof(m.werte -> k.s) = 'number' then (m.werte ->> k.s)::double precision end)
             )
      from public.technik_messwerte m
      cross join unnest(p_schluessel) as k(s)
      where m.quelle = p_quelle
        and m.minute >= p_von
        and m.minute < p_bis
        and (m.werte ? k.s or m.werte ? (k.s || '.max'))
        and not exists (
          select 1 from public.technik_stunden x
          where x.quelle = p_quelle and x.stunde = date_trunc('hour', m.minute)
        )
      group by 1, 2
    )
    select to_timestamp(floor(extract(epoch from s.stunde) / v_schritt) * v_schritt) as t,
           s.s as schluessel,
           case when sum(case when s.avg_wert is not null then coalesce(s.n, 1) end) > 0
                then sum(s.avg_wert * coalesce(s.n, 1)) / sum(case when s.avg_wert is not null then coalesce(s.n, 1) end)
           end as mittel,
           max(s.max_wert) as spitze
    from stunden s
    group by 1, 2
    order by 1, 2;
end;
$$;

revoke all on function public.technik_reihe(text, timestamptz, timestamptz, int, text[]) from public, anon, authenticated;
grant execute on function public.technik_reihe(text, timestamptz, timestamptz, int, text[]) to service_role;
