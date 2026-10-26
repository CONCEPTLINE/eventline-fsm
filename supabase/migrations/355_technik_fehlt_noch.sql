-- 355: Technik — «Fehlt noch» je Positionsgruppe (Leo 2026-10-26: «was fehlt
-- sind z. B. die Längen für Kabel oder Ständer … in der Mail steht nichts von
-- Ständern für die Mikrofone, aber wie sollen die halten?»).
--
-- job_technik_hinweise = kurze Hinweise/Fragen zu technisch noetigen, aber
-- NICHT genannten Angaben oder Komponenten einer Positionsgruppe
-- («Mikrofon-Halterung fehlt – Stative oder Galgen?», «Kabellänge Bühne →
-- Mischpult?»). Bewusst KEINE Einzelpositionen: Positionen entstehen weiter
-- nur aus Kundenaussagen (CLAUDE.md B3). Nur fuer EVENTLINE — das
-- Lieferantenportal zeigt sie nicht, die Zahl am Tab zaehlt sie nicht.
--
--   gruppe_id            → job_anforderungen, ON DELETE CASCADE
--   status               offen | erledigt | verworfen
--   created_via          ki | manuell (wie job_anforderungen/-positionen)
--   quelle_item_id       Eingang-Element, aus dem die KI den Hinweis hat
--   manuell_geaendert_at von Hand abgehakt/verworfen/wieder geoeffnet → die
--                        Eingang-KI fasst den Hinweis nie mehr an
--   erledigt_von/_at     wer/wann erledigt oder verworfen (KI: erledigt_von null)
--   erledigt_item_id     Eingang-Element, das den Hinweis beantwortet hat (KI)
--
-- RLS wie die uebrigen Technik-Tabellen (Migration 330): lesen = internes
-- Konto UND Auftrag sichtbar; schreiben zusaetzlich has_permission
-- ('auftraege:edit') (Admins automatisch). Alle 4 Verben, anon gesperrt.
-- Archiv-Schutz (Migration 342) und Realtime (Technik-Tab laedt nach).
-- NUR additiv (B1), idempotent.

create table if not exists public.job_technik_hinweise (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  gruppe_id uuid not null references public.job_anforderungen(id) on delete cascade,
  text text not null,
  status text not null default 'offen',
  created_via text not null default 'manuell',
  quelle_item_id uuid references public.job_inbox_items(id) on delete set null,
  manuell_geaendert_at timestamptz,
  erledigt_von uuid references public.profiles(id) on delete set null,
  erledigt_at timestamptz,
  erledigt_item_id uuid references public.job_inbox_items(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint job_technik_hinweise_text_check check (char_length(btrim(text)) between 1 and 300),
  constraint job_technik_hinweise_status_check check (status in ('offen', 'erledigt', 'verworfen')),
  constraint job_technik_hinweise_via_check check (created_via in ('ki', 'manuell'))
);

create index if not exists job_technik_hinweise_job_idx on public.job_technik_hinweise(job_id);
create index if not exists job_technik_hinweise_gruppe_idx on public.job_technik_hinweise(gruppe_id);

-- Hinweis und Gruppe gehoeren zum selben Auftrag (job_id traegt die RLS).
create or replace function public.technik_hinweis_auftrag()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_job uuid;
begin
  select g.job_id into v_job from public.job_anforderungen g where g.id = new.gruppe_id;
  if v_job is distinct from new.job_id then
    raise exception 'Hinweis und Position gehören nicht zum selben Auftrag';
  end if;
  return new;
end;
$$;
revoke all on function public.technik_hinweis_auftrag() from public, anon, authenticated;

drop trigger if exists job_technik_hinweise_auftrag on public.job_technik_hinweise;
create trigger job_technik_hinweise_auftrag
  before insert or update of job_id, gruppe_id on public.job_technik_hinweise
  for each row execute function public.technik_hinweis_auftrag();

-- RLS (Muster Migration 330) -----------------------------------------------
alter table public.job_technik_hinweise enable row level security;

drop policy if exists job_technik_hinweise_select on public.job_technik_hinweise;
create policy job_technik_hinweise_select on public.job_technik_hinweise
  for select to authenticated using (
    (select public.is_internal_user())
    and exists (select 1 from public.jobs j where j.id = job_technik_hinweise.job_id)
  );

drop policy if exists job_technik_hinweise_insert on public.job_technik_hinweise;
create policy job_technik_hinweise_insert on public.job_technik_hinweise
  for insert to authenticated with check (
    (select public.is_internal_user())
    and (select public.has_permission('auftraege:edit'))
    and exists (select 1 from public.jobs j where j.id = job_technik_hinweise.job_id)
  );

drop policy if exists job_technik_hinweise_update on public.job_technik_hinweise;
create policy job_technik_hinweise_update on public.job_technik_hinweise
  for update to authenticated using (
    (select public.is_internal_user())
    and (select public.has_permission('auftraege:edit'))
    and exists (select 1 from public.jobs j where j.id = job_technik_hinweise.job_id)
  ) with check (
    (select public.is_internal_user())
    and (select public.has_permission('auftraege:edit'))
    and exists (select 1 from public.jobs j where j.id = job_technik_hinweise.job_id)
  );

drop policy if exists job_technik_hinweise_delete on public.job_technik_hinweise;
create policy job_technik_hinweise_delete on public.job_technik_hinweise
  for delete to authenticated using (
    (select public.is_internal_user())
    and (select public.has_permission('auftraege:edit'))
    and exists (select 1 from public.jobs j where j.id = job_technik_hinweise.job_id)
  );

revoke all on public.job_technik_hinweise from anon;

-- Archiv = nur lesen (Migration 342) ----------------------------------------
drop trigger if exists archiv_schutz on public.job_technik_hinweise;
create trigger archiv_schutz
  before insert or update or delete on public.job_technik_hinweise
  for each row execute function public.archiv_schutz_kind(
    'auftrag', 'job_id',
    'Der Auftrag ist archiviert (abgeschlossen oder storniert) und kann nur noch gelesen werden.'
  );

-- Realtime: der offene Technik-Tab laedt nach, wenn die Eingang-KI Hinweise
-- anlegt oder als beantwortet abhakt (ohne Aktivitaets-Eintrag — die
-- Aktivitaet sieht auch der Lieferant).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'job_technik_hinweise'
  ) then
    alter publication supabase_realtime add table public.job_technik_hinweise;
  end if;
end $$;
