-- 264: Material-Liste in die Technik-Planung fusioniert (Leo 2026-09-24:
-- "Material & Plan" UND "Technik" nebeneinander ergibt keinen Sinn).
--
-- job_technik_positionen ist ab jetzt die EINE Materialliste des Auftrags:
--   + masse           (jsonb {l,b,h} in Metern — fuer den Aufbauplan)
--   + position        (jsonb (PlanPos|null)[] — Platzierungen pro Stueck)
--   + created_via     ('ki' = aus dem Eingang extrahiert, 'manuell')
--   + quelle_item_id  (Herkunft: job_inbox_items, fuer die Quelle-Ansicht)
--
-- job_material wird komplett entfernt (war leer — Feature war nie gepusht,
-- die Eingang-KI laeuft nur lokal). Der Plan-Editor platziert ab jetzt
-- Technik-Positionen; job_plan_objekte (Buehne, PA, Text, …) bleibt.

alter table public.job_technik_positionen
  add column if not exists masse jsonb,
  add column if not exists position jsonb,
  add column if not exists created_via text not null default 'manuell'
    check (created_via in ('ki', 'manuell')),
  add column if not exists quelle_item_id uuid
    references public.job_inbox_items(id) on delete set null;

drop table if exists public.job_material;
