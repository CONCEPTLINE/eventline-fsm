-- 304: ablage_fristen — EINE Quelle fuer alle Fristen
-- (docs/lokale-ki/MASTERPLAN.md §4 «N+2»). Nur additiv, idempotent.
--
-- Heute stehen Fristen nur in ablage_items.frist + frist_erinnert (282):
-- geschrieben von POST /api/ablage/upload, gelesen vom Cron
-- api/cron/ablage-fristen (Mails 30/7/0) und vom Buero-Bildschirm. Neu
-- kommen KI-Fristen der Nachtarbeit dazu (quelle 'ki', status 'vorschlag',
-- Datum vom FSM aus den Bedingungen berechnet — `grundlage`, ohne Text;
-- `bezeichnung` strukturiert «<Art> · <Partei|Dateiname>», nie ein Zitat).
-- Die Leser werden in Etappe 3 (E3.4) umgestellt; bis dahin aendert diese
-- Migration am bestehenden Verhalten nichts. ablage_items.frist und
-- frist_erinnert werden erst danach in einer eigenen Migration entfernt.
--
-- Rechte wie die NAS-Seite (271, 277, 282): (select public.is_admin()),
-- alle 4 Verben.

create table if not exists public.ablage_fristen (
  id uuid primary key default gen_random_uuid(),
  ablage_item_id uuid references public.ablage_items(id) on delete cascade,
  pfad text,
  sha256 text,
  art text not null check (art in ('kuendigung', 'ablauf', 'vertragsende', 'verlaengerung', 'zahlung', 'sonstige')),
  datum date not null,
  bezeichnung text not null check (char_length(bezeichnung) <= 120),
  grundlage jsonb,                     -- KI-Bedingungen, ohne Text
  quelle text not null check (quelle in ('ablage', 'ki', 'manuell')),
  status text not null default 'aktiv' check (status in ('vorschlag', 'aktiv', 'verworfen', 'erledigt')),
  sicherheit text check (sicherheit in ('hoch', 'mittel', 'niedrig')),
  erinnert jsonb not null default '[]'::jsonb,
  entschieden_von uuid references public.profiles(id) on delete set null,
  entschieden_am timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ablage_fristen_bezug check (ablage_item_id is not null or pfad is not null)
);

create unique index if not exists ablage_fristen_uq
  on public.ablage_fristen (coalesce(ablage_item_id::text, pfad), art, datum);
create index if not exists ablage_fristen_offen
  on public.ablage_fristen (datum) where status in ('aktiv', 'vorschlag');
-- Abgleich je Datei bzw. Ablage-Eintrag (Nachtarbeit: frist_bekannt).
create index if not exists ablage_fristen_pfad on public.ablage_fristen (pfad);
create index if not exists ablage_fristen_item on public.ablage_fristen (ablage_item_id);
-- Abgleich ueber den Inhalt: eine verschobene Datei (neuer Pfad, gleicher
-- sha256) belebt eine verworfene Frist nicht wieder.
create index if not exists ablage_fristen_sha on public.ablage_fristen (sha256) where sha256 is not null;

alter table public.ablage_fristen enable row level security;

drop policy if exists ablage_fristen_select on public.ablage_fristen;
create policy ablage_fristen_select on public.ablage_fristen
  for select using ((select public.is_admin()));
drop policy if exists ablage_fristen_insert on public.ablage_fristen;
create policy ablage_fristen_insert on public.ablage_fristen
  for insert with check ((select public.is_admin()));
drop policy if exists ablage_fristen_update on public.ablage_fristen;
create policy ablage_fristen_update on public.ablage_fristen
  for update using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists ablage_fristen_delete on public.ablage_fristen;
create policy ablage_fristen_delete on public.ablage_fristen
  for delete using ((select public.is_admin()));

-- Backfill (idempotent; nach dem Umstellen der Leser in E3.4 nochmals
-- ausfuehren): jede Ablage-Frist als aktive Frist 'sonstige' mit ihren
-- schon versandten Erinnerungsstufen.
insert into public.ablage_fristen (ablage_item_id, pfad, art, datum, bezeichnung, quelle, status, erinnert)
select i.id, i.ordner_pfad || '/' || i.abgelegt_name, 'sonstige', i.frist,
       left(i.abgelegt_name, 120), 'ablage', 'aktiv', i.frist_erinnert
from public.ablage_items i
where i.frist is not null
on conflict do nothing;
