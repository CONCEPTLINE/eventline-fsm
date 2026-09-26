-- NAS-Ablage (Leo 2026-09-26): Dokumente im FSM ablegen, die dann in die
-- Ordnerstruktur des UGREEN-NAS wandern. BEWUSST OHNE KI — sensible
-- Dokumente werden nie inhaltlich analysiert; der Nutzer gibt pro Datei
-- einen Kurzbeschrieb ab und waehlt den Zielordner selbst.
--
-- Architektur: Upload landet im privaten Storage-Bucket 'nas-ablage'
-- unter dem Zielordner-Pfad; das NAS holt die Dateien per Sync ab
-- (kein offener Port am NAS noetig). ablage_items ist die Historie.

-- Ordnerstruktur des NAS als pflegbare Pfadliste (Quelle fuer die
-- Zielordner-Auswahl; wird 1:1 von der echten NAS-Struktur uebernommen).
create table if not exists public.ablage_ordner (
  id uuid primary key default gen_random_uuid(),
  pfad text not null unique,
  created_at timestamptz not null default now()
);

-- Historie der abgelegten Dokumente (Metadaten; die Datei selbst liegt
-- im Bucket bzw. nach dem Sync auf dem NAS).
create table if not exists public.ablage_items (
  id uuid primary key default gen_random_uuid(),
  ordner_pfad text not null,
  beschrieb text not null,
  original_name text not null,
  abgelegt_name text not null,
  storage_path text not null,
  file_size bigint,
  mime_type text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ablage_items_created_at on public.ablage_items (created_at desc);

-- RLS: reines Admin-Werkzeug (sensible Dokumente). Alle 4 Verben
-- explizit, kein Portal-/Mitarbeiter-Zugriff.
alter table public.ablage_ordner enable row level security;
alter table public.ablage_items enable row level security;

drop policy if exists "ablage_ordner_select" on public.ablage_ordner;
create policy "ablage_ordner_select" on public.ablage_ordner for select using ((select public.is_admin()));
drop policy if exists "ablage_ordner_insert" on public.ablage_ordner;
create policy "ablage_ordner_insert" on public.ablage_ordner for insert with check ((select public.is_admin()));
drop policy if exists "ablage_ordner_update" on public.ablage_ordner;
create policy "ablage_ordner_update" on public.ablage_ordner for update using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "ablage_ordner_delete" on public.ablage_ordner;
create policy "ablage_ordner_delete" on public.ablage_ordner for delete using ((select public.is_admin()));

drop policy if exists "ablage_items_select" on public.ablage_items;
create policy "ablage_items_select" on public.ablage_items for select using ((select public.is_admin()));
drop policy if exists "ablage_items_insert" on public.ablage_items;
create policy "ablage_items_insert" on public.ablage_items for insert with check ((select public.is_admin()));
drop policy if exists "ablage_items_update" on public.ablage_items;
create policy "ablage_items_update" on public.ablage_items for update using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "ablage_items_delete" on public.ablage_items;
create policy "ablage_items_delete" on public.ablage_items for delete using ((select public.is_admin()));

-- Privater Bucket fuer die Uebergabe ans NAS. KEINE storage.objects-
-- Policies: nur der Service-Role-Client (Server-Route mit requireAdmin)
-- schreibt/liest — normale Sessions kommen nicht an die Dateien.
insert into storage.buckets (id, name, public)
values ('nas-ablage', 'nas-ablage', false)
on conflict (id) do nothing;
