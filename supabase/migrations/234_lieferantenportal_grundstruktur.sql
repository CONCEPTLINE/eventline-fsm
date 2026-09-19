-- 234_lieferantenportal_grundstruktur.sql
-- ============================================================
-- LIEFERANTENPORTAL — Grundstruktur (Leo 2026-09-19): dediziertes Portal
-- fuer Technik-Lieferanten, exakt nach dem Partnerportal-Muster.
-- V1: Rolle + Zugangs-Verwaltung + Portal mit "Mein Konto" — kein Inhalt.
--  1. profiles.lieferant_id → public.lieferanten (Stammdaten-Kartei)
--  2. roles-Zeile 'lieferant' (leere Permissions — Portal hat noch nichts)
--  3. is_lieferant() + is_lieferant_email() (Login-Weiche, wie 103/216)
--  4. Interne RPCs/Policy schliessen Lieferanten aus wie Partner
--     (Zuweisungs-Dropdowns, Anwesenheit, Lohn-Statistik, Rapporte,
--     is_eventline_email) — Live-Definitionen gepatcht, kein Drift.
--  5. Alle "not is_partner()"-Exklusions-Policies (227/230/231/232)
--     schliessen zusaetzlich is_lieferant() aus — maschinell aus den
--     Original-Migrationen erzeugt.
-- Idempotent.
-- ============================================================

-- ── 1. Verknuepfung Profil → Lieferanten-Firma ────────────────
alter table public.profiles
  add column if not exists lieferant_id uuid references public.lieferanten(id) on delete set null;

create index if not exists profiles_lieferant_idx
  on public.profiles (lieferant_id) where lieferant_id is not null;

comment on column public.profiles.lieferant_id is
  'Portal-Login eines Lieferanten: verweist auf seine Firma in public.lieferanten. NULL = kein Lieferanten-Portal-User.';

-- ── 2. Rolle ──────────────────────────────────────────────────
insert into public.roles (slug, label, permissions, is_system)
values ('lieferant', 'Lieferant', '[]'::jsonb, true)
on conflict (slug) do nothing;

-- ── 3. is_lieferant() + Login-Weiche ─────────────────────────
create or replace function public.is_lieferant() returns boolean
language sql stable security definer set search_path = public as $func$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'lieferant' and is_active = true
  );
$func$;

grant execute on function public.is_lieferant() to authenticated;

-- Wie is_partner_email (103): bewusst fuer anon aufrufbar (Login-Weiche);
-- Enumeration-Risiko wie dort akzeptiert.
create or replace function public.is_lieferant_email(p_email text) returns boolean
language sql stable security definer set search_path = public as $func$
  select exists (
    select 1 from public.profiles
    where lower(email) = lower(p_email) and role = 'lieferant'
  );
$func$;

grant execute on function public.is_lieferant_email(text) to anon, authenticated;

-- ── 4. Interne Funktionen/Policy: Lieferant wie Partner ausschliessen ──
-- ### get_anwesenheit_users
CREATE OR REPLACE FUNCTION public.get_anwesenheit_users()
 RETURNS TABLE(id uuid, full_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p.id, p.full_name
  from public.profiles p
  join public.roles r on r.slug = p.role
  where p.is_active = true
    and p.role not in ('partner', 'lieferant')
    and (
      p.role = 'admin'
      or r.permissions ? 'anwesenheit:view'
    )
  order by p.full_name;
$function$
;

-- ### get_assignable_users
CREATE OR REPLACE FUNCTION public.get_assignable_users()
 RETURNS TABLE(id uuid, full_name text, role text, is_active boolean, avatar_url text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select id, full_name, role, is_active, avatar_url
  from public.profiles
  where is_active = true
    and role not in ('partner', 'lieferant')
  order by full_name;
$function$
;

-- ### get_monthly_payroll_stats
CREATE OR REPLACE FUNCTION public.get_monthly_payroll_stats(p_month_start date)
 RETURNS TABLE(profile_id uuid, full_name text, role text, is_active boolean, stempel_minutes integer, geplant_minutes integer, rapport_minutes integer, hourly_wage_chf numeric, uses_standard_lohn boolean, employer_ahv_pct numeric, employer_alv_pct numeric, employer_fak_pct numeric, employer_bu_pct numeric, employer_bvg_pct numeric, employer_verwaltung_pct numeric, ahv_iv_eo_pct numeric, alv_pct numeric, nbu_pct numeric, bvg_pct numeric, ktg_pct numeric, quellensteuer_pct numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_month_end date := (p_month_start + interval '1 month')::date;
begin
  if not public.is_admin() then
    raise exception 'forbidden: nur fuer Administratoren';
  end if;

  return query
  with stempel as (
    select t.user_id,
      sum(greatest(0, extract(epoch from (t.clock_out - t.clock_in)) / 60))::int as minutes
    from public.time_entries t
    where t.clock_in >= p_month_start
      and t.clock_in < v_month_end
      and t.clock_out is not null
    group by t.user_id
  ),
  geplant as (
    select a.assigned_to as user_id,
      sum(greatest(0, extract(epoch from (a.end_time - a.start_time)) / 60))::int as minutes
    from public.job_appointments a
    where a.assigned_to is not null
      and a.start_time >= p_month_start
      and a.start_time < v_month_end
    group by a.assigned_to
  ),
  rapport as (
    select (range->>'technician_id')::uuid as user_id,
      sum(greatest(
        0,
        case
          when (range->>'end')::time < (range->>'start')::time
            then 1440 + (extract(epoch from ((range->>'end')::time - (range->>'start')::time))::int / 60)
          else extract(epoch from ((range->>'end')::time - (range->>'start')::time))::int / 60
        end
        - coalesce(nullif(range->>'pause', '')::int, 0)
      ))::int as minutes
    from public.service_reports r
    cross join lateral jsonb_array_elements(r.time_ranges) as range
    where r.report_date >= p_month_start
      and r.report_date < v_month_end
      and r.status = 'abgeschlossen'
      and coalesce(range->>'technician_id', '') <> ''
      and coalesce(range->>'start', '') <> ''
      and coalesce(range->>'end', '') <> ''
    group by (range->>'technician_id')::uuid
  ),
  comp as (
    select distinct on (c.profile_id)
      c.profile_id,
      c.hourly_wage_chf,
      c.uses_standard_lohn,
      c.employer_ahv_pct,
      c.employer_alv_pct,
      c.employer_fak_pct,
      c.employer_bu_pct,
      c.employer_bvg_pct,
      c.employer_verwaltung_pct,
      c.ahv_iv_eo_pct,
      c.alv_pct,
      c.nbu_pct,
      c.bvg_pct,
      c.ktg_pct,
      c.quellensteuer_pct
    from public.employee_compensation c
    where c.effective_from <= p_month_start
      and (c.effective_to is null or c.effective_to >= p_month_start)
    order by c.profile_id, c.effective_from desc
  )
  select
    p.id,
    p.full_name,
    p.role,
    p.is_active,
    coalesce(s.minutes, 0),
    coalesce(g.minutes, 0),
    coalesce(r.minutes, 0),
    c.hourly_wage_chf,
    c.uses_standard_lohn,
    c.employer_ahv_pct,
    c.employer_alv_pct,
    c.employer_fak_pct,
    c.employer_bu_pct,
    c.employer_bvg_pct,
    c.employer_verwaltung_pct,
    c.ahv_iv_eo_pct,
    c.alv_pct,
    c.nbu_pct,
    c.bvg_pct,
    c.ktg_pct,
    c.quellensteuer_pct
  from public.profiles p
  left join stempel s on s.user_id = p.id
  left join geplant g on g.user_id = p.id
  left join rapport r on r.user_id = p.id
  left join comp c on c.profile_id = p.id
  where p.role not in ('partner', 'lieferant')
    and (
      p.is_active = true
      or coalesce(s.minutes, 0) > 0
      or coalesce(g.minutes, 0) > 0
      or coalesce(r.minutes, 0) > 0
    )
  order by p.is_active desc, p.full_name;
end;
$function$
;

-- ### is_eventline_email
CREATE OR REPLACE FUNCTION public.is_eventline_email(p_email text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE lower(email) = lower(trim(p_email))
      AND role not in ('partner', 'lieferant')
      AND is_active = true
  );
$function$
;


-- service_reports-Sichtbarkeit (Original: 106) — Portal-Rollen raus.
drop policy if exists "Rapporte sind sichtbar" on public.service_reports;
create policy "Rapporte sind sichtbar"
  on public.service_reports for select to authenticated
  using (
    is_admin()
    or created_by = auth.uid()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_active = true
        and p.role not in ('partner', 'lieferant')
    )
  );

-- ── 5. Exklusions-Policies aus 227/230/231/232, plus is_lieferant() ──
-- >>> uebernommen und erweitert aus 227_documents_folder.sql (2 Stellen)
-- 227_documents_folder.sql
-- ============================================================
-- Ordner fuer hochgeladene Dokumente (Auftrag + Projekt).
-- Bewusst simpel ("less but intuitive"): EINE Ordner-Ebene als
-- Text-Attribut pro Dokument. NULL = Hauptordner. Keine eigene
-- Ordner-Tabelle, kein FK — ein Ordner existiert, solange
-- Dokumente ihn tragen (frisch angelegte leere Ordner leben bis
-- zum ersten Upload nur im Client-State).
-- Standort-Dokumente brauchen KEINE Migration — dort liegen die
-- Docs als JSON-Array in locations.technical_details und tragen
-- den Ordner als optionales JSON-Property `folder`.
-- Idempotent.
-- ============================================================

alter table public.documents
  add column if not exists folder text;

comment on column public.documents.folder is
  'Ordner-Name (eine Ebene, frei benannt, z.B. "Pläne"). NULL = Hauptordner. Kein FK — Ordner existiert solange Dokumente ihn tragen.';

-- ------------------------------------------------------------
-- UPDATE-Policy: documents hatte bis jetzt nur select/insert/delete-
-- Policies — ein update({folder}) vom Client wuerde unter RLS still
-- 0 Zeilen treffen ("Verschieben" ohne Wirkung). Staff darf Dokumente
-- verschieben, die er sehen/bearbeiten kann; Partner-Portal-User
-- explizit NICHT (die Verschieben-UI existiert nur im Staff-Bereich).
-- Die EXISTS-Subqueries stehen selbst unter jobs-/projects-RLS und
-- erben damit die Auftrag-/Projekt-Sichtbarkeit (Muster Migration 126).
-- Hinweis: RLS ist nicht spaltengenau — die App aendert nur `folder`;
-- wer hier matcht, sieht/bearbeitet das Dokument ohnehin schon.
-- ------------------------------------------------------------

drop policy if exists "documents_update_folder_staff" on public.documents;

create policy "documents_update_folder_staff"
  on public.documents for update to authenticated
  using (
    not public.is_partner()
    and not public.is_lieferant()
    and (
      uploaded_by = auth.uid()
      or public.is_admin()
      or (job_id is not null and exists (
        select 1 from public.jobs j where j.id = documents.job_id
      ))
      or (project_id is not null and exists (
        select 1 from public.projects p where p.id = documents.project_id
      ))
    )
  )
  with check (
    not public.is_partner()
    and not public.is_lieferant()
    and (
      uploaded_by = auth.uid()
      or public.is_admin()
      or (job_id is not null and exists (
        select 1 from public.jobs j where j.id = documents.job_id
      ))
      or (project_id is not null and exists (
        select 1 from public.projects p where p.id = documents.project_id
      ))
    )
  );

-- >>> uebernommen und erweitert aus 230_projects_edit_members_only.sql (7 Stellen)
-- 230_projects_edit_members_only.sql
-- ============================================================
-- Korrektur zu 229: Leo meinte mit "jeder der sich einloggt" das
-- EINLOGGEN AUF DEM PROJEKT (project_members, der "Einloggen"-Button
-- vor dem Stempeln) — nicht jeden App-Login.
-- Bearbeiten duerfen also: Admin / projekte:approve bzw. see-all /
-- Ersteller / Projektleiter (assigned_to) / eingeloggte MITGLIEDER.
-- Loeschen (is_deleted) bleibt DB-seitig Admin-only, geloeschte
-- Projekte fasst nur ein Admin an. Partner-Portal bleibt aussen vor.
-- Idempotent.
-- ============================================================

-- ── projects: UPDATE fuer Beteiligte ──────────────────────────
drop policy if exists "projects_update" on public.projects;

create policy "projects_update"
  on public.projects for update to authenticated
  using (
    not public.is_partner()
    and not public.is_lieferant()
    and (not is_deleted or public.is_admin())
    and (
      public.is_admin()
      or public.has_permission('projekte:approve')
      or created_by = auth.uid()
      or assigned_to = auth.uid()
      or exists (
        select 1 from public.project_members pm
        where pm.project_id = projects.id and pm.user_id = auth.uid()
      )
    )
  )
  with check (
    not public.is_partner()
    and not public.is_lieferant()
    and (is_deleted = false or public.is_admin())
    and (
      public.is_admin()
      or public.has_permission('projekte:approve')
      or created_by = auth.uid()
      or assigned_to = auth.uid()
      or exists (
        select 1 from public.project_members pm
        where pm.project_id = projects.id and pm.user_id = auth.uid()
      )
    )
  );

-- ── project_appointments: Beteiligte sehen + bearbeiten ───────
-- (Mitglieder sahen vor 229 nicht mal die Termine — Mitglied-Klausel
-- bleibt jetzt in allen vier Verben drin.)
drop policy if exists "pa_select" on public.project_appointments;
create policy "pa_select"
  on public.project_appointments for select to authenticated
  using (
    not public.is_partner()
    and not public.is_lieferant()
    and exists (
      select 1 from public.projects p
      where p.id = project_appointments.project_id and not p.is_deleted
        and (
          public.is_admin()
          or public.has_permission('projekte:see-all')
          or p.created_by = auth.uid()
          or p.assigned_to = auth.uid()
          or exists (
            select 1 from public.project_members pm
            where pm.project_id = p.id and pm.user_id = auth.uid()
          )
        )
    )
  );

drop policy if exists "pa_insert" on public.project_appointments;
create policy "pa_insert"
  on public.project_appointments for insert to authenticated
  with check (
    not public.is_partner()
    and not public.is_lieferant()
    and created_by = auth.uid()
    and exists (
      select 1 from public.projects p
      where p.id = project_appointments.project_id and not p.is_deleted
        and (
          public.is_admin()
          or public.has_permission('projekte:see-all')
          or p.created_by = auth.uid()
          or p.assigned_to = auth.uid()
          or exists (
            select 1 from public.project_members pm
            where pm.project_id = p.id and pm.user_id = auth.uid()
          )
        )
    )
  );

drop policy if exists "pa_update" on public.project_appointments;
create policy "pa_update"
  on public.project_appointments for update to authenticated
  using (
    not public.is_partner()
    and not public.is_lieferant()
    and exists (
      select 1 from public.projects p
      where p.id = project_appointments.project_id and not p.is_deleted
        and (
          public.is_admin()
          or public.has_permission('projekte:see-all')
          or p.created_by = auth.uid()
          or p.assigned_to = auth.uid()
          or exists (
            select 1 from public.project_members pm
            where pm.project_id = p.id and pm.user_id = auth.uid()
          )
        )
    )
  )
  with check (
    not public.is_partner()
    and not public.is_lieferant()
    and exists (
      select 1 from public.projects p
      where p.id = project_appointments.project_id and not p.is_deleted
        and (
          public.is_admin()
          or public.has_permission('projekte:see-all')
          or p.created_by = auth.uid()
          or p.assigned_to = auth.uid()
          or exists (
            select 1 from public.project_members pm
            where pm.project_id = p.id and pm.user_id = auth.uid()
          )
        )
    )
  );

drop policy if exists "pa_delete" on public.project_appointments;
create policy "pa_delete"
  on public.project_appointments for delete to authenticated
  using (
    not public.is_partner()
    and not public.is_lieferant()
    and exists (
      select 1 from public.projects p
      where p.id = project_appointments.project_id and not p.is_deleted
        and (
          public.is_admin()
          or public.has_permission('projekte:see-all')
          or p.created_by = auth.uid()
          or p.assigned_to = auth.uid()
          or exists (
            select 1 from public.project_members pm
            where pm.project_id = p.id and pm.user_id = auth.uid()
          )
        )
    )
  );

-- >>> uebernommen und erweitert aus 231_project_docs.sql (7 Stellen)
-- 231_project_docs.sql
-- ============================================================
-- Live-Dokumente in Projekten ("Sharepoint"-Idee, Leo 2026-09-17):
-- gemeinsame, gleichzeitig bearbeitbare Dokumente direkt in der App —
-- kein Hin- und Herschicken von Dateien.
--  - project_docs: ein Live-Dokument pro Zeile. ydoc_state = kompletter
--    Kollaborations-Zustand (Yjs, base64), content_html = letzter
--    HTML-Schnappschuss (Versionen/Vorschau).
--  - project_doc_versions: Verlaufs-Schnappschuesse (alle ~10 Min beim
--    aktiven Schreiben), fuer "Verlauf ansehen + wiederherstellen".
-- Live-Sync laeuft ueber Supabase Realtime BROADCAST (kein Table-
-- Replication-Setup noetig).
-- Rechte wie Migration 230: LESEN alle Mitarbeiter (kein Partner),
-- SCHREIBEN Admin / projekte:approve / projekte:see-all / Ersteller /
-- Projektleiter / eingeloggte Mitglieder. Loeschen von Dokumenten:
-- gleiche Schreib-Gruppe; Versionen loescht nur ein Admin.
-- Idempotent.
-- ============================================================

create table if not exists public.project_docs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null default 'Neues Dokument',
  ydoc_state text,
  content_html text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);

create index if not exists project_docs_project_idx
  on public.project_docs (project_id, updated_at desc);

create table if not exists public.project_doc_versions (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references public.project_docs(id) on delete cascade,
  content_html text not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists project_doc_versions_doc_idx
  on public.project_doc_versions (doc_id, created_at desc);

alter table public.project_docs enable row level security;
alter table public.project_doc_versions enable row level security;

-- Schreib-Klausel (Beteiligte) als wiederverwendbares Muster:
-- is_admin / projekte:approve / projekte:see-all / Ersteller / Projekt-
-- leiter / Mitglied — identisch zu Migration 230.

drop policy if exists "pdocs_select" on public.project_docs;
create policy "pdocs_select"
  on public.project_docs for select to authenticated
  using (
    not public.is_partner()
    and not public.is_lieferant()
    and exists (
      select 1 from public.projects p
      where p.id = project_docs.project_id and not p.is_deleted
    )
  );

drop policy if exists "pdocs_insert" on public.project_docs;
create policy "pdocs_insert"
  on public.project_docs for insert to authenticated
  with check (
    not public.is_partner()
    and not public.is_lieferant()
    and created_by = auth.uid()
    and exists (
      select 1 from public.projects p
      where p.id = project_docs.project_id and not p.is_deleted
        and (
          public.is_admin()
          or public.has_permission('projekte:approve')
          or public.has_permission('projekte:see-all')
          or p.created_by = auth.uid()
          or p.assigned_to = auth.uid()
          or exists (
            select 1 from public.project_members pm
            where pm.project_id = p.id and pm.user_id = auth.uid()
          )
        )
    )
  );

drop policy if exists "pdocs_update" on public.project_docs;
create policy "pdocs_update"
  on public.project_docs for update to authenticated
  using (
    not public.is_partner()
    and not public.is_lieferant()
    and exists (
      select 1 from public.projects p
      where p.id = project_docs.project_id and not p.is_deleted
        and (
          public.is_admin()
          or public.has_permission('projekte:approve')
          or public.has_permission('projekte:see-all')
          or p.created_by = auth.uid()
          or p.assigned_to = auth.uid()
          or exists (
            select 1 from public.project_members pm
            where pm.project_id = p.id and pm.user_id = auth.uid()
          )
        )
    )
  )
  with check (
    not public.is_partner()
    and not public.is_lieferant()
    and exists (
      select 1 from public.projects p
      where p.id = project_docs.project_id and not p.is_deleted
        and (
          public.is_admin()
          or public.has_permission('projekte:approve')
          or public.has_permission('projekte:see-all')
          or p.created_by = auth.uid()
          or p.assigned_to = auth.uid()
          or exists (
            select 1 from public.project_members pm
            where pm.project_id = p.id and pm.user_id = auth.uid()
          )
        )
    )
  );

drop policy if exists "pdocs_delete" on public.project_docs;
create policy "pdocs_delete"
  on public.project_docs for delete to authenticated
  using (
    not public.is_partner()
    and not public.is_lieferant()
    and exists (
      select 1 from public.projects p
      where p.id = project_docs.project_id and not p.is_deleted
        and (
          public.is_admin()
          or public.has_permission('projekte:approve')
          or public.has_permission('projekte:see-all')
          or p.created_by = auth.uid()
          or p.assigned_to = auth.uid()
          or exists (
            select 1 from public.project_members pm
            where pm.project_id = p.id and pm.user_id = auth.uid()
          )
        )
    )
  );

-- Versionen: lesen wie Doks; anlegen durch Schreibberechtigte (eigener
-- Stempel); loeschen nur Admin (Verlauf soll nicht verschwinden).
drop policy if exists "pdocv_select" on public.project_doc_versions;
create policy "pdocv_select"
  on public.project_doc_versions for select to authenticated
  using (
    not public.is_partner()
    and not public.is_lieferant()
    and exists (
      select 1 from public.project_docs d
      join public.projects p on p.id = d.project_id
      where d.id = project_doc_versions.doc_id and not p.is_deleted
    )
  );

drop policy if exists "pdocv_insert" on public.project_doc_versions;
create policy "pdocv_insert"
  on public.project_doc_versions for insert to authenticated
  with check (
    not public.is_partner()
    and not public.is_lieferant()
    and created_by = auth.uid()
    and exists (
      select 1 from public.project_docs d
      join public.projects p on p.id = d.project_id
      where d.id = project_doc_versions.doc_id and not p.is_deleted
        and (
          public.is_admin()
          or public.has_permission('projekte:approve')
          or public.has_permission('projekte:see-all')
          or p.created_by = auth.uid()
          or p.assigned_to = auth.uid()
          or exists (
            select 1 from public.project_members pm
            where pm.project_id = p.id and pm.user_id = auth.uid()
          )
        )
    )
  );

drop policy if exists "pdocv_update" on public.project_doc_versions;
create policy "pdocv_update"
  on public.project_doc_versions for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "pdocv_delete" on public.project_doc_versions;
create policy "pdocv_delete"
  on public.project_doc_versions for delete to authenticated
  using (public.is_admin());

-- >>> uebernommen und erweitert aus 232_job_eingang_zusagen.sql (10 Stellen)
-- 232_job_eingang_zusagen.sql
-- ============================================================
-- "Der Auftrag dokumentiert sich selbst" (Leo 2026-09-19):
--  - job_inbox_items: der EINGANG eines Auftrags — unsortiertes Roh-
--    material (diktierter/getippter Text, weitergeleitete Mails als Text,
--    Screenshots/Fotos/PDFs). KI liest Neues und pflegt daraus Zusammen-
--    fassung + Zusagen. ai_status: neu -> verarbeitet/fehler.
--  - job_zusagen: verbindliche Abmachungen mit dem Kunden (offen/erledigt/
--    hinfaellig), von der KI extrahiert ODER manuell erfasst; quelle_item_id
--    verlinkt den Beleg im Eingang.
--  - jobs.ai_summary: KI-gepflegte Zusammenfassung des Auftrags.
-- Rechte: sichtbar/beschreibbar fuer alle Mitarbeiter, die den Auftrag
-- sehen (jobs-RLS wird via EXISTS-Subquery geerbt) — ausser Partner-
-- Portal-User (interne Infos!). Eingang-Loeschen: Ersteller oder Admin.
-- Idempotent.
-- ============================================================

alter table public.jobs add column if not exists ai_summary text;

comment on column public.jobs.ai_summary is
  'KI-gepflegte Zusammenfassung aus dem Eingang (job_inbox_items). Manuell ueberschreibbar.';

create table if not exists public.job_inbox_items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  kind text not null check (kind in ('text', 'datei')),
  content text,
  file_path text,
  file_name text,
  mime_type text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  ai_status text not null default 'neu' check (ai_status in ('neu', 'verarbeitet', 'fehler')),
  ai_error text
);

create index if not exists job_inbox_items_job_idx
  on public.job_inbox_items (job_id, created_at desc);

create table if not exists public.job_zusagen (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  text text not null,
  status text not null default 'offen' check (status in ('offen', 'erledigt', 'hinfaellig')),
  mit_wem text,
  quelle_item_id uuid references public.job_inbox_items(id) on delete set null,
  created_via text not null default 'manuell' check (created_via in ('ki', 'manuell')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists job_zusagen_job_idx
  on public.job_zusagen (job_id, status, created_at desc);

alter table public.job_inbox_items enable row level security;
alter table public.job_zusagen enable row level security;

-- ── Eingang ──────────────────────────────────────────────────
drop policy if exists "jii_select" on public.job_inbox_items;
create policy "jii_select"
  on public.job_inbox_items for select to authenticated
  using (
    not public.is_partner()
    and not public.is_lieferant()
    and exists (select 1 from public.jobs j where j.id = job_inbox_items.job_id)
  );

drop policy if exists "jii_insert" on public.job_inbox_items;
create policy "jii_insert"
  on public.job_inbox_items for insert to authenticated
  with check (
    not public.is_partner()
    and not public.is_lieferant()
    and created_by = auth.uid()
    and exists (select 1 from public.jobs j where j.id = job_inbox_items.job_id)
  );

drop policy if exists "jii_update" on public.job_inbox_items;
create policy "jii_update"
  on public.job_inbox_items for update to authenticated
  using (
    not public.is_partner()
    and not public.is_lieferant()
    and (created_by = auth.uid() or public.is_admin())
  )
  with check (
    not public.is_partner()
    and not public.is_lieferant()
    and (created_by = auth.uid() or public.is_admin())
  );

drop policy if exists "jii_delete" on public.job_inbox_items;
create policy "jii_delete"
  on public.job_inbox_items for delete to authenticated
  using (
    not public.is_partner()
    and not public.is_lieferant()
    and (created_by = auth.uid() or public.is_admin())
  );

-- ── Zusagen ──────────────────────────────────────────────────
drop policy if exists "jz_select" on public.job_zusagen;
create policy "jz_select"
  on public.job_zusagen for select to authenticated
  using (
    not public.is_partner()
    and not public.is_lieferant()
    and exists (select 1 from public.jobs j where j.id = job_zusagen.job_id)
  );

drop policy if exists "jz_insert" on public.job_zusagen;
create policy "jz_insert"
  on public.job_zusagen for insert to authenticated
  with check (
    not public.is_partner()
    and not public.is_lieferant()
    and exists (select 1 from public.jobs j where j.id = job_zusagen.job_id)
  );

drop policy if exists "jz_update" on public.job_zusagen;
create policy "jz_update"
  on public.job_zusagen for update to authenticated
  using (
    not public.is_partner()
    and not public.is_lieferant()
    and exists (select 1 from public.jobs j where j.id = job_zusagen.job_id)
  )
  with check (
    not public.is_partner()
    and not public.is_lieferant()
    and exists (select 1 from public.jobs j where j.id = job_zusagen.job_id)
  );

drop policy if exists "jz_delete" on public.job_zusagen;
create policy "jz_delete"
  on public.job_zusagen for delete to authenticated
  using (
    not public.is_partner()
    and not public.is_lieferant()
    and exists (select 1 from public.jobs j where j.id = job_zusagen.job_id)
  );
