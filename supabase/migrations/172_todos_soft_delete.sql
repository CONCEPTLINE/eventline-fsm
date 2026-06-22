-- Soft-Delete fuer Todos.
--
-- Bisher: 'Loeschen' war ein hartes DB-DELETE -> Todo war komplett weg,
-- inkl. Audit-Trail (wer/wann/warum). Im Archiv tauchten nur 'erledigte'
-- Todos auf, geloeschte gar nicht.
--
-- Neu: deleted_at-Timestamp markiert ein Todo als 'geloescht'. Das Todo
-- bleibt in der DB, taucht im Archiv mit rotem 'Geloescht'-Tag auf,
-- aktive Liste filtert deleted_at IS NULL aus. Wiederherstellung
-- moeglich (Admin via UI oder DB-Update).
--
-- deleted_by speichert wer geloescht hat — fuer Nachvollziehbarkeit.

alter table public.todos
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.profiles(id) on delete set null;

-- Partial-Index: aktive Sicht (haeufigster Query) braucht is-null-check.
create index if not exists todos_active_idx
  on public.todos (status, due_date)
  where deleted_at is null;
