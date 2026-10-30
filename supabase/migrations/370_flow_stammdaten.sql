-- 370: Schnittstelle Trust flow — Stammdaten-Abruf A6 (POST /api/flow/stammdaten). Additiv, idempotent.
--
-- !! Nummer beim Zusammenführen prüfen: höchste Nummer auf origin/main UND
-- !! allen Branches + 1 (Stand 30.10.2026: 369 live auf main, 368 auf lohn,
-- !! 365/366 auf origin/vertrieb-kampagnen).
--
-- Braucht 369 (flow_abrufe, flow_abruf_beginnen). Reihenfolge Live:
-- supabase/lokal/live-gang-a6/LIVE-GANG.md. Vertrag: supabase/lokal/live-gang-a6/VERTRAG.md.
--
-- Einzige Änderungen gegenüber 369:
--   1. flow_abrufe.aud kennt zusätzlich 'flow-stammdaten' (Regel flow_abrufe_aud_check)
--   2. flow_abruf_beginnen nimmt 'flow-stammdaten' an — Gruppe «abruf» (10 je Minute)
-- Keine bestehende Zeile ändert sich. Rechte unverändert (nur service_role).
-- Rückweg: supabase/lokal/live-gang-a6/370_rueckweg.sql (Funktion wie 369; die erweiterte
-- Regel und protokollierte A6-Aufrufe bleiben).

-- ===========================================================================
-- 1. flow_abrufe: aud «flow-stammdaten»
-- ===========================================================================
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'flow_abrufe_aud_check' and conrelid = 'public.flow_abrufe'::regclass
                    and pg_get_constraintdef(oid) like '%flow-stammdaten%') then
    alter table public.flow_abrufe drop constraint if exists flow_abrufe_aud_check;
    alter table public.flow_abrufe add constraint flow_abrufe_aud_check
      check (aud in ('erp-stempel', 'erp-personen', 'erp-vergleich', 'erp-lohnabrechnung-ablage', 'flow-stammdaten'));
  end if;
end $$;
comment on table public.flow_abrufe is
  'Signierte Aufrufe aus Trust flow (/api/flow/*): Protokoll, Einmal-Schutz (jti) und Höchstzahl je Minute. Migration 369, A6 Stammdaten 370.';

-- ===========================================================================
-- 2. flow_abruf_beginnen: wie 369, zusätzlich aud «flow-stammdaten» (Gruppe «abruf»)
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
  if p_aud not in ('erp-stempel', 'erp-personen', 'erp-vergleich', 'erp-lohnabrechnung-ablage', 'flow-stammdaten') then
    raise exception 'flow_abruf_beginnen: aud ungültig';
  end if;
  if p_jti is null or p_sub is null then
    raise exception 'flow_abruf_beginnen: jti/sub fehlt';
  end if;
  -- flow-stammdaten (A6) zählt zur Gruppe «abruf» (10 je Minute, zusammen mit Stempel/Personen/Vergleich).
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
