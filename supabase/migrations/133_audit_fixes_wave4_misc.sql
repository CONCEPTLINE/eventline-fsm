-- Audit Wave 4: kleinere Cleanups.
--
-- 1. trusted_devices SELECT-policy nutzt has_permission('admin:audit') —
--    dieser Permission-Slug existiert aber in keinem Rollen-Set, also
--    fiel die Klausel immer auf FALSE. Admins konnten daher KEINE
--    Trust-Devices anderer User sehen, obwohl das gewollt war. Fix:
--    direkter is_admin()-Check.

drop policy if exists "trusted_devices_self_select" on public.trusted_devices;
create policy "trusted_devices_self_select"
  on public.trusted_devices
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());
