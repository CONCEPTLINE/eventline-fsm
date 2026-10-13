-- 318: Technik-Dashboard — Luefter-Profil des Rigs (docs/technik-dashboard/VERTRAG.md §2.5).
-- Eine Zeile: das gewuenschte Profil (leise · ausgewogen · kuehl). Admins setzen es auf /technik
-- (POST /api/technik/steuerung), das Rig holt es mit der Antwort auf POST /api/technik/messwerte
-- (alle 60 s) und meldet das uebernommene Profil als rig.kuehlung.profil_aktiv zurueck.
-- RLS: lesen und aendern nur Admins (Praedikat wie 313), anlegen und loeschen niemand
-- (nur service_role). Alle 4 Verben explizit. Idempotent, nur additiv.

create table if not exists public.technik_steuerung (
  id smallint primary key default 1 check (id = 1),
  luefter_profil text not null default 'ausgewogen' check (luefter_profil in ('leise', 'ausgewogen', 'kuehl')),
  geaendert_von uuid references public.profiles(id) on delete set null,
  geaendert_am timestamptz
);

-- Seed: Standard «ausgewogen». Eine schon vorhandene Zeile (und damit die Wahl eines Admins) bleibt.
insert into public.technik_steuerung (id, luefter_profil, geaendert_am)
values (1, 'ausgewogen', now())
on conflict (id) do nothing;

alter table public.technik_steuerung enable row level security;

drop policy if exists "technik_steuerung_select" on public.technik_steuerung;
create policy "technik_steuerung_select" on public.technik_steuerung
  for select using ((select public.is_admin()));
drop policy if exists "technik_steuerung_insert" on public.technik_steuerung;
create policy "technik_steuerung_insert" on public.technik_steuerung
  for insert with check (false);
drop policy if exists "technik_steuerung_update" on public.technik_steuerung;
create policy "technik_steuerung_update" on public.technik_steuerung
  for update using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "technik_steuerung_delete" on public.technik_steuerung;
create policy "technik_steuerung_delete" on public.technik_steuerung
  for delete using (false);
