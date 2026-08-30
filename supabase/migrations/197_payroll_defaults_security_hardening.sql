-- 197_payroll_defaults_security_hardening.sql
-- ============================================================
-- Follow-Up zu Migration 195. Audit-Findings:
--
-- 1) BLOCKER: get_payroll_defaults_as_of() war SECURITY DEFINER +
--    RETURNS SETOF payroll_defaults + GRANT EXECUTE TO authenticated
--    -> jeder eingeloggte Nutzer (auch Techniker/Partner ohne
--    lohn:manage) konnte via PostgREST alle 12 Firmen-Prozentsaetze
--    + BVG-Threshold + Notes auslesen. RLS auf payroll_defaults war
--    damit wirkungslos. Zusaetzlich ist der RPC im gesamten Backend
--    nie aufgerufen (loadLohnDefaults nutzt admin client direkt).
--    -> ersatzlos droppen.
--
-- 2) MEDIUM: kein Guard gegen retroaktive INSERTs mit alte
--    effective_from-Datums. Damit koennte lohn:manage-Nutzer die
--    2020-Baseline verschieben und alte Lohnabrechnungen bei
--    Regenerate mit anderen Saetzen rechnen. In der API-Route wird
--    das schon geblockt, aber Defense-in-Depth via CHECK-Constraint
--    ist trivial und wehrt Direktzugriffe ab.
-- ============================================================

-- 1) Leaky RPC ersatzlos droppen.
drop function if exists public.get_payroll_defaults_as_of(date);

-- 2) CHECK-Constraint gegen retroaktive Baseline-Verschiebung.
--    Das Baseline-Datum 2020-01-01 kommt aus 195 (seedet die
--    urspruenglichen app_settings-Werte). Neuere Zeilen duerfen nie
--    davor liegen — sonst wuerden alte Rechnungen bei Regenerate
--    einen abweichenden Satz sehen.
alter table public.payroll_defaults
  drop constraint if exists payroll_defaults_no_pre_baseline;
alter table public.payroll_defaults
  add constraint payroll_defaults_no_pre_baseline
  check (effective_from >= '2020-01-01');
