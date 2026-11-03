-- 376: «Fragen an dich» — Pflicht-Fragen an Mitarbeitende + Abruf durch Trust flow. Additiv, idempotent.
--
-- !! Nummer beim Zusammenführen prüfen: höchste Nummer auf origin/main UND
-- !! allen Branches + 1 (Stand 03.11.2026: 375 auf main, 375_catering_bestell_anteile
-- !! auf origin/feat/getraenke-catering; lohn ohne neue Nummer).
--
-- Braucht 369/371 (flow_abrufe, flow_abruf_beginnen). Code: src/lib/fragen/ (Katalog),
-- /api/mein-konto/fragen (Person), /api/flow/antworten (Trust flow, src/lib/flow/).
--
-- Inhalt:
--   1. mitarbeiter_antworten: Antworten der Mitarbeitenden auf die Fragen aus dem Katalog
--      (src/lib/fragen/katalog.ts) als Verlauf — nur anhängen, nie ändern/löschen. Eine
--      Änderung unter «Mein Konto › Meine Antworten» ist ein neuer Eintrag; es gilt der neueste.
--   2. RLS (alle 4 Verben): die Person liest und schreibt (Insert) nur die eigenen, als
--      interne aktive Person und nur «selbst»; Admin liest alle; Ändern/Löschen für niemanden.
--      anon ohne Rechte. Einträge der Verwaltung (quelle 'verwaltung') nur über den Server.
--   3. Trust flow: aud 'erp-antworten' (POST /api/flow/antworten, Gruppe «abruf», 10 je Minute).
--
-- Rückweg: supabase/lokal/live-gang-fragen/376_rueckweg.sql (Funktion wie 371; Tabelle und
-- Antworten bleiben als Nachweis).

-- ===========================================================================
-- 1. mitarbeiter_antworten
-- ===========================================================================
create table if not exists public.mitarbeiter_antworten (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete restrict,
  -- Schlüssel aus dem Katalog im Code (z. B. 'ahv_geringfuegig').
  frage_schluessel text not null check (frage_schluessel ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- Wert einer Option des Katalogs (z. B. 'abziehen' | 'keine').
  antwort text not null check (antwort ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- Fassung des Fragetexts, die die Person gesehen hat.
  text_version text not null check (length(text_version) between 1 and 20),
  -- Zeit setzt immer die Datenbank (Trigger), nie der Aufrufer.
  beantwortet_at timestamptz not null default now(),
  -- selbst = die Person; verwaltung = auf Wunsch der Person eingetragen (nur Server)
  quelle text not null check (quelle in ('selbst', 'verwaltung')),
  akteur_id uuid,
  akteur_name text check (akteur_name is null or length(akteur_name) <= 200),
  notiz text check (notiz is null or length(notiz) <= 500)
);
create index if not exists mitarbeiter_antworten_neueste_idx
  on public.mitarbeiter_antworten (profile_id, frage_schluessel, beantwortet_at desc);
comment on table public.mitarbeiter_antworten is
  'Fragen an dich: Antworten der Mitarbeitenden (Katalog src/lib/fragen/katalog.ts) als Verlauf, nur anhängen; es gilt der neueste Eintrag je Person und Frage. Trust flow liest über POST /api/flow/antworten. Migration 376.';

-- Zeit und Akteur beim Einfügen festlegen: beantwortet_at = jetzt; «selbst» heisst
-- akteur = die Person. Schutz gegen Ändern/Löschen: Verlauf (wie lohn_zustellung_wahl).
create or replace function public.mitarbeiter_antworten_einfuegen()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.beantwortet_at := now();
  if new.quelle = 'selbst' then
    new.akteur_id := new.profile_id;
  end if;
  return new;
end;
$$;
revoke all on function public.mitarbeiter_antworten_einfuegen() from public, anon, authenticated;
drop trigger if exists mitarbeiter_antworten_einfuegen on public.mitarbeiter_antworten;
create trigger mitarbeiter_antworten_einfuegen
  before insert on public.mitarbeiter_antworten
  for each row execute function public.mitarbeiter_antworten_einfuegen();

drop trigger if exists mitarbeiter_antworten_lohn_schutz on public.mitarbeiter_antworten;
create trigger mitarbeiter_antworten_lohn_schutz
  before update or delete on public.mitarbeiter_antworten
  for each row execute function public.lohn_schutz_nie_loeschen();

-- ===========================================================================
-- 2. Rechte und RLS
-- ===========================================================================
alter table public.mitarbeiter_antworten enable row level security;
alter table public.mitarbeiter_antworten force row level security;
revoke all on public.mitarbeiter_antworten from public, anon, authenticated;
grant select, insert on public.mitarbeiter_antworten to authenticated;
grant select, insert on public.mitarbeiter_antworten to service_role;

drop policy if exists mitarbeiter_antworten_select on public.mitarbeiter_antworten;
create policy mitarbeiter_antworten_select on public.mitarbeiter_antworten
  for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.is_admin()));

-- Nur die eigene Antwort, nur «selbst», nur als interne aktive Person (keine Portal-Konten).
drop policy if exists mitarbeiter_antworten_insert on public.mitarbeiter_antworten;
create policy mitarbeiter_antworten_insert on public.mitarbeiter_antworten
  for insert to authenticated
  with check (
    profile_id = (select auth.uid())
    and quelle = 'selbst'
    and (select public.is_internal_user())
  );

-- Verlauf: Ändern und Löschen für niemanden (zusätzlich zum Trigger und ohne Grant).
drop policy if exists mitarbeiter_antworten_update on public.mitarbeiter_antworten;
create policy mitarbeiter_antworten_update on public.mitarbeiter_antworten
  for update to authenticated using (false) with check (false);

drop policy if exists mitarbeiter_antworten_delete on public.mitarbeiter_antworten;
create policy mitarbeiter_antworten_delete on public.mitarbeiter_antworten
  for delete to authenticated using (false);

-- ===========================================================================
-- 3. Trust flow: aud «erp-antworten»
-- ===========================================================================
-- Regel: bisherige Audiences bleiben (protokollierte Aufrufe stehen als Nachweis).
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'flow_abrufe_aud_check' and conrelid = 'public.flow_abrufe'::regclass
                    and pg_get_constraintdef(oid) like '%erp-antworten%') then
    alter table public.flow_abrufe drop constraint if exists flow_abrufe_aud_check;
    alter table public.flow_abrufe add constraint flow_abrufe_aud_check
      check (aud in ('erp-stempel', 'erp-personen', 'erp-vergleich', 'erp-lohnabrechnung-ablage', 'flow-stammdaten', 'erp-antworten'));
  end if;
end $$;
comment on table public.flow_abrufe is
  'Signierte Aufrufe aus Trust flow (/api/flow/*): Protokoll, Einmal-Schutz (jti) und Höchstzahl je Minute. Migration 369; A6 Stammdaten 370, entfernt 371 (Zeilen bleiben); Antworten 376.';

-- Wie 371, einzige Änderung: aud 'erp-antworten' (Gruppe «abruf»).
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
  if p_aud not in ('erp-stempel', 'erp-vergleich', 'erp-lohnabrechnung-ablage', 'erp-antworten') then
    raise exception 'flow_abruf_beginnen: aud ungültig';
  end if;
  if p_jti is null or p_sub is null then
    raise exception 'flow_abruf_beginnen: jti/sub fehlt';
  end if;
  -- Gruppe «abruf» = Stempel/Vergleich/Antworten (10 je Minute), «ablage» = Lohnabrechnung (30 je Minute).
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
