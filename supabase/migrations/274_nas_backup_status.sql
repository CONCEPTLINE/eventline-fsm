-- NAS-Backup-Ueberwachung (Leo 2026-09-29): der Backup-Container auf dem
-- UGREEN meldet nach jedem naechtlichen Lauf Status + Groessen ans FSM.
-- Ein taeglicher Cron prueft das Alter der letzten OK-Meldung und mailt
-- die Admins, wenn >26h nichts kam — damit ein still stehendes Backup
-- nie wieder monatelang unbemerkt bleibt.

create table if not exists public.nas_backup_runs (
  id uuid primary key default gen_random_uuid(),
  -- Datum/Zeit-Stempel des Laufs, wie ihn das Backup-Skript vergibt
  -- (z.B. "2026-09-29_030000"); bei Fehler-Meldungen der Zeitpunkt des
  -- Abbruchs.
  run_date text not null,
  status text not null default 'ok' check (status in ('ok', 'fehler')),
  total_size text,
  db_size text,
  storage_size text,
  reported_at timestamptz not null default now()
);

create index if not exists idx_nas_backup_runs_reported
  on public.nas_backup_runs (reported_at desc);

-- Alarm-Log: verhindert Mail-Spam (max. ~1 Alarm-Mail pro Tag).
create table if not exists public.nas_backup_alerts (
  id uuid primary key default gen_random_uuid(),
  sent_at timestamptz not null default now(),
  grund text
);

-- RLS: Admin-only lesen; geschrieben wird ausschliesslich ueber
-- Server-Routen (Service-Role). Alle 4 Verben explizit.
alter table public.nas_backup_runs enable row level security;
alter table public.nas_backup_alerts enable row level security;

drop policy if exists "nas_backup_runs_select" on public.nas_backup_runs;
create policy "nas_backup_runs_select" on public.nas_backup_runs for select using ((select public.is_admin()));
drop policy if exists "nas_backup_runs_insert" on public.nas_backup_runs;
create policy "nas_backup_runs_insert" on public.nas_backup_runs for insert with check (false);
drop policy if exists "nas_backup_runs_update" on public.nas_backup_runs;
create policy "nas_backup_runs_update" on public.nas_backup_runs for update using (false);
drop policy if exists "nas_backup_runs_delete" on public.nas_backup_runs;
create policy "nas_backup_runs_delete" on public.nas_backup_runs for delete using (false);

drop policy if exists "nas_backup_alerts_select" on public.nas_backup_alerts;
create policy "nas_backup_alerts_select" on public.nas_backup_alerts for select using ((select public.is_admin()));
drop policy if exists "nas_backup_alerts_insert" on public.nas_backup_alerts;
create policy "nas_backup_alerts_insert" on public.nas_backup_alerts for insert with check (false);
drop policy if exists "nas_backup_alerts_update" on public.nas_backup_alerts;
create policy "nas_backup_alerts_update" on public.nas_backup_alerts for update using (false);
drop policy if exists "nas_backup_alerts_delete" on public.nas_backup_alerts;
create policy "nas_backup_alerts_delete" on public.nas_backup_alerts for delete using (false);
