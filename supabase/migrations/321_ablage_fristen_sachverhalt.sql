-- 321: ablage_fristen — gleiche Frist aus mehreren Dokumenten nur EINMAL
-- (src/lib/ki/fristen-sachverhalt.ts). Nur additiv, idempotent.
--
-- Ursache: die Nachtarbeit erkannte «schon bekannt» nur je Datei (Pfad,
-- Ablage-Eintrag, sha256). Derselbe Vertrag als .docx und .pdf, als Entwurf
-- und als Kopie unter «Historie» ergab je eine eigene Frist (SCALA BASEL:
-- 4× «Kündigung · 31.12.2027»).
--
--   sachverhalt    Art + Vertragspartei, normalisiert («kuendigung:scala
--                  basel»); gesetzt vom FSM (Nachtarbeit), null ohne Partei.
--   weitere_pfade  weitere Quell-Dokumente derselben Frist (pfad bleibt das
--                  Haupt-Dokument).
--
-- Unique: je Sachverhalt + Datum hoechstens EIN offener KI-Vorschlag.
-- Bestehende Doppel stoeren den Index nicht (sachverhalt ist dort noch
-- null); zusammengefuehrt werden sie getrennt mit
-- scripts/fristen-duplikate.mjs (nach Sicherung, nur nach Freigabe).
-- RLS unveraendert (304: is_admin, alle 4 Verben).

alter table public.ablage_fristen add column if not exists sachverhalt text;
alter table public.ablage_fristen add column if not exists weitere_pfade text[] not null default '{}';

create unique index if not exists ablage_fristen_sachverhalt_vorschlag_uq
  on public.ablage_fristen (sachverhalt, datum)
  where sachverhalt is not null and status = 'vorschlag';

-- Abgleich der Nachtarbeit (alle Status: verworfen bleibt verworfen).
create index if not exists ablage_fristen_sachverhalt on public.ablage_fristen (sachverhalt, datum) where sachverhalt is not null;
-- «schon bekannt» auch fuer die weiteren Dokumente einer Frist.
create index if not exists ablage_fristen_weitere_pfade on public.ablage_fristen using gin (weitere_pfade);
