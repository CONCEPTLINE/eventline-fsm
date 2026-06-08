-- Lohndokumente — monatliche Lohnabrechnungen + jaehrliche Lohnausweise.
--
-- Storage: bucket 'lohndokumente' (private), Pfad-Schema:
--   lohndokumente/<profile_id>/<year>/<doc_type>_<period>.pdf
--   z.B. lohndokumente/abc123/2026/lohnabrechnung_2026-05.pdf
--        lohndokumente/abc123/2026/lohnausweis_2026.pdf
--
-- Zugriff: Mitarbeiter sieht/laedt nur eigene Dokumente. Admin sieht/
-- aendert alle. Alles ueber API-Routes (kein direkter Storage-Zugriff
-- vom Client) damit Signed-URLs zentral generiert werden.
--
-- Profile-Spalten fuer Datenschutz-Einwilligung: erste digitale
-- Bereitstellung erfordert bewusste Akzeptanz (Logging mit Timestamp
-- + Version damit aenderungen nachvollziehbar sind).

create table public.wage_documents (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  doc_type text not null check (doc_type in ('lohnabrechnung', 'lohnausweis')),
  year integer not null,
  -- 1-12 fuer Monatsabrechnungen, NULL fuer Jahres-Lohnausweise.
  period_month integer check (period_month is null or (period_month between 1 and 12)),
  storage_path text not null,
  file_size bigint,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid references public.profiles(id),
  notes text,
  -- Unique-Constraint pro Mitarbeiter+Jahr+Typ+Monat (verhindert Duplikate
  -- beim Re-Upload — alter Storage-File wird ueberschrieben, Row geupdated).
  constraint wage_doc_unique_per_period unique (profile_id, doc_type, year, period_month),
  -- Konsistenz: lohnabrechnung braucht Monat, lohnausweis ist jaehrlich.
  constraint wage_doc_period_consistency check (
    (doc_type = 'lohnabrechnung' and period_month is not null)
    or (doc_type = 'lohnausweis' and period_month is null)
  )
);

create index wage_documents_profile_year_idx on public.wage_documents (profile_id, year desc);

alter table public.wage_documents enable row level security;

-- SELECT: User sieht eigene, Admin sieht alle
create policy "wage_documents_select" on public.wage_documents
  for select to authenticated
  using (profile_id = auth.uid() or public.is_admin());

-- INSERT/UPDATE/DELETE: Admin only
create policy "wage_documents_admin_write" on public.wage_documents
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Profile-Spalten fuer Einwilligung
alter table public.profiles
  add column if not exists lohndokumente_digital_accepted_at timestamptz,
  add column if not exists lohndokumente_digital_accepted_version text;
