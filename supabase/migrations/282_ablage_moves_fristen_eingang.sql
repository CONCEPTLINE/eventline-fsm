-- 282: Drei NAS-Ausbauten (Leo 2026-10-02)
--
-- a) ablage_moves: Verschiebe-Auftraege fuer den Sync-Client (Datei ->
--    anderer Ordner bzw. Papierkorb 99_System/Papierkorb; Client macht
--    mkdir -p + rename, nie ueberschreiben). Muster wie ablage_renames.
-- b) Fristen-Waechter: ablage_items.frist (z.B. Kuendigungstermin) +
--    erinnert-Stufen; taeglicher Cron mailt Admins 30/7/0 Tage vorher.
-- c) ablage_eingang: per Mail an die Ablage geschickte Anhaenge warten
--    hier, bis sie im Ablage-Tab uebernommen werden.

create table if not exists ablage_moves (
  id uuid primary key default gen_random_uuid(),
  pfad text not null unique,        -- aktueller relativer Vollpfad
  ziel_ordner text not null,        -- Zielordner (relativ, ohne Dateiname)
  created_at timestamptz not null default now()
);
alter table ablage_moves enable row level security;
drop policy if exists ablage_moves_select on ablage_moves;
create policy ablage_moves_select on ablage_moves for select using ((select is_admin()));
drop policy if exists ablage_moves_insert on ablage_moves;
create policy ablage_moves_insert on ablage_moves for insert with check ((select is_admin()));
drop policy if exists ablage_moves_update on ablage_moves;
create policy ablage_moves_update on ablage_moves for update using ((select is_admin()));
drop policy if exists ablage_moves_delete on ablage_moves;
create policy ablage_moves_delete on ablage_moves for delete using ((select is_admin()));

alter table ablage_items
  add column if not exists frist date,
  add column if not exists frist_erinnert jsonb not null default '[]'::jsonb;
create index if not exists ablage_items_frist on ablage_items (frist) where frist is not null;

create table if not exists ablage_eingang (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  mime_type text,
  groesse bigint,
  storage_path text not null,       -- eingang/<id> im Bucket nas-ablage
  mail_von text,
  mail_betreff text,
  created_at timestamptz not null default now()
);
alter table ablage_eingang enable row level security;
drop policy if exists ablage_eingang_select on ablage_eingang;
create policy ablage_eingang_select on ablage_eingang for select using ((select is_admin()));
drop policy if exists ablage_eingang_insert on ablage_eingang;
create policy ablage_eingang_insert on ablage_eingang for insert with check ((select is_admin()));
drop policy if exists ablage_eingang_update on ablage_eingang;
create policy ablage_eingang_update on ablage_eingang for update using ((select is_admin()));
drop policy if exists ablage_eingang_delete on ablage_eingang;
create policy ablage_eingang_delete on ablage_eingang for delete using ((select is_admin()));
