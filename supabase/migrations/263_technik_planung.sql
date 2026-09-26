-- 263: Technik-Planungsplattform (Lieferantenportal-Ausbau)
--
-- Gemeinsame technische Planung von Auftraegen mit dem Techniklieferanten:
--   Kundenanforderungen -> Technikpositionen -> Lieferanten-Review
--   (bestaetigen / Empfehlung / Problem / Frage) -> Uebernahme -> Aktivitaet.
--
-- Zugriffsmodell: ALLE Tabellen sind staff-only (RLS wie job_material,
-- Migration 245). Das Lieferantenportal greift AUSSCHLIESSLICH ueber
-- /api/lieferant/*-Routen zu (Admin-Client, Whitelist-Selects, Zuweisungs-
-- Check) — so sieht ein Lieferant nie Kundenpreise/Stunden/Dokumente und
-- die Live-RLS auf jobs bleibt unangetastet.

-- 1. Zuweisung Lieferant <-> Auftrag ---------------------------------------
create table public.job_lieferanten (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  lieferant_id uuid not null references public.lieferanten(id) on delete cascade,
  -- wann die Anfrage aktiv an den Lieferanten geschickt wurde (Benachrichtigung);
  -- null = zugewiesen, aber noch nicht angefragt.
  angefragt_at timestamptz,
  angefragt_by uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (job_id, lieferant_id)
);
create index job_lieferanten_lieferant_idx on public.job_lieferanten(lieferant_id);

-- 2. Kundenanforderungen (Wunsch-Ebene, getrennt von der Technik) ----------
create table public.job_anforderungen (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  text text not null,
  sort int not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index job_anforderungen_job_idx on public.job_anforderungen(job_id);
create trigger job_anforderungen_updated_at before update on public.job_anforderungen
  for each row execute function public.update_updated_at();

-- 3. Technikpositionen (der eigentliche Plan) ------------------------------
create table public.job_technik_positionen (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  anforderung_id uuid references public.job_anforderungen(id) on delete set null,
  artikel_id uuid references public.lieferant_katalog_artikel(id) on delete set null,
  kategorie text not null default 'Sonstiges',
  bezeichnung text not null,
  details text,
  menge int not null default 1 check (menge > 0),
  status text not null default 'geplant' check (status in ('geplant', 'bestaetigt')),
  quelle text not null default 'eventfirma' check (quelle in ('kunde', 'eventfirma', 'lieferant')),
  bestaetigt_by uuid references public.profiles(id) on delete set null,
  bestaetigt_at timestamptz,
  sort int not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index job_technik_positionen_job_idx on public.job_technik_positionen(job_id);
create trigger job_technik_positionen_updated_at before update on public.job_technik_positionen
  for each row execute function public.update_updated_at();

-- 4. Review-Punkte des Lieferanten -----------------------------------------
-- position_id null = allgemeiner Punkt zum Auftrag (z.B. "Strom klaeren").
-- vorschlag (jsonb) macht Empfehlungen mit einem Klick uebernehmbar:
--   { typ: 'menge',          menge }
--   { typ: 'neue_position',  bezeichnung, menge, kategorie?, details?, artikel_id? }
--   { typ: 'ersatz',         bezeichnung, menge?, details?, artikel_id? }
create table public.job_technik_reviews (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  position_id uuid references public.job_technik_positionen(id) on delete cascade,
  art text not null check (art in ('empfehlung', 'problem', 'frage')),
  text text not null,
  vorschlag jsonb,
  status text not null default 'offen' check (status in ('offen', 'uebernommen', 'abgelehnt', 'erledigt')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  entschieden_by uuid references public.profiles(id) on delete set null,
  entschieden_at timestamptz
);
create index job_technik_reviews_job_idx on public.job_technik_reviews(job_id);

-- 5. Kommentare, an Position oder Review-Punkt gebunden --------------------
create table public.job_technik_kommentare (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  position_id uuid references public.job_technik_positionen(id) on delete cascade,
  review_id uuid references public.job_technik_reviews(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);
create index job_technik_kommentare_job_idx on public.job_technik_kommentare(job_id);

-- 6. Aktivitaets-Verlauf ----------------------------------------------------
-- actor_name denormalisiert, damit die Timeline ohne profiles-Join (und im
-- Portal ohne profiles-Zugriff) anzeigbar bleibt.
create table public.job_technik_aktivitaet (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  actor_name text,
  aktion text not null,
  beschreibung text not null,
  meta jsonb,
  created_at timestamptz not null default now()
);
create index job_technik_aktivitaet_job_idx on public.job_technik_aktivitaet(job_id, created_at desc);

-- 7. Lieferanten-Wissen: Pakete + Hinweise (Etappe 3) ----------------------
-- trigger_text: Stichwort, das auf Bezeichnung/Kategorie neuer Positionen
-- gematcht wird (case-insensitiv, contains).
create table public.lieferant_regeln (
  id uuid primary key default gen_random_uuid(),
  lieferant_id uuid not null references public.lieferanten(id) on delete cascade,
  art text not null check (art in ('paket', 'hinweis')),
  trigger_text text not null,
  hinweis text,
  paket jsonb,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index lieferant_regeln_lieferant_idx on public.lieferant_regeln(lieferant_id);
create trigger lieferant_regeln_updated_at before update on public.lieferant_regeln
  for each row execute function public.update_updated_at();

-- RLS: staff-only (Portal laeuft ueber Admin-Client-API-Routen) ------------
do $$
declare t text;
begin
  foreach t in array array[
    'job_lieferanten', 'job_anforderungen', 'job_technik_positionen',
    'job_technik_reviews', 'job_technik_kommentare', 'job_technik_aktivitaet',
    'lieferant_regeln'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "%s sehen" on public.%I for select to authenticated using (not public.is_partner() and not public.is_lieferant())', t, t);
    execute format(
      'create policy "%s anlegen" on public.%I for insert to authenticated with check (not public.is_partner() and not public.is_lieferant())', t, t);
    execute format(
      'create policy "%s bearbeiten" on public.%I for update to authenticated using (not public.is_partner() and not public.is_lieferant()) with check (not public.is_partner() and not public.is_lieferant())', t, t);
    execute format(
      'create policy "%s loeschen" on public.%I for delete to authenticated using (not public.is_partner() and not public.is_lieferant())', t, t);
  end loop;
end $$;
