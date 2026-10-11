-- Ansprechpartner je Kandidat.
--
-- Eine Location ohne Ansprechperson ist kein verwertbarer Lead: jemand
-- muesste erst recherchieren, wen er anruft. Die Felder werden aus der
-- Website der Location gelesen (Kontakt-/Impressum-/Vermietungsseite),
-- NICHT geschaetzt — `kontakt_quelle` haelt fest, woher die Angabe
-- stammt, damit niemand einen erfundenen Namen anschreibt.

alter table public.akquise_locations
  add column if not exists ansprechperson  text,
  add column if not exists position        text,
  -- URL der Seite, auf der die Angaben gefunden wurden.
  add column if not exists kontakt_quelle  text,
  add column if not exists angereichert_am timestamptz,
  -- Was die Website ueber die Vermietung sagt — bestaetigt oder
  -- widerlegt die Einschaetzung der Flaechenart aus Migration 296.
  add column if not exists vermietung_hinweis text;

comment on column public.akquise_locations.kontakt_quelle is
  'URL, auf der Ansprechperson/Kontakt gefunden wurden. Leer = nicht belegt, '
  'dann sind ansprechperson/email/telefon nicht aus der Website bestaetigt.';

-- Arbeitsliste: angereicherte Kandidaten mit Bedarf, beste zuerst.
create index if not exists akquise_locations_angereichert_idx
  on public.akquise_locations (score desc nulls last)
  where angereichert_am is not null;
