-- Flaechenart: das K.-o.-Kriterium der Akquise.
--
-- Die erste Fassung der Bewertung (Migration 295) hat gemessen, was einer
-- Location FEHLT — und damit Tanzschulen, Clubs und ein Apartmenthotel
-- ganz nach oben sortiert. Denen fehlt zwar Vermarktung und Technik, aber
-- sie vermieten ihre Raeume gar nicht: sie bespielen sie selbst.
--
-- EVENTLINE uebernimmt den Betrieb FREMDER Raeume fuer Eigentuemer, die
-- vermieten (wollen), den Betrieb aber nicht selbst machen. Ob eine
-- Flaeche ueberhaupt vermietet wird, entscheidet deshalb vor allem
-- anderen, ob es einen Kunden gibt.
--
--   vermietung    — die Raeume werden an Dritte vermietet, das ist der Zweck
--   nebenbei      — Betrieb mit Saal, der zusaetzlich vermietet wird (Hotel)
--   eigennutzung  — nutzt die Flaeche selbst, vermietet nicht → kein Kunde
--   unklar        — noch nicht beurteilt

alter table public.akquise_locations
  add column if not exists flaeche text not null default 'unklar'
    check (flaeche in ('vermietung', 'nebenbei', 'eigennutzung', 'unklar'));

comment on column public.akquise_locations.flaeche is
  'Wofuer die Flaeche da ist. eigennutzung = kein Bedarf an Betrieb oder '
  'Vermarktung durch Dritte, unabhaengig davon was sonst fehlt.';

-- Die Trefferliste blendet Eigennutzer praktisch aus (Score 0) — ein
-- Teilindex auf den Rest haelt die haeufigste Abfrage klein.
create index if not exists akquise_locations_bedarf_idx
  on public.akquise_locations (score desc nulls last)
  where flaeche <> 'eigennutzung';
