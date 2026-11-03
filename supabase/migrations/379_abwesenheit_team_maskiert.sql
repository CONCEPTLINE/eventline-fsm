-- 379: Abwesenheiten fuer Kolleginnen und Kollegen nur als «abwesend».
--
-- Entscheid (Owner, 2026-11-03): Wer krank ist, erscheint fuer Kolleginnen
-- und Kollegen nur als «abwesend», nie als «krank». Den echten Typ sehen nur
--   * die Person selbst,
--   * Admins,
--   * wer ferien:approve hat (Abwesenheiten entscheiden),
--   * wer tickets:manage hat (operative Leitung, dieselbe Gruppe wie die
--     Beleg-Freigabe).
-- Immer ueber has_permission()/is_admin(), nie ueber Namenslisten.
--
-- Bisher (Migration 257, Policy «time_off_select_team») durften Team-Leitung
-- und Rollen mit scope 'all' die GANZEN Zeilen anderer lesen — inklusive
-- type, note, decision_note und (seit 378) arztzeugnis_*. Eine Spalte laesst
-- sich mit RLS nicht maskieren, darum:
--   1. Direktes SELECT auf fremde Zeilen nur noch fuer die berechtigte
--      Gruppe (eigene Zeilen bleiben ueber «Eigene Ferien sehen» lesbar).
--   2. Kalender, Planung und Konflikt-Warnung lesen fremde Abwesenheiten
--      ueber team_abwesenheiten(): nur Zeitraum/Status/Typ, Typ «krank»
--      fuer Nicht-Berechtigte als «abwesend». Keine Notizen, kein
--      Entscheid-Text, keine Arztzeugnis-Felder. Sichtbar sind dieselben
--      Personen wie bisher (eigene, eigenes Team, scope 'all') plus alle
--      fuer die berechtigte Gruppe.
--   3. get_anwesenheit_abwesenheiten() (Migration 262, Anwesenheits-Karte)
--      maskiert «krank» ebenfalls.
--
-- Reihenfolge beim Deploy: diese Migration VOR dem Code einspielen
-- (der Code ruft team_abwesenheiten() auf). Alter Code laeuft danach
-- weiter, sieht fuer Nicht-Berechtigte aber nur noch eigene Zeilen.
--
-- Idempotent: mehrfaches Ausfuehren ist harmlos.

-- ── 1. Wer darf den echten Abwesenheits-Typ fremder Personen sehen? ──
create or replace function public.darf_abwesenheitsgrund_sehen()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
      or public.has_permission('ferien:approve')
      or public.has_permission('tickets:manage');
$$;

comment on function public.darf_abwesenheitsgrund_sehen() is
  'true = darf fremde Abwesenheiten mit echtem Typ (krank) und Notizen sehen: Admin, ferien:approve, tickets:manage (Migration 379).';

revoke execute on function public.darf_abwesenheitsgrund_sehen() from public, anon;
grant execute on function public.darf_abwesenheitsgrund_sehen() to authenticated;

-- ── 2. Direktes SELECT auf fremde Zeilen nur fuer die berechtigte Gruppe ──
-- «Eigene Ferien sehen» (eigene Zeilen) und «Genehmiger sieht alle Ferien»
-- (ferien:approve) bleiben unveraendert bestehen.
drop policy if exists "time_off_select_team" on public.time_off;
create policy "time_off_select_team" on public.time_off
  for select to authenticated
  using (
    user_id = (select auth.uid())
    -- Ganze Zeilen (Notizen, Arztzeugnis-Felder) nur Admins und Genehmigern;
    -- tickets:manage sieht den Grund nur ueber team_abwesenheiten().
    or (select public.is_admin())
    or (select public.has_permission('ferien:approve'))
  );

-- ── 3. Team-Abwesenheiten fuer Kalender/Planung/Konflikte ──
create or replace function public.team_abwesenheiten(p_von date, p_bis date)
returns table(
  id uuid,
  user_id uuid,
  start_date date,
  end_date date,
  status text,
  ende_offen boolean,
  typ text,
  user_name text,
  user_aktiv boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with ich as (
    select (select auth.uid()) as uid,
           public.darf_abwesenheitsgrund_sehen() as darf,
           public.get_my_scope() as scope,
           public.my_team_user_ids() as team
  )
  select t.id,
         t.user_id,
         t.start_date,
         t.end_date,
         t.status,
         t.ende_offen,
         case
           when t.user_id = ich.uid or ich.darf then t.type
           when t.type = 'krank' then 'abwesend'
           else t.type
         end as typ,
         p.full_name as user_name,
         coalesce(p.is_active, false) as user_aktiv
  from public.time_off t
  cross join ich
  left join public.profiles p on p.id = t.user_id
  where ich.uid is not null
    and t.start_date <= p_bis
    and t.end_date >= p_von
    and (
      t.user_id = ich.uid
      or ich.darf
      or ich.scope = 'all'
      or t.user_id = any (ich.team)
    );
$$;

comment on function public.team_abwesenheiten(date, date) is
  'Abwesenheiten im Zeitraum fuer Kalender/Planung/Konflikte; Typ krank fuer Nicht-Berechtigte als abwesend, ohne Notizen/Arztzeugnis (Migration 379).';

revoke execute on function public.team_abwesenheiten(date, date) from public, anon;
grant execute on function public.team_abwesenheiten(date, date) to authenticated;

-- ── 4. Anwesenheits-Karte (Migration 262): «krank» ebenfalls maskieren ──
create or replace function public.get_anwesenheit_abwesenheiten(p_von date, p_bis date)
returns table(user_id uuid, start_date date, end_date date, type text)
language sql stable security definer set search_path = public as $$
  select t.user_id, t.start_date, t.end_date,
         case
           when t.user_id = (select auth.uid()) or public.darf_abwesenheitsgrund_sehen() then t.type
           when t.type = 'krank' then 'abwesend'
           else t.type
         end as type
  from public.time_off t
  where t.status = 'genehmigt'
    and t.start_date <= p_bis
    and t.end_date >= p_von
    and exists (select 1 from public.get_anwesenheit_users() u where u.id = auth.uid())
    and exists (select 1 from public.get_anwesenheit_users() u where u.id = t.user_id);
$$;

revoke execute on function public.get_anwesenheit_abwesenheiten(date, date) from public, anon;
grant execute on function public.get_anwesenheit_abwesenheiten(date, date) to authenticated;
