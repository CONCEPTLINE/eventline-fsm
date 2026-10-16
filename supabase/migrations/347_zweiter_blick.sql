-- 347: Zweiter Blick (16.10.2026) — nachts liest das Hauptmodell der lokalen KI (Gemma 4 26B) Dokumente im
-- Rueckstau ZZ mit offenem, unentschiedenem Vorschlag nochmals. Ist sein Beschrieb inhaltlich anders oder
-- vollstaendiger, meldet das Rig ihn mit dem Rezept «<rezept>+zb» (z. B. zz/v4+zb); die Warteschlange fragt Claude
-- erneut und ersetzt den Vorschlag nur, wenn er noch offen und nie entschieden ist (lib/ki/zz-warteschlange). Nur
-- additiv, idempotent.
--
-- nas_vorschlaege (303, 329) bekommt, was der Vorschlag ERSETZT hat (gesetzt von der Warteschlange beim Ersetzen
-- eines offenen Vorschlags; null = hat nichts ersetzt):
--   ersetzt_ziel  Zielordner des ersetzten Vorschlags
--   ersetzt_name  Namensvorschlag des ersetzten Vorschlags (null = er hatte keinen)
-- Damit zeigt die NAS-Seite beim Kennzeichen «zweiter Blick», ob sich der Vorschlag geaendert hat, und
-- technik_leistung() zaehlt es. Nur Ordnerpfade und Dateinamen — dieselbe Art Daten wie ziel_ordner/name_vorschlag.
--
-- technik_leistung() (335, 339) zaehlt zusaetzlich `zweiter_blick`: Vorschlaege aus dem zweiten Blick (Rezept mit
-- «+zb»), davon offen, davon mit ersetztem Vorschlag und davon geaendert (Ordner bzw. Name anders als vorher).
-- Wie viele Dokumente das Hauptmodell nachgelesen hat (auch ohne Unterschied), zaehlt das Rig (Sammler, rig.leistung).
--
-- Rechte: nas_vorschlaege unveraendert (nur Admin, alle vier Verben, 303). technik_leistung bleibt security definer,
-- nur service_role.

alter table public.nas_vorschlaege
  add column if not exists ersetzt_ziel text check (char_length(ersetzt_ziel) <= 300),
  add column if not exists ersetzt_name text check (char_length(ersetzt_name) <= 160);

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
  ),
  -- Zweiter Blick (347): Vorschlaege mit Rezept «…+zb»; geaendert = Ordner oder Name anders als beim ersetzten.
  zb as (
    select
      n.created_at,
      n.status,
      n.ersetzt_ziel is not null as ersetzt,
      n.ersetzt_ziel is not null and normalize(n.ersetzt_ziel, nfc) <> normalize(n.ziel_ordner, nfc) as ordner_anders,
      n.ersetzt_ziel is not null
        and normalize(coalesce(n.ersetzt_name, ''), nfc) <> normalize(coalesce(n.name_vorschlag, ''), nfc) as name_anders
    from public.nas_vorschlaege n
    where n.art = 'zz' and n.rezept like '%+zb'
  ),
  zweiter_blick as (
    select
      min(zb.created_at) as seit,
      count(*) filter (where zb.created_at >= p.von) as vorschlaege,
      count(*) filter (where zb.status = 'offen') as offen,
      count(*) filter (where zb.created_at >= p.von and zb.ersetzt) as ersetzt,
      count(*) filter (where zb.created_at >= p.von and (zb.ordner_anders or zb.name_anders)) as geaendert,
      count(*) filter (where zb.created_at >= p.von and zb.ordner_anders) as ordner_geaendert,
      count(*) filter (where zb.created_at >= p.von and zb.name_anders) as name_geaendert
    from zb cross join par p
  )
  select jsonb_build_object(
    'ablage', coalesce((select jsonb_agg(to_jsonb(a) order by a.logik) from ablage a), '[]'::jsonb),
    'uploads', (select to_jsonb(u) from uploads u),
    'groesstes', (select to_jsonb(g) from groesstes g),
    'fristen', (select to_jsonb(fr) from fr),
    'sicherheit', (select to_jsonb(si) from si),
    'zweiter_blick', (select to_jsonb(z) from zweiter_blick z)
  );
$$;

revoke all on function public.technik_leistung(timestamptz) from public, anon, authenticated;
grant execute on function public.technik_leistung(timestamptz) to service_role;
