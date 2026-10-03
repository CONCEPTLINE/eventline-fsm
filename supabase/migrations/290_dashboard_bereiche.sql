-- 290: Dashboard fest statt Baukasten (2026-10-02, Mischa).
--
-- Das Dashboard hat jetzt feste Bereiche (src/lib/dashboard-bereiche.ts):
--   kennzahlen | aufmerksamkeit | anwesenheit | team | einsatz | monat
-- Nutzer koennen nichts mehr ausblenden, verschieben oder in der Breite
-- aendern. Was jemand sieht, folgt aus den Rechten der Rolle plus einem
-- Ein/Aus-Schalter je Bereich pro Rolle (z. B. Projekt-Leiter ohne
-- «Braucht Aufmerksamkeit» und ohne «Team»).
--
-- roles.dashboard_bereiche_aus = Liste der AUS-geschalteten Bereich-Keys.
-- Leer = alles an, was die Rechte erlauben. Fuer die Admin-Rolle ignoriert.
--
-- Backfill aus dem alten Rollen-Override roles.dashboard_widgets.hidden:
--   zu-erledigen ODER overdue-jobs                 -> aufmerksamkeit
--   team-status                                    -> team
--   anwesenheitskalender                           -> anwesenheit
--   ma-naechster-einsatz                           -> einsatz
--   ma-monat-stunden UND ma-prognose               -> monat
--   kpi-offene-auftraege UND kpi-termine-woche     -> kennzahlen
-- dashboard_widgets = NULL (Registry-Default) -> nichts aus.
--
-- Nur additiv: die alte Spalte und user_dashboard_overrides bleiben bis
-- Migration 291 (nach dem Deploy) stehen.
-- Idempotent: Spalte + Backfill laufen nur, wenn die Spalte noch fehlt —
-- ein zweiter Lauf ueberschreibt keine spaeteren Schalter-Aenderungen.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'roles' and column_name = 'dashboard_bereiche_aus'
  ) then
    alter table public.roles
      add column dashboard_bereiche_aus text[] not null default '{}';

    update public.roles r
    set dashboard_bereiche_aus = array_remove(array[
      case when src.h @> '["kpi-offene-auftraege"]'::jsonb and src.h @> '["kpi-termine-woche"]'::jsonb then 'kennzahlen' end,
      case when src.h @> '["zu-erledigen"]'::jsonb or src.h @> '["overdue-jobs"]'::jsonb then 'aufmerksamkeit' end,
      case when src.h @> '["anwesenheitskalender"]'::jsonb then 'anwesenheit' end,
      case when src.h @> '["team-status"]'::jsonb then 'team' end,
      case when src.h @> '["ma-naechster-einsatz"]'::jsonb then 'einsatz' end,
      case when src.h @> '["ma-monat-stunden"]'::jsonb and src.h @> '["ma-prognose"]'::jsonb then 'monat' end
    ]::text[], null)
    from (
      select slug, dashboard_widgets -> 'hidden' as h
      from public.roles
      where jsonb_typeof(dashboard_widgets -> 'hidden') = 'array'
    ) src
    where r.slug = src.slug;
  end if;
end $$;

comment on column public.roles.dashboard_bereiche_aus is
  'Dashboard-Bereiche, die fuer diese Rolle AUS geschaltet sind (Keys aus src/lib/dashboard-bereiche.ts: kennzahlen, aufmerksamkeit, anwesenheit, team, einsatz, monat). Leer = alles an, was die Rechte der Rolle erlauben. Fuer die Admin-Rolle ignoriert.';
