-- 341: Realtime-Kanaele «live:<user-id>» und «livedoc:<doc-id>» privat.
--
-- Bisher oeffentlich: Wer den oeffentlichen anon-Schluessel (steht im
-- Browser-Bundle) und eine Personen-ID kannte, konnte im Browser dieser
-- Person das Sperr-Overlay «… arbeitet gerade an deinem Konto» ausloesen,
-- Navigation erzwingen und Feldwerte setzen (Live-Modus der «Ansicht als»);
-- mit einer Dokument-ID ein Live-Dokument mitlesen oder veraendern.
-- Muster wie «app-presence» (Migration 337): Policies auf realtime.messages,
-- der Client tritt mit config.private = true bei.
--
-- live:<user-id> — Live-Modus der «Ansicht als» (src/components/dev/live-*):
--   Empfaenger = das Konto selbst, in seinem eigenen Browser
--   (live-broadcast-receiver, nur empfangen). Sender = Admin mit
--   Entwickler-Modus (live-broadcast-sender, beitreten + senden) — dieselbe
--   Bedingung wie /api/dev/impersonate (src/lib/api-auth.ts).
--     Lesen/Beitreten: eigenes Thema ODER live_modus_steuern()
--     Senden:          nur live_modus_steuern()
--
-- livedoc:<doc-id> — Live-Dokumente (src/components/projekt/live-doc):
--     Lesen/Beitreten: wer die Zeile in project_docs sehen darf — geprueft
--                      ueber die bestehende RLS der Tabelle (pdocs_select)
--     Senden:          wer das Dokument bearbeiten darf — livedoc_bearbeitbar()
--                      bildet pdocs_update (Migration 231) nach
--   Nur-Lese-Konten senden darum nichts (auch kein syncreq); fehlende
--   Aenderungen laedt der Client aus dem gespeicherten Stand nach.
--
-- UPDATE/DELETE auf realtime.messages haben bewusst keine Policy und bleiben
-- gesperrt. Nur additiv und idempotent.

create or replace function public.live_modus_steuern()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
      and p.is_active = true
      and p.developer_mode_enabled = true
  );
$$;

comment on function public.live_modus_steuern() is
  'Darf den Live-Modus der «Ansicht als» steuern: echter Admin mit Entwickler-Modus (wie /api/dev/impersonate). Policies live_modus_* auf realtime.messages (Migration 341).';

create or replace function public.livedoc_bearbeitbar(p_thema text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(p_thema like 'livedoc:%', false)
    and (select public.is_internal_user())
    and exists (
      select 1
      from public.project_docs d
      join public.projects p on p.id = d.project_id
      where d.id::text = substr(p_thema, 9)
        and not p.is_deleted
        and (
          (select public.is_admin())
          or (select public.has_permission('projekte:approve'))
          or (select public.has_permission('projekte:see-all'))
          or p.created_by = (select auth.uid())
          or p.assigned_to = (select auth.uid())
          or exists (
            select 1 from public.project_members pm
            where pm.project_id = p.id and pm.user_id = (select auth.uid())
          )
        )
    );
$$;

comment on function public.livedoc_bearbeitbar(text) is
  'Darf im Kanal livedoc:<doc-id> senden = darf das Dokument bearbeiten; bildet die Policy pdocs_update auf project_docs nach (Migration 231). Bei Aenderungen an pdocs_update mitziehen. Policy livedoc_bearbeiten (Migration 341).';

-- Nicht ohne Login aufrufbar (Muster Migration 320).
revoke execute on function public.live_modus_steuern() from public, anon;
revoke execute on function public.livedoc_bearbeitbar(text) from public, anon;
grant execute on function public.live_modus_steuern() to authenticated;
grant execute on function public.livedoc_bearbeitbar(text) to authenticated;

-- ---------------------------------------------------------------- live:<id>
drop policy if exists "live_modus_lesen" on realtime.messages;
create policy "live_modus_lesen"
  on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() like 'live:%'
    and (
      realtime.topic() = 'live:' || (select auth.uid())::text
      or (select public.live_modus_steuern())
    )
  );

drop policy if exists "live_modus_senden" on realtime.messages;
create policy "live_modus_senden"
  on realtime.messages
  for insert
  to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() like 'live:%'
    and (select public.live_modus_steuern())
  );

-- ------------------------------------------------------------- livedoc:<id>
drop policy if exists "livedoc_lesen" on realtime.messages;
create policy "livedoc_lesen"
  on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() like 'livedoc:%'
    -- als die Person selbst: die RLS von project_docs (pdocs_select) entscheidet
    and exists (
      select 1 from public.project_docs d
      where d.id::text = substr(realtime.topic(), 9)
    )
  );

drop policy if exists "livedoc_bearbeiten" on realtime.messages;
create policy "livedoc_bearbeiten"
  on realtime.messages
  for insert
  to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() like 'livedoc:%'
    and (select public.livedoc_bearbeitbar(realtime.topic()))
  );
