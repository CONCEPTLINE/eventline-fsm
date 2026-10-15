-- 338: (1) has_permission() und is_admin() verlangen ein AKTIVES Konto.
--      (2) angebot_upload_waisen(): verwaiste Angebots-Uploads des
--          Lieferantenportals finden (Aufraeumen in lib/lieferant-angebot).
--
-- (1) Haertung: Bisher prueften beide Funktionen nur Rolle bzw. Rechte —
-- ein deaktiviertes Konto mit noch gueltigem Zugriffs-Token haette bis zu
-- dessen Ablauf weiter Rechte gehabt (gemildert, weil Deaktivieren das Konto
-- sperrt). Neu zusaetzlich `p.is_active = true` — gleich wie is_internal_user(),
-- is_partner() und is_lieferant(); NULL zaehlt wie dort als nicht aktiv (heute
-- keine NULL-Werte, Spalte hat Default true). Sonst identisch: Signatur,
-- STABLE, SECURITY DEFINER, search_path = public; CREATE OR REPLACE behaelt
-- Besitzer und Ausfuehrungsrechte (RLS-Policies werten die Funktionen auch
-- fuer anon aus — dort ist auth.uid() null, Ergebnis false wie bisher).
--
-- (2) Der Lieferant laedt Angebote per signierter Upload-URL direkt in den
-- Storage (documents/jobs/<job>/lieferant-<id>/…); erst die Bestaetigung legt
-- die documents-Zeile an. Kommt sie nie (Tab zu, Netz weg), bleibt die Datei
-- liegen. Die Funktion liefert solche Dateien: nur in lieferant-<uuid>-
-- Ordnern, ohne documents-Zeile, aelter als 24 h (fest — laufende Uploads
-- werden nie erfasst), hoechstens 100 je Aufruf. Geloescht wird ueber die
-- Storage-API (nicht per SQL). Nur service_role darf sie ausfuehren.
--
-- Pruefen:
--   select pg_get_functiondef('public.has_permission(text)'::regprocedure);
--   select pg_get_functiondef('public.is_admin()'::regprocedure);
--   select * from public.angebot_upload_waisen(null);

create or replace function public.has_permission(perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    join public.roles r on r.slug = p.role
    where p.id = auth.uid()
      and p.is_active = true
      and (r.slug = 'admin' or r.permissions ? perm)
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and is_active = true
  );
$$;

create or replace function public.angebot_upload_waisen(p_lieferant_id uuid default null)
returns table (pfad text)
language sql
stable
security definer
set search_path = public
as $$
  select o.name
  from storage.objects o
  where o.bucket_id = 'documents'
    and o.name like 'jobs/%'
    and o.name ~ (
      '^jobs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/lieferant-'
      || coalesce(p_lieferant_id::text, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
      || '/[^/]+$'
    )
    and o.created_at < now() - interval '24 hours'
    and not exists (select 1 from public.documents d where d.storage_path = o.name)
  order by o.created_at
  limit 100;
$$;

revoke all on function public.angebot_upload_waisen(uuid) from public, anon, authenticated;
grant execute on function public.angebot_upload_waisen(uuid) to service_role;
