-- Rückweg Migration 368 (Stempel-Regeln) — z. B. wenn das Stempeln am Handy
-- wegen der neuen Regeln klemmt. Entfernt die Ausschluss-Bedingung gegen
-- überlappende Stempel und die Begründungspflicht über 16 Stunden.
-- Markierungen (ueberlappung_altfall) und Begründungen BLEIBEN. Die Erweiterung
-- btree_gist bleibt (harmlos). Erneutes Einspielen von 368 stellt die Regeln
-- wieder her (markiert dabei neue Überlappungen als Altfall — vorher mit
-- pruefen-live.mjs vorher-368 ansehen).

alter table public.time_entries drop constraint if exists time_entries_keine_ueberlappung;
drop trigger if exists time_entries_lang_begruendung on public.time_entries;
drop function if exists public.time_entries_lang_begruendung();
