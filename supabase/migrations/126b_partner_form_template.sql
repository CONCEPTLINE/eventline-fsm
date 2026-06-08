-- Konfigurierbares Partner-Anfrage-Form.
--
-- Statt einer hardcoded Form auf /partner/anfragen/neu kann der Admin
-- jetzt das Form-Schema im UI bauen (Block-Builder + Raw-JSON-Editor)
-- und versioniert publishen.
--
-- Tabelle haelt zwei Schemas:
--   draft_schema = was der Admin gerade bearbeitet (nicht live)
--   live_schema  = was der Partner sieht (= zuletzt publishtes Draft)
--
-- Scope kann global (= ein Template fuer alle Partner) oder location-
-- spezifisch sein. v1: nur global. Schema unterstuetzt schon Per-Location-
-- Overrides damit das spaeter ohne Migration moeglich ist.

create table if not exists public.partner_form_template (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('global', 'location')),
  location_id uuid references public.locations(id) on delete cascade,
  draft_schema jsonb not null default '{"version":1,"blocks":[]}'::jsonb,
  live_schema jsonb,
  draft_updated_at timestamptz default now(),
  draft_updated_by uuid references public.profiles(id),
  live_published_at timestamptz,
  live_published_by uuid references public.profiles(id),
  created_at timestamptz default now(),
  -- Konsistenz: scope='global' braucht NULL location_id, scope='location'
  -- braucht non-NULL location_id.
  constraint partner_form_template_scope_location_consistency check (
    (scope = 'global' and location_id is null)
    or (scope = 'location' and location_id is not null)
  )
);

-- Genau ein globales Template.
create unique index if not exists partner_form_template_one_global
  on public.partner_form_template (scope)
  where scope = 'global';

-- Maximal ein Template pro Location (Per-Location-Override).
create unique index if not exists partner_form_template_one_per_location
  on public.partner_form_template (location_id)
  where location_id is not null;

alter table public.partner_form_template enable row level security;

-- Lesen: Admins/Leads (zum Editieren) UND Partner (zum Rendern der Form).
drop policy if exists "partner_form_template_select" on public.partner_form_template;
create policy "partner_form_template_select"
  on public.partner_form_template
  for select
  using (
    public.is_admin_or_lead()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'partner'
    )
  );

-- Schreiben: nur Admins.
drop policy if exists "partner_form_template_admin_write" on public.partner_form_template;
create policy "partner_form_template_admin_write"
  on public.partner_form_template
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- Beantwortete Custom-Felder werden auf dem Job-Datensatz selbst gespeichert.
-- Core-Felder (title, dates, contact_*) bleiben in eigenen Spalten — nur
-- ueber das Schema definierte Zusatzfelder landen in form_answers (key =
-- block.id, value = whatever der Block zurueckgibt).
alter table public.jobs add column if not exists form_answers jsonb;
