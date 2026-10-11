-- Wo steht ein Kandidat, und wann wird nachgehakt?
--
-- Bewusst klein gehalten: Leo und Mischa schaffen rund eine Location pro
-- Tag, eine Liste von zwanzig ist also vier Wochen Arbeit. In der Zeit
-- verliert man ohne Festhalten den Faden — aber eine Pipeline mit zehn
-- Stufen und Pflichtfeldern wuerde dabei mehr kosten als helfen.
--
-- Deshalb genau drei Dinge:
--   stand            — vier Werte, mehr braucht es nicht
--   wiedervorlage_am — ein Datum, sonst nichts
--   gespraechsnotiz  — freier Text aus dem Gespraech
--
-- Die Gespraechsnotiz ist das Wertvollste davon: was im Gespraech gesagt
-- wird, ist belastbarer als jede Website-Recherche, und sie soll spaeter
-- in Bedarfsanalyse und Konzept einfliessen koennen.

alter table public.akquise_locations
  add column if not exists stand text not null default 'neu'
    check (stand in ('neu', 'angeschrieben', 'gespraech', 'abgehakt')),
  add column if not exists wiedervorlage_am date,
  add column if not exists gespraechsnotiz text;

comment on column public.akquise_locations.stand is
  'neu | angeschrieben | gespraech | abgehakt. Bewusst vier Werte.';
comment on column public.akquise_locations.gespraechsnotiz is
  'Was im Gespraech gesagt wurde — Grundlage fuer Bedarfsanalyse und Konzept.';

-- Arbeitsliste: was ist faellig?
create index if not exists akquise_locations_wiedervorlage_idx
  on public.akquise_locations (wiedervorlage_am)
  where wiedervorlage_am is not null and stand <> 'abgehakt';
