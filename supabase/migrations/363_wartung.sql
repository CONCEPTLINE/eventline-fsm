-- 363: Wartungsmodus-Schalter für Umbauten (Wunsch Mischa, 29.10.2026).
--
-- !! Nummer beim Zusammenführen prüfen: höchste Nummer auf origin/main UND
-- !! allen Branches + 1 (Stand 29.10.2026: 362 auf main, 359 auf lena-telefon).
--
-- Reihenfolge auf Live (supabase/lokal/live-gang-wartung.md):
--   1. DIESE Migration (vor dem Code — der Code liest public.wartung).
--   2. Code-Deploy. Standard = aus (keine Bereiche in Wartung).
--
-- Inhalt (idempotent, nur additiv):
--   1. public.wartung: Singleton mit den Bereichen in Wartung, Grund, seit wann,
--      und den Profil-IDs, die trotz Wartung arbeiten dürfen (Ausnahmen).
--      Nur Server (service_role); der Browser liest den Stand über die App.
--   2. wartung_setzen(): Bereiche ein-/ausschalten, protokolliert im
--      Rechte-Protokoll (wartung.an / wartung.aus). Aufruf aus der App
--      (/api/wartung) und aus scripts/wartung.mjs.
--   3. wartung_ausnahmen_setzen(): Liste der Ausnahmen setzen (nur Skript),
--      protokolliert (wartung.ausnahmen).
--   4. permission_audit_log: Aktionen wartung.*
--   5. lohn_lauf: Status «pausiert» (der Cron pausiert in der Wartung).

-- ===========================================================================
-- 1. public.wartung (Singleton, nur Server)
-- ===========================================================================
create table if not exists public.wartung (
  id text primary key default 'default' check (id = 'default'),
  -- Bereiche in Wartung. Leer = keine Wartung (Standard).
  bereiche text[] not null default '{}'::text[],
  grund text,
  -- Seit wann (mindestens ein Bereich) in Wartung ist; leer, wenn aus.
  seit timestamptz,
  -- Profile, die trotz Wartung normal arbeiten (z. B. Mischa).
  ausnahmen uuid[] not null default '{}'::uuid[],
  geaendert_at timestamptz not null default now(),
  geaendert_von uuid,
  geaendert_von_name text,
  constraint wartung_bereiche_gueltig check (bereiche <@ array['lohn', 'rechte', 'geraete', 'finanzen']::text[])
);
insert into public.wartung (id) values ('default') on conflict (id) do nothing;
alter table public.wartung enable row level security;
revoke all on public.wartung from public, anon, authenticated;
grant select, insert, update on public.wartung to service_role;

comment on table public.wartung is 'Wartungsmodus je Bereich (lohn, rechte, geraete, finanzen). Nur Server; Schalter: /api/wartung, scripts/wartung.mjs. Migration 363.';

-- ===========================================================================
-- 4. Rechte-Protokoll: Aktionen wartung.* (Liste aus 361 + neu)
-- ===========================================================================
alter table public.permission_audit_log drop constraint if exists permission_audit_log_action_check;
alter table public.permission_audit_log add constraint permission_audit_log_action_check check (action = any (array[
  'role.created', 'role.updated', 'role.deleted', 'user.role_changed', 'user.permissions_changed',
  'view_as.started', 'view_as.stopped', 'view_as.write_enabled', 'view_as.write_disabled',
  'device.requested', 'device.approved', 'device.rejected', 'device.revoked', 'device.notfreigabe',
  'lohn.vertretung_changed',
  'rechte.antrag_gestellt', 'rechte.antrag_bestaetigt', 'rechte.antrag_abgelehnt', 'rechte.antrag_notweg',
  'wartung.an', 'wartung.aus', 'wartung.ausnahmen'
]::text[]));

-- ===========================================================================
-- 5. lohn_lauf: Status «pausiert» (Cron in der Wartung)
-- ===========================================================================
alter table public.lohn_lauf drop constraint if exists lohn_lauf_status_check;
alter table public.lohn_lauf add constraint lohn_lauf_status_check
  check (status in ('laeuft', 'ok', 'teilweise', 'fehler', 'abgebrochen', 'pausiert'));

-- ===========================================================================
-- 2. wartung_setzen(): ein-/ausschalten + Protokoll (atomar)
-- ===========================================================================
-- p_an / p_aus: Bereiche, die eingeschaltet bzw. ausgeschaltet werden.
-- p_grund: gilt beim Einschalten (leer = bisheriger Grund bleibt, falls schon
-- etwas in Wartung war). p_actor: Profil (App) oder null (Skript);
-- p_actor_name: Name im Protokoll. Keine Änderung = kein Protokoll-Eintrag.
create or replace function public.wartung_setzen(
  p_an text[],
  p_aus text[],
  p_grund text,
  p_actor uuid,
  p_actor_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gueltig constant text[] := array['lohn', 'rechte', 'geraete', 'finanzen'];
  v_an text[] := coalesce(p_an, '{}'::text[]);
  v_aus text[] := coalesce(p_aus, '{}'::text[]);
  v_alt public.wartung;
  v_neu text[];
  v_dazu text[];
  v_weg text[];
  v_grund text := nullif(trim(coalesce(p_grund, '')), '');
  v_name text := nullif(trim(coalesce(p_actor_name, '')), '');
  v_row public.wartung;
begin
  if not (v_an <@ v_gueltig) or not (v_aus <@ v_gueltig) then
    raise exception 'Wartung: unbekannter Bereich (gültig: lohn, rechte, geraete, finanzen)';
  end if;
  if v_an && v_aus then
    raise exception 'Wartung: derselbe Bereich kann nicht gleichzeitig ein- und ausgeschaltet werden';
  end if;
  if v_name is null then
    raise exception 'Wartung: Name für das Protokoll fehlt';
  end if;

  insert into public.wartung (id) values ('default') on conflict (id) do nothing;
  select * into v_alt from public.wartung where id = 'default' for update;

  -- Neue Menge in fester Reihenfolge (wie v_gueltig).
  select coalesce(array_agg(b order by array_position(v_gueltig, b)), '{}'::text[])
    into v_neu
    from unnest(v_gueltig) b
   where (b = any (v_alt.bereiche) or b = any (v_an)) and not (b = any (v_aus));
  select coalesce(array_agg(b order by array_position(v_gueltig, b)), '{}'::text[])
    into v_dazu from unnest(v_neu) b where not (b = any (v_alt.bereiche));
  select coalesce(array_agg(b order by array_position(v_gueltig, b)), '{}'::text[])
    into v_weg from unnest(v_alt.bereiche) b where not (b = any (v_neu));

  if cardinality(v_dazu) = 0 and cardinality(v_weg) = 0
     and (v_grund is null or cardinality(v_an) = 0 or v_grund is not distinct from v_alt.grund) then
    return jsonb_build_object('bereiche', to_jsonb(v_alt.bereiche), 'grund', v_alt.grund, 'seit', v_alt.seit,
                              'an', '[]'::jsonb, 'aus', '[]'::jsonb);
  end if;

  update public.wartung
     set bereiche = v_neu,
         grund = case
                   when cardinality(v_neu) = 0 then null
                   when cardinality(v_an) > 0 and v_grund is not null then v_grund
                   when cardinality(v_alt.bereiche) = 0 then v_grund
                   else v_alt.grund
                 end,
         seit = case
                  when cardinality(v_neu) = 0 then null
                  when cardinality(v_alt.bereiche) = 0 then now()
                  else coalesce(v_alt.seit, now())
                end,
         geaendert_at = now(),
         geaendert_von = p_actor,
         geaendert_von_name = v_name
   where id = 'default'
  returning * into v_row;

  if cardinality(v_dazu) > 0 or (cardinality(v_an) > 0 and v_grund is not null and v_grund is distinct from v_alt.grund) then
    insert into public.permission_audit_log (actor_profile_id, actor_label, action, details)
    values (p_actor, v_name, 'wartung.an',
            jsonb_build_object('bereiche', to_jsonb(case when cardinality(v_dazu) > 0 then v_dazu else v_an end),
                               'aktiv', to_jsonb(v_neu), 'grund', v_row.grund));
  end if;
  if cardinality(v_weg) > 0 then
    insert into public.permission_audit_log (actor_profile_id, actor_label, action, details)
    values (p_actor, v_name, 'wartung.aus',
            jsonb_build_object('bereiche', to_jsonb(v_weg), 'aktiv', to_jsonb(v_neu)));
  end if;

  return jsonb_build_object('bereiche', to_jsonb(v_row.bereiche), 'grund', v_row.grund, 'seit', v_row.seit,
                            'an', to_jsonb(v_dazu), 'aus', to_jsonb(v_weg));
end;
$$;

-- ===========================================================================
-- 3. wartung_ausnahmen_setzen(): Ausnahmen (nur Skript) + Protokoll
-- ===========================================================================
create or replace function public.wartung_ausnahmen_setzen(
  p_ausnahmen uuid[],
  p_actor uuid,
  p_actor_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
  v_name text := nullif(trim(coalesce(p_actor_name, '')), '');
  v_fehlt int;
  v_namen text[];
begin
  if v_name is null then
    raise exception 'Wartung: Name für das Protokoll fehlt';
  end if;
  select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_ids from unnest(coalesce(p_ausnahmen, '{}'::uuid[])) x;
  select count(*) into v_fehlt from unnest(v_ids) x where not exists (select 1 from public.profiles p where p.id = x);
  if v_fehlt > 0 then
    raise exception 'Wartung: % Profil-ID(s) unbekannt', v_fehlt;
  end if;
  select coalesce(array_agg(coalesce(p.full_name, p.email) order by p.full_name), '{}'::text[])
    into v_namen from public.profiles p where p.id = any (v_ids);

  insert into public.wartung (id) values ('default') on conflict (id) do nothing;
  update public.wartung
     set ausnahmen = v_ids, geaendert_at = now(), geaendert_von = p_actor, geaendert_von_name = v_name
   where id = 'default';

  insert into public.permission_audit_log (actor_profile_id, actor_label, action, details)
  values (p_actor, v_name, 'wartung.ausnahmen', jsonb_build_object('personen', to_jsonb(v_namen)));

  return jsonb_build_object('ausnahmen', to_jsonb(v_ids), 'namen', to_jsonb(v_namen));
end;
$$;

revoke all on function public.wartung_setzen(text[], text[], text, uuid, text) from public, anon, authenticated;
revoke all on function public.wartung_ausnahmen_setzen(uuid[], uuid, text) from public, anon, authenticated;
grant execute on function public.wartung_setzen(text[], text[], text, uuid, text) to service_role;
grant execute on function public.wartung_ausnahmen_setzen(uuid[], uuid, text) to service_role;
