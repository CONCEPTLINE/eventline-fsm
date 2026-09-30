-- 279: Datei-Abrufe vom NAS (Leo 2026-09-30) — Klick auf ein Dokument
-- im FSM soll es direkt oeffnen/herunterladen. Ablauf:
--   1. Admin klickt -> Zeile status='wartet'
--   2. Sync-Client sieht den Abruf (Abhol-API liefert signierte
--      Upload-URL), laedt die Datei vom NAS in den Uebergabe-Bucket
--      (abrufe/<id>) und bestaetigt -> status='bereit'
--   3. FSM-UI pollt, holt die signierte Download-URL, Browser laedt.
--   Housekeeping: Abrufe aelter 1h raeumt die Abhol-API weg (Bucket+Zeile).

create table if not exists ablage_abrufe (
  id uuid primary key default gen_random_uuid(),
  pfad text not null,
  status text not null default 'wartet' check (status in ('wartet', 'bereit', 'fehler')),
  fehler text,
  storage_path text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references profiles(id)
);

alter table ablage_abrufe enable row level security;

drop policy if exists ablage_abrufe_select on ablage_abrufe;
create policy ablage_abrufe_select on ablage_abrufe
  for select using ((select is_admin()));
drop policy if exists ablage_abrufe_insert on ablage_abrufe;
create policy ablage_abrufe_insert on ablage_abrufe
  for insert with check ((select is_admin()));
drop policy if exists ablage_abrufe_update on ablage_abrufe;
create policy ablage_abrufe_update on ablage_abrufe
  for update using ((select is_admin()));
drop policy if exists ablage_abrufe_delete on ablage_abrufe;
create policy ablage_abrufe_delete on ablage_abrufe
  for delete using ((select is_admin()));
