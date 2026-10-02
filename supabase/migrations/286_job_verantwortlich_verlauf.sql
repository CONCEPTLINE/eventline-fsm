-- 286: Verlauf der verantwortlichen Person je Auftrag (Leo 2026-10-02:
-- "ein kleiner Block Verantwortlich, wo man auch die Historie sehen kann").
--
-- Aufgezeichnet per Trigger auf jobs.project_lead_id — damit JEDER Weg
-- erfasst ist (Formular, Schnellwechsel im Kopf, Entwurf-/Vertrieb-
-- Umwandlung, SQL). Namen als Momentaufnahme, damit der Verlauf lesbar
-- bleibt, auch wenn ein Profil spaeter geloescht wird (FKs SET NULL).
-- Wer geaendert hat: auth.uid() des Aufrufers; bei Service-Role-Aufrufen
-- (z.B. Entwurf-Umwandlung) beim Anlegen ersatzweise jobs.created_by.
-- Kein Backfill: fuer Bestandsauftraege ist unbekannt, wann wer gesetzt
-- wurde — der Verlauf beginnt mit dieser Migration.

create table if not exists job_verantwortlich_verlauf (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  person_id uuid references profiles(id) on delete set null,
  person_name text,
  vorher_id uuid references profiles(id) on delete set null,
  vorher_name text,
  geaendert_von uuid references profiles(id) on delete set null,
  geaendert_von_name text,
  created_at timestamptz not null default now()
);
create index if not exists job_verantwortlich_verlauf_job on job_verantwortlich_verlauf (job_id, created_at desc);

alter table job_verantwortlich_verlauf enable row level security;

-- Lesen: interne Mitarbeiter, die den Auftrag sehen duerfen (die jobs-RLS
-- greift in der Unterabfrage). Schreiben nur ueber den Trigger (security
-- definer) — bewusst keine insert/update/delete-Policies: der Verlauf ist
-- append-only und fuer Clients nicht veraenderbar.
drop policy if exists job_verantwortlich_verlauf_select on job_verantwortlich_verlauf;
create policy job_verantwortlich_verlauf_select on job_verantwortlich_verlauf
  for select to authenticated
  using (
    not public.is_partner()
    and not public.is_lieferant()
    and exists (select 1 from jobs j where j.id = job_verantwortlich_verlauf.job_id)
  );

create or replace function public.log_job_verantwortlich()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
begin
  if tg_op = 'INSERT' then
    if new.project_lead_id is null then
      return new;
    end if;
  elsif new.project_lead_id is not distinct from old.project_lead_id then
    return new;
  end if;

  v_actor := coalesce(auth.uid(), case when tg_op = 'INSERT' then new.created_by end);

  insert into job_verantwortlich_verlauf
    (job_id, person_id, person_name, vorher_id, vorher_name, geaendert_von, geaendert_von_name)
  values (
    new.id,
    new.project_lead_id,
    (select full_name from profiles where id = new.project_lead_id),
    case when tg_op = 'UPDATE' then old.project_lead_id end,
    case when tg_op = 'UPDATE' then (select full_name from profiles where id = old.project_lead_id) end,
    v_actor,
    (select full_name from profiles where id = v_actor)
  );
  return new;
end;
$$;

drop trigger if exists jobs_verantwortlich_verlauf on jobs;
create trigger jobs_verantwortlich_verlauf
  after insert or update of project_lead_id on jobs
  for each row execute function public.log_job_verantwortlich();
