-- Team, Partner und Geschaeftsstruktur der Location.
--
-- Der Grund: Hat ein Haus vier eigene Techniker oder einen festen
-- Technikpartner, ist EVENTLINE dort als Technikpartner draussen — egal
-- wie attraktiv die Flaeche sonst ist. Umgekehrt ist ein Haus ohne
-- eigenes Team und ohne Partner der klare Fall. Diese Felder entscheiden
-- also ueber die Machbarkeit, nicht nur ueber die Attraktivitaet.
--
-- Alle Angaben stammen aus der Website der Location (siehe
-- kontakt_quelle, Migration 297) — nicht geschaetzt. Was dort nicht
-- steht, bleibt null bzw. 'unklar'.

alter table public.akquise_locations
  -- Anzahl erkennbarer Techniker im eigenen Team. 0 = ausdruecklich
  -- keine, null = die Website sagt nichts dazu.
  add column if not exists techniker_im_team integer,
  -- Fester externer Technikpartner genannt?
  add column if not exists technikpartner text
    check (technikpartner is null or technikpartner in ('ja', 'nein', 'unklar')),
  -- Name des Partners, falls genannt — sagt uns, gegen wen wir antreten.
  add column if not exists technikpartner_name text,
  -- Wie das Team aussieht, in einem Satz von der Website.
  add column if not exists team_beschreibung text,
  -- Rechtsform/Traegerschaft: verein, stiftung, gmbh, ag, einzelfirma,
  -- oeffentlich, genossenschaft, unbekannt. Freitext, weil die Website
  -- es in beliebiger Form schreibt.
  add column if not exists geschaeftsstruktur text;

comment on column public.akquise_locations.techniker_im_team is
  'Erkennbare eigene Techniker. Je mehr, desto schwieriger fuer EVENTLINE '
  'als Technikpartner. null = Website sagt nichts dazu.';
comment on column public.akquise_locations.technikpartner is
  'Fester externer Technikpartner vorhanden? Ja = Technikpartner-Modell faellt weg.';

-- Arbeitsliste: Kandidaten ohne eigenes Technikteam zuerst.
create index if not exists akquise_locations_technik_idx
  on public.akquise_locations (techniker_im_team nulls first, score desc);

-- Vollstaendiges Rechercheergebnis als Dossier.
--
-- Die Website gibt mehr her als ein paar Spalten fassen: Raeume mit
-- Groessen, Infrastruktur, Preishinweise, was dort stattfindet, seit wann
-- es das Haus gibt. Das alles als eigene Spalten anzulegen hiesse, bei
-- jeder neuen Frage eine Migration zu schreiben — als strukturiertes
-- JSON bleibt es erweiterbar und steht trotzdem geordnet da.
--
-- Form (alle Felder optional, null wenn die Website nichts hergibt):
--   {
--     raeume: [{ name, kapazitaet, flaeche_m2, eignung }],
--     infrastruktur: ["Küche", "Bar", "Parkplätze", …],
--     preis_hinweis: "ab 800 CHF/Tag" | null,
--     preise_oeffentlich: true | false,
--     veranstaltungstypen: ["Konzerte", "Firmenanlässe", …],
--     betrieb_seit: "2019" | null,
--     besonderheiten: "…" | null,
--     gelesene_seiten: [{ url, zweck }]
--   }
alter table public.akquise_locations
  add column if not exists recherche jsonb;

comment on column public.akquise_locations.recherche is
  'Dossier aus der Website-Recherche. gelesene_seiten belegt, woher die '
  'Angaben stammen — nichts darin ist geschaetzt.';
