-- 340: profiles.settings entfernt.
--
-- Die Spalte (Migration 014, jsonb, Default '{}') hielt nur die Quick-Links
-- der Route /api/user-settings. Die Route ist seit Commit 0ea64ceb weg (live),
-- kein Code liest oder schreibt die Spalte mehr (geprueft auf origin/main:
-- keine Zugriffe, keine Typen; die select('*')-Leser — /api/me, Datenexport,
-- Personal-Dossier — nutzen das Feld nicht). Live hatten 0 von 11 Profilen
-- dort Inhalt. Keine Abhaengigkeiten ausser dem eigenen Default (keine View,
-- Funktion, Policy oder Publikation nutzt die Spalte).
--
-- Pruefen:
--   select count(*) from information_schema.columns
--   where table_schema = 'public' and table_name = 'profiles' and column_name = 'settings';  -- 0

alter table public.profiles drop column if exists settings;
