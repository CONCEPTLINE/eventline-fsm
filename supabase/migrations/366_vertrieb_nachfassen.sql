-- 366: Vertrieb › Kampagnen — Nachfassen + Antworten ansehen (Leo, 29.10.2026).
--
-- !! Nummer beim Zusammenführen prüfen: höchste Nummer auf origin/main UND
-- !! allen Branches + 1 (Stand 29.10.2026: 364 auf main, 365 auf vertrieb-kampagnen).
-- !! Voraussetzung: 365_vertrieb_kampagnen.sql ist eingespielt.
--
-- 1. Nachfassen: Wer angeschrieben wurde und nach NACHFASS_TAGE (10, im Code
--    src/lib/vertrieb/nachfassen.ts — die Schwelle wird als Parameter
--    übergeben, nicht hier festgeschrieben) keine Antwort hat, ist
--    «Nachfassen fällig». Höchstens 2 Runden. Der vorbereitete Text
--    (KI-Vorschlag, editierbar) liegt in nachfass_betreff/nachfass_text.
-- 2. letzte_antwort_graph_id: Graph-ID der letzten Antwort (vom Abgleich),
--    damit das Detail die Antwort gezielt aus dem Postfach laden kann. Der
--    Mailinhalt selbst wird NIE gespeichert.
-- 3. vertrieb_kampagne_liste(): die Liste mit Rang inkl. «Nachfassen fällig»
--    (zeitabhängig → nicht als gespeicherte Spalte möglich), Filter,
--    Keyset-Paginierung und Trefferzahl in EINER Abfrage.
-- 4. vertrieb_kampagne_uebersicht(): wie vertrieb_kampagne_zahlen() plus
--    die Zahl der fälligen Nachfass-Kontakte.
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
  add column if not exists letzte_antwort_graph_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'vertrieb_kampagne_kontakte_nachfass_anzahl_check') then
    alter table public.vertrieb_kampagne_kontakte
      add constraint vertrieb_kampagne_kontakte_nachfass_anzahl_check check (nachfass_anzahl >= 0);
  end if;
end;
$$;

-- ===========================================================================
-- 3. Liste
--    Rang: 0 Antwort erhalten · 1 Anrufen · 2 Nachfassen fällig ·
--          3 Termin/Offerte · 4 offen/geplant/angeschrieben · 5 abgeschlossen
--    Keyset: (rang, firma, id) > (p_nach_rang, p_nach_firma, p_nach_id).
--    treffer = Anzahl aller Treffer des Filters (vor der Paginierung).
--    security invoker → RLS der Tabelle gilt (vertrieb:view).
-- ===========================================================================
create or replace function public.vertrieb_kampagne_liste(
  p_kampagne uuid,
  p_faellig_vor timestamptz,
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
             k.status = 'gesendet' and k.antworten_anzahl = 0 and k.nachfass_anzahl < 2
             and coalesce(k.nachgefasst_am, k.mail_gesendet_am) < p_faellig_vor,
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

revoke all on function public.vertrieb_kampagne_liste(uuid, timestamptz, text[], boolean, text, text, int, text, uuid, int) from public, anon;
grant execute on function public.vertrieb_kampagne_liste(uuid, timestamptz, text[], boolean, text, text, int, text, uuid, int) to authenticated, service_role;

-- ===========================================================================
-- 4. Übersicht: Status, Gruppen und fällige Nachfass-Kontakte
-- ===========================================================================
create or replace function public.vertrieb_kampagne_uebersicht(p_kampagne uuid, p_faellig_vor timestamptz)
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
    and k.status = 'gesendet' and k.antworten_anzahl = 0 and k.nachfass_anzahl < 2
    and coalesce(k.nachgefasst_am, k.mail_gesendet_am) < p_faellig_vor;
$$;

revoke all on function public.vertrieb_kampagne_uebersicht(uuid, timestamptz) from public, anon;
grant execute on function public.vertrieb_kampagne_uebersicht(uuid, timestamptz) to authenticated, service_role;

notify pgrst, 'reload schema';
