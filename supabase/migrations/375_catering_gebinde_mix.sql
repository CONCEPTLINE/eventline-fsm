-- 375: Getränke-Catering — Gebinde, Erfahrungs-Mix und echte Rupp-Einkaufspreise (Leo 2026-11-02).
--
-- Die Bestellliste muss in den Gebinden rechnen, in denen bestellt werden kann, und der Mix muss die Erfahrung abbilden
-- (Bier am meisten, Softdrinks am wenigsten).
--
-- 1. catering_getraenke.gebinde_stueck / gebinde_name: Stück pro Gebinde (z. B. 24, «Harass»). Leer = ohne Gebinde.
-- 2. Mix je Sorte (Summe 100 %): Bier 40 (Birra Moretti 32, alkoholfrei 8), Softdrinks 20 (Eptinger rot 6, blau 6,
--    Coca-Cola 6, Zero 2), Weisswein 12.5, Rotwein 12.5, Aperol 15. Vorher: Bier 35, Softdrinks 35, Wein 20, Aperol 10.
-- 3. Einkaufspreise nach Rupp-Shop (Mehrweg-Harass à 24, Depot CHF 12.20 pro Harass kommt bei Rückgabe zurück, deshalb
--    kein Kostenbestandteil): Birra Moretti und alkoholfrei CHF 1.95 pro Flasche (vorher 1.85), Coca-Cola und Zero im
--    Glas CHF 1.57 (vorher 1.20 als Mischwert). Eptinger bleibt bei 1.20 (im Shop nicht abrufbar, bitte prüfen).
-- 4. Gebinde: Bier, Eptinger, Cola je Harass à 24; Weinflaschen Karton à 6 (Annahme, bitte prüfen).
-- 5. catering_stammdaten_speichern() kennt die neuen Felder.
--
-- ACHTUNG: Mix und Einkauf ändern die Kalkulation. Für INT-26404 (90 Gäste) steigen die Kosten von 719 auf 778, der
-- Mindestumsatz von 800 auf 860 und der Richtwert A von 2080 auf 2160. Idempotent: Werte werden gesetzt, nicht addiert.

alter table public.catering_getraenke add column if not exists gebinde_stueck integer;
alter table public.catering_getraenke add column if not exists gebinde_name text;
alter table public.catering_getraenke drop constraint if exists catering_getraenke_gebinde_check;
alter table public.catering_getraenke add constraint catering_getraenke_gebinde_check check (
  (gebinde_stueck is null or gebinde_stueck between 1 and 1000)
  and (gebinde_name is null or char_length(btrim(gebinde_name)) between 1 and 20)
);

-- Mix, Einkauf, Gebinde (nur Zeilen, die es mit diesem Namen gibt)
update public.catering_getraenke set mix_anteil = 0.32,  einkauf = 1.95, gebinde_stueck = 24, gebinde_name = 'Harass' where kategorie = 'bier'      and name = 'Birra Moretti'             and einheit = '33 cl';
update public.catering_getraenke set mix_anteil = 0.08,  einkauf = 1.95, gebinde_stueck = 24, gebinde_name = 'Harass' where kategorie = 'bier'      and name = 'Birra Moretti, alkoholfrei' and einheit = '33 cl';
update public.catering_getraenke set mix_anteil = 0.06,                  gebinde_stueck = 24, gebinde_name = 'Harass' where kategorie = 'softdrink' and name = 'Eptinger rot';
update public.catering_getraenke set mix_anteil = 0.06,                  gebinde_stueck = 24, gebinde_name = 'Harass' where kategorie = 'softdrink' and name = 'Eptinger blau';
update public.catering_getraenke set mix_anteil = 0.06,  einkauf = 1.57, gebinde_stueck = 24, gebinde_name = 'Harass' where kategorie = 'softdrink' and name = 'Coca-Cola';
update public.catering_getraenke set mix_anteil = 0.02,  einkauf = 1.57, gebinde_stueck = 24, gebinde_name = 'Harass' where kategorie = 'softdrink' and name = 'Coca-Cola Zero';
update public.catering_getraenke set mix_anteil = 0.125 where kategorie in ('weisswein', 'rotwein') and einheit like 'Glas%';
update public.catering_getraenke set mix_anteil = 0.15  where kategorie = 'aperitif' and name = 'Aperol Spritz';
update public.catering_getraenke set gebinde_stueck = 6, gebinde_name = 'Karton' where kategorie in ('weisswein', 'rotwein') and einheit like 'Flasche%';

-- Speicherfunktion (aus 374) mit den neuen Feldern
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

  delete from public.catering_getraenke where id <> all (v_ids);

  for z in select * from jsonb_array_elements(p_karte) loop
    if z->>'id' is not null then
      update public.catering_getraenke set
        kategorie = z->>'kategorie', name = btrim(z->>'name'), einheit = btrim(coalesce(z->>'einheit', '')),
        verkauf = (z->>'verkauf')::numeric, einkauf = (z->>'einkauf')::numeric,
        mix_anteil = (z->>'mixAnteil')::numeric, aktiv = coalesce((z->>'aktiv')::boolean, true),
        gebinde_stueck = (z->>'gebindeStueck')::integer, gebinde_name = nullif(btrim(coalesce(z->>'gebindeName', '')), ''),
        sort = (z->>'sort')::integer, updated_at = now()
      where id = (z->>'id')::uuid;
      get diagnostics v_n = row_count;
      if v_n = 0 then
        raise exception 'Getränk % existiert nicht mehr — bitte Seite neu laden', z->>'id';
      end if;
    else
      insert into public.catering_getraenke (kategorie, name, einheit, verkauf, einkauf, mix_anteil, aktiv, gebinde_stueck, gebinde_name, sort)
      values (z->>'kategorie', btrim(z->>'name'), btrim(coalesce(z->>'einheit', '')), (z->>'verkauf')::numeric,
              (z->>'einkauf')::numeric, (z->>'mixAnteil')::numeric, coalesce((z->>'aktiv')::boolean, true),
              (z->>'gebindeStueck')::integer, nullif(btrim(coalesce(z->>'gebindeName', '')), ''), (z->>'sort')::integer);
    end if;
  end loop;
end;
$$;
revoke all on function public.catering_stammdaten_speichern(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.catering_stammdaten_speichern(jsonb, jsonb) to service_role;
