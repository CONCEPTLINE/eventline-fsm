-- 196_bvg_threshold_public_rpc.sql
-- ============================================================
-- Public RPC fuer BVG-Eintrittsschwelle.
--
-- payroll_defaults (Migration 195) hat RLS gated auf lohn:manage —
-- normale Mitarbeiter/Client-Code kann die Tabelle nicht lesen. Fuer
-- die BVG-Vorabpruefung im Termin-Modal + Schichtplan brauchen wir
-- den Threshold aber auch fuer Nicht-Admins (die Info selbst ist
-- keine Payroll-Zahl, sondern die publik bekannte Schweizer BVG-
-- Eintrittsschwelle).
--
-- Security-definer RPC gibt gezielt nur den bvg_threshold_chf raus,
-- keine anderen Payroll-Werte.
-- ============================================================

create or replace function public.get_current_bvg_threshold(p_as_of date default (now() at time zone 'Europe/Zurich')::date)
returns numeric(10,2)
language sql stable security definer
set search_path = public
as $$
  select bvg_threshold_chf
  from public.payroll_defaults
  where effective_from <= p_as_of
  order by effective_from desc
  limit 1;
$$;

grant execute on function public.get_current_bvg_threshold(date) to authenticated;

comment on function public.get_current_bvg_threshold(date) is
  'Public read fuer die zum Datum gueltige BVG-Eintrittsschwelle (CHF/Monat). Bewusst als RPC statt Tabellen-Grant weil payroll_defaults sonst gated auf lohn:manage ist.';
