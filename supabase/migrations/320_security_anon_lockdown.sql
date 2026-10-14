-- 320_security_anon_lockdown.sql
-- Sicherheits-Haertung: anonyme (nicht eingeloggte) Lesezugriffe schliessen.
--
-- Hintergrund (Sicherheits-Pruefung 2026-10-14): Die App sperrt sensible
-- Objekte sonst explizit mit `revoke ... from public, anon`. Supabase gibt
-- per Default aber anon + authenticated SELECT auf alle public-Tabellen/Views
-- und EXECUTE auf alle public-Routinen. Objekte OHNE solchen Revoke, deren
-- RLS-Policy zudem kein `TO authenticated` traegt (-> Default `TO public`,
-- schliesst anon ein), waren damit OHNE Login lesbar. Verschaerfend:
-- public.is_portal_user() liefert fuer anon `false` (auth.uid() ist null),
-- sodass jede `not is_portal_user()`-Huerde fuer anon durchfaellt.
--
-- Betroffen (von aussen ohne Login lesbar): projects, documents (Metadaten),
-- v_location_rate_tiers_current (CHF-Stundensaetze), get_assignable_users()
-- und get_anwesenheit_users() (interne Mitarbeiterliste + Rollen).
--
-- Diese Migration ist additiv + idempotent. Sie aendert KEINEN legitimen
-- Zugriff eingeloggter Nutzer: betroffen ist ausschliesslich die anon-Rolle.
-- ALTER POLICY aendert nur die Rollen-Liste; die USING-Ausdruecke bleiben 1:1.

-- 1) projects: SELECT-Policy war `TO public` -> nur noch authenticated.
--    USING ((not is_deleted) and not is_portal_user()) bleibt unveraendert.
alter policy "projects_select" on public.projects to authenticated;

-- 2) documents: SELECT-Policy war `TO public` -> nur noch authenticated.
--    Die job_id/project_id/location_id-Zweige bleiben inhaltlich unveraendert
--    (interne Nutzer sehen weiterhin dieselben Dokument-Metadaten wie bisher).
alter policy "documents_select" on public.documents to authenticated;

-- 3) v_location_rate_tiers_current: definer-rechte View umging die RLS der
--    Basis-Tabellen (die korrekt `TO authenticated` sind). security_invoker=on
--    laesst die View mit den Rechten des Aufrufers laufen -> anon sieht nichts,
--    eingeloggte Nutzer sehen ihre Tarife unveraendert. Zusaetzlich anon-Grant weg.
alter view public.v_location_rate_tiers_current set (security_invoker = on);
revoke select on public.v_location_rate_tiers_current from anon;

-- 4) RPCs (SECURITY DEFINER) ohne auth.uid()-Huerde, die die interne
--    Mitarbeiterliste zurueckgeben. EXECUTE kam via PUBLIC-Default (deshalb
--    reicht `revoke from anon` allein NICHT - anon erbt via PUBLIC). Also
--    PUBLIC-Grant entziehen und gezielt den berechtigten Rollen neu geben.
revoke execute on function public.get_assignable_users() from public, anon;
grant  execute on function public.get_assignable_users() to authenticated, service_role;

revoke execute on function public.get_anwesenheit_users() from public, anon;
grant  execute on function public.get_anwesenheit_users() to authenticated, service_role;

-- 5) Defense-in-depth: aktuell schon self-guarded (auth.uid()-Check gibt anon
--    leere Liste), aber ebenfalls nicht fuer anon aufrufbar machen.
revoke execute on function public.get_anwesenheit_abwesenheiten(date, date) from public, anon;
grant  execute on function public.get_anwesenheit_abwesenheiten(date, date) to authenticated, service_role;
