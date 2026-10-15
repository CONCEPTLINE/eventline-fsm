-- 336: Zaehler «offene Lieferanten-Punkte» (Tab «Technik & Plan») korrigiert.
--
-- Bisher (331) zaehlte ein Kommentar-Faden an einer ENTSCHIEDENEN
-- Rueckmeldung als offener Punkt, sobald sein letzter Beitrag vom Lieferanten
-- stammte — die Firma sieht entschiedene Punkte aber nur eingeklappt und
-- kann dort nicht antworten (Phantom-Zaehler). Neu:
--   - offene Empfehlungen + offene Probleme zaehlen je 1 (inkl. ihrer Faeden),
--   - entschiedene Rueckmeldungen zaehlen nie (auch nicht ihre Faeden),
--   - Kommentar-Faeden an Positionen zaehlen, wenn der letzte Beitrag vom
--     Lieferanten stammt (unbeantwortet).
-- Kommentare ohne Position und ohne Rueckmeldung lehnen die APIs ab (zeigt
-- keine Oberflaeche an). Signatur, security invoker, Rechte unveraendert.

create or replace function public.technik_offene_punkte(p_job_id uuid)
returns integer
language sql
stable
security invoker
set search_path = public
as $$
  with letzte as (
    -- Je Positions-Faden der juengste Beitrag (Faeden an Rueckmeldungen
    -- zaehlen nur ueber die offene Rueckmeldung selbst).
    select distinct on (k.position_id)
           coalesce(public.profil_ist_portal(k.author_id), false) as vom_portal
    from public.job_technik_kommentare k
    where k.job_id = p_job_id
      and k.review_id is null
      and k.position_id is not null
    order by k.position_id, k.created_at desc
  )
  select case
    when not coalesce((select public.is_internal_user()), false) then 0
    else (
      (select count(*) from public.job_technik_reviews r
        where r.job_id = p_job_id and r.status = 'offen')
      + (select count(*) from letzte l where l.vom_portal)
    )::integer
  end;
$$;

revoke all on function public.technik_offene_punkte(uuid) from public, anon;
grant execute on function public.technik_offene_punkte(uuid) to authenticated;
