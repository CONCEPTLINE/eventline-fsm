-- 239_katalog_hauptkategorie.sql
-- Zwei-Ebenen-Struktur fuer den Lieferanten-Katalog: hauptkategorie
-- (ca. 8-12 Kapitel, Filter-Chips im Portal) + kategorie (Unterkapitel,
-- Abschnitts-Ueberschriften). Idempotent.

alter table public.lieferant_katalog_artikel add column if not exists hauptkategorie text not null default 'Sonstiges';
create index if not exists lka_haupt_idx on public.lieferant_katalog_artikel (lieferant_id, hauptkategorie);
