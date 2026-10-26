-- 354: Technik — je Positionsgruppe ein Absatz «Zusammenhang» (Leo 2026-10-26:
-- «Pro Positionsgruppe ein Beschreibungsparagraph», damit der Techniklieferant
-- nicht nur Positionen hat, sondern versteht, wofuer, wo/wann und wie alles
-- zusammenhaengt).
--
-- job_anforderungen
--   + zusammenhang   kurzer Absatz (2–5 Saetze) in Klartext, NUR aus dem, was
--                    Kunde/Rider sagt (Eingang-KI) oder von Hand. Neben titel
--                    (Kurztitel) und text (kurzer Klartext). Von Hand geaendert
--                    → manuell_geaendert_at (die KI fasst die Gruppe nicht mehr an).
--
-- Trigger «Inhalt geaendert» (Migration 352) zaehlt den Absatz mit: eine
-- Aenderung markiert die Gruppe im Lieferantenportal als «Geändert». Ausnahme
-- fuer den Nachlauf auf den Bestand (CLAUDE.md B3): mit
--   set local eventline.ohne_aenderungsmarker = 'an';
-- nachgetragene Absaetze sind keine Aenderung der Planung → kein Marker.
--
-- NUR additiv (B1), idempotent.

alter table public.job_anforderungen
  add column if not exists zusammenhang text;

create or replace function public.technik_gruppe_inhalt_geaendert()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (new.titel is distinct from old.titel
      or new.text is distinct from old.text
      or new.zusammenhang is distinct from old.zusammenhang)
     and coalesce(current_setting('eventline.ohne_aenderungsmarker', true), '') <> 'an' then
    new.inhalt_geaendert_at := now();
  end if;
  return new;
end;
$$;
revoke all on function public.technik_gruppe_inhalt_geaendert() from public, anon;
