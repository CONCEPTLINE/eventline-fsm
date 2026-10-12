#!/usr/bin/env bash
# EVENTLINE Lokale KI — Speicherprofil (Masterplan E2.0). Eine Zeile pro Aufruf; der Timer
# eventline-ki-speicherprofil.timer ruft das jede Minute auf. Nur Zahlen, keine Inhalte.
#
# Ziel: /srv/eventline-ki/data/messung/speicherprofil-<JJJJ-MM-TT>.csv (Tresor, root 0700, Tag in
# Europe/Zurich, 30 Tage aufbewahrt). Auswertung: python3 messung/auswerten.py (README «Speicherprofil»).
#
# Trust one wird hier nur GELESEN (memory.current/memory.swap.current aus /sys/fs/cgroup) — nichts daran
# konfiguriert. Ist der Tresor nicht eingehängt, schreibt das Skript nichts (nie auf den leeren Mount-Punkt).

set -u
export LC_ALL=C

DATEN=/srv/eventline-ki/data
ZIEL="$DATEN/messung"
CG=/sys/fs/cgroup
KI_SLICE="$CG/system.slice/system-eventlineki.slice"
TO_SLICE="$CG/system.slice/system-trustone.slice"
DIENSTE="ollama ollama-gruendlich whisper dienst db egress caddy"

mountpoint -q "$DATEN" || exit 0
install -d -m 0700 -o root -g root "$ZIEL"

lies() { [ -r "$1" ] && head -c 64 "$1" 2>/dev/null | tr -d '\n' || true; }
stat_wert() { [ -r "$1/memory.stat" ] && awk -v k="$2" '$1 == k { print $2; exit }' "$1/memory.stat" 2>/dev/null || true; }
mem() { awk -v k="$1:" '$1 == k { print $2; exit }' /proc/meminfo; }
psi() { awk -v z="$1" '$1 == z { for (i = 2; i <= NF; i++) if ($i ~ /^avg10=/) { sub(/avg10=/, "", $i); print $i } }' /proc/pressure/memory 2>/dev/null; }

# memory.current je KI-Container: Pfad aus /proc/<pid>/cgroup (gilt mit und ohne Slice).
declare -A AKT
while read -r name pid; do
  [ -n "${pid:-}" ] && [ "$pid" != "0" ] || continue
  pfad="$(sed -n 's/^0:://p' "/proc/$pid/cgroup" 2>/dev/null)"
  [ -n "$pfad" ] && AKT["${name#/eventline-ki-}"]="$(lies "$CG$pfad/memory.current")"
done < <(docker ps -q --filter label=com.docker.compose.project=eventline-ki 2>/dev/null \
           | xargs -r docker inspect -f '{{.Name}} {{.State.Pid}}' 2>/dev/null)

SWARM_CG="$(systemctl show -p ControlGroup --value trust-one-swarm 2>/dev/null)"
SWARM=""
[ -n "$SWARM_CG" ] && SWARM="$(lies "$CG$SWARM_CG/memory.current")"

KOPF="zeit,mem_total_kb,mem_available_kb,swap_total_kb,swap_free_kb,psi_some_avg10,psi_full_avg10,pgmajfault"
KOPF+=",ki_slice,ki_slice_swap,ki_slice_anon,ki_slice_file"
for d in $DIENSTE; do KOPF+=",${d//-/_}"; done
KOPF+=",trustone_swarm,trustone_slice,trustone_slice_swap"

ZEILE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ZEILE+=",$(mem MemTotal),$(mem MemAvailable),$(mem SwapTotal),$(mem SwapFree)"
ZEILE+=",$(psi some),$(psi full),$(awk '$1 == "pgmajfault" { print $2 }' /proc/vmstat)"
ZEILE+=",$(lies "$KI_SLICE/memory.current"),$(lies "$KI_SLICE/memory.swap.current")"
ZEILE+=",$(stat_wert "$KI_SLICE" anon),$(stat_wert "$KI_SLICE" file)"
for d in $DIENSTE; do ZEILE+=",${AKT[$d]:-}"; done
ZEILE+=",$SWARM,$(lies "$TO_SLICE/memory.current"),$(lies "$TO_SLICE/memory.swap.current")"

DATEI="$ZIEL/speicherprofil-$(TZ=Europe/Zurich date +%Y-%m-%d).csv"
# Neue Spalten: eine Datei mit anderem Kopf wird beiseitegelegt statt gemischt.
if [ -s "$DATEI" ] && [ "$(head -n 1 "$DATEI")" != "$KOPF" ]; then
  mv "$DATEI" "${DATEI%.csv}-bis-$(date +%H%M).csv"
fi
if [ ! -s "$DATEI" ]; then
  ( umask 077; echo "$KOPF" > "$DATEI" )
fi
echo "$ZEILE" >> "$DATEI"

find "$ZIEL" -maxdepth 1 -name 'speicherprofil-*.csv' -mtime +30 -delete 2>/dev/null || true
