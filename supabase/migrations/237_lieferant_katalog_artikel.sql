-- 237_lieferant_katalog_artikel.sql
-- Katalog als DATEN statt PDF-Vorschau (Leo 2026-09-19): strukturierte
-- Mietartikel pro Lieferanten-Firma. Befuellt via KI-Import aus dem
-- hinterlegten Katalog-PDF (/api/ai/katalog-import, chunk-weise), Quelle
-- 'ki'; manuelle Korrekturen spaeter als 'manuell'.
-- RLS: Staff liest mit lieferanten:view, schreibt mit lieferanten:edit
-- (Admin via has_permission immer); der Lieferanten-Portal-User liest
-- GENAU die Artikel seiner eigenen Firma, schreibt nichts.
-- Idempotent.

create table if not exists public.lieferant_katalog_artikel (
  id uuid primary key default gen_random_uuid(),
  lieferant_id uuid not null references public.lieferanten(id) on delete cascade,
  kategorie text not null default 'Sonstiges',
  name text not null,
  beschreibung text,
  inhalt text,
  preis_chf numeric(10,2),
  preis_text text,
  sort integer not null default 0,
  is_active boolean not null default true,
  source text not null default 'ki' check (source in ('ki', 'manuell')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lka_lieferant_idx
  on public.lieferant_katalog_artikel (lieferant_id, kategorie, sort);

alter table public.lieferant_katalog_artikel enable row level security;

drop policy if exists "lka_select" on public.lieferant_katalog_artikel;
create policy "lka_select"
  on public.lieferant_katalog_artikel for select to authenticated
  using (
    public.has_permission('lieferanten:view')
    or public.is_admin()
    or (
      public.is_lieferant()
      and lieferant_id = (select lieferant_id from public.profiles where id = auth.uid())
    )
  );

drop policy if exists "lka_insert" on public.lieferant_katalog_artikel;
create policy "lka_insert"
  on public.lieferant_katalog_artikel for insert to authenticated
  with check (public.has_permission('lieferanten:edit') or public.is_admin());

drop policy if exists "lka_update" on public.lieferant_katalog_artikel;
create policy "lka_update"
  on public.lieferant_katalog_artikel for update to authenticated
  using (public.has_permission('lieferanten:edit') or public.is_admin())
  with check (public.has_permission('lieferanten:edit') or public.is_admin());

drop policy if exists "lka_delete" on public.lieferant_katalog_artikel;
create policy "lka_delete"
  on public.lieferant_katalog_artikel for delete to authenticated
  using (public.has_permission('lieferanten:edit') or public.is_admin());
