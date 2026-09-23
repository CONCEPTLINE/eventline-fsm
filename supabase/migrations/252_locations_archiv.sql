-- Locations archivierbar mit Begruendung — gleiches Prinzip wie das
-- Auftrags-Stornieren (cancelled_at/by/reason): Zwei-Phasen-Modal mit
-- Pflicht-Grund, Badge + Grund am Detail sichtbar, reversibel.
-- Archivieren spiegelt zusaetzlich is_active=false, damit archivierte
-- Standorte app-weit aus allen Auswahllisten verschwinden (die filtern
-- bereits auf is_active).

alter table public.locations
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references auth.users(id),
  add column if not exists archived_reason text;

-- Update-Policy um das Archiv-Recht erweitern (Client-Update wie beim
-- Storno; has_permission() deckt Admins mit ab).
drop policy if exists "locations_update" on public.locations;
create policy "locations_update" on public.locations
  for update
  using (has_permission('locations:edit') or has_permission('locations:archive'))
  with check (has_permission('locations:edit') or has_permission('locations:archive'));
