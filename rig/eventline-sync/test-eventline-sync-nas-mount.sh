#!/bin/bash
# Test für eventline-sync-nas-mount — ohne root, ohne NAS, ohne echte Mounts.
# findmnt/mount/install/flock/timeout/ls werden über PATH durch Attrappen ersetzt; die Mount-Tabelle
# ist eine Textdatei. Aufruf: bash rig/eventline-sync/test-eventline-sync-nas-mount.sh
set -uo pipefail
HIER=$(cd "$(dirname "$0")" && pwd)
SKRIPT="$HIER/eventline-sync-nas-mount"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/base"
printf 'NAS_HOST=127.0.0.1\nNAS_SHARES=A_EINS, B_ZWEI ,C_DREI\n' > "$T/env"
printf 'username=test\n' > "$T/cred"
export EVENTLINE_SYNC_TEST_ENV="$T/env" EVENTLINE_SYNC_TEST_CRED="$T/cred" \
  EVENTLINE_SYNC_TEST_BASE="$T/base" EVENTLINE_SYNC_TEST_LOCK="$T/lock" \
  STUB_TAB="$T/mounttab" STUB_HAENGT="$T/haengt" STUB_MOUNTLOG="$T/mountlog" STUB_MOUNT_FAIL="$T/mountfail"

# findmnt: nur «--mountpoint X» wird gebraucht; Treffer = Zeile X in der Mount-Tabelle.
cat > "$T/bin/findmnt" <<'EOF'
#!/bin/bash
ziel=""; while [ $# -gt 0 ]; do case "$1" in --mountpoint|-M) ziel="$2"; shift 2 ;; *) shift ;; esac; done
[ -n "$ziel" ] && [ -f "$STUB_TAB" ] && grep -qxF -- "$ziel" "$STUB_TAB" && { echo "$ziel"; exit 0; }
exit 1
EOF
# mount: protokolliert; schlägt fehl für Ziele in STUB_MOUNT_FAIL, sonst «eingehängt» (Tabelle).
cat > "$T/bin/mount" <<'EOF'
#!/bin/bash
ziel="$4"; echo "$ziel" >> "$STUB_MOUNTLOG"
[ -f "$STUB_MOUNT_FAIL" ] && grep -qxF -- "$ziel" "$STUB_MOUNT_FAIL" && { echo "mount error(16): Device or resource busy" >&2; exit 32; }
echo "$ziel" >> "$STUB_TAB"
EOF
# ls: «hängt» für Ziele in STUB_HAENGT.
cat > "$T/bin/ls" <<'EOF'
#!/bin/bash
for a in "$@"; do [ -f "$STUB_HAENGT" ] && grep -qxF -- "$a" "$STUB_HAENGT" && exit 124; done
exit 0
EOF
# timeout: SMB-Port gilt als erreichbar; sonst Optionen überspringen und Befehl ausführen.
cat > "$T/bin/timeout" <<'EOF'
#!/bin/bash
case "$*" in *"/dev/tcp/"*) exit 0 ;; esac
while [ $# -gt 0 ]; do case "$1" in -k) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift; exec "$@"
EOF
printf '#!/bin/bash\nfor a in "$@"; do z="$a"; done; mkdir -p "$z"\n' > "$T/bin/install"
printf '#!/bin/bash\nexit 0\n' > "$T/bin/flock"
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH"

fehler=0
pruefe() { # name erwarteter_exit tatsaechlicher_exit ausgabe muster
  if [ "$2" = "$3" ] && grep -qF -- "$5" <<< "$4"; then echo "ok   $1"
  else echo "FAIL $1 (exit $3, erwartet $2; erwartet «$5»)"; echo "$4" | sed 's/^/     | /'; fehler=$((fehler + 1)); fi
}
lauf() { aus=$(bash "$SKRIPT" mount 2>&1); rc=$?; }
neu_start() { rm -f "$STUB_TAB" "$STUB_HAENGT" "$STUB_MOUNTLOG" "$STUB_MOUNT_FAIL"; rm -rf "$T/base"; mkdir -p "$T/base"; }
alle_eingehaengt() { printf '%s\n' "$T/base/A_EINS" "$T/base/B_ZWEI" "$T/base/C_DREI" > "$STUB_TAB"; }

# 1) Alles eingehängt + antwortet: nichts anfassen, kein mount, kein Marker, exit 0.
neu_start; alle_eingehaengt; mkdir -p "$T/base/A_EINS" "$T/base/B_ZWEI" "$T/base/C_DREI"; lauf
pruefe "alle eingehängt → übersprungen" 0 "$rc" "$aus" "alle 3 Freigaben eingehängt"
[ ! -f "$STUB_MOUNTLOG" ] && echo "ok   kein mount-Aufruf" || { echo "FAIL mount aufgerufen"; fehler=$((fehler + 1)); }
ls_marker=$(find "$T/base" -name .nicht-eingehaengt | wc -l)
[ "$ls_marker" -eq 0 ] && echo "ok   kein Marker auf eingehängten Freigaben" || { echo "FAIL Marker geschrieben"; fehler=$((fehler + 1)); }

# 2) Viele Mounts in der Tabelle (früher SIGPIPE-anfällig): 30 Läufe, alle exit 0 ohne mount.
neu_start; alle_eingehaengt; for i in $(seq 1 200); do echo "/mnt/anderes/$i" >> "$STUB_TAB"; done
ok_laeufe=0; for i in $(seq 1 30); do lauf; [ "$rc" -eq 0 ] && grep -qF "alle 3" <<< "$aus" && ok_laeufe=$((ok_laeufe + 1)); done
pruefe "30 Läufe stabil" 30 "$ok_laeufe" "x" "x"

# 3) Eine fehlt: nur diese einhängen, Marker darunter, exit 0.
neu_start; printf '%s\n' "$T/base/A_EINS" "$T/base/C_DREI" > "$STUB_TAB"; lauf
pruefe "eine fehlt → eingehängt" 0 "$rc" "$aus" "eingehängt: 3 von 3 Freigaben (2 bereits da, 1 neu, 0 Fehler)"
[ "$(cat "$STUB_MOUNTLOG")" = "$T/base/B_ZWEI" ] && echo "ok   nur B_ZWEI gemountet" || { echo "FAIL mount-Ziele: $(cat "$STUB_MOUNTLOG")"; fehler=$((fehler + 1)); }
[ -f "$T/base/B_ZWEI/.nicht-eingehaengt" ] && echo "ok   Marker unter dem neuen Mount" || { echo "FAIL Marker fehlt"; fehler=$((fehler + 1)); }

# 4) Eingehängt, antwortet nicht: Fehler, aber kein zweiter Mount darüber; Rest ok → exit 0.
neu_start; alle_eingehaengt; echo "$T/base/B_ZWEI" > "$STUB_HAENGT"; lauf
pruefe "hängender Mount → Fehler, Teil-Erfolg" 0 "$rc" "$aus" "eingehängt: 2 von 3 Freigaben (2 bereits da, 0 neu, 1 Fehler)"
[ ! -f "$STUB_MOUNTLOG" ] && echo "ok   kein Mount über hängende Freigabe" || { echo "FAIL mount über hängende Freigabe"; fehler=$((fehler + 1)); }

# 5) Nichts eingehängt und mount schlägt überall fehl → exit 1.
neu_start; printf '%s\n' "$T/base/A_EINS" "$T/base/B_ZWEI" "$T/base/C_DREI" > "$STUB_MOUNT_FAIL"; lauf
pruefe "alles fehlgeschlagen → exit 1" 1 "$rc" "$aus" "keine Freigabe eingehängt"

# 6) Alle eingehängt, alle hängen → exit 1.
neu_start; alle_eingehaengt; printf '%s\n' "$T/base/A_EINS" "$T/base/B_ZWEI" "$T/base/C_DREI" > "$STUB_HAENGT"; lauf
pruefe "alle hängen → exit 1" 1 "$rc" "$aus" "eingehängt: 0 von 3"

[ "$fehler" -eq 0 ] && echo "ALLE TESTS OK" || { echo "$fehler TEST(S) FEHLGESCHLAGEN"; exit 1; }
