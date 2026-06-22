-- get_job_hours_audit: nicht-verrechnete Stunden separat ausweisen.
--
-- Vorher: rapport_minutes summierte ALLE time_ranges, also auch jene die
-- der User explizit als "nicht verrechnen" markiert hat. Die Differenz
-- (Rapport - Stempel) wurde dadurch positiv verzerrt — der Audit zeigte
-- "Mehr-Rapport-als-Stempel" obwohl der Mehraufwand bewusst dem Kunden
-- nicht in Rechnung gestellt wird, also nicht "fehlt".
--
-- Neu:
--   rapport_minutes      = nur Ranges OHNE not_billable
--   not_billable_minutes = Ranges MIT not_billable=true (gelbe Sub-Anzeige)
--   diff_minutes         = rapport_minutes - stempel_minutes
--
-- Damit ist die Differenz wieder das ehrliche Audit-Signal: passt der
-- gestempelte Aufwand zum verrechneten Aufwand?

-- DROP-then-CREATE statt OR REPLACE: Postgres erlaubt kein In-Place-
-- Aendern der RETURN-Spalten einer Funktion (42P13).
DROP FUNCTION IF EXISTS public.get_job_hours_audit(uuid);

CREATE OR REPLACE FUNCTION public.get_job_hours_audit(p_job_id uuid)
RETURNS TABLE(
  user_id uuid,
  user_name text,
  stempel_minutes integer,
  rapport_minutes integer,
  not_billable_minutes integer,
  diff_minutes integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: nur fuer Administratoren';
  END IF;
  RETURN QUERY
  WITH stempel AS (
    SELECT t.user_id,
      SUM(GREATEST(0, EXTRACT(EPOCH FROM (t.clock_out - t.clock_in)) / 60))::int AS minutes
    FROM public.time_entries t
    WHERE t.job_id = p_job_id AND t.clock_out IS NOT NULL
    GROUP BY t.user_id
  ),
  -- Verrechenbare Rapport-Stunden (not_billable IS NOT TRUE).
  rapport AS (
    SELECT (range->>'technician_id')::uuid AS user_id,
      SUM(GREATEST(0, EXTRACT(EPOCH FROM ((range->>'end')::time - (range->>'start')::time))::int / 60 - COALESCE(NULLIF(range->>'pause', '')::int, 0)))::int AS minutes
    FROM public.service_reports r
    CROSS JOIN LATERAL jsonb_array_elements(r.time_ranges) AS range
    WHERE r.job_id = p_job_id
      AND r.status = 'abgeschlossen'
      AND COALESCE(range->>'technician_id', '') <> ''
      AND COALESCE(range->>'start', '') <> ''
      AND COALESCE(range->>'end', '') <> ''
      AND COALESCE((range->>'not_billable')::boolean, false) = false
    GROUP BY (range->>'technician_id')::uuid
  ),
  -- Nicht-verrechnete Rapport-Stunden (not_billable = true).
  not_billable AS (
    SELECT (range->>'technician_id')::uuid AS user_id,
      SUM(GREATEST(0, EXTRACT(EPOCH FROM ((range->>'end')::time - (range->>'start')::time))::int / 60 - COALESCE(NULLIF(range->>'pause', '')::int, 0)))::int AS minutes
    FROM public.service_reports r
    CROSS JOIN LATERAL jsonb_array_elements(r.time_ranges) AS range
    WHERE r.job_id = p_job_id
      AND r.status = 'abgeschlossen'
      AND COALESCE(range->>'technician_id', '') <> ''
      AND COALESCE(range->>'start', '') <> ''
      AND COALESCE(range->>'end', '') <> ''
      AND COALESCE((range->>'not_billable')::boolean, false) = true
    GROUP BY (range->>'technician_id')::uuid
  ),
  all_users AS (
    SELECT s.user_id FROM stempel s
    UNION SELECT r.user_id FROM rapport r
    UNION SELECT n.user_id FROM not_billable n
  )
  SELECT u.user_id, COALESCE(p.full_name, '—') AS user_name,
    COALESCE(s.minutes, 0) AS stempel_minutes,
    COALESCE(r.minutes, 0) AS rapport_minutes,
    COALESCE(n.minutes, 0) AS not_billable_minutes,
    COALESCE(r.minutes, 0) - COALESCE(s.minutes, 0) AS diff_minutes
  FROM all_users u
  LEFT JOIN public.profiles p ON p.id = u.user_id
  LEFT JOIN stempel s ON s.user_id = u.user_id
  LEFT JOIN rapport r ON r.user_id = u.user_id
  LEFT JOIN not_billable n ON n.user_id = u.user_id
  ORDER BY COALESCE(p.full_name, '—');
END;
$function$;
