-- Rückweg zu 388 (nur falls das ERP den November doch selbst rechnen soll).
update public.lohn_einstellungen set lauf_bis = date '2026-11-01' where id = 'default';

CREATE OR REPLACE FUNCTION public.lohn_bexio_fassung_speichern(p_profile_id uuid, p_jahr integer, p_monat integer, p_fassung integer, p_pdf_sha256 text, p_storage_path text, p_file_size bigint, p_flow_abruf_id uuid, p_flow_sub uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_gleich public.lohn_bexio_fassungen%rowtype;
  v_max integer;
  v_doc jsonb;
begin
  if p_monat is null or p_monat not between 1 and 12 or p_jahr is null then
    raise exception 'lohn_bexio_fassung_speichern: Monat ungültig';
  end if;
  if p_fassung is null or p_fassung not between 1 and 99 then
    raise exception 'lohn_bexio_fassung_speichern: Fassung ungültig';
  end if;
  if not (p_jahr > 2026 or (p_jahr = 2026 and p_monat = 12)) then
    return jsonb_build_object('modus', 'abgelehnt', 'code', 'erp_monat',
      'meldung', 'Lohnabrechnungen aus Bexio gibt es erst ab Lohnmonat Dezember 2026.');
  end if;
  if public.lohn_nach_lauf_bis(p_jahr, p_monat) is null then
    return jsonb_build_object('modus', 'abgelehnt', 'code', 'erp_monat',
      'meldung', 'Für diesen Lohnmonat rechnet das ERP (lohn_einstellungen.lauf_bis) — keine Lohnabrechnung aus Bexio.');
  end if;

  -- Gleiche Sperre wie lohn_fassung_speichern: dieselbe Person/Periode nacheinander.
  perform pg_advisory_xact_lock(hashtextextended(
    'lohn_fassung|' || p_profile_id::text || '|lohnabrechnung|' || p_jahr || '|' || p_monat, 0));

  select * into v_gleich from public.lohn_bexio_fassungen
   where profile_id = p_profile_id and jahr = p_jahr and monat = p_monat and fassung = p_fassung;
  if found then
    if v_gleich.pdf_sha256 = p_pdf_sha256 then
      return jsonb_build_object('modus', 'vorhanden', 'id', v_gleich.wage_document_id, 'version', v_gleich.erp_version);
    end if;
    return jsonb_build_object('modus', 'abgelehnt', 'code', 'fassung_abweichend',
      'meldung', 'Fassung ' || p_fassung || ' ist schon mit anderem Inhalt abgelegt — eine geänderte Abrechnung braucht eine neue Fassung.');
  end if;
  select max(fassung) into v_max from public.lohn_bexio_fassungen
   where profile_id = p_profile_id and jahr = p_jahr and monat = p_monat;
  if v_max is not null and p_fassung < v_max then
    return jsonb_build_object('modus', 'abgelehnt', 'code', 'veraltet',
      'meldung', 'Für diesen Monat liegt schon Fassung ' || v_max || ' vor — eine ältere Fassung wird nicht mehr abgelegt.');
  end if;

  v_doc := public.lohn_fassung_speichern(
    p_profile_id, 'lohnabrechnung', p_jahr, p_monat, p_storage_path, p_file_size, 'bexio',
    null, 'Trust flow (Bexio)', 'Lohnabrechnung aus Bexio, Fassung ' || p_fassung, false,
    jsonb_build_object('quelle', 'bexio', 'fassung_bexio', p_fassung, 'pdf_sha256', p_pdf_sha256,
                       'flow_abruf_id', p_flow_abruf_id, 'flow_sub', p_flow_sub));

  insert into public.lohn_bexio_fassungen (
    profile_id, jahr, monat, fassung, pdf_sha256, file_size, wage_document_id, erp_version,
    storage_path, flow_abruf_id, flow_sub)
  values (
    p_profile_id, p_jahr, p_monat, p_fassung, p_pdf_sha256, p_file_size, (v_doc ->> 'id')::uuid,
    (v_doc ->> 'version')::integer, p_storage_path, p_flow_abruf_id, p_flow_sub);

  return v_doc;
end;
$function$
;
