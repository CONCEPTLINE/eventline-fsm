-- Standort-Dokumente: raus aus dem zweckentfremdeten JSON-Feld
-- locations.technical_details, rein in die documents-Tabelle (ein
-- Datenmodell fuer alle Dokumente — Audit-Befund "zwei Wahrheiten").
--
-- Schritt 1 (diese Migration, ADDITIV): Backfill in documents + RLS-
-- Zweige fuer location_id. technical_details bleibt vorerst stehen,
-- damit der noch deployte Alt-Code weiterlaeuft; das Feld wird in
-- einer Folge-Migration geleert, sobald der neue Code live ist.

insert into public.documents (name, storage_path, created_at, folder, location_id)
select
  d->>'name',
  d->>'path',
  coalesce(nullif(d->>'uploaded_at', '')::timestamptz, now()),
  nullif(d->>'folder', ''),
  l.id
from public.locations l
cross join lateral jsonb_array_elements(l.technical_details::jsonb) as d
where l.technical_details like '[%'
  and coalesce(d->>'path', '') <> ''
  and not exists (select 1 from public.documents x where x.storage_path = d->>'path');

-- RLS: Standort-Dokumente sichtbar/pflegbar fuer interne mit
-- Location-Sicht (locations-RLS erbt via EXISTS), Portal-User aussen vor.
drop policy if exists "documents_select" on public.documents;
create policy "documents_select" on public.documents for select using (
  uploaded_by = (select auth.uid())
  or (select public.is_admin())
  or (job_id is not null and exists (select 1 from public.jobs j where j.id = documents.job_id))
  or (project_id is not null
      and not (select public.is_portal_user())
      and exists (select 1 from public.projects p where p.id = documents.project_id))
  or (location_id is not null
      and not (select public.is_portal_user())
      and exists (select 1 from public.locations l where l.id = documents.location_id))
);

drop policy if exists "documents_update_folder_staff" on public.documents;
create policy "documents_update_folder_staff" on public.documents for update
using (
  not (select public.is_portal_user())
  and (uploaded_by = (select auth.uid()) or (select public.is_admin())
       or (job_id is not null and exists (select 1 from public.jobs j where j.id = documents.job_id))
       or (project_id is not null and exists (select 1 from public.projects p where p.id = documents.project_id))
       or (location_id is not null and exists (select 1 from public.locations l where l.id = documents.location_id)))
)
with check (
  not (select public.is_portal_user())
  and (uploaded_by = (select auth.uid()) or (select public.is_admin())
       or (job_id is not null and exists (select 1 from public.jobs j where j.id = documents.job_id))
       or (project_id is not null and exists (select 1 from public.projects p where p.id = documents.project_id))
       or (location_id is not null and exists (select 1 from public.locations l where l.id = documents.location_id)))
);

-- Loeschen von Standort-Dokumenten: locations:edit (Admins via Bypass).
drop policy if exists "documents_delete_location" on public.documents;
create policy "documents_delete_location" on public.documents for delete using (
  location_id is not null
  and not (select public.is_portal_user())
  and (select public.has_permission('locations:edit'))
);
