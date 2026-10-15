-- 331: Technik-Workflow Firma + Lieferantenportal (2026-10-15)
--
-- Eingespielt NACH dem Deploy von 3c96b49c (Code ohne «frage», ohne
-- job_technik_positionen.sort/anforderung_id). Idempotent.
--
-- 1. Rueckmeldungs-Art «Frage» entfaellt (Leo 2026-10-15: Fragen laufen
--    ueber Kommentare). Live gab es keine Rueckmeldung der Art 'frage'.
-- 2. job_technik_aktivitaet in die Realtime-Publication: Technik-Tab und
--    Zaehler am Tab aktualisieren sich live (Lesen regelt die RLS: intern
--    und Auftrag sichtbar, Migration 330).
-- 3. «Seit letzter Anfrage geaendert»:
--    - job_lieferanten.vorige_angefragt_at = Zeitpunkt der vorherigen
--      Anfrage-Runde (Bezug fuer die Neu/Geaendert-Markierung im Portal)
--    - job_technik_positionen.inhalt_geaendert_at = letzte inhaltliche
--      Aenderung (Menge/Bezeichnung/Details), per Trigger fuer JEDEN
--      Schreibweg (Tab, KI, uebernommene Empfehlung)
-- 4. technik_offene_punkte(job_id): offene Lieferanten-Punkte fuer den Tab
--    «Technik & Plan» = offene Empfehlungen + offene Probleme + Kommentar-
--    Faeden, deren letzter Beitrag vom Lieferanten stammt (unbeantwortet)
--    und die nicht an einer offenen Rueckmeldung haengen (sonst doppelt).
--    security invoker: die RLS der Technik-Tabellen entscheidet; zusaetzlich
--    nur fuer interne Konten (is_internal_user). Kein Execute fuer anon.
-- 5. Ungenutzte Spalten entfernt: job_technik_positionen.sort und
--    .anforderung_id (nie befuellt, Code seit 3c96b49c ohne Bezug).

-- 1. Review-Art ohne «frage» --------------------------------------------
alter table public.job_technik_reviews drop constraint if exists job_technik_reviews_art_check;
alter table public.job_technik_reviews
  add constraint job_technik_reviews_art_check check (art in ('empfehlung', 'problem'));

-- 2. Realtime ---------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'job_technik_aktivitaet'
  ) then
    alter publication supabase_realtime add table public.job_technik_aktivitaet;
  end if;
end $$;

-- 3. Aenderungs-Bezug ------------------------------------------------------
alter table public.job_lieferanten add column if not exists vorige_angefragt_at timestamptz;
alter table public.job_technik_positionen add column if not exists inhalt_geaendert_at timestamptz;

create or replace function public.technik_position_inhalt_geaendert()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.menge is distinct from old.menge
     or new.bezeichnung is distinct from old.bezeichnung
     or new.details is distinct from old.details then
    new.inhalt_geaendert_at := now();
  end if;
  return new;
end;
$$;
revoke all on function public.technik_position_inhalt_geaendert() from public, anon;

drop trigger if exists job_technik_positionen_inhalt on public.job_technik_positionen;
create trigger job_technik_positionen_inhalt
  before update on public.job_technik_positionen
  for each row execute function public.technik_position_inhalt_geaendert();

-- 4. Offene Lieferanten-Punkte (Zaehler am Tab) ----------------------------
create or replace function public.technik_offene_punkte(p_job_id uuid)
returns integer
language sql
stable
security invoker
set search_path = public
as $$
  with letzte as (
    -- Je Kommentar-Faden (an einer Rueckmeldung, sonst an einer Position,
    -- sonst allgemein) der juengste Beitrag.
    select distinct on (coalesce(k.review_id, k.position_id))
           k.review_id,
           coalesce(public.profil_ist_portal(k.author_id), false) as vom_portal
    from public.job_technik_kommentare k
    where k.job_id = p_job_id
    order by coalesce(k.review_id, k.position_id), k.created_at desc
  )
  select case
    when not coalesce((select public.is_internal_user()), false) then 0
    else (
      (select count(*) from public.job_technik_reviews r
        where r.job_id = p_job_id and r.status = 'offen')
      + (select count(*) from letzte l
          where l.vom_portal
            and not exists (
              select 1 from public.job_technik_reviews r
              where r.id = l.review_id and r.status = 'offen'))
    )::integer
  end;
$$;
revoke all on function public.technik_offene_punkte(uuid) from public, anon;
grant execute on function public.technik_offene_punkte(uuid) to authenticated;

-- 5. Ungenutzte Spalten ----------------------------------------------------
alter table public.job_technik_positionen drop column if exists sort;
alter table public.job_technik_positionen drop column if exists anforderung_id;
