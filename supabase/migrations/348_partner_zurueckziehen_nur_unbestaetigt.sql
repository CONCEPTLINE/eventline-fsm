-- 348 — Partnerportal: «Zurückziehen» nur, solange die Anfrage NICHT
-- bestätigt ist (Leo 2026-10-16).
--
-- Bisher konnte ein Partner eine bereits bestätigte Anfrage im Änderungsmodus
-- («Änderungen vornehmen» setzt den Status zurück auf partner_anfrage)
-- zurückziehen — partner_withdraw_anfrage löschte dann den ganzen Auftrag
-- samt EVENTLINE-Terminen, Zuteilungen und Dokument-Zeilen.
--
-- Neu: bestätigt = von EVENTLINE angenommen (accepted_at gesetzt) oder im
-- Änderungsmodus (partner_aenderung gesetzt). Solche Anfragen werden nie
-- gelöscht — die Funktion bricht vor jedem Löschen ab ('cannot withdraw
-- confirmed job', die Server-Route antwortet 409). Die Prüfung läuft unter
-- derselben Zeilensperre wie die Status-Prüfung (gleichzeitige Annahme durch
-- EVENTLINE). «Änderungen vornehmen» bleibt unverändert.
--
-- Aufruf weiterhin nur über den Server-Wrapper partnerportal_zurueckziehen
-- (Migration 345); create or replace behält die Rechte (nur service_role,
-- Migration 346). Idempotent.

create or replace function public.partner_withdraw_anfrage(p_job_id uuid)
returns table(storage_paths text[])
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller_loc uuid;
  v_job_status text;
  v_job_creator uuid;
  v_job_location uuid;
  v_accepted_at timestamptz;
  v_aenderung jsonb;
  v_paths text[];
begin
  -- Aktiver Partner (is_partner prueft is_active) mit Loesch-Recht
  if not public.is_partner() then
    raise exception 'forbidden: only partner role can withdraw anfragen';
  end if;
  if not public.has_permission('partner:anfragen:delete') then
    raise exception 'forbidden: missing permission partner:anfragen:delete';
  end if;

  select partner_location_id into v_caller_loc
  from public.profiles where id = auth.uid();

  -- Sperre gegen gleichzeitige Annahme durch EVENTLINE
  select status, created_by, location_id, accepted_at, partner_aenderung
  into v_job_status, v_job_creator, v_job_location, v_accepted_at, v_aenderung
  from public.jobs where id = p_job_id
  for update;

  if not found then
    raise exception 'job not found';
  end if;

  -- NULL-fest: nur Ersteller ODER gleicher Standort (beide Seiten gesetzt)
  if not (coalesce(v_job_creator = auth.uid(), false)
          or coalesce(v_caller_loc = v_job_location, false)) then
    raise exception 'forbidden: not your job';
  end if;

  -- Nur in den Pre-Accept-Status zurueckziehbar
  if v_job_status not in ('partner_entwurf', 'partner_anfrage') then
    raise exception 'cannot withdraw job in status %', v_job_status;
  end if;

  -- Bestaetigt (angenommen oder im Aenderungsmodus): nie loeschen (Leo 2026-10-16)
  if v_accepted_at is not null or v_aenderung is not null then
    raise exception 'cannot withdraw confirmed job';
  end if;

  -- Storage-Paths fuer das Aufraeumen (Server-Route) zurueckgeben
  select array_agg(storage_path) into v_paths
  from public.documents where job_id = p_job_id;

  -- Cascade: documents, appointments, dann job. Status-Guard greift nicht
  -- bei DELETE (BEFORE UPDATE only).
  delete from public.documents where job_id = p_job_id;
  -- Letzter-Termin-Schutz gilt fuer einzelne Termine, nicht fuers
  -- Zurueckziehen des ganzen Auftrags (Schalter transaktions-lokal).
  perform set_config('app.partner_withdraw_ok', 'on', true);
  delete from public.job_appointments where job_id = p_job_id;
  perform set_config('app.partner_withdraw_ok', 'off', true);
  delete from public.jobs where id = p_job_id;

  return query select coalesce(v_paths, array[]::text[]);
end;
$function$;

-- Rechte wie nach Migration 346: nur der Server (ueber den Wrapper).
revoke execute on function public.partner_withdraw_anfrage(uuid) from public, anon, authenticated;
