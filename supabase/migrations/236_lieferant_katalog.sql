-- 236_lieferant_katalog.sql
-- Mietkatalog pro Lieferanten-Firma (Leo 2026-09-19): Admin hinterlegt das
-- Katalog-PDF in den Einstellungen, der Lieferant sieht es im Portal-Tab
-- "Katalog". Datei liegt im documents-Bucket (lieferanten/<id>/…), die
-- signed URL liefert eine API-Route (Server, Admin-Client) — der Lieferant
-- braucht keinerlei Storage-Rechte. Lesen der Spalten: via bestehender
-- Policies (Staff mit lieferanten:view; Lieferant sieht eigene Zeile, 235).
-- Idempotent.

alter table public.lieferanten add column if not exists katalog_path text;
alter table public.lieferanten add column if not exists katalog_name text;
alter table public.lieferanten add column if not exists katalog_updated_at timestamptz;

comment on column public.lieferanten.katalog_path is
  'Storage-Pfad (Bucket documents) des Mietkatalog-PDFs; NULL = kein Katalog hinterlegt.';
