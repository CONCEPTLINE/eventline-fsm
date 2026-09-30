-- 278: Umbenennungs-Auftraege fuer Bestandsdateien auf dem NAS
-- (Leo 2026-09-30: falsch benannte Alt-Dokumente sollen nach Beschrieb
-- ins Namensschema umbenannt werden). Der Sync-Client holt die Liste
-- ueber die Abhol-API, benennt physisch um (nie ueberschreiben) und
-- bestaetigt — dann wird der Datei-Index nachgezogen.

create table if not exists ablage_renames (
  id uuid primary key default gen_random_uuid(),
  pfad text not null unique,     -- aktueller relativer Vollpfad
  neuer_name text not null,      -- nur der neue Dateiname (kein Pfad)
  created_at timestamptz not null default now()
);

alter table ablage_renames enable row level security;

drop policy if exists ablage_renames_select on ablage_renames;
create policy ablage_renames_select on ablage_renames
  for select using ((select is_admin()));
drop policy if exists ablage_renames_insert on ablage_renames;
create policy ablage_renames_insert on ablage_renames
  for insert with check ((select is_admin()));
drop policy if exists ablage_renames_update on ablage_renames;
create policy ablage_renames_update on ablage_renames
  for update using ((select is_admin()));
drop policy if exists ablage_renames_delete on ablage_renames;
create policy ablage_renames_delete on ablage_renames
  for delete using ((select is_admin()));
