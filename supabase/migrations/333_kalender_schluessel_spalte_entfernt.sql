-- 333_kalender_schluessel_spalte_entfernt.sql — Sicherheit & Datenbank-Grenzen, Teil 3
--
-- Datum: 2026-10-15. Nummer 333: 331 (Technik-Workflow) und 332 (Lieferanten-Verwaltung)
-- sind anderen Arbeitspaketen zugeteilt.
--
-- Der Kalender-Abo-Schluessel lebt seit 329 in profile_calendar_tokens (RLS: nur die eigene
-- Zeile). Der Code liest/schreibt seit 92f3d036 nur noch dort; profiles.calendar_feed_token
-- war fuer interne Konten weiterhin ueber «select *» fremder Profile lesbar und wird jetzt
-- entfernt. Vorab geprueft (2026-10-15): 11 Profile = 11 Schluessel, alle identisch, kein
-- Profil ohne Schluessel; im Code (origin/main) nur noch Kommentare.
--
--  1) Neue Profile bekommen ihren Schluessel weiter automatisch (Trigger ohne die Spalte).
--  2) Sync-Trigger auf die Spalte entfernen, dann Index + Spalte droppen.
--
-- Idempotent. Einspielen: node scripts/apply-migration.mjs supabase/migrations/333_kalender_schluessel_spalte_entfernt.sql

create or replace function public.profile_calendar_token_anlegen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profile_calendar_tokens (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return null;
end;
$$;

revoke execute on function public.profile_calendar_token_anlegen() from public, anon, authenticated;

drop trigger if exists profile_calendar_token_update on public.profiles;
drop trigger if exists profile_calendar_token_insert on public.profiles;
create trigger profile_calendar_token_insert
  after insert on public.profiles
  for each row execute function public.profile_calendar_token_anlegen();

drop function if exists public.profile_calendar_token_sync();

drop index if exists public.profiles_calendar_feed_token_idx;
alter table public.profiles drop column if exists calendar_feed_token;
