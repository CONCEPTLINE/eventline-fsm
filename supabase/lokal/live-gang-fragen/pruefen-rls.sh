#!/usr/bin/env bash
# Prüft Migration 381 in einem Wegwerf-Postgres (Docker, postgres:17-alpine) — NUR LOKAL,
# berührt keine Supabase-Instanz. Spielt 381 zweimal ein (idempotent, auf dem aud-Stand 377/380),
# prüft RLS/Verlauf/aud und den Rückweg.
#   bash supabase/lokal/live-gang-fragen/pruefen-rls.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
NAME="fragen-rls-$$"
docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD=lokal postgres:17-alpine >/dev/null
trap 'docker stop "$NAME" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U postgres -q; then break; fi
  sleep 0.5
done
sleep 2
psql_() { docker exec -i "$NAME" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 "$@"; }
psql_ < supabase/lokal/live-gang-fragen/rls-grundlage.sql
# 369 Abschnitte 1–2 (flow_abrufe, beginnen/abschliessen), 371, dann die aud-Abschnitte von 377 (2.)
# und 380 (3.) — der Stand, der live ist —, dann 381 (zweimal).
sed -n '/^create table if not exists public.flow_abrufe/,/^-- 3. Quelle/p' supabase/migrations/369_flow_schnittstelle.sql | psql_
psql_ < supabase/migrations/371_flow_ohne_personen_stammdaten.sql
sed -n '/^-- 2. aud «erp-saetze»/,/^-- 3. lohn_bexio_fassungen/p' supabase/migrations/377_flow_saetze_lohnausweis.sql | psql_
sed -n '/^-- 3. aud «erp-abwesenheiten»/,$p' supabase/migrations/380_flow_abwesenheiten.sql | psql_
psql_ < supabase/migrations/381_fragen_an_dich.sql
psql_ < supabase/migrations/381_fragen_an_dich.sql
echo "381 zweimal eingespielt (idempotent)"
psql_ < supabase/lokal/live-gang-fragen/rls-pruefen.sql
# Rückweg: Funktion wieder wie 380 — erp-antworten abgelehnt, die Audiences aus 377/380 weiter angenommen.
psql_ < supabase/lokal/live-gang-fragen/381_rueckweg.sql
psql_ <<'SQL'
do $$ declare r jsonb; begin
  begin
    perform public.flow_abruf_beginnen(gen_random_uuid(), 'erp-antworten', gen_random_uuid(), null, null, 1, now(), now() + interval '60 seconds');
    raise exception 'FEHLT: Rückweg nimmt erp-antworten noch an';
  exception when raise_exception then
    if sqlerrm like 'FEHLT%' then raise; end if;
  end;
  r := public.flow_abruf_beginnen(gen_random_uuid(), 'erp-arztzeugnis', gen_random_uuid(), null, null, 1, now(), now() + interval '60 seconds');
  if r ->> 'status' <> 'ok' then raise exception 'FEHLT: Rückweg verliert erp-arztzeugnis: %', r; end if;
  r := public.flow_abruf_beginnen(gen_random_uuid(), 'erp-saetze', gen_random_uuid(), null, null, 1, now(), now() + interval '60 seconds');
  if r ->> 'status' <> 'ok' then raise exception 'FEHLT: Rückweg verliert erp-saetze: %', r; end if;
  raise notice 'OK Rückweg: Funktion wie 380';
end $$;
SQL
# Wieder vorwärts (381 nach dem Rückweg erneut einspielbar).
psql_ < supabase/migrations/381_fragen_an_dich.sql
echo "OK: 381 nach Rückweg erneut eingespielt"
