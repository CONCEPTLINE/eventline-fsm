-- Admin-Personal-Space: jeder Admin hat eine eigene Notiz-Zeile mit
-- Zielen + Notizen. Andere Admins koennen ALLES lesen (-> "synchronisiert
-- zwischen Admins"), aber nur den eigenen Eintrag bearbeiten.
--
-- Use Case: persoenliche Quartals-Ziele + Mental-Notes der Sales-/
-- Geschaeftsfuehrungs-Ebene, transparent gegenueber den anderen Admins
-- damit Leo+Mischa+Raul wissen woran der jeweils andere arbeitet, ohne
-- Mail-Pingpong.

create table if not exists public.admin_personal_space (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  goals      text not null default '',
  notes      text not null default '',
  updated_at timestamptz not null default now()
);

create or replace function public.admin_personal_space_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists admin_personal_space_touch_trg on public.admin_personal_space;
create trigger admin_personal_space_touch_trg
  before update on public.admin_personal_space
  for each row execute function public.admin_personal_space_touch();

alter table public.admin_personal_space enable row level security;

-- SELECT: nur Admins koennen ueberhaupt was sehen. Nicht-Admins kriegen
-- via RLS einen leeren Result -> Component rendert sich eh nur fuer Admins.
drop policy if exists "admin_space_select_admins" on public.admin_personal_space;
create policy "admin_space_select_admins" on public.admin_personal_space
  for select to authenticated
  using (public.is_admin());

drop policy if exists "admin_space_insert_own" on public.admin_personal_space;
create policy "admin_space_insert_own" on public.admin_personal_space
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_admin());

drop policy if exists "admin_space_update_own" on public.admin_personal_space;
create policy "admin_space_update_own" on public.admin_personal_space
  for update to authenticated
  using (user_id = auth.uid() and public.is_admin())
  with check (user_id = auth.uid() and public.is_admin());

-- Realtime: jeder Admin sieht die Aenderungen der anderen live.
alter publication supabase_realtime add table public.admin_personal_space;
