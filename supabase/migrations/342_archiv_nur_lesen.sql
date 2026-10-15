-- 342 — Archiv = nur lesen (Leo 2026-10-15: «alle sachen in archiven sollten
-- nicht mehr bearbeitbar sein, also z.b. aufträge»).
--
-- DB-Schutz fuer direkte Client-Writes (Browser UND Handy) auf archivierte
-- Datensaetze und ihre wichtigsten Kind-Tabellen. Gegenstueck im Code:
-- src/lib/archiv.ts (gleiche Archiv-Definitionen und Meldungen).
--
-- Archiv je Bereich:
--   Auftraege  jobs.status in (abgeschlossen, storniert)
--   Kunden     customers.archived_at gesetzt
--   Locations  locations.archived_at gesetzt
--   Projekte   projects.status in (abgeschlossen, abgelehnt, storniert)
--   Entwuerfe  job_drafts.status in (storniert, umgewandelt)
--
-- WER gesperrt wird: nur Endnutzer — Anweisungen, die ueber PostgREST mit der
-- Rolle authenticated (oder anon) laufen; current_user ist dort genau diese
-- Rolle (Muster: fixiere_rapport_ersteller_auftrag, Migration 306). Weiter
-- laufen, bewusst:
--   * service_role — Admin-Client der API-Routen (Rechnung/Bexio-Nachlauf,
--     Rapport-PDF + Auto-Stempel, Mail-Eingang, Crons). Die Routen, die
--     Inhalte aendern wuerden, lehnen archivierte Datensaetze selbst mit 409 ab.
--   * postgres — Migrationen, pg_cron und FK-Kaskaden (ON DELETE SET NULL /
--     CASCADE laufen als Tabellen-Eigentuemer, z.B. beim Loeschen eines
--     Benutzers).
--   * SECURITY-DEFINER-Funktionen (laufen als Eigentuemer). Die bestehenden,
--     die diese Tabellen schreiben, pruefen ihren Status selbst
--     (partner_update_*, cancel_project) oder sind System-Nachlaeufe
--     (preserve_user_name_history).
--
-- RUECKWEGE (bleiben fuer Berechtigte, Admins via has_permission):
--   Auftraege  Status aus dem Archiv heraus («Wieder oeffnen», auftraege:edit)
--   Kunden     archived_at -> null («Reaktivieren», kunden:archive)
--   Locations  archived_at -> null («Reaktivieren», locations:archive/edit)
--   Entwuerfe  storniert -> aktiv/wartet_auf_kunde («Wieder aktivieren»,
--              auftraege:edit); umgewandelt bleibt endgueltig
--   Projekte   keiner (Folgeprojekt)
-- Weiterhin erlaubt am archivierten Auftrag: Rechnungs-Felder (invoiced_*,
-- invoice_skipped_*) und is_deleted (Soft-Delete durch Berechtigte).
--
-- FEHLER: SQLSTATE PT409 — PostgREST antwortet damit HTTP 409, die Meldung
-- erscheint unveraendert als Toast.
-- Trigger-Funktionen sind SECURITY INVOKER (current_user = Aufrufer); den
-- Archiv-Status des Elternteils liest archiv_gesperrt() als SECURITY DEFINER,
-- damit die Pruefung nicht an der RLS des Aufrufers haengt.
-- Idempotent: create or replace / drop trigger if exists.

-- ─── Helfer: liegt der Eltern-Datensatz im Archiv? ─────────────────────────
create or replace function public.archiv_gesperrt(p_art text, p_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_id is null then
    return false;
  end if;
  case p_art
    when 'auftrag' then
      return exists (select 1 from public.jobs j
                     where j.id = p_id and j.status in ('abgeschlossen', 'storniert'));
    when 'rapport' then
      return exists (select 1 from public.service_reports r
                     join public.jobs j on j.id = r.job_id
                     where r.id = p_id and j.status in ('abgeschlossen', 'storniert'));
    when 'standort' then
      return exists (select 1 from public.locations l
                     where l.id = p_id and l.archived_at is not null);
    when 'tarif' then
      return exists (select 1 from public.location_rate_tiers t
                     join public.locations l on l.id = t.location_id
                     where t.id = p_id and l.archived_at is not null);
    when 'projekt' then
      return exists (select 1 from public.projects p
                     where p.id = p_id and p.status in ('abgeschlossen', 'abgelehnt', 'storniert'));
    when 'projekt_termin' then
      return exists (select 1 from public.project_appointments a
                     join public.projects p on p.id = a.project_id
                     where a.id = p_id and p.status in ('abgeschlossen', 'abgelehnt', 'storniert'));
    when 'projekt_dok' then
      return exists (select 1 from public.project_docs d
                     join public.projects p on p.id = d.project_id
                     where d.id = p_id and p.status in ('abgeschlossen', 'abgelehnt', 'storniert'));
    when 'entwurf' then
      return exists (select 1 from public.job_drafts d
                     where d.id = p_id and d.status in ('storniert', 'umgewandelt'));
    else
      raise exception 'archiv_gesperrt: unbekannte Art %', p_art;
  end case;
end;
$$;

revoke all on function public.archiv_gesperrt(text, uuid) from public, anon;
grant execute on function public.archiv_gesperrt(text, uuid) to authenticated, service_role;

-- ─── Kind-Tabellen: generischer Trigger ────────────────────────────────────
-- Argumente: (art, spalte_mit_eltern_id, meldung). Prueft beim INSERT die neue,
-- beim DELETE die alte und beim UPDATE beide Eltern-IDs (Umhaengen in ein
-- archiviertes Elternteil ist ebenso gesperrt wie das Herausloesen).
create or replace function public.archiv_schutz_kind()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_art     text := tg_argv[0];
  v_spalte  text := tg_argv[1];
  v_meldung text := tg_argv[2];
  v_alt     uuid;
  v_neu     uuid;
begin
  if current_user not in ('authenticated', 'anon') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op <> 'INSERT' then
    v_alt := (to_jsonb(old) ->> v_spalte)::uuid;
  end if;
  if tg_op <> 'DELETE' then
    v_neu := (to_jsonb(new) ->> v_spalte)::uuid;
  end if;
  if public.archiv_gesperrt(v_art, v_alt)
     or (v_neu is distinct from v_alt and public.archiv_gesperrt(v_art, v_neu)) then
    raise exception using errcode = 'PT409', message = v_meldung;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- ─── Auftraege (jobs) ──────────────────────────────────────────────────────
create or replace function public.archiv_schutz_jobs()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  c_meldung constant text :=
    'Der Auftrag ist archiviert (abgeschlossen oder storniert) und kann nur noch gelesen werden.';
  -- Nach dem Archivieren legitim: Rechnungs-Nachlauf + Soft-Delete.
  c_frei constant text[] := array[
    'updated_at', 'is_deleted',
    'invoiced_at', 'invoice_number', 'invoiced_by', 'invoiced_by_name',
    'invoice_skipped_at', 'invoice_skipped_reason', 'invoice_skipped_by', 'invoice_skipped_by_name'
  ];
  -- Beim Wieder-Oeffnen duerfen die Storno-Angaben mit zurueckgesetzt werden.
  c_storno constant text[] := array['status', 'cancelled_by', 'cancelled_at', 'cancellation_reason', 'cancelled_by_name'];
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if old.status not in ('abgeschlossen', 'storniert') then
    return new;
  end if;

  -- Wieder oeffnen: Status verlaesst das Archiv.
  if new.status not in ('abgeschlossen', 'storniert') then
    if not public.has_permission('auftraege:edit') then
      raise exception using errcode = 'PT409', message = c_meldung;
    end if;
    if (to_jsonb(new) - c_frei - c_storno) is distinct from (to_jsonb(old) - c_frei - c_storno) then
      raise exception using errcode = 'PT409', message = c_meldung;
    end if;
    return new;
  end if;

  if (to_jsonb(new) - c_frei) is distinct from (to_jsonb(old) - c_frei) then
    raise exception using errcode = 'PT409', message = c_meldung;
  end if;
  return new;
end;
$$;

drop trigger if exists archiv_schutz on public.jobs;
create trigger archiv_schutz
  before update on public.jobs
  for each row execute function public.archiv_schutz_jobs();

-- ─── Kunden (customers) ────────────────────────────────────────────────────
create or replace function public.archiv_schutz_kunden()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  c_meldung constant text :=
    'Der Kunde ist archiviert und kann nur noch gelesen werden — zum Bearbeiten zuerst reaktivieren.';
  c_frei constant text[] := array['updated_at'];
  c_reaktiv constant text[] := array['archived_at', 'is_active'];
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if old.archived_at is null then
    return new;
  end if;
  -- Reaktivieren
  if new.archived_at is null then
    if not public.has_permission('kunden:archive') then
      raise exception using errcode = 'PT409', message = c_meldung;
    end if;
    if (to_jsonb(new) - c_frei - c_reaktiv) is distinct from (to_jsonb(old) - c_frei - c_reaktiv) then
      raise exception using errcode = 'PT409', message = c_meldung;
    end if;
    return new;
  end if;
  if (to_jsonb(new) - c_frei) is distinct from (to_jsonb(old) - c_frei) then
    raise exception using errcode = 'PT409', message = c_meldung;
  end if;
  return new;
end;
$$;

drop trigger if exists archiv_schutz on public.customers;
create trigger archiv_schutz
  before update on public.customers
  for each row execute function public.archiv_schutz_kunden();

-- ─── Locations (locations) ─────────────────────────────────────────────────
create or replace function public.archiv_schutz_locations()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  c_meldung constant text :=
    'Die Location ist archiviert und kann nur noch gelesen werden — zum Bearbeiten zuerst reaktivieren.';
  c_frei constant text[] := array['updated_at'];
  c_reaktiv constant text[] := array['archived_at', 'archived_by', 'archived_reason', 'is_active'];
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if old.archived_at is null then
    return new;
  end if;
  -- Reaktivieren (RLS wie Migration 252: locations:edit ODER locations:archive)
  if new.archived_at is null then
    if not (public.has_permission('locations:archive') or public.has_permission('locations:edit')) then
      raise exception using errcode = 'PT409', message = c_meldung;
    end if;
    if (to_jsonb(new) - c_frei - c_reaktiv) is distinct from (to_jsonb(old) - c_frei - c_reaktiv) then
      raise exception using errcode = 'PT409', message = c_meldung;
    end if;
    return new;
  end if;
  if (to_jsonb(new) - c_frei) is distinct from (to_jsonb(old) - c_frei) then
    raise exception using errcode = 'PT409', message = c_meldung;
  end if;
  return new;
end;
$$;

drop trigger if exists archiv_schutz on public.locations;
create trigger archiv_schutz
  before update on public.locations
  for each row execute function public.archiv_schutz_locations();

-- ─── Projekte (projects) ───────────────────────────────────────────────────
create or replace function public.archiv_schutz_projekte()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  c_meldung constant text :=
    'Das Projekt ist archiviert (abgeschlossen, abgelehnt oder storniert) und kann nur noch gelesen werden.';
  c_frei constant text[] := array['updated_at', 'is_deleted'];
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if old.status not in ('abgeschlossen', 'abgelehnt', 'storniert') then
    return new;
  end if;
  if (to_jsonb(new) - c_frei) is distinct from (to_jsonb(old) - c_frei) then
    raise exception using errcode = 'PT409', message = c_meldung;
  end if;
  return new;
end;
$$;

drop trigger if exists archiv_schutz on public.projects;
create trigger archiv_schutz
  before update on public.projects
  for each row execute function public.archiv_schutz_projekte();

-- ─── Entwuerfe (job_drafts) ────────────────────────────────────────────────
create or replace function public.archiv_schutz_entwuerfe()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  c_meldung constant text :=
    'Der Entwurf ist archiviert (storniert oder umgewandelt) und kann nur noch gelesen werden.';
  c_frei constant text[] := array['updated_at', 'is_deleted'];
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if old.status not in ('storniert', 'umgewandelt') then
    return new;
  end if;
  -- Wieder aktivieren (nur stornierte; umgewandelt ist endgueltig)
  if old.status = 'storniert' and new.status in ('aktiv', 'wartet_auf_kunde') then
    if not public.has_permission('auftraege:edit') then
      raise exception using errcode = 'PT409', message = c_meldung;
    end if;
    if (to_jsonb(new) - c_frei - 'status') is distinct from (to_jsonb(old) - c_frei - 'status') then
      raise exception using errcode = 'PT409', message = c_meldung;
    end if;
    return new;
  end if;
  if (to_jsonb(new) - c_frei) is distinct from (to_jsonb(old) - c_frei) then
    raise exception using errcode = 'PT409', message = c_meldung;
  end if;
  return new;
end;
$$;

drop trigger if exists archiv_schutz on public.job_drafts;
create trigger archiv_schutz
  before update on public.job_drafts
  for each row execute function public.archiv_schutz_entwuerfe();

-- ─── Kind-Tabellen anhaengen ───────────────────────────────────────────────
do $$
declare
  c_auftrag  constant text := 'Der Auftrag ist archiviert (abgeschlossen oder storniert) und kann nur noch gelesen werden.';
  c_standort constant text := 'Die Location ist archiviert und kann nur noch gelesen werden — zum Bearbeiten zuerst reaktivieren.';
  c_projekt  constant text := 'Das Projekt ist archiviert (abgeschlossen, abgelehnt oder storniert) und kann nur noch gelesen werden.';
  c_entwurf  constant text := 'Der Entwurf ist archiviert (storniert oder umgewandelt) und kann nur noch gelesen werden.';
  r record;
begin
  for r in
    select * from (values
      -- Tabelle,                             Trigger-Name,             Art,              Spalte,           Meldung
      ('job_appointments',                    'archiv_schutz',          'auftrag',        'job_id',         c_auftrag),
      ('job_anforderungen',                   'archiv_schutz',          'auftrag',        'job_id',         c_auftrag),
      ('job_plan_objekte',                    'archiv_schutz',          'auftrag',        'job_id',         c_auftrag),
      ('job_technik_positionen',              'archiv_schutz',          'auftrag',        'job_id',         c_auftrag),
      ('job_technik_kommentare',              'archiv_schutz',          'auftrag',        'job_id',         c_auftrag),
      ('job_technik_reviews',                 'archiv_schutz',          'auftrag',        'job_id',         c_auftrag),
      ('job_lieferanten',                     'archiv_schutz',          'auftrag',        'job_id',         c_auftrag),
      ('job_inbox_items',                     'archiv_schutz',          'auftrag',        'job_id',         c_auftrag),
      ('service_reports',                     'archiv_schutz',          'auftrag',        'job_id',         c_auftrag),
      ('report_photos',                       'archiv_schutz',          'rapport',        'report_id',      c_auftrag),
      ('documents',                           'archiv_schutz_auftrag',  'auftrag',        'job_id',         c_auftrag),
      ('documents',                           'archiv_schutz_standort', 'standort',       'location_id',    c_standort),
      ('documents',                           'archiv_schutz_projekt',  'projekt',        'project_id',     c_projekt),
      ('location_contacts',                   'archiv_schutz',          'standort',       'location_id',    c_standort),
      ('location_rate_tiers',                 'archiv_schutz',          'standort',       'location_id',    c_standort),
      ('location_rate_tier_prices',           'archiv_schutz',          'tarif',          'tier_id',        c_standort),
      ('project_appointments',                'archiv_schutz',          'projekt',        'project_id',     c_projekt),
      ('project_appointment_participants',    'archiv_schutz',          'projekt_termin', 'appointment_id', c_projekt),
      ('project_appointment_notes',           'archiv_schutz',          'projekt_termin', 'appointment_id', c_projekt),
      ('project_docs',                        'archiv_schutz',          'projekt',        'project_id',     c_projekt),
      ('project_doc_versions',                'archiv_schutz',          'projekt_dok',    'doc_id',         c_projekt),
      ('project_members',                     'archiv_schutz',          'projekt',        'project_id',     c_projekt),
      ('job_draft_notes',                     'archiv_schutz',          'entwurf',        'draft_id',       c_entwurf)
    ) as t(tabelle, trigger_name, art, spalte, meldung)
  loop
    execute format('drop trigger if exists %I on public.%I', r.trigger_name, r.tabelle);
    execute format(
      'create trigger %I before insert or update or delete on public.%I '
      'for each row execute function public.archiv_schutz_kind(%L, %L, %L)',
      r.trigger_name, r.tabelle, r.art, r.spalte, r.meldung
    );
  end loop;
end;
$$;

-- Trigger-Funktionen sind nie direkt aufrufbar; ausdruecklich niemandem
-- ausser den Eigentuemern (Ausfuehren beim Feuern prueft Postgres nicht).
revoke all on function public.archiv_schutz_kind() from public, anon, authenticated;
revoke all on function public.archiv_schutz_jobs() from public, anon, authenticated;
revoke all on function public.archiv_schutz_kunden() from public, anon, authenticated;
revoke all on function public.archiv_schutz_locations() from public, anon, authenticated;
revoke all on function public.archiv_schutz_projekte() from public, anon, authenticated;
revoke all on function public.archiv_schutz_entwuerfe() from public, anon, authenticated;
