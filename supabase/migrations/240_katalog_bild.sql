-- 240_katalog_bild.sql
-- Produktbild pro Katalog-Artikel (aus dem PDF extrahiert, Storage-Pfad
-- im documents-Bucket; signed URLs liefert /api/lieferant/katalog).
alter table public.lieferant_katalog_artikel add column if not exists bild_path text;
