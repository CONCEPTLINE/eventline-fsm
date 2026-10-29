-- RÜCKWEG zu Migration 357 (Lohn-Schutz, Fassungen, Gerätefreigabe).
--
-- Bei einem Code-Rollback reicht in aller Regel 358_rueckweg.sql: der alte
-- Code läuft mit 357 weiter (zusätzliche Spalten/Tabellen stören ihn nicht).
-- Mit 357 bleiben die Schutz-Trigger aktiv — der alte Code kann dann z. B.
-- keine Lohnabrechnung mehr überschreiben («Alle neu erstellen»/«Generieren»
-- auf vorhandenem Monat brechen mit Fehler ab) und keine Person mit Lohndaten
-- löschen. Das ist gewollt (Daten bleiben sicher).
--
-- Diese Datei NUR, wenn 357 selbst ein Problem verursacht. Sie entfernt die
-- Trigger und Funktionen und stellt get_monthly_payroll_stats und die alte
-- Aktionsliste des Rechte-Protokolls wieder her. Neue Tabellen und Spalten
-- (lohn_dokument_protokoll, lohn_lauf, lohn_einstellungen, lohn_dossiers,
-- wage_documents.version/archived_*/superseded_*, trusted_devices.approved_by …)
-- BLEIBEN — sie enthalten Protokoll und Aufbewahrungsdaten und stören alten Code nicht.
-- Die Browser-Rechte auf trusted_devices werden NICHT wiederhergestellt (der
-- Browser hat sie nie gebraucht; sie erlaubten die Selbst-Freischaltung).
-- Reihenfolge: zuerst 358_rueckweg.sql, dann diese Datei. Idempotent.

-- Schutz-Trigger
drop trigger if exists wage_documents_lohn_schutz on public.wage_documents;
drop trigger if exists wage_documents_lohn_schutz_pfad on public.wage_documents;
drop trigger if exists lohn_dokument_protokoll_lohn_schutz on public.lohn_dokument_protokoll;
drop trigger if exists lohn_dossiers_lohn_schutz on public.lohn_dossiers;
drop trigger if exists lohn_lauf_lohn_schutz on public.lohn_lauf;
drop trigger if exists employee_compensation_lohn_schutz on public.employee_compensation;
drop trigger if exists time_entries_lohn_schutz_loeschen on public.time_entries;
drop trigger if exists time_entries_lohn_schutz_person on public.time_entries;
drop trigger if exists time_off_lohn_schutz on public.time_off;
drop trigger if exists time_off_lohn_schutz_entscheid on public.time_off;
drop trigger if exists payroll_defaults_lohn_schutz on public.payroll_defaults;
drop trigger if exists profiles_lohn_schutz on public.profiles;

drop function if exists public.lohn_schutz_nie_loeschen();
drop function if exists public.lohn_schutz_fassung_pfad();
drop function if exists public.lohn_schutz_lohnzeile();
drop function if exists public.lohn_schutz_stempel();
drop function if exists public.lohn_schutz_abwesenheit();
drop function if exists public.lohn_schutz_abwesenheit_entscheid();
drop function if exists public.lohn_schutz_firmensaetze();
drop function if exists public.lohn_schutz_profil();

-- RPCs (der Phase-1-Code braucht sie; nach diesem Rückweg nur alter Code)
drop function if exists public.lohn_fassung_speichern(uuid, text, integer, integer, text, bigint, text, uuid, text, text, boolean, jsonb);
drop function if exists public.lohn_dokument_archivieren(uuid, uuid, text, text);
drop function if exists public.lohn_dokument_wiederherstellen(uuid, uuid, text, text);
drop function if exists public.lohn_lauf_starten(text);
drop function if exists public.geraet_notfreigabe(uuid, text, text);

-- get_monthly_payroll_stats: Rechteprüfung wie vor 357 (nur Browser-Aufruf)
do $$
declare
  v_def text;
begin
  select pg_get_functiondef('public.get_monthly_payroll_stats(date)'::regprocedure) into v_def;
  if position('''service_role'' or public.is_admin()' in v_def) > 0 then
    v_def := replace(v_def,
      'if not (coalesce(auth.role(), '''') = ''service_role'' or public.is_admin() or public.has_permission(''lohn:manage'')) then',
      'if not (public.is_admin() or public.has_permission(''lohn:manage'')) then');
    execute v_def;
  end if;
end $$;

-- Rechte-Protokoll: alte Aktionsliste nur, wenn noch keine neuen Aktionen
-- protokolliert sind (Protokolleinträge werden nie gelöscht).
do $$
begin
  if not exists (
    select 1 from public.permission_audit_log
     where action not in ('role.created', 'role.updated', 'role.deleted', 'user.role_changed', 'user.permissions_changed')
  ) then
    alter table public.permission_audit_log drop constraint if exists permission_audit_log_action_check;
    alter table public.permission_audit_log add constraint permission_audit_log_action_check check (action = any (array[
      'role.created', 'role.updated', 'role.deleted', 'user.role_changed', 'user.permissions_changed'
    ]::text[]));
  end if;
end $$;
