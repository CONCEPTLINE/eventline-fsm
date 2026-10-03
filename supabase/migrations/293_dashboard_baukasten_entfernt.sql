-- 291: Dashboard-Baukasten komplett entfernt (2026-10-02, Mischa: "Es soll
-- sich erleichternd anfuehlen, wenn man draufgeht"). Das Dashboard ist fest
-- (src/lib/dashboard-bereiche.ts); Nutzer blenden nichts mehr aus, schieben
-- nichts und aendern keine Breiten. Die Rollen-Schalter leben seit
-- Migration 290 in roles.dashboard_bereiche_aus.
--
-- ERST NACH DEM DEPLOY einspielen: der bisher live laufende Code liest
-- roles.dashboard_widgets und user_dashboard_overrides noch.
--
-- Daten vor dem Loeschen exportiert nach
-- C:\tmp\eventline-backup\dashboard-baukasten_2026-10-02.json
-- (roles.dashboard_widgets aller Rollen + alle Zeilen user_dashboard_overrides).
-- Bis zum Deploy kann das alte Dashboard noch Overrides schreiben — direkt
-- vor dem Einspielen den Export bei Bedarf mit diesem SELECT erneuern:
--   select json_build_object(
--     'roles_dashboard_widgets', (select coalesce(json_agg(json_build_object(
--        'slug', r.slug, 'label', r.label, 'dashboard_widgets', r.dashboard_widgets)
--        order by r.slug), '[]'::json) from public.roles r),
--     'user_dashboard_overrides', (select coalesce(json_agg(row_to_json(o)
--        order by o.user_id), '[]'::json) from public.user_dashboard_overrides o)
--   ) as backup;
--
-- Ohne CASCADE: haengt doch noch etwas daran, bricht die Migration ab.
-- (Geprueft 2026-10-02: keine Views, Funktionen oder Fremdschluessel auf
-- Tabelle/Spalte; Trigger und RLS-Policies fallen mit der Tabelle weg. Die
-- globale Trigger-Funktion public.update_updated_at() bleibt.)

drop table if exists public.user_dashboard_overrides;

alter table public.roles drop column if exists dashboard_widgets;
