-- 380: Schnittstelle Trust flow — Abwesenheiten und Arztzeugnisse. Additiv, idempotent.
--
-- !! Nummer beim Zusammenführen prüfen (376 liegt auf Branch fragen-an-dich; 377–379 live).
--
-- Trust flow rechnet den Lohn und braucht dafür die Abwesenheiten (Ferien, Krank, …) und die
-- Arztzeugnisse:
--   - POST /api/flow/abwesenheiten (aud «erp-abwesenheiten»): je Person alle Abwesenheiten, die
--     den Monat berühren, mit Angaben zum Arztzeugnis (ohne Notizen).
--   - POST /api/flow/arztzeugnis (aud «erp-arztzeugnis»): signierter Link (60 s) auf die Datei eines Arztzeugnisses.
-- Beide lesen nur (Gruppe «abruf», Höchstzahl 10/min zusammen mit Stempel und Vergleich).
--
-- Inhalt:
--   1. time_off: Angaben zur Datei des Arztzeugnisses (beim Hochladen gesetzt, /api/krank/[id]/arztzeugnis;
--      ältere Dateien füllt der Server beim ersten Abruf nach) und arztzeugnis_an_flow_at
--      (erste erfolgreiche Übergabe an Trust flow; ein neues Zeugnis setzt sie zurück).
--      Gelöscht wird nichts (Lösch-Regel nach Übergabe noch offen).
--   2. Mitarbeitende dürfen eigene Anträge nur ohne Arztzeugnis-Angaben anlegen/ändern
--      (Zeugnisse setzt nur der Server; vorher konnte ein eigener Antrag einen fremden Pfad tragen).
--   3. flow_abrufe_aud_check + flow_abruf_beginnen: zusätzlich «erp-abwesenheiten», «erp-arztzeugnis».
--
-- Rückweg: flow_abruf_beginnen wie 377 einspielen, Policies wie 378; Spalten und Protokolle
-- bleiben (nie löschen).

-- ===========================================================================
-- 1. time_off: Arztzeugnis-Angaben
-- ===========================================================================
alter table public.time_off add column if not exists arztzeugnis_dateiname text;
alter table public.time_off add column if not exists arztzeugnis_mime text;
alter table public.time_off add column if not exists arztzeugnis_groesse bigint;
alter table public.time_off add column if not exists arztzeugnis_sha256 text;
alter table public.time_off add column if not exists arztzeugnis_an_flow_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'time_off_arztzeugnis_sha256_check'
                  and conrelid = 'public.time_off'::regclass) then
    alter table public.time_off add constraint time_off_arztzeugnis_sha256_check
      check (arztzeugnis_sha256 is null or arztzeugnis_sha256 ~ '^[0-9a-f]{64}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'time_off_arztzeugnis_groesse_check'
                  and conrelid = 'public.time_off'::regclass) then
    alter table public.time_off add constraint time_off_arztzeugnis_groesse_check
      check (arztzeugnis_groesse is null or arztzeugnis_groesse between 0 and 10485760);
  end if;
end $$;

comment on column public.time_off.arztzeugnis_dateiname is 'Dateiname des Arztzeugnisses beim Hochladen (Migration 380).';
comment on column public.time_off.arztzeugnis_mime is 'MIME-Typ des Arztzeugnisses (Migration 380).';
comment on column public.time_off.arztzeugnis_groesse is 'Grösse des Arztzeugnisses in Bytes (Migration 380).';
comment on column public.time_off.arztzeugnis_sha256 is 'sha256 (hex) des Arztzeugnisses; für Trust flow (Migration 380).';
comment on column public.time_off.arztzeugnis_an_flow_at is 'Erste Übergabe des aktuellen Arztzeugnisses an Trust flow (Link ausgestellt, POST /api/flow/arztzeugnis); ein neues Zeugnis setzt sie zurück (Migration 380).';

-- ===========================================================================
-- 2. Eigene Anträge ohne Arztzeugnis-Angaben (nur der Server setzt sie)
-- ===========================================================================
drop policy if exists "Eigene Ferien anlegen" on public.time_off;
create policy "Eigene Ferien anlegen" on public.time_off
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and status = 'beantragt'
    and approved_by is null
    and approved_at is null
    and decision_note is null
    and ende_offen = false
    and arztzeugnis_pfad is null
    and arztzeugnis_hochgeladen_at is null
    and arztzeugnis_dateiname is null
    and arztzeugnis_mime is null
    and arztzeugnis_groesse is null
    and arztzeugnis_sha256 is null
    and arztzeugnis_an_flow_at is null
  );

drop policy if exists "Eigene Ferien aendern wenn beantragt" on public.time_off;
create policy "Eigene Ferien aendern wenn beantragt" on public.time_off
  for update to authenticated
  using (user_id = (select auth.uid()) and status = 'beantragt')
  with check (
    user_id = (select auth.uid())
    and status = 'beantragt'
    and approved_by is null
    and approved_at is null
    and decision_note is null
    and arztzeugnis_pfad is null
    and arztzeugnis_hochgeladen_at is null
    and arztzeugnis_dateiname is null
    and arztzeugnis_mime is null
    and arztzeugnis_groesse is null
    and arztzeugnis_sha256 is null
    and arztzeugnis_an_flow_at is null
  );

-- ===========================================================================
-- 3. aud «erp-abwesenheiten», «erp-arztzeugnis»
-- ===========================================================================
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'flow_abrufe_aud_check' and conrelid = 'public.flow_abrufe'::regclass
                    and pg_get_constraintdef(oid) like '%erp-arztzeugnis%') then
    alter table public.flow_abrufe drop constraint if exists flow_abrufe_aud_check;
    -- Wie 377 (alte Audiences bleiben: protokollierte Aufrufe stehen als Nachweis), zusätzlich die zwei neuen.
    alter table public.flow_abrufe add constraint flow_abrufe_aud_check
      check (aud in ('erp-stempel', 'erp-personen', 'erp-vergleich', 'erp-lohnabrechnung-ablage', 'flow-stammdaten', 'erp-saetze',
                     'erp-abwesenheiten', 'erp-arztzeugnis'));
  end if;
end $$;

-- Wie 377, einzige Änderung: aud 'erp-abwesenheiten' und 'erp-arztzeugnis' erlaubt
-- (Gruppe «abruf»: liest nur, Höchstzahl 10/min).
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
  if p_aud not in ('erp-stempel', 'erp-vergleich', 'erp-lohnabrechnung-ablage', 'erp-saetze', 'erp-abwesenheiten', 'erp-arztzeugnis') then
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
