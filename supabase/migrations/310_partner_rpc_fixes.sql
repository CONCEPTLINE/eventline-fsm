-- 310_partner_rpc_fixes.sql — Partner-RPCs: Zurueckziehen + Besitzpruefung
--
-- Datum: 2026-10-12. Nacharbeit zu 309 (gehaertete partner_withdraw_anfrage).
-- Die Schlusspruefung von 309 fand zwei AELTERE Fehler:
--
-- (1) Abgeschickte Anfrage laesst sich nicht zurueckziehen.
--     Eine Anfrage im Status partner_anfrage hat immer >= 1 Termin
--     (partner_submit_anfrage verlangt ihn). partner_withdraw_anfrage loescht
--     die Termine, dabei feuert protect_last_termin_trg (BEFORE DELETE je
--     Zeile, Migration 104) und bricht beim letzten Termin ab: «Mindestens ein
--     Termin muss in dieser Phase bleiben». Ergebnis: Zurueckziehen klappt nur
--     fuer Entwuerfe, bei jeder abgeschickten Anfrage kommt die Fehlermeldung.
--     Fix: Der Schutz gilt fuer das Loeschen EINZELNER Termine, nicht fuer das
--     Zurueckziehen des ganzen Auftrags. partner_withdraw_anfrage rahmt das
--     Loeschen der Termine mit dem transaktions-lokalen Schalter
--     app.partner_withdraw_ok = 'on' … 'off' ein (gleiches Muster wie
--     app.partner_status_change_ok in partner_submit_anfrage), der Trigger
--     laesst nur dann durch. Ein Partner kann den Schalter selbst nicht setzen:
--     PostgREST fuehrt je Anfrage genau eine Anweisung in eigener Transaktion
--     aus, set_config ist nicht als RPC freigegeben (Schema pg_catalog), und
--     der Schalter wird direkt danach wieder auf 'off' gestellt.
--     Direktes Loeschen des letzten Termins durch den Partner bleibt gesperrt.
--
-- (2) NULL-Luecke + inaktive Partner in partner_update_notes und
--     partner_submit_anfrage (gleiches Muster wie vor 309 in withdraw):
--       if v_job_creator <> auth.uid()
--          and (v_caller_loc is null or v_caller_loc <> v_job_location) …
--     Ist v_job_location NULL, wird «v_caller_loc <> NULL» zu NULL, die ganze
--     Bedingung NULL -> kein Abbruch. Folge: jeder Partner mit Standort konnte
--     die Notizen JEDES fremden Auftrags ohne Standort (Status offen /
--     partner_entwurf / partner_anfrage) ueberschreiben (geprueft 2026-10-12:
--     8 solche offenen Auftraege). Gleiches bei created_by = NULL. Ausserdem
--     prueften beide nur role = 'partner', nicht is_active -> deaktivierte
--     Partner-Konten mit noch gueltiger Sitzung kamen durch.
--     Fix wie 309: is_partner() (prueft role UND is_active) und Besitz-
--     pruefung NULL-fest mit coalesce(…, false): nur Ersteller ODER gleicher
--     Standort (beide Seiten gesetzt).
--
-- Unveraendert: Status-Uebergaenge, erlaubte Status, Termin-Pflicht-Logik,
-- Admin-Benachrichtigung, Rueckgabewerte und ALLE Fehlermeldungen (die Route
-- /api/partner/anfragen/[id]/zurueckziehen und TOAST bilden sie ab).
-- Rechte: create or replace behaelt die bestehenden EXECUTE-Rechte (wie
-- vorher: Standard-Grant; die Funktionen pruefen selbst, anon scheitert an
-- is_partner()). Keine grant/revoke-Aenderung.
--
-- Idempotent: nur create or replace function.
-- NUR ALS DATEI — Einspielen: node scripts/apply-migration.mjs supabase/migrations/310_partner_rpc_fixes.sql
-- Ruecksetzen: die letzten Definitionen aus 104 (Trigger-Funktion), 102
-- (partner_update_notes), 254 (partner_submit_anfrage) und 309 (withdraw)
-- erneut einspielen — dann sind Fehler (1) und (2) wieder da.

-- 1a) Letzter-Termin-Schutz: Zurueckziehen des ganzen Auftrags durchlassen ---
create or replace function public.protect_last_termin_for_partner_anfrage()
returns trigger
language plpgsql security definer set search_path = public as $$
DECLARE
  v_remaining int;
  v_status text;
  v_caller_role text;
BEGIN
  -- partner_withdraw_anfrage entfernt den ganzen Auftrag (Termine inklusive);
  -- der Schalter ist nur innerhalb dieser Funktion 'on'.
  IF current_setting('app.partner_withdraw_ok', true) = 'on' THEN
    RETURN OLD;
  END IF;

  SELECT role INTO v_caller_role FROM public.profiles WHERE id = auth.uid();
  IF v_caller_role IS DISTINCT FROM 'partner' THEN
    RETURN OLD; -- Admin/Lead/Team duerfen
  END IF;

  SELECT status INTO v_status FROM public.jobs WHERE id = OLD.job_id;
  IF v_status <> 'partner_anfrage' THEN
    RETURN OLD; -- Nur in partner_anfrage geschuetzt
  END IF;

  -- Wieviele Termine bleiben NACH dem Delete uebrig?
  SELECT count(*) INTO v_remaining
  FROM public.job_appointments
  WHERE job_id = OLD.job_id AND id <> OLD.id;

  IF v_remaining = 0 THEN
    RAISE EXCEPTION 'Mindestens ein Termin muss in dieser Phase bleiben. Zuerst neuen Termin anlegen, dann den alten loeschen.';
  END IF;

  RETURN OLD;
END;
$$;
-- Trigger protect_last_termin_trg (BEFORE DELETE ON job_appointments FOR EACH
-- ROW) bleibt unveraendert und zeigt weiter auf diese Funktion.

-- 1b) partner_withdraw_anfrage (Stand 309) + Schalter um das Termin-Loeschen --
create or replace function public.partner_withdraw_anfrage(p_job_id uuid)
returns table(storage_paths text[])
language plpgsql security definer set search_path = public as $$
declare
  v_caller_loc uuid;
  v_job_status text;
  v_job_creator uuid;
  v_job_location uuid;
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
  select status, created_by, location_id
  into v_job_status, v_job_creator, v_job_location
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
$$;

-- 2a) partner_update_notes: aktiver Partner + NULL-feste Besitzpruefung ------
create or replace function public.partner_update_notes(p_job_id uuid, p_notes text)
returns void
language plpgsql security definer set search_path = public as $$
DECLARE
  v_caller_loc uuid;
  v_job_status text;
  v_job_creator uuid;
  v_job_location uuid;
BEGIN
  -- Aktiver Partner (is_partner prueft role UND is_active)
  IF NOT public.is_partner() THEN
    RAISE EXCEPTION 'forbidden: only partner role can call partner_update_notes';
  END IF;

  SELECT partner_location_id INTO v_caller_loc
  FROM public.profiles WHERE id = auth.uid();

  SELECT status, created_by, location_id
  INTO v_job_status, v_job_creator, v_job_location
  FROM public.jobs WHERE id = p_job_id;

  IF v_job_status IS NULL THEN
    RAISE EXCEPTION 'job not found';
  END IF;

  -- NULL-fest: nur Ersteller ODER gleicher Standort (beide Seiten gesetzt)
  IF NOT (coalesce(v_job_creator = auth.uid(), false)
          OR coalesce(v_caller_loc = v_job_location, false)) THEN
    RAISE EXCEPTION 'forbidden: not your job';
  END IF;

  IF v_job_status NOT IN ('partner_anfrage', 'partner_entwurf', 'offen') THEN
    RAISE EXCEPTION 'job not editable in status %', v_job_status;
  END IF;

  UPDATE public.jobs
  SET notes = NULLIF(trim(p_notes), '')
  WHERE id = p_job_id;
END;
$$;

-- 2b) partner_submit_anfrage: aktiver Partner + NULL-feste Besitzpruefung ----
create or replace function public.partner_submit_anfrage(p_job_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_caller_loc uuid;
  v_caller_name text;
  v_job_status text;
  v_job_creator uuid;
  v_job_location uuid;
  v_job_title text;
  v_job_snapshot jsonb;
  v_template_schema jsonb;
  v_appointment_required boolean;
  v_termin_count int;
  v_admin_id uuid;
begin
  -- Aktiver Partner (is_partner prueft role UND is_active)
  if not public.is_partner() then
    raise exception 'forbidden: only partner role can submit anfragen';
  end if;

  select partner_location_id, full_name
  into v_caller_loc, v_caller_name
  from public.profiles where id = auth.uid();

  select status, created_by, location_id, title, form_schema_snapshot
  into v_job_status, v_job_creator, v_job_location, v_job_title, v_job_snapshot
  from public.jobs where id = p_job_id;

  if v_job_status is null then
    raise exception 'job not found';
  end if;

  -- NULL-fest: nur Ersteller ODER gleicher Standort (beide Seiten gesetzt)
  if not (coalesce(v_job_creator = auth.uid(), false)
          or coalesce(v_caller_loc = v_job_location, false)) then
    raise exception 'forbidden: not your job';
  end if;

  if v_job_status <> 'partner_entwurf' then
    raise exception 'can only submit from partner_entwurf state, current: %', v_job_status;
  end if;

  -- Schema-Aware-Termin-Pflicht. Reihenfolge: snapshot -> location-template
  -- -> global-template -> default (true).
  v_appointment_required := null;

  if v_job_snapshot is not null then
    v_appointment_required := (v_job_snapshot -> 'submit' ->> 'appointment_required')::boolean;
  end if;

  if v_appointment_required is null and v_job_location is not null then
    select (live_schema -> 'submit' ->> 'appointment_required')::boolean
    into v_appointment_required
    from public.partner_form_template
    where scope = 'location' and location_id = v_job_location
    limit 1;
  end if;

  if v_appointment_required is null then
    select (live_schema -> 'submit' ->> 'appointment_required')::boolean
    into v_appointment_required
    from public.partner_form_template
    where scope = 'global'
    limit 1;
  end if;

  -- Default: Termin Pflicht (= altes Verhalten).
  if v_appointment_required is null then
    v_appointment_required := true;
  end if;

  if v_appointment_required then
    select count(*) into v_termin_count from public.job_appointments where job_id = p_job_id;
    if v_termin_count = 0 then
      raise exception 'mindestens ein Termin erforderlich vor dem Absenden';
    end if;
  end if;

  -- Status-Guard temporaer umgehen
  perform set_config('app.partner_status_change_ok', 'on', true);

  update public.jobs
  set status = 'partner_anfrage',
      submitted_at = now(),
      submitted_by = auth.uid()
  where id = p_job_id;

  perform set_config('app.partner_status_change_ok', 'off', true);

  -- In-App-Notification an alle aktiven Admins (keine Mail per Leos Wunsch).
  for v_admin_id in
    select p.id from public.profiles p join public.roles r on r.slug = p.role where p.is_active = true and (r.slug = 'admin' or r.permissions ? 'auftraege:see-all')
  loop
    insert into public.notifications (user_id, title, message, link)
    values (
      v_admin_id,
      'Neue Partner-Anfrage: ' || coalesce(v_job_title, 'Anfrage'),
      coalesce(v_caller_name, 'Partner') || ' hat eine Anfrage abgeschickt.',
      '/auftraege/' || p_job_id::text
    );
  end loop;
end;
$$;
