-- 307_nas_nur_admin.sql — NAS-Sperre: private Storage-Buckets wirklich zu
--
-- Datum: 2026-10-11. Entscheid Mischa: der GANZE NAS-Bereich ist NUR FUER
-- ADMINS (Personalakten sind dort durchsuchbar). Die NAS-Tabellen
-- (ablage_*, nas_*) sind bereits sauber auf ( select is_admin() ) gesperrt
-- (alle 4 Verben bzw. Schreiben nur service_role) — hier nichts zu tun.
--
-- Die Luecke ist der Datei-Speicher: Die «Sperr»-Policies aus 136
-- (lohndokumente_no_direct_access_*) und 138 (personal_dossiers_no_direct_access_*)
-- sind PERMISSIVE und gelten fuer anon UND authenticated. Erlaubende Policies
-- werden mit ODER verknuepft:
--   * «bucket_id <> 'lohndokumente'»     gibt nas-ablage + personal-dossiers frei,
--   * «bucket_id <> 'personal-dossiers'» gibt lohndokumente frei.
-- Ergebnis (geprueft read-only, SET LOCAL ROLE anon): jeder Bucket ist fuer
-- jeden lesbar/schreibbar/loeschbar, auch ohne Login nur mit dem oeffentlichen
-- Anon-Key. Betrifft jede vom NAS abgerufene Datei (abrufe/<id>, auch
-- Personalakten), jede Ablage-Datei (items/…, ki-tmp/…), jeden Mail-Anhang
-- (eingang/…), dazu Lohnabrechnungen und Personaldossiers.
--
-- Fix: die 8 permissiven Pseudo-Sperren weg, dafuer EINE RESTRICTIVE Policy
-- (wird mit UND verknuepft): anon/authenticated kommen an die drei privaten
-- Buckets nie direkt heran — auch Admins nicht (wie schon 138 wollte:
-- Zugriff nur ueber die API mit Audit-Moeglichkeit).
--
-- Nicht betroffen (service_role umgeht RLS, signierte URLs werden vom
-- Storage-Dienst selbst geprueft):
--   * /api/ablage/sync, /api/ablage/datei-index (NAS-Sync-Container, LIVE):
--     Admin-Client + createSignedUrl/createSignedUploadUrl
--   * /api/ablage/{upload,ki-upload,eingang,abruf}, /api/ki/sync, lib/ki/queue
--   * /api/hr/wage-documents/**, /api/admin/users/[id]{,/dossier}
-- Geprueft: kein Browser-Code greift mit dem User-Client auf diese Buckets zu.
-- Bucket documents bleibt unveraendert (4 «auth users … documents»-Policies).
--
-- Idempotent: drop … if exists, Policy wird neu angelegt.
-- NUR ALS DATEI — Einspielen: node scripts/apply-migration.mjs supabase/migrations/307_nas_nur_admin.sql
--
-- Nachpruefung nach dem Einspielen (read-only):
--   begin read only; set local role anon;
--     select bucket_id, count(*) from storage.objects group by 1;   -- 0 Zeilen
--   rollback;
--   begin read only; set local role authenticated;
--     select bucket_id, count(*) from storage.objects group by 1;   -- nur documents
--   rollback;

-- 1) Restriktive Sperre zuerst (engt nur ein, nie aus) ------------------------
drop policy if exists "private_buckets_kein_direktzugriff" on storage.objects;
create policy "private_buckets_kein_direktzugriff" on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (bucket_id not in ('nas-ablage', 'lohndokumente', 'personal-dossiers'))
  with check (bucket_id not in ('nas-ablage', 'lohndokumente', 'personal-dossiers'));

-- 2) Die permissiven Pseudo-Sperren aus 136/138 entfernen --------------------
drop policy if exists "lohndokumente_no_direct_access_select" on storage.objects;
drop policy if exists "lohndokumente_no_direct_access_insert" on storage.objects;
drop policy if exists "lohndokumente_no_direct_access_update" on storage.objects;
drop policy if exists "lohndokumente_no_direct_access_delete" on storage.objects;

drop policy if exists "personal_dossiers_no_direct_access_select" on storage.objects;
drop policy if exists "personal_dossiers_no_direct_access_insert" on storage.objects;
drop policy if exists "personal_dossiers_no_direct_access_update" on storage.objects;
drop policy if exists "personal_dossiers_no_direct_access_delete" on storage.objects;
