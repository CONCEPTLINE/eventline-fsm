#!/usr/bin/env bash
# EVENTLINE Lokale KI — Installation/Update auf dem Rig (idempotent).
#
#   sudo ./install.sh                 Units installieren, bauen, Modelle laden, starten
#   sudo ./install.sh --ohne-modelle  dasselbe ohne Modell-Downloads (z. B. reines Code-Update)
#   sudo ./install.sh --quelle <verz> zuerst den Stand aus <verz> in den Checkout spiegeln
#                                     (rsync --delete, ohne __pycache__), dann wie oben
#
# Deploy vom Arbeitsplatz (Repo-Stand als tar, LF-Zeilenenden):
#   tar -C <repo>/rig --exclude=__pycache__ --exclude='*.pyc' -cf - eventline-ki \
#     | ssh rig 'rm -rf /tmp/ki-neu && mkdir /tmp/ki-neu && tar -C /tmp/ki-neu -xf -'
#   ssh rig 'sudo bash /tmp/ki-neu/eventline-ki/install.sh --ohne-modelle --quelle /tmp/ki-neu/eventline-ki'
#
# Voraussetzungen (richtet der Rig-Agent ein, siehe docs/lokale-ki/SPEC.md §2.1):
#   - Benutzer eventline-ki (uid/gid 1500), LUKS-Tresor gemountet auf /srv/eventline-ki/data
#   - /etc/eventline-ki/env und /etc/eventline-ki/caddy.env (root 0600)
#   - NVIDIA Container Toolkit (nvidia-ctk); die CDI-Spezifikation /var/run/cdi/nvidia.yaml
#     erzeugt nvidia-cdi-refresh.service bei jedem Booten, sonst dieses Skript bzw. die Unit
# Das Skript fasst keine Trust-one-Dienste an; es prüft nur, dass der Schwarm weiterläuft.

set -euo pipefail

BASIS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STANDARD_PFAD="/srv/eventline-ki/repo/eventline-ki"
ENV_DATEI="/etc/eventline-ki/env"
CADDY_ENV="/etc/eventline-ki/caddy.env"
DATEN="/srv/eventline-ki/data"
UNIT_QUELLE="$BASIS/systemd/eventline-ki.service"
UNIT_ZIEL="/etc/systemd/system/eventline-ki.service"
SLICE="system-eventlineki.slice"
PROFIL_UNITS="eventline-ki-speicherprofil.service eventline-ki-speicherprofil.timer"
TECHNIK_UNIT="eventline-ki-technik.service"   # Technik-Sammler (docs/technik-dashboard/VERTRAG.md §1.1)
AUDIT_QUELLE="$BASIS/audit/eventline-ki.rules"
AUDIT_ZIEL="/etc/audit/rules.d/eventline-ki.rules"

compose() {
  docker compose --env-file "$ENV_DATEI" -f "$BASIS/docker-compose.yml" "$@"
}

fehler() { echo "FEHLER: $*" >&2; exit 1; }
info()   { echo "==> $*"; }
# nochmal <versuche> <befehl …> — für Container, die gerade erst gestartet wurden.
nochmal() {
  local n="$1"; shift
  for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 2; done
  return 1
}

MIT_MODELLEN=1
QUELLE=""
WEITER=()   # Optionen, die nach dem Spiegeln an die übernommene Fassung dieses Skripts gehen
while [ $# -gt 0 ]; do
  case "$1" in
    --ohne-modelle) MIT_MODELLEN=0; WEITER+=("$1") ;;
    --quelle) [ -n "${2:-}" ] || fehler "--quelle braucht ein Verzeichnis"; QUELLE="$2"; shift ;;
    --quelle=*) QUELLE="${1#--quelle=}" ;;
    *) fehler "unbekannte Option «$1» (erlaubt: --ohne-modelle, --quelle <verzeichnis>)" ;;
  esac
  shift
done

[ "$(id -u)" = "0" ] || fehler "bitte mit sudo ausführen"
command -v docker >/dev/null || fehler "docker fehlt"
docker compose version >/dev/null 2>&1 || fehler "docker compose (v2) fehlt"

# --- Stand übernehmen (--quelle) ---------------------------------------------
# rsync --delete spiegelt die Quelle in den Checkout: entfernte Dateien verschwinden, Bytecode
# (__pycache__, *.pyc) kommt weder mit noch bleibt er liegen (--delete-excluded). Die als
# Verzeichnis eingebundenen Ordner (egress/, caddy/, probelauf/) behalten ihren Inode, die
# Container sehen die neuen Dateien also sofort. Ziel ist der Checkout, zu dem dieses Skript
# gehört; läuft es aus der Quelle selbst (frisch entpackt), ist das Ziel der Standard-Checkout.
# Danach läuft die soeben übernommene Fassung dieses Skripts weiter (exec) — ohne --quelle.
if [ -n "$QUELLE" ]; then
  command -v rsync >/dev/null || fehler "rsync fehlt (apt install rsync)"
  [ -d "$QUELLE" ] || fehler "--quelle: $QUELLE ist kein Verzeichnis"
  QUELLE="$(cd "$QUELLE" && pwd)"
  [ -f "$QUELLE/docker-compose.yml" ] && [ -f "$QUELLE/install.sh" ] \
    || fehler "--quelle: $QUELLE ist kein eventline-ki-Stand (docker-compose.yml, install.sh fehlen)"
  ZIEL="$BASIS"
  case "$BASIS/" in "$QUELLE"/*) ZIEL="$STANDARD_PFAD" ;; esac
  [ "$QUELLE" != "$ZIEL" ] || fehler "--quelle: Quelle und Ziel sind dasselbe Verzeichnis ($ZIEL)"
  info "Stand aus $QUELLE nach $ZIEL spiegeln (rsync --delete)"
  rsync -a --delete --delete-excluded \
    --exclude='__pycache__/' --exclude='*.pyc' --exclude='.pytest_cache/' \
    "$QUELLE/" "$ZIEL/"
  chmod +x "$ZIEL/install.sh"
  exec bash "$ZIEL/install.sh" ${WEITER[@]+"${WEITER[@]}"}
fi

# --- Vorbedingungen ---------------------------------------------------------
[ -f "$ENV_DATEI" ]  || fehler "$ENV_DATEI fehlt (FSM_URL, KI_SYNC_TOKEN, KI_TICKET_SECRET, PG_PASSWORD, KI_MODELL_*)"
[ -f "$CADDY_ENV" ]  || fehler "$CADDY_ENV fehlt (CLOUDFLARE_API_TOKEN)"
for var in FSM_URL KI_SYNC_TOKEN KI_TICKET_SECRET PG_PASSWORD KI_CORS_ORIGINS KI_MODELL_TEXT KI_MODELL_BILD; do
  grep -Eq "^${var}=." "$ENV_DATEI" || fehler "$ENV_DATEI: Variable $var fehlt oder ist leer"
done
grep -Eq "^CLOUDFLARE_API_TOKEN=." "$CADDY_ENV" || fehler "$CADDY_ENV: CLOUDFLARE_API_TOKEN fehlt"
chmod 700 /etc/eventline-ki
chmod 600 "$ENV_DATEI" "$CADDY_ENV"

mountpoint -q "$DATEN" || fehler "$DATEN ist kein Mount-Punkt — Tresor (eventline-ki-vault.service) zuerst öffnen"
getent group eventline-ki >/dev/null || fehler "Gruppe eventline-ki (gid 1500) fehlt"
getent passwd eventline-ki >/dev/null || fehler "Benutzer eventline-ki (uid 1500) fehlt"

if [ "$BASIS" != "$STANDARD_PFAD" ]; then
  echo "Hinweis: Checkout liegt unter $BASIS (Standard: $STANDARD_PFAD) — Unit wird darauf angepasst."
fi

# GPU über CDI: ohne Spezifikation starten ollama/whisper/dienst nicht. Wie die Unit
# (ExecStartPre): nur erzeugen, wenn keine da ist — und dann dort, wo auch
# nvidia-cdi-refresh.service schreibt. Eine zweite Datei unter /etc/cdi würde nach einem
# Treiber-Update veralten und dasselbe Gerät doppelt definieren.
if [ ! -e /var/run/cdi/nvidia.yaml ] && [ ! -e /etc/cdi/nvidia.yaml ]; then
  if command -v nvidia-ctk >/dev/null; then
    info "CDI-Spezifikation fehlt — erzeuge /var/run/cdi/nvidia.yaml"
    mkdir -p /var/run/cdi
    nvidia-ctk cdi generate --output=/var/run/cdi/nvidia.yaml
  else
    fehler "keine CDI-Spezifikation (/var/run/cdi/nvidia.yaml) und kein nvidia-ctk — NVIDIA Container Toolkit installieren"
  fi
fi

SCHWARM_VORHER="$(systemctl is-active trust-one-swarm 2>/dev/null || true)"
info "Trust-one-Schwarm vorher: ${SCHWARM_VORHER:-unbekannt}"

# --- Datenverzeichnisse im Tresor ------------------------------------------
# dienst läuft als 1500 und schreibt nur nach /data; die anderen Container
# laufen als root (ollama, whisper, caddy) bzw. chown-en selbst (postgres).
install -d -m 0700 -o 1500 -g 1500 "$DATEN/dienst" "$DATEN/dienst/tmp" "$DATEN/dienst/probelauf"
install -d -m 0700 -o root -g root "$DATEN/ollama" "$DATEN/ollama-gruendlich" "$DATEN/whisper" "$DATEN/caddy" \
  "$DATEN/messung"
install -d -m 0700 -o 999 -g 999 "$DATEN/pg"
# Technik-Sammler (root) schreibt stand.json hierher, der Dienst (Gruppe 1500) liest sie als /data/technik.
install -d -m 0750 -o root -g 1500 "$DATEN/dienst/technik"
chmod 0700 "$DATEN"
chown 1500:1500 "$DATEN"

# --- systemd-Units -----------------------------------------------------------
# eventline-ki.service (Stack), der Slice (Speicher-/CPU-Rahmen; muss vor «compose up» bekannt sein,
# sonst legt systemd ihn ohne Grenzen an) und der Timer für das Speicherprofil (Masterplan E2.0).
info "systemd-Units installieren (Stack, Slice $SLICE, Speicherprofil)"
unit_installieren() {   # <quelle> <ziel>: Pfade auf den Checkout setzen, nur bei Änderung ersetzen
  sed "s#$STANDARD_PFAD#$BASIS#g" "$1" > "$2.neu"
  if ! cmp -s "$2.neu" "$2" 2>/dev/null; then mv "$2.neu" "$2"; else rm -f "$2.neu"; fi
  chmod 644 "$2"
}
unit_installieren "$UNIT_QUELLE" "$UNIT_ZIEL"
unit_installieren "$BASIS/systemd/$SLICE" "/etc/systemd/system/$SLICE"
for u in $PROFIL_UNITS; do unit_installieren "$BASIS/systemd/$u" "/etc/systemd/system/$u"; done
unit_installieren "$BASIS/systemd/$TECHNIK_UNIT" "/etc/systemd/system/$TECHNIK_UNIT"
systemctl daemon-reload
systemctl enable eventline-ki.service >/dev/null
systemctl start "$SLICE"
[ "$(systemctl show -p MemoryMax --value "$SLICE")" = "23622320128" ] \
  || fehler "$SLICE hat nicht MemoryMax=22G (systemctl show $SLICE)"

# --- Zugriffs-Protokoll (auditd) ---------------------------------------------
# Lesezugriffe fremder Benutzer auf dokumente/ und dienst/ (TMPDIR) im Tresor. Die Regeln
# brauchen die eingehängten Ordner — eventline-ki-vault lädt sie nach jedem Einhängen neu,
# hier wird gleich geladen (der Tresor ist oben schon geprüft).
if command -v augenrules >/dev/null && [ -d /etc/audit/rules.d ]; then
  info "auditd-Regeln installieren"
  install -m 0640 -o root -g root "$AUDIT_QUELLE" "$AUDIT_ZIEL"
  augenrules --load >/dev/null || fehler "auditd-Regeln konnten nicht geladen werden (augenrules --load)"
  auditctl -l | grep "dir=$DATEN/dienst " >/dev/null || fehler "auditd-Regel für $DATEN/dienst ist nicht aktiv"
else
  echo "WARNUNG: auditd (augenrules) fehlt — Zugriffs-Protokoll der Tresor-Daten nicht aktiv" >&2
fi

# --- Bauen -------------------------------------------------------------------
KI_BUILD="$(git -C "$BASIS" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d-%H%M)"
export KI_BUILD
# Rückfall: der bisher laufende Stand bleibt als :vorher erhalten (README «Rückfall auf den vorherigen Build»).
for img in eventline-ki/dienst eventline-ki/caddy; do
  if docker image inspect "$img:local" >/dev/null 2>&1; then docker tag "$img:local" "$img:vorher"; fi
done
info "Images bauen (dienst, caddy) — Build $KI_BUILD"
compose build --pull dienst caddy

# --- Modelle (einmalig mit Internet, danach offline) -------------------------
if [ "$MIT_MODELLEN" = "1" ]; then
  info "Ollama-Modelle laden (Profil modelle)"
  compose --profile modelle run --rm ollama-modelle
  info "Whisper-Modell laden (Profil modelle)"
  compose --profile modelle run --rm whisper-modelle
else
  info "Modell-Downloads übersprungen (--ohne-modelle)"
fi

# --- Starten -----------------------------------------------------------------
info "Stack starten"
compose up -d --remove-orphans
systemctl start eventline-ki.service
# egress/ und caddy/ sind als Verzeichnisse eingebunden — Compose erstellt die Container bei
# einer geänderten Datei darin nicht neu. Beide lesen ihre Konfiguration deshalb hier neu ein
# (ohne Unterbruch; ein frisch gestarteter Container liest sie ohnehin).
info "Konfiguration von egress (Squid) und caddy neu einlesen"
SQUID_CONF=/etc/squid/eventline/squid.conf
nochmal 15 compose exec -T egress squid -k parse -f "$SQUID_CONF" >/dev/null 2>&1 \
  || fehler "squid.conf ist ungültig oder egress nicht bereit — Proxy läuft mit der alten Konfiguration weiter"
nochmal 15 compose exec -T egress squid -k reconfigure -f "$SQUID_CONF" \
  || fehler "Squid hat die Konfiguration nicht übernommen (docker compose … logs egress)"
nochmal 15 compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
  || fehler "Caddyfile ungültig oder Caddy nicht bereit (docker compose … logs caddy)"

# Jeder Container muss im Slice laufen (sonst gilt der 22-GB-Rahmen nicht).
for c in $(compose ps -q); do
  cg="$(sed -n 's/^0:://p' "/proc/$(docker inspect -f '{{.State.Pid}}' "$c")/cgroup" 2>/dev/null || true)"
  case "$cg" in
    "/system.slice/$SLICE/"*) ;;
    *) echo "WARNUNG: $(docker inspect -f '{{.Name}}' "$c") läuft nicht in $SLICE (${cg:-unbekannt})" >&2 ;;
  esac
done
systemctl enable --now eventline-ki-speicherprofil.timer >/dev/null

# --- Technik-Sammler (Technik-Dashboard, VERTRAG.md §1.1/§1.3) ----------------------------------------------
# Werkzeuge: smartmontools (SSD-Gesundheit) und der SNMP-Client «snmp» (NAS, ruht bis
# /etc/eventline-ki/technik-snmp.env existiert) — nur die Kommandozeilen-Werkzeuge, kein snmpd. Den mit
# smartmontools kommenden Überwachungs-Dienst smartd braucht hier niemand; er wird nach der Erstinstallation
# abgeschaltet (der Sammler ruft smartctl selbst alle 5 min). Fehlt das Internet, läuft der Sammler ohne
# diese Werte weiter («nicht_verfuegbar» / «werkzeug_fehlt»).
paket_installieren() {   # <befehl> <paket>
  command -v "$1" >/dev/null && return 0
  info "Paket $2 installieren (für den Technik-Sammler)"
  local apt=(env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 -y -q --no-install-recommends install "$2")
  if ! "${apt[@]}" >/dev/null; then
    apt-get -o DPkg::Lock::Timeout=120 -q update >/dev/null || true
    "${apt[@]}" >/dev/null || { echo "WARNUNG: $2 liess sich nicht installieren — Werte dazu fehlen" >&2; return 0; }
  fi
  [ "$2" = "smartmontools" ] && systemctl disable --now smartmontools.service smartd.service >/dev/null 2>&1 || true
}
paket_installieren smartctl smartmontools
paket_installieren snmpget snmp

# Lüftersensor: nur ein Treiber, der ohne Kernel-Parameter und ohne Neustart lädt UND danach Drehzahlen liefert,
# wird dauerhaft eingetragen. Sonst wird er wieder entladen und die Seite zeigt «kommt mit Freigabe am Rig».
# Geprüft wird einmal (Merker); neu prüfen: sudo rm /var/lib/eventline-technik/luefter-geprueft
LUEFTER_CONF=/etc/modules-load.d/eventline-technik.conf
LUEFTER_MERKER=/var/lib/eventline-technik/luefter-geprueft
if [ ! -f "$LUEFTER_CONF" ] && [ ! -f "$LUEFTER_MERKER" ]; then
  install -d -m 0755 /var/lib/eventline-technik
  vorher_geladen=0
  lsmod | grep -q '^it87 ' && vorher_geladen=1
  drehzahl=0
  if modprobe it87 2>/dev/null; then
    for h in /sys/class/hwmon/hwmon*; do
      case "$(cat "$h/name" 2>/dev/null)" in it87*|it8*) ;; *) continue ;; esac
      for f in "$h"/fan*_input; do
        [ -r "$f" ] || continue
        v="$(cat "$f" 2>/dev/null || echo 0)"
        [ "${v:-0}" -gt 0 ] 2>/dev/null && drehzahl=1
      done
    done
  fi
  if [ "$drehzahl" = "1" ]; then
    echo it87 > "$LUEFTER_CONF"
    info "Lüftersensor: Treiber lädt und liefert Drehzahlen — dauerhaft eingetragen ($LUEFTER_CONF)"
  else
    [ "$vorher_geladen" = "0" ] && modprobe -r it87 2>/dev/null || true
    echo "kein" > "$LUEFTER_MERKER"
    info "Lüftersensor: kein Treiber liefert ohne Kernel-Parameter Drehzahlen — bleibt aus (nichts erzwungen)"
  fi
fi

info "Technik-Sammler (neu) starten"
# reenable statt enable: legt auch neue [Install]-Verknüpfungen an (WantedBy eventline-ki-vault.service).
systemctl reenable "$TECHNIK_UNIT" >/dev/null 2>&1
systemctl restart "$TECHNIK_UNIT"
TECHNIK_STAND="$DATEN/dienst/technik/stand.json"
frisch=0
for _ in $(seq 1 20); do
  if [ -s "$TECHNIK_STAND" ] && [ $(( $(date +%s) - $(stat -c %Y "$TECHNIK_STAND") )) -lt 15 ]; then frisch=1; break; fi
  sleep 1
done
[ "$frisch" = "1" ] || echo "WARNUNG: $TECHNIK_STAND wird nicht geschrieben (journalctl -u $TECHNIK_UNIT)" >&2

echo
compose ps
echo
SCHWARM_NACHHER="$(systemctl is-active trust-one-swarm 2>/dev/null || true)"
info "Trust-one-Schwarm nachher: ${SCHWARM_NACHHER:-unbekannt}"
if [ "$SCHWARM_VORHER" = "active" ] && [ "$SCHWARM_NACHHER" != "active" ]; then
  echo "WARNUNG: trust-one-swarm läuft nicht mehr — bitte prüfen (dieses Skript hat ihn nicht angefasst)." >&2
fi
info "fertig — Logs: docker compose --env-file $ENV_DATEI -f $BASIS/docker-compose.yml logs -f dienst"
