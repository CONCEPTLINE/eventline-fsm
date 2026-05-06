-- Drop des veralteten profiles_role_check-Constraints.
--
-- 001_create_profiles.sql hat profiles.role mit
--   check (role in ('admin', 'techniker'))
-- angelegt. 048_roles.sql hat dann das dynamische Rollen-System mit der
-- roles-Tabelle eingefuehrt — der Migrations-Header sagt explizit
-- "profile.role bleibt ein text-Feld ohne FK — Validierung passiert in
-- der Anwendungs-Logik" — aber der alte CHECK-Constraint wurde nie
-- gedropt.
--
-- Konsequenz: Eigene Rollen (z.B. 'vertrieb', 'buchhaltung') konnten
-- zwar in roles angelegt werden, das Zuweisen an einen User
-- (UPDATE profiles SET role = '<custom-slug>') wurde aber vom
-- CHECK-Constraint geblockt — User sah "Update fehlgeschlagen".
--
-- Validierung des Rollen-Slugs passiert jetzt in der API
-- (PATCH /api/admin/users/[id]) ueber einen Lookup in der roles-Tabelle.

alter table public.profiles drop constraint if exists profiles_role_check;
