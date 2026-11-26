-- 391: Interne Auftragsnotizen getrennt von den Partner-Notizen (Leo, 2026-11-26).
--
-- «Wenn wir unter einem Auftrag Notizen reinschreiben, sind diese intern und
-- gehen den Partner nichts an.» Bisher schrieb die Notizen-Karte im Firmenportal
-- in jobs.notes — dasselbe Feld liest und schreibt der Partner im Partnerportal
-- als «gemeinsame Notizen». Neu:
--   jobs.notizen_intern  interne Notizen (Firmenportal, Handy) — nie an Partner
--                        oder Lieferanten ausgeliefert
--   jobs.notes           bleibt der gemeinsame Text mit dem Partner
--
-- Backfill: Bei Auftraegen, die NICHT ein Partner angelegt hat (created_by leer
-- oder Profil-Rolle <> 'partner'), war notes immer eine interne Notiz → nach
-- notizen_intern verschieben und notes leeren. Partner-Auftraege bleiben
-- unveraendert (ihr notes ist der gemeinsame Text, den der Partner kennt).
--
-- Idempotent und nur additiv: zweiter Lauf findet keine Zeilen mehr
-- (notizen_intern ist dann gefuellt bzw. notes leer). RLS: die jobs-Policies
-- gelten automatisch fuer die neue Spalte (SELECT nur interne Benutzer);
-- Partner/Lieferanten lesen jobs nur ueber Server-Routen mit Spaltenliste.
-- updated_at bleibt beim Verschieben unveraendert (Trigger kurz aus).

begin;

alter table public.jobs add column if not exists notizen_intern text;

comment on column public.jobs.notizen_intern is
  'Interne Auftragsnotizen (Firmenportal/Handy). Nie an Partner oder Lieferanten ausliefern. jobs.notes = gemeinsamer Text mit dem Partner.';

alter table public.jobs disable trigger jobs_updated_at;

update public.jobs j
set notizen_intern = j.notes,
    notes = null
from public.jobs x
left join public.profiles p on p.id = x.created_by
where x.id = j.id
  and (x.created_by is null or p.role is distinct from 'partner')
  and nullif(btrim(x.notes), '') is not null
  and x.notizen_intern is null;

alter table public.jobs enable trigger jobs_updated_at;

commit;
