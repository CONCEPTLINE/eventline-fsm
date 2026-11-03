-- NUR LOKAL: Prüfungen zu 381 (RLS alle 4 Verben, Verlauf nur anhängen, Trust-flow-aud).
-- Erfundene IDs, keine echten Personen. Jede Prüfung meldet «OK …» oder bricht ab.
\set ON_ERROR_STOP on
\pset tuples_only on
insert into public.profiles values
  ('a0000000-0000-4000-8000-000000000001', 'admin', true, 'Test Admin'),
  ('a0000000-0000-4000-8000-000000000011', 'mitarbeiter', true, 'Test Eins'),
  ('a0000000-0000-4000-8000-000000000012', 'mitarbeiter', true, 'Test Zwei'),
  ('a0000000-0000-4000-8000-000000000013', 'mitarbeiter', false, 'Test Inaktiv'),
  ('a0000000-0000-4000-8000-000000000021', 'partner', true, 'Test Partner');

create or replace function public.erwarte_fehler(p_sql text, p_was text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'OK % (%)', p_was, sqlerrm;
    return;
  end;
  raise exception 'FEHLT: % ging durch', p_was;
end $$;
grant execute on function public.erwarte_fehler(text, text) to anon, authenticated, service_role;

-- Person «Eins»
set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000011', false);
insert into public.mitarbeiter_antworten (profile_id, frage_schluessel, antwort, text_version, quelle, beantwortet_at, akteur_id)
values ('a0000000-0000-4000-8000-000000000011', 'ahv_geringfuegig', 'abziehen', '1.0', 'selbst', '2020-01-01', 'a0000000-0000-4000-8000-000000000001');
do $$ begin
  if (select count(*) from public.mitarbeiter_antworten) <> 1 then raise exception 'FEHLT: eigene Antwort nicht sichtbar'; end if;
  if (select beantwortet_at < now() - interval '1 minute' or akteur_id <> profile_id from public.mitarbeiter_antworten) then
    raise exception 'FEHLT: Zeit/Akteur nicht von der Datenbank gesetzt';
  end if;
  raise notice 'OK Insert eigene Antwort; Zeit = jetzt, Akteur = Person';
end $$;
insert into public.mitarbeiter_antworten (profile_id, frage_schluessel, antwort, text_version, quelle)
values ('a0000000-0000-4000-8000-000000000011', 'ahv_geringfuegig', 'keine', '1.0', 'selbst');
select public.erwarte_fehler($q$insert into public.mitarbeiter_antworten (profile_id, frage_schluessel, antwort, text_version, quelle)
  values ('a0000000-0000-4000-8000-000000000012', 'ahv_geringfuegig', 'keine', '1.0', 'selbst')$q$, 'Insert für fremde Person gesperrt');
select public.erwarte_fehler($q$insert into public.mitarbeiter_antworten (profile_id, frage_schluessel, antwort, text_version, quelle)
  values ('a0000000-0000-4000-8000-000000000011', 'ahv_geringfuegig', 'keine', '1.0', 'verwaltung')$q$, 'Insert «verwaltung» durch Person gesperrt');
select public.erwarte_fehler($q$insert into public.mitarbeiter_antworten (profile_id, frage_schluessel, antwort, text_version, quelle)
  values ('a0000000-0000-4000-8000-000000000011', 'AHV', 'keine', '1.0', 'selbst')$q$, 'Schlüssel-Format geprüft');
select public.erwarte_fehler($q$update public.mitarbeiter_antworten set antwort = 'keine'$q$, 'Update gesperrt (kein Recht)');
select public.erwarte_fehler($q$delete from public.mitarbeiter_antworten$q$, 'Delete gesperrt (kein Recht)');
reset role;

-- Person «Zwei» sieht nichts von «Eins»
set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000012', false);
do $$ begin
  if (select count(*) from public.mitarbeiter_antworten) <> 0 then raise exception 'FEHLT: fremde Antworten sichtbar'; end if;
  raise notice 'OK fremde Antworten unsichtbar';
end $$;
reset role;

-- Inaktive Person und Partner-Zugang dürfen nicht antworten
set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000013', false);
select public.erwarte_fehler($q$insert into public.mitarbeiter_antworten (profile_id, frage_schluessel, antwort, text_version, quelle)
  values ('a0000000-0000-4000-8000-000000000013', 'ahv_geringfuegig', 'keine', '1.0', 'selbst')$q$, 'Insert inaktive Person gesperrt');
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000021', false);
select public.erwarte_fehler($q$insert into public.mitarbeiter_antworten (profile_id, frage_schluessel, antwort, text_version, quelle)
  values ('a0000000-0000-4000-8000-000000000021', 'ahv_geringfuegig', 'keine', '1.0', 'selbst')$q$, 'Insert Partner-Zugang gesperrt');
reset role;

-- Admin liest alle, schreibt aber nicht für andere
set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', false);
do $$ begin
  if (select count(*) from public.mitarbeiter_antworten) <> 2 then raise exception 'FEHLT: Admin sieht nicht alle'; end if;
  raise notice 'OK Admin liest alle';
end $$;
select public.erwarte_fehler($q$insert into public.mitarbeiter_antworten (profile_id, frage_schluessel, antwort, text_version, quelle)
  values ('a0000000-0000-4000-8000-000000000011', 'ahv_geringfuegig', 'keine', '1.0', 'selbst')$q$, 'Admin-Insert für andere gesperrt');
reset role;

-- anon: nichts
set role anon;
select public.erwarte_fehler($q$select count(*) from public.mitarbeiter_antworten$q$, 'anon liest nicht');
select public.erwarte_fehler($q$insert into public.mitarbeiter_antworten (profile_id, frage_schluessel, antwort, text_version, quelle)
  values ('a0000000-0000-4000-8000-000000000011', 'ahv_geringfuegig', 'keine', '1.0', 'selbst')$q$, 'anon schreibt nicht');
reset role;

-- service_role (Server): Verwaltung trägt ein; Ändern/Löschen sperrt der Trigger
set role service_role;
insert into public.mitarbeiter_antworten (profile_id, frage_schluessel, antwort, text_version, quelle, akteur_name, notiz)
values ('a0000000-0000-4000-8000-000000000012', 'ahv_geringfuegig', 'abziehen', '1.0', 'verwaltung', 'Test Admin', 'auf Wunsch');
select public.erwarte_fehler($q$update public.mitarbeiter_antworten set antwort = 'keine'$q$, 'Update für den Server gesperrt (kein Recht)');
select public.erwarte_fehler($q$delete from public.mitarbeiter_antworten$q$, 'Delete für den Server gesperrt (kein Recht)');
select public.erwarte_fehler($q$select public.flow_abruf_beginnen(gen_random_uuid(), 'erp-personen', gen_random_uuid(), null, null, 1, now(), now() + interval '60 seconds')$q$, 'flow: entfernte aud bleibt gesperrt');
do $$ declare r jsonb; begin
  r := public.flow_abruf_beginnen(gen_random_uuid(), 'erp-antworten', gen_random_uuid(), null, null, 3, now(), now() + interval '60 seconds');
  if r ->> 'status' <> 'ok' then raise exception 'FEHLT: erp-antworten nicht angenommen: %', r; end if;
  perform public.flow_abruf_abschliessen((r ->> 'id')::uuid, 'ok', 2, repeat('a', 64), null);
  if not exists (select 1 from public.flow_abrufe where aud = 'erp-antworten' and gruppe = 'abruf' and status = 'ok' and angefragt = 3) then
    raise exception 'FEHLT: Protokoll erp-antworten';
  end if;
  raise notice 'OK flow: erp-antworten angenommen und protokolliert (Gruppe abruf)';
end $$;
-- Audiences aus 377/380 bleiben erhalten, mit ihrer Gruppe (381 baut auf der Fassung 380 auf).
do $$ declare r jsonb; a text; g text; begin
  foreach a in array array['erp-stempel', 'erp-vergleich', 'erp-lohnabrechnung-ablage', 'erp-saetze', 'erp-abwesenheiten', 'erp-arztzeugnis'] loop
    r := public.flow_abruf_beginnen(gen_random_uuid(), a, gen_random_uuid(), null, null, 1, now(), now() + interval '60 seconds');
    if r ->> 'status' <> 'ok' then raise exception 'FEHLT: % nicht mehr angenommen: %', a, r; end if;
    select gruppe into g from public.flow_abrufe where id = (r ->> 'id')::uuid;
    if g <> (case when a in ('erp-lohnabrechnung-ablage', 'erp-saetze') then 'ablage' else 'abruf' end) then
      raise exception 'FEHLT: % in falscher Gruppe %', a, g;
    end if;
  end loop;
  raise notice 'OK flow: Audiences aus 369/377/380 weiterhin angenommen, Gruppen wie 380';
end $$;
reset role;

-- authenticated darf flow_abruf_beginnen nicht
set role authenticated;
select public.erwarte_fehler($q$select public.flow_abruf_beginnen(gen_random_uuid(), 'erp-antworten', gen_random_uuid(), null, null, 1, now(), now())$q$, 'flow_abruf_beginnen nur Server');
reset role;

-- Selbst der Eigentümer (Superuser, umgeht RLS und Rechte): der Trigger sperrt Ändern/Löschen
do $$ begin
  begin
    update public.mitarbeiter_antworten set antwort = 'keine';
    raise exception 'FEHLT: Update durch Eigentümer ging durch';
  exception when sqlstate 'P0001' then
    if sqlerrm not like '%gesperrt%' then raise; end if;
    raise notice 'OK Trigger sperrt Ändern (%)', sqlerrm;
  end;
  begin
    delete from public.mitarbeiter_antworten;
    raise exception 'FEHLT: Delete durch Eigentümer ging durch';
  exception when sqlstate 'P0001' then
    if sqlerrm not like '%gesperrt%' then raise; end if;
    raise notice 'OK Trigger sperrt Löschen (%)', sqlerrm;
  end;
end $$;

\echo ALLE PRUEFUNGEN OK
