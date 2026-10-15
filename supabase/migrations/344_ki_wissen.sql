-- 344: Wissen der KI (Technik-Seite, Tab «Wissen»; Mischa 2026-10-16: «sollte bei Technik sein unter einem Tab
-- ‹Wissen›; bei Unklarheiten soll dort die KI auch fragen»). Nur additiv, idempotent.
--
-- a) ki_wissen — Einträge, die Admins pflegen: Kategorie (Abkürzung/Begriff, Benennungsregel, Zuordnung,
--    Ansprechpartner/Rolle, Ordner-Hinweis, Sonstiges), Begriff/Titel, Erklärung, optional Bezug auf Stammdaten
--    (Location, Kunde, Lieferant, Person — Name als Schnappschuss für Liste und KI), aktiv, wer/wann.
--    Aktive Einträge gehen in den Nacht-Kontext des Rigs (GET /api/ki/kontext, lib/ki/kontext.ts) und — nach
--    Relevanz ausgewählt — in den Claude-Prompt der Ordner-/Namenswahl im Rückstau ZZ (lib/ki/zz-entscheid.ts).
-- b) ki_wissen_fragen — Rückfragen von Claude (0–2 je Dokument), dedupliziert über `schluessel` (Art + gefalteter
--    Begriff, lib/ki/wissen.ts). status: offen → beantwortet (wird Eintrag in a)) | verworfen (Admin) | erledigt (kein
--    Dokument fragt mehr). Nie Dokumentinhalt, gleicher Sensibel-Filter wie der Beschrieb.
-- c) ki_wissen_fragen_dokumente — welche Datei die Frage gestellt hat (Zähler «betrifft n Dokumente») und ihr offener
--    Vorschlag; beim Beantworten werden die offenen, unentschiedenen Vorschläge neu berechnet.
-- d) ki_wissen_fragen_melden(…), ki_wissen_frage_beantworten(…) — je eine Transaktion, nur service_role.
--
-- Rechte: nur Admin, alle 4 Verben explizit ((select public.is_admin()), wie 329/334). Geschrieben wird über die
-- Service-Role in den Routen (requireAdmin) bzw. im Cron.

create table if not exists public.ki_wissen (
  id uuid primary key default gen_random_uuid(),
  kategorie text not null
    check (kategorie in ('abkuerzung', 'benennung', 'zuordnung', 'ansprechpartner', 'ordner', 'sonstiges')),
  begriff text not null check (char_length(btrim(begriff)) between 1 and 120),
  erklaerung text not null check (char_length(btrim(erklaerung)) between 1 and 1000),
  bezug_art text check (bezug_art in ('location', 'kunde', 'lieferant', 'person')),
  bezug_id uuid,
  bezug_name text check (char_length(bezug_name) <= 160),
  aktiv boolean not null default true,
  erstellt_von uuid references public.profiles(id) on delete set null,
  erstellt_am timestamptz not null default now(),
  geaendert_von uuid references public.profiles(id) on delete set null,
  geaendert_am timestamptz not null default now(),
  constraint ki_wissen_bezug_paar check ((bezug_art is null) = (bezug_id is null))
);
-- Ein Begriff je Kategorie nur einmal (Gross/klein egal) — eine beantwortete Frage ergänzt sonst den bestehenden.
create unique index if not exists ki_wissen_begriff_uq on public.ki_wissen (kategorie, lower(btrim(begriff)));
create index if not exists ki_wissen_aktiv on public.ki_wissen (aktiv, kategorie);

alter table public.ki_wissen enable row level security;
drop policy if exists ki_wissen_select on public.ki_wissen;
create policy ki_wissen_select on public.ki_wissen
  for select using ((select public.is_admin()));
drop policy if exists ki_wissen_insert on public.ki_wissen;
create policy ki_wissen_insert on public.ki_wissen
  for insert with check ((select public.is_admin()));
drop policy if exists ki_wissen_update on public.ki_wissen;
create policy ki_wissen_update on public.ki_wissen
  for update using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists ki_wissen_delete on public.ki_wissen;
create policy ki_wissen_delete on public.ki_wissen
  for delete using ((select public.is_admin()));

create table if not exists public.ki_wissen_fragen (
  id uuid primary key default gen_random_uuid(),
  schluessel text not null check (char_length(schluessel) between 3 and 200),
  art text not null check (art in ('abkuerzung', 'zuordnung', 'person', 'benennung', 'sonstiges')),
  begriff text check (char_length(begriff) <= 120),
  frage text not null check (char_length(btrim(frage)) between 1 and 300),
  quelle text not null default 'claude' check (quelle in ('claude', 'rig')),
  status text not null default 'offen' check (status in ('offen', 'beantwortet', 'verworfen', 'erledigt')),
  wissen_id uuid references public.ki_wissen(id) on delete set null,
  erledigt_von uuid references public.profiles(id) on delete set null,
  erledigt_am timestamptz,
  zuletzt_gefragt timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index if not exists ki_wissen_fragen_schluessel_uq on public.ki_wissen_fragen (schluessel);
create index if not exists ki_wissen_fragen_status on public.ki_wissen_fragen (status, zuletzt_gefragt desc);

alter table public.ki_wissen_fragen enable row level security;
drop policy if exists ki_wissen_fragen_select on public.ki_wissen_fragen;
create policy ki_wissen_fragen_select on public.ki_wissen_fragen
  for select using ((select public.is_admin()));
drop policy if exists ki_wissen_fragen_insert on public.ki_wissen_fragen;
create policy ki_wissen_fragen_insert on public.ki_wissen_fragen
  for insert with check ((select public.is_admin()));
drop policy if exists ki_wissen_fragen_update on public.ki_wissen_fragen;
create policy ki_wissen_fragen_update on public.ki_wissen_fragen
  for update using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists ki_wissen_fragen_delete on public.ki_wissen_fragen;
create policy ki_wissen_fragen_delete on public.ki_wissen_fragen
  for delete using ((select public.is_admin()));

create table if not exists public.ki_wissen_fragen_dokumente (
  frage_id uuid not null references public.ki_wissen_fragen(id) on delete cascade,
  pfad text not null check (char_length(pfad) <= 1000),
  vorschlag_id uuid references public.nas_vorschlaege(id) on delete set null,
  beschrieb_id uuid references public.nas_zz_beschriebe(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (frage_id, pfad)
);
create index if not exists ki_wissen_fragen_dokumente_pfad on public.ki_wissen_fragen_dokumente (pfad);
create index if not exists ki_wissen_fragen_dokumente_vorschlag on public.ki_wissen_fragen_dokumente (vorschlag_id);

alter table public.ki_wissen_fragen_dokumente enable row level security;
drop policy if exists ki_wissen_fragen_dokumente_select on public.ki_wissen_fragen_dokumente;
create policy ki_wissen_fragen_dokumente_select on public.ki_wissen_fragen_dokumente
  for select using ((select public.is_admin()));
drop policy if exists ki_wissen_fragen_dokumente_insert on public.ki_wissen_fragen_dokumente;
create policy ki_wissen_fragen_dokumente_insert on public.ki_wissen_fragen_dokumente
  for insert with check ((select public.is_admin()));
drop policy if exists ki_wissen_fragen_dokumente_update on public.ki_wissen_fragen_dokumente;
create policy ki_wissen_fragen_dokumente_update on public.ki_wissen_fragen_dokumente
  for update using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists ki_wissen_fragen_dokumente_delete on public.ki_wissen_fragen_dokumente;
create policy ki_wissen_fragen_dokumente_delete on public.ki_wissen_fragen_dokumente
  for delete using ((select public.is_admin()));

-- ── d) Rückfragen eines Dokuments melden (Cron zz-entscheide, lib/ki/zz-warteschlange.ts) ─────────────────────
-- p_fragen: [{schluessel, art, begriff, frage}] (höchstens 2, im FSM geprüft und gefiltert). Gleicher Schlüssel =
-- dieselbe Frage (nur einmal, Zähler über die Dokumente). Eine verworfene oder beantwortete Frage öffnet nie neu, eine
-- «erledigte» (kein Dokument fragte mehr) schon. Danach: Verknüpfungen dieser Datei zu OFFENEN Fragen, die sie nicht mehr
-- stellt, fallen weg; offene Fragen ohne Dokument werden «erledigt».
create or replace function public.ki_wissen_fragen_melden(
  p_pfad text, p_beschrieb_id uuid, p_vorschlag_id uuid, p_fragen jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  f jsonb;
  v_id uuid;
  v_status text;
  v_eingefuegt boolean;
  v_gefragt uuid[] := '{}';
  v_neu int := 0;
  v_erledigt int := 0;
  v_weg uuid[];
begin
  if p_pfad is null or btrim(p_pfad) = '' then
    raise exception 'pfad fehlt';
  end if;
  for f in select * from jsonb_array_elements(coalesce(p_fragen, '[]'::jsonb)) loop
    insert into public.ki_wissen_fragen (schluessel, art, begriff, frage)
    values (f->>'schluessel', f->>'art', nullif(btrim(coalesce(f->>'begriff', '')), ''), f->>'frage')
    on conflict (schluessel) do update
      set zuletzt_gefragt = now(),
          status = case when ki_wissen_fragen.status = 'erledigt' then 'offen' else ki_wissen_fragen.status end,
          erledigt_am = case when ki_wissen_fragen.status = 'erledigt' then null else ki_wissen_fragen.erledigt_am end
    returning id, status, (xmax = 0) into v_id, v_status, v_eingefuegt;
    if v_eingefuegt then
      v_neu := v_neu + 1;
    end if;
    if v_status = 'offen' then
      v_gefragt := v_gefragt || v_id;
      insert into public.ki_wissen_fragen_dokumente (frage_id, pfad, vorschlag_id, beschrieb_id)
      values (v_id, p_pfad, p_vorschlag_id, p_beschrieb_id)
      on conflict (frage_id, pfad) do update
        set vorschlag_id = excluded.vorschlag_id, beschrieb_id = excluded.beschrieb_id;
    end if;
  end loop;

  with weg as (
    delete from public.ki_wissen_fragen_dokumente d
    using public.ki_wissen_fragen q
    where d.pfad = p_pfad and q.id = d.frage_id and q.status = 'offen' and not (d.frage_id = any (v_gefragt))
    returning d.frage_id
  )
  select coalesce(array_agg(distinct frage_id), '{}') into v_weg from weg;

  update public.ki_wissen_fragen q
     set status = 'erledigt', erledigt_am = now()
   where q.id = any (v_weg) and q.status = 'offen'
     and not exists (select 1 from public.ki_wissen_fragen_dokumente d where d.frage_id = q.id);
  get diagnostics v_erledigt = row_count;

  return jsonb_build_object('neu', v_neu, 'offen', coalesce(array_length(v_gefragt, 1), 0), 'erledigt', v_erledigt);
end;
$$;

-- ── d) Frage beantworten (POST /api/technik/wissen/fragen, nur Admin) ─────────────────────────────────────────
-- Legt den Wissens-Eintrag an (gleicher Begriff in derselben Kategorie: ersetzt dessen Erklärung und Bezug, wieder
-- aktiv), schliesst die Frage und setzt die Beschriebe ihrer Dokumente mit OFFENEM, nie entschiedenem Vorschlag zurück
-- auf «wartet» — der Cron fragt Claude dann mit dem neuen Wissen nochmals (der alte Vorschlag bleibt sichtbar, bis der
-- neue da ist). Entschiedenes wird nie angefasst.
create or replace function public.ki_wissen_frage_beantworten(
  p_frage_id uuid, p_kategorie text, p_begriff text, p_erklaerung text,
  p_bezug_art text, p_bezug_id uuid, p_bezug_name text, p_von uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_wissen uuid;
  v_neu int := 0;
begin
  select status into v_status from public.ki_wissen_fragen where id = p_frage_id for update;
  if v_status is null then
    raise exception 'frage_unbekannt';
  end if;
  if v_status <> 'offen' then
    raise exception 'frage_nicht_offen';
  end if;

  insert into public.ki_wissen (kategorie, begriff, erklaerung, bezug_art, bezug_id, bezug_name, aktiv,
                                erstellt_von, geaendert_von)
  values (p_kategorie, btrim(p_begriff), btrim(p_erklaerung), p_bezug_art, p_bezug_id, p_bezug_name, true, p_von, p_von)
  on conflict (kategorie, lower(btrim(begriff))) do update
    set erklaerung = excluded.erklaerung, bezug_art = excluded.bezug_art, bezug_id = excluded.bezug_id,
        bezug_name = excluded.bezug_name, aktiv = true, geaendert_von = excluded.geaendert_von, geaendert_am = now()
  returning id into v_wissen;

  update public.ki_wissen_fragen
     set status = 'beantwortet', wissen_id = v_wissen, erledigt_von = p_von, erledigt_am = now()
   where id = p_frage_id;

  update public.nas_zz_beschriebe b
     set status = 'wartet', versuche = 0, fehler = null, updated_at = now()
    from public.ki_wissen_fragen_dokumente d
    join public.nas_vorschlaege v on v.id = d.vorschlag_id
   where d.frage_id = p_frage_id
     and v.status = 'offen' and v.entschieden_von is null
     and b.vorschlag_id = v.id and b.status = 'fertig';
  get diagnostics v_neu = row_count;

  return jsonb_build_object('wissen_id', v_wissen, 'neu_berechnen', v_neu);
end;
$$;

revoke all on function public.ki_wissen_fragen_melden(text, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ki_wissen_fragen_melden(text, uuid, uuid, jsonb) to service_role;
revoke all on function public.ki_wissen_frage_beantworten(uuid, text, text, text, text, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.ki_wissen_frage_beantworten(uuid, text, text, text, text, uuid, text, uuid) to service_role;
