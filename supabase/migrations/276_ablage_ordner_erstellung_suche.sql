-- 276: Ordner-Erstellung aus dem FSM + Suche ueber die Ablage-Historie
-- (Leo 2026-09-30).
--
-- nas_ausstehend: Ordner wurde im FSM angelegt und wartet darauf, dass
-- der Sync-Client ihn physisch auf dem UGREEN erstellt. Der Ordner-
-- Vollabgleich darf solche Zeilen NICHT loeschen (sie fehlen im Scan,
-- bis der Client sie angelegt hat).
--
-- pg_trgm-Indexe: die Ablage-Historie ist das dauerhafte Namensregister
-- ("wo liegt welches Dokument") — die Suche laeuft per ilike und soll
-- auch mit zehntausenden Eintraegen schnell bleiben.

alter table ablage_ordner
  add column if not exists nas_ausstehend boolean not null default false;

create extension if not exists pg_trgm;

create index if not exists ablage_items_name_trgm
  on ablage_items using gin (abgelegt_name gin_trgm_ops);
create index if not exists ablage_items_beschrieb_trgm
  on ablage_items using gin (beschrieb gin_trgm_ops);
create index if not exists ablage_items_ordner_trgm
  on ablage_items using gin (ordner_pfad gin_trgm_ops);
