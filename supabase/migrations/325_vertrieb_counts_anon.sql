-- 325_vertrieb_counts_anon.sql
-- Vom taeglichen Auto-Sicherheits-Check (2026-10-15) gefunden: die View
-- public.vertrieb_counts war OHNE Login lesbar (aggregierte Vertriebs-Pipeline-
-- Zahlen: total/offen/kontaktiert/gewonnen/…). Gleiches Muster wie
-- v_location_rate_tiers_current (Migration 320): definer-rechte View ->
-- security_invoker (laeuft mit Rechten des Aufrufers, respektiert RLS der
-- Basis-Tabelle) und den anon-Grant entziehen. Idempotent + additiv; aendert
-- KEINEN legitimen Zugriff eingeloggter Nutzer.
alter view public.vertrieb_counts set (security_invoker = on);
revoke select on public.vertrieb_counts from anon;
