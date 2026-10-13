-- 316: time_off in die Realtime-Publication aufnehmen.
--
-- Zweck: Der rote Punkt bei «Anträge» (src/lib/use-nav-counts.tsx) soll
-- geraeteuebergreifend sofort stimmen. Stellt jemand am Handy einen
-- Abwesenheits-Antrag, sah ein Genehmiger auf einem anderen Geraet den Punkt
-- bisher erst beim naechsten Tab-Fokus. Der Client abonniert time_off nur,
-- wenn die Person den Punkt braucht (ferien:approve, Admin passt durch) —
-- siehe src/app/(app)/layout.tsx.
--
-- Sicherheit: Realtime liefert INSERT/UPDATE nur fuer Zeilen, die die Person
-- per RLS sehen darf (bestehende SELECT-Policies auf time_off: eigene Zeilen,
-- Team/Scope, «Genehmiger sieht alle Ferien»). DELETE-Events tragen bei
-- REPLICA IDENTITY DEFAULT nur den Primaerschluessel (id) — keine Inhalte.
-- Darum bleibt REPLICA IDENTITY bewusst DEFAULT (nicht FULL).
--
-- Nur additiv und idempotent: mehrfaches Ausfuehren ist harmlos.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'time_off'
  ) then
    execute 'alter publication supabase_realtime add table public.time_off';
  end if;
end
$$;
