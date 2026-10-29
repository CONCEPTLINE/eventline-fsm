#!/usr/bin/env bash
# Lokale Testumgebung eventline-fsm (Lohn-Umbau) komplett neu aufbauen:
#   leere lokale DB -> alle Migrationen (wie Live) -> Live-Nachträge -> synthetische Testdaten.
# NUR LOKAL: spricht ausschliesslich den Docker-Container supabase_db_eventline-fsm-lohn an.
#
# Aufruf (Git Bash, im Worktree-Root):
#   bash supabase/lokal/aufbauen.sh             # alles neu, inkl. Testdaten
#   bash supabase/lokal/aufbauen.sh --ohne-seed # nur Schema
#   bash supabase/lokal/aufbauen.sh --nur-seed  # Testdaten neu laden (Schema bleibt)
set -euo pipefail

cd "$(dirname "$0")/../.."
CLI="npx -y supabase@2.121.0"
DB=supabase_db_eventline-fsm-lohn
API=http://127.0.0.1:55421

# Migrationen, die im Repo liegen, auf Live aber (noch) NICHT eingespielt sind.
# Lokal ebenfalls auslassen, damit das Schema dem Live-Stand entspricht.
# Wird eine davon auf Live eingespielt: hier entfernen (der Abgleich zeigt es an).
NICHT_AUF_LIVE=(
  351_ablage_technik_nach_trust_one.sql   # Drop Ablage/Technik — wartet auf Freigabe (Kopf der Datei)
)

modus="${1:-alles}"

psql_lokal() { docker exec -i "$DB" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 "$@"; }

laeuft() { docker ps --format '{{.Names}}' | grep -qx "$1"; }

if [ "$modus" != "--nur-seed" ]; then
  if ! laeuft "$DB"; then
    if docker volume ls --format '{{.Name}}' | grep -qx "supabase_db_eventline-fsm-lohn"; then
      echo "==> Supabase lokal starten"
      $CLI start
    else
      # Ganz frisch: PostgREST verlangt das Schema «finanzen» (wie Live freigegeben),
      # das erst die Migrationen anlegen. Darum zuerst ohne PostgREST starten.
      echo "==> Supabase lokal erstmals starten (PostgREST folgt nach den Migrationen)"
      $CLI start -x postgrest
      ERSTSTART=1
    fi
  fi

  echo "==> Lokale DB leeren (supabase db reset --local; Migrationen/Seed sind in config.toml aus)"
  $CLI db reset --local

  echo "==> Migrationen einspielen (je Datei eine Transaktion, wie die Management-API auf Live)"
  tmp=$(mktemp)
  {
    echo '\set ON_ERROR_STOP 1'
    for f in $(cd supabase/migrations && ls *.sql | LC_ALL=C sort); do
      skip=0
      for s in "${NICHT_AUF_LIVE[@]}"; do [ "$f" = "$s" ] && skip=1; done
      if [ $skip = 1 ]; then echo "\echo '   übersprungen (nicht auf Live): $f'"; continue; fi
      echo "\echo '   $f'"
      echo 'BEGIN;'
      sed 's/\r$//' "supabase/migrations/$f"   # Windows-Checkout (CRLF) -> LF wie im Repo
      printf '\n;\nCOMMIT;\n'
    done
  } > "$tmp"
  set +e
  psql_lokal -f - < "$tmp" > "$tmp.log" 2>&1
  rc=$?
  set -e
  grep -E 'übersprungen' "$tmp.log" || true
  if [ $rc -ne 0 ]; then
    echo "!! Migration fehlgeschlagen — letzte Zeilen:"
    grep -v -E 'NOTICE|^\s*$' "$tmp.log" | tail -15
    rm -f "$tmp" "$tmp.log"; exit 1
  fi
  echo "   $(grep -c -E '^   [0-9]' "$tmp.log") Migrationen eingespielt, letzte: $(grep -E '^   [0-9]' "$tmp.log" | tail -1 | xargs)"
  rm -f "$tmp" "$tmp.log"

  echo "==> Live-Nachträge (Buckets, Realtime) einspielen"
  sed 's/\r$//' supabase/lokal/nach-migrationen.sql | psql_lokal -f -
fi

if [ "$modus" != "--ohne-seed" ]; then
  echo "==> Synthetische Testdaten (supabase/seed-lohn-test.sql)"
  sed 's/\r$//' supabase/seed-lohn-test.sql | psql_lokal -o /dev/null -f -
fi

echo "==> PostgREST-Schema neu laden"
psql_lokal -c "notify pgrst, 'reload schema'; notify pgrst, 'reload config';"
if [ "${ERSTSTART:-0}" = 1 ]; then
  echo "==> Erststart abschliessen: einmal neu starten, jetzt mit PostgREST"
  $CLI stop
  $CLI start
fi

# Warten, bis die API antwortet
ANON=$($CLI status -o env 2>/dev/null | grep "^ANON_KEY=" | cut -d"\"" -f2)
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$API/rest/v1/" -H "apikey: $ANON" || true)
  [ "$code" = 200 ] && break
  sleep 2
done
echo "==> Fertig. API $API (HTTP $code), Studio http://127.0.0.1:55423, Mails http://127.0.0.1:55424"
