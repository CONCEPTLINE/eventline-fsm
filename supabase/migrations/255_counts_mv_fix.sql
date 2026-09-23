-- AKTIVER BUG (im Skalierbarkeits-Audit entdeckt): vertrieb_counts
-- wurde irgendwann von einer Materialized View zu einer normalen View —
-- refresh_dashboard_counts() wirft seither bei JEDEM Lauf einen Fehler
-- ("is not a table or materialized view"), der Minuten-Cron failte
-- still und auftraege_counts wurde nie mehr aktualisiert.
--
-- Fix: (1) auftraege_counts mit id-Spalte + Unique-Index neu, damit
-- REFRESH CONCURRENTLY moeglich ist (kein ACCESS-EXCLUSIVE-Lock mehr,
-- der bei jedem Refresh alle Leser blockiert). (2) Funktion refresht
-- nur noch die echte MV. Cron-Intervall via vercel.json auf */5 gesenkt.

drop materialized view if exists public.auftraege_counts;
create materialized view public.auftraege_counts as
  select
    1 as id,
    (count(*) filter (where status = 'anfrage' and (cancelled_as_anfrage is null or cancelled_as_anfrage = false)))::integer as anfrage,
    (count(*) filter (where status = 'offen'))::integer as offen,
    (count(*) filter (where status = 'offen' and was_anfrage = true))::integer as offen_vermietung,
    (count(*) filter (where status = 'abgeschlossen'))::integer as abgeschlossen,
    (count(*) filter (where status = 'storniert' and (cancelled_as_anfrage is null or cancelled_as_anfrage = false)))::integer as storniert,
    (count(*) filter (where status = 'entwurf'))::integer as entwurf
  from public.jobs
  where is_deleted is not true;

create unique index auftraege_counts_pk on public.auftraege_counts (id);
grant select on public.auftraege_counts to authenticated;

create or replace function public.refresh_dashboard_counts()
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  refresh materialized view concurrently public.auftraege_counts;
end;
$$;

-- Einmal initial fuellen (CONCURRENTLY braucht einen ersten normalen
-- Refresh nicht — create hat sie schon befuellt).
select public.refresh_dashboard_counts();
