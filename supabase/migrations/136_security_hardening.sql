-- Audit-Findings Wave-B Fixes.
--
-- 1. trusted_devices: admin INSERT/UPDATE/DELETE-Policies erweitern
--    (Migration 133 fixte nur SELECT). Admin sollte fremde Devices
--    auch revoken koennen.
--
-- 2. wage_documents.source: 'manual' vs 'auto' — verhindert dass
--    Generate-Button versehentlich manuelle Bexio-PDFs ueberschreibt.
--    Generate-API muss bei existing source='manual' Confirm verlangen.
--
-- 3. Storage-Bucket lohndokumente: explizite RLS-Sperre auf
--    storage.objects damit Authenticated-User NICHT direkt downloaden
--    koennen (alles muss ueber API + Signed-URL).

-- 1) trusted_devices Admin-Verben
drop policy if exists "trusted_devices_self_revoke" on public.trusted_devices;
create policy "trusted_devices_self_revoke" on public.trusted_devices
  for update to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "trusted_devices_self_delete" on public.trusted_devices;
create policy "trusted_devices_self_delete" on public.trusted_devices
  for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- INSERT: Admin braucht's nicht (User legt eigene Devices an), aber konsistent
-- INSERT-Policy bleibt restriktiv = nur eigene.

-- 2) wage_documents.source column
alter table public.wage_documents
  add column if not exists source text default 'manual'
    check (source in ('manual', 'auto'));

-- 3) Storage-Objects-Lockdown fuer lohndokumente:
-- Verbietet authenticated/anon direkten Zugriff. Service-role (Admin-Client)
-- in den API-Routen bleibt unangetastet (laeuft als postgres-Owner).
drop policy if exists "lohndokumente_no_direct_access_select" on storage.objects;
create policy "lohndokumente_no_direct_access_select" on storage.objects
  for select to authenticated, anon
  using (bucket_id <> 'lohndokumente');

drop policy if exists "lohndokumente_no_direct_access_insert" on storage.objects;
create policy "lohndokumente_no_direct_access_insert" on storage.objects
  for insert to authenticated, anon
  with check (bucket_id <> 'lohndokumente');

drop policy if exists "lohndokumente_no_direct_access_update" on storage.objects;
create policy "lohndokumente_no_direct_access_update" on storage.objects
  for update to authenticated, anon
  using (bucket_id <> 'lohndokumente')
  with check (bucket_id <> 'lohndokumente');

drop policy if exists "lohndokumente_no_direct_access_delete" on storage.objects;
create policy "lohndokumente_no_direct_access_delete" on storage.objects
  for delete to authenticated, anon
  using (bucket_id <> 'lohndokumente');
