-- 361: Lohn-Umbau Phase 1 — Vier Augen bei Rechten (Strohmann-Schutz).
--
-- !! Nummer beim Zusammenführen prüfen: höchste Nummer auf origin/main UND
-- !! allen Branches + 1 (Stand 29.10.2026 abends: 359 auf lena-telefon, 356 auf vertrieb-einfach).
--
-- Entscheid der Firma 29.10.2026: Wer Lohndaten sehen kann, entscheidet nie
-- ein Admin allein. Folgende Änderungen sind nur noch als ANTRAG möglich, den
-- der ANDERE Admin auf einem vertrauten Gerät bestätigt (24 h, protokolliert):
--   - Admin-Rolle vergeben oder entziehen (auch Reaktivieren eines Admins)
--   - eine Rolle mit Lohnrecht (lohn:manage) vergeben oder entziehen
--   - das Lohnrecht einer Rolle geben oder nehmen
--   - die Vertretung (lohn_einstellungen) ändern
-- Deaktivieren bleibt sofort möglich (entzieht nur, Notfall).
--
-- Durchsetzung zweifach:
--   Server  /api/admin/users/[id], /api/admin/roles*, /api/hr/lohn-einstellungen
--           stellen Anträge; /api/admin/rechte-antraege bestätigt (Gerät!).
--   DB      Trigger auf profiles, roles, lohn_einstellungen lassen diese
--           Änderungen NUR innerhalb von rechte_antrag_ausfuehren() zu (setzt
--           lohn.rechte_antrag transaktionslokal). Kein Direktzugriff (REST mit
--           Admin-Login, Service-Schlüssel) kommt vorbei.
-- Notweg (kein zweiter Admin erreichbar): scripts/rechte-notfreigabe.mjs (Mischa,
-- mit Grund, protokolliert).
--
-- Reihenfolge Live: mit 360 VOR dem Code-Deploy. Idempotent.
-- Rückweg: supabase/lokal/live-gang-phase1/361_rueckweg.sql.

-- ---------------------------------------------------------------------------
-- 1. Öffnet eine Rolle Lohndaten?
-- ---------------------------------------------------------------------------
create or replace function public.rolle_oeffnet_lohn(p_slug text, p_permissions jsonb)
returns boolean
language sql
immutable
as $$
  select p_slug = 'admin' or coalesce(p_permissions ? 'lohn:manage', false);
$$;

create or replace function public.rolle_oeffnet_lohn(p_slug text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select public.rolle_oeffnet_lohn(r.slug, r.permissions) from public.roles r where r.slug = p_slug), p_slug = 'admin');
$$;

-- ---------------------------------------------------------------------------
-- 2. Anträge
-- ---------------------------------------------------------------------------
create table if not exists public.rechte_antraege (
  id uuid primary key default gen_random_uuid(),
  art text not null check (art in ('person', 'rolle_rechte', 'vertretung')),
  -- person: ziel_profile_id + payload {rolle_alt, rolle_neu, aktivieren}
  -- rolle_rechte: ziel_rolle + payload {lohn: true|false}
  -- vertretung: payload {vertretung_profile_id, vertretung_name}
  ziel_profile_id uuid,
  ziel_name text,
  ziel_rolle text,
  payload jsonb not null default '{}'::jsonb,
  beschreibung text not null,
  -- Gewährt der Antrag Zugang (true) oder entzieht er ihn (false)?
  gewaehrt boolean not null,
  status text not null default 'offen' check (status in ('offen', 'bestaetigt', 'abgelehnt')),
  beantragt_von uuid not null,
  beantragt_von_name text,
  beantragt_at timestamptz not null default now(),
  gueltig_bis timestamptz not null default now() + interval '24 hours',
  entschieden_von uuid,
  entschieden_von_name text,
  entschieden_at timestamptz,
  notweg_grund text
);
create index if not exists rechte_antraege_offen_idx on public.rechte_antraege (beantragt_at desc) where status = 'offen';
alter table public.rechte_antraege enable row level security;
revoke all on public.rechte_antraege from public, anon, authenticated;
grant select, insert, update on public.rechte_antraege to service_role;

drop trigger if exists rechte_antraege_lohn_schutz on public.rechte_antraege;
create trigger rechte_antraege_lohn_schutz
  before delete on public.rechte_antraege
  for each row execute function public.lohn_schutz_nie_loeschen();

-- Rechte-Protokoll: Aktionen der Anträge
alter table public.permission_audit_log drop constraint if exists permission_audit_log_action_check;
alter table public.permission_audit_log add constraint permission_audit_log_action_check check (action = any (array[
  'role.created', 'role.updated', 'role.deleted', 'user.role_changed', 'user.permissions_changed',
  'view_as.started', 'view_as.stopped', 'view_as.write_enabled', 'view_as.write_disabled',
  'device.requested', 'device.approved', 'device.rejected', 'device.revoked', 'device.notfreigabe',
  'lohn.vertretung_changed',
  'rechte.antrag_gestellt', 'rechte.antrag_bestaetigt', 'rechte.antrag_abgelehnt', 'rechte.antrag_notweg'
]::text[]));

-- ---------------------------------------------------------------------------
-- 3. Schutz-Trigger (nur innerhalb von rechte_antrag_ausfuehren erlaubt)
-- ---------------------------------------------------------------------------
create or replace function public.lohn_rechte_schutz_profil()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alt_admin boolean := false;
  v_alt_lohn boolean := false;
  v_neu_admin boolean;
  v_neu_lohn boolean;
begin
  if coalesce(current_setting('lohn.rechte_antrag', true), '') = 'an' then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    -- Nur deaktivieren (Rolle unverändert) entzieht und bleibt sofort möglich.
    -- (NULL zaehlt wie in has_permission als inaktiv.)
    if old.role is not distinct from new.role and coalesce(old.is_active, false) and not coalesce(new.is_active, false) then
      return new;
    end if;
    v_alt_admin := coalesce(old.is_active, false) and old.role = 'admin';
    v_alt_lohn := coalesce(old.is_active, false) and coalesce(public.rolle_oeffnet_lohn(old.role), false);
  end if;
  v_neu_admin := coalesce(new.is_active, false) and new.role = 'admin';
  v_neu_lohn := coalesce(new.is_active, false) and coalesce(public.rolle_oeffnet_lohn(new.role), false);
  if v_alt_admin <> v_neu_admin or v_alt_lohn <> v_neu_lohn then
    raise exception 'profiles: Admin-Rolle bzw. Lohnrecht ändern geht nur per Antrag, den der andere Admin bestätigt (Vier Augen)'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_lohn_rechte_schutz on public.profiles;
create trigger profiles_lohn_rechte_schutz
  before insert or update of role, is_active on public.profiles
  for each row execute function public.lohn_rechte_schutz_profil();

create or replace function public.lohn_rechte_schutz_rolle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alt boolean;
  v_neu boolean;
begin
  if coalesce(current_setting('lohn.rechte_antrag', true), '') = 'an' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    if public.rolle_oeffnet_lohn(new.slug, new.permissions) then
      raise exception 'roles: eine Rolle mit Lohnrecht entsteht nur per Antrag (Vier Augen) — erst ohne Lohnrecht anlegen' using errcode = 'P0001';
    end if;
    return new;
  end if;
  v_alt := public.rolle_oeffnet_lohn(old.slug, old.permissions);
  if tg_op = 'DELETE' then
    if v_alt and exists (select 1 from public.profiles p where p.role = old.slug and p.is_active) then
      raise exception 'roles: eine Rolle mit Lohnrecht und aktiven Personen ist nicht löschbar' using errcode = 'P0001';
    end if;
    return old;
  end if;
  v_neu := public.rolle_oeffnet_lohn(new.slug, new.permissions);
  if old.slug is distinct from new.slug then
    -- profiles.role haengt am Namen (ohne Fremdschluessel): umbenennen wuerde
    -- Personen von ihrer Rolle loesen bzw. einer neuen gleichnamigen zuordnen.
    raise exception 'roles: Rollen werden nicht umbenannt (Rechte haengen am Namen)' using errcode = 'P0001';
  end if;
  if v_alt <> v_neu then
    raise exception 'roles: das Lohnrecht einer Rolle ändern geht nur per Antrag, den der andere Admin bestätigt (Vier Augen)'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists roles_lohn_rechte_schutz on public.roles;
create trigger roles_lohn_rechte_schutz
  before insert or update or delete on public.roles
  for each row execute function public.lohn_rechte_schutz_rolle();

create or replace function public.lohn_rechte_schutz_vertretung()
returns trigger
language plpgsql
as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'lohn_einstellungen: nicht löschbar' using errcode = 'P0001';
  end if;
  if coalesce(current_setting('lohn.rechte_antrag', true), '') <> 'an'
     and ((tg_op = 'INSERT' and new.vertretung_profile_id is not null)
          or (tg_op = 'UPDATE' and new.vertretung_profile_id is distinct from old.vertretung_profile_id)) then
    raise exception 'lohn_einstellungen: die Vertretung ändern geht nur per Antrag, den der andere Admin bestätigt (Vier Augen)'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists lohn_einstellungen_rechte_schutz on public.lohn_einstellungen;
create trigger lohn_einstellungen_rechte_schutz
  before insert or update or delete on public.lohn_einstellungen
  for each row execute function public.lohn_rechte_schutz_vertretung();
drop trigger if exists lohn_einstellungen_rechte_schutz_truncate on public.lohn_einstellungen;
create trigger lohn_einstellungen_rechte_schutz_truncate
  before truncate on public.lohn_einstellungen
  for each statement execute function public.lohn_rechte_schutz_vertretung();

-- ---------------------------------------------------------------------------
-- 4. Antrag ausführen (nur service_role). Prüft in der DB:
--    offen, nicht abgelaufen, Bestätiger = aktiver Admin, nicht der
--    Antragsteller, bei Gewährung nicht die Zielperson. Das vertraute Gerät
--    des Bestätigers prüft der Server (/api/admin/rechte-antraege).
--    Notweg: p_bestaetiger null + p_notweg_grund (scripts/rechte-notfreigabe.mjs).
-- ---------------------------------------------------------------------------
create or replace function public.rechte_antrag_ausfuehren(
  p_id uuid,
  p_bestaetiger uuid,
  p_bestaetiger_name text,
  p_notweg_grund text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.rechte_antraege%rowtype;
  v_ist_admin boolean;
  v_perms jsonb;
  v_rolle_jetzt text;
  v_notweg boolean := coalesce(trim(p_notweg_grund), '') <> '';
begin
  select * into a from public.rechte_antraege where id = p_id for update;
  if a.id is null then raise exception 'Antrag nicht gefunden'; end if;
  if a.status <> 'offen' then raise exception 'Antrag ist nicht mehr offen'; end if;
  if a.gueltig_bis <= now() then raise exception 'Antrag ist abgelaufen (älter als 24 h) — bitte neu stellen'; end if;

  if not v_notweg then
    if p_bestaetiger is null then raise exception 'Bestätiger fehlt'; end if;
    select (p.role = 'admin' and p.is_active) into v_ist_admin from public.profiles p where p.id = p_bestaetiger;
    if coalesce(v_ist_admin, false) is false then raise exception 'Bestätigen kann nur ein aktiver Admin'; end if;
    if p_bestaetiger = a.beantragt_von then raise exception 'Den eigenen Antrag bestätigt der andere Admin (Vier Augen)'; end if;
    if a.gewaehrt and p_bestaetiger is not distinct from a.ziel_profile_id then
      raise exception 'Eigene Rechte bestätigt der andere Admin (Vier Augen)';
    end if;
  end if;

  perform set_config('lohn.rechte_antrag', 'an', true);

  if a.art = 'person' then
    select role into v_rolle_jetzt from public.profiles where id = a.ziel_profile_id for update;
    if v_rolle_jetzt is null then raise exception 'Person nicht gefunden'; end if;
    if (a.payload ? 'rolle_alt') and v_rolle_jetzt is distinct from (a.payload ->> 'rolle_alt') then
      raise exception 'Antrag veraltet: die Rolle wurde inzwischen geändert';
    end if;
    update public.profiles
       set role = coalesce(a.payload ->> 'rolle_neu', role),
           is_active = case when coalesce((a.payload ->> 'aktivieren')::boolean, false) then true else is_active end
     where id = a.ziel_profile_id;
  elsif a.art = 'rolle_rechte' then
    select permissions into v_perms from public.roles where slug = a.ziel_rolle for update;
    if v_perms is null then raise exception 'Rolle nicht gefunden'; end if;
    -- Wer bekommt das Lohnrecht? Genau die Personen, die beim Antrag in der
    -- Rolle waren (payload.mitglieder) — sonst ist der Antrag veraltet.
    if a.gewaehrt and coalesce((
         select array_agg(p.id::text order by p.id::text) from public.profiles p
          where p.role = a.ziel_rolle and coalesce(p.is_active, false)), '{}'::text[])
       is distinct from coalesce((
         select array_agg(e ->> 'id' order by e ->> 'id') from jsonb_array_elements(coalesce(a.payload -> 'mitglieder', '[]'::jsonb)) e), '{}'::text[]) then
      raise exception 'Antrag veraltet: die Personen in dieser Rolle haben sich seit dem Antrag geändert — bitte neu beantragen';
    end if;
    if (a.payload ->> 'lohn')::boolean then
      if not (v_perms ? 'lohn:manage') then v_perms := v_perms || '["lohn:manage"]'::jsonb; end if;
    else
      v_perms := coalesce((select jsonb_agg(e) from jsonb_array_elements(v_perms) e where e <> '"lohn:manage"'::jsonb), '[]'::jsonb);
    end if;
    update public.roles set permissions = v_perms where slug = a.ziel_rolle;
  elsif a.art = 'vertretung' then
    update public.lohn_einstellungen
       set vertretung_profile_id = nullif(a.payload ->> 'vertretung_profile_id', '')::uuid,
           vertretung_name = a.payload ->> 'vertretung_name',
           updated_at = now(), updated_by = p_bestaetiger, updated_by_name = coalesce(p_bestaetiger_name, 'Notweg')
     where id = 'default';
  end if;

  update public.rechte_antraege
     set status = 'bestaetigt', entschieden_von = p_bestaetiger,
         entschieden_von_name = case when v_notweg then 'Notweg: ' || coalesce(p_bestaetiger_name, '?') else p_bestaetiger_name end,
         entschieden_at = now(), notweg_grund = case when v_notweg then trim(p_notweg_grund) end
   where id = a.id;

  insert into public.permission_audit_log (actor_profile_id, actor_label, action, target_profile_id, target_profile_label, target_role_slug, details)
  values (
    p_bestaetiger,
    case when v_notweg then 'Notweg: ' || coalesce(p_bestaetiger_name, '?') else p_bestaetiger_name end,
    case when v_notweg then 'rechte.antrag_notweg' else 'rechte.antrag_bestaetigt' end,
    a.ziel_profile_id, a.ziel_name, a.ziel_rolle,
    jsonb_build_object('antrag_id', a.id, 'art', a.art, 'beschreibung', a.beschreibung, 'payload', a.payload,
                       'beantragt_von', a.beantragt_von_name, 'grund', nullif(trim(coalesce(p_notweg_grund, '')), '')));

  return jsonb_build_object('id', a.id, 'art', a.art, 'ziel_profile_id', a.ziel_profile_id, 'ziel_rolle', a.ziel_rolle, 'payload', a.payload);
end;
$$;

revoke all on function public.rechte_antrag_ausfuehren(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.rechte_antrag_ausfuehren(uuid, uuid, text, text) to service_role;
revoke all on function public.rolle_oeffnet_lohn(text) from public, anon;
grant execute on function public.rolle_oeffnet_lohn(text) to authenticated, service_role;
