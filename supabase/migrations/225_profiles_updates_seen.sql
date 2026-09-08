-- 225_profiles_updates_seen.sql
-- ============================================================
-- "Was ist neu"-Popup: pro User merken, bis zu welchem Zeitpunkt er
-- die App-Neuerungen gesehen hat. Das Login-Popup (Nicht-Admins)
-- erscheint, wenn der neueste Eintrag in src/lib/app-updates.ts
-- juenger ist als profiles.updates_seen_at, und setzt den Timestamp
-- beim Schliessen (via API-Route mit Admin-Client — kein RLS-Risiko).
-- NULL = noch nie gesehen -> Popup beim naechsten Login.
-- ============================================================

alter table public.profiles
  add column if not exists updates_seen_at timestamptz;

comment on column public.profiles.updates_seen_at is
  'Bis wann hat der User die App-Neuerungen (/was-ist-neu) gesehen. NULL = noch nie; Popup zeigt Eintraege neuer als dieser Zeitpunkt.';
