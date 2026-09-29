-- Ordner-Deaktivierung in der NAS-Ablage (Leo 2026-09-29): einzelne
-- Ordner aus der Zielordner-Auswahl nehmen, ohne sie zu loeschen.
-- Der Auto-Abgleich vom NAS fasst bestehende Zeilen nicht an — das
-- Flag ueberlebt jedes Struktur-Update; erst wenn der Ordner auf dem
-- NAS wirklich verschwindet, faellt auch die Zeile (samt Flag) weg.

alter table public.ablage_ordner
  add column if not exists aktiv boolean not null default true;
