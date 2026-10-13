-- 317: tickets und todos in die Realtime-Publication aufnehmen.
--
-- Zweck: Das (app)/layout abonniert tickets und todos schon lange
-- (Kanal «global-invalidate» → Events realtime:tickets / realtime:todos),
-- die Tabellen waren aber nie in supabase_realtime — die Events kamen nie an.
-- Folge: Die roten Punkte bei «Todos», «Tickets & Belege» und der
-- Stempel-Korrektur-Teil von «Anträge» (src/lib/use-nav-counts.tsx) sowie
-- die Handy-Listen (todos-mobil, tickets-mobil) aktualisierten erst beim
-- naechsten Tab-Fokus. service_reports und akquise_locations bleiben bewusst
-- draussen (kein roter Punkt; Akquise gehoert Leos Session).
--
-- Sicherheit: RLS ist auf beiden Tabellen aktiv (je 2 SELECT-Policies);
-- Realtime liefert INSERT/UPDATE nur fuer Zeilen, die die Person sehen darf.
-- DELETE-Events tragen bei REPLICA IDENTITY DEFAULT nur die id — bleibt so.
--
-- Nur additiv und idempotent (Muster wie 316).

do $$
declare
  t text;
begin
  foreach t in array array['tickets', 'todos'] loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;
