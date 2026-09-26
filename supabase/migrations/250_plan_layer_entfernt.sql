-- Plan-Layer-Funktion komplett entfernt (Leo, 2026-09-20): kein Mehrwert.
-- Die Basis-Unterlage (locations.plan_unterlage) bleibt — sie ist das
-- Fundament der 2D-Planung im Auftrag.

drop table if exists public.location_plan_objekte;
drop table if exists public.location_plan_layer;
