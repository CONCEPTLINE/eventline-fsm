-- 315: Partner darf den TITEL seiner Anfrage aendern (Partnerwunsch 2026-10-13).
--
-- Regel (im Chat bestaetigt 2026-10-13):
--   - Noch nicht bestaetigt (partner_entwurf / partner_anfrage): der Partner
--     aendert den Titel direkt. Das gilt auch im Aenderungsmodus einer zuvor
--     bestaetigten Anfrage («Aenderungen vornehmen»: Status wieder
--     partner_anfrage, Snapshot in jobs.partner_aenderung) — dort zeigt der
--     interne Banner den Titel alt -> neu, EVENTLINE bestaetigt neu.
--   - Bestaetigt (offen): NICHT direkt. Erst «Aenderungen vornehmen», damit
--     nie ein bestaetigter Auftrag still umbenannt wird.
--   - Abgeschlossen / storniert / interne Status: nie.
--
-- 1) RPC partner_update_title(p_job_id, p_title) — SECURITY DEFINER nach dem
--    Muster von partner_update_termin (268) / partner_update_notes (310):
--    aktiver Partner (is_partner prueft role UND is_active), Recht
--    partner:anfragen:edit (gleich wie die jobs-UPDATE-Policy 257), nur
--    Auftraege des EIGENEN Standorts (NULL-fest, gleiche Bedingung wie
--    jobs_select / jobs_update_partner), nur Status partner_entwurf /
--    partner_anfrage, nur die Spalte title. Titel: Leerraum zusammengefasst,
--    getrimmt, nicht leer, max. 200 Zeichen. Zeile wird mit FOR UPDATE
--    gesperrt, damit eine gleichzeitige Annahme durch EVENTLINE nicht
--    zwischen Pruefung und Schreiben rutscht.
--
-- 2) Trigger partner_title_guard_trg — Rueckfallnetz fuer den direkten Weg:
--    jobs_update_partner (257) erlaubt dem Partner in partner_entwurf /
--    partner_anfrage seit jeher ein direktes UPDATE der Zeile. Damit die
--    Titel-Pruefung auch dort gilt, normalisiert/prueft der Trigger einen
--    vom Partner geaenderten Titel genauso. Fuer EVENTLINE-Konten aendert
--    sich nichts (Trigger kehrt sofort zurueck).
--
-- Idempotent: create or replace / drop trigger if exists. Nur additiv,
-- keine Daten. Einspielen:
--   node scripts/apply-migration.mjs supabase/migrations/315_partner_titel.sql
-- Ruecksetzen:
--   drop trigger if exists partner_title_guard_trg on public.jobs;
--   drop function if exists public.partner_title_guard();
--   drop function if exists public.partner_update_title(uuid, text);

-- 1) RPC ------------------------------------------------------------------
create or replace function public.partner_update_title(p_job_id uuid, p_title text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_loc uuid;
  v_job_status text;
  v_job_location uuid;
  v_title text;
begin
  if not public.is_partner() then
    raise exception 'Keine Berechtigung';
  end if;
  if not public.has_permission('partner:anfragen:edit') then
    raise exception 'Keine Berechtigung';
  end if;

  -- Zeilenumbrueche/Tabs/Mehrfach-Leerzeichen -> ein Leerzeichen, getrimmt
  v_title := btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g'));
  if v_title = '' then
    raise exception 'Titel fehlt';
  end if;
  if char_length(v_title) > 200 then
    raise exception 'Titel ist zu lang (höchstens 200 Zeichen)';
  end if;

  select partner_location_id into v_caller_loc
  from public.profiles where id = auth.uid();

  select status, location_id into v_job_status, v_job_location
  from public.jobs where id = p_job_id
  for update;

  -- Fremde Auftraege wie nicht vorhandene behandeln (keine Existenz-Auskunft)
  if not found or not coalesce(v_caller_loc = v_job_location, false) then
    raise exception 'Anfrage nicht gefunden';
  end if;

  if v_job_status = 'offen' then
    raise exception 'Die Anfrage ist bereits bestätigt — den Titel bitte über «Änderungen vornehmen» anpassen';
  end if;
  if v_job_status not in ('partner_entwurf', 'partner_anfrage') then
    raise exception 'Der Titel kann in diesem Status nicht mehr geändert werden';
  end if;

  update public.jobs set title = v_title where id = p_job_id;
  return v_title;
end;
$$;

-- Supabase vergibt neuen Funktionen per Default-Privileg auch anon das
-- EXECUTE — darum anon ausdruecklich entziehen, nicht nur public.
revoke all on function public.partner_update_title(uuid, text) from public;
revoke all on function public.partner_update_title(uuid, text) from anon;
grant execute on function public.partner_update_title(uuid, text) to authenticated;

-- 2) Trigger: Titel-Pruefung auch beim direkten Partner-UPDATE -------------
create or replace function public.partner_title_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  if new.title is not distinct from old.title then
    return new;
  end if;

  select role into v_role from public.profiles where id = auth.uid();
  if v_role is distinct from 'partner' then
    return new; -- EVENTLINE-Konten / Server (service_role): unveraendert
  end if;

  new.title := btrim(regexp_replace(coalesce(new.title, ''), '\s+', ' ', 'g'));
  if new.title = '' then
    raise exception 'Titel fehlt';
  end if;
  if char_length(new.title) > 200 then
    raise exception 'Titel ist zu lang (höchstens 200 Zeichen)';
  end if;
  return new;
end;
$$;

drop trigger if exists partner_title_guard_trg on public.jobs;
create trigger partner_title_guard_trg
  before update of title on public.jobs
  for each row
  execute function public.partner_title_guard();
