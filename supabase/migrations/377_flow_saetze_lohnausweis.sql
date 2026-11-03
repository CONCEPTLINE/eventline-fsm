-- 377: Schnittstelle Trust flow — Personal-Sätze und Lohnausweis aus Bexio. Additiv, idempotent.
--
-- !! Nummer beim Zusammenführen prüfen (376 liegt auf einem anderen Branch).
--
-- Lohn-Umbau «Lohn neu» Phase 1a: der Lohn wird nur noch in Trust flow gerechnet. Das ERP bekommt
--   - je Person die Stundensätze für Kosten (Auftragskosten, Standort-Report) — POST /api/flow/saetze
--     (aud «erp-saetze»), Tabelle personal_saetze;
--   - den Lohnausweis (PDF aus Bexio) je Person und Jahr — POST /api/flow/lohnabrechnung mit art «lohnausweis».
--
-- Inhalt:
--   1. personal_saetze (nur service_role; RLS an, keine Policies)
--   2. flow_abrufe_aud_check + flow_abruf_beginnen: zusätzlich aud «erp-saetze» (Gruppe «ablage», schreibt)
--   3. lohn_bexio_fassungen: Spalte doc_type, monat für den Lohnausweis leer; Regeln je Art
--   4. lohn_bexio_ausweis_speichern: Lohnausweis aus Bexio als Fassung ablegen (wie
--      lohn_bexio_fassung_speichern, ohne Monat und ohne lauf_bis-Prüfung; Jahre ab 2026).
--      lohn_bexio_fassung_speichern (Lohnabrechnung) bleibt unverändert; lohn_fassung_speichern
--      kennt doc_type «lohnausweis» und Quelle «bexio» schon (369).
--
-- Rückweg: Funktion lohn_bexio_ausweis_speichern droppen, flow_abruf_beginnen wie 371 einspielen;
-- Tabelle, Spalte und Protokolle bleiben (nie löschen).

-- ===========================================================================
-- 1. personal_saetze
-- ===========================================================================
create table if not exists public.personal_saetze (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  gueltig_ab date not null,
  kosten_chf_h numeric(8,2) not null check (kosten_chf_h >= 0),
  netto_chf_h numeric(8,2) not null check (netto_chf_h >= 0),
  quelle text not null default 'trust-flow',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint personal_saetze_eindeutig unique (profile_id, gueltig_ab)
);
comment on table public.personal_saetze is
  'Stundensätze je Person ab einem Datum, aus Trust flow (POST /api/flow/saetze): Kosten (Arbeitgeber, CHF/h) und Netto (CHF/h). Nur für Kostenrechnungen im ERP (Auftragskosten, Standort-Report) — der Lohn selbst wird in Trust flow gerechnet. Nur Server (service_role). Migration 377.';
comment on column public.personal_saetze.kosten_chf_h is 'Vollkosten Arbeitgeber je Stunde (CHF), laut Trust flow.';
comment on column public.personal_saetze.netto_chf_h is 'Nettolohn je Stunde (CHF), laut Trust flow.';
comment on column public.personal_saetze.gueltig_ab is 'Gilt ab diesem Tag bis zum nächsten Eintrag derselben Person.';
alter table public.personal_saetze enable row level security;
alter table public.personal_saetze force row level security;
revoke all on public.personal_saetze from public, anon, authenticated;
grant select, insert, update on public.personal_saetze to service_role;
create index if not exists personal_saetze_profil_idx on public.personal_saetze (profile_id, gueltig_ab desc);

-- ===========================================================================
-- 2. aud «erp-saetze»
-- ===========================================================================
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'flow_abrufe_aud_check' and conrelid = 'public.flow_abrufe'::regclass
                    and pg_get_constraintdef(oid) like '%erp-saetze%') then
    alter table public.flow_abrufe drop constraint if exists flow_abrufe_aud_check;
    -- Wie 370 (alte Audiences bleiben: protokollierte Aufrufe stehen als Nachweis), zusätzlich 'erp-saetze'.
    alter table public.flow_abrufe add constraint flow_abrufe_aud_check
      check (aud in ('erp-stempel', 'erp-personen', 'erp-vergleich', 'erp-lohnabrechnung-ablage', 'flow-stammdaten', 'erp-saetze'));
  end if;
end $$;

-- Wie 371, einzige Änderung: aud 'erp-saetze' erlaubt (Gruppe «ablage»: schreibt ins ERP, Höchstzahl 30/min).
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
  if p_aud not in ('erp-stempel', 'erp-vergleich', 'erp-lohnabrechnung-ablage', 'erp-saetze') then
    raise exception 'flow_abruf_beginnen: aud ungültig';
  end if;
  if p_jti is null or p_sub is null then
    raise exception 'flow_abruf_beginnen: jti/sub fehlt';
  end if;
  v_gruppe := case when p_aud in ('erp-lohnabrechnung-ablage', 'erp-saetze') then 'ablage' else 'abruf' end;
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

-- ===========================================================================
-- 3. lohn_bexio_fassungen: auch Lohnausweise (doc_type, monat leer)
-- ===========================================================================
alter table public.lohn_bexio_fassungen add column if not exists doc_type text not null default 'lohnabrechnung';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lohn_bexio_fassungen_doc_type_check'
                  and conrelid = 'public.lohn_bexio_fassungen'::regclass) then
    alter table public.lohn_bexio_fassungen add constraint lohn_bexio_fassungen_doc_type_check
      check (doc_type in ('lohnabrechnung', 'lohnausweis'));
  end if;
end $$;
alter table public.lohn_bexio_fassungen alter column monat drop not null;

-- Regel je Art: Lohnabrechnung mit Monat ab Dezember 2026 (wie 369), Lohnausweis ohne Monat ab Jahr 2026.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lohn_bexio_fassungen_art_periode'
                  and conrelid = 'public.lohn_bexio_fassungen'::regclass) then
    alter table public.lohn_bexio_fassungen drop constraint if exists lohn_bexio_fassungen_ab_dezember_2026;
    alter table public.lohn_bexio_fassungen add constraint lohn_bexio_fassungen_art_periode check (
      (doc_type = 'lohnabrechnung' and monat is not null and (jahr > 2026 or (jahr = 2026 and monat = 12)))
      or (doc_type = 'lohnausweis' and monat is null and jahr >= 2026)
    );
  end if;
end $$;
-- Die bisherige Eindeutigkeit (profile_id, jahr, monat, fassung) greift für Lohnabrechnungen weiter;
-- für den Lohnausweis (monat leer) eine eigene je Person, Jahr und Fassung.
create unique index if not exists lohn_bexio_fassungen_ausweis_eindeutig
  on public.lohn_bexio_fassungen (profile_id, jahr, fassung) where doc_type = 'lohnausweis';
comment on table public.lohn_bexio_fassungen is
  'Lohnabrechnungen (je Lohnmonat) und Lohnausweise (je Jahr, monat leer) aus Bexio über Trust flow (POST /api/flow/lohnabrechnung), je Person und Fassung. Migration 369, Lohnausweis 377.';

-- ===========================================================================
-- 4. Lohnausweis aus Bexio ablegen
-- ===========================================================================
-- Wie lohn_bexio_fassung_speichern (369), aber je Jahr statt Lohnmonat; ohne lauf_bis-Prüfung
-- (das ERP stellt keine Lohnausweise mehr aus). PDF liegt schon unter p_storage_path.
create or replace function public.lohn_bexio_ausweis_speichern(
  p_profile_id uuid,
  p_jahr integer,
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
  if p_jahr is null then
    raise exception 'lohn_bexio_ausweis_speichern: Jahr ungültig';
  end if;
  if p_fassung is null or p_fassung not between 1 and 99 then
    raise exception 'lohn_bexio_ausweis_speichern: Fassung ungültig';
  end if;
  if p_jahr < 2026 then
    return jsonb_build_object('modus', 'abgelehnt', 'code', 'erp_jahr',
      'meldung', 'Lohnausweise aus Bexio gibt es erst ab Jahr 2026.');
  end if;

  -- Gleiche Sperre wie lohn_fassung_speichern (Lohnausweis: Monat 0).
  perform pg_advisory_xact_lock(hashtextextended(
    'lohn_fassung|' || p_profile_id::text || '|lohnausweis|' || p_jahr || '|0', 0));

  select * into v_gleich from public.lohn_bexio_fassungen
   where profile_id = p_profile_id and doc_type = 'lohnausweis' and jahr = p_jahr and fassung = p_fassung;
  if found then
    if v_gleich.pdf_sha256 = p_pdf_sha256 then
      return jsonb_build_object('modus', 'vorhanden', 'id', v_gleich.wage_document_id, 'version', v_gleich.erp_version);
    end if;
    return jsonb_build_object('modus', 'abgelehnt', 'code', 'fassung_abweichend',
      'meldung', 'Fassung ' || p_fassung || ' ist schon mit anderem Inhalt abgelegt — ein geänderter Lohnausweis braucht eine neue Fassung.');
  end if;
  select max(fassung) into v_max from public.lohn_bexio_fassungen
   where profile_id = p_profile_id and doc_type = 'lohnausweis' and jahr = p_jahr;
  if v_max is not null and p_fassung < v_max then
    return jsonb_build_object('modus', 'abgelehnt', 'code', 'veraltet',
      'meldung', 'Für dieses Jahr liegt schon Fassung ' || v_max || ' vor — eine ältere Fassung wird nicht mehr abgelegt.');
  end if;

  v_doc := public.lohn_fassung_speichern(
    p_profile_id, 'lohnausweis', p_jahr, null, p_storage_path, p_file_size, 'bexio',
    null, 'Trust flow (Bexio)', 'Lohnausweis aus Bexio, Fassung ' || p_fassung, false,
    jsonb_build_object('quelle', 'bexio', 'fassung_bexio', p_fassung, 'pdf_sha256', p_pdf_sha256,
                       'flow_abruf_id', p_flow_abruf_id, 'flow_sub', p_flow_sub));

  insert into public.lohn_bexio_fassungen (
    profile_id, doc_type, jahr, monat, fassung, pdf_sha256, file_size, wage_document_id, erp_version,
    storage_path, flow_abruf_id, flow_sub)
  values (
    p_profile_id, 'lohnausweis', p_jahr, null, p_fassung, p_pdf_sha256, p_file_size, (v_doc ->> 'id')::uuid,
    (v_doc ->> 'version')::integer, p_storage_path, p_flow_abruf_id, p_flow_sub);

  return v_doc;
end;
$$;
revoke all on function public.lohn_bexio_ausweis_speichern(uuid, integer, integer, text, text, bigint, uuid, uuid) from public, anon, authenticated;
grant execute on function public.lohn_bexio_ausweis_speichern(uuid, integer, integer, text, text, bigint, uuid, uuid) to service_role;
