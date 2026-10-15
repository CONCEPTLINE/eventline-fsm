-- 339: KI-Vorschlag neben dem final gewaehlten Ziel einer Ablage aus der App
-- (Upload und Mail-Eingang) — Trefferquote der KI auch fuer diese Dokumente
-- (docs/technik-dashboard/VERTRAG.md §6.5). Nur additiv, idempotent.
--
-- ablage_items (271) ist die Historie jeder Ablage aus der App; dort stehen
-- schon der final gewaehlte Ordner (ordner_pfad) und Name (abgelegt_name).
-- Neu daneben, was die KI auf der Karte vorgeschlagen hatte:
--   ki_quelle  woher der Vorschlag kam: 'regel' / 'lokal' / 'claude' = die
--              lokale KI hat das Dokument gelesen, den Ordner bestimmte eine
--              Regel, die lokale KI oder Claude (ordner_quelle, V8);
--              'beschrieb' = Claude hat nur den getippten Beschrieb
--              strukturiert (lokale KI offline). null = kein KI-Vorschlag.
--   ki_ordner  vorgeschlagener Ordner (auch ein vorgeschlagener NEUER),
--              null = die KI hat keinen vorgeschlagen.
--   ki_name    Name, den der Vorschlag ergeben haette (gleiches Schema wie
--              abgelegt_name, beim Ablegen auf dem Server gebaut), null ohne
--              Betreff.
--   seiten     Seitenzahl, wenn die lokale KI das Dokument gelesen hat.
-- Nur Ordnerpfade, Namen und eine Zahl — dieselbe Art Daten wie die
-- bestehenden Spalten, nie Dokumentinhalt.
--
-- Die Lerntabelle nas_ablage_lernbeispiele (329) passt nicht: sie ist an
-- Vorschlaege des Rueckstaus ZZ gebunden (Beschrieb der lokalen KI Pflicht)
-- und speist die Beispiele fuer Claude — Ablagen aus der App duerfen dort
-- nicht hinein (personenbezogene Uploads gehen nie an Claude).
--
-- technik_leistung() (335) zaehlt zusaetzlich
--   uploads    Ablagen mit KI-Vorschlag: unveraendert (Ordner und Name),
--              Ordner bzw. Name geaendert, je Quelle;
--   groesstes  das Dokument mit den meisten Seiten, dessen vorgeschlagener
--              Ordner uebernommen wurde (App: ki_ordner = ordner_pfad;
--              Rueckstau ZZ: uebernommen in den vorgeschlagenen Ordner,
--              Seiten aus dem Beschrieb der lokalen KI) — nur Zahl, Herkunft
--              und Zeitpunkt.
--
-- Rechte: ablage_items unveraendert ((select public.is_admin()), alle vier
-- Verben, 271). technik_leistung bleibt security definer, nur service_role.

alter table public.ablage_items
  add column if not exists ki_quelle text
    check (ki_quelle in ('regel', 'lokal', 'claude', 'beschrieb')),
  add column if not exists ki_ordner text check (char_length(ki_ordner) <= 300),
  add column if not exists ki_name text check (char_length(ki_name) <= 240),
  add column if not exists seiten integer check (seiten between 1 and 100000);

create index if not exists ablage_items_ki_quelle
  on public.ablage_items (created_at) where ki_quelle is not null;

create or replace function public.technik_leistung(p_von timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with par as (
    select coalesce(p_von, '-infinity'::timestamptz) as von
  ),
  v as (
    select
      id,
      case when quelle = 'claude' then 'claude' else 'lokal' end as logik,
      status,
      created_at,
      entschieden_am,
      status in ('angenommen', 'korrigiert', 'erledigt') and entschieden_am is not null and gewaehlt_ordner is not null as uebernommen,
      status = 'abgelehnt' and entschieden_am is not null as abgelehnt,
      normalize(coalesce(gewaehlt_ordner, ''), nfc) <> normalize(ziel_ordner, nfc) as ordner_anders,
      normalize(coalesce(gewaehlt_name, regexp_replace(pfad, '^.*/', '')), nfc)
        <> normalize(coalesce(name_vorschlag, regexp_replace(pfad, '^.*/', '')), nfc) as name_anders
    from public.nas_vorschlaege
  ),
  ablage as (
    select
      v.logik,
      min(v.created_at) as seit,
      count(*) filter (where v.created_at >= p.von) as vorschlaege,
      count(*) filter (where v.status = 'offen') as offen,
      count(*) filter (where v.uebernommen and not v.ordner_anders and not v.name_anders and v.entschieden_am >= p.von) as unveraendert,
      count(*) filter (where v.uebernommen and (v.ordner_anders or v.name_anders) and v.entschieden_am >= p.von) as geaendert,
      count(*) filter (where v.uebernommen and v.ordner_anders and v.entschieden_am >= p.von) as ordner_geaendert,
      count(*) filter (where v.uebernommen and v.name_anders and v.entschieden_am >= p.von) as name_geaendert,
      count(*) filter (where v.abgelehnt and v.entschieden_am >= p.von) as abgelehnt,
      min(v.entschieden_am) filter (where (v.uebernommen or v.abgelehnt) and v.entschieden_am >= p.von) as entscheid_von,
      max(v.entschieden_am) filter (where (v.uebernommen or v.abgelehnt) and v.entschieden_am >= p.von) as entscheid_bis
    from v cross join par p
    group by v.logik
  ),
  -- Ablagen aus der App (Upload, Mail-Eingang) mit KI-Vorschlag (339)
  up as (
    select
      i.ki_quelle,
      i.created_at,
      i.seiten,
      normalize(coalesce(i.ki_ordner, ''), nfc) = normalize(i.ordner_pfad, nfc) as ordner_gleich,
      i.ki_name is not null and normalize(i.ki_name, nfc) = normalize(i.abgelegt_name, nfc) as name_gleich
    from public.ablage_items i
    where i.ki_quelle is not null
  ),
  uploads as (
    select
      min(up.created_at) as seit,
      count(*) filter (where up.created_at >= p.von) as mit_vorschlag,
      count(*) filter (where up.created_at >= p.von and up.ordner_gleich and up.name_gleich) as unveraendert,
      count(*) filter (where up.created_at >= p.von and not up.ordner_gleich) as ordner_geaendert,
      count(*) filter (where up.created_at >= p.von and not up.name_gleich) as name_geaendert,
      count(*) filter (where up.created_at >= p.von and up.ki_quelle = 'regel') as regel,
      count(*) filter (where up.created_at >= p.von and up.ki_quelle = 'lokal') as lokal,
      count(*) filter (where up.created_at >= p.von and up.ki_quelle = 'claude') as claude,
      count(*) filter (where up.created_at >= p.von and up.ki_quelle = 'beschrieb') as beschrieb
    from up cross join par p
  ),
  -- Uebernommene Vorschlaege mit Seitenzahl: App (Ordner wie vorgeschlagen) und Rueckstau ZZ (Claude-Logik, Seiten
  -- aus dem gefilterten Beschrieb der lokalen KI, nas_zz_beschriebe 329)
  akzeptiert as (
    select up.seiten::numeric as seiten, up.created_at as am, 'app'::text as herkunft
    from up
    where up.ordner_gleich and up.seiten is not null
    union all
    select (b.beschrieb->>'seiten')::numeric, v.entschieden_am, 'zz'::text
    from v
    join public.nas_zz_beschriebe b on b.vorschlag_id = v.id
    where v.uebernommen and not v.ordner_anders and jsonb_typeof(b.beschrieb->'seiten') = 'number'
  ),
  groesstes as (
    -- erst eingrenzen, dann umwandeln (ein unsinniger Wert im Beschrieb darf die Funktion nie sprengen)
    select round(a.seiten)::int as seiten, a.herkunft, a.am
    from akzeptiert a cross join par p
    where a.am >= p.von and a.seiten between 1 and 100000
    order by a.seiten desc, a.am desc
    limit 1
  ),
  fr as (
    select
      min(f.created_at) as seit,
      count(*) filter (where f.created_at >= p.von) as gefunden,
      count(*) filter (where f.status in ('aktiv', 'erledigt') and f.entschieden_am >= p.von) as bestaetigt,
      count(*) filter (where f.status = 'verworfen' and f.entschieden_am >= p.von) as verworfen,
      count(*) filter (where f.status = 'vorschlag') as offen
    from public.ablage_fristen f cross join par p
    where f.quelle = 'ki'
  ),
  si as (
    select
      min(s.started_at) as seit,
      count(*) filter (where s.started_at >= p.von) as rapporte
    from public.security_runs s cross join par p
    where s.narrative is not null and length(btrim(s.narrative)) > 0
  )
  select jsonb_build_object(
    'ablage', coalesce((select jsonb_agg(to_jsonb(a) order by a.logik) from ablage a), '[]'::jsonb),
    'uploads', (select to_jsonb(u) from uploads u),
    'groesstes', (select to_jsonb(g) from groesstes g),
    'fristen', (select to_jsonb(fr) from fr),
    'sicherheit', (select to_jsonb(si) from si)
  );
$$;

revoke all on function public.technik_leistung(timestamptz) from public, anon, authenticated;
grant execute on function public.technik_leistung(timestamptz) to service_role;
