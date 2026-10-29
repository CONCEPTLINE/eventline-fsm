-- Rückweg Migration 364 (Lohn-Umbau Phase 2) — nur wenn der Phase-1-Code
-- wieder laufen soll (Vercel «Promote» auf den vorherigen Deploy).
--
-- Entfernt, was den Phase-1-Code behindern würde: Sperre und Protokoll auf
-- Lohnzeilen/Firmensätzen (der alte Lohn-Editor schreibt direkt) sowie die
-- Phase-2-Funktionen. Tabellen und ihre Daten BLEIBEN (Momentaufnahmen,
-- Anstellungen, Protokoll, Anträge, Vorschläge) — nichts wird gelöscht; ein
-- erneutes Einspielen von 364 stellt alles wieder her (idempotent, lokal geprüft).
-- Einspielen wie eine Migration (Management API), danach pruefen-live.mjs vorher
-- zeigt «Phase 2 noch nicht eingespielt» NICHT (Tabellen bleiben) — erwartet.

do $$
declare
  t text;
begin
  foreach t in array array['employee_compensation', 'payroll_defaults', 'lohn_anstellungen'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_lohn_sperre', t);
    execute format('drop trigger if exists %I on public.%I', t || '_lohn_protokoll', t);
  end loop;
end $$;

drop function if exists public.lohn_aenderung_direkt(jsonb, uuid, text);
drop function if exists public.lohn_aenderung_ausfuehren(uuid, uuid, text, text);
drop function if exists public.lohn_operationen_anwenden(jsonb);
drop function if exists public.lohn_momentaufnahme_speichern(uuid, integer, integer, text, text, bigint, text, uuid, text, boolean, date, boolean, text, jsonb, jsonb, text, jsonb, text, uuid);
drop function if exists public.lohn_sperre_pruefen();
drop function if exists public.lohn_aenderung_protokollieren();
