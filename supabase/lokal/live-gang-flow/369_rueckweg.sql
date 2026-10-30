-- Rückweg Migration 369 (Schnittstelle Trust flow) — z. B. wenn ein Abruf oder
-- die Ablage der Lohnabrechnungen aus Bexio stört.
--
-- Entfernt die Funktionen der Schnittstelle (die Routen /api/flow/* antworten
-- danach mit 500, es fliessen keine Daten mehr) und stellt lohn_fassung_speichern
-- wie in Migration 360 her (nimmt die Quelle «bexio» nicht mehr an).
-- BLEIBEN: flow_abrufe (Protokoll), lohn_bexio_fassungen, abgelegte
-- Lohnabrechnungen (Zeilen und PDF) und die erweiterte Regel
-- wage_documents_source_check (abgelegte «bexio»-Zeilen bleiben gültig).
-- Schneller ohne Datenbank: Env FLOW_ABRUF_PUBLIC_KEY in Vercel entfernen →
-- alle Routen 503 (nach dem nächsten Deploy bzw. Neustart der Funktionen).
-- Erneutes Einspielen von 369 stellt alles wieder her.

drop function if exists public.flow_abruf_beginnen(uuid, text, uuid, integer, integer, integer, timestamptz, timestamptz);
drop function if exists public.flow_abruf_abschliessen(uuid, text, integer, text, text);
drop function if exists public.lohn_bexio_fassung_speichern(uuid, integer, integer, integer, text, text, bigint, uuid, uuid);

-- lohn_fassung_speichern wie Migration 360 (Quelle nur manual/auto)
create or replace function public.lohn_fassung_speichern(
  p_profile_id uuid,
  p_doc_type text,
  p_year integer,
  p_period_month integer,
  p_storage_path text,
  p_file_size bigint,
  p_source text,
  p_actor uuid,
  p_actor_name text,
  p_notes text,
  p_nur_wenn_keine_gueltige boolean default false,
  p_details jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alt_id uuid;
  v_alt_version integer;
  v_alt_pfad text;
  v_neu_id uuid;
  v_version integer;
  v_modus text;
  v_name text;
  v_constraint text;
begin
  -- Erlaubt dem Pfad-Schutz-Trigger (s. u.) das Umstellen von storage_path
  -- NUR innerhalb dieser Funktion (transaktionslokal).
  perform set_config('lohn.fassung_rpc', 'an', true);
  if p_doc_type not in ('lohnabrechnung', 'lohnausweis') then
    raise exception 'lohn_fassung_speichern: doc_type ungültig';
  end if;
  if p_source not in ('manual', 'auto') then
    raise exception 'lohn_fassung_speichern: source ungültig';
  end if;
  if coalesce(p_storage_path, '') = '' then
    raise exception 'lohn_fassung_speichern: storage_path fehlt';
  end if;

  -- Gleichzeitige Aufrufe für dieselbe Person/Periode nacheinander.
  perform pg_advisory_xact_lock(hashtextextended(
    'lohn_fassung|' || p_profile_id::text || '|' || p_doc_type || '|' || p_year || '|' || coalesce(p_period_month, 0), 0));

  select w.id, w.version, w.storage_path into v_alt_id, v_alt_version, v_alt_pfad
    from public.wage_documents w
   where w.profile_id = p_profile_id and w.doc_type = p_doc_type and w.year = p_year
     and w.period_month is not distinct from p_period_month
     and w.archived_at is null and w.superseded_at is null
   order by w.version desc, w.uploaded_at desc
   limit 1
   for update;

  if v_alt_id is not null and p_nur_wenn_keine_gueltige then
    return jsonb_build_object('modus', 'vorhanden', 'id', v_alt_id, 'version', v_alt_version);
  end if;

  select coalesce(max(w.version), 0) + 1 into v_version
    from public.wage_documents w
   where w.profile_id = p_profile_id and w.doc_type = p_doc_type and w.year = p_year
     and w.period_month is not distinct from p_period_month;

  begin
    if v_alt_id is not null then
      update public.wage_documents set superseded_at = now() where id = v_alt_id;
    end if;
    insert into public.wage_documents (
      profile_id, doc_type, year, period_month, storage_path, file_size,
      uploaded_at, uploaded_by, uploaded_by_name, notes, source, version)
    values (
      p_profile_id, p_doc_type, p_year, p_period_month, p_storage_path, p_file_size,
      now(), p_actor, p_actor_name, p_notes, p_source, v_version)
    returning id into v_neu_id;
    if v_alt_id is not null then
      update public.wage_documents set superseded_by = v_neu_id where id = v_alt_id;
    end if;
    v_modus := case when v_alt_id is null then 'neu' else 'neue_fassung' end;
  exception when unique_violation then
    -- Einmaligkeits-Regel noch aktiv: die eine Zeile der Periode zeigt ab jetzt
    -- auf die neue Datei. Die bisherige Datei bleibt im Speicher, ihr Pfad
    -- steht im Protokoll (vorheriger_storage_path). Nur fuer GENAU diese
    -- Regel — jede andere Verletzung (z. B. der spaetere Teil-Index) wirft.
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'wage_doc_unique_per_period' then
      raise;
    end if;
    select w.id, w.version, w.storage_path into v_alt_id, v_alt_version, v_alt_pfad
      from public.wage_documents w
     where w.profile_id = p_profile_id and w.doc_type = p_doc_type and w.year = p_year
       and w.period_month = p_period_month
     for update;
    if v_alt_id is null then
      raise;
    end if;
    update public.wage_documents set
      storage_path = p_storage_path, file_size = p_file_size, uploaded_at = now(),
      uploaded_by = p_actor, uploaded_by_name = p_actor_name, notes = p_notes, source = p_source,
      version = v_version, superseded_at = null, superseded_by = null,
      archived_at = null, archived_by = null, archived_by_name = null, archive_reason = null
     where id = v_alt_id;
    v_neu_id := v_alt_id;
    v_modus := 'ersetzt';
  end;

  select full_name into v_name from public.profiles where id = p_profile_id;

  insert into public.lohn_dokument_protokoll (
    aktion, wage_document_id, profile_id, profile_name, doc_type, year, period_month,
    version, vorherige_version, storage_path, vorheriger_storage_path, modus,
    actor_profile_id, actor_name, system, details)
  values (
    case when p_source = 'manual' then 'hochgeladen' else 'erstellt' end,
    v_neu_id, p_profile_id, v_name, p_doc_type, p_year, p_period_month,
    v_version, v_alt_version, p_storage_path, v_alt_pfad, v_modus,
    p_actor, p_actor_name, p_actor is null, coalesce(p_details, '{}'::jsonb));

  return jsonb_build_object(
    'modus', v_modus, 'id', v_neu_id, 'version', v_version,
    'vorherige_version', v_alt_version, 'vorheriger_pfad', v_alt_pfad);
end;
$$;
revoke all on function public.lohn_fassung_speichern(uuid, text, integer, integer, text, bigint, text, uuid, text, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.lohn_fassung_speichern(uuid, text, integer, integer, text, bigint, text, uuid, text, text, boolean, jsonb) to service_role;
