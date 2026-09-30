-- 280: Sync-Puls (Leo 2026-09-30) — die Abhol-API stempelt bei jedem
-- Poll des NAS-Clients letzter_poll + gemeldetes Intervall. Das UI
-- rechnet daraus den Countdown "NAS-Abgleich in m:ss".

create table if not exists ablage_sync_status (
  id smallint primary key default 1,
  letzter_poll timestamptz not null default now(),
  intervall_s int not null default 60,
  constraint ablage_sync_status_single check (id = 1)
);

insert into ablage_sync_status (id) values (1) on conflict (id) do nothing;

alter table ablage_sync_status enable row level security;

drop policy if exists ablage_sync_status_select on ablage_sync_status;
create policy ablage_sync_status_select on ablage_sync_status
  for select using ((select is_admin()));
-- Schreiben: nur Service-Role (Abhol-API).
