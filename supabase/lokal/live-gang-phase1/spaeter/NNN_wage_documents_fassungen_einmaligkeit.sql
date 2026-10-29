-- NNN: Lohn-Umbau — Einmaligkeits-Regel auf wage_documents durch «eine gültige
-- Fassung je Periode» ersetzen.
--
-- NICHT im Phase-1-Lauf. Erst einspielen, wenn der fassungsfähige Code
-- (Migration 360 + Phase-1-Code, RPC lohn_fassung_speichern) auf Live läuft
-- und mindestens ein Lauf/Generieren damit erfolgreich war. Dann diese Datei
-- mit der dann freien Nummer nach supabase/migrations/ verschieben.
-- !! Nummer beim Zusammenführen prüfen.
--
-- Wirkung: Neue Fassungen werden eigene Zeilen (version 2, 3, …); die
-- Vorgänger bekommen superseded_at/superseded_by und bleiben erhalten.
-- Der Code funktioniert mit UND ohne diese Migration (getestet lokal).
-- Rückweg: Index weg + Regel wieder anlegen — geht nur, solange es je
-- Periode nur EINE Zeile gibt (sonst erst entscheiden, welche Zeilen bleiben;
-- nie löschen, der Löschschutz-Trigger verhindert es ohnehin).

alter table public.wage_documents drop constraint if exists wage_doc_unique_per_period;

-- Altlast (Befund 49): Lohnausweise ohne Monat konnten doppelt hochgeladen
-- werden (NULL fällt nicht unter die alte Regel). Je Periode bleibt die
-- jüngste gültig, ältere werden «ersetzt» markiert (nicht gelöscht).
with r as (
  select id,
         row_number() over w as rn,
         first_value(id) over w as neueste
    from public.wage_documents
   where archived_at is null and superseded_at is null
  window w as (partition by profile_id, doc_type, year, coalesce(period_month, 0)
               order by uploaded_at desc, id desc)
)
update public.wage_documents d
   set superseded_at = now(), superseded_by = r.neueste
  from r
 where d.id = r.id and r.rn > 1;

create unique index if not exists wage_documents_eine_gueltige_fassung
  on public.wage_documents (profile_id, doc_type, year, coalesce(period_month, 0))
  where archived_at is null and superseded_at is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wage_documents_superseded_by_fkey') then
    alter table public.wage_documents
      add constraint wage_documents_superseded_by_fkey
      foreign key (superseded_by) references public.wage_documents(id) on delete restrict;
  end if;
end $$;
