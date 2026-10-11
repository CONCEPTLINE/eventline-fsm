-- Die drei Modelle A/B/C aus Leos Akquise-Auftrag.
--
-- Bisher standen hier vier selbst gesetzte Modelle (Vermietungsmanagement,
-- Vermietung+Betreuung, Betreuung, Technikpartner). Der verbindliche
-- Auftrag kennt drei, und sie folgen einer anderen Logik — nicht "was
-- fehlt dem Haus", sondern "stehen Zeitfenster leer und belastet die
-- Vermietung den Betrieb":
--
--   A Betriebspartner — der Verein KULTURLINE uebernimmt definierte
--     Zeitfenster, bespielt und vermietet sie; der Ort erhaelt pro
--     Veranstaltungstag einen fixen Anteil, ohne Aufwand und Risiko.
--   B Service-Partner — der Ort vermietet selbst, EVENTLINE liefert
--     Technik, Personal und Betreuung fuer die Mieter.
--   C Kulturfenster — der Verein bespielt einzelne Abende oder eine
--     Reihe, der Ort bleibt Hausherr.
--
-- Dazu zwei Felder, die der Auftrag verlangt: ob Zeitfenster real frei
-- sind (Grundbedingung fuer A und 20 % des Scorings) und die Monatsmiete
-- als Grundlage der Tarifrechnung.

alter table public.akquise_locations
  add column if not exists zeitfenster_frei text not null default 'unklar'
    check (zeitfenster_frei in ('ja', 'nein', 'unklar')),
  -- Monatsmiete der Liegenschaft in CHF. Selten oeffentlich; ohne sie
  -- sind keine Tagesansaetze rechenbar und im Dokument steht keine Zahl.
  add column if not exists monatsmiete_chf integer,
  -- Priorität nach dem Auftrag: A ab 3.8, B ab 3.0, sonst C.
  add column if not exists prioritaet text
    check (prioritaet is null or prioritaet in ('A', 'B', 'C'));

comment on column public.akquise_locations.zeitfenster_frei is
  'Stehen Zeitfenster real leer? Grundbedingung fuer Modell A.';
comment on column public.akquise_locations.monatsmiete_chf is
  'Monatsmiete der Liegenschaft. Tagesmietwert = Monatsmiete / 28, '
  'mal Kategorie-Faktor = Tagesansatz. Intern, nie als Formel kommunizieren.';

-- Alte Modellwerte auf die drei neuen abbilden, bevor der Check greift.
update public.akquise_locations set empfohlenes_modell = case empfohlenes_modell
  -- "Wir vermarkten und buchen" entspricht am ehesten dem Betriebspartner.
  when 'vermietungsmanagement' then 'betriebspartner'
  when 'vermietung_betreuung'  then 'betriebspartner'
  -- Reine Betreuung bzw. Technik ist die Service-Partner-Rolle.
  when 'betreuung'             then 'servicepartner'
  when 'technikpartner'        then 'servicepartner'
  else empfohlenes_modell
end
where empfohlenes_modell in
  ('vermietungsmanagement', 'vermietung_betreuung', 'betreuung', 'technikpartner');

alter table public.akquise_locations
  drop constraint if exists akquise_locations_empfohlenes_modell_check;

alter table public.akquise_locations
  add constraint akquise_locations_empfohlenes_modell_check
  check (empfohlenes_modell is null or empfohlenes_modell in
    ('betriebspartner', 'servicepartner', 'kulturfenster', 'keins'));

-- Arbeitsliste: A-Ziele zuerst.
create index if not exists akquise_locations_prioritaet_idx
  on public.akquise_locations (prioritaet, score desc nulls last);
