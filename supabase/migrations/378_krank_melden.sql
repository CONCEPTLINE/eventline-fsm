-- 378 — «Krank melden» ohne Freigabe + Arztzeugnis (HR-Vereinfachung Schritt 2, 2026-11-03)
--
-- Krankmeldungen legt NUR der Server an (/api/krank, Admin-Client): Abwesenheit Typ «krank»,
-- Status «genehmigt», approved_by NULL, approved_by_name «Krankmeldung». So bleiben Kalender,
-- Lohn und Konfliktpruefung unveraendert (sie lesen «genehmigt»); eine Freigabe gibt es nicht.
--
-- Neu auf time_off (additiv, nullable/Default):
--   ende_offen                 Ende noch unbekannt («Weiss nicht»). end_date = bisher bekannter
--                              letzter Tag (anfangs «Ab»); «Wieder gesund» setzt end_date = heute
--                              und ende_offen = false.
--   arztzeugnis_pfad           Datei im privaten Bucket «arztzeugnisse» (<user_id>/<time_off_id>/…)
--   arztzeugnis_hochgeladen_at Zeitpunkt des Uploads
--   arztzeugnis_erinnert_at    einmalige Erinnerung «Bitte reiche dein Arztzeugnis nach»
--                              (Cron /api/cron/krank-tagesabschluss; nie zweimal)
--
-- Offenes Ende: der Cron (taeglich 00:05 Zuerich) zieht end_date jeden Tag auf heute nach,
-- damit Planung/Kalender/Lohn die Person nicht ab Tag 2 als verfuegbar sehen.
--
-- Bucket «arztzeugnisse» (privat, Gesundheitsdaten — DSG Art. 5): KEIN direkter Zugriff fuer
-- anon/authenticated auf allen Verben (gemeinsame RESTRICTIVE-Sperre aus 307 um den Bucket
-- erweitert). Hochladen und Ansehen nur ueber /api/krank/[id]/arztzeugnis (Admin-Client, prueft:
-- die Person selbst, ferien:approve oder Admin) mit kurzlebigen signierten URLs.
--
-- time_off INSERT-Policy enger: Mitarbeiter legen selbst nur «beantragt» ohne Entscheid an
-- (vorher konnte ein Direkt-Insert sich selbst «genehmigt» setzen). Einziger Client-Insert ist
-- /api/time-off (Status-Default «beantragt») — unveraendert gueltig.
--
-- Idempotent und additiv.

begin;

alter table public.time_off add column if not exists ende_offen boolean not null default false;
alter table public.time_off add column if not exists arztzeugnis_pfad text;
alter table public.time_off add column if not exists arztzeugnis_hochgeladen_at timestamptz;
alter table public.time_off add column if not exists arztzeugnis_erinnert_at timestamptz;

comment on column public.time_off.ende_offen is 'Krankmeldung mit unbekanntem Ende; end_date = bisher bekannter letzter Tag (Migration 378).';
comment on column public.time_off.arztzeugnis_pfad is 'Arztzeugnis im privaten Bucket arztzeugnisse; Zugriff nur ueber /api/krank (Migration 378).';

-- Insert nur als offener Antrag ohne Entscheid (Admins/Genehmiger entscheiden ueber /decide).
drop policy if exists "Eigene Ferien anlegen" on public.time_off;
create policy "Eigene Ferien anlegen" on public.time_off
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and status = 'beantragt'
    and approved_by is null
    and approved_at is null
    and decision_note is null
    and ende_offen = false
    and arztzeugnis_pfad is null
  );

-- Privater Bucket fuer Arztzeugnisse (Foto oder PDF, max. 10 MB).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('arztzeugnisse', 'arztzeugnisse', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Gemeinsame RESTRICTIVE-Sperre (307) um «arztzeugnisse» erweitern: kein select/insert/update/
-- delete fuer anon/authenticated — nur der Server (service_role) greift zu.
drop policy if exists "private_buckets_kein_direktzugriff" on storage.objects;
create policy "private_buckets_kein_direktzugriff" on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (bucket_id not in ('nas-ablage', 'lohndokumente', 'personal-dossiers', 'arztzeugnisse'))
  with check (bucket_id not in ('nas-ablage', 'lohndokumente', 'personal-dossiers', 'arztzeugnisse'));

commit;
