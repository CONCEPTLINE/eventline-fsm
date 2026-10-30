-- 369: Schnittstelle zu Trust flow (Backoffice) — additiv, idempotent.
--
-- !! Nummer beim Zusammenführen prüfen: höchste Nummer auf origin/main UND
-- !! allen Branches + 1 (Stand 30.10.2026: 368 auf lohn, 365/366 auf
-- !! origin/vertrieb-kampagnen, 364 auf main).
--
-- Reihenfolge Live: supabase/lokal/live-gang-flow/LIVE-GANG.md — NACH Phase 4
-- (braucht 367: lohn_einstellungen.lauf_bis, lohn_nach_lauf_bis, lohn_dokument_zustellung).
--
-- Was Trust flow vom ERP holt bzw. bringt (Vertrag: _backoffice-uebergabe/10_Schnittstelle_Stunden.md,
-- Code: src/lib/flow/, Routen /api/flow/*):
--   A1  POST /api/flow/stempel | personen | vergleich  — signierter Einzelabruf (JWS EdDSA, 60 s)
--   A5  POST /api/flow/lohnabrechnung                   — Lohnabrechnung (PDF aus Bexio) je Person/Monat
--
-- Inhalt:
--   1. flow_abrufe: jeder Aufruf mit gültigem Ausweis (Protokoll: wer laut sub, welcher Monat,
--      wie viele Personen, Prüfsumme der Antwort), Einmal-Schutz (jti) und Höchstzahl je Minute
--   2. flow_abruf_beginnen / flow_abruf_abschliessen (nur Server, atomar)
--   3. wage_documents.source kennt 'bexio'; lohn_fassung_speichern nimmt die Quelle an
--   4. lohn_bexio_fassungen + lohn_bexio_fassung_speichern: PDF aus Bexio als Fassung ablegen
--      (nur Lohnmonate nach lauf_bis und ab Dezember 2026, nie überschreiben, Reihenfolge der Fassungen)
--
-- Rechte: alles nur service_role (Route Handler). RLS an, keine Policies, anon/authenticated ohne Rechte.
-- Rückweg: supabase/lokal/live-gang-flow/369_rueckweg.sql (Funktionen weg, Quelle zurück;
-- Tabellen und Protokolle bleiben).

-- ===========================================================================
-- 1. flow_abrufe — Protokoll und Einmal-Schutz
-- ===========================================================================
create table if not exists public.flow_abrufe (
  id uuid primary key default gen_random_uuid(),
  jti uuid not null,
  aud text not null check (aud in ('erp-stempel', 'erp-personen', 'erp-vergleich', 'erp-lohnabrechnung-ablage')),
  -- Höchstzahl je Minute gilt je Gruppe: abruf (Stempel/Personen/Vergleich) 10, ablage (Lohnabrechnungen) 30.
  gruppe text not null check (gruppe in ('abruf', 'ablage')),
  sub uuid not null,                       -- Trust-flow-Profil laut Ausweis (wer hat abgerufen)
  jahr integer,
  monat integer check (monat is null or monat between 1 and 12),
  angefragt integer,                       -- Anzahl ERP-Profil-IDs im Ausweis (Ablage: 1)
  geliefert integer,                       -- Personen in der Antwort (Ablage: 1 = abgelegt)
  -- angenommen = läuft; ok | abgelehnt | fehler = abgeschlossen;
  -- wiederholt (jti schon da) und zu_viele (Höchstzahl) verbrauchen den jti nicht.
  status text not null default 'angenommen'
    check (status in ('angenommen', 'ok', 'abgelehnt', 'fehler', 'wiederholt', 'zu_viele')),
  grund text,
  antwort_sha256 text check (antwort_sha256 is null or antwort_sha256 ~ '^[0-9a-f]{64}$'),
  ausweis_iat timestamptz,
  ausweis_exp timestamptz,
  empfangen_at timestamptz not null default now(),
  abgeschlossen_at timestamptz
);
create unique index if not exists flow_abrufe_jti_einmal on public.flow_abrufe (jti)
  where status not in ('wiederholt', 'zu_viele');
create index if not exists flow_abrufe_fenster_idx on public.flow_abrufe (gruppe, empfangen_at desc)
  where status not in ('wiederholt', 'zu_viele');
create index if not exists flow_abrufe_empfangen_idx on public.flow_abrufe (empfangen_at desc);
comment on table public.flow_abrufe is
  'Signierte Aufrufe aus Trust flow (/api/flow/*): Protokoll, Einmal-Schutz (jti) und Höchstzahl je Minute. Migration 369.';

alter table public.flow_abrufe enable row level security;
alter table public.flow_abrufe force row level security;
revoke all on public.flow_abrufe from public, anon, authenticated;
grant select, insert, update on public.flow_abrufe to service_role;

-- Nur anhängen: nie löschen; nur ein laufender Aufruf (angenommen) wird einmal
-- abgeschlossen, und dabei ändern sich nur die Abschluss-Felder.
create or replace function public.flow_abrufe_schutz()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'flow_abrufe: Löschen ist gesperrt (Protokoll)' using errcode = 'P0001';
  end if;
  if old.status <> 'angenommen'
     or new.id is distinct from old.id or new.jti is distinct from old.jti or new.aud is distinct from old.aud
     or new.gruppe is distinct from old.gruppe or new.sub is distinct from old.sub
     or new.jahr is distinct from old.jahr or new.monat is distinct from old.monat
     or new.angefragt is distinct from old.angefragt or new.empfangen_at is distinct from old.empfangen_at
     or new.ausweis_iat is distinct from old.ausweis_iat or new.ausweis_exp is distinct from old.ausweis_exp then
    raise exception 'flow_abrufe: nur ein laufender Aufruf wird abgeschlossen (Protokoll)' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.flow_abrufe_schutz() from public, anon, authenticated;
drop trigger if exists flow_abrufe_schutz on public.flow_abrufe;
create trigger flow_abrufe_schutz
  before update or delete on public.flow_abrufe
  for each row execute function public.flow_abrufe_schutz();

-- ===========================================================================
-- 2. Beginnen (jti einmalig + Höchstzahl je Minute, atomar) und Abschliessen
-- ===========================================================================
create or replace function public.flow_abruf_beginnen(
  p_jti uuid,
  p_aud text,
  p_sub uuid,
  p_jahr integer,
  p_monat integer,
  p_angefragt integer,
  p_iat timestamptz,
  p_exp timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gruppe text;
  v_limit integer;
  v_n integer;
  v_aeltester timestamptz;
  v_id uuid;
begin
  if p_aud not in ('erp-stempel', 'erp-personen', 'erp-vergleich', 'erp-lohnabrechnung-ablage') then
    raise exception 'flow_abruf_beginnen: aud ungültig';
  end if;
  if p_jti is null or p_sub is null then
    raise exception 'flow_abruf_beginnen: jti/sub fehlt';
  end if;
  v_gruppe := case when p_aud = 'erp-lohnabrechnung-ablage' then 'ablage' else 'abruf' end;
  v_limit := case when v_gruppe = 'ablage' then 30 else 10 end;

  -- Gleichzeitige Aufrufe derselben Gruppe nacheinander (Zählen + Eintragen atomar).
  perform pg_advisory_xact_lock(hashtextextended('flow_abruf|' || v_gruppe, 0));

  if exists (select 1 from public.flow_abrufe where jti = p_jti and status not in ('wiederholt', 'zu_viele')) then
    insert into public.flow_abrufe (jti, aud, gruppe, sub, jahr, monat, angefragt, status, grund, ausweis_iat, ausweis_exp, abgeschlossen_at)
    values (p_jti, p_aud, v_gruppe, p_sub, p_jahr, p_monat, p_angefragt, 'wiederholt', 'Ausweis schon verwendet (jti)', p_iat, p_exp, now());
    return jsonb_build_object('status', 'wiederholt');
  end if;

  select count(*), min(empfangen_at) into v_n, v_aeltester
    from public.flow_abrufe
   where gruppe = v_gruppe and status not in ('wiederholt', 'zu_viele')
     and empfangen_at > now() - interval '60 seconds';
  if v_n >= v_limit then
    insert into public.flow_abrufe (jti, aud, gruppe, sub, jahr, monat, angefragt, status, grund, ausweis_iat, ausweis_exp, abgeschlossen_at)
    values (p_jti, p_aud, v_gruppe, p_sub, p_jahr, p_monat, p_angefragt, 'zu_viele',
            'Höchstzahl ' || v_limit || ' je Minute erreicht', p_iat, p_exp, now());
    return jsonb_build_object('status', 'zu_viele', 'limit', v_limit,
      'retry_after', greatest(1, ceil(extract(epoch from (v_aeltester + interval '60 seconds' - now()))))::integer);
  end if;

  begin
    insert into public.flow_abrufe (jti, aud, gruppe, sub, jahr, monat, angefragt, status, ausweis_iat, ausweis_exp)
    values (p_jti, p_aud, v_gruppe, p_sub, p_jahr, p_monat, p_angefragt, 'angenommen', p_iat, p_exp)
    returning id into v_id;
  exception when unique_violation then
    -- Gleichzeitig derselbe jti über eine andere Gruppe (andere Sperre): einmal reicht.
    return jsonb_build_object('status', 'wiederholt');
  end;
  return jsonb_build_object('status', 'ok', 'id', v_id);
end;
$$;
revoke all on function public.flow_abruf_beginnen(uuid, text, uuid, integer, integer, integer, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.flow_abruf_beginnen(uuid, text, uuid, integer, integer, integer, timestamptz, timestamptz) to service_role;

create or replace function public.flow_abruf_abschliessen(
  p_id uuid,
  p_status text,
  p_geliefert integer,
  p_antwort_sha256 text,
  p_grund text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('ok', 'abgelehnt', 'fehler') then
    raise exception 'flow_abruf_abschliessen: Status ungültig';
  end if;
  update public.flow_abrufe
     set status = p_status, geliefert = p_geliefert, antwort_sha256 = p_antwort_sha256,
         grund = left(nullif(trim(coalesce(p_grund, '')), ''), 500), abgeschlossen_at = now()
   where id = p_id and status = 'angenommen';
  if not found then
    raise exception 'flow_abruf_abschliessen: Aufruf % läuft nicht (mehr)', p_id;
  end if;
end;
$$;
revoke all on function public.flow_abruf_abschliessen(uuid, text, integer, text, text) from public, anon, authenticated;
grant execute on function public.flow_abruf_abschliessen(uuid, text, integer, text, text) to service_role;

-- ===========================================================================
-- 3. Quelle «bexio» für Lohndokumente
-- ===========================================================================
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'wage_documents_source_check' and conrelid = 'public.wage_documents'::regclass
                    and pg_get_constraintdef(oid) like '%bexio%') then
    alter table public.wage_documents drop constraint if exists wage_documents_source_check;
    alter table public.wage_documents add constraint wage_documents_source_check
      check (source in ('manual', 'auto', 'bexio'));
  end if;
end $$;
comment on column public.wage_documents.source is
  'manual = von Hand hochgeladen, auto = vom ERP erzeugt (bis lauf_bis), bexio = aus Bexio über Trust flow (Migration 369).';

-- Wie 360, einzige Änderungen: Quelle 'bexio' erlaubt, Protokoll «hochgeladen» auch für 'bexio'.
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
  if p_source not in ('manual', 'auto', 'bexio') then
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
    case when p_source in ('manual', 'bexio') then 'hochgeladen' else 'erstellt' end,
    v_neu_id, p_profile_id, v_name, p_doc_type, p_year, p_period_month,
    v_version, v_alt_version, p_storage_path, v_alt_pfad, v_modus,
    p_actor, p_actor_name, p_actor is null, coalesce(p_details, '{}'::jsonb));

  return jsonb_build_object(
    'modus', v_modus, 'id', v_neu_id, 'version', v_version,
    'vorherige_version', v_alt_version, 'vorheriger_pfad', v_alt_pfad);
end;
$$;
revoke all on function public.lohn_fassung_speichern(uuid, text, integer, integer, text, bigint, text, uuid, text, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.lohn_fassung_speichern(uuid, text, integer, integer, text, bigint, text, uuid, text, text, boolean, jsonb) to service_role;

-- ===========================================================================
-- 4. Lohnabrechnungen aus Bexio (A5)
-- ===========================================================================
-- Je Person, Lohnmonat und Fassung laut Trust flow genau eine Zeile (nie ändern,
-- nie löschen). Die PDF liegt im Bucket lohndokumente unter einem eigenen Pfad
-- (src/lib/lohn/fassung.ts), die wage_documents-Zeile zeigt sie unter «Meine
-- Lohndokumente» wie eine ERP-Abrechnung. Keine Momentaufnahme: ab Dezember 2026
-- rechnet Trust flow/Bexio, die Phase-2/4-Logik zählt nur Momentaufnahmen.
create table if not exists public.lohn_bexio_fassungen (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete restrict,
  jahr integer not null,
  monat integer not null check (monat between 1 and 12),
  fassung integer not null check (fassung between 1 and 99),   -- Fassung laut Trust flow/Bexio
  pdf_sha256 text not null check (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  file_size bigint not null check (file_size > 0),
  wage_document_id uuid not null references public.wage_documents(id) on delete restrict,
  erp_version integer not null,                               -- wage_documents.version dieser Fassung
  storage_path text not null,
  flow_abruf_id uuid references public.flow_abrufe(id),
  flow_sub uuid,                                               -- Trust-flow-Profil laut Ausweis
  erstellt_at timestamptz not null default now(),
  constraint lohn_bexio_fassungen_eindeutig unique (profile_id, jahr, monat, fassung),
  constraint lohn_bexio_fassungen_ab_dezember_2026 check (jahr > 2026 or (jahr = 2026 and monat = 12))
);
create index if not exists lohn_bexio_fassungen_doc_idx on public.lohn_bexio_fassungen (wage_document_id);
comment on table public.lohn_bexio_fassungen is
  'Lohnabrechnungen aus Bexio (über Trust flow, POST /api/flow/lohnabrechnung) je Person/Lohnmonat/Fassung. Migration 369.';
alter table public.lohn_bexio_fassungen enable row level security;
alter table public.lohn_bexio_fassungen force row level security;
revoke all on public.lohn_bexio_fassungen from public, anon, authenticated;
grant select, insert on public.lohn_bexio_fassungen to service_role;
drop trigger if exists lohn_bexio_fassungen_lohn_schutz on public.lohn_bexio_fassungen;
create trigger lohn_bexio_fassungen_lohn_schutz
  before update or delete on public.lohn_bexio_fassungen
  for each row execute function public.lohn_schutz_nie_loeschen();

-- PDF liegt schon unter p_storage_path (eigener Pfad, nie überschrieben).
-- Erwartete Ablehnungen kommen als {modus: 'abgelehnt', code, meldung} zurück
-- (der Server räumt dann seine Datei weg), alles andere wirft.
create or replace function public.lohn_bexio_fassung_speichern(
  p_profile_id uuid,
  p_jahr integer,
  p_monat integer,
  p_fassung integer,
  p_pdf_sha256 text,
  p_storage_path text,
  p_file_size bigint,
  p_flow_abruf_id uuid,
  p_flow_sub uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gleich public.lohn_bexio_fassungen%rowtype;
  v_max integer;
  v_doc jsonb;
begin
  if p_monat is null or p_monat not between 1 and 12 or p_jahr is null then
    raise exception 'lohn_bexio_fassung_speichern: Monat ungültig';
  end if;
  if p_fassung is null or p_fassung not between 1 and 99 then
    raise exception 'lohn_bexio_fassung_speichern: Fassung ungültig';
  end if;
  if not (p_jahr > 2026 or (p_jahr = 2026 and p_monat = 12)) then
    return jsonb_build_object('modus', 'abgelehnt', 'code', 'erp_monat',
      'meldung', 'Lohnabrechnungen aus Bexio gibt es erst ab Lohnmonat Dezember 2026.');
  end if;
  if public.lohn_nach_lauf_bis(p_jahr, p_monat) is null then
    return jsonb_build_object('modus', 'abgelehnt', 'code', 'erp_monat',
      'meldung', 'Für diesen Lohnmonat rechnet das ERP (lohn_einstellungen.lauf_bis) — keine Lohnabrechnung aus Bexio.');
  end if;

  -- Gleiche Sperre wie lohn_fassung_speichern: dieselbe Person/Periode nacheinander.
  perform pg_advisory_xact_lock(hashtextextended(
    'lohn_fassung|' || p_profile_id::text || '|lohnabrechnung|' || p_jahr || '|' || p_monat, 0));

  select * into v_gleich from public.lohn_bexio_fassungen
   where profile_id = p_profile_id and jahr = p_jahr and monat = p_monat and fassung = p_fassung;
  if found then
    if v_gleich.pdf_sha256 = p_pdf_sha256 then
      return jsonb_build_object('modus', 'vorhanden', 'id', v_gleich.wage_document_id, 'version', v_gleich.erp_version);
    end if;
    return jsonb_build_object('modus', 'abgelehnt', 'code', 'fassung_abweichend',
      'meldung', 'Fassung ' || p_fassung || ' ist schon mit anderem Inhalt abgelegt — eine geänderte Abrechnung braucht eine neue Fassung.');
  end if;
  select max(fassung) into v_max from public.lohn_bexio_fassungen
   where profile_id = p_profile_id and jahr = p_jahr and monat = p_monat;
  if v_max is not null and p_fassung < v_max then
    return jsonb_build_object('modus', 'abgelehnt', 'code', 'veraltet',
      'meldung', 'Für diesen Monat liegt schon Fassung ' || v_max || ' vor — eine ältere Fassung wird nicht mehr abgelegt.');
  end if;

  v_doc := public.lohn_fassung_speichern(
    p_profile_id, 'lohnabrechnung', p_jahr, p_monat, p_storage_path, p_file_size, 'bexio',
    null, 'Trust flow (Bexio)', 'Lohnabrechnung aus Bexio, Fassung ' || p_fassung, false,
    jsonb_build_object('quelle', 'bexio', 'fassung_bexio', p_fassung, 'pdf_sha256', p_pdf_sha256,
                       'flow_abruf_id', p_flow_abruf_id, 'flow_sub', p_flow_sub));

  insert into public.lohn_bexio_fassungen (
    profile_id, jahr, monat, fassung, pdf_sha256, file_size, wage_document_id, erp_version,
    storage_path, flow_abruf_id, flow_sub)
  values (
    p_profile_id, p_jahr, p_monat, p_fassung, p_pdf_sha256, p_file_size, (v_doc ->> 'id')::uuid,
    (v_doc ->> 'version')::integer, p_storage_path, p_flow_abruf_id, p_flow_sub);

  return v_doc;
end;
$$;
revoke all on function public.lohn_bexio_fassung_speichern(uuid, integer, integer, integer, text, text, bigint, uuid, uuid) from public, anon, authenticated;
grant execute on function public.lohn_bexio_fassung_speichern(uuid, integer, integer, integer, text, text, bigint, uuid, uuid) to service_role;
