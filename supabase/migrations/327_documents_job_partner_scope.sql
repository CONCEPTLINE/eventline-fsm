-- 327_documents_job_partner_scope.sql
-- (urspruenglich als 326 geschrieben + eingespielt; umbenannt wegen Kollision
-- mit 326_finanzen.sql einer parallelen Session — die DB-Aenderung selbst
-- ist bereits korrekt live, nur die Datei wird fuer die Reihenfolge angepasst)
-- Haertung (optionaler Befund aus dem Pentest 2026-10-14): documents_select
-- liess den job_id-Zweig OHNE Standort-Pruefung durch — jeder eingeloggte
-- Portal-Account (Partner, Lieferant) konnte per .eq("job_id", <beliebige-ID>)
-- oder sogar per blossem select=* Dokument-Metadaten (Name, storage_path,
-- Uploader) JEDES Auftrags lesen, nicht nur der eigenen. Migration 309 (Storage-
-- Ebene) ging bereits faelschlich davon aus, dass diese Tabelle schon auf
-- "sichtbare Auftraege" scopt ("documents_select -> Dokumente seiner
-- Auftraege") — das war nie der Fall.
--
-- Fix: der job_id-Zweig bekommt dieselbe Standort-Pruefung wie jobs_select
-- (257_rls_sweep.sql) fuer Partner: nur wenn der eigene partner_location_id
-- zum location_id des Auftrags passt. Interne Nutzer (not is_portal_user())
-- sind unveraendert — das war schon immer der Haupt-Nutzungsfall (jobuebergreifende
-- Sicht fuers Team) und bleibt so. Lieferant bekommt ueber diesen Zweig weiterhin
-- NICHTS (das Lieferantenportal liest Dokumente ausschliesslich ueber
-- /api/lieferant/* mit dem Admin-Client, nie direkt per RLS-Client — siehe 309).
-- Bewusst OHNE zusaetzlichen has_permission-Gate: das hier ist die Mandanten-
-- Grenze (eigene Firma/eigener Standort), keine Feature-Berechtigung — die
-- Partner-Anfragen-Seite braucht z.B. nur partner:anfragen:*, nicht
-- partner:auftraege:view/belegungsplan:view wie jobs_select.
--
-- Idempotent + additiv. Aendert NICHTS an project_id/location_id-Zweigen
-- (schon korrekt mit not is_portal_user() gesperrt) und nichts an
-- documents_update_folder_staff (schon komplett portal-gesperrt).
--
-- WICHTIG: Migration 320 hatte documents_select per ALTER POLICY auf
-- "to authenticated" eingeschraenkt (anon-Lockdown). Diese Migration ersetzt
-- die Policy komplett (DROP+CREATE, da die USING-Klausel sich aendert) --
-- "to authenticated" MUSS hier explizit wieder gesetzt werden, sonst faellt
-- die Rolle auf den Default PUBLIC zurueck und der anon-Fix waere weg.

drop policy if exists "documents_select" on public.documents;
create policy "documents_select" on public.documents for select to authenticated using (
  uploaded_by = (select auth.uid())
  or (select public.is_admin())
  or (job_id is not null and exists (
        select 1 from public.jobs j
        where j.id = documents.job_id
          and (
            not (select public.is_portal_user())
            or (
              (select public.is_partner())
              and exists (
                select 1 from public.profiles p
                where p.id = (select auth.uid())
                  and p.partner_location_id is not null
                  and p.partner_location_id = j.location_id
              )
            )
          )
      ))
  or (project_id is not null
      and not (select public.is_portal_user())
      and exists (select 1 from public.projects p where p.id = documents.project_id))
  or (location_id is not null
      and not (select public.is_portal_user())
      and exists (select 1 from public.locations l where l.id = documents.location_id))
);
