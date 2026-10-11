-- 302: Rig-Masterplan lokale KI, Etappe 1 (docs/lokale-ki/MASTERPLAN.md §4 «N»).
-- Nur additiv, idempotent.
--
-- a) ki_auftraege.prioritaet: Abhol-Reihenfolge der Nicht-Diktate
--    (order by prioritaet desc, created_at). Gesetzt beim Anlegen aus
--    KI_PRIORITAET (src/lib/ki/konstanten.ts): diktat 100, nas_suche 90,
--    archiv_frage 80, alle uebrigen 50. Diktate holt /api/ki/sync weiter in
--    einer eigenen ersten Abfrage (unveraendert); fuer die bisherigen Arten
--    bleibt die Reihenfolge gleich (Diktate zuerst, dann FIFO).
-- b) ki_status.eilig_bis: POST /api/ki/wach setzt jetzt + 90 s; solange
--    pollt das Rig alle 300 ms statt alle 2 s (adaptiver Abholtakt).
-- c) ki_status.arten: Faehigkeiten-Meldung des Rigs (Poll-Parameter
--    `arten`); null = altes Rig = nur die vier Basis-Arten.
-- d) ki_auftraege_select (288) ersetzt: die fluechtigen Arten nas_suche
--    und archiv_frage (Suchbegriffe, Archiv-Fragen und -Antworten, auch zu
--    Personalakten) sind ueber PostgREST fuer NIEMANDEN lesbar — auch nicht
--    fuer Admins auf einem nicht vertrauten Geraet. Gelesen werden sie nur
--    von der Service-Role in den eigenen Routen (/api/ki/suche,
--    /api/ki/archiv/[id] mit Geraetesperre und «nur eigener Auftrag»).
--    Schreiben bleibt wie in 288 nur der Service-Role vorbehalten.

alter table public.ki_auftraege add column if not exists prioritaet smallint not null default 50;

-- Bestehende offene Diktate (falls beim Einspielen welche warten) vorziehen.
update public.ki_auftraege set prioritaet = 100
where art = 'diktat' and status = 'offen' and prioritaet = 50;

create index if not exists idx_ki_auftraege_abholung
  on public.ki_auftraege (status, prioritaet desc, created_at);

alter table public.ki_status
  add column if not exists eilig_bis timestamptz,
  add column if not exists arten text[];

drop policy if exists ki_auftraege_select on public.ki_auftraege;
create policy ki_auftraege_select on public.ki_auftraege
  for select to authenticated
  using (
    (created_by = (select auth.uid()) or (select public.is_admin()))
    and art not in ('nas_suche', 'archiv_frage')
  );
