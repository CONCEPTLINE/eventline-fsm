-- 350_trust_one_sso.sql — «Ein Login» aus Trust one (https://one.trust-group.ch).
--
-- Trust one leitet mit einem signierten Ausweis (Ed25519, 60 s gueltig) auf
-- /sso#t=<token>. Die App prueft ihn (src/lib/trust-one-sso.ts) und meldet
-- das verknuepfte Profil an (POST /api/auth/trust-one).
--
--  - trust_one_links: feste Verbindung Trust-one-User-ID -> Profil-ID (NICHT
--    ueber die E-Mail: Login-Daten in der App duerfen sich aendern, die
--    Verbindung bleibt). Ein Trust-one-User -> genau ein Profil, ein Profil
--    -> genau ein Trust-one-User (beide Seiten UNIQUE).
--  - trust_one_sso_tokens: jeder eingeloeste Ausweis (jti = Einmal-Schutz
--    gegen Wiederholung). Ist der Trust-one-User noch nicht verbunden, haengt
--    an der Zeile ein pending_id (10 Min.), mit dem sich der Nutzer nach
--    einer normalen Anmeldung unter /sso/verbinden einmal verbindet.
--
-- Rechte: NUR Service-Rolle (Route Handler unter /api/auth/trust-one).
-- RLS an + erzwungen, KEINE Policies, anon/authenticated/public ohne Rechte.
--
-- Einspielen: node scripts/apply-migration.mjs supabase/migrations/350_trust_one_sso.sql
-- Idempotent.

create table if not exists public.trust_one_links (
  trust_one_user_id uuid primary key,
  profile_id uuid not null unique references public.profiles(id) on delete cascade,
  trust_one_name text check (trust_one_name is null or char_length(trust_one_name) <= 120),
  created_at timestamptz not null default now()
);

create table if not exists public.trust_one_sso_tokens (
  jti text primary key check (char_length(jti) between 16 and 200),
  trust_one_user_id uuid not null,
  trust_one_name text check (trust_one_name is null or char_length(trust_one_name) <= 120),
  pending_id text unique,
  pending_until timestamptz,
  linked_at timestamptz,
  created_at timestamptz not null default now()
);

-- nur Service Role: RLS an, KEINE Policies, anon/authenticated/public ohne Rechte
alter table public.trust_one_links enable row level security;
alter table public.trust_one_links force row level security;
alter table public.trust_one_sso_tokens enable row level security;
alter table public.trust_one_sso_tokens force row level security;
revoke all on public.trust_one_links, public.trust_one_sso_tokens from anon, authenticated, public;
grant all on public.trust_one_links, public.trust_one_sso_tokens to service_role;
