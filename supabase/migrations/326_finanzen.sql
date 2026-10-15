-- Finanzen Welle 1 (2026-10-15): eigenes Schema `finanzen` fuer den Bexio-
-- Spiegel und das Lese-Protokoll (Finanzen + Lohn).
--
-- Sicherheitsmodell (Entscheid Leo/Mischa):
--   * Das Schema wird in PostgREST exponiert (scripts/finanzen-schema-expose.mjs),
--     damit der Admin-Client (service_role) mit { db: { schema: 'finanzen' } }
--     direkt arbeiten kann — aber anon und authenticated haben KEINE USAGE auf
--     dem Schema. Jede kuenftige Tabelle hier ist damit von Haus aus fuer
--     Browser-Clients unerreichbar (PostgREST antwortet 401/403/404).
--   * Zusaetzlich RLS an auf jeder Tabelle OHNE Policies (zweiter Riegel,
--     falls jemand spaeter doch USAGE vergibt). Abweichung von der README-
--     4-Verben-Regel ist bewusst: Policies "to authenticated" waeren tot,
--     weil die Rolle das Schema gar nicht sieht. service_role umgeht RLS.
--   * Views mit security_invoker = on (dritter Riegel): ein spaeterer,
--     gut gemeinter `grant select on view to authenticated` oeffnet NICHT
--     die Basistabellen (Befund Migration 320 §3). service_role hat
--     BYPASSRLS, fuer den Admin-Client aendert sich nichts.
--   * Einzige Zugriffsdatei im Code: src/lib/finanzen/db.ts.
--   * Bexio bleibt Quelle der Wahrheit — der Spiegel ist jederzeit komplett
--     neu aufbaubar: scripts/finanzen-neuaufbau.sql (truncate + Wasser-
--     zeichen null) und danach POST /api/finanzen/sync { voll: true }.
--     Ein nacktes truncate reicht NICHT (Wasserzeichen bliebe stehen).
--   * KEINE Betraege im Lese-Protokoll (finanzen.zugriffe.details).
-- Idempotent, rein additiv. Grants am Ende der Datei.

create schema if not exists finanzen;
comment on schema finanzen is 'Bexio-Spiegel + Lese-Protokoll Finanzen/Lohn. Nur service_role (src/lib/finanzen/db.ts). anon/authenticated haben keine USAGE.';

revoke all on schema finanzen from public;
revoke all on schema finanzen from anon;
revoke all on schema finanzen from authenticated;
grant usage on schema finanzen to service_role;

-- Default-Privilegien fuer alles, was postgres (Management-API) kuenftig in
-- diesem Schema anlegt: Funktionen NICHT fuer PUBLIC ausfuehrbar, Tabellen/
-- Sequenzen/Funktionen fuer service_role.
alter default privileges for role postgres in schema finanzen revoke execute on functions from public;
alter default privileges for role postgres in schema finanzen grant all on tables to service_role;
alter default privileges for role postgres in schema finanzen grant all on sequences to service_role;
alter default privileges for role postgres in schema finanzen grant execute on functions to service_role;
-- Dasselbe fuer die Rolle, die diese Migration gerade ausfuehrt (falls die
-- Management-API nicht als postgres laeuft) — identisch, wenn es postgres ist.
alter default privileges in schema finanzen revoke execute on functions from public;
alter default privileges in schema finanzen grant all on tables to service_role;
alter default privileges in schema finanzen grant all on sequences to service_role;
alter default privileges in schema finanzen grant execute on functions to service_role;

-- =====================================================================
-- 1. Lese-Protokoll (append-only, Vorbild 168_permission_audit_log.sql)
-- =====================================================================
create table if not exists finanzen.zugriffe (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  actor_profile_id uuid references public.profiles(id) on delete set null,
  actor_label text,
  bereich text not null check (bereich in ('finanzen', 'lohn')),
  aktion text not null,
  ziel_profile_id uuid references public.profiles(id) on delete set null,
  ziel_label text,
  geraet_hash text,
  details jsonb not null default '{}'::jsonb
);
create index if not exists zugriffe_occurred_idx on finanzen.zugriffe (occurred_at desc);
create index if not exists zugriffe_actor_idx on finanzen.zugriffe (actor_profile_id);
create index if not exists zugriffe_bereich_idx on finanzen.zugriffe (bereich, occurred_at desc);
alter table finanzen.zugriffe enable row level security;
comment on table finanzen.zugriffe is
  'Append-Only Lese-Protokoll Finanzen + Lohn. occurred_at einzige Zeitspalte. Schreiben nur service_role (protokolliereZugriff). details NIE mit Betraegen/Namen/Dokumentnamen. RLS an ohne Policies: Clients haben keine Schema-USAGE.';

-- Nachweis des Wochen-Digests (Idempotenz bei Cron-Wiederholung).
create table if not exists finanzen.digest_versand (
  id uuid primary key default gen_random_uuid(),
  sent_at timestamptz not null default now(),
  von timestamptz not null,
  bis timestamptz not null,
  anzahl int not null default 0
);
alter table finanzen.digest_versand enable row level security;
comment on table finanzen.digest_versand is 'Versand-Nachweis /api/cron/zugriffe-digest (Montag). Nur service_role.';

-- =====================================================================
-- 2. Bexio-Spiegel
-- =====================================================================
create table if not exists finanzen.kontakte (
  id int primary key,
  nr text,
  name_1 text not null default '',
  name_2 text,
  contact_type_id int,
  bexio_updated_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now()
);
alter table finanzen.kontakte enable row level security;
comment on table finanzen.kontakte is 'Spiegel /2.0/contact (nur Stammfelder; raw = ganzes Objekt). Delta via updated_at.';

-- Waehrungen: Bexio hat KEIN /2.0/currency, nur GET /3.0/currencies
-- (security null). Bruecke rechnungen.currency_id -> ISO-Code, damit die
-- Auswertungen nur CHF summieren und Fremdwaehrung zaehlen statt blind
-- addieren.
create table if not exists finanzen.waehrungen (
  id int primary key,
  name text not null,
  round_factor numeric(14,6),
  raw jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now()
);
alter table finanzen.waehrungen enable row level security;
comment on table finanzen.waehrungen is 'Spiegel /3.0/currencies (id, name = ISO 4217, round_factor). Vollabgleich. Views joinen darauf.';

create table if not exists finanzen.rechnungen (
  id int primary key,
  document_nr text not null,
  title text,
  contact_id int,
  contact_sub_id int,
  project_id int,
  user_id int,
  currency_id int,
  kb_item_status_id int not null,
  status text not null default 'unbekannt'
    check (status in ('entwurf','offen','bezahlt','teilbezahlt','storniert','ueberfaellig','unbekannt')),
  total_gross numeric(14,6),
  total_net numeric(14,6),
  total_taxes numeric(14,6),
  total numeric(14,6),
  total_received_payments numeric(14,6),
  total_credit_vouchers numeric(14,6),
  total_remaining_payments numeric(14,6),
  is_valid_from date not null,
  is_valid_to date,
  reference text,
  api_reference text,
  mahnstufe int not null default 0,
  bexio_updated_at timestamptz,
  kinder_synced_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now()
);
-- Fortschrittsmarker des N+1 (Zahlungen/Mahnungen): null = nie geladen. Der
-- Spiegel laedt offene Rechnungen in dieser Reihenfolge (null zuerst, dann
-- aelteste), damit sich die Kinder ueber mehrere Laeufe fuellen, wenn das
-- Zeitbudget nicht fuer alle reicht. (Korrektor-Nachtrag, additiv.)
alter table finanzen.rechnungen add column if not exists kinder_synced_at timestamptz;
create index if not exists rechnungen_status_idx on finanzen.rechnungen (kb_item_status_id);
create index if not exists rechnungen_datum_idx on finanzen.rechnungen (is_valid_from);
create index if not exists rechnungen_contact_idx on finanzen.rechnungen (contact_id);
alter table finanzen.rechnungen enable row level security;
comment on table finanzen.rechnungen is 'Spiegel /2.0/kb_invoice ohne Positionen (Welle 1). Status-Mapping in src/lib/finanzen/types.ts. mahnstufe = max(reminder_level) aus finanzen.mahnungen.';

create table if not exists finanzen.rechnung_zahlungen (
  id int primary key,
  rechnung_id int not null references finanzen.rechnungen(id) on delete cascade,
  datum date,
  betrag numeric(14,6),
  bank_account_id int,
  title text,
  payment_service_id int,
  is_cash_discount boolean not null default false,
  raw jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now()
);
create index if not exists rechnung_zahlungen_rechnung_idx on finanzen.rechnung_zahlungen (rechnung_id);
alter table finanzen.rechnung_zahlungen enable row level security;
comment on table finanzen.rechnung_zahlungen is 'Spiegel /2.0/kb_invoice/{id}/payment (nur offene Rechnungen + Delta-Rechnungen, N+1).';

create table if not exists finanzen.mahnungen (
  id int primary key,
  rechnung_id int not null references finanzen.rechnungen(id) on delete cascade,
  title text,
  is_valid_from date,
  is_valid_to date,
  reminder_level int not null default 0,
  is_sent boolean not null default false,
  remaining_price numeric(14,6),
  received_total numeric(14,6),
  raw jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now()
);
create index if not exists mahnungen_rechnung_idx on finanzen.mahnungen (rechnung_id);
alter table finanzen.mahnungen enable row level security;
comment on table finanzen.mahnungen is 'Spiegel /2.0/kb_invoice/{id}/kb_reminder (nur offene Rechnungen).';

create table if not exists finanzen.offerten (
  id int primary key,
  document_nr text not null,
  title text,
  contact_id int,
  contact_sub_id int,
  project_id int,
  user_id int,
  currency_id int,
  kb_item_status_id int not null,
  status text not null default 'unbekannt'
    check (status in ('entwurf','offen','bestaetigt','abgelehnt','unbekannt')),
  total_gross numeric(14,6),
  total_net numeric(14,6),
  total numeric(14,6),
  is_valid_from date,
  is_valid_until date,
  api_reference text,
  bexio_updated_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now()
);
alter table finanzen.offerten enable row level security;
comment on table finanzen.offerten is 'Spiegel /2.0/kb_offer (liefert kein reference, nur api_reference). Delta via updated_at.';

create table if not exists finanzen.lieferantenrechnungen (
  id uuid primary key,
  document_no text,
  title text,
  status text not null,
  vendor text,
  firstname_suffix text,
  lastname_company text,
  supplier_id int,
  vendor_ref text,
  currency_code text,
  net numeric(14,2),
  gross numeric(14,2),
  pending_amount numeric(14,2),
  bill_date date,
  due_date date,
  overdue boolean not null default false,
  created_at_bexio timestamptz,
  zahlungen_synced_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now()
);
-- Fortschrittsmarker der Outgoing-Payments (null = nie geladen), gleiche
-- Logik wie rechnungen.kinder_synced_at. (Korrektor-Nachtrag, additiv.)
alter table finanzen.lieferantenrechnungen add column if not exists zahlungen_synced_at timestamptz;
create index if not exists lieferantenrechnungen_status_idx on finanzen.lieferantenrechnungen (status);
create index if not exists lieferantenrechnungen_due_idx on finanzen.lieferantenrechnungen (due_date);
alter table finanzen.lieferantenrechnungen enable row level security;
comment on table finanzen.lieferantenrechnungen is 'Spiegel /4.0/purchase/bills, Vollabgleich letzte 15 Monate (kein updated_at-Filter in Bexio).';

create table if not exists finanzen.lieferanten_zahlungen (
  id uuid primary key,
  bill_id uuid not null references finanzen.lieferantenrechnungen(id) on delete cascade,
  payment_type text,
  status text,
  execution_date date,
  amount numeric(14,2),
  sender_bank_account_id int,
  raw jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now()
);
create index if not exists lieferanten_zahlungen_bill_idx on finanzen.lieferanten_zahlungen (bill_id);
alter table finanzen.lieferanten_zahlungen enable row level security;
comment on table finanzen.lieferanten_zahlungen is 'Spiegel /4.0/purchase/outgoing-payments?bill_id= (nur offene Bills). Kein currency_code (liefert Bexio nicht) — Waehrung = Bill.';

create table if not exists finanzen.konten (
  id int primary key,
  uuid uuid,
  account_no text,
  name text,
  account_type int,
  tax_id int,
  fibu_account_group_id int,
  is_active boolean not null default true,
  is_locked boolean not null default false,
  raw jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now()
);
alter table finanzen.konten enable row level security;
comment on table finanzen.konten is 'Spiegel /2.0/accounts (Kontenplan), Vollabgleich. account_type 1 Ertrag 2 Aufwand 3 Aktiv 4 Passiv 5 Abschluss.';

create table if not exists finanzen.kontengruppen (
  id int primary key,
  uuid uuid,
  account_no text,
  name text,
  parent_fibu_account_group_id int,
  is_active boolean not null default true,
  is_locked boolean not null default false,
  raw jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now()
);
alter table finanzen.kontengruppen enable row level security;
comment on table finanzen.kontengruppen is 'Spiegel /2.0/account_groups, Vollabgleich.';

create table if not exists finanzen.journal_buchungen (
  id int primary key,
  ref_id int,
  ref_uuid uuid,
  ref_class text,
  datum date not null,
  debit_account_id int,
  credit_account_id int,
  description text,
  amount numeric(14,6),
  currency_id int,
  currency_factor numeric(14,6),
  base_currency_id int,
  base_currency_amount numeric(14,6),
  raw jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now()
);
create index if not exists journal_datum_idx on finanzen.journal_buchungen (datum);
create index if not exists journal_debit_idx on finanzen.journal_buchungen (debit_account_id);
create index if not exists journal_credit_idx on finanzen.journal_buchungen (credit_account_id);
alter table finanzen.journal_buchungen enable row level security;
comment on table finanzen.journal_buchungen is 'Spiegel /3.0/accounting/journal (UNTER VORBEHALT: Mai 2026 lieferte /3.0/accounting_journal 404). Leer, wenn sync_stand.journal.verfuegbar=false.';

create table if not exists finanzen.bankkonten (
  id int primary key,
  uuid text,
  name text,
  owner text,
  bank_name text,
  iban_nr text,
  currency_id int,
  account_id int,
  type text,
  raw jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now()
);
alter table finanzen.bankkonten enable row level security;
comment on table finanzen.bankkonten is 'Spiegel /3.0/banking/accounts (ohne Saldo — Bexio liefert keinen). Saldo = Journal-Summe ueber account_id (v_bankkonten_saldo).';

-- =====================================================================
-- 3. Sync-Verwaltung
-- =====================================================================
create table if not exists finanzen.sync_laeufe (
  id uuid primary key default gen_random_uuid(),
  gestartet timestamptz not null default now(),
  beendet timestamptz,
  art text not null check (art in ('cron', 'manuell')),
  status text not null default 'laeuft' check (status in ('laeuft', 'ok', 'teilweise', 'fehler', 'abgebrochen')),
  ausgeloest_von uuid references public.profiles(id) on delete set null,
  ergebnis jsonb not null default '{}'::jsonb,
  fehler text
);
create index if not exists sync_laeufe_gestartet_idx on finanzen.sync_laeufe (gestartet desc);
-- Doppelstart-Sperre mit DB-Garantie: hoechstens EINE Zeile mit status
-- 'laeuft' (Cron 02:30 + manueller Klick / zwei Tabs / Vercel-Retry). Der
-- Code setzt veraltete 'laeuft'-Zeilen (> 15 min) zuerst auf 'abgebrochen',
-- dann insert; Fehlercode 23505 -> SyncLaeuftFehler (409).
create unique index if not exists sync_laeufe_ein_laufender on finanzen.sync_laeufe (status) where status = 'laeuft';
alter table finanzen.sync_laeufe enable row level security;
comment on table finanzen.sync_laeufe is 'Ein Eintrag pro Sync-Lauf: insert bei Start (laeuft), ein update bei Ende. Nie loeschen. ergebnis = { entitaet: { anzahl, fehler, verfuegbar, wasserzeichen } } OHNE Betraege. Unique-Index: nur ein laeuft.';

create table if not exists finanzen.sync_stand (
  entitaet text primary key
    check (entitaet in ('kontakte','waehrungen','konten','kontengruppen','bankkonten','rechnungen','offerten','lieferantenrechnungen','journal')),
  wasserzeichen timestamptz,
  letzter_erfolg timestamptz,
  verfuegbar boolean not null default true,
  hinweis text,
  updated_at timestamptz not null default now()
);
alter table finanzen.sync_stand enable row level security;
comment on table finanzen.sync_stand is 'Wasserzeichen je Entitaet. verfuegbar=false + hinweis, wenn Bexio 403/404 liefert (Journal, Einkaufsmodul).';

insert into finanzen.sync_stand (entitaet)
values ('kontakte'),('waehrungen'),('konten'),('kontengruppen'),('bankkonten'),('rechnungen'),('offerten'),('lieferantenrechnungen'),('journal')
on conflict (entitaet) do nothing;

-- =====================================================================
-- 4. Auswertungen (Views + Funktionen). Stichtag immer Zuerich-Datum.
--    Alle Views security_invoker = on (siehe Kopf). Summen NUR in CHF.
-- =====================================================================
create or replace view finanzen.v_offene_debitoren with (security_invoker = on) as
select
  r.id as rechnung_id,
  r.document_nr,
  coalesce(
    nullif(trim(concat_ws(' ', k.name_1, k.name_2)), ''),
    'Unbekannt (#' || coalesce(r.contact_id::text, '?') || ')'
  ) as kunde,
  r.contact_id,
  r.is_valid_from as datum,
  r.is_valid_to as faellig,
  greatest(0, (timezone('Europe/Zurich', now()))::date - r.is_valid_to) as tage_ueberfaellig,
  coalesce(r.total_remaining_payments, r.total, 0) as betrag_offen,
  coalesce(r.total, 0) as betrag_total,
  r.status,
  r.mahnstufe,
  w.name as waehrung
from finanzen.rechnungen r
left join finanzen.kontakte k on k.id = r.contact_id
left join finanzen.waehrungen w on w.id = r.currency_id
where r.kb_item_status_id in (8, 16, 31)
  and coalesce(r.total_remaining_payments, r.total, 0) > 0
order by r.is_valid_to asc nulls last, r.id;
comment on view finanzen.v_offene_debitoren is 'Offene Debitoren (Bexio-Status 8 Pending, 16 Partial, 31 Unpaid) mit Restbetrag > 0 (durch Gutschrift gedeckte Pending-Rechnungen zaehlen nicht). tage_ueberfaellig gegen Zuerich-Datum, 0 wenn nicht faellig. waehrung null = unbekannt (als CHF behandelt).';

create or replace view finanzen.v_offene_kreditoren with (security_invoker = on) as
select
  l.id as bill_id,
  l.document_no,
  coalesce(
    nullif(trim(l.vendor), ''),
    nullif(trim(concat_ws(' ', l.firstname_suffix, l.lastname_company)), ''),
    'Unbekannt'
  ) as lieferant,
  l.bill_date as datum,
  l.due_date as faellig,
  greatest(0, (timezone('Europe/Zurich', now()))::date - l.due_date) as tage_ueberfaellig,
  coalesce(l.pending_amount, l.gross, 0) as betrag_offen,
  coalesce(l.gross, 0) as betrag_total,
  l.status,
  l.currency_code as waehrung
from finanzen.lieferantenrechnungen l
where l.status not in ('DRAFT', 'PAID')
  and coalesce(l.pending_amount, l.gross, 0) > 0
order by l.due_date asc nulls last, l.document_no;
comment on view finanzen.v_offene_kreditoren is 'Offene Lieferantenrechnungen (nicht DRAFT/PAID, pending_amount > 0).';

create or replace view finanzen.v_bankkonten_saldo with (security_invoker = on) as
select
  b.id as bankkonto_id,
  b.name,
  b.bank_name,
  b.iban_nr,
  b.account_id,
  k.account_no,
  coalesce(j.soll, 0) - coalesce(j.haben, 0) as saldo,
  coalesce(j.anzahl, 0)::int as buchungen_anzahl,
  j.letzte as letzte_buchung
from finanzen.bankkonten b
left join finanzen.konten k on k.id = b.account_id
left join lateral (
  select
    sum(case when jb.debit_account_id = b.account_id then jb.base_currency_amount else 0 end) as soll,
    sum(case when jb.credit_account_id = b.account_id then jb.base_currency_amount else 0 end) as haben,
    count(*) as anzahl,
    max(jb.datum) as letzte
  from finanzen.journal_buchungen jb
  where jb.debit_account_id = b.account_id or jb.credit_account_id = b.account_id
) j on true
order by b.name;
comment on view finanzen.v_bankkonten_saldo is 'Saldo = Soll - Haben (base_currency_amount) ueber alle gespiegelten Journal-Buchungen des Fibu-Kontos. Nur aussagekraeftig, wenn sync_stand.journal.verfuegbar = true und hinweis null (Journal vollstaendig).';

-- Umsatz: nur CHF-Rechnungen (currency_id unbekannt/ohne Waehrungszeile =
-- CHF), netto, ohne Gutschriften (Welle 2: kb_credit_voucher).
create or replace function finanzen.umsatz_monate(p_jahr int)
returns table (monat int, umsatz numeric, umsatz_vorjahr numeric)
language sql
stable
set search_path = finanzen, public
as $$
  with chf as (
    select r.total_net, r.is_valid_from
    from finanzen.rechnungen r
    left join finanzen.waehrungen w on w.id = r.currency_id
    where r.kb_item_status_id in (8, 9, 16, 31)
      and coalesce(w.name, 'CHF') = 'CHF'
  )
  select
    m.monat,
    coalesce((
      select sum(c.total_net) from chf c
      where extract(year from c.is_valid_from) = p_jahr
        and extract(month from c.is_valid_from) = m.monat
    ), 0) as umsatz,
    coalesce((
      select sum(c.total_net) from chf c
      where extract(year from c.is_valid_from) = p_jahr - 1
        and extract(month from c.is_valid_from) = m.monat
    ), 0) as umsatz_vorjahr
  from generate_series(1, 12) as m(monat)
  order by m.monat;
$$;
comment on function finanzen.umsatz_monate(int) is 'Umsatz netto (total_net) pro Monat, nur CHF, Basis Rechnungsdatum is_valid_from, nur gueltige Rechnungen (ohne Entwurf 7 / storniert 19), ohne Gutschriften. 12 Zeilen.';

create or replace function finanzen.kennzahlen()
returns table (
  jahr int,
  stichtag date,
  debitoren_offen_summe numeric,
  debitoren_offen_anzahl int,
  debitoren_ueberfaellig_summe numeric,
  debitoren_ueberfaellig_anzahl int,
  kreditoren_offen_summe numeric,
  kreditoren_offen_anzahl int,
  kreditoren_ueberfaellig_summe numeric,
  kreditoren_ueberfaellig_anzahl int,
  umsatz_jahr_summe numeric,
  umsatz_vorjahr_gleicher_zeitraum_summe numeric,
  fremdwaehrung_anzahl int
)
language sql
stable
set search_path = finanzen, public
as $$
  with heute as (select (timezone('Europe/Zurich', now()))::date as d),
  deb as (select * from finanzen.v_offene_debitoren where coalesce(waehrung, 'CHF') = 'CHF'),
  kred as (select * from finanzen.v_offene_kreditoren where coalesce(waehrung, 'CHF') = 'CHF'),
  chf as (
    select r.total_net, r.is_valid_from
    from finanzen.rechnungen r
    left join finanzen.waehrungen w on w.id = r.currency_id
    where r.kb_item_status_id in (8, 9, 16, 31)
      and coalesce(w.name, 'CHF') = 'CHF'
  )
  select
    extract(year from heute.d)::int,
    heute.d,
    coalesce((select sum(betrag_offen) from deb), 0),
    (select count(*)::int from deb),
    coalesce((select sum(betrag_offen) from deb where tage_ueberfaellig > 0), 0),
    (select count(*)::int from deb where tage_ueberfaellig > 0),
    coalesce((select sum(betrag_offen) from kred), 0),
    (select count(*)::int from kred),
    coalesce((select sum(betrag_offen) from kred where tage_ueberfaellig > 0), 0),
    (select count(*)::int from kred where tage_ueberfaellig > 0),
    coalesce((
      select sum(c.total_net) from chf c
      where c.is_valid_from >= date_trunc('year', heute.d)::date
        and c.is_valid_from <= heute.d
    ), 0),
    coalesce((
      select sum(c.total_net) from chf c
      where c.is_valid_from >= date_trunc('year', heute.d - interval '1 year')::date
        and c.is_valid_from <= (heute.d - interval '1 year')::date
    ), 0),
    (
      (select count(*)::int from finanzen.v_offene_debitoren where coalesce(waehrung, 'CHF') <> 'CHF')
      + (select count(*)::int from finanzen.v_offene_kreditoren where coalesce(waehrung, 'CHF') <> 'CHF')
    )
  from heute;
$$;
comment on function finanzen.kennzahlen() is 'Kennzahlen-Zeile fuer /finanzen: offene Debitoren/Kreditoren (Summe, Anzahl, davon ueberfaellig) und Umsatz netto laufendes Jahr vs Vorjahr gleicher Zeitraum — NUR CHF. fremdwaehrung_anzahl = offene Posten in anderer Waehrung (fehlen in den Summen).';

-- Wochen-Digest: Zaehlung SERVER-SEITIG (PostgREST max_rows = 1000 wuerde
-- eine JS-Gruppierung still unterzaehlen). Nur Zahlen, keine Betraege.
create or replace function finanzen.zugriffe_zaehlung(p_von timestamptz, p_bis timestamptz)
returns table (actor_label text, finanzen int, lohn int, fremde int, freigaben int, fehlversuche int)
language sql
stable
set search_path = finanzen, public
as $$
  select
    coalesce(z.actor_label, 'Unbekannt') as actor_label,
    count(*) filter (where z.bereich = 'finanzen' and z.aktion not in ('finanzen.freigabe', 'finanzen.freigabe_fehlgeschlagen'))::int as finanzen,
    count(*) filter (where z.bereich = 'lohn')::int as lohn,
    count(*) filter (where z.ziel_profile_id is not null and z.ziel_profile_id <> z.actor_profile_id)::int as fremde,
    count(*) filter (where z.aktion = 'finanzen.freigabe')::int as freigaben,
    count(*) filter (where z.aktion = 'finanzen.freigabe_fehlgeschlagen')::int as fehlversuche
  from finanzen.zugriffe z
  where z.occurred_at >= p_von and z.occurred_at < p_bis
  group by coalesce(z.actor_label, 'Unbekannt')
  order by 1;
$$;
comment on function finanzen.zugriffe_zaehlung(timestamptz, timestamptz) is 'Zaehlung pro Person fuer /api/cron/zugriffe-digest. Nur service_role.';

-- =====================================================================
-- 5. Grants: NUR service_role. Explizit auch fuer bereits angelegte Objekte.
-- =====================================================================
grant all on all tables in schema finanzen to service_role;
grant all on all sequences in schema finanzen to service_role;
revoke all on all tables in schema finanzen from public, anon, authenticated;
revoke all on all functions in schema finanzen from public, anon, authenticated;
grant execute on function finanzen.umsatz_monate(int) to service_role;
grant execute on function finanzen.kennzahlen() to service_role;
grant execute on function finanzen.zugriffe_zaehlung(timestamptz, timestamptz) to service_role;

-- PostgREST-Schema-Cache auffrischen (Supabase macht das bei DDL ohnehin;
-- harmlos doppelt).
notify pgrst, 'reload schema';
