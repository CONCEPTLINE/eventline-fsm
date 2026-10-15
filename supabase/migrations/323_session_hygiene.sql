-- 323_session_hygiene.sql
-- Offene Sitzungen (ended_at IS NULL) mit altem Heartbeat als 'expired' schliessen.
-- Tab-Schliessen beendet die Sitzung nicht -> ohne das sammeln sich Karteileichen
-- (Stand 2026-10-15: 156 offen, davon 149 seit >24h inaktiv, aelteste vom 10. Juni).
-- Laeuft kuenftig taeglich im db-retention-Cron; diese Migration raeumt die
-- Altlasten einmalig. ended_at wird auf den letzten Heartbeat gesetzt (ehrlich,
-- nicht "jetzt"). Loeschen >180 Tage macht db-retention weiterhin separat.
-- Idempotent + additiv.

create or replace function public.expire_stale_user_sessions(p_days integer default 7)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  update public.user_sessions
     set ended_at   = coalesce(last_seen_at, started_at),
         end_reason = 'expired'
   where ended_at is null
     and coalesce(last_seen_at, started_at) < now() - make_interval(days => greatest(1, p_days));
  get diagnostics n = row_count;
  return coalesce(n, 0);
end;
$$;

-- Nur der Cron (service_role) darf massenhaft Sitzungen schliessen.
revoke all on function public.expire_stale_user_sessions(integer) from public, anon, authenticated;
grant execute on function public.expire_stale_user_sessions(integer) to service_role;

-- Einmalige Altlasten-Bereinigung (>7 Tage ohne Heartbeat jetzt schliessen).
select public.expire_stale_user_sessions(7);
