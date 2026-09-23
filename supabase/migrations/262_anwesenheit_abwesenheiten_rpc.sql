-- Dashboard-Anwesenheitskalender soll Abwesenheiten (Ferien/Militaer/…)
-- direkt mitanzeigen (Leo 2026-09-23). Die time_off-RLS erlaubt normalen
-- Mitarbeitern nur eigene Eintraege — fuers Team-Grid liefert diese
-- SECURITY-DEFINER-RPC die GENEHMIGTEN Abwesenheiten aller Grid-
-- Personen, gegated wie das Grid selbst (nur wer selbst in
-- get_anwesenheit_users steht). Nur user_id + Zeitraum + Typ — keine
-- Notizen/Begruendungen.

create or replace function public.get_anwesenheit_abwesenheiten(p_von date, p_bis date)
returns table(user_id uuid, start_date date, end_date date, type text)
language sql stable security definer set search_path = public as $$
  select t.user_id, t.start_date, t.end_date, t.type
  from public.time_off t
  where t.status = 'genehmigt'
    and t.start_date <= p_bis
    and t.end_date >= p_von
    and exists (select 1 from public.get_anwesenheit_users() u where u.id = auth.uid())
    and exists (select 1 from public.get_anwesenheit_users() u where u.id = t.user_id);
$$;
