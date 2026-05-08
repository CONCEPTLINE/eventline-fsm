-- Migration 090 hatte nur is_admin() ausgenommen — jetzt sollen auch
-- team-leiter alle Auftraege/Termine/Zuweisungen sehen koennen. Sonst:
-- Techniker werden weiterhin gefiltert.
--
-- Helper-Function 'is_admin_or_lead()' kapselt den Permission-Check; die
-- bestehende user_can_see_job() ruft sie auf statt nur is_admin().

CREATE OR REPLACE FUNCTION public.is_admin_or_lead()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $func$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND role IN ('admin', 'team-leiter')
  );
$func$;
GRANT EXECUTE ON FUNCTION public.is_admin_or_lead() TO authenticated;

-- user_can_see_job nutzt jetzt is_admin_or_lead statt is_admin.
CREATE OR REPLACE FUNCTION public.user_can_see_job(job_uuid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $func$
  SELECT
    public.is_admin_or_lead()
    OR EXISTS (SELECT 1 FROM public.jobs              WHERE id = job_uuid AND project_lead_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.job_assignments   WHERE job_id = job_uuid AND profile_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.job_appointments  WHERE job_id = job_uuid AND assigned_to = auth.uid());
$func$;

-- jobs-Policy aktualisieren: is_admin_or_lead statt is_admin.
DROP POLICY IF EXISTS "jobs_select" ON public.jobs;
CREATE POLICY "jobs_select" ON public.jobs
  FOR SELECT TO authenticated
  USING (
    public.is_admin_or_lead()
    OR project_lead_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.job_assignments  WHERE job_id = jobs.id AND profile_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.job_appointments WHERE job_id = jobs.id AND assigned_to = auth.uid())
  );

-- job_appointments-Policy
DROP POLICY IF EXISTS "appointments_select" ON public.job_appointments;
CREATE POLICY "appointments_select" ON public.job_appointments
  FOR SELECT TO authenticated
  USING (
    public.is_admin_or_lead()
    OR assigned_to = auth.uid()
    OR (job_id IS NOT NULL AND public.user_can_see_job(job_id))
  );

-- job_assignments-Policy
DROP POLICY IF EXISTS "assignments_select" ON public.job_assignments;
CREATE POLICY "assignments_select" ON public.job_assignments
  FOR SELECT TO authenticated
  USING (
    public.is_admin_or_lead()
    OR profile_id = auth.uid()
    OR public.user_can_see_job(job_id)
  );
