-- partner_submit_anfrage schema-aware machen.
--
-- Vorher: hardcoded "mindestens ein Termin" Check, egal ob der Builder
-- 'Termin Pflicht' deaktiviert hat.
--
-- Jetzt: RPC liest die aktive Form-Schema-Konfiguration und
-- respektiert appointment_required. Schema-Source-Reihenfolge:
--   1. jobs.form_schema_snapshot wenn vorhanden (= Submit-Time-Snapshot,
--      stabil falls der Admin spaeter den Builder aendert)
--   2. partner_form_template.live_schema fuer die Job-Location (location-scope)
--   3. partner_form_template.live_schema (global-scope)
--   4. Fallback: appointment_required = true (= altes Verhalten)
--
-- Wir lesen NUR appointment_required hier weil die anderen Submit-Regeln
-- (title_required, start_date_required, contact_required) im Client schon
-- evaluiert werden. title/start_date sind NOT NULL in jobs sowieso, also
-- gibt's keinen Submit der mit leerem Wert hier ankommt — die RPC wuerde
-- erst nach erfolgreichem Job-INSERT aufgerufen.

create or replace function public.partner_submit_anfrage(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller_role text;
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
  select role, partner_location_id, full_name
  into v_caller_role, v_caller_loc, v_caller_name
  from public.profiles where id = auth.uid();

  if v_caller_role is distinct from 'partner' then
    raise exception 'forbidden: only partner role can submit anfragen';
  end if;

  select status, created_by, location_id, title, form_schema_snapshot
  into v_job_status, v_job_creator, v_job_location, v_job_title, v_job_snapshot
  from public.jobs where id = p_job_id;

  if v_job_status is null then
    raise exception 'job not found';
  end if;

  if v_job_creator <> auth.uid()
     and (v_caller_loc is null or v_caller_loc <> v_job_location) then
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
    select id from public.profiles where role = 'admin' and is_active = true
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
$function$;
