#!/usr/bin/env bash
# EVENTLINE Technik-Dashboard — Zugang für die Mess-Container auf dem NAS erzeugen (läuft auf dem Rig, mit sudo).
# Vertrag: docs/technik-dashboard/VERTRAG.md §1.4 · Anleitung: README.md in diesem Ordner.
#
#   sudo bash zugang-erzeugen.sh            neues Zufallspasswort + bcrypt-Hash; schreibt
#                                           /etc/eventline-ki/technik-nas.env (root 0600, für den Technik-Sammler) und
#                                           /etc/eventline-ki/technik-nas-compose.yml (fertige Compose-Datei fürs NAS)
#                                           und gibt die Compose-Datei zum Kopieren aus
#   sudo bash zugang-erzeugen.sh --zeigen   die fertige Compose-Datei noch einmal ausgeben
#   sudo bash zugang-erzeugen.sh --neu      bestehenden Zugang ersetzen (danach die Compose-Datei im NAS neu einfügen)
#
# Das Passwort wird nie angezeigt und steht nie auf einer Kommandozeile; ins NAS kommt nur der Hash. Ohne die
# Env-Datei bleibt der Sammler wie bisher (NAS-Hardware «kommt mit NAS-Zugang»).

set -euo pipefail

BASIS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VORLAGE="$BASIS/docker-compose.yml"
ENV_DATEI=/etc/eventline-ki/technik-nas.env
COMPOSE_DATEI=/etc/eventline-ki/technik-nas-compose.yml
KI_ENV=/etc/eventline-ki/env
BENUTZER=messung
PLATZHALTER=BCRYPT_HASH_HIER_EINSETZEN

fehler() { echo "FEHLER: $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || fehler "bitte mit sudo starten"
NEU=0
case "${1:-}" in
  "") ;;
  --neu) NEU=1 ;;
  --zeigen)
    [ -s "$COMPOSE_DATEI" ] || fehler "noch kein Zugang erzeugt — zuerst ohne Zusatz starten"
    cat "$COMPOSE_DATEI"; exit 0 ;;
  *) fehler "unbekannte Option «$1» (erlaubt: --neu, --zeigen)" ;;
esac

[ -f "$VORLAGE" ] || fehler "Vorlage $VORLAGE fehlt"
grep -q "$PLATZHALTER" "$VORLAGE" || fehler "Vorlage ohne Platzhalter $PLATZHALTER"
grep -q "MESS_BENUTZER: $BENUTZER\$" "$VORLAGE" || fehler "Vorlage nennt einen anderen Benutzer als «$BENUTZER»"
if [ -e "$ENV_DATEI" ] && [ "$NEU" != "1" ]; then
  fehler "Zugang besteht schon ($ENV_DATEI). Compose noch einmal ausgeben: --zeigen · ersetzen: --neu"
fi
install -d -m 0700 -o root -g root /etc/eventline-ki

umask 077
PASSWORT="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
[ "${#PASSWORT}" -ge 30 ] || fehler "Zufallspasswort liess sich nicht erzeugen"

# bcrypt-Hash (Kosten 10): Python-crypt (bis Python 3.12 dabei), sonst htpasswd (Paket apache2-utils).
# Das Passwort geht über stdin (printf ist in bash eingebaut — kein eigener Prozess, keine Kommandozeile).
HASH="$(printf '%s' "$PASSWORT" | python3 -W ignore -c '
import sys
try:
    import crypt
except ImportError:
    sys.exit(3)
pw = sys.stdin.read()
h = crypt.crypt(pw, crypt.mksalt(crypt.METHOD_BLOWFISH, rounds=1 << 10))
if not h or not h.startswith("$2") or crypt.crypt(pw, h) != h:
    sys.exit(4)
print(h)
' 2>/dev/null || true)"
if [ -z "$HASH" ] && command -v htpasswd >/dev/null; then
  HASH="$(printf '%s' "$PASSWORT" | htpasswd -niBC 10 "$BENUTZER" 2>/dev/null | cut -d: -f2- || true)"
fi
case "$HASH" in
  '$2'?'$'??'$'*) ;;
  *) fehler "kein bcrypt-Hash möglich — Python mit crypt-Modul oder «apt install apache2-utils» nötig" ;;
esac

# Fertige Compose-Datei: Platzhalter → Hash, jedes «$» als «$$» (Compose-Schreibweise).
HASH_COMPOSE="${HASH//\$/\$\$}"
TMP_COMPOSE="$(mktemp /etc/eventline-ki/.technik-nas-compose.XXXXXX)"
sed "s|$PLATZHALTER|$HASH_COMPOSE|g" "$VORLAGE" > "$TMP_COMPOSE"
grep -q "$PLATZHALTER" "$TMP_COMPOSE" && { rm -f "$TMP_COMPOSE"; fehler "Platzhalter nicht ersetzt"; }

TMP_ENV="$(mktemp /etc/eventline-ki/.technik-nas.env.XXXXXX)"
{
  echo "# Technik-Dashboard: Zugang zu den Mess-Containern auf dem NAS (VERTRAG.md §1.4)."
  echo "# Erzeugt $(date -Iseconds) von nas-messung/zugang-erzeugen.sh. Root 0600 — sonst ignoriert der Sammler die Datei."
  echo "# NAS_EXPORTER_ADRESSE leer = Adresse aus der Einhänge-Konfiguration (NAS_HOST in /etc/eventline-ki/env)."
  echo "# Andere Ports nur, wenn sie auch in der Compose-Datei im NAS geändert sind."
  echo "NAS_EXPORTER_BENUTZER=$BENUTZER"
  echo "NAS_EXPORTER_PASSWORT=$PASSWORT"
  echo "NAS_EXPORTER_ADRESSE="
  echo "NAS_EXPORTER_PORT_SYSTEM=9100"
  echo "NAS_EXPORTER_PORT_PLATTEN=9633"
} > "$TMP_ENV"
unset PASSWORT
chown root:root "$TMP_ENV" "$TMP_COMPOSE"
chmod 0600 "$TMP_ENV" "$TMP_COMPOSE"
mv -f "$TMP_COMPOSE" "$COMPOSE_DATEI"
mv -f "$TMP_ENV" "$ENV_DATEI"

# Adresse des Rigs im Hausnetz (für die Firewall-Regel im NAS) — nur hier im Terminal, nirgends gespeichert.
NAS_HOST="$(sed -n 's/^NAS_HOST=//p' "$KI_ENV" 2>/dev/null | tr -d "\"' " | head -n1 || true)"
RIG_ADRESSE=""
if [ -n "$NAS_HOST" ]; then
  RIG_ADRESSE="$(ip -4 route get "$NAS_HOST" 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1 || true)"
fi

echo "================ Compose-Datei fürs NAS (alles zwischen den Linien kopieren) ================"
cat "$COMPOSE_DATEI"
echo "================================================================================================"
echo
echo "Zugang gespeichert: $ENV_DATEI (root 0600). Das Passwort wird nirgends angezeigt."
echo "Die Compose-Datei liegt auch in $COMPOSE_DATEI (erneut ausgeben: sudo bash $0 --zeigen)."
if [ -n "$RIG_ADRESSE" ]; then
  echo "Adresse des Rigs für die Firewall-Regel im NAS: $RIG_ADRESSE"
else
  echo "Adresse des Rigs: nicht ermittelbar — im Router oder mit «ip -4 addr» nachsehen."
fi
echo "Bis die Container im NAS laufen, zeigt /technik «NAS-Hardwarewerte: Fehler» — das ist normal."
