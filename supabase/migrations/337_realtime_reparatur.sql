-- 337: Live-Aktualisierung (Supabase Realtime) reparieren.
--
-- 1) service_reports in die Publication supabase_realtime.
--    Die Auftrags-Seite abonniert die Rapport-Aenderungen IHRES Auftrags
--    (Server-Filter job_id, src/components/auftrag/tabs/use-auftrag-data.ts),
--    damit z.B. eine Unterschrift am Handy sofort am Laptop erscheint. Bisher
--    stand dieses Abo im Sammelkanal «global-invalidate», die Tabelle fehlte
--    aber in der Publication — der Server lehnte darum ALLE Abos jenes Kanals
--    ab (Auftraege, Kunden, Glocke, Zeiten, Tickets, Todos waren seit Juni 2026
--    nicht mehr live). Der Client abonniert jetzt je Tabelle einen eigenen
--    Kanal (src/lib/realtime.ts).
--    Volumen klein (Rapporte: rund 100 Aenderungen im Monat), keine Massen-
--    Schreibvorgaenge. Sicherheit: Realtime liefert INSERT/UPDATE nur fuer
--    Zeilen, die die Person per RLS sehen darf («Rapporte sind sichtbar»:
--    interne Konten, keine Portal-Konten). DELETE ist per Policy gesperrt;
--    REPLICA IDENTITY bleibt DEFAULT (Muster 316/317).
--    akquise_locations bleibt bewusst draussen: Vertrieb (Leos Session), ein
--    Suchlauf loescht und schreibt Dutzende Zeilen auf einmal, und kein
--    Bildschirm hoert zu — der Client abonniert die Tabelle nicht mehr.
--
-- 2) Presence-Kanal «app-presence» nur fuer interne Konten.
--    Der Kanal ist ab jetzt privat (Realtime Authorization, Client:
--    src/lib/use-online-presence.tsx). Beitreten/Lesen (SELECT) und sich als
--    online melden (INSERT = presence track) nur, wenn is_internal_user() —
--    Portal-Konten (Partner, Lieferant) bekamen ueber den Kanal die IDs aller
--    online Mitarbeiter. UPDATE/DELETE haben bewusst keine Policy und bleiben
--    damit gesperrt (RLS auf realtime.messages ist aktiv). Andere Kanaele sind
--    von diesen Policies nicht betroffen (alle anderen sind oeffentlich).
--
-- Nur additiv und idempotent: mehrfaches Ausfuehren ist harmlos.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'service_reports'
  ) then
    execute 'alter publication supabase_realtime add table public.service_reports';
  end if;
end
$$;

drop policy if exists "app_presence_intern_lesen" on realtime.messages;
create policy "app_presence_intern_lesen"
  on realtime.messages
  for select
  to authenticated
  using (
    realtime.topic() = 'app-presence'
    and realtime.messages.extension = 'presence'
    and (select public.is_internal_user())
  );

drop policy if exists "app_presence_intern_melden" on realtime.messages;
create policy "app_presence_intern_melden"
  on realtime.messages
  for insert
  to authenticated
  with check (
    realtime.topic() = 'app-presence'
    and realtime.messages.extension = 'presence'
    and (select public.is_internal_user())
  );
