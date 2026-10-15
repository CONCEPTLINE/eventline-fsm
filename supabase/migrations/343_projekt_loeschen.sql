-- 343 — «Projekt löschen» repariert (Leo 2026-10-15: «Projekt löschen
-- funktioniert seit Längerem nicht»).
--
-- URSACHE: Der Löschen-Knopf setzte projects.is_deleted = true per direktem
-- UPDATE (supabase.from('projects').update({ is_deleted: true }).eq('id', …)).
-- Die SELECT-Policy projects_select blendet gelöschte Projekte aus
-- (not is_deleted). Liest ein UPDATE Spalten der Tabelle (hier WHERE id = …),
-- prüft Postgres die SELECT-Policies auch gegen die NEUE Zeile — die
-- gelöschte Zeile wäre unsichtbar, also wird das UPDATE abgelehnt:
-- «new row violates row-level security policy for table "projects"» (42501).
-- Das traf jeden, auch Admins; seit Migration 186 wurde nie ein Projekt
-- gelöscht. (Aufträge, Entwürfe und Todos betrifft das nicht — ihre
-- SELECT-Policies blenden Gelöschtes nicht aus; Kunden und Locations haben
-- kein Soft-Delete, sondern Archiv + echtes Löschen.)
--
-- FIX: Soft-Delete über die SECURITY-DEFINER-Funktion projekt_loeschen()
-- (Muster cancel_project, Migration 189). Sie prüft selbst:
--   * internes, aktives Konto (keine Portal-Konten),
--   * Recht projekte:approve — dasselbe Recht, das den Knopf zeigt
--     (src/app/(app)/projekte/[id]/page.tsx); Admins via has_permission,
--   * Archiv = nur lesen (Migration 342, src/lib/archiv.ts): abgeschlossene,
--     abgelehnte und stornierte Projekte bleiben stehen (PT409 → HTTP 409,
--     gleiche Meldung wie die DB-Sperre).
-- projects_select bleibt unverändert: gelöschte Projekte sind für alle
-- unsichtbar, Zeit-Einträge bleiben in der Historie.
--
-- RECHTE KONSISTENT, alle 4 Verben über has_permission (Admins automatisch)
-- statt is_admin():
--   SELECT  unverändert (nicht gelöscht, keine Portal-Konten)
--   INSERT  internes Konto; direkt anlegen (genehmigt, mit Budget) =
--           projekte:approve wie /projekte/neu, sonst eigener Entwurf/Antrag
--   UPDATE  internes Konto, Beteiligte wie bisher; is_deleted lässt sich
--           direkt nicht mehr setzen (Löschen nur über projekt_loeschen)
--   DELETE  (hart, ohne Oberfläche) internes Konto + projekte:approve, nur
--           nicht archivierte Projekte
-- Idempotent: create or replace / drop policy if exists.

-- ─── Soft-Delete ───────────────────────────────────────────────────────────
create or replace function public.projekt_loeschen(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status    text;
  v_geloescht boolean;
begin
  if not (public.is_internal_user() and public.has_permission('projekte:approve')) then
    raise exception using errcode = '42501', message = 'Keine Berechtigung, Projekte zu löschen.';
  end if;

  select p.status, p.is_deleted into v_status, v_geloescht
    from public.projects p
   where p.id = p_project_id
     for update;
  if not found or v_geloescht then
    raise exception using errcode = 'PT404', message = 'Projekt nicht gefunden.';
  end if;

  -- Archiv = nur lesen (Migration 342) — gleiche Meldung wie die DB-Sperre.
  if v_status in ('abgeschlossen', 'abgelehnt', 'storniert') then
    raise exception using errcode = 'PT409',
      message = 'Das Projekt ist archiviert (abgeschlossen, abgelehnt oder storniert) und kann nur noch gelesen werden.';
  end if;

  update public.projects set is_deleted = true where id = p_project_id;
end;
$$;

comment on function public.projekt_loeschen(uuid) is
  'Projekt löschen (Soft-Delete, is_deleted = true). Berechtigt: projekte:approve (Admins automatisch). Archivierte Projekte (abgeschlossen/abgelehnt/storniert) bleiben stehen (PT409). Migration 343.';

revoke all on function public.projekt_loeschen(uuid) from public, anon;
grant execute on function public.projekt_loeschen(uuid) to authenticated;

-- ─── Policies auf projects ─────────────────────────────────────────────────
drop policy if exists "projects_insert" on public.projects;
create policy "projects_insert" on public.projects
  for insert to authenticated
  with check (
    (select public.is_internal_user())
    and (
      (select public.has_permission('projekte:approve'))
      or (
        created_by = (select auth.uid())
        and assigned_to = (select auth.uid())
        and status in ('entwurf', 'angefragt')
        and budget_hours is null
        and approved_by is null
      )
    )
  );

drop policy if exists "projects_update" on public.projects;
create policy "projects_update" on public.projects
  for update to authenticated
  using (
    (select public.is_internal_user())
    and not is_deleted
    and ((select public.has_permission('projekte:approve'))
      or created_by = (select auth.uid())
      or assigned_to = (select auth.uid())
      or exists (select 1 from public.project_members pm
                 where pm.project_id = projects.id and pm.user_id = (select auth.uid())))
  )
  with check (
    (select public.is_internal_user())
    and is_deleted = false
    and ((select public.has_permission('projekte:approve'))
      or created_by = (select auth.uid())
      or assigned_to = (select auth.uid())
      or exists (select 1 from public.project_members pm
                 where pm.project_id = projects.id and pm.user_id = (select auth.uid())))
  );

drop policy if exists "projects_delete" on public.projects;
create policy "projects_delete" on public.projects
  for delete to authenticated
  using (
    (select public.is_internal_user())
    and (select public.has_permission('projekte:approve'))
    and status not in ('abgeschlossen', 'abgelehnt', 'storniert')
  );
