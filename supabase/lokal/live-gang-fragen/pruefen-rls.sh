#!/usr/bin/env bash
# Prüft Migration 376 in einem Wegwerf-Postgres (Docker, postgres:17-alpine) — NUR LOKAL,
# berührt keine Supabase-Instanz. Spielt 376 zweimal ein (idempotent) und prüft RLS/Verlauf/aud.
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
# 369 Abschnitte 1–2 (flow_abrufe, beginnen/abschliessen), dann 371, dann 376 (zweimal).
sed -n '/^create table if not exists public.flow_abrufe/,/^-- 3. Quelle/p' supabase/migrations/369_flow_schnittstelle.sql | psql_
psql_ < supabase/migrations/371_flow_ohne_personen_stammdaten.sql
psql_ < supabase/migrations/376_fragen_an_dich.sql
psql_ < supabase/migrations/376_fragen_an_dich.sql
echo "376 zweimal eingespielt (idempotent)"
psql_ < supabase/lokal/live-gang-fragen/rls-pruefen.sql
