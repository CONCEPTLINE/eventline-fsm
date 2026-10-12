-- 309_documents_portal_grenzen.sql — Bucket documents: Portal-Konten raus
--
-- Datum: 2026-10-12. Nacharbeit zu 307 (Storage-Sperre private Buckets).
--
-- Luecke: Die 4 Policies «auth users read/insert/update/delete documents»
-- pruefen nur bucket_id = 'documents'. Damit kann JEDES angemeldete Konto
-- alle Dateien im Bucket lesen, hochladen, ueberschreiben und loeschen —
-- auch die externen Partner- und Lieferanten-Portal-Konten (geprueft per
-- SET LOCAL ROLE authenticated + Claims: jedes Portal-Konto sah alle 1086
-- Dateien: Rechnungen, Offerten, Rapporte, Unterschriften, Lieferanten-
-- Kataloge, Standortplaene, Eingang usw.).
--
-- Wer braucht was (Code-Analyse main, 2026-10-12):
--   * Interne Rollen (admin, projekt-leiter, team-leiter, techniker, vertrieb,
--     temporar): Hochladen, Lesen, Ueberschreiben, Loeschen im Browser
--     (Rapport-Fotos/Unterschriften inkl. Offline-Outbox mit upsert:true ->
--     UPDATE noetig; Standort-Plaene, Tickets, Todos, Auftrags-Eingang,
--     Doku-Verlauf, Lieferanten-Katalog in den Einstellungen). -> unveraendert.
--   * Lieferant: NULL Storage-Zugriff. Das Lieferantenportal laeuft komplett
--     ueber /api/lieferant/* (Admin-Client nach requireLieferantPortal).
--   * Partner: nur LESEN (createSignedUrl in partner/(portal)/anfragen/[id]):
--     die eigenen Anfrage-Anhaenge UND die Dokumente, die EVENTLINE an seine
--     Auftraege gehaengt hat (Vertraege, Offerten, Rechnungen, Rapporte —
--     bewusst so gebaut in Migration 101, documents_select_partner). Die
--     Seite listet alle documents-Zeilen des Auftrags. Hochladen laeuft ueber
--     /api/upload (Admin-Client) -> kein Storage-INSERT-Recht noetig.
--
-- ABHAENGIGKEIT (vor oder zusammen mit 309 live bringen):
--   Anfrage zurueckziehen: Heute ruft der Browser partner_withdraw_anfrage
--   (loescht Auftrag + documents-Zeilen, liefert die storage_paths) und danach
--   storage.from('documents').remove(paths) MIT dem Partner-Konto. Vor 309
--   klappt das (offene DELETE-Policy). Nach 309 darf ein Partner im Bucket
--   nichts mehr loeschen -> remove() loescht still nichts, die Anhaenge
--   blieben verwaist liegen. Deshalb muss das Zurueckziehen in die Server-
--   Route POST /api/partner/anfragen/[id]/zurueckziehen: RPC mit dem Nutzer-
--   Client (Status-/Standort-Pruefung bleibt), danach Admin-Client remove()
--   NUR fuer Pfade mit Praefix 'partner-anfragen/<jobId>/'.
--   Ebenfalls Code (nicht Teil dieser Datei): /api/upload Portal-Konten auf
--   'partner-anfragen/<sichtbarer jobId>/' begrenzen, Lieferant sperren;
--   /api/lieferant/anfragen/[jobId]/angebot nur 'jobs/<jobId>/' signieren.
--
-- Fix:
--   1) Helfer is_internal_user(): Profil mit Nicht-Portal-Rolle. Positiv-
--      Pruefung statt «not is_portal_user()», damit ein Konto ohne Profil
--      oder mit unbekannter Rolle NICHT als intern durchrutscht. Heute haben
--      alle Konten ein Profil mit gueltiger Rolle -> fuer bestehende interne
--      Konten identisch. Prueft bewusst NICHT is_active (wie bisher: inaktive
--      interne Konten behalten Zugriff; offener Entscheid fuer Leo).
--   2) Partner-Zweig (in Grenze UND Select-Policy gleich, bewusst inline
--      statt Hilfsfunktion: eine SQL-Funktion mit Unterabfragen bettet der
--      Planer nicht ein -> gemessen ~470 ms statt 10-45 ms je Bucket-Scan).
--      Die Unterabfragen laufen mit der RLS des Partners (jobs_select ->
--      eigener Standort, documents_select -> Dokumente seiner Auftraege).
--      Lesbar ist
--        a) partner-anfragen/<jobId>/… eines sichtbaren Auftrags,
--        b) ODER eine Datei, auf die eine sichtbare documents-Zeile mit
--           job_id zeigt (Dokumente seiner Auftraege, auch von EVENTLINE).
--      Zu b): Eine Zeile, die ein Portal-Konto angelegt hat, gibt nur ihren
--      eigenen Anfrage-Ordner frei (partner-anfragen/<job_id>/…), nie einen
--      fremden Pfad. Nach 309 koennen Portal-Konten ohnehin keine Zeile mit
--      fremdem storage_path mehr anlegen (Punkt 5) oder aendern
--      (documents_update_folder_staff schliesst Portal-Konten aus); bestehende
--      Portal-Zeilen mit fremdem Pfad: 0 (geprueft 2026-10-12). profiles und
--      roles sind fuer alle angemeldeten Konten lesbar -> die Pruefung
--      greift auch unter der RLS des Partners. Neuer Index
--      documents(storage_path) fuer die Zeilen-Suche.
--   3) RESTRICTIVE Grenze storage_documents_grenze (Muster 307, mit UND
--      verknuepft): Lesen nur intern oder aktiver Partner fuer Dateien nach
--      Punkt 2, Schreiben/Ueberschreiben/Loeschen nur intern. Damit kann
--      auch eine kuenftige erlaubende Policy ohne Rollenfilter den Bucket
--      fuer Lieferant/anon gar nicht und fuer Partner nur fuer seine
--      Auftrags-Dateien oeffnen.
--   4) Die 4 «auth users … documents»-Policies durch 4 neue ersetzen
--      (storage_documents_select/insert/update/delete; Praefix storage_,
--      damit sie nicht mit den gleichnamigen Policies auf public.documents
--      verwechselt werden): intern alles wie bisher; Partner nur SELECT auf
--      die Dateien nach Punkt 2.
--   5) public.documents INSERT fuer Portal-Konten schliessen:
--      «Benutzer können Dokumente hochladen» nur noch fuer interne Konten.
--      Partner legen Zeilen nur ueber documents_insert_partner an, jetzt
--      zusaetzlich mit storage_path = 'partner-anfragen/<job_id>/…' (ohne
--      '..'). Lieferanten legen keine Zeilen mit dem Nutzer-Client an (das
--      Lieferantenportal schreibt per Admin-Client). Damit kann kein Portal-
--      Konto mehr eine Zeile mit fremdem storage_path anlegen, die eine
--      Server-Route (Admin-Client) danach signieren wuerde.
--
-- Nicht betroffen: service_role (Admin-Client in allen /api-Routen) umgeht RLS;
-- signierte URLs werden vom Storage-Dienst geprueft. Die anderen Buckets
-- bleiben unveraendert (307 + ihre eigenen Policies).
--   6) partner_withdraw_anfrage haerten (die Route POST /api/partner/
--      anfragen/[id]/zurueckziehen loescht danach mit dem Admin-Client die
--      Anhaenge -> die RPC ist das einzige Tor): Besitzpruefung NULL-fest
--      (vorher liess created_by/location_id = NULL die Pruefung still
--      passieren), is_partner() statt role = 'partner' (prueft is_active),
--      Recht partner:anfragen:delete wie documents_delete, Auftrag FOR UPDATE
--      sperren (Wettlauf mit EVENTLINE-Annahme). Meldungen unveraendert
--      (die Route bildet sie auf Klartext ab).
--
-- Idempotent: create or replace / drop … if exists, Policies neu angelegt.
-- NUR ALS DATEI — Einspielen: node scripts/apply-migration.mjs supabase/migrations/309_documents_portal_grenzen.sql
-- Ruecksetzen: Gegenstueck mit den alten Policies (siehe Ende der Datei).
--
-- Nachpruefung nach dem Einspielen (read-only, je Konto Claims setzen):
--   begin read only;
--     select set_config('request.jwt.claims', json_build_object('sub','<uuid>','role','authenticated')::text, true);
--     set local role authenticated;
--     select split_part(name,'/',1), count(*) from storage.objects where bucket_id='documents' group by 1;
--   rollback;
--   Erwartet (Stand 2026-10-12): intern 1086 (wie vorher), Partner nur
--   Dateien seiner Standort-Auftraege (partner-anfragen/ + die per documents-
--   Zeile verknuepften jobs/, rapporte/, auftraege/ …), Lieferant 0, anon 0.

-- 1) Helfer ------------------------------------------------------------------
create or replace function public.is_internal_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    join public.roles r on r.slug = p.role
    where p.id = auth.uid() and not r.is_portal
  );
$$;
-- Ausfuehrbar bleibt sie fuer anon (Standard-Grant, wie is_portal_user): die
-- restriktive Policy gilt auch fuer anon und wuerde sonst JEDE anon-Abfrage
-- auf storage.objects mit «permission denied» abbrechen. Fuer anon liefert sie
-- false (auth.uid() ist null).

-- 2) Index fuer die Zeilen-Suche (documents.storage_path = objects.name) ------
create index if not exists documents_storage_path_idx on public.documents (storage_path);

-- 3) Restriktive Grenze zuerst (engt nur ein, nie aus) -----------------------
-- Partner-Zweig a) Anfrage-Ordner eines sichtbaren Auftrags, b) Datei einer
-- sichtbaren documents-Zeile seines Auftrags (siehe Kopf, Punkt 2). Identisch
-- in storage_documents_select — bei Aenderungen beide anpassen. Immer
-- storage.objects.name voll qualifizieren: public.documents hat selbst eine
-- Spalte «name», ein nacktes name in der Unterabfrage waere d.name.
drop policy if exists "storage_documents_grenze" on storage.objects;
create policy "storage_documents_grenze" on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (
    bucket_id <> 'documents'
    or (select public.is_internal_user())
    or (
      (select public.is_partner())
      and (
    (
          split_part(storage.objects.name, '/', 1) = 'partner-anfragen'
          and exists (
            select 1 from public.jobs j
            where j.id = case
              when split_part(storage.objects.name, '/', 2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(storage.objects.name, '/', 2)::uuid
            end
          )
        )
        or exists (
          select 1
          from public.documents d
          join public.jobs j on j.id = d.job_id
          left join public.profiles up on up.id = d.uploaded_by
          left join public.roles r on r.slug = up.role
          where d.storage_path = storage.objects.name
            and (
              r.is_portal is not true
              or (
                d.storage_path like 'partner-anfragen/' || d.job_id::text || '/%'
                and position('..' in d.storage_path) = 0
              )
            )
        )
      )
    )
  )
  with check (
    bucket_id <> 'documents'
    or (select public.is_internal_user())
  );

-- 4) Die 4 offenen Storage-Policies ersetzen ---------------------------------
drop policy if exists "auth users read documents"   on storage.objects;
drop policy if exists "auth users insert documents" on storage.objects;
drop policy if exists "auth users update documents" on storage.objects;
drop policy if exists "auth users delete documents" on storage.objects;

drop policy if exists "storage_documents_select" on storage.objects;
create policy "storage_documents_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and (
      (select public.is_internal_user())
      or (
        (select public.is_partner())
        and (
      (
            split_part(storage.objects.name, '/', 1) = 'partner-anfragen'
            and exists (
              select 1 from public.jobs j
              where j.id = case
                when split_part(storage.objects.name, '/', 2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then split_part(storage.objects.name, '/', 2)::uuid
              end
            )
          )
          or exists (
            select 1
            from public.documents d
            join public.jobs j on j.id = d.job_id
            left join public.profiles up on up.id = d.uploaded_by
            left join public.roles r on r.slug = up.role
            where d.storage_path = storage.objects.name
              and (
                r.is_portal is not true
                or (
                  d.storage_path like 'partner-anfragen/' || d.job_id::text || '/%'
                  and position('..' in d.storage_path) = 0
                )
              )
          )
        )
      )
    )
  );

drop policy if exists "storage_documents_insert" on storage.objects;
create policy "storage_documents_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documents' and (select public.is_internal_user()));

drop policy if exists "storage_documents_update" on storage.objects;
create policy "storage_documents_update" on storage.objects
  for update to authenticated
  using      (bucket_id = 'documents' and (select public.is_internal_user()))
  with check (bucket_id = 'documents' and (select public.is_internal_user()));

drop policy if exists "storage_documents_delete" on storage.objects;
create policy "storage_documents_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'documents' and (select public.is_internal_user()));

-- 5) public.documents: INSERT fuer Portal-Konten schliessen -------------------
drop policy if exists "Benutzer können Dokumente hochladen" on public.documents;
create policy "Benutzer können Dokumente hochladen" on public.documents
  for insert to authenticated
  with check (
    uploaded_by = (select auth.uid())
    and (select public.is_internal_user())
  );

drop policy if exists "documents_insert_partner" on public.documents;
create policy "documents_insert_partner" on public.documents
  for insert to public
  with check (
    (select public.is_admin_or_lead())
    or (
      uploaded_by = (select auth.uid())
      and (select public.is_partner())
      and job_id is not null
      and storage_path like 'partner-anfragen/' || job_id::text || '/%'
      and position('..' in storage_path) = 0
      and exists (
        select 1
        from public.jobs j
        join public.profiles p on p.id = (select auth.uid())
        where j.id = documents.job_id
          and j.status = any (array['partner_anfrage', 'partner_entwurf', 'offen'])
          and p.partner_location_id is not null
          and p.partner_location_id = j.location_id
      )
      and (select public.has_permission('partner:anfragen:edit'))
    )
  );

-- 6) partner_withdraw_anfrage haerten ----------------------------------------
create or replace function public.partner_withdraw_anfrage(p_job_id uuid)
returns table(storage_paths text[])
language plpgsql security definer set search_path = public as $$
declare
  v_caller_loc uuid;
  v_job_status text;
  v_job_creator uuid;
  v_job_location uuid;
  v_paths text[];
begin
  -- Aktiver Partner (is_partner prueft is_active) mit Loesch-Recht
  if not public.is_partner() then
    raise exception 'forbidden: only partner role can withdraw anfragen';
  end if;
  if not public.has_permission('partner:anfragen:delete') then
    raise exception 'forbidden: missing permission partner:anfragen:delete';
  end if;

  select partner_location_id into v_caller_loc
  from public.profiles where id = auth.uid();

  -- Sperre gegen gleichzeitige Annahme durch EVENTLINE
  select status, created_by, location_id
  into v_job_status, v_job_creator, v_job_location
  from public.jobs where id = p_job_id
  for update;

  if not found then
    raise exception 'job not found';
  end if;

  -- NULL-fest: nur Ersteller ODER gleicher Standort (beide Seiten gesetzt)
  if not (coalesce(v_job_creator = auth.uid(), false)
          or coalesce(v_caller_loc = v_job_location, false)) then
    raise exception 'forbidden: not your job';
  end if;

  -- Nur in den Pre-Accept-Status zurueckziehbar
  if v_job_status not in ('partner_entwurf', 'partner_anfrage') then
    raise exception 'cannot withdraw job in status %', v_job_status;
  end if;

  -- Storage-Paths fuer das Aufraeumen (Server-Route) zurueckgeben
  select array_agg(storage_path) into v_paths
  from public.documents where job_id = p_job_id;

  -- Cascade: documents, appointments, dann job. Status-Guard greift nicht
  -- bei DELETE (BEFORE UPDATE only).
  delete from public.documents where job_id = p_job_id;
  delete from public.job_appointments where job_id = p_job_id;
  delete from public.jobs where id = p_job_id;

  return query select coalesce(v_paths, array[]::text[]);
end;
$$;

-- Ruecksetzen (nur im Notfall, stellt den offenen Stand vor 309 wieder her;
-- ausfuehrlich mit Pruefung: scratchpad ruecksetzen.sql):
--   drop policy if exists "storage_documents_grenze" on storage.objects;
--   drop policy if exists "storage_documents_select" on storage.objects;
--   drop policy if exists "storage_documents_insert" on storage.objects;
--   drop policy if exists "storage_documents_update" on storage.objects;
--   drop policy if exists "storage_documents_delete" on storage.objects;
--   (Index documents_storage_path_idx und die gehaertete RPC partner_withdraw_
--   anfrage koennen bleiben — sie schraenken nichts Gewolltes ein.)
--   create policy "auth users read documents"   on storage.objects for select to authenticated using (bucket_id = 'documents');
--   create policy "auth users insert documents" on storage.objects for insert to authenticated with check (bucket_id = 'documents');
--   create policy "auth users update documents" on storage.objects for update to authenticated using (bucket_id = 'documents');
--   create policy "auth users delete documents" on storage.objects for delete to authenticated using (bucket_id = 'documents');
--   drop policy if exists "Benutzer können Dokumente hochladen" on public.documents;
--   create policy "Benutzer können Dokumente hochladen" on public.documents for insert to authenticated
--     with check (uploaded_by = (select auth.uid()));
--   drop policy if exists "documents_insert_partner" on public.documents;
--   create policy "documents_insert_partner" on public.documents for insert to public with check (
--     (select is_admin_or_lead()) or ((uploaded_by = (select auth.uid())) and (select is_partner())
--     and exists (select 1 from jobs j join profiles p on p.id = (select auth.uid())
--       where j.id = documents.job_id and j.status = any (array['partner_anfrage','partner_entwurf','offen'])
--       and p.partner_location_id is not null and p.partner_location_id = j.location_id)
--     and (select has_permission('partner:anfragen:edit'))));
