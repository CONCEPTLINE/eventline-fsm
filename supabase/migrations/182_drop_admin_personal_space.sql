-- Admin-Personal-Space wieder entfernen — Feature komplett rueckgebaut
-- (Migration 151 hatte es eingefuehrt). Alle Layer weg: Tabelle, Trigger,
-- Trigger-Funktion, Realtime-Publikation.

do $$
begin
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'admin_personal_space') then
    execute 'alter publication supabase_realtime drop table public.admin_personal_space';
  end if;
end $$;

drop trigger if exists admin_personal_space_touch_trg on public.admin_personal_space;
drop function if exists public.admin_personal_space_touch();
drop table if exists public.admin_personal_space;
