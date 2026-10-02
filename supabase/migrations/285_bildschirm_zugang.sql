-- 285: Buero-Bildschirm ohne Login (Leo 2026-10-02).
-- Der grosse Monitor im Buero fordert einen 6-stelligen Code an, der an
-- admin@eventline-basel.com geht; nach Eingabe erhaelt der Bildschirm ein
-- langlebiges Session-Cookie fuer das Wand-Dashboard (nur lesend).
--
-- Beide Tabellen haben RLS ohne Policies: ausschliesslich der Service-
-- Role-Client (API-Routen) liest/schreibt — kein App-User sieht sie.
-- Codes und Tokens liegen nur als HMAC-Hash (Pepper = Service-Role-Key).

create table if not exists bildschirm_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  versuche int not null default 0,
  ip text
);
create index if not exists bildschirm_codes_offen on bildschirm_codes (created_at desc) where used_at is null;
alter table bildschirm_codes enable row level security;

create table if not exists bildschirm_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  user_agent text,
  revoked_at timestamptz
);
alter table bildschirm_sessions enable row level security;
