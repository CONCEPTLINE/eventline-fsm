-- Partner-Locationspartner sollen auch NACH Annahme der Anfrage (Status
-- offen) noch zwei Dinge tun koennen:
--   1) Notizen aendern (z.B. neue Info fuer EVENTLINE nachreichen)
--   2) Dokumente hochladen (Dossier, Vertragsfile, geaenderter Ablauf)
--
-- Vorher: jobs_update_partner + documents_insert_partner haben nur in
-- status='partner_anfrage' erlaubt. Sobald EVENTLINE accept-druckt, war
-- die Anfrage komplett read-only fuer den Partner.
--
-- Aenderungen:
-- ----------------------------------------------------------------------
-- A) documents_insert_partner: zusaetzlich status='offen' erlauben.
--    documents_delete_partner BLEIBT auf partner_anfrage beschraenkt —
--    Partner soll nach Annahme keine Files mehr loeschen koennen (Eventline
--    plant ggf. schon mit dem Dokument).
--
-- B) Statt jobs_update_partner zu lockern (zu breit — Partner koennte sonst
--    titel/status/dates aendern), legen wir eine SECURITY DEFINER-RPC
--    `partner_update_notes(p_job_id, p_notes)` an. Diese updated NUR die
--    notes-Spalte und prueft selbst dass:
--      - Caller hat role='partner'
--      - Job gehoert ihm (created_by oder partner_location_id matched)
--      - Job-Status ist 'partner_anfrage' ODER 'offen'
--    Der Frontend-Code ruft fuer Notes-Autosave kuenftig diese RPC, nicht
--    mehr `from("jobs").update(...)`.
--
-- Migration ist idempotent (CREATE OR REPLACE + DROP IF EXISTS + neue
-- CREATE POLICY).

-- ===== A) Documents-Insert auch in 'offen' erlauben =====
DROP POLICY IF EXISTS "documents_insert_partner" ON public.documents;
CREATE POLICY "documents_insert_partner" ON public.documents
  FOR INSERT TO authenticated
  WITH CHECK (
    is_admin_or_lead()
    OR (
      uploaded_by = auth.uid()
      AND EXISTS (
        SELECT 1
        FROM public.jobs j
        JOIN public.profiles p ON p.id = auth.uid()
        WHERE j.id = documents.job_id
          AND j.status IN ('partner_anfrage', 'offen')
          AND p.role = 'partner'
      )
    )
  );

-- Documents-Select: Partner soll alle Dokumente seines eigenen Jobs sehen,
-- nicht nur die selbst hochgeladenen. EVENTLINE-Admin haengt z.B. Vertrag
-- oder bestaetigte Konditionen an — die Partner sollte einsehen koennen.
DROP POLICY IF EXISTS "documents_select_partner" ON public.documents;
CREATE POLICY "documents_select_partner" ON public.documents
  FOR SELECT TO authenticated
  USING (
    -- Bestehende Regeln laufen weiter; diese Policy ist ADDITIV via OR.
    EXISTS (
      SELECT 1
      FROM public.jobs j
      JOIN public.profiles p ON p.id = auth.uid()
      WHERE j.id = documents.job_id
        AND p.role = 'partner'
        AND p.partner_location_id IS NOT NULL
        AND (j.created_by = auth.uid() OR j.location_id = p.partner_location_id)
    )
  );

-- ===== B) SECURITY DEFINER RPC: partner_update_notes =====
-- Wir lockern die jobs UPDATE-RLS NICHT (sonst koennte Partner z.B. status
-- selbst umstellen — "self-accept" der eigenen Anfrage). Stattdessen
-- spezifische RPC die nur das Notes-Feld aendert.
CREATE OR REPLACE FUNCTION public.partner_update_notes(
  p_job_id uuid,
  p_notes text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role text;
  v_caller_loc uuid;
  v_job_status text;
  v_job_creator uuid;
  v_job_location uuid;
BEGIN
  SELECT role, partner_location_id INTO v_caller_role, v_caller_loc
  FROM public.profiles WHERE id = auth.uid();

  IF v_caller_role IS DISTINCT FROM 'partner' THEN
    RAISE EXCEPTION 'forbidden: only partner role can call partner_update_notes';
  END IF;

  SELECT status, created_by, location_id
  INTO v_job_status, v_job_creator, v_job_location
  FROM public.jobs WHERE id = p_job_id;

  IF v_job_status IS NULL THEN
    RAISE EXCEPTION 'job not found';
  END IF;

  -- Caller muss Ersteller ODER an der Job-Location als Partner gemounted sein.
  IF v_job_creator <> auth.uid()
     AND (v_caller_loc IS NULL OR v_caller_loc <> v_job_location) THEN
    RAISE EXCEPTION 'forbidden: not your job';
  END IF;

  IF v_job_status NOT IN ('partner_anfrage', 'offen') THEN
    RAISE EXCEPTION 'job not editable in status %', v_job_status;
  END IF;

  UPDATE public.jobs
  SET notes = NULLIF(trim(p_notes), '')
  WHERE id = p_job_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.partner_update_notes(uuid, text) TO authenticated;
