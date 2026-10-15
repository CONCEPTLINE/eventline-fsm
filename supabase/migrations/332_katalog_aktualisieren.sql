-- 332_katalog_aktualisieren.sql
-- Katalog-Neuimport AKTUALISIERT statt zu ersetzen (2026-10-15).
--
-- Bisher loeschte der erste Import-Abschnitt alle KI-Artikel der Firma und
-- legte sie neu an: Technik-Positionen verloren ihre artikel_id, alle
-- Produktbilder (bild_path) gingen verloren. Neu bleibt jeder Artikel, der
-- wieder im PDF steht, dieselbe Zeile (id, bild_path, Verweise bleiben):
--
--   * artikelnummer — falls der Katalog eine fuehrt; wird zuerst zugeordnet.
--   * match_key     — stabile Identitaet je Firma: 'a:<nummer>' bzw.
--                     'n:<normalisierter Name>'; steht derselbe Name mehrfach
--                     im Katalog (gleicher Artikel in zwei Kapiteln), haengt
--                     '#2', '#3' … an. VOLLER Unique-Constraint (lieferant_id,
--                     match_key) — ON CONFLICT funktioniert nicht mit einem
--                     partiellen Index. NULL bei manuell erfassten Artikeln.
--   * import_lauf   — letzter Import-Lauf, der den Artikel gesehen hat.
--
--   katalog_import_abschnitt(lieferant, lauf, artikel[]) ordnet einen
--   Seitenabschnitt atomar zu: Artikelnummer → normalisierter Name (in
--   Katalog-Reihenfolge, je Lauf jede Zeile hoechstens einmal), aktualisiert
--   Texte/Preise/Reihenfolge, legt Neues an.
--   katalog_import_abschluss(lieferant, lauf) DEAKTIVIERT (loescht nicht)
--   Artikel, die der Lauf nicht mehr gesehen hat — nur wenn der Lauf
--   mindestens einen Artikel erkannt hat (leeres/kaputtes PDF raeumt nichts
--   ab) und kein zweiter Import derselben Firma gleichzeitig lief.
--
-- Die Funktionen sind nur fuer den Server (service_role, /api/ai/katalog-
-- import). Idempotent; nur additiv (Live-Code ohne match_key bricht nicht:
-- NULL-Werte verletzen den Unique-Constraint nicht).
--
-- Lieferanten-Rollen-Matrix entfernt (Code 2026-10-15): verbliebene
-- lieferant:*-Rechte in roles waeren tot — werden entfernt (heute keine).

-- 1. Spalten ---------------------------------------------------------------
alter table public.lieferant_katalog_artikel add column if not exists artikelnummer text;
alter table public.lieferant_katalog_artikel add column if not exists match_key text;
alter table public.lieferant_katalog_artikel add column if not exists import_lauf uuid;

comment on column public.lieferant_katalog_artikel.match_key is
  'Stabile Identitaet je Firma fuer den Katalog-Neuimport (a:<nummer> / n:<name>[#n]); NULL bei manuellen Artikeln.';
comment on column public.lieferant_katalog_artikel.import_lauf is
  'Letzter Katalog-Import-Lauf, der den Artikel im PDF gesehen hat.';

-- 2. Normalisierung (eine Quelle fuer Backfill und Import) ----------------
-- Kleinschreibung, Unicode-NFKC, alles ausser Buchstaben/Ziffern wird ein
-- Leerzeichen: «DJ Set „Klein“» und «DJ Set "Klein"» ergeben denselben Schluessel.
create or replace function public.katalog_name_key(p text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select btrim(regexp_replace(lower(normalize(coalesce(p, ''), NFKC)), '[^[:alnum:]]+', ' ', 'g'))
$$;

-- Artikelnummer ohne Trenner/Leerzeichen ('Art.-Nr. 12-34' → '1234' nur
-- wenn der Import die reine Nummer liefert); leer → NULL.
create or replace function public.katalog_nr_key(p text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(regexp_replace(lower(normalize(coalesce(p, ''), NFKC)), '[^[:alnum:]]+', '', 'g'), '')
$$;

-- 3. Backfill bestehender KI-Artikel (Katalog-Reihenfolge = sort) ----------
with k as (
  select id,
         'n:' || public.katalog_name_key(name) as basis,
         row_number() over (
           partition by lieferant_id, public.katalog_name_key(name)
           order by sort, created_at, id
         ) as nr
  from public.lieferant_katalog_artikel
  where source = 'ki' and match_key is null
)
update public.lieferant_katalog_artikel a
   set match_key = case when k.nr = 1 then k.basis else k.basis || '#' || k.nr end
  from k
 where a.id = k.id;

-- 4. Voller Unique-Constraint ---------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'lka_lieferant_match_key_uniq'
       and conrelid = 'public.lieferant_katalog_artikel'::regclass
  ) then
    alter table public.lieferant_katalog_artikel
      add constraint lka_lieferant_match_key_uniq unique (lieferant_id, match_key);
  end if;
end $$;

-- 5. Import-Abschnitt zuordnen --------------------------------------------
create or replace function public.katalog_import_abschnitt(
  p_lieferant_id uuid,
  p_lauf uuid,
  p_artikel jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  a jsonb;
  v_name text;
  v_nk text;
  v_nr text;
  v_nrk text;
  v_id uuid;
  v_basis text;
  v_key text;
  v_n int;
  v_zeilen int;
  v_neu int := 0;
  v_aktualisiert int := 0;
begin
  if p_lieferant_id is null or p_lauf is null or p_artikel is null or jsonb_typeof(p_artikel) <> 'array' then
    raise exception 'katalog_import_abschnitt: ungueltige Parameter';
  end if;
  -- Ein Import je Firma zur selben Zeit (zwei Fenster/Personen) — sonst
  -- koennten zwei Laeufe dieselbe Zeile gleichzeitig zuordnen.
  perform pg_advisory_xact_lock(hashtextextended('katalog_import:' || p_lieferant_id::text, 0));

  for a in select value from jsonb_array_elements(p_artikel) loop
    v_name := left(btrim(coalesce(a->>'name', '')), 300);
    continue when v_name = '';
    v_nk := public.katalog_name_key(v_name);
    v_nr := nullif(left(btrim(coalesce(a->>'artikelnummer', '')), 60), '');
    v_nrk := public.katalog_nr_key(v_nr);
    v_id := null;

    -- (1) gleiche Artikelnummer, in diesem Lauf noch nicht zugeordnet
    if v_nrk is not null then
      select x.id into v_id
        from public.lieferant_katalog_artikel x
       where x.lieferant_id = p_lieferant_id and x.source = 'ki'
         and public.katalog_nr_key(x.artikelnummer) = v_nrk
         and x.import_lauf is distinct from p_lauf
       order by x.sort, x.created_at, x.id
       limit 1;
    end if;
    -- (2) gleicher normalisierter Name, in Katalog-Reihenfolge
    if v_id is null then
      select x.id into v_id
        from public.lieferant_katalog_artikel x
       where x.lieferant_id = p_lieferant_id and x.source = 'ki'
         and public.katalog_name_key(x.name) = v_nk
         and x.import_lauf is distinct from p_lauf
       order by x.sort, x.created_at, x.id
       limit 1;
    end if;

    if v_id is not null then
      update public.lieferant_katalog_artikel set
        name           = v_name,
        artikelnummer  = coalesce(v_nr, artikelnummer),
        hauptkategorie = left(coalesce(nullif(btrim(a->>'hauptkategorie'), ''), 'Diverses'), 60),
        kategorie      = left(coalesce(nullif(btrim(a->>'kategorie'), ''), 'Sonstiges'), 120),
        beschreibung   = nullif(a->>'beschreibung', ''),
        inhalt         = nullif(a->>'inhalt', ''),
        preis_chf      = nullif(a->>'preis_chf', '')::numeric(10,2),
        preis_text     = nullif(a->>'preis_text', ''),
        sort           = coalesce(nullif(a->>'sort', '')::int, sort),
        is_active      = true,
        import_lauf    = p_lauf,
        updated_at     = now()
      where id = v_id;
      v_aktualisiert := v_aktualisiert + 1;
    else
      v_basis := case when v_nrk is not null then 'a:' || v_nrk else 'n:' || v_nk end;
      v_key := v_basis;
      v_n := 1;
      while exists (
        select 1 from public.lieferant_katalog_artikel x
         where x.lieferant_id = p_lieferant_id and x.match_key = v_key
      ) loop
        v_n := v_n + 1;
        v_key := v_basis || '#' || v_n;
      end loop;
      insert into public.lieferant_katalog_artikel (
        lieferant_id, match_key, artikelnummer, name, hauptkategorie, kategorie,
        beschreibung, inhalt, preis_chf, preis_text, sort, source, is_active, import_lauf
      ) values (
        p_lieferant_id, v_key, v_nr, v_name,
        left(coalesce(nullif(btrim(a->>'hauptkategorie'), ''), 'Diverses'), 60),
        left(coalesce(nullif(btrim(a->>'kategorie'), ''), 'Sonstiges'), 120),
        nullif(a->>'beschreibung', ''), nullif(a->>'inhalt', ''),
        nullif(a->>'preis_chf', '')::numeric(10,2), nullif(a->>'preis_text', ''),
        coalesce(nullif(a->>'sort', '')::int, 0), 'ki', true, p_lauf
      )
      on conflict (lieferant_id, match_key) do nothing;
      get diagnostics v_zeilen = row_count;
      v_neu := v_neu + v_zeilen;
    end if;
  end loop;

  return jsonb_build_object('neu', v_neu, 'aktualisiert', v_aktualisiert);
end
$$;

-- 6. Import abschliessen: nicht mehr gesehene Artikel deaktivieren ---------
create or replace function public.katalog_import_abschluss(
  p_lieferant_id uuid,
  p_lauf uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_gesehen int;
  v_start timestamptz;
  v_deaktiviert int := 0;
begin
  if p_lieferant_id is null or p_lauf is null then
    raise exception 'katalog_import_abschluss: ungueltige Parameter';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('katalog_import:' || p_lieferant_id::text, 0));

  select count(*), min(updated_at) into v_gesehen, v_start
    from public.lieferant_katalog_artikel
   where lieferant_id = p_lieferant_id and import_lauf = p_lauf;

  -- Schutz 2: lief gleichzeitig ein anderer Import derselben Firma (zwei
  -- Personen), koennte das Deaktivieren dessen Zuordnungen treffen — dann
  -- nichts ausblenden; der naechste Import raeumt sauber auf.
  if v_gesehen > 0 and exists (
    select 1 from public.lieferant_katalog_artikel
     where lieferant_id = p_lieferant_id
       and import_lauf is not null and import_lauf <> p_lauf
       and updated_at >= v_start
  ) then
    return jsonb_build_object('gesehen', v_gesehen, 'deaktiviert', 0, 'parallel', true);
  end if;

  -- Schutz 1: hat der Lauf nichts erkannt (leeres/falsches PDF, KI-Ausfall),
  -- bleibt der bisherige Katalog unangetastet.
  if v_gesehen > 0 then
    update public.lieferant_katalog_artikel
       set is_active = false, updated_at = now()
     where lieferant_id = p_lieferant_id
       and source = 'ki'
       and is_active
       and import_lauf is distinct from p_lauf;
    get diagnostics v_deaktiviert = row_count;
  end if;

  return jsonb_build_object('gesehen', v_gesehen, 'deaktiviert', v_deaktiviert);
end
$$;

-- 7. Nur der Server darf die Funktionen ausfuehren ------------------------
revoke all on function public.katalog_name_key(text) from public, anon, authenticated;
revoke all on function public.katalog_nr_key(text) from public, anon, authenticated;
revoke all on function public.katalog_import_abschnitt(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.katalog_import_abschluss(uuid, uuid) from public, anon, authenticated;
grant execute on function public.katalog_name_key(text) to service_role;
grant execute on function public.katalog_nr_key(text) to service_role;
grant execute on function public.katalog_import_abschnitt(uuid, uuid, jsonb) to service_role;
grant execute on function public.katalog_import_abschluss(uuid, uuid) to service_role;

-- 8. Tote lieferant:*-Rechte entfernen (Rollen-Matrix gibt es nicht mehr) --
update public.roles r
   set permissions = coalesce(
         (select jsonb_agg(p) from jsonb_array_elements_text(r.permissions) p where p !~ '^lieferant:'),
         '[]'::jsonb)
 where exists (select 1 from jsonb_array_elements_text(r.permissions) p where p ~ '^lieferant:');

notify pgrst, 'reload schema';
