-- 314: ablage_fristen — Abgleich vor dem Umstellen der Leser (E3.4,
-- docs/lokale-ki/MASTERPLAN.md §4 «Backfill nochmals»). Nur Daten, nur
-- additiv, idempotent (beliebig oft ausfuehrbar).
--
-- Ab E3.4 lesen Erinnerungs-Cron, Dashboard, Buero-Bildschirm und die
-- Gruppe «Fristen» nur noch ablage_fristen; der Upload schreibt beide
-- Tabellen. Seit dem ersten Backfill (304) kann es geben:
--   a) neue Ablage-Eintraege mit Frist, die nur in ablage_items stehen;
--   b) Erinnerungen, die der alte Cron nur in ablage_items.frist_erinnert
--      vermerkt hat (sonst kaeme dieselbe Stufe nochmals per Mail);
--   c) Ablage-Fristen ohne sha256 (304 hat inhalt_hash nicht uebernommen —
--      die Nachtarbeit erkennt eine Frist auch ueber den Inhalt, §3.6).
--
-- REIHENFOLGE: vor dem Deploy des Codes einspielen und direkt nach dem
-- Deploy nochmals (Fristen, die dazwischen noch der alte Upload abgelegt
-- hat). ablage_items.frist / frist_erinnert entfernt erst eine spaetere
-- Migration (MASTERPLAN «Später»).

-- a) fehlende Ablage-Fristen (wie 304)
insert into public.ablage_fristen (ablage_item_id, pfad, sha256, art, datum, bezeichnung, quelle, status, erinnert)
select i.id, i.ordner_pfad || '/' || i.abgelegt_name, i.inhalt_hash, 'sonstige', i.frist,
       left(i.abgelegt_name, 120), 'ablage', 'aktiv', i.frist_erinnert
from public.ablage_items i
where i.frist is not null
on conflict do nothing;

-- b) Erinnerungsstufen zusammenfuehren (Vereinigung, nie etwas entfernen)
update public.ablage_fristen f
set erinnert = (
      select coalesce(jsonb_agg(s order by s desc), '[]'::jsonb)
      from (
        select distinct x::int as s
        from jsonb_array_elements_text(f.erinnert || coalesce(i.frist_erinnert, '[]'::jsonb)) as x
      ) stufen
    ),
    updated_at = now()
from public.ablage_items i
where f.ablage_item_id = i.id
  and f.quelle = 'ablage'
  and f.datum = i.frist
  and not (f.erinnert @> coalesce(i.frist_erinnert, '[]'::jsonb));

-- c) sha256 der Ablage-Fristen aus dem Inhalts-Hash (sha256, Upload-Route)
update public.ablage_fristen f
set sha256 = i.inhalt_hash,
    updated_at = now()
from public.ablage_items i
where f.ablage_item_id = i.id
  and f.sha256 is null
  and i.inhalt_hash ~ '^[0-9a-f]{64}$';
