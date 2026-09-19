-- 232_job_eingang_zusagen.sql
-- ============================================================
-- "Der Auftrag dokumentiert sich selbst" (Leo 2026-09-19):
--  - job_inbox_items: der EINGANG eines Auftrags — unsortiertes Roh-
--    material (diktierter/getippter Text, weitergeleitete Mails als Text,
--    Screenshots/Fotos/PDFs). KI liest Neues und pflegt daraus Zusammen-
--    fassung + Zusagen. ai_status: neu -> verarbeitet/fehler.
--  - job_zusagen: verbindliche Abmachungen mit dem Kunden (offen/erledigt/
--    hinfaellig), von der KI extrahiert ODER manuell erfasst; quelle_item_id
--    verlinkt den Beleg im Eingang.
--  - jobs.ai_summary: KI-gepflegte Zusammenfassung des Auftrags.
-- Rechte: sichtbar/beschreibbar fuer alle Mitarbeiter, die den Auftrag
-- sehen (jobs-RLS wird via EXISTS-Subquery geerbt) — ausser Partner-
-- Portal-User (interne Infos!). Eingang-Loeschen: Ersteller oder Admin.
-- Idempotent.
-- ============================================================

alter table public.jobs add column if not exists ai_summary text;

comment on column public.jobs.ai_summary is
  'KI-gepflegte Zusammenfassung aus dem Eingang (job_inbox_items). Manuell ueberschreibbar.';

create table if not exists public.job_inbox_items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  kind text not null check (kind in ('text', 'datei')),
  content text,
  file_path text,
  file_name text,
  mime_type text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  ai_status text not null default 'neu' check (ai_status in ('neu', 'verarbeitet', 'fehler')),
  ai_error text
);

create index if not exists job_inbox_items_job_idx
  on public.job_inbox_items (job_id, created_at desc);

create table if not exists public.job_zusagen (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  text text not null,
  status text not null default 'offen' check (status in ('offen', 'erledigt', 'hinfaellig')),
  mit_wem text,
  quelle_item_id uuid references public.job_inbox_items(id) on delete set null,
  created_via text not null default 'manuell' check (created_via in ('ki', 'manuell')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists job_zusagen_job_idx
  on public.job_zusagen (job_id, status, created_at desc);

alter table public.job_inbox_items enable row level security;
alter table public.job_zusagen enable row level security;

-- ── Eingang ──────────────────────────────────────────────────
drop policy if exists "jii_select" on public.job_inbox_items;
create policy "jii_select"
  on public.job_inbox_items for select to authenticated
  using (
    not public.is_partner()
    and exists (select 1 from public.jobs j where j.id = job_inbox_items.job_id)
  );

drop policy if exists "jii_insert" on public.job_inbox_items;
create policy "jii_insert"
  on public.job_inbox_items for insert to authenticated
  with check (
    not public.is_partner()
    and created_by = auth.uid()
    and exists (select 1 from public.jobs j where j.id = job_inbox_items.job_id)
  );

drop policy if exists "jii_update" on public.job_inbox_items;
create policy "jii_update"
  on public.job_inbox_items for update to authenticated
  using (
    not public.is_partner()
    and (created_by = auth.uid() or public.is_admin())
  )
  with check (
    not public.is_partner()
    and (created_by = auth.uid() or public.is_admin())
  );

drop policy if exists "jii_delete" on public.job_inbox_items;
create policy "jii_delete"
  on public.job_inbox_items for delete to authenticated
  using (
    not public.is_partner()
    and (created_by = auth.uid() or public.is_admin())
  );

-- ── Zusagen ──────────────────────────────────────────────────
drop policy if exists "jz_select" on public.job_zusagen;
create policy "jz_select"
  on public.job_zusagen for select to authenticated
  using (
    not public.is_partner()
    and exists (select 1 from public.jobs j where j.id = job_zusagen.job_id)
  );

drop policy if exists "jz_insert" on public.job_zusagen;
create policy "jz_insert"
  on public.job_zusagen for insert to authenticated
  with check (
    not public.is_partner()
    and exists (select 1 from public.jobs j where j.id = job_zusagen.job_id)
  );

drop policy if exists "jz_update" on public.job_zusagen;
create policy "jz_update"
  on public.job_zusagen for update to authenticated
  using (
    not public.is_partner()
    and exists (select 1 from public.jobs j where j.id = job_zusagen.job_id)
  )
  with check (
    not public.is_partner()
    and exists (select 1 from public.jobs j where j.id = job_zusagen.job_id)
  );

drop policy if exists "jz_delete" on public.job_zusagen;
create policy "jz_delete"
  on public.job_zusagen for delete to authenticated
  using (
    not public.is_partner()
    and exists (select 1 from public.jobs j where j.id = job_zusagen.job_id)
  );
