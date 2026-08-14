-- Firmeneinstellungen (Singleton): zentrale Stammdaten der Firma —
-- Name, Adresse, Kontakt, MWST/IBAN. Wird in PDFs (Lohnabrechnung,
-- Rapport) und E-Mail-Footern eingesetzt statt hardcoded.
--
-- Singleton via id='default' + Check-Constraint: nur eine Zeile.
-- Admin-only Read/Write (RLS).
--
-- Seed = die Werte die aktuell konsistent in allen anderen Codestellen
-- stehen (Rapport-PDF, Datenschutz-Seite, Mail-Footer). Admin ueberprueft
-- + korrigiert im UI unter Einstellungen -> Firma.

create table if not exists public.company_settings (
  id text primary key default 'default',
  name text not null default '',
  street text not null default '',
  zip text not null default '',
  city text not null default '',
  country text not null default 'Schweiz',
  phone text not null default '',
  email text not null default '',
  website text not null default '',
  uid_number text not null default '',   -- MWST-/UID-Nummer, z.B. CHE-123.456.789
  iban text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id),
  constraint company_settings_singleton check (id = 'default')
);

-- Seed default-Row (idempotent). Nur einfuegen wenn noch nichts da ist.
insert into public.company_settings (id, name, street, zip, city, country, phone, email, website)
values ('default', 'EVENTLINE GmbH', 'St. Jakobs-Strasse 200', '4052', 'Basel', 'Schweiz', '055 556 62 61', 'info@eventline-basel.com', 'www.eventline-basel.com')
on conflict (id) do nothing;

alter table public.company_settings enable row level security;

-- SELECT: eingeloggte User duerfen Firmen-Stammdaten lesen (harmlos, in
-- vielen UI-Stellen z.B. Absender-Hinweise, Footer, Verifikations-Angaben).
create policy "company_settings_select" on public.company_settings
  for select to authenticated using (true);

-- INSERT/UPDATE/DELETE: nur Admin. Delete faktisch nicht sinnvoll da
-- Singleton — Policy setzt aber sauber die Grenze.
create policy "company_settings_admin_write" on public.company_settings
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

comment on table public.company_settings is 'Zentrale Firmen-Stammdaten (Singleton, id=default). Fuellt PDFs + Mail-Footer.';
