-- 335: Kennzahlen «Leistung» der lokalen KI fuer das Technik-Dashboard
-- (docs/technik-dashboard/VERTRAG.md §6.5). Nur additiv, idempotent.
--
-- Eine lesende Funktion zaehlt im FSM, was Menschen mit den Ergebnissen der
-- lokalen KI gemacht haben (die Zahlen vom Rig selbst kommen im Messpaket,
-- rig.leistung, §2.6):
--   ablage     Entscheide ueber Ablage-Vorschlaege (nas_vorschlaege, 303/329)
--              je Logik: «lokal» (Regel/Vorbild/Modell auf dem Rig, seit 12.10.)
--              und «claude» (Rig beschreibt, Claude schlaegt vor, seit 15.10.).
--              Unveraendert/geaendert nach derselben Regel wie die Lerntabelle
--              nas_ablage_lernbeispiele (lib/ki/vorschlaege baueLernbeispiel:
--              Ordner und Name in NFC verglichen, ohne gewaehlten Namen gilt der
--              bisherige Dateiname). Gezaehlt ab Start der jeweiligen Logik.
--   fristen    KI-Fristen (ablage_fristen quelle 'ki', 304): gefunden,
--              bestaetigt (aktiv/erledigt), verworfen, jetzt offen.
--   sicherheit Sicherheits-Laeufe mit Klartext-Rapport der KI
--              (security_runs.narrative, 324).
-- p_von = Beginn des Zeitraums (null = gesamt). Zurueck gehen nur Zahlen und
-- Zeitpunkte — nie Pfade, Ordner, Dateinamen oder Inhalte.
--
-- Rechte: security definer, ausfuehren nur service_role (GET
-- /api/technik/leistung prueft vorher Admin). Keine neue Tabelle, keine
-- RLS-Aenderung.

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
    'fristen', (select to_jsonb(fr) from fr),
    'sicherheit', (select to_jsonb(si) from si)
  );
$$;

revoke all on function public.technik_leistung(timestamptz) from public, anon, authenticated;
grant execute on function public.technik_leistung(timestamptz) to service_role;
