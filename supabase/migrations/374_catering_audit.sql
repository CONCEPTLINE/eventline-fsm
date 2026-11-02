-- 374: Getränke-Catering — Audit-Korrekturen (Leo/Claude 2026-11-02, nach unabhängigem Review).
--
-- 1. Rechte: Einkaufspreise, Personalkosten und Gewinn sind intern. Die Policies aus 372 liessen jede Rolle mit
--    einstellungen:view zu (das Recht ist auch an Nicht-Admins vergebbar, z. B. Techniker). Neu nur is_admin()
--    (Migration 053, kanonische Definition von «Admin»). Die App-Routen laufen über den Service-Key und sind davon
--    nicht betroffen; es geht nur um direkte Zugriffe mit dem Nutzer-Token.
-- 2. Stundensatz Variante A (CHF pro Servicekraft und Stunde, Verkauf an die Kundschaft) ist jetzt eine Einstellung
--    statt einer Zahl im Code (catering_einstellungen.stundensatz_a, Standard 45).
-- 3. Aufräumen: catering_einstellungen.aufschlag_a (Variante A rechnet ohne Aufschlag) sowie
--    job_catering.auftraggeber/auftraggeber_adresse (Migration 373; Name und Adresse kommen live aus dem Auftrag)
--    werden von keinem deployten Code mehr gebraucht und entfernt (B1: erst nach dem Deploy, der sie nicht mehr nutzt).
-- 4. catering_stammdaten_speichern(): Einstellungen und Karte in EINER Transaktion speichern (vorher mehrere
--    Einzelschritte: bei einem Abbruch hätte die Karte halb gespeichert dastehen können, mit zwei Mix-Zeilen).
--    Nur für den Service-Key aufrufbar.
--
-- Idempotent; Schema-Änderungen nur an Spalten, die nirgends mehr gelesen oder geschrieben werden.

-- 2. + 3. Einstellungen -----------------------------------------------------------
alter table public.catering_einstellungen add column if not exists stundensatz_a numeric(8,2) not null default 45;
alter table public.catering_einstellungen drop constraint if exists catering_einstellungen_check;
alter table public.catering_einstellungen drop column if exists aufschlag_a;
alter table public.catering_einstellungen add constraint catering_einstellungen_check check (
  lohn_pro_stunde >= 0 and stundensatz_a >= 0 and gaeste_pro_kraft >= 1 and puffer >= 0
  and anteil_vor between 0 and 1 and anteil_pause between 0 and 1 and anteil_nach between 0 and 1
  and rate_vor >= 0 and rate_pause >= 0 and rate_nach >= 0
);

alter table public.job_catering drop constraint if exists job_catering_texte_check;
alter table public.job_catering drop column if exists auftraggeber;
alter table public.job_catering drop column if exists auftraggeber_adresse;
alter table public.job_catering add constraint job_catering_texte_check check (
  anlass is null or char_length(btrim(anlass)) between 1 and 120
);

-- 1. Rechte: nur Admins --------------------------------------------------------------
drop policy if exists catering_getraenke_select on public.catering_getraenke;
create policy catering_getraenke_select on public.catering_getraenke for select to authenticated using ((select public.is_admin()));
drop policy if exists catering_getraenke_insert on public.catering_getraenke;
create policy catering_getraenke_insert on public.catering_getraenke for insert to authenticated with check ((select public.is_admin()));
drop policy if exists catering_getraenke_update on public.catering_getraenke;
create policy catering_getraenke_update on public.catering_getraenke for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists catering_getraenke_delete on public.catering_getraenke;
create policy catering_getraenke_delete on public.catering_getraenke for delete to authenticated using ((select public.is_admin()));

drop policy if exists catering_einstellungen_select on public.catering_einstellungen;
create policy catering_einstellungen_select on public.catering_einstellungen for select to authenticated using ((select public.is_admin()));
drop policy if exists catering_einstellungen_insert on public.catering_einstellungen;
create policy catering_einstellungen_insert on public.catering_einstellungen for insert to authenticated with check ((select public.is_admin()));
drop policy if exists catering_einstellungen_update on public.catering_einstellungen;
create policy catering_einstellungen_update on public.catering_einstellungen for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists catering_einstellungen_delete on public.catering_einstellungen;
create policy catering_einstellungen_delete on public.catering_einstellungen for delete to authenticated using ((select public.is_admin()));

drop policy if exists job_catering_select on public.job_catering;
create policy job_catering_select on public.job_catering for select to authenticated
  using ((select public.is_admin()) and exists (select 1 from public.jobs j where j.id = job_catering.job_id));
drop policy if exists job_catering_insert on public.job_catering;
create policy job_catering_insert on public.job_catering for insert to authenticated
  with check ((select public.is_admin()) and exists (select 1 from public.jobs j where j.id = job_catering.job_id));
drop policy if exists job_catering_update on public.job_catering;
create policy job_catering_update on public.job_catering for update to authenticated
  using ((select public.is_admin()) and exists (select 1 from public.jobs j where j.id = job_catering.job_id))
  with check ((select public.is_admin()) and exists (select 1 from public.jobs j where j.id = job_catering.job_id));
drop policy if exists job_catering_delete on public.job_catering;
create policy job_catering_delete on public.job_catering for delete to authenticated
  using ((select public.is_admin()) and exists (select 1 from public.jobs j where j.id = job_catering.job_id));

-- 4. Atomares Speichern von Einstellungen und Karte ------------------------------------
create or replace function public.catering_stammdaten_speichern(p_einstellungen jsonb, p_karte jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  z jsonb;
  v_ids uuid[];
  v_n integer;
begin
  insert into public.catering_einstellungen (
    id, lohn_pro_stunde, stundensatz_a, gaeste_pro_kraft, puffer,
    anteil_vor, rate_vor, anteil_pause, rate_pause, anteil_nach, rate_nach, updated_at
  ) values (
    true,
    (p_einstellungen->>'lohnProStunde')::numeric, (p_einstellungen->>'stundensatzA')::numeric,
    (p_einstellungen->>'gaesteProKraft')::integer, (p_einstellungen->>'puffer')::numeric,
    (p_einstellungen->>'anteilVor')::numeric, (p_einstellungen->>'rateVor')::numeric,
    (p_einstellungen->>'anteilPause')::numeric, (p_einstellungen->>'ratePause')::numeric,
    (p_einstellungen->>'anteilNach')::numeric, (p_einstellungen->>'rateNach')::numeric, now()
  )
  on conflict (id) do update set
    lohn_pro_stunde = excluded.lohn_pro_stunde, stundensatz_a = excluded.stundensatz_a,
    gaeste_pro_kraft = excluded.gaeste_pro_kraft, puffer = excluded.puffer,
    anteil_vor = excluded.anteil_vor, rate_vor = excluded.rate_vor,
    anteil_pause = excluded.anteil_pause, rate_pause = excluded.rate_pause,
    anteil_nach = excluded.anteil_nach, rate_nach = excluded.rate_nach, updated_at = now();

  select coalesce(array_agg((e->>'id')::uuid) filter (where e->>'id' is not null), '{}'::uuid[])
    into v_ids from jsonb_array_elements(p_karte) e;

  -- zuerst entfernen, was nicht mehr gesendet wird (verhindert kurzzeitig zwei Mix-Zeilen)
  delete from public.catering_getraenke where id <> all (v_ids);

  for z in select * from jsonb_array_elements(p_karte) loop
    if z->>'id' is not null then
      update public.catering_getraenke set
        kategorie = z->>'kategorie', name = btrim(z->>'name'), einheit = btrim(coalesce(z->>'einheit', '')),
        verkauf = (z->>'verkauf')::numeric, einkauf = (z->>'einkauf')::numeric,
        mix_anteil = (z->>'mixAnteil')::numeric, aktiv = coalesce((z->>'aktiv')::boolean, true),
        sort = (z->>'sort')::integer, updated_at = now()
      where id = (z->>'id')::uuid;
      get diagnostics v_n = row_count;
      if v_n = 0 then
        raise exception 'Getränk % existiert nicht mehr — bitte Seite neu laden', z->>'id';
      end if;
    else
      insert into public.catering_getraenke (kategorie, name, einheit, verkauf, einkauf, mix_anteil, aktiv, sort)
      values (z->>'kategorie', btrim(z->>'name'), btrim(coalesce(z->>'einheit', '')), (z->>'verkauf')::numeric,
              (z->>'einkauf')::numeric, (z->>'mixAnteil')::numeric, coalesce((z->>'aktiv')::boolean, true), (z->>'sort')::integer);
    end if;
  end loop;
end;
$$;
revoke all on function public.catering_stammdaten_speichern(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.catering_stammdaten_speichern(jsonb, jsonb) to service_role;
