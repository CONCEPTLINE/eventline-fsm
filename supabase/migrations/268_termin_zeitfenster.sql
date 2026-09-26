-- Partnerwunsch Barakuba (Basil, Mail 26.09.2026): drei Zeitfenster-Arten
-- pro Termin + Partner kann bestehende Termine BEARBEITEN (bisher gab es
-- im Portal nur Hinzufuegen/Loeschen und keine UPDATE-Policy).
--
-- zeit_modus:
--   fix          = muss zwingend zu den angegebenen Zeiten stattfinden (Default,
--                  entspricht dem bisherigen Verhalten aller Termine)
--   verschiebbar = festgelegtes Fenster, darf nach Absprache mit den
--                  Mieter:innen geschoben werden; der Partner wird ueber jede
--                  Verschiebung informiert (keine Doppelbuchungen)
--   deadline     = nur "fertig bis"-Zeitpunkt: start_time = Deadline,
--                  end_time = null; EVENTLINE plant frei davor und traegt die
--                  Verantwortung, dass es bis dahin erledigt ist

alter table public.job_appointments
  add column if not exists zeit_modus text not null default 'fix';

do $$ begin
  alter table public.job_appointments
    add constraint job_appointments_zeit_modus_check
    check (zeit_modus in ('fix', 'verschiebbar', 'deadline'));
exception when duplicate_object then null; end $$;

-- Termin-Bearbeitung fuer Partner als SECURITY-DEFINER-RPC statt einer
-- UPDATE-Policy: so sind NUR die erlaubten Spalten aenderbar (nie
-- assigned_to / customer_* / meeting_link), gleiche Status- und
-- Location-Gates wie die insert/delete-Partner-Policies (257).
create or replace function public.partner_update_termin(
  p_termin_id uuid,
  p_title text,
  p_start timestamptz,
  p_end timestamptz,
  p_description text,
  p_zeit_modus text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
begin
  if not public.is_partner() then
    raise exception 'Keine Berechtigung';
  end if;
  if not public.has_permission('partner:anfragen:edit') then
    raise exception 'Keine Berechtigung';
  end if;
  if p_zeit_modus is null or p_zeit_modus not in ('fix', 'verschiebbar', 'deadline') then
    raise exception 'Ungültiger Zeitfenster-Modus';
  end if;
  if p_title is null or btrim(p_title) = '' then
    raise exception 'Titel fehlt';
  end if;
  if p_start is null then
    raise exception 'Startzeit fehlt';
  end if;

  select ja.job_id into v_job_id
  from public.job_appointments ja
  join public.jobs j on j.id = ja.job_id
  join public.profiles p on p.id = (select auth.uid())
  where ja.id = p_termin_id
    and j.status in ('partner_entwurf', 'partner_anfrage')
    and p.partner_location_id is not null
    and p.partner_location_id = j.location_id;

  if v_job_id is null then
    raise exception 'Termin nicht bearbeitbar';
  end if;

  update public.job_appointments set
    title = btrim(p_title),
    start_time = p_start,
    end_time = case when p_zeit_modus = 'deadline' then null else p_end end,
    description = nullif(btrim(coalesce(p_description, '')), ''),
    zeit_modus = p_zeit_modus
  where id = p_termin_id;
end;
$$;

revoke all on function public.partner_update_termin(uuid, text, timestamptz, timestamptz, text, text) from public;
grant execute on function public.partner_update_termin(uuid, text, timestamptz, timestamptz, text, text) to authenticated;
