-- Nachschärfung zu 271: Storage-Keys vertragen keine Umlaute/Sonderzeichen
-- (Supabase-Restriktion) — die Datei liegt deshalb unter neutralem Key
-- 'items/<id>', die ECHTEN Namen (Ordnerpfad + Ablage-Name, inkl. Umlaute)
-- stehen in ablage_items und gehen per Sync-API ans NAS.
-- synced_at = wann der NAS-Sync die Datei abgeholt hat (null = wartet).

alter table public.ablage_items
  add column if not exists synced_at timestamptz;

create index if not exists idx_ablage_items_unsynced
  on public.ablage_items (created_at) where synced_at is null;
