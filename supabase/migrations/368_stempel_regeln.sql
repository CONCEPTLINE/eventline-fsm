-- 368: Lohn-Umbau Phase 4 — Stempel-Regeln (Teil 2, idempotent).
--
-- !! Erst einspielen, wenn der Code mit den Klartext-Meldungen live ist
-- !! (Handy/App zeigen sonst den Datenbankfehler). Reihenfolge:
-- !! supabase/lokal/live-gang-phase4/LIVE-GANG.md.
--
--   1. Keine überlappenden Stempel derselben Person (Zeitraum [Beginn, Ende),
--      Ende exklusiv; offene Stempel gelten bis «unendlich»). Datenbank-Regel
--      (Ausschluss-Bedingung, auch gegen gleichzeitige Geräte).
--      Bestehende Überlappungen (Altfälle) werden markiert und ausgenommen,
--      nie gelöscht. Live am 29.10.2026 (nur lesend geprüft): 2 Paare
--      (03.05.2026 30 min, 12.06.2026 1 min), beide ausgetretene Personen.
--   2. Stempel über 16 Stunden nur mit Begründung (lang_begruendung) —
--      gilt für neue und geänderte Stempel, nicht für den Bestand.
--
-- Schwelle 16 h: Tages- und Abendarbeit liegt nach Art. 10 Abs. 3 ArG mit
-- Pausen und Überzeit innerhalb von 14 Stunden; 2 h Reserve für Auf-/Abbau
-- bei Anlässen. Darüber ist ein Stempel praktisch immer ein vergessenes
-- Ausstempeln. Gleiche Zahl im Code: src/lib/lohn/stempel-pruefung.ts
-- (STEMPEL_LANG_STUNDEN) — das Prüfskript vergleicht beide.
--
-- Rückweg: supabase/lokal/live-gang-phase4/368_rueckweg.sql (Regeln weg,
-- Markierungen bleiben).

create extension if not exists btree_gist with schema extensions;

-- Grenze an EINER Stelle in der Datenbank.
create or replace function public.stempel_lang_grenze()
returns interval
language sql
immutable
as $$ select interval '16 hours' $$;
grant execute on function public.stempel_lang_grenze() to authenticated, service_role;

-- ===========================================================================
-- 1. Überlappung
-- ===========================================================================
do $$
declare
  v_n integer;
begin
  if not exists (select 1 from pg_constraint where conname = 'time_entries_keine_ueberlappung'
                   and conrelid = 'public.time_entries'::regclass) then
    -- Keine neuen Stempel zwischen Markieren und Regel (Stempeln wartet kurz).
    lock table public.time_entries in share row exclusive mode;
    -- Altfälle markieren (beide Stempel jedes Paares). Der Sperr-Trigger
    -- ignoriert dieses Feld; der Feldschutz lässt die Datenbank zu.
    with paare as (
      select a.id a_id, b.id b_id
        from public.time_entries a
        join public.time_entries b
          on a.user_id = b.user_id and a.id < b.id
         and tstzrange(a.clock_in, coalesce(a.clock_out, 'infinity'::timestamptz), '[)')
             && tstzrange(b.clock_in, coalesce(b.clock_out, 'infinity'::timestamptz), '[)')
       where not a.ueberlappung_altfall and not b.ueberlappung_altfall
    ), ids as (
      select a_id id from paare union select b_id from paare
    )
    update public.time_entries t set ueberlappung_altfall = true
      from ids where t.id = ids.id;
    get diagnostics v_n = row_count;
    raise notice 'Überlappung: % Stempel als Altfall markiert', v_n;

    alter table public.time_entries add constraint time_entries_keine_ueberlappung
      exclude using gist (
        user_id with =,
        tstzrange(clock_in, coalesce(clock_out, 'infinity'::timestamptz), '[)') with &&
      ) where (not ueberlappung_altfall);
  end if;
end $$;
comment on constraint time_entries_keine_ueberlappung on public.time_entries is
  'Keine überlappenden Stempel derselben Person ([Beginn, Ende), offen = bis unendlich). Altfälle (ueberlappung_altfall) ausgenommen. Phase 4, Migration 368.';

-- ===========================================================================
-- 2. Lange Stempel nur mit Begründung
-- ===========================================================================
create or replace function public.time_entries_lang_begruendung()
returns trigger
language plpgsql
as $$
begin
  if new.clock_out is not null
     and new.clock_out - new.clock_in > public.stempel_lang_grenze()
     and coalesce(trim(new.lang_begruendung), '') = ''
     and (tg_op = 'INSERT' or new.clock_in is distinct from old.clock_in or new.clock_out is distinct from old.clock_out) then
    raise exception 'time_entries: Stempel über 16 Stunden brauchen eine Begründung (Endzeit prüfen)' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.time_entries_lang_begruendung() from public, anon, authenticated;
drop trigger if exists time_entries_lang_begruendung on public.time_entries;
create trigger time_entries_lang_begruendung
  before insert or update on public.time_entries
  for each row execute function public.time_entries_lang_begruendung();
