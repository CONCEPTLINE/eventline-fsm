-- 281: Duplikat-Warnung (Leo 2026-09-30) — SHA-256-Fingerabdruck jeder
-- ueber das FSM abgelegten Datei. Beim Ablegen prueft der Server:
--   a) gleicher Hash -> sicher dasselbe Dokument (Warnung mit Fundort)
--   b) gleiche Groesse + aehnlicher Name im NAS-Datei-Index -> Verdacht
--   c) Zielname existiert schon -> wuerde als " (2)" daneben landen
-- Nie blockierend: "Trotzdem ablegen" (force) geht immer.

alter table ablage_items
  add column if not exists inhalt_hash text;

create index if not exists ablage_items_inhalt_hash
  on ablage_items (inhalt_hash)
  where inhalt_hash is not null;
