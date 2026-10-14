#!/usr/bin/env bash
# EVENTLINE Rig — Kühlung & LEDs einrichten/aktualisieren (idempotent, mit sudo). README «Kühlung & LEDs».
#   sudo bash /srv/eventline-ki/repo/eventline-ki/kuehlung/install.sh
# Installiert (Versionen fest, Prüfsummen geprüft): liquidctl 1.13.0-2 (apt), OpenLinkHub 0.9.2 (GitHub-Release),
# OpenRGB 1.0 (AppImage von Codeberg, ausgepackt nach /opt/openrgb-1.0) und die drei Units. Kein Kernel-Parameter,
# kein Neustart des Rigs. Trust one wird nicht angefasst.
set -euo pipefail

HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "braucht root (sudo)"; exit 1; }

OLH_VERSION=0.9.2
OLH_TAR_SHA256=e1a2211f01ab6229709a4cd7994b74e5f067af7bb11ef4cd2beaf69bc2244c0c   # GitHub-Release-Digest
OLH_URL="https://github.com/jurkovic-nikola/OpenLinkHub/releases/download/${OLH_VERSION}/OpenLinkHub_${OLH_VERSION}_amd64.tar.gz"
ORGB_DATEI=OpenRGB_1.0_x86_64_81bbe18.AppImage
ORGB_SHA256=a77d9fea9ab1e59e5ec2b5cec4ab22d50f0433594c4e83eb13de4e5c3cfadebf   # Codeberg veröffentlicht keine Summe: 14.10. festgehalten
ORGB_URL="https://codeberg.org/OpenRGB/OpenRGB/releases/download/release_1.0/${ORGB_DATEI}"
ORGB_ZIEL=/opt/openrgb-1.0
ORGB_KONF=/etc/eventline-kuehlung/openrgb
# Nur diese Erkenner laufen (alle ~1900 anderen aus — v. a. LINK-Hub und Kraken, die gehören OpenLinkHub/liquidctl):
ORGB_AN='["Gigabyte RGB Fusion 2 USB", "Corsair DRAM", "Gigabyte GeForce RTX 3070 MASTER"]'

ARBEIT="$(mktemp -d /tmp/eventline-kuehlung-XXXX)"
trap 'rm -rf "$ARBEIT"' EXIT

echo "== Pakete (apt)"
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  liquidctl=1.13.0-2 libpipewire-0.3-0t64 libegl1 libopengl0 libice6 libsm6 >/dev/null

echo "== OpenLinkHub ${OLH_VERSION}"
id openlinkhub >/dev/null 2>&1 || useradd -r openlinkhub --shell=/bin/false
if [ "$(cat /opt/OpenLinkHub/.eventline-version 2>/dev/null)" != "${OLH_VERSION}" ]; then
  curl -fsSL --max-time 300 -o "$ARBEIT/olh.tar.gz" "$OLH_URL"
  echo "${OLH_TAR_SHA256}  $ARBEIT/olh.tar.gz" | sha256sum -c --quiet
  mkdir "$ARBEIT/olh" && tar xzf "$ARBEIT/olh.tar.gz" -C "$ARBEIT/olh"
  systemctl stop OpenLinkHub 2>/dev/null || true
  if [ -d /opt/OpenLinkHub/database ]; then  # Zuordnungen behalten
    cp -a /opt/OpenLinkHub/database "$ARBEIT/database.alt"
  fi
  rm -rf /opt/OpenLinkHub
  cp -a "$ARBEIT/olh/OpenLinkHub" /opt/OpenLinkHub
  if [ -d "$ARBEIT/database.alt" ]; then
    cp -a "$ARBEIT/database.alt/profiles" "$ARBEIT/database.alt/temperatures" /opt/OpenLinkHub/database/ 2>/dev/null || true
  fi
  echo "${OLH_VERSION}" > /opt/OpenLinkHub/.eventline-version
fi
install -m 0644 "$HIER/openlinkhub-config.json" /opt/OpenLinkHub/config.json  # immer: nur 127.0.0.1, kein nvidia-smi
chown -R openlinkhub:openlinkhub /opt/OpenLinkHub
chmod -R u=rwX,go=rX /opt/OpenLinkHub
chmod 0755 /opt/OpenLinkHub/OpenLinkHub
install -m 0644 -o root -g root "$HIER/99-openlinkhub.rules" /etc/udev/rules.d/99-openlinkhub.rules
udevadm control --reload-rules
udevadm trigger --action=change --subsystem-match=usb --attr-match=idVendor=1b1c
udevadm trigger --action=change --subsystem-match=hidraw
udevadm settle --timeout=15

echo "== OpenRGB 1.0"
if [ "$(cat "$ORGB_ZIEL/.appimage.sha256" 2>/dev/null)" != "$ORGB_SHA256" ] || [ ! -x "$ORGB_ZIEL/AppRun" ]; then
  curl -fsSL --max-time 300 -o "$ARBEIT/$ORGB_DATEI" "$ORGB_URL"
  echo "${ORGB_SHA256}  $ARBEIT/$ORGB_DATEI" | sha256sum -c --quiet
  chmod 0755 "$ARBEIT/$ORGB_DATEI"
  chown nobody "$ARBEIT"
  (cd "$ARBEIT" && runuser -u nobody -- "./$ORGB_DATEI" --appimage-extract >/dev/null)
  rm -rf "$ORGB_ZIEL"
  cp -a "$ARBEIT/squashfs-root" "$ORGB_ZIEL"
  chown -R root:root "$ORGB_ZIEL"
  chmod -R go-w "$ORGB_ZIEL"
  echo "$ORGB_SHA256" > "$ORGB_ZIEL/.appimage.sha256"
fi
install -d -m 0700 -o root -g root /etc/eventline-kuehlung "$ORGB_KONF"
if [ ! -s "$ORGB_KONF/OpenRGB.json" ]; then
  # Liste aller Erkenner holen, OHNE zu erkennen: als nobody (kein Gerätezugriff) und mit 300 s Startverzögerung —
  # OpenRGB schreibt die Liste vor der Verzögerung und wird darin beendet. Dann nur die drei oben einschalten.
  LISTE="$ARBEIT/orgb-liste"
  install -d -o nobody "$LISTE"
  echo '{"Detectors":{"initial_detection_delay_ms":300000}}' > "$LISTE/OpenRGB.json"
  chown nobody "$LISTE/OpenRGB.json"
  runuser -u nobody -- timeout 25 "$ORGB_ZIEL/AppRun" --config "$LISTE" --noautoconnect --list-devices >/dev/null 2>&1 || true
  python3 - "$LISTE/OpenRGB.json" "$ORGB_AN" > "$ARBEIT/OpenRGB.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
alle = d["Detectors"]["detectors"]
an = set(json.loads(sys.argv[2]))
fehlt = an - set(alle)
assert not fehlt, f"Erkenner fehlen: {fehlt}"
d["Detectors"] = {"detectors": {k: (k in an) for k in alle}, "hid_safe_mode": False, "initial_detection_delay_ms": 0}
print(json.dumps(d, indent=1))
PY
  install -m 0600 -o root -g root "$ARBEIT/OpenRGB.json" "$ORGB_KONF/OpenRGB.json"
fi

echo "== Units"
install -m 0644 -o root -g root "$HIER/eventline-kuehlung.tmpfiles" /etc/tmpfiles.d/eventline-kuehlung.conf
systemd-tmpfiles --create /etc/tmpfiles.d/eventline-kuehlung.conf
for u in OpenLinkHub.service eventline-kuehlung-boot.service eventline-kuehlung.service; do
  install -m 0644 -o root -g root "$HIER/$u" "/etc/systemd/system/$u"
done
systemctl daemon-reload
systemctl enable eventline-kuehlung-boot.service OpenLinkHub.service eventline-kuehlung.service >/dev/null

echo "== Kurven nach OpenLinkHub, Start"
python3 "$HIER/kuehlung.py" olh-profile >/dev/null
systemctl restart eventline-kuehlung-boot.service || echo "WARNUNG: Start-Einrichtung meldet einen Fehler (journalctl -u eventline-kuehlung-boot)"
systemctl restart OpenLinkHub.service
systemctl restart eventline-kuehlung.service
sleep 15
ss -ltnp | grep -q '127.0.0.1:27003' || { echo "FEHLER: OpenLinkHub hört nicht auf 127.0.0.1:27003"; exit 1; }
if ss -ltnp | grep OpenLinkHub | grep -vq '127.0.0.1:27003'; then echo "FEHLER: OpenLinkHub hört nicht nur lokal"; exit 1; fi
python3 "$HIER/kuehlung.py" status
echo "fertig"
