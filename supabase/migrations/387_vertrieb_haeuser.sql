-- Vertrieb neu (Leo, 09.11.2026): die Häuser-Pipeline zieht aus der Excel
-- (~/EVENTLINE_Steuerung/EVENTLINE_Steuerung_2027.xlsx) ins FSM.
--
-- !! Nummer: höchste Migration auf main + allen Branches + 1
-- !! (Stand 09.11.2026: 386 auf main). Nur additiv (B1).
--
-- 1. vertrieb_raeume wird zur Häuser-Tabelle: Stufe, Gebiet, Prio, Bedarf
--    mit Beleg, Gruppe. Datum + Aufgabe bleiben der «nächste Schritt» und
--    erscheinen weiter im Kalender — darum keine neue Tabelle.
-- 2. vertrieb_haus_verlauf: Mails, Anrufe, Antworten, Notizen, Stufenwechsel
--    je Haus (Zeitstrahl im Haus-Profil, Takt pro Woche in der Auswertung).
-- 3. vertrieb_wochenpaket_mails: die Mails des Wochenpakets zur Freigabe.
--    Das FSM SENDET NICHTS (Leos Entscheid «Weg 1»): es merkt sich nur
--    «freigegeben». Der Mac holt freigegebene Mails ab
--    (~/EVENTLINE_Steuerung/fsm_freigabe_abholen.py), prüft sie und plant sie
--    bei Microsoft ein; danach setzt er «eingeplant». Das Postfachrecht des
--    FSM bleibt Mail.Read.
--
-- RLS (§5): alle vier Verben explizit, Admin kommt über has_permission().
-- Lesen = vertrieb:view, Schreiben = vertrieb:edit (wie Migration 365).

-- ---------------------------------------------------------------------------
-- 1. vertrieb_raeume → Häuser
-- ---------------------------------------------------------------------------
alter table public.vertrieb_raeume
  add column if not exists stufe text not null default 'recherche',
  add column if not exists gebiet text,
  add column if not exists prio text not null default 'B',
  add column if not exists gruppe text,
  add column if not exists bedarf text,
  add column if not exists bedarf_beleg text,
  add column if not exists bedarf_belegt boolean not null default false,
  -- Schlüssel aus der Excel-Pipeline, damit der Import idempotent ist.
  add column if not exists import_schluessel text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'vertrieb_raeume_stufe_check') then
    alter table public.vertrieb_raeume add constraint vertrieb_raeume_stufe_check
      check (stufe in ('recherche','bedarf','anruf','angeschrieben','gespraech','pilot','partner','absage','pause'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'vertrieb_raeume_prio_check') then
    alter table public.vertrieb_raeume add constraint vertrieb_raeume_prio_check
      check (prio in ('A','B'));
  end if;
end $$;

create unique index if not exists vertrieb_raeume_import_schluessel_idx
  on public.vertrieb_raeume (import_schluessel) where import_schluessel is not null;

-- ---------------------------------------------------------------------------
-- 2. vertrieb_haus_verlauf
-- ---------------------------------------------------------------------------
create table if not exists public.vertrieb_haus_verlauf (
  id uuid primary key default gen_random_uuid(),
  haus_id uuid not null references public.vertrieb_raeume(id) on delete cascade,
  -- Date-Only (Zurich-Tag des Ereignisses), Anzeige ohne Zeitzonen-Kippen.
  datum date not null default ((now() at time zone 'Europe/Zurich')::date),
  art text not null check (art in ('mail','anruf','antwort','notiz','stufe')),
  titel text not null check (length(btrim(titel)) > 0),
  text text,
  -- Farbe des Punkts im Zeitstrahl.
  ton text check (ton in ('rot','amber','gruen','neutral')),
  -- Schlüssel für idempotente Importe (z. B. Zeile aus versand_log.csv).
  import_schluessel text,
  erstellt_von uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists vertrieb_haus_verlauf_haus_idx
  on public.vertrieb_haus_verlauf (haus_id, datum desc, created_at desc);
create index if not exists vertrieb_haus_verlauf_datum_idx
  on public.vertrieb_haus_verlauf (datum) where art = 'mail';
create unique index if not exists vertrieb_haus_verlauf_import_idx
  on public.vertrieb_haus_verlauf (import_schluessel) where import_schluessel is not null;

alter table public.vertrieb_haus_verlauf enable row level security;

drop policy if exists vertrieb_haus_verlauf_select on public.vertrieb_haus_verlauf;
create policy vertrieb_haus_verlauf_select on public.vertrieb_haus_verlauf
  for select to authenticated using ((select public.has_permission('vertrieb:view')));

drop policy if exists vertrieb_haus_verlauf_insert on public.vertrieb_haus_verlauf;
create policy vertrieb_haus_verlauf_insert on public.vertrieb_haus_verlauf
  for insert to authenticated with check ((select public.has_permission('vertrieb:edit')));

drop policy if exists vertrieb_haus_verlauf_update on public.vertrieb_haus_verlauf;
create policy vertrieb_haus_verlauf_update on public.vertrieb_haus_verlauf
  for update to authenticated
  using ((select public.has_permission('vertrieb:edit')))
  with check ((select public.has_permission('vertrieb:edit')));

drop policy if exists vertrieb_haus_verlauf_delete on public.vertrieb_haus_verlauf;
create policy vertrieb_haus_verlauf_delete on public.vertrieb_haus_verlauf
  for delete to authenticated using ((select public.has_permission('vertrieb:edit')));

-- ---------------------------------------------------------------------------
-- 3. vertrieb_wochenpaket_mails
-- ---------------------------------------------------------------------------
create table if not exists public.vertrieb_wochenpaket_mails (
  id uuid primary key default gen_random_uuid(),
  -- z. B. 'KW46' (Ordnername in ~/EVENTLINE_Steuerung/Wochenpakete/).
  kw text not null check (kw ~ '^KW[0-9]{1,2}$'),
  haus_id uuid references public.vertrieb_raeume(id) on delete set null,
  an text not null check (length(btrim(an)) > 0),
  betreff text not null,
  text text not null,
  -- Pfad auf Leos Mac (nur Anzeige) bzw. im Bucket `documents` (Vorschau).
  anhang_pfad text,
  anhang_name text,
  anhang_bucket_pfad text,
  versand_ab timestamptz,
  -- { aufhaenger, bedarf, beleg_url, anrede_hinweis, ... } aus mails.json
  kundenblatt jsonb not null default '{}'::jsonb,
  -- [{ text, ok }] Ergebnis der Prüfungen auf dem Mac (Prüfer, Sperrliste …)
  pruefungen jsonb not null default '[]'::jsonb,
  status text not null default 'offen'
    check (status in ('offen','freigegeben','gestrichen','eingeplant','gesendet')),
  freigegeben_von uuid references public.profiles(id) on delete set null,
  freigegeben_am timestamptz,
  eingeplant_am timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kw, an)
);

create index if not exists vertrieb_wochenpaket_mails_status_idx
  on public.vertrieb_wochenpaket_mails (status, kw);

drop trigger if exists vertrieb_wochenpaket_mails_updated_at on public.vertrieb_wochenpaket_mails;
create trigger vertrieb_wochenpaket_mails_updated_at
  before update on public.vertrieb_wochenpaket_mails
  for each row execute function public.update_updated_at();

alter table public.vertrieb_wochenpaket_mails enable row level security;

drop policy if exists vertrieb_wochenpaket_mails_select on public.vertrieb_wochenpaket_mails;
create policy vertrieb_wochenpaket_mails_select on public.vertrieb_wochenpaket_mails
  for select to authenticated using ((select public.has_permission('vertrieb:view')));

-- Schreiben aus der App nur über /api/vertrieb/wochenpaket (vertrieb:edit,
-- nur offen → freigegeben/gestrichen). Die Policies erlauben vertrieb:edit,
-- die Route begrenzt die Übergänge. Anlegen/«eingeplant» macht der Mac mit
-- dem Service-Role-Key (umgeht RLS).
drop policy if exists vertrieb_wochenpaket_mails_insert on public.vertrieb_wochenpaket_mails;
create policy vertrieb_wochenpaket_mails_insert on public.vertrieb_wochenpaket_mails
  for insert to authenticated with check ((select public.has_permission('vertrieb:edit')));

drop policy if exists vertrieb_wochenpaket_mails_update on public.vertrieb_wochenpaket_mails;
create policy vertrieb_wochenpaket_mails_update on public.vertrieb_wochenpaket_mails
  for update to authenticated
  using ((select public.has_permission('vertrieb:edit')))
  with check ((select public.has_permission('vertrieb:edit')));

drop policy if exists vertrieb_wochenpaket_mails_delete on public.vertrieb_wochenpaket_mails;
create policy vertrieb_wochenpaket_mails_delete on public.vertrieb_wochenpaket_mails
  for delete to authenticated using ((select public.has_permission('vertrieb:edit')));

notify pgrst, 'reload schema';
