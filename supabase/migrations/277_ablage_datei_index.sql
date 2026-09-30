-- 277: Datei-Index des NAS (Leo 2026-09-30) — damit die Ablage-Suche
-- ALLE Dokumente findet, auch die vor der FSM-Ablage manuell aufs NAS
-- gelegten. Der Sync-Client scannt Dateinamen (nie Inhalte) und meldet
-- sie chunked an /api/ablage/datei-index:
--   * Upsert je Datei (unique pfad), zuletzt_gesehen = scan_id
--   * am Scan-Ende: Zeilen mit fremder scan_id loeschen (Datei weg/
--     verschoben) — mit Schutzbremse gegen Fehl-Scans
-- Reine Service-Tabelle: Admins lesen (Suche), Clients schreiben nie.

create table if not exists ablage_datei_index (
  id uuid primary key default gen_random_uuid(),
  pfad text not null unique,          -- relativer Vollpfad inkl. Dateiname
  ordner_pfad text not null,
  name text not null,
  groesse bigint,
  geaendert timestamptz,              -- mtime der Datei auf dem NAS
  scan_id text,                       -- letzter Scan, der die Datei sah
  aktualisiert timestamptz not null default now()
);

alter table ablage_datei_index enable row level security;

drop policy if exists ablage_datei_index_select on ablage_datei_index;
create policy ablage_datei_index_select on ablage_datei_index
  for select using ((select is_admin()));
-- insert/update/delete: KEINE Policies — nur die Service-Role schreibt.

create index if not exists ablage_datei_index_name_trgm
  on ablage_datei_index using gin (name gin_trgm_ops);
create index if not exists ablage_datei_index_ordner_trgm
  on ablage_datei_index using gin (ordner_pfad gin_trgm_ops);
create index if not exists ablage_datei_index_scan
  on ablage_datei_index (scan_id);
