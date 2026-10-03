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
install -d -m 0700 -o root -g root "$DATEN/ollama" "$DATEN/whisper" "$DATEN/caddy"
install -d -m 0700 -o 999 -g 999 "$DATEN/pg"
chmod 0700 "$DATEN"
chown 1500:1500 "$DATEN"

# --- systemd-Unit ------------------------------------------------------------
info "systemd-Unit installieren"
sed "s#$STANDARD_PFAD#$BASIS#g" "$UNIT_QUELLE" > "$UNIT_ZIEL.neu"
if ! cmp -s "$UNIT_ZIEL.neu" "$UNIT_ZIEL" 2>/dev/null; then
  mv "$UNIT_ZIEL.neu" "$UNIT_ZIEL"
else
  rm -f "$UNIT_ZIEL.neu"
fi
chmod 644 "$UNIT_ZIEL"
systemctl daemon-reload
systemctl enable eventline-ki.service >/dev/null

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

echo
compose ps
echo
SCHWARM_NACHHER="$(systemctl is-active trust-one-swarm 2>/dev/null || true)"
info "Trust-one-Schwarm nachher: ${SCHWARM_NACHHER:-unbekannt}"
if [ "$SCHWARM_VORHER" = "active" ] && [ "$SCHWARM_NACHHER" != "active" ]; then
  echo "WARNUNG: trust-one-swarm läuft nicht mehr — bitte prüfen (dieses Skript hat ihn nicht angefasst)." >&2
fi
info "fertig — Logs: docker compose --env-file $ENV_DATEI -f $BASIS/docker-compose.yml logs -f dienst"
