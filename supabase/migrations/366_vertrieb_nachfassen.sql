-- 366: Vertrieb › Kampagnen — Nachfassen, Antworten ansehen, Audit-Fixes
-- (Leo, 29.10.2026).
--
-- !! Nummer beim Zusammenführen prüfen: höchste Nummer auf origin/main UND
-- !! allen Branches + 1 (Stand 29.10.2026: 364 auf main, 365 + 366 auf
-- !! vertrieb-kampagnen). Reihenfolge auf Live: 356 → 365 → 366, DANN Merge.
--
-- 1. Nachfassen: Wer angeschrieben wurde und nach N Tagen (NACHFASS_TAGE im
--    Code, src/lib/vertrieb/nachfassen.ts — wird als Parameter übergeben,
--    gerechnet mit der DB-Zeit now()) keine Antwort hat, ist «Nachfassen
--    fällig». Höchstens NACHFASS_MAX Runden. Der vorbereitete Text
--    (KI-Vorschlag, editierbar) liegt in nachfass_betreff/nachfass_text.
-- 2. Zuordnung über Microsoft-Konversationen: mail_conversation_id der
--    gesendeten Erstmail; antwort_graph_ids = Graph-IDs der Antworten, die
--    der Abgleich SELBST zugeordnet hat. Nur diese Mails zeigt das Detail
--    (live geladen, Inhalte werden nie gespeichert).
-- 3. Rechte (Audit K1/M2): Nutzer mit vertrieb:edit dürfen an Kontakten nur
--    Status, Notizen und Nachfass-Felder ändern (Spalten-Rechte). Anlegen und
--    Löschen von Kontakten und Kampagnen nur noch über den Server
--    (Import-Skript, service_role).
-- 4. vertrieb_kampagne_liste()/_uebersicht(): Liste mit Rang inkl. «Nachfassen
--    fällig», Filter, Keyset, Trefferzahl; Kennzahlen inkl. Nachfassen.
-- 5. vertrieb_abgleich_speichern(): schreibt alle Änderungen eines Abgleichs
--    in EINEM Aufruf (nur service_role).
-- Idempotent, nur additiv. sortier_rang (365) bleibt stehen, wird von der
-- App nicht mehr gelesen; Entfernen in einer späteren Migration.

-- ===========================================================================
-- 1. + 2. Spalten
-- ===========================================================================
alter table public.vertrieb_kampagne_kontakte
  add column if not exists nachfass_betreff text,
  add column if not exists nachfass_text text,
  add column if not exists nachgefasst_am timestamptz,
  add column if not exists nachfass_anzahl int not null default 0,
  add column if not exists mail_conversation_id text,
  add column if not exists antwort_graph_ids text[] not null default '{}'::text[];

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'vertrieb_kampagne_kontakte_nachfass_anzahl_check') then
    alter table public.vertrieb_kampagne_kontakte
      add constraint vertrieb_kampagne_kontakte_nachfass_anzahl_check check (nachfass_anzahl >= 0);
  end if;
end;
$$;

create index if not exists vertrieb_kampagne_kontakte_conversation_idx
  on public.vertrieb_kampagne_kontakte (mail_conversation_id) where mail_conversation_id is not null;

-- ===========================================================================
-- 3. Rechte (Audit K1, M2)
-- ===========================================================================
-- Kontakte: lesen mit vertrieb:view; ändern mit vertrieb:edit, aber nur diese
-- Spalten. Adressen, Versand- und Antwortdaten schreibt nur der Server.
revoke insert, update, delete on public.vertrieb_kampagne_kontakte from authenticated, anon;
grant update (status, status_manuell, notizen, nachfass_betreff, nachfass_text, nachgefasst_am, nachfass_anzahl)
  on public.vertrieb_kampagne_kontakte to authenticated;

drop policy if exists vertrieb_kampagne_kontakte_insert on public.vertrieb_kampagne_kontakte;
create policy vertrieb_kampagne_kontakte_insert on public.vertrieb_kampagne_kontakte
  for insert to authenticated with check (false);

drop policy if exists vertrieb_kampagne_kontakte_delete on public.vertrieb_kampagne_kontakte;
create policy vertrieb_kampagne_kontakte_delete on public.vertrieb_kampagne_kontakte
  for delete to authenticated using (false);

-- Kampagnen: nur lesen; anlegen/ändern/löschen nur über den Server.
revoke insert, update, delete on public.vertrieb_kampagnen from authenticated, anon;

drop policy if exists vertrieb_kampagnen_insert on public.vertrieb_kampagnen;
create policy vertrieb_kampagnen_insert on public.vertrieb_kampagnen
  for insert to authenticated with check (false);

drop policy if exists vertrieb_kampagnen_update on public.vertrieb_kampagnen;
create policy vertrieb_kampagnen_update on public.vertrieb_kampagnen
  for update to authenticated using (false) with check (false);

drop policy if exists vertrieb_kampagnen_delete on public.vertrieb_kampagnen;
create policy vertrieb_kampagnen_delete on public.vertrieb_kampagnen
  for delete to authenticated using (false);

-- ===========================================================================
-- 4. Liste
--    Fällig: Schwelle p_tage/p_max aus dem Code, Zeit = DB-Zeit now().
--    Rang: 0 Antwort erhalten · 1 Anrufen · 2 Nachfassen fällig ·
--          3 Termin/Offerte · 4 offen/geplant/angeschrieben · 5 abgeschlossen
--    Keyset: (rang, firma, id) > (p_nach_rang, p_nach_firma, p_nach_id).
--    treffer = Anzahl aller Treffer des Filters (vor der Paginierung).
--    security invoker → RLS der Tabelle gilt (vertrieb:view).
-- ===========================================================================
create or replace function public.vertrieb_kampagne_liste(
  p_kampagne uuid,
  p_tage int,
  p_max int,
  p_status text[] default null,
  p_nur_faellig boolean default false,
  p_gruppe text default null,
  p_suche text default null,
  p_nach_rang int default null,
  p_nach_firma text default null,
  p_nach_id uuid default null,
  p_limit int default 100
)
returns table (
  id uuid,
  nr text,
  firma text,
  gruppe text,
  ansprechperson text,
  status text,
  mail_geplant_am timestamptz,
  mail_gesendet_am timestamptz,
  letzte_antwort_am timestamptz,
  nachfassen_faellig boolean,
  rang int,
  treffer bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with muster as (
    select case when coalesce(btrim(p_suche), '') = '' then null
      else '%' || replace(replace(replace(btrim(p_suche), '\', '\\'), '%', '\%'), '_', '\_') || '%' end as m
  ),
  basis as (
    select k.id, k.nr, k.firma, k.gruppe, k.ansprechperson, k.status,
           k.mail_geplant_am, k.mail_gesendet_am, k.letzte_antwort_am,
           coalesce(
             k.status = 'gesendet' and k.antworten_anzahl = 0 and k.nachfass_anzahl < p_max
             and coalesce(k.nachgefasst_am, k.mail_gesendet_am) < now() - make_interval(days => p_tage),
             false
           ) as faellig
    from public.vertrieb_kampagne_kontakte k, muster
    where k.kampagne_id = p_kampagne
      and (p_status is null or k.status = any (p_status))
      and (p_gruppe is null or k.gruppe = p_gruppe)
      and (muster.m is null
           or k.firma ilike muster.m or k.ansprechperson ilike muster.m
           or k.email ilike muster.m or k.mail_an ilike muster.m or k.nr ilike muster.m)
  ),
  gerankt as (
    select b.*,
           case
             when b.status = 'geantwortet' then 0
             when b.status = 'anrufen' then 1
             when b.faellig then 2
             when b.status in ('termin', 'offerte') then 3
             when b.status in ('offen', 'geplant', 'gesendet') then 4
             else 5
           end as rang
    from basis b
    where not coalesce(p_nur_faellig, false) or b.faellig
  ),
  gezaehlt as (
    select g.*, count(*) over () as treffer from gerankt g
  )
  select z.id, z.nr, z.firma, z.gruppe, z.ansprechperson, z.status,
         z.mail_geplant_am, z.mail_gesendet_am, z.letzte_antwort_am,
         z.faellig, z.rang, z.treffer
  from gezaehlt z
  where p_nach_id is null or (z.rang, z.firma, z.id) > (p_nach_rang, p_nach_firma, p_nach_id)
  order by z.rang, z.firma, z.id
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

revoke all on function public.vertrieb_kampagne_liste(uuid, int, int, text[], boolean, text, text, int, text, uuid, int) from public, anon;
grant execute on function public.vertrieb_kampagne_liste(uuid, int, int, text[], boolean, text, text, int, text, uuid, int) to authenticated, service_role;

-- ===========================================================================
-- 4b. Übersicht: Status, Gruppen und fällige Nachfass-Kontakte
-- ===========================================================================
create or replace function public.vertrieb_kampagne_uebersicht(p_kampagne uuid, p_tage int, p_max int)
returns table (art text, wert text, anzahl int)
language sql
stable
security invoker
set search_path = public
as $$
  select z.art, z.wert, z.anzahl from public.vertrieb_kampagne_zahlen(p_kampagne) z
  union all
  select 'nachfassen'::text, null::text, count(*)::int
  from public.vertrieb_kampagne_kontakte k
  where k.kampagne_id = p_kampagne
    and k.status = 'gesendet' and k.antworten_anzahl = 0 and k.nachfass_anzahl < p_max
    and coalesce(k.nachgefasst_am, k.mail_gesendet_am) < now() - make_interval(days => p_tage);
$$;

revoke all on function public.vertrieb_kampagne_uebersicht(uuid, int, int) from public, anon;
grant execute on function public.vertrieb_kampagne_uebersicht(uuid, int, int) to authenticated, service_role;

-- ===========================================================================
-- 5. Abgleich speichern: alle Änderungen eines Laufs in EINEM Aufruf.
--    p_aenderungen = [{ id, felder: {…}, status_von?, status_nach? }]
--    Felder werden nur gesetzt, wenn der Schlüssel vorkommt. Der Status nur,
--    wenn er noch status_von ist und kein Mensch ihn gesetzt hat.
--    Nur service_role (der Abgleich läuft auf dem Server).
-- ===========================================================================
create or replace function public.vertrieb_abgleich_speichern(p_aenderungen jsonb)
returns table (geaendert int, statuswechsel int)
language plpgsql
security invoker
set search_path = public
as $$
declare
  e jsonb;
  f jsonb;
  n_felder int := 0;
  n_status int := 0;
  n int;
begin
  for e in select * from jsonb_array_elements(coalesce(p_aenderungen, '[]'::jsonb)) loop
    f := coalesce(e->'felder', '{}'::jsonb);
    if f <> '{}'::jsonb then
      update public.vertrieb_kampagne_kontakte k set
        mail_gesendet_am       = case when f ? 'mail_gesendet_am' then (f->>'mail_gesendet_am')::timestamptz else k.mail_gesendet_am end,
        mail_conversation_id   = case when f ? 'mail_conversation_id' then f->>'mail_conversation_id' else k.mail_conversation_id end,
        graph_message_id       = case when f ? 'graph_message_id' then f->>'graph_message_id' else k.graph_message_id end,
        letzte_antwort_am      = case when f ? 'letzte_antwort_am' then (f->>'letzte_antwort_am')::timestamptz else k.letzte_antwort_am end,
        letzte_antwort_betreff = case when f ? 'letzte_antwort_betreff' then f->>'letzte_antwort_betreff' else k.letzte_antwort_betreff end,
        antworten_anzahl       = case when f ? 'antworten_anzahl' then (f->>'antworten_anzahl')::int else k.antworten_anzahl end,
        antwort_graph_ids      = case when f ? 'antwort_graph_ids'
                                   then array(select jsonb_array_elements_text(f->'antwort_graph_ids'))
                                   else k.antwort_graph_ids end
      where k.id = (e->>'id')::uuid;
      get diagnostics n = row_count;
      n_felder := n_felder + n;
    end if;
    if e ? 'status_nach' then
      update public.vertrieb_kampagne_kontakte k
        set status = e->>'status_nach'
      where k.id = (e->>'id')::uuid and k.status = e->>'status_von' and not k.status_manuell;
      get diagnostics n = row_count;
      n_status := n_status + n;
    end if;
  end loop;
  return query select n_felder, n_status;
end;
$$;

revoke all on function public.vertrieb_abgleich_speichern(jsonb) from public, anon, authenticated;
grant execute on function public.vertrieb_abgleich_speichern(jsonb) to service_role;

notify pgrst, 'reload schema';
