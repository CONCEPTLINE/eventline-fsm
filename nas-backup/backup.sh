#!/bin/sh
# Nightly Backup-Script — laeuft im Container per Sleep-Loop um 03:00.
# Wird vom docker-compose.yml als Volume reingemounted unter
# /usr/local/bin/backup.sh.
#
# Macht zwei Dinge pro Run:
#   1. pg_dump der ganzen DB als Custom-Format-Dump (db.dump)
#   2. rclone-Sync des documents-Storage-Buckets als File-Tree (storage/)
#
# Per Datum versioniert: /backups/2026-05-04_030000/db.dump + /storage/...
# Retention: aelter als $RETENTION_DAYS Tage wird geloescht.

set -eu

DATE=$(date +%Y-%m-%d_%H%M%S)
DEST="/backups/$DATE"
LOG="$DEST/run.log"

mkdir -p "$DEST"

log() {
  echo "[$(date -Iseconds 2>/dev/null || date)] $*" | tee -a "$LOG"
}

log "=== Backup-Run startet ==="

log "Postgres-Dump nach $DEST/db.dump..."
PGPASSWORD="$PG_PASSWORD" pg_dump \
  --host="$PG_HOST" \
  --port="$PG_PORT" \
  --username="$PG_USER" \
  --dbname="$PG_DATABASE" \
  --no-owner \
  --no-acl \
  --format=custom \
  --file="$DEST/db.dump" 2>>"$LOG"
DUMP_SIZE=$(du -h "$DEST/db.dump" | cut -f1)
log "DB-Dump fertig — Groesse: $DUMP_SIZE"

log "Storage-Sync (alle Buckets) nach $DEST/storage..."
# s3: ohne Bucket-Name = alle Buckets unter /storage/<bucket>/...
# Vorteil: neue Buckets in der App werden automatisch mitgesichert ohne
# Script-Aenderung. Wenn du je auf einen einzelnen Bucket einschraenken
# willst, hier "s3:bucketname" schreiben.
rclone --config /tmp/rclone.conf \
  sync "s3:" "$DEST/storage" \
  --create-empty-src-dirs \
  --transfers=4 \
  --log-file="$LOG" \
  --log-level=INFO 2>>"$LOG"
STORAGE_SIZE=$(du -sh "$DEST/storage" 2>/dev/null | cut -f1 || echo "0")
log "Storage-Sync fertig — Groesse: $STORAGE_SIZE"

TOTAL_SIZE=$(du -sh "$DEST" | cut -f1)
log "Backup gesamt: $TOTAL_SIZE"

log "Cleanup: loesche Backups aelter als $RETENTION_DAYS Tage..."
DELETED=$(find /backups -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENTION_DAYS" -print -exec rm -rf {} + | wc -l)
log "Cleanup fertig — $DELETED alte Backup-Folder geloescht."

log "=== Backup-Run abgeschlossen ==="

# Sentinel-Datei mit Timestamp + Groesse — fuer Heartbeat-Monitoring
# (App kann die NAS via separatem Endpoint anpingen oder du schaust manuell rein).
echo "{\"date\":\"$DATE\",\"size\":\"$TOTAL_SIZE\",\"db_size\":\"$DUMP_SIZE\",\"storage_size\":\"$STORAGE_SIZE\"}" \
  > /backups/last-run.json

# Status ans FSM melden (NAS-Seite → Tab "Backup" + Admin-Alarm-Mail,
# wenn laenger als 26h keine OK-Meldung kommt). Best-effort: eine
# fehlgeschlagene Meldung bricht das Backup nicht ab. Braucht FSM_URL +
# ABLAGE_SYNC_TOKEN im .env (gleicher Token wie der Ablage-Sync).
if [ -n "${FSM_URL:-}" ] && [ -n "${ABLAGE_SYNC_TOKEN:-}" ]; then
  log "Melde Backup-Status ans FSM..."
  if curl -fsS -X POST "$FSM_URL/api/nas/backup-status" \
    -H "Authorization: Bearer $ABLAGE_SYNC_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"date\":\"$DATE\",\"status\":\"ok\",\"size\":\"$TOTAL_SIZE\",\"db_size\":\"$DUMP_SIZE\",\"storage_size\":\"$STORAGE_SIZE\"}" \
    >/dev/null 2>&1; then
    log "Status gemeldet."
  else
    log "[WARN] Status-Meldung ans FSM fehlgeschlagen (Netz? Token?)"
  fi
fi
