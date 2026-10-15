-- 328 — Finanzen ohne Step-up (Bestätigung per Passkey/Passwort entfernt).
--
-- Leo-Entscheid 2026-10-15: auf /finanzen genügt das vertraute Gerät, die
-- zusätzliche Bestätigung (Step-up) ist komplett weg. Die Aktionen
-- 'finanzen.freigabe' / 'finanzen.freigabe_fehlgeschlagen' entstehen nicht mehr;
-- der Wochen-Digest liest die Spalten freigaben/fehlversuche seit dem Code-
-- Deploy nicht mehr. Diese Migration entfernt sie aus finanzen.zugriffe_zaehlung.
--
-- ERST NACH dem Deploy des Codes einspielen (Rückgabetyp ändert sich →
-- drop + create; der neue Code liest nur actor_label/finanzen/lohn/fremde und
-- läuft mit beiden Versionen). Idempotent, in einer Transaktion: die Funktion
-- ist zu keinem Zeitpunkt weg. Grants wie in 326: nur service_role.

begin;

drop function if exists finanzen.zugriffe_zaehlung(timestamptz, timestamptz);

-- Wochen-Digest: Zaehlung SERVER-SEITIG (PostgREST max_rows = 1000 wuerde
-- eine JS-Gruppierung still unterzaehlen). Nur Zahlen, keine Betraege.
create function finanzen.zugriffe_zaehlung(p_von timestamptz, p_bis timestamptz)
returns table (actor_label text, finanzen int, lohn int, fremde int)
language sql
stable
set search_path = finanzen, public
as $$
  select
    coalesce(z.actor_label, 'Unbekannt') as actor_label,
    count(*) filter (where z.bereich = 'finanzen')::int as finanzen,
    count(*) filter (where z.bereich = 'lohn')::int as lohn,
    count(*) filter (where z.ziel_profile_id is not null and z.ziel_profile_id <> z.actor_profile_id)::int as fremde
  from finanzen.zugriffe z
  where z.occurred_at >= p_von and z.occurred_at < p_bis
  group by coalesce(z.actor_label, 'Unbekannt')
  order by 1;
$$;
comment on function finanzen.zugriffe_zaehlung(timestamptz, timestamptz) is 'Zaehlung pro Person fuer /api/cron/zugriffe-digest. Nur service_role.';

revoke all on function finanzen.zugriffe_zaehlung(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function finanzen.zugriffe_zaehlung(timestamptz, timestamptz) to service_role;

commit;

-- PostgREST-Schema-Cache auffrischen (neuer Rückgabetyp der RPC).
notify pgrst, 'reload schema';
