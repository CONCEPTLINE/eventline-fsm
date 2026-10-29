-- 360: Lohn-Umbau Phase 1 «Gefahren und Sicherheit» — Teil A (additiv).
--
-- !! Nummer beim Zusammenführen prüfen: höchste Nummer auf origin/main UND
-- !! allen Branches + 1 (Stand 29.10.2026 abends: 359 auf lena-telefon, 356 auf vertrieb-einfach).
--
-- Reihenfolge auf Live (supabase/lokal/live-gang-phase1/LIVE-GANG.md):
--   1. DIESE Migration + 361 (vor dem Code-Deploy — der neue Code ruft die RPCs).
--   2. Code-Deploy (Leser auf Server umgestellt).
--   3. Migration 362 (Rechte im Browser entziehen).
--   Später, wenn der fassungsfähige Code live ist: Folgemigration
--   «Einmaligkeits-Regel» (liegt in live-gang-phase1/spaeter/).
--
-- Inhalt (alles idempotent, nur additiv bzw. Rechte verengen, die der
-- Browser nachweislich nicht nutzt):
--   1. wage_documents: Fassungen (version, superseded_*) + Papierkorb (archived_*)
--   2. lohn_dokument_protokoll: jede Aktion an Lohndokumenten (nur anhängen)
--   3. lohn_lauf: Status des automatischen Laufs (sichtbar in der App)
--   4. lohn_einstellungen: Vertretung (Vier Augen, Gerätefreigabe), Lauf ab Monat
--   5. lohn_dossiers: Register der Lohn-Dossiers mit Aufbewahrungsdatum (10 Jahre)
--   6. trusted_devices: Freigabe durch anderen Admin/Vertretung, Schreiben nur Server
--   7. RPCs (nur service_role): Fassung speichern, Papierkorb, Lauf, Notweg
--   8. Löschschutz-Trigger: Lohnzeilen, Fassungen (auch Datei/Periode), Stempel,
--      Abwesenheiten (auch kein Zurücksetzen eines Entscheids), Firmensätze, Profile
--   9. permission_audit_log: Aktionen «Ansicht als» und Gerätefreigabe
--  10. get_monthly_payroll_stats: auch für den Server (service_role) aufrufbar
--  11. anon: keine Rechte auf Lohn-Objekte

-- ===========================================================================
-- 1. wage_documents: Fassungen + Papierkorb
-- ===========================================================================
-- Gültige Fassung = archived_at IS NULL AND superseded_at IS NULL.
-- Solange die Einmaligkeits-Regel wage_doc_unique_per_period besteht, gibt es
-- je Person/Typ/Jahr/Monat genau eine Zeile; eine neue Fassung zeigt dann auf
-- die neue Datei (Speicherpfad je Fassung), die alte Datei bleibt im Speicher
-- und steht im Protokoll. Nach der Folgemigration entsteht je Fassung eine Zeile.
alter table public.wage_documents add column if not exists version integer not null default 1;
alter table public.wage_documents add column if not exists superseded_at timestamptz;
alter table public.wage_documents add column if not exists superseded_by uuid;
alter table public.wage_documents add column if not exists archived_at timestamptz;
alter table public.wage_documents add column if not exists archived_by uuid;
alter table public.wage_documents add column if not exists archived_by_name text;
alter table public.wage_documents add column if not exists archive_reason text;

create index if not exists wage_documents_gueltig_idx
  on public.wage_documents (profile_id, doc_type, year, period_month)
  where archived_at is null and superseded_at is null;

comment on column public.wage_documents.version is 'Fassung je Person/Typ/Jahr/Monat (1, 2, …). Phase 1 Lohn-Umbau.';
comment on column public.wage_documents.superseded_at is 'Durch eine neuere Fassung ersetzt (nur ohne Einmaligkeits-Regel).';
comment on column public.wage_documents.archived_at is 'Im Papierkorb (nie endgültig gelöscht).';

-- ===========================================================================
-- 2. lohn_dokument_protokoll (nur anhängen)
-- ===========================================================================
create table if not exists public.lohn_dokument_protokoll (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  aktion text not null check (aktion in ('erstellt', 'hochgeladen', 'archiviert', 'wiederhergestellt')),
  wage_document_id uuid,
  profile_id uuid,
  profile_name text,
  doc_type text,
  year integer,
  period_month integer,
  version integer,
  vorherige_version integer,
  storage_path text,
  vorheriger_storage_path text,
  modus text,
  actor_profile_id uuid,
  actor_name text,
  system boolean not null default false,
  grund text,
  details jsonb not null default '{}'::jsonb
);
create index if not exists lohn_dokument_protokoll_profil_idx on public.lohn_dokument_protokoll (profile_id, occurred_at desc);
create index if not exists lohn_dokument_protokoll_doc_idx on public.lohn_dokument_protokoll (wage_document_id);
alter table public.lohn_dokument_protokoll enable row level security;
revoke all on public.lohn_dokument_protokoll from public, anon, authenticated;
grant select, insert on public.lohn_dokument_protokoll to service_role;

-- ===========================================================================
-- 3. lohn_lauf (Status des automatischen Laufs)
-- ===========================================================================
create table if not exists public.lohn_lauf (
  id uuid primary key default gen_random_uuid(),
  gestartet_at timestamptz not null default now(),
  beendet_at timestamptz,
  ausloeser text not null default 'cron' check (ausloeser in ('cron', 'manuell')),
  status text not null default 'laeuft' check (status in ('laeuft', 'ok', 'teilweise', 'fehler', 'abgebrochen')),
  erstellt integer not null default 0,
  fehler integer not null default 0,
  offen integer not null default 0,
  ergebnisse jsonb not null default '[]'::jsonb,
  hinweise jsonb not null default '[]'::jsonb,
  zusammenfassung text
);
create index if not exists lohn_lauf_gestartet_idx on public.lohn_lauf (gestartet_at desc);
-- Nie zwei Läufe gleichzeitig (Doppel-Aufruf des Crons).
create unique index if not exists lohn_lauf_nur_einer on public.lohn_lauf ((true)) where status = 'laeuft';
alter table public.lohn_lauf enable row level security;
revoke all on public.lohn_lauf from public, anon, authenticated;
grant select, insert, update on public.lohn_lauf to service_role;

-- ===========================================================================
-- 4. lohn_einstellungen (Singleton, nur Server)
-- ===========================================================================
create table if not exists public.lohn_einstellungen (
  id text primary key default 'default' check (id = 'default'),
  -- Vertretung: darf (wie der andere Admin) Geräte freigeben und den Lohn
  -- der Lohn-Verwalter ändern (Vier Augen). Leer = nur Admins.
  vertretung_profile_id uuid references public.profiles(id) on delete set null,
  vertretung_name text,
  -- Der automatische Lauf holt gesperrte Monate erst ab diesem Monat nach.
  -- Frühere Monate gehören zur Korrektur (Phase K) und werden nie automatisch
  -- erzeugt. 2026-10-01 = erster Monat, den der neue Lauf abrechnet (7.11.).
  lauf_ab date not null default '2026-10-01',
  updated_at timestamptz not null default now(),
  updated_by uuid,
  updated_by_name text
);
insert into public.lohn_einstellungen (id) values ('default') on conflict (id) do nothing;
alter table public.lohn_einstellungen enable row level security;
revoke all on public.lohn_einstellungen from public, anon, authenticated;
grant select, insert, update on public.lohn_einstellungen to service_role;

-- ===========================================================================
-- 5. lohn_dossiers (Register, Aufbewahrung 10 Jahre, nie gelöscht)
-- ===========================================================================
-- Bewusst ohne Fremdschlüssel auf profiles: das Dossier muss das Profil
-- überdauern (es wird vor dem Löschen eines Benutzers erstellt).
create table if not exists public.lohn_dossiers (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid,
  profile_name text,
  storage_bucket text not null default 'personal-dossiers',
  storage_path text not null unique,
  file_size bigint,
  erstellt_at timestamptz not null default now(),
  erstellt_von uuid,
  erstellt_von_name text,
  aufbewahren_bis date not null
);
create index if not exists lohn_dossiers_profil_idx on public.lohn_dossiers (profile_id);
alter table public.lohn_dossiers enable row level security;
revoke all on public.lohn_dossiers from public, anon, authenticated;
grant select, insert on public.lohn_dossiers to service_role;

-- Bestehende Dossiers im Speicher nachtragen (Aufbewahrung ab Erstellung).
insert into public.lohn_dossiers (profile_id, storage_path, file_size, erstellt_at, aufbewahren_bis)
select
  case when split_part(o.name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       then split_part(o.name, '/', 1)::uuid end,
  o.name,
  nullif(o.metadata ->> 'size', '')::bigint,
  coalesce(o.created_at, now()),
  ((coalesce(o.created_at, now()) at time zone 'Europe/Zurich')::date + interval '10 years')::date
from storage.objects o
where o.bucket_id = 'personal-dossiers'
on conflict (storage_path) do nothing;

update public.lohn_dossiers d
   set profile_name = p.full_name
  from public.profiles p
 where d.profile_id = p.id and d.profile_name is null;

-- ===========================================================================
-- 6. trusted_devices: Freigabe per Knopf, Schreiben nur durch den Server
-- ===========================================================================
alter table public.trusted_devices add column if not exists approved_by uuid;
alter table public.trusted_devices add column if not exists approved_by_name text;
alter table public.trusted_devices add column if not exists freigabe_art text;
alter table public.trusted_devices add column if not exists anfrage_gueltig_bis timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'trusted_devices_freigabe_art_check') then
    alter table public.trusted_devices
      add constraint trusted_devices_freigabe_art_check
      check (freigabe_art is null or freigabe_art in ('mail_link', 'admin', 'vertretung', 'notweg'));
  end if;
end $$;

-- Bestehende Freigaben bleiben gültig; Herkunft festhalten.
update public.trusted_devices set freigabe_art = 'mail_link'
 where status = 'approved' and freigabe_art is null;

-- Der Browser hat nie direkt auf trusted_devices zugegriffen (nur die
-- Server-Routen /api/trust/*). Die Selbst-Policies erlaubten aber, die eigene
-- Zeile per REST auf «approved» zu setzen → weg. Lesen/Schreiben nur Server.
drop policy if exists trusted_devices_self_insert on public.trusted_devices;
drop policy if exists trusted_devices_self_revoke on public.trusted_devices;
drop policy if exists trusted_devices_self_delete on public.trusted_devices;
drop policy if exists trusted_devices_self_select on public.trusted_devices;
revoke all on public.trusted_devices from public, anon, authenticated;
grant select, insert, update on public.trusted_devices to service_role;

-- ===========================================================================
-- 7. permission_audit_log: «Ansicht als» + Gerätefreigabe protokollieren
-- ===========================================================================
alter table public.permission_audit_log drop constraint if exists permission_audit_log_action_check;
alter table public.permission_audit_log add constraint permission_audit_log_action_check check (action = any (array[
  'role.created', 'role.updated', 'role.deleted', 'user.role_changed', 'user.permissions_changed',
  'view_as.started', 'view_as.stopped', 'view_as.write_enabled', 'view_as.write_disabled',
  'device.requested', 'device.approved', 'device.rejected', 'device.revoked', 'device.notfreigabe',
  'lohn.vertretung_changed',
  -- Aktionen aus Migration 361 (Vier Augen bei Rechten) schon hier, damit ein
  -- erneutes Einspielen von 360 nach 361 nicht an bestehenden Zeilen scheitert.
  'rechte.antrag_gestellt', 'rechte.antrag_bestaetigt', 'rechte.antrag_abgelehnt', 'rechte.antrag_notweg'
]::text[]));

-- ===========================================================================
-- 8. RPCs (nur service_role)
-- ===========================================================================

-- 8a. Fassung speichern: Zeile + Protokoll in EINER Transaktion. Die PDF liegt
-- schon unter einem eigenen Pfad im Speicher (nie überschrieben); schlägt
-- diese Funktion fehl, räumt der Server genau diese neue Datei wieder weg.
-- Funktioniert mit UND ohne Einmaligkeits-Regel wage_doc_unique_per_period.
create or replace function public.lohn_fassung_speichern(
  p_profile_id uuid,
  p_doc_type text,
  p_year integer,
  p_period_month integer,
  p_storage_path text,
  p_file_size bigint,
  p_source text,
  p_actor uuid,
  p_actor_name text,
  p_notes text,
  p_nur_wenn_keine_gueltige boolean default false,
  p_details jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alt_id uuid;
  v_alt_version integer;
  v_alt_pfad text;
  v_neu_id uuid;
  v_version integer;
  v_modus text;
  v_name text;
  v_constraint text;
begin
  -- Erlaubt dem Pfad-Schutz-Trigger (s. u.) das Umstellen von storage_path
  -- NUR innerhalb dieser Funktion (transaktionslokal).
  perform set_config('lohn.fassung_rpc', 'an', true);
  if p_doc_type not in ('lohnabrechnung', 'lohnausweis') then
    raise exception 'lohn_fassung_speichern: doc_type ungültig';
  end if;
  if p_source not in ('manual', 'auto') then
    raise exception 'lohn_fassung_speichern: source ungültig';
  end if;
  if coalesce(p_storage_path, '') = '' then
    raise exception 'lohn_fassung_speichern: storage_path fehlt';
  end if;

  -- Gleichzeitige Aufrufe für dieselbe Person/Periode nacheinander.
  perform pg_advisory_xact_lock(hashtextextended(
    'lohn_fassung|' || p_profile_id::text || '|' || p_doc_type || '|' || p_year || '|' || coalesce(p_period_month, 0), 0));

  select w.id, w.version, w.storage_path into v_alt_id, v_alt_version, v_alt_pfad
    from public.wage_documents w
   where w.profile_id = p_profile_id and w.doc_type = p_doc_type and w.year = p_year
     and w.period_month is not distinct from p_period_month
     and w.archived_at is null and w.superseded_at is null
   order by w.version desc, w.uploaded_at desc
   limit 1
   for update;

  if v_alt_id is not null and p_nur_wenn_keine_gueltige then
    return jsonb_build_object('modus', 'vorhanden', 'id', v_alt_id, 'version', v_alt_version);
  end if;

  select coalesce(max(w.version), 0) + 1 into v_version
    from public.wage_documents w
   where w.profile_id = p_profile_id and w.doc_type = p_doc_type and w.year = p_year
     and w.period_month is not distinct from p_period_month;

  begin
    if v_alt_id is not null then
      update public.wage_documents set superseded_at = now() where id = v_alt_id;
    end if;
    insert into public.wage_documents (
      profile_id, doc_type, year, period_month, storage_path, file_size,
      uploaded_at, uploaded_by, uploaded_by_name, notes, source, version)
    values (
      p_profile_id, p_doc_type, p_year, p_period_month, p_storage_path, p_file_size,
      now(), p_actor, p_actor_name, p_notes, p_source, v_version)
    returning id into v_neu_id;
    if v_alt_id is not null then
      update public.wage_documents set superseded_by = v_neu_id where id = v_alt_id;
    end if;
    v_modus := case when v_alt_id is null then 'neu' else 'neue_fassung' end;
  exception when unique_violation then
    -- Einmaligkeits-Regel noch aktiv: die eine Zeile der Periode zeigt ab jetzt
    -- auf die neue Datei. Die bisherige Datei bleibt im Speicher, ihr Pfad
    -- steht im Protokoll (vorheriger_storage_path). Nur fuer GENAU diese
    -- Regel — jede andere Verletzung (z. B. der spaetere Teil-Index) wirft.
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'wage_doc_unique_per_period' then
      raise;
    end if;
    select w.id, w.version, w.storage_path into v_alt_id, v_alt_version, v_alt_pfad
      from public.wage_documents w
     where w.profile_id = p_profile_id and w.doc_type = p_doc_type and w.year = p_year
       and w.period_month = p_period_month
     for update;
    if v_alt_id is null then
      raise;
    end if;
    update public.wage_documents set
      storage_path = p_storage_path, file_size = p_file_size, uploaded_at = now(),
      uploaded_by = p_actor, uploaded_by_name = p_actor_name, notes = p_notes, source = p_source,
      version = v_version, superseded_at = null, superseded_by = null,
      archived_at = null, archived_by = null, archived_by_name = null, archive_reason = null
     where id = v_alt_id;
    v_neu_id := v_alt_id;
    v_modus := 'ersetzt';
  end;

  select full_name into v_name from public.profiles where id = p_profile_id;

  insert into public.lohn_dokument_protokoll (
    aktion, wage_document_id, profile_id, profile_name, doc_type, year, period_month,
    version, vorherige_version, storage_path, vorheriger_storage_path, modus,
    actor_profile_id, actor_name, system, details)
  values (
    case when p_source = 'manual' then 'hochgeladen' else 'erstellt' end,
    v_neu_id, p_profile_id, v_name, p_doc_type, p_year, p_period_month,
    v_version, v_alt_version, p_storage_path, v_alt_pfad, v_modus,
    p_actor, p_actor_name, p_actor is null, coalesce(p_details, '{}'::jsonb));

  return jsonb_build_object(
    'modus', v_modus, 'id', v_neu_id, 'version', v_version,
    'vorherige_version', v_alt_version, 'vorheriger_pfad', v_alt_pfad);
end;
$$;

-- 8b. Papierkorb: archivieren (nie löschen)
create or replace function public.lohn_dokument_archivieren(
  p_id uuid, p_actor uuid, p_actor_name text, p_grund text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.wage_documents%rowtype;
  v_name text;
begin
  update public.wage_documents
     set archived_at = now(), archived_by = p_actor, archived_by_name = p_actor_name,
         archive_reason = nullif(trim(coalesce(p_grund, '')), '')
   where id = p_id and archived_at is null
  returning * into v;
  if v.id is null then
    raise exception 'Lohndokument nicht gefunden oder schon im Papierkorb';
  end if;
  select full_name into v_name from public.profiles where id = v.profile_id;
  insert into public.lohn_dokument_protokoll (
    aktion, wage_document_id, profile_id, profile_name, doc_type, year, period_month,
    version, storage_path, actor_profile_id, actor_name, system, grund)
  values ('archiviert', v.id, v.profile_id, v_name, v.doc_type, v.year, v.period_month,
    v.version, v.storage_path, p_actor, p_actor_name, p_actor is null, v.archive_reason);
  return jsonb_build_object('id', v.id);
end;
$$;

-- 8c. Papierkorb: wiederherstellen
create or replace function public.lohn_dokument_wiederherstellen(
  p_id uuid, p_actor uuid, p_actor_name text, p_grund text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.wage_documents%rowtype;
  v_name text;
begin
  select * into v from public.wage_documents where id = p_id;
  if v.id is null or v.archived_at is null then
    raise exception 'Lohndokument nicht im Papierkorb';
  end if;
  -- Gleiche Sperre wie lohn_fassung_speichern (keine Ueberschneidung mit Erzeugen).
  perform pg_advisory_xact_lock(hashtextextended(
    'lohn_fassung|' || v.profile_id::text || '|' || v.doc_type || '|' || v.year || '|' || coalesce(v.period_month, 0), 0));
  select * into v from public.wage_documents where id = p_id for update;
  if v.archived_at is null then
    raise exception 'Lohndokument nicht im Papierkorb';
  end if;
  if v.superseded_at is not null then
    raise exception 'Diese Fassung wurde durch eine neuere ersetzt und kann nicht wiederhergestellt werden';
  end if;
  if exists (
    select 1 from public.wage_documents w
     where w.id <> v.id and w.profile_id = v.profile_id and w.doc_type = v.doc_type and w.year = v.year
       and w.period_month is not distinct from v.period_month
       and w.archived_at is null and w.superseded_at is null
  ) then
    raise exception 'Für diesen Zeitraum gibt es bereits eine gültige Fassung';
  end if;
  update public.wage_documents
     set archived_at = null, archived_by = null, archived_by_name = null, archive_reason = null
   where id = v.id;
  select full_name into v_name from public.profiles where id = v.profile_id;
  insert into public.lohn_dokument_protokoll (
    aktion, wage_document_id, profile_id, profile_name, doc_type, year, period_month,
    version, storage_path, actor_profile_id, actor_name, system, grund)
  values ('wiederhergestellt', v.id, v.profile_id, v_name, v.doc_type, v.year, v.period_month,
    v.version, v.storage_path, p_actor, p_actor_name, p_actor is null, nullif(trim(coalesce(p_grund, '')), ''));
  return jsonb_build_object('id', v.id);
end;
$$;

-- 8d. Lauf starten: höchstens ein Lauf gleichzeitig; hängengebliebene
-- Läufe (> 15 min) gelten als abgebrochen. null = es läuft schon einer.
create or replace function public.lohn_lauf_starten(p_ausloeser text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  update public.lohn_lauf
     set status = 'abgebrochen', beendet_at = now(),
         zusammenfassung = coalesce(zusammenfassung || ' · ', '') || 'nach 15 Minuten ohne Abschluss als abgebrochen markiert'
   where status = 'laeuft' and gestartet_at < now() - interval '15 minutes';
  begin
    insert into public.lohn_lauf (ausloeser) values (p_ausloeser) returning id into v_id;
  exception when unique_violation then
    return null;
  end;
  return v_id;
end;
$$;

-- 8e. Notweg Gerätefreigabe (Mischa, mit Protokoll). Aufruf nur mit dem
-- Service-Schlüssel: scripts/geraet-notfreigabe.mjs.
create or replace function public.geraet_notfreigabe(p_device_id uuid, p_grund text, p_durch text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
  v_geraet text;
  v_person text;
begin
  if coalesce(trim(p_grund), '') = '' or coalesce(trim(p_durch), '') = '' then
    raise exception 'Notweg: Grund und Name (durch) sind Pflicht';
  end if;
  update public.trusted_devices
     set status = 'approved', approved_at = now(), approved_by = null, approved_by_name = trim(p_durch),
         approved_by_email = 'notweg', freigabe_art = 'notweg', confirm_token_hash = null
   where id = p_device_id and status = 'pending' and revoked_at is null
  returning user_id, device_name into v_user, v_geraet;
  if v_user is null then
    raise exception 'Notweg: keine offene Anfrage mit dieser ID';
  end if;
  select full_name into v_person from public.profiles where id = v_user;
  insert into public.permission_audit_log (actor_profile_id, actor_label, action, target_profile_id, target_profile_label, details)
  values (null, 'Notweg: ' || trim(p_durch), 'device.notfreigabe', v_user, v_person,
          jsonb_build_object('device_id', p_device_id, 'geraet', v_geraet, 'grund', trim(p_grund)));
  return jsonb_build_object('user_id', v_user, 'geraet', v_geraet);
end;
$$;

revoke all on function public.lohn_fassung_speichern(uuid, text, integer, integer, text, bigint, text, uuid, text, text, boolean, jsonb) from public, anon, authenticated;
revoke all on function public.lohn_dokument_archivieren(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.lohn_dokument_wiederherstellen(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.lohn_lauf_starten(text) from public, anon, authenticated;
revoke all on function public.geraet_notfreigabe(uuid, text, text) from public, anon, authenticated;
grant execute on function public.lohn_fassung_speichern(uuid, text, integer, integer, text, bigint, text, uuid, text, text, boolean, jsonb) to service_role;
grant execute on function public.lohn_dokument_archivieren(uuid, uuid, text, text) to service_role;
grant execute on function public.lohn_dokument_wiederherstellen(uuid, uuid, text, text) to service_role;
grant execute on function public.lohn_lauf_starten(text) to service_role;
grant execute on function public.geraet_notfreigabe(uuid, text, text) to service_role;

-- ===========================================================================
-- 9. Löschschutz (gilt für alle Rollen inkl. Server und Kaskaden)
-- ===========================================================================

-- Nie löschbar (Aufbewahrungspflicht): Fassungen, Protokoll, Dossier-Register.
create or replace function public.lohn_schutz_nie_loeschen()
returns trigger
language plpgsql
as $$
begin
  raise exception '%: % ist gesperrt (Aufbewahrungspflicht) — archivieren statt löschen',
    tg_table_name, case tg_op when 'DELETE' then 'Löschen' else 'Ändern' end
    using errcode = 'P0001';
end;
$$;

drop trigger if exists wage_documents_lohn_schutz on public.wage_documents;
create trigger wage_documents_lohn_schutz
  before delete on public.wage_documents
  for each row execute function public.lohn_schutz_nie_loeschen();

drop trigger if exists lohn_dokument_protokoll_lohn_schutz on public.lohn_dokument_protokoll;
create trigger lohn_dokument_protokoll_lohn_schutz
  before update or delete on public.lohn_dokument_protokoll
  for each row execute function public.lohn_schutz_nie_loeschen();

drop trigger if exists lohn_dossiers_lohn_schutz on public.lohn_dossiers;
create trigger lohn_dossiers_lohn_schutz
  before update or delete on public.lohn_dossiers
  for each row execute function public.lohn_schutz_nie_loeschen();

drop trigger if exists lohn_lauf_lohn_schutz on public.lohn_lauf;
create trigger lohn_lauf_lohn_schutz
  before delete on public.lohn_lauf
  for each row execute function public.lohn_schutz_nie_loeschen();

-- Lohnzeilen: nur eine GEPLANTE, noch nie gültige Zeile (Gültig ab nach heute,
-- Europe/Zurich) darf direkt entfernt werden (Knopf «geplante Erhöhung
-- löschen»). Nie über eine Kaskade (Profil löschen).
create or replace function public.lohn_schutz_lohnzeile()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() = 1 and old.effective_from > (now() at time zone 'Europe/Zurich')::date then
    return old;
  end if;
  raise exception 'employee_compensation: Lohnzeilen sind nicht löschbar (Lohn-Historie, Aufbewahrungspflicht). Nur geplante, noch nicht gültige Änderungen können entfernt werden.'
    using errcode = 'P0001';
end;
$$;
drop trigger if exists employee_compensation_lohn_schutz on public.employee_compensation;
create trigger employee_compensation_lohn_schutz
  before delete on public.employee_compensation
  for each row execute function public.lohn_schutz_lohnzeile();

-- Stempel: in gesperrten (abgerechneten) Monaten nie löschbar, auch nicht vom
-- Server; nie über eine Kaskade; die Person geht nie verloren (ON DELETE SET
-- NULL beim Profil). Offene Monate bleiben wie heute korrigierbar.
create or replace function public.lohn_schutz_stempel()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then
      raise exception 'time_entries: Stempel werden nie über eine Kaskade gelöscht (Lohngrundlage)' using errcode = 'P0001';
    end if;
    if public.is_time_entry_locked(old.clock_in) then
      raise exception 'time_entries: Stempel in abgerechneten Monaten sind nicht löschbar' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if old.user_id is not null and new.user_id is null then
    raise exception 'time_entries: Stempel dürfen ihre Person nicht verlieren (Lohngrundlage)' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists time_entries_lohn_schutz_loeschen on public.time_entries;
create trigger time_entries_lohn_schutz_loeschen
  before delete on public.time_entries
  for each row execute function public.lohn_schutz_stempel();
drop trigger if exists time_entries_lohn_schutz_person on public.time_entries;
create trigger time_entries_lohn_schutz_person
  before update of user_id on public.time_entries
  for each row execute function public.lohn_schutz_stempel();

-- Abwesenheiten: entschiedene (genehmigt/abgelehnt) nie löschbar — auch
-- nicht über eine Kaskade. Ein noch offener Antrag (keine Abwesenheit, nur
-- ein Wunsch) darf weiter zurückgezogen werden.
create or replace function public.lohn_schutz_abwesenheit()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'beantragt' then
    raise exception 'time_off: entschiedene Abwesenheiten sind nicht löschbar' using errcode = 'P0001';
  end if;
  return old;
end;
$$;
drop trigger if exists time_off_lohn_schutz on public.time_off;
create trigger time_off_lohn_schutz
  before delete on public.time_off
  for each row execute function public.lohn_schutz_abwesenheit();

-- Profile mit Lohn- oder Zeitdaten: nie löschen, nur archivieren
-- (deaktivieren). Klare Meldung statt Kaskaden-Fehler.
create or replace function public.lohn_schutz_profil()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grund text;
begin
  if exists (select 1 from public.employee_compensation where profile_id = old.id) then
    v_grund := 'Lohnzeilen';
  elsif exists (select 1 from public.wage_documents where profile_id = old.id) then
    v_grund := 'Lohndokumente';
  elsif exists (select 1 from public.time_entries where user_id = old.id) then
    v_grund := 'Stempelzeiten';
  elsif exists (select 1 from public.time_off where user_id = old.id and status <> 'beantragt') then
    v_grund := 'Abwesenheiten';
  end if;
  if v_grund is not null then
    raise exception 'profiles: Person hat % (Aufbewahrungspflicht) — nicht löschbar, nur archivieren (deaktivieren)', v_grund
      using errcode = 'P0001';
  end if;
  return old;
end;
$$;
drop trigger if exists profiles_lohn_schutz on public.profiles;
create trigger profiles_lohn_schutz
  before delete on public.profiles
  for each row execute function public.lohn_schutz_profil();

-- Fassungen: Datei und Periode einer Zeile nie still umstellen. storage_path
-- (und die Periode) aendert nur lohn_fassung_speichern (setzt lohn.fassung_rpc).
-- Papierkorb-Spalten (archived_*) und superseded_* bleiben fuer die RPCs frei.
create or replace function public.lohn_schutz_fassung_pfad()
returns trigger
language plpgsql
as $$
begin
  if (new.storage_path is distinct from old.storage_path
      or new.profile_id is distinct from old.profile_id
      or new.doc_type is distinct from old.doc_type
      or new.year is distinct from old.year
      or new.period_month is distinct from old.period_month)
     and coalesce(current_setting('lohn.fassung_rpc', true), '') <> 'an' then
    raise exception 'wage_documents: Datei/Periode einer Fassung ist nicht änderbar — neue Fassung erzeugen'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists wage_documents_lohn_schutz_pfad on public.wage_documents;
create trigger wage_documents_lohn_schutz_pfad
  before update on public.wage_documents
  for each row execute function public.lohn_schutz_fassung_pfad();

-- Abwesenheiten: ein Entscheid (genehmigt/abgelehnt) laesst sich nicht auf
-- «beantragt» zuruecksetzen — sonst waere die entschiedene Abwesenheit danach
-- loeschbar (Gegenpruefung Phase 1).
create or replace function public.lohn_schutz_abwesenheit_entscheid()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'beantragt' and new.status = 'beantragt' then
    raise exception 'time_off: ein Entscheid kann nicht auf «beantragt» zurückgesetzt werden' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists time_off_lohn_schutz_entscheid on public.time_off;
create trigger time_off_lohn_schutz_entscheid
  before update of status on public.time_off
  for each row execute function public.lohn_schutz_abwesenheit_entscheid();

-- Firmensaetze: bereits gueltige Zeilen (gueltig ab <= heute, Europe/Zurich)
-- weder loeschen noch zeitlich verschieben (vorher: Datum in die Zukunft
-- schieben, dann loeschen). Geplante Zeilen bleiben frei.
create or replace function public.lohn_schutz_firmensaetze()
returns trigger
language plpgsql
as $$
declare
  v_heute date := (now() at time zone 'Europe/Zurich')::date;
begin
  if old.effective_from <= v_heute then
    if tg_op = 'DELETE' then
      raise exception 'payroll_defaults: gültige Firmensätze sind nicht löschbar (Lohn-Historie)' using errcode = 'P0001';
    elsif new.effective_from is distinct from old.effective_from then
      raise exception 'payroll_defaults: «gültig ab» einer gültigen Zeile ist nicht verschiebbar' using errcode = 'P0001';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
drop trigger if exists payroll_defaults_lohn_schutz on public.payroll_defaults;
create trigger payroll_defaults_lohn_schutz
  before update or delete on public.payroll_defaults
  for each row execute function public.lohn_schutz_firmensaetze();

-- ===========================================================================
-- 10. get_monthly_payroll_stats: Server-Aufruf (service_role) zulassen.
-- Body unverändert bis auf die Rechteprüfung (Stand Migration 259 = Live).
-- Migration 362 entzieht danach den Browser-Rollen das Ausführen.
-- ===========================================================================
do $$
declare
  v_def text;
begin
  select pg_get_functiondef('public.get_monthly_payroll_stats(date)'::regprocedure) into v_def;
  if position('''service_role'' or public.is_admin()' in v_def) = 0 then
    v_def := replace(v_def,
      'if not (public.is_admin() or public.has_permission(''lohn:manage'')) then',
      'if not (coalesce(auth.role(), '''') = ''service_role'' or public.is_admin() or public.has_permission(''lohn:manage'')) then');
    if position('''service_role'' or public.is_admin()' in v_def) = 0 then
      raise exception 'get_monthly_payroll_stats: Rechteprüfung nicht gefunden — Definition weicht ab, bitte prüfen';
    end if;
    execute v_def;
  end if;
end $$;

-- ===========================================================================
-- 11. anon (nicht eingeloggt): keine Rechte auf Lohn-Objekte
-- ===========================================================================
revoke all on public.employee_compensation from anon;
revoke all on public.payroll_defaults from anon;
revoke all on public.wage_documents from anon;
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.get_monthly_payroll_stats(date)',
    'public.get_current_bvg_threshold(date)',
    'public.get_my_wage_consent()',
    'public.get_location_stats(date, date, text)',
    'public.get_my_compensation()',
    'public._test_payroll()'
  ] loop
    if to_regprocedure(f) is not null then
      execute format('revoke execute on function %s from public, anon', f);
    end if;
  end loop;
end $$;
-- get_my_wage_consent braucht der eingeloggte Mitarbeiter weiterhin (eigene Einwilligung).
grant execute on function public.get_my_wage_consent() to authenticated;
