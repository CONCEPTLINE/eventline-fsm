-- 319: Änderungsverlauf der Auftrags-Stammdaten + «letzte Änderung rückgängig»
-- (Leo 2026-10-14: «mache das wieder, dass man Aufträge bearbeiten kann, diese
-- Änderungen sollten aber in einer Historie geloggt sein und jeweils die letzte
-- Änderung rückgängig gemacht werden können»).
--
-- 1) Tabelle public.job_aenderungen — EIN Eintrag pro Änderung (= pro UPDATE
--    einer jobs-Zeile, das mindestens ein Stammdaten-Feld wirklich ändert):
--      felder = {"<spalte>": {"alt": <wert>, "neu": <wert>}, …}  (nur geänderte)
--      art    = 'aenderung' | 'rueckgaengig'
--      bezug_id         = bei 'rueckgaengig': der zurückgenommene Eintrag
--      rueckgaengig_at/_von = am zurückgenommenen 'aenderung'-Eintrag
--      person_id = auth.uid() des Aufrufers; NULL = System/Server (Service-Role,
--      z.B. KI-Eingang, Partner-Entscheid-Route; ebenso ein Konto ohne
--      profiles-Zeile, damit Speichern nie am FK scheitert). person_name = Momentaufnahme
--      (bleibt lesbar, wenn das Profil später gelöscht wird — FK SET NULL),
--      Muster wie job_verantwortlich_verlauf (286).
--
-- 2) Trigger jobs_aenderungen_verlauf (AFTER UPDATE OF <Stammdaten-Spalten>)
--    protokolliert genau die Felder, die die Bearbeiten-Seite schreibt
--    (src/app/(app)/auftraege/[id]/bearbeiten/page.tsx, Payload bzw.
--    JOB_FORM_FIELDS ohne id/job_number/status):
--      job_type, title, description, priority, customer_id, location_id,
--      room_id, external_address, start_date, end_date, contact_person,
--      contact_phone, contact_email, project_lead_id
--    Bewusst NICHT: status, Zeitstempel, Zähler, notes, Rechnungs-, Partner-
--    und Technik-/KI-Felder. Erfasst wird JEDER Weg (Formular, Verantwortlich-
--    Klick im Kopf, KI-Vorschläge, Partner-Titel, Server-Routen, SQL) —
--    gewollt, damit der Verlauf lückenlos ist. Kein Backfill: der Verlauf
--    beginnt mit dieser Migration.
--
-- 3) RPC auftrag_aenderung_rueckgaengig(p_id) — nimmt die NEUESTE noch nicht
--    zurückgenommene 'aenderung' eines Auftrags zurück (Stapel: danach ist die
--    nächstältere die letzte). Prüft:
--      - Recht auftraege:edit (has_permission, Admin immer)
--      - Auftrag sichtbar UND bearbeitbar: die RPC läuft bewusst als
--        SECURITY INVOKER — Eintrag lesen, Auftrag sperren und zurückschreiben
--        gehen durch die RLS von job_aenderungen und jobs (jobs_select +
--        jobs_update_*), exakt wie beim direkten Bearbeiten. So muss die
--        Sichtbarkeitsregel von jobs nicht nachgebaut werden (kein Auseinander-
--        driften, z.B. projekt-leiter sieht nur eigene/zugeteilte Aufträge).
--      - Eintrag ist die neueste offene 'aenderung' des Auftrags
--      - die aktuellen Werte sind noch genau die «neu»-Werte des Eintrags
--        (sonst «Wurde inzwischen erneut geändert» — nie still überschreiben)
--    Dann: Auftrag FOR UPDATE gesperrt (serialisiert gleichzeitige Klicks und
--    Bearbeitungen), Felder auf «alt», und über set_config('app.job_
--    rueckgaengig_von', <id>, true) erfährt der Trigger den Bezug: ER (security
--    definer) markiert den Eintrag als zurückgenommen und schreibt den
--    'rueckgaengig'-Eintrag. Rückgängig-Einträge selbst sind nicht rücknehmbar
--    (kein Redo). Fremdschlüssel-Fehler (früherer Kunde/Location/Raum/Person
--    inzwischen gelöscht) kommen als verständliche Meldung zurück.
--
-- RLS job_aenderungen — alle 4 Verben bedacht:
--   SELECT: interne Konten (is_internal_user, keine Portal-Rollen) UND der
--           Auftrag ist sichtbar (exists auf jobs → jobs-RLS greift).
--   INSERT/UPDATE/DELETE: bewusst KEINE Policy + Rechte für anon/authenticated
--           entzogen — nur der Trigger (security definer, Tabellen-Owner)
--           schreibt; der Verlauf ist für Clients unveränderlich. Gelöscht wird
--           nur per Kaskade mit dem Auftrag.
--
-- Idempotent (if not exists / create or replace / drop … if exists), nur
-- additiv, keine Datenänderung. Einspielen:
--   node scripts/apply-migration.mjs supabase/migrations/319_auftrag_aenderungen.sql
-- Rücksetzen:
--   drop trigger if exists jobs_aenderungen_verlauf on public.jobs;
--   drop function if exists public.auftrag_aenderung_rueckgaengig(uuid);
--   drop function if exists public.log_job_aenderung();
--   drop table if exists public.job_aenderungen;

-- create/drop trigger sperren jobs kurz — nie lange hinter einer laufenden
-- Transaktion warten (Live-DB).
set lock_timeout = '5s';

-- 1) Tabelle -----------------------------------------------------------------
create table if not exists public.job_aenderungen (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  -- clock_timestamp statt now(): mehrere Änderungen in EINER Transaktion
  -- bekommen trotzdem eine eindeutige Reihenfolge (Stapel «letzte Änderung»).
  zeitpunkt timestamptz not null default clock_timestamp(),
  person_id uuid references public.profiles(id) on delete set null,
  person_name text,
  felder jsonb not null,
  art text not null default 'aenderung',
  bezug_id uuid references public.job_aenderungen(id) on delete set null,
  rueckgaengig_at timestamptz,
  rueckgaengig_von uuid references public.profiles(id) on delete set null,
  constraint job_aenderungen_art_check check (art in ('aenderung', 'rueckgaengig')),
  constraint job_aenderungen_felder_check check (jsonb_typeof(felder) = 'object'),
  -- Bezug nur bei Rückgängig-Einträgen; zurückgenommen werden nur Änderungen.
  constraint job_aenderungen_bezug_check check (art = 'rueckgaengig' or bezug_id is null),
  constraint job_aenderungen_rueckgaengig_check check (art = 'aenderung' or rueckgaengig_at is null)
);

comment on table public.job_aenderungen is
  'Änderungsverlauf der Auftrags-Stammdaten (Migration 319). Schreibt nur der Trigger jobs_aenderungen_verlauf.';
comment on column public.job_aenderungen.felder is
  '{"<jobs-spalte>": {"alt": <wert>, "neu": <wert>}} — nur die geänderten Felder.';
comment on column public.job_aenderungen.person_id is
  'auth.uid() des Aufrufers; NULL = System/Server.';

create index if not exists job_aenderungen_job_zeit
  on public.job_aenderungen (job_id, zeitpunkt desc);
-- Eine Änderung kann höchstens EINMAL zurückgenommen werden (auch bei Wettlauf).
create unique index if not exists job_aenderungen_bezug_einmal
  on public.job_aenderungen (bezug_id) where bezug_id is not null;

-- 2) RLS + Rechte -------------------------------------------------------------
alter table public.job_aenderungen enable row level security;

drop policy if exists job_aenderungen_select on public.job_aenderungen;
create policy job_aenderungen_select on public.job_aenderungen
  for select to authenticated
  using (
    ( SELECT public.is_internal_user() )
    and exists (select 1 from public.jobs j where j.id = job_aenderungen.job_id)
  );
-- INSERT / UPDATE / DELETE: absichtlich keine Policy (siehe Kopf).

revoke all on table public.job_aenderungen from anon;
revoke insert, update, delete, truncate, references, trigger
  on table public.job_aenderungen from authenticated;
grant select on table public.job_aenderungen to authenticated;

-- 3) Trigger-Funktion ---------------------------------------------------------
create or replace function public.log_job_aenderung()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  c_felder constant text[] := array[
    'job_type', 'title', 'description', 'priority',
    'customer_id', 'location_id', 'room_id', 'external_address',
    'start_date', 'end_date',
    'contact_person', 'contact_phone', 'contact_email',
    'project_lead_id'
  ];
  v_alt   jsonb := to_jsonb(old);
  v_neu   jsonb := to_jsonb(new);
  v_diff  jsonb := '{}'::jsonb;
  v_feld  text;
  v_actor uuid;
  v_name  text;
  v_bezug_txt text := nullif(current_setting('app.job_rueckgaengig_von', true), '');
  v_bezug public.job_aenderungen%rowtype;
begin
  foreach v_feld in array c_felder loop
    if (v_alt -> v_feld) is distinct from (v_neu -> v_feld) then
      v_diff := v_diff || jsonb_build_object(
        v_feld, jsonb_build_object('alt', v_alt -> v_feld, 'neu', v_neu -> v_feld)
      );
    end if;
  end loop;

  -- Nichts Relevantes geändert (z.B. gleicher Wert erneut gespeichert).
  if v_diff = '{}'::jsonb then
    return null;
  end if;

  -- Person nur, wenn es das Profil gibt — ein Konto ohne profiles-Zeile darf
  -- das Speichern des Auftrags nie am Fremdschlüssel scheitern lassen
  -- (dann NULL = wie System).
  select p.id, p.full_name into v_actor, v_name
  from public.profiles p
  where p.id = auth.uid();

  -- Normale Änderung
  if v_bezug_txt is null then
    insert into public.job_aenderungen (job_id, person_id, person_name, felder, art)
    values (new.id, v_actor, v_name, v_diff, 'aenderung');
    return null;
  end if;

  -- Rückgängig-Lauf (Bezug gesetzt von auftrag_aenderung_rueckgaengig).
  -- Gegenprobe: Eintrag gehört zu diesem Auftrag, ist eine offene Änderung,
  -- und es ändern sich genau ihre Felder.
  select * into v_bezug
  from public.job_aenderungen
  where id = v_bezug_txt::uuid
  for update;

  if not found
     or v_bezug.job_id <> new.id
     or v_bezug.art <> 'aenderung'
     or v_bezug.rueckgaengig_at is not null
     or (select array_agg(k order by k) from jsonb_object_keys(v_diff) k)
        is distinct from
        (select array_agg(k order by k) from jsonb_object_keys(v_bezug.felder) k)
  then
    raise exception 'Rückgängig nicht möglich — der Eintrag passt nicht zu dieser Änderung';
  end if;

  update public.job_aenderungen
     set rueckgaengig_at = clock_timestamp(),
         rueckgaengig_von = v_actor
   where id = v_bezug.id;

  insert into public.job_aenderungen (job_id, person_id, person_name, felder, art, bezug_id)
  values (new.id, v_actor, v_name, v_diff, 'rueckgaengig', v_bezug.id);

  -- Bezug verbrauchen: weitere Updates derselben Transaktion zählen wieder
  -- als normale Änderung.
  perform set_config('app.job_rueckgaengig_von', '', true);
  return null;
end;
$$;

-- Trigger-Funktionen sind nicht direkt aufrufbar; Rechte trotzdem schliessen.
revoke all on function public.log_job_aenderung() from public;
revoke all on function public.log_job_aenderung() from anon;

drop trigger if exists jobs_aenderungen_verlauf on public.jobs;
create trigger jobs_aenderungen_verlauf
  after update of
    job_type, title, description, priority,
    customer_id, location_id, room_id, external_address,
    start_date, end_date,
    contact_person, contact_phone, contact_email,
    project_lead_id
  on public.jobs
  for each row
  execute function public.log_job_aenderung();

-- 4) Rückgängig-RPC -----------------------------------------------------------
create or replace function public.auftrag_aenderung_rueckgaengig(p_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_eintrag    public.job_aenderungen%rowtype;
  v_job        public.jobs%rowtype;
  v_ziel       public.jobs%rowtype;
  v_neueste    uuid;
  v_alt        jsonb;
  v_neu        jsonb;
  v_ist        jsonb;
  v_soll       jsonb;
  v_feld       text;
  v_constraint text;
  v_anzahl     integer := 0;
begin
  if p_id is null then
    raise exception 'Eintrag fehlt';
  end if;
  if not public.has_permission('auftraege:edit') then
    raise exception 'Keine Berechtigung, Aufträge zu bearbeiten' using errcode = '42501';
  end if;

  -- Lesen durch die RLS: fremde/unsichtbare Aufträge wie nicht vorhanden.
  select * into v_eintrag from public.job_aenderungen where id = p_id;
  if not found then
    raise exception 'Eintrag nicht gefunden';
  end if;
  if v_eintrag.art <> 'aenderung' then
    raise exception 'Ein Rückgängig-Eintrag kann nicht zurückgenommen werden';
  end if;

  -- Auftrag sperren (RLS: sehen + bearbeiten). Ein zweiter gleichzeitiger
  -- Klick oder eine laufende Bearbeitung wartet hier und sieht danach den
  -- neuen Stand.
  select * into v_job from public.jobs where id = v_eintrag.job_id for update;
  if not found then
    raise exception 'Auftrag nicht gefunden';
  end if;

  -- Nach der Sperre frisch lesen.
  select * into v_eintrag from public.job_aenderungen where id = p_id;
  if v_eintrag.rueckgaengig_at is not null then
    raise exception 'Diese Änderung wurde bereits rückgängig gemacht';
  end if;

  select id into v_neueste
  from public.job_aenderungen
  where job_id = v_job.id and art = 'aenderung' and rueckgaengig_at is null
  order by zeitpunkt desc, id desc
  limit 1;
  if v_neueste is distinct from p_id then
    raise exception 'Wurde inzwischen erneut geändert — nur die letzte Änderung kann rückgängig gemacht werden';
  end if;

  select jsonb_object_agg(e.key, e.value -> 'alt'), jsonb_object_agg(e.key, e.value -> 'neu')
    into v_alt, v_neu
  from jsonb_each(v_eintrag.felder) e;

  -- Stehen noch genau die «neu»-Werte drin? Vergleich typisiert (über
  -- jsonb_populate_record in DIESER Sitzung gerendert) — Zeitstempel aus
  -- einer Sitzung mit anderer Zeitzone zählen so trotzdem als gleich.
  v_ist  := to_jsonb(v_job);
  v_soll := to_jsonb(jsonb_populate_record(v_job, v_neu));
  for v_feld in select jsonb_object_keys(v_eintrag.felder) loop
    if (v_ist -> v_feld) is distinct from (v_soll -> v_feld) then
      raise exception 'Wurde inzwischen erneut geändert — Rückgängig nicht möglich';
    end if;
  end loop;

  v_ziel := jsonb_populate_record(v_job, v_alt);

  perform set_config('app.job_rueckgaengig_von', p_id::text, true);
  begin
    -- Alle Stammdaten-Felder aus dem Ziel-Datensatz: nicht betroffene Felder
    -- behalten ihren aktuellen Wert, der Trigger sieht nur die echten Diffs.
    update public.jobs set
      job_type         = v_ziel.job_type,
      title            = v_ziel.title,
      description      = v_ziel.description,
      priority         = v_ziel.priority,
      customer_id      = v_ziel.customer_id,
      location_id      = v_ziel.location_id,
      room_id          = v_ziel.room_id,
      external_address = v_ziel.external_address,
      start_date       = v_ziel.start_date,
      end_date         = v_ziel.end_date,
      contact_person   = v_ziel.contact_person,
      contact_phone    = v_ziel.contact_phone,
      contact_email    = v_ziel.contact_email,
      project_lead_id  = v_ziel.project_lead_id
    where id = v_job.id;
    get diagnostics v_anzahl = row_count;
  exception when foreign_key_violation then
    get stacked diagnostics v_constraint = constraint_name;
    raise exception '%', case v_constraint
      when 'jobs_customer_id_fkey'     then 'Der frühere Kunde existiert nicht mehr — Rückgängig nicht möglich'
      when 'jobs_location_id_fkey'     then 'Die frühere Location existiert nicht mehr — Rückgängig nicht möglich'
      when 'jobs_room_id_fkey'         then 'Der frühere Raum existiert nicht mehr — Rückgängig nicht möglich'
      when 'jobs_project_lead_id_fkey' then 'Die früher verantwortliche Person existiert nicht mehr — Rückgängig nicht möglich'
      else 'Ein früherer Wert existiert nicht mehr — Rückgängig nicht möglich'
    end;
  end;
  perform set_config('app.job_rueckgaengig_von', '', true);

  if v_anzahl = 0 then
    raise exception 'Keine Berechtigung, diesen Auftrag zu ändern' using errcode = '42501';
  end if;
end;
$$;

-- Supabase vergibt neuen Funktionen per Default-Privileg auch anon das
-- EXECUTE — darum anon ausdrücklich entziehen, nicht nur public.
revoke all on function public.auftrag_aenderung_rueckgaengig(uuid) from public;
revoke all on function public.auftrag_aenderung_rueckgaengig(uuid) from anon;
grant execute on function public.auftrag_aenderung_rueckgaengig(uuid) to authenticated;
