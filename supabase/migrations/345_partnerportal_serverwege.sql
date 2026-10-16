-- 345 — Partnerportal: Server-Wege für Titel, Absenden und Zurückziehen
-- (Leo 2026-10-15: Partner sehen nur noch ihre EIGENEN Anfragen; alles läuft
-- über Server-Routen unter /api/partner/**, wie im Lieferantenportal).
--
-- Bisher rief der Browser des Partners die SECURITY-DEFINER-Funktionen
-- partner_update_title / partner_submit_anfrage / partner_withdraw_anfrage
-- direkt auf (auth.uid() = Partner). Neu ruft sie ausschliesslich der Server
-- (Admin-Client, service_role), nachdem er Konto, Standort, Recht und «eigene
-- Anfrage» geprüft hat — auch in der «Ansicht als» eines Admins.
--
-- Damit die bestehenden Funktionen UNVERÄNDERT weiterlaufen (gleiche Prüfungen,
-- Status-Wächter, Benachrichtigungen und Verlauf «wer hat was geändert»), führt
-- der Server sie im Namen des Partners aus: partnerportal_als(p_actor) setzt
-- für die laufende Transaktion die JWT-Angaben auf das Partner-Konto, so dass
-- auth.uid() = Partner gilt — genau wie bei einem Aufruf aus dem Browser.
--
-- Sicherheit:
--   * partnerportal_als ist nur intern (kein EXECUTE für irgendeine API-Rolle)
--     und prüft zusätzlich, dass der Aufruf vom Server kommt (JWT-Rolle
--     service_role) und das Ziel ein aktives Partner-Konto mit Standort ist.
--   * Die drei Wrapper sind nur für service_role ausführbar (nicht anon,
--     nicht authenticated) — ein Browser kann sie nie aufrufen.
--   * Der Wechsel gilt nur bis zum Ende der Transaktion (= dieses Aufrufs).
--
-- Rein additiv; die direkten Browser-Wege werden erst entzogen, wenn der
-- Server-Code live geprüft ist (Migration 346). Idempotent.

create or replace function public.partnerportal_als(p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Nur der Server (Service-Schlüssel) darf im Namen eines Partners handeln.
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') <> 'service_role' then
    raise exception 'forbidden: nur der Server darf im Namen eines Partners handeln';
  end if;
  if p_actor is null or not exists (
    select 1 from public.profiles p
    where p.id = p_actor
      and p.role = 'partner'
      and p.is_active = true
      and p.partner_location_id is not null
  ) then
    raise exception 'forbidden: kein aktives Partner-Konto';
  end if;
  -- Gilt bis zum Ende der Transaktion: auth.uid() = Partner.
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_actor, 'role', 'authenticated')::text,
    true
  );
end;
$$;

revoke all on function public.partnerportal_als(uuid) from public, anon, authenticated, service_role;

-- ─── Titel ändern (Logik: partner_update_title, Migration 315) ─────────────
create or replace function public.partnerportal_titel(p_actor uuid, p_job_id uuid, p_title text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.partnerportal_als(p_actor);
  return public.partner_update_title(p_job_id, p_title);
end;
$$;

revoke all on function public.partnerportal_titel(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.partnerportal_titel(uuid, uuid, text) to service_role;

-- ─── Entwurf absenden (Logik: partner_submit_anfrage) ──────────────────────
create or replace function public.partnerportal_absenden(p_actor uuid, p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.partnerportal_als(p_actor);
  perform public.partner_submit_anfrage(p_job_id);
end;
$$;

revoke all on function public.partnerportal_absenden(uuid, uuid) from public, anon, authenticated;
grant execute on function public.partnerportal_absenden(uuid, uuid) to service_role;

-- ─── Anfrage zurückziehen (Logik: partner_withdraw_anfrage, Migration 308) ─
create or replace function public.partnerportal_zurueckziehen(p_actor uuid, p_job_id uuid)
returns table(storage_paths text[])
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.partnerportal_als(p_actor);
  return query select w.storage_paths from public.partner_withdraw_anfrage(p_job_id) w;
end;
$$;

revoke all on function public.partnerportal_zurueckziehen(uuid, uuid) from public, anon, authenticated;
grant execute on function public.partnerportal_zurueckziehen(uuid, uuid) to service_role;
