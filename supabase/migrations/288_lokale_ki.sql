-- 288: Warteschlange + Herzschlag der lokalen KI (docs/lokale-ki/SPEC.md 2.3).
-- Vertrauliche Dokumente werden nur noch vom Rig im Buero verarbeitet: das
-- FSM legt Auftraege an, das Rig holt sie ueber /api/ki/sync ab (Service-
-- Role), Ergebnisse landen in `ergebnis`. Nutzer sehen ausschliesslich ihre
-- eigenen Auftraege; Admins alle. Datei-Inhalte liegen nie in diesen
-- Tabellen — nur Pfade im Uebergabe-Bucket und strukturierte Ergebnisse.

create table if not exists public.ki_auftraege (
  id uuid primary key default gen_random_uuid(),
  art text not null,
  status text not null default 'offen'
    constraint ki_auftraege_status_check check (status in ('offen', 'laeuft', 'fertig', 'fehler')),
  payload jsonb not null default '{}'::jsonb,
  ergebnis jsonb,
  fehler text,
  versuche int not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- Abholung = FIFO ueber die offenen Auftraege; Haenge-Pruefung ueber laeuft.
create index if not exists idx_ki_auftraege_status_created on public.ki_auftraege (status, created_at);

alter table public.ki_auftraege enable row level security;

drop policy if exists ki_auftraege_select on public.ki_auftraege;
create policy ki_auftraege_select on public.ki_auftraege
  for select to authenticated
  using (created_by = auth.uid() or (select public.is_admin()));
-- insert/update/delete: bewusst keine Policies -> nur die Service-Role
-- (API-Routen) schreibt. Ein Nutzer kann so weder fremde Pfade in die
-- Warteschlange schieben noch Ergebnisse faelschen.

-- Herzschlag des Rigs: eine einzige Zeile, bei jedem Poll gestempelt.
-- Das UI leitet daraus "Lokale KI online/offline" ab (letzter_poll < 90 s).
create table if not exists public.ki_status (
  id int primary key default 1,
  online_seit timestamptz,
  letzter_poll timestamptz,
  version text,
  modell text,
  gpu jsonb,
  warteschlange int not null default 0,
  letzter_fehler text,
  constraint ki_status_single check (id = 1)
);

insert into public.ki_status (id) values (1) on conflict (id) do nothing;

alter table public.ki_status enable row level security;

drop policy if exists ki_status_select on public.ki_status;
create policy ki_status_select on public.ki_status
  for select to authenticated
  using (not (select public.is_partner()) and not (select public.is_lieferant()));
-- Schreiben: nur Service-Role (Herzschlag der Abhol-API).
