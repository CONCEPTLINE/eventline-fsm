-- 351 — Ablage (NAS), Firmenwissen der KI und Technik-Dashboard sind nach Trust one gezogen
-- (https://one.trust-group.ch, Bereich «eventline-gmbh»): die ERP-Reste in der Datenbank entfernen.
--
-- ERST ANWENDEN, WENN ALLES HIER ERFUELLT IST — vorher NICHT:
--   1. Der ERP-Code ohne Ablage/Technik ist deployt (/api/version zeigt den Rueckbau-Commit). Bis dahin lesen und
--      schreiben Seiten, Crons und Rig-Routen diese Tabellen noch.
--   2. Rig (Sync + Ablage-KI) und NAS-Backup melden an Trust one, nicht mehr ans ERP.
--   3. Die Daten sind nach Trust one kopiert und dort geprueft (Kopier-Skript, Zaehlungen verglichen).
--   4. Ein Datenexport der unten geloeschten Tabellen ist gesichert (z. B. pg_dump --table=… oder die naechtliche
--      NAS-Sicherung des Vortags liegt vor).
-- DROP ist endgueltig. Idempotent (if exists) — ein zweiter Lauf aendert nichts.
-- Einspielen: node scripts/apply-migration.mjs supabase/migrations/351_ablage_technik_nach_trust_one.sql
--
-- BLEIBT im ERP:
--   - ki_auftraege, ki_status: lokale KI fuer Diktat, Beleg- und Warenkorb-Erkennung (lib/ki/queue, /api/ki/sync).
--   - Bucket «nas-ablage»: nur noch Uebergabe-Praefix ki-tmp/ (lib/ki/konstanten KI_BUCKET); die gemeinsame
--     RESTRICTIVE-Sperre private_buckets_kein_direktzugriff (Migration 307) bleibt unveraendert.
--   - Event-Technik: job_technik_*, technik_planung, technik_offene_punkte(), technik_position_inhalt_geaendert().
--
-- Live geprueft am 24.10.2026: notifications.type hat keinen CHECK (technik_alarm stand nur im Code), keine Views,
-- keine Realtime-Publikation und keine Fremd-FKs auf die geloeschten Tabellen; 8 Mitteilungen technik_alarm.

begin;

-- 1. Funktionen (lesen/schreiben die Tabellen unten; Signaturen wie in der ERP-DB)
drop function if exists public.technik_leistung(timestamptz);
drop function if exists public.technik_reihe(text, timestamptz, timestamptz, integer, text[]);
drop function if exists public.technik_verdichten();
drop function if exists public.ki_wissen_frage_beantworten(uuid, text, text, text, text, uuid, text, uuid);
drop function if exists public.ki_wissen_fragen_melden(text, uuid, uuid, jsonb);

-- 2. Ablage / NAS (Migrationen 271–283, 303, 304, 329, 334) — cascade nimmt FKs untereinander, Policies, Indizes
--    und eigene Sequenzen (nas_doppel_id_seq) mit.
drop table if exists public.ablage_abrufe cascade;
drop table if exists public.ablage_datei_index cascade;
drop table if exists public.ablage_eingang cascade;
drop table if exists public.ablage_fristen cascade;
drop table if exists public.ablage_moves cascade;
drop table if exists public.ablage_ordner cascade;
drop table if exists public.ablage_renames cascade;
drop table if exists public.ablage_sync_status cascade;
drop table if exists public.nas_ablage_lernbeispiele cascade;
drop table if exists public.nas_doppel_behalten cascade;
drop table if exists public.nas_doppel cascade;
drop table if exists public.nas_vorschlaege cascade;
drop table if exists public.nas_zz_beschriebe cascade;
drop table if exists public.ablage_items cascade;

-- 3. NAS-Sicherung (Migration 274) — Meldungen und Waechter laufen jetzt in Trust one.
drop table if exists public.nas_backup_alerts cascade;
drop table if exists public.nas_backup_runs cascade;

-- 4. Firmenwissen der KI (Migration 344)
drop table if exists public.ki_wissen_fragen_dokumente cascade;
drop table if exists public.ki_wissen_fragen cascade;
drop table if exists public.ki_wissen cascade;

-- 5. Technik-Dashboard (Migrationen 313, 318)
drop table if exists public.technik_ereignisse cascade;
drop table if exists public.technik_messwerte cascade;
drop table if exists public.technik_stand cascade;
drop table if exists public.technik_steuerung cascade;
drop table if exists public.technik_stunden cascade;
drop table if exists public.technik_zustaende cascade;

-- 6. Mitteilungen des Technik-Dashboards (Typ im Code entfernt) und allfaellige Kanal-Einstellungen dazu.
delete from public.notifications where type = 'technik_alarm';
update public.user_notification_settings
   set channels = channels - 'technik_alarm'
 where jsonb_typeof(channels) = 'object' and channels ? 'technik_alarm';

-- 7. Warteschlange der lokalen KI: nur noch die ERP-Arten.
--    Altbestand der Ablage-Arten (ablage_analyse, vorschau, nas_suche, archiv_frage) loeschen — die bedient Trust one.
delete from public.ki_auftraege where art not in ('diktat', 'beleg_analyse', 'warenkorb_analyse');
--    Lesen (Migration 302) nur noch fuer die ERP-Arten (Whitelist statt der alten Ausnahme nas_suche/archiv_frage).
drop policy if exists ki_auftraege_select on public.ki_auftraege;
create policy ki_auftraege_select on public.ki_auftraege
  for select to authenticated
  using (
    (created_by = (select auth.uid()) or (select public.is_admin()))
    and art in ('diktat', 'beleg_analyse', 'warenkorb_analyse')
  );
--    ki_status: «eilig_bis» (POST /api/ki/wach der NAS-Suche) und «arten» (Faehigkeiten fuer die Ablage-Arten,
--    Migration 302) liest im ERP niemand mehr.
alter table public.ki_status drop column if exists eilig_bis;
alter table public.ki_status drop column if exists arten;

commit;
