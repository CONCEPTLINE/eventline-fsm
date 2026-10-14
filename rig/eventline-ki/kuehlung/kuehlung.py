#!/usr/bin/env python3
"""EVENTLINE Rig — Kühlung & LEDs (README «Kühlung & LEDs»; Paket-Block rig.kuehlung, VERTRAG §1.1).

Host-Dienst als root (Python-Standardbibliothek; für die Pumpe die liquidctl-Bibliothek aus apt). Drei Teile:

  - Lüfter (7 am LINK-Hub): OpenLinkHub (eigener Dienst, nur 127.0.0.1:27003) fährt die Lüfterkurve des aktiven
    Profils. Ihr Eingang ist die Datei /run/eventline-kuehlung/regel_temp (m°C), die dieser Dienst alle 2 s schreibt:
    die CPU-Package-Temperatur, geglättet (steigt schnell, fällt langsam — sonst «pumpen» die Lüfter hörbar mit jeder
    Lastspitze), ab 88 °C ungeglättet; Kühlmittel ≥ 45 °C setzt sie auf 95 °C (= 100 % in jedem Profil). Steht dieser
    Dienst, wird regel_temp ein Verweis auf den CPU-Fühler (ExecStopPost «notfall», beim Start «boot») — OpenLinkHub
    regelt dann ungeglättet weiter, nie blind.
  - Pumpe (Kraken): Pumpenkurve nach Kühlmitteltemperatur im Gerät gespeichert (läuft ohne Software weiter), LED-Ring
    und Logo aus. Geht bei Stromverlust verloren → beim Start und alle 15 min neu gesetzt (idempotent).
  - Mainboard, RAM, Grafikkarte: LEDs aus über OpenRGB 1.0 beim Start (nur drei Erkenner aktiv, kein Hub, keine Pumpe).

Wächter für OpenLinkHub: antwortet die API 30 s nicht (Dienst läuft aber) → Neustart (höchstens alle 5 min). Ist der
Dienst 60 s nicht aktiv, übernimmt dieser Dienst den Hub selbst mit 100 % («Notbetrieb», gemessen: ohne Software fällt
der Hub auf ~500 U/min); startet OpenLinkHub wieder, gibt er den Hub sofort frei (Sperrdatei hub.lock).

Profil: Wunsch aus der App in /srv/eventline-ki/data/dienst/steuerung/luefter_profil (schreibt der KI-Dienst, nur der
Profilname, hier geprüft), gemerkt in /var/lib/eventline-kuehlung/profil (gilt auch ohne Tresor, Start: ausgewogen).
Status für den Technik-Sammler: /run/eventline-kuehlung/status.json (nur Zahlen und Zustandswörter, keine
Seriennummern, Gerätenamen oder Marken).

  kuehlung.py boot           einmal beim Start (eventline-kuehlung-boot.service)
  kuehlung.py dienst         Dauerdienst (eventline-kuehlung.service, systemd-Wächter)
  kuehlung.py notfall        ExecStopPost: regel_temp → Verweis auf den CPU-Fühler
  kuehlung.py profil NAME    Profil von Hand setzen (leise | ausgewogen | kuehl), der Dienst übernimmt es ≤ 15 s
  kuehlung.py olh-profile    die drei Kurven als OpenLinkHub-Profile schreiben (install.sh, danach Neustart OLH)
  kuehlung.py status         Status-Datei lesbar ausgeben
  kuehlung.py hub-lesen      Drehzahlen direkt vom Hub — NUR wenn OpenLinkHub steht (Ausfalltest); --wach: vorher
                             Software-Modus, danach zurück in den Hardware-Modus (wie OpenLinkHub beim Stop)
"""

from __future__ import annotations

import fcntl
import glob
import json
import logging
import math
import os
import select
import signal
import socket
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger("kuehlung")

# --- Pfade -------------------------------------------------------------------------------------------------------

LAUFZEIT = Path("/run/eventline-kuehlung")
REGEL = LAUFZEIT / "regel_temp"
STATUS = LAUFZEIT / "status.json"
BOOT_STAND = LAUFZEIT / "boot.json"
HUB_SPERRE = LAUFZEIT / "hub.lock"
ZUSTAND = Path("/var/lib/eventline-kuehlung")
PROFIL_DATEI = ZUSTAND / "profil"
KANAELE_DATEI = ZUSTAND / "kanaele.json"
WUNSCH = Path("/srv/eventline-ki/data/dienst/steuerung/luefter_profil")
WUNSCH_UIDS = (0, 1500)  # root oder der KI-Dienst (eventline-ki)
WUNSCH_MAX_B = 64

OLH_URL = "http://127.0.0.1:27003"
OLH_UNIT = "OpenLinkHub.service"
OLH_PROFIL_ORDNER = Path("/opt/OpenLinkHub/database/temperatures")
OLH_HUB = "iCUE LINK System Hub"
OLH_ZEITLIMIT_S = 3.0
OPENRGB = ["/opt/openrgb-1.0/AppRun", "--config", "/etc/eventline-kuehlung/openrgb", "--noautoconnect"]

# --- Profile (einzige Quelle der Kurven; README «Kühlung & LEDs» begründet sie) ------------------------------------
# luefter: (Regeltemperatur °C, Leistung %) — Eingang ist regel_temp (geglättete CPU-Package-Temperatur).
# pumpe:   (Kühlmittel °C, Leistung %) — im Kraken gespeichert, das Gerät regelt selbst.
# Sicherheitsboden in allen Profilen (test_technik.py prüft ihn): Lüfter nie unter 25 %, Pumpe nie unter 50 %,
# Lüfter 100 % ab Regeltemperatur 90 °C, Pumpe 100 % ab Kühlmittel 45 °C (und Kühlmittel ≥ 45 °C → Lüfter 100 %).

PROFILE: dict[str, dict[str, Any]] = {
    "leise": {
        "olh": "eventlineLeise",
        "luefter": [(45, 25), (60, 30), (70, 40), (78, 60), (85, 80), (90, 100)],
        "pumpe": [(30, 50), (36, 55), (40, 70), (43, 85), (45, 100)],
    },
    "ausgewogen": {
        "olh": "eventlineAusgewogen",
        "luefter": [(40, 25), (50, 28), (60, 38), (68, 55), (76, 75), (84, 100)],
        "pumpe": [(30, 55), (35, 65), (40, 80), (43, 90), (45, 100)],
    },
    "kuehl": {
        "olh": "eventlineKuehl",
        "luefter": [(35, 30), (50, 45), (60, 60), (68, 80), (75, 100)],
        "pumpe": [(30, 70), (35, 85), (40, 100)],
    },
}
STANDARD_PROFIL = "ausgewogen"
LUEFTER_MIN = 25
PUMPE_MIN = 50
CPU_VOLL_C = 90
KUEHLMITTEL_VOLL_C = 45.0
REGEL_DIREKT_AB_C = 88.0  # ab hier folgt die Regeltemperatur der CPU ungeglättet
REGEL_ZWANG_C = 95.0  # Kühlmittel ≥ 45 °C → Regeltemperatur 95 °C → 100 % in jedem Profil
REGEL_OHNE_FUEHLER_C = 90.0  # CPU-Fühler nicht lesbar → so tun, als wäre es heiss (100 %)
TAU_AUF_S = 10.0
TAU_AB_S = 60.0
NOTBETRIEB_PROZENT = 100

TAKT_S = 2.0
STATUS_S = 10.0
WUNSCH_S = 15.0
KRAKEN_NEU_S = 900.0
OLH_STUMM_NEUSTART_S = 30.0
OLH_NEUSTART_PAUSE_S = 300.0
OLH_WEG_NOTBETRIEB_S = 60.0
KUEHLMITTEL_MAX_ALTER_S = 60.0

GRUND_RANG = ("notbetrieb", "hub_dienst_steht", "hub_antwortet_nicht", "pumpe_nicht_lesbar", "cpu_fuehler_fehlt")


# --- Kleine Helfer -------------------------------------------------------------------------------------------------


def jetzt_iso(t: float | None = None) -> str:
    return datetime.fromtimestamp(time.time() if t is None else t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def schreibe_atomar(pfad: Path, text: str, modus: int = 0o644) -> None:
    """tmp im selben Ordner + rename — ersetzt auch einen Verweis (regel_temp) durch eine echte Datei."""
    tmp = pfad.with_name(f".{pfad.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, modus)
    try:
        os.fchmod(fd, modus)
        os.write(fd, text.encode())
    finally:
        os.close(fd)
    os.replace(tmp, pfad)


def interpolieren(punkte: list[tuple[float, float]], x: float) -> float:
    """Wie OpenLinkHub temperatures.Interpolate (und liquidctl): unter/über den Enden festgehalten, dazwischen linear."""
    p = sorted(punkte)
    if x <= p[0][0]:
        return float(p[0][1])
    if x >= p[-1][0]:
        return float(p[-1][1])
    for (x0, y0), (x1, y1) in zip(p, p[1:]):
        if x0 <= x <= x1:
            return y0 + (x - x0) / (x1 - x0) * (y1 - y0)
    return float(p[-1][1])


def soll_luefter(profil: str, regel_c: float) -> int:
    """Leistung, die OpenLinkHub bei dieser Regeltemperatur vorgibt (gleiche Rundung und Grenzen 20…100)."""
    wert = int(math.floor(interpolieren(PROFILE[profil]["luefter"], regel_c) + 0.5))
    return max(20, min(100, wert))


def profil_gueltig(name: Any) -> str | None:
    return name if isinstance(name, str) and name in PROFILE else None


# --- Regeltemperatur -------------------------------------------------------------------------------------------------


class Glaetter:
    """Exponentielles Mittel mit zwei Zeitkonstanten: steigt schnell (TAU_AUF_S), fällt langsam (TAU_AB_S)."""

    def __init__(self, tau_auf: float = TAU_AUF_S, tau_ab: float = TAU_AB_S) -> None:
        self.tau_auf, self.tau_ab = tau_auf, tau_ab
        self.wert: float | None = None

    def neu(self, roh: float, dt: float) -> float:
        if self.wert is None:
            self.wert = roh
        else:
            tau = self.tau_auf if roh > self.wert else self.tau_ab
            self.wert += (roh - self.wert) * (1.0 - math.exp(-max(dt, 0.0) / tau))
        return self.wert


def regel_berechnen(geglaettet: float | None, roh: float | None, kuehlmittel: float | None) -> float:
    """Eingang der Lüfterkurve. Roh ab 88 °C (Sicherheit vor Ruhe), Kühlmittel ≥ 45 °C → 95 °C, ohne Fühler → 90 °C."""
    if roh is None or geglaettet is None:
        wert = REGEL_OHNE_FUEHLER_C
    else:
        wert = max(geglaettet, roh) if roh >= REGEL_DIREKT_AB_C else geglaettet
    if kuehlmittel is not None and kuehlmittel >= KUEHLMITTEL_VOLL_C:
        wert = max(wert, REGEL_ZWANG_C)
    return wert


def cpu_fuehler() -> Path | None:
    """tempN_input des coretemp-Pakets («Package id 0»); hwmon-Nummern wechseln je Start, darum jedes Mal suchen."""
    for d in sorted(Path("/sys/class/hwmon").glob("hwmon*")):
        try:
            if (d / "name").read_text().strip() not in ("coretemp", "k10temp"):
                continue
        except OSError:
            continue
        for label in sorted(d.glob("temp*_label")):
            try:
                text = label.read_text().strip().lower()
            except OSError:
                continue
            if text.startswith("package") or text in ("tctl", "tdie"):
                return label.with_name(label.name.replace("_label", "_input"))
        if (d / "temp1_input").exists():
            return d / "temp1_input"
    return None


def lies_temp(pfad: Path | None) -> float | None:
    if pfad is None:
        return None
    try:
        wert = int(pfad.read_text().strip()) / 1000.0
    except (OSError, ValueError):
        return None
    return wert if 0.0 < wert < 130.0 else None


def notfall_verweis() -> bool:
    """regel_temp → Verweis auf den CPU-Fühler (OpenLinkHub liest dann die rohe CPU-Temperatur)."""
    ziel = cpu_fuehler()
    if ziel is None:
        return False
    LAUFZEIT.mkdir(mode=0o755, exist_ok=True)
    tmp = REGEL.with_name(f".{REGEL.name}.verweis")
    try:
        os.unlink(tmp)
    except FileNotFoundError:
        pass
    os.symlink(ziel, tmp)
    os.replace(tmp, REGEL)
    return True


# --- Profil merken, Wunsch der App ---------------------------------------------------------------------------------


def profil_laden(pfad: Path = PROFIL_DATEI) -> str:
    try:
        return profil_gueltig(pfad.read_text(encoding="ascii").strip()) or STANDARD_PROFIL
    except (OSError, UnicodeDecodeError):
        return STANDARD_PROFIL


def profil_merken(profil: str, pfad: Path = PROFIL_DATEI) -> None:
    pfad.parent.mkdir(mode=0o755, exist_ok=True)
    schreibe_atomar(pfad, profil + "\n")


def wunsch_lesen(pfad: Path = WUNSCH, uids: tuple[int, ...] = WUNSCH_UIDS) -> tuple[str | None, str]:
    """Wunschprofil aus dem Tresor (Ordner gehört dem KI-Dienst — root liest darum vorsichtig): Ordner echt (kein
    Verweis), Datei regulär, kein Verweis, höchstens 64 B, Besitzer root oder 1500, Inhalt genau ein Profilname.
    Rückgabe (Profil | None, Grund) — Grund nur fürs Log («fehlt», «ungueltig», «ok»)."""
    try:
        ordner = os.lstat(pfad.parent)
    except OSError:
        return None, "fehlt"
    if not stat.S_ISDIR(ordner.st_mode) or ordner.st_uid not in uids:
        return None, "ungueltig"
    try:
        fd = os.open(pfad, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_NOCTTY)
    except FileNotFoundError:
        return None, "fehlt"
    except OSError:
        return None, "ungueltig"
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid not in uids or st.st_size > WUNSCH_MAX_B:
            return None, "ungueltig"
        roh = os.read(fd, WUNSCH_MAX_B + 1)
    finally:
        os.close(fd)
    try:
        profil = profil_gueltig(roh.decode("ascii").strip())
    except UnicodeDecodeError:
        profil = None
    return (profil, "ok") if profil else (None, "ungueltig")


# --- OpenLinkHub (REST, nur 127.0.0.1) -------------------------------------------------------------------------------


def olh_anfrage(pfad: str, daten: dict[str, Any] | None = None) -> Any:
    req = urllib.request.Request(OLH_URL + pfad, method="POST" if daten is not None else "GET",
                                 data=json.dumps(daten).encode() if daten is not None else None,
                                 headers={"Content-Type": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=OLH_ZEITLIMIT_S) as r:
        return json.loads(r.read(4 << 20))


def olh_hub() -> tuple[str, dict[int, dict[str, Any]]] | None:
    """(Seriennummer — bleibt hier, Kanäle) des LINK-Hubs, oder None."""
    antwort = olh_anfrage("/api/devices/")
    for eintrag in (antwort.get("devices") or {}).values():
        g = eintrag.get("GetDevice") if isinstance(eintrag, dict) else None
        if isinstance(g, dict) and g.get("product") == OLH_HUB and isinstance(g.get("devices"), dict):
            kanaele = {}
            for k, v in g["devices"].items():
                if isinstance(v, dict) and str(k).isdigit():
                    kanaele[int(k)] = v
            return str(g.get("serial") or ""), kanaele
    return None


def olh_setzen(art: str, seriennummer: str, profil: str) -> bool:
    pfad = {"speed": "/api/speed", "color": "/api/color"}[art]
    antwort = olh_anfrage(pfad, {"deviceId": seriennummer, "channelId": -1, "profile": profil})
    return isinstance(antwort, dict) and antwort.get("status") == 1


def olh_profil_daten(profil: str) -> dict[str, Any]:
    """OpenLinkHub-Temperaturprofil (database/temperatures/<name>.json): Fühler «External HwMon» = regel_temp."""
    punkte = PROFILE[profil]["luefter"]
    stufen = []
    vorher = 0.0
    for i, (x, y) in enumerate(punkte):
        stufen.append({"id": i + 1, "min": vorher, "max": float(x), "mode": 0, "fans": int(y), "pump": 70})
        vorher = float(x)
    stufen.append({"id": len(punkte) + 1, "min": vorher, "max": 200.0, "mode": 0, "fans": 100, "pump": 100})
    return {
        "sensor": 6, "zeroRpm": False, "profiles": stufen,
        "points": {"0": [{"x": 0.0, "y": 70.0}, {"x": 100.0, "y": 100.0}],
                   "1": [{"x": float(x), "y": float(y)} for x, y in punkte]},
        "device": str(REGEL), "hwmonDevice": "", "temperatureInputId": "", "channelId": 0, "linear": False,
        "gpuIndex": 0, "sensorString": "External HwMon", "Hidden": False,
    }


def kind_env() -> dict[str, str]:
    """Umgebung für Kindprozesse ohne die systemd-Wächter-Variablen (sonst melden sie sich fälschlich bei systemd)."""
    return {k: v for k, v in os.environ.items() if k not in ("NOTIFY_SOCKET", "WATCHDOG_PID", "WATCHDOG_USEC")}


def olh_unit_zustand() -> str:
    try:
        r = subprocess.run(["systemctl", "is-active", OLH_UNIT], capture_output=True, text=True, timeout=5,
                           env=kind_env())
        return r.stdout.strip() or "unbekannt"
    except (OSError, subprocess.TimeoutExpired):
        return "unbekannt"


# --- Kraken (liquidctl-Bibliothek; erst bei Bedarf geladen, damit die Tests ohne liquidctl laufen) ------------------


def kraken_finden() -> Any:
    from liquidctl.driver.kraken3 import KrakenX3  # noqa: PLC0415

    for geraet in KrakenX3.find_supported_devices():
        return geraet
    return None


def kraken_einrichten(profil: str, initialisieren: bool) -> bool:
    """Pumpenkurve (im Gerät) + LED-Ring/Logo aus. Idempotent."""
    geraet = kraken_finden()
    if geraet is None:
        return False
    with geraet.connect():
        if initialisieren:
            geraet.initialize()
        geraet.set_speed_profile("pump", PROFILE[profil]["pumpe"])
        geraet.set_color("sync", "off", [])
    return True


def kraken_status() -> dict[str, float] | None:
    geraet = kraken_finden()
    if geraet is None:
        return None
    with geraet.connect():
        werte = {k: v for k, v, _e in geraet.get_status()}
    t, rpm, duty = werte.get("Liquid temperature"), werte.get("Pump speed"), werte.get("Pump duty")
    ergebnis: dict[str, float] = {}
    if isinstance(t, (int, float)) and 5.0 < t < 90.0:
        ergebnis["kuehlmittel_c"] = round(float(t), 1)
    if isinstance(rpm, (int, float)) and 0 <= rpm < 10_000:
        ergebnis["pumpe_rpm"] = int(rpm)
    if isinstance(duty, (int, float)) and 0 <= duty <= 100:
        ergebnis["pumpe_prozent"] = int(duty)
    return ergebnis or None


# --- LINK-Hub direkt (Notbetrieb und Ausfalltest; Protokoll wie OpenLinkHub src/devices/lsh) ------------------------


class HubDirekt:
    SOFTWARE = bytes([0x01, 0x03, 0x00, 0x02])
    HARDWARE = bytes([0x01, 0x03, 0x00, 0x01])
    SCHLIESSEN = bytes([0x05, 0x01, 0x01])
    OEFFNEN = bytes([0x0D, 0x01])
    LESEN = bytes([0x08, 0x01])
    SCHREIBEN = bytes([0x06, 0x01])
    EP_DREHZAHL, TYP_DREHZAHL = bytes([0x17]), bytes([0x25, 0x00])
    EP_LEISTUNG, TYP_LEISTUNG = bytes([0x18]), bytes([0x07, 0x00])

    def __init__(self) -> None:
        pfad = self.finden()
        if pfad is None:
            raise OSError("LINK-Hub nicht gefunden")
        self.fd = os.open(pfad, os.O_RDWR | os.O_CLOEXEC)

    @staticmethod
    def finden() -> str | None:
        for h in sorted(glob.glob("/sys/class/hidraw/hidraw*")):
            try:
                ue = Path(h, "device", "uevent").read_text()
                nr = Path(h, "device", "..", "bInterfaceNumber").read_text().strip()
            except OSError:
                continue
            if "HID_ID=0003:00001B1C:00000C3F" in ue and nr == "00":
                return "/dev/" + os.path.basename(h)
        return None

    def schliessen(self) -> None:
        os.close(self.fd)

    def _transfer(self, befehl: bytes, daten: bytes = b"") -> bytes | None:
        puffer = bytearray(513)
        puffer[2] = 0x01
        puffer[3:3 + len(befehl)] = befehl
        puffer[3 + len(befehl):3 + len(befehl) + len(daten)] = daten
        os.write(self.fd, bytes(puffer))
        bereit, _, _ = select.select([self.fd], [], [], 0.5)
        return os.read(self.fd, 512) if bereit else None

    def modus(self, software: bool) -> bool:
        r = self._transfer(self.SOFTWARE if software else self.HARDWARE)
        return r is not None and r[3] == 0

    def drehzahlen(self) -> dict[int, int] | None:
        """{Kanal: U/min}; None, wenn der Hub nicht antwortet (z. B. im Hardware-Modus)."""
        self._transfer(self.SCHLIESSEN, self.EP_DREHZAHL)
        self._transfer(self.OEFFNEN, self.EP_DREHZAHL)
        b = self._transfer(self.LESEN, self.EP_DREHZAHL)
        if b is not None and b[4:6] == self.TYP_DREHZAHL:
            self._transfer(self.LESEN, self.EP_DREHZAHL)  # zweiter Teil, wie OpenLinkHub read()
        self._transfer(self.SCHLIESSEN, self.EP_DREHZAHL)
        if not b or b[3] != 0 or b[4:6] != self.TYP_DREHZAHL:
            return None
        werte = {}
        for i in range(b[6]):
            e = b[7 + i * 3:10 + i * 3]
            if len(e) == 3 and e[0] == 0:
                werte[i] = int.from_bytes(e[1:3], "little", signed=True)
        return werte

    def leistung(self, kanaele: list[int], prozent: int) -> bool:
        daten = bytearray([len(kanaele)])
        for k in sorted(kanaele):
            daten += bytes([k, 0, prozent, 0])
        nutz = bytearray(4 + len(self.TYP_LEISTUNG) + len(daten))
        nutz[0:2] = (len(daten) + 2).to_bytes(2, "little")
        nutz[4:6] = self.TYP_LEISTUNG
        nutz[6:] = daten
        self._transfer(self.SCHLIESSEN, self.EP_LEISTUNG)
        self._transfer(self.OEFFNEN, self.EP_LEISTUNG)
        r = self._transfer(self.SCHREIBEN, bytes(nutz))
        self._transfer(self.SCHLIESSEN, self.EP_LEISTUNG)
        return r is not None and r[3] == 0


# --- Status für den Sammler -----------------------------------------------------------------------------------------


LUEFTER_ORTE_DATEI = Path("/etc/eventline-kuehlung/luefter-orte.json")
ORTE = ("radiator", "front", "heck", "boden", "unbekannt")


def orte_laden(pfad: Path = LUEFTER_ORTE_DATEI) -> dict[int, str]:
    """Ort je Hub-Kanal, von Hand zugeordnet ({"1": "radiator", "13": "heck", …}). Der Hub selbst weiss nicht, wo ein
    Lüfter sitzt — ohne Datei (oder für fehlende/ungültige Einträge) bleibt der Ort «unbekannt». Nie geraten."""
    orte: dict[int, str] = {}
    d = lies_json(pfad)
    for k, v in d.items():
        if str(k).isdigit() and 0 <= int(k) < 64 and v in ORTE:
            orte[int(k)] = v
    return orte


def status_bauen(*, profil: str, gruende: list[str], kanaele: dict[int, int] | None, prozent: int | None,
                 kraken: dict[str, float] | None, leds: str, orte: dict[int, str] | None = None,
                 t: float | None = None) -> dict[str, Any]:
    """Block «kuehlung» (Vertrag rig.kuehlung) plus gemessen_am. Lüfter in Kanal-Reihenfolge nummeriert; Ort aus
    luefter-orte.json, sonst «unbekannt». prozent = vorgegebene Leistung (Kurve bzw. Notbetrieb). Ist die Pumpe nicht
    auslesbar (keine Drehzahl), ist der Status «fehler»/pumpe_nicht_lesbar — «ok» mit pumpe_rpm 0 heisst: steht."""
    gruende = list(gruende)
    if not kraken or not isinstance(kraken.get("pumpe_rpm"), int):
        gruende.append("pumpe_nicht_lesbar")
    grund = next((g for g in GRUND_RANG if g in gruende), None)
    block: dict[str, Any] = {"gemessen_am": jetzt_iso(t), "status": "fehler" if grund else "ok"}
    if grund:
        block["grund"] = grund
    block["profil_aktiv"] = profil
    if kanaele:
        block["luefter"] = [{"nr": i + 1, "ort": (orte or {}).get(k, "unbekannt"), "rpm": max(0, int(rpm)),
                             **({"prozent": prozent} if prozent is not None else {})}
                            for i, (k, rpm) in enumerate(sorted(kanaele.items()))]
    for k in ("pumpe_rpm", "pumpe_prozent", "kuehlmittel_c"):
        if kraken and k in kraken:
            block[k] = kraken[k]
    block["leds"] = leds if leds in ("aus", "an", "unbekannt") else "unbekannt"
    return block


def leds_zustand(boot: dict[str, Any], olh_rgb: list[str] | None) -> str:
    """«aus» nur, wenn alle Teile es bestätigt haben: Hub-Lüfter (OpenLinkHub meldet «off»), Pumpe und
    Mainboard/RAM/Grafikkarte (Rückmeldung von liquidctl/OpenRGB seit diesem Start)."""
    if olh_rgb and any(p != "off" for p in olh_rgb):
        return "an"
    if olh_rgb and boot.get("pumpe_leds_aus") is True and boot.get("board_leds_aus") is True:
        return "aus"
    return "unbekannt"


def lies_json(pfad: Path) -> dict[str, Any]:
    try:
        d = json.loads(pfad.read_text())
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


# --- Unterbefehl boot -----------------------------------------------------------------------------------------------


def warte_auf(bedingung: Any, sekunden: float) -> bool:
    ende = time.monotonic() + sekunden
    while True:
        if bedingung():
            return True
        if time.monotonic() >= ende:
            return False
        time.sleep(1.0)


def i2c_bereit() -> bool:
    namen = []
    for d in glob.glob("/sys/bus/i2c/devices/i2c-*"):
        try:
            namen.append(Path(d, "name").read_text())
        except OSError:
            pass
    smbus = any("SMBus I801" in n for n in namen)
    nvidia_gpu = any(Path(p).read_text().strip() == "0x10de" and Path(p).with_name("class").read_text().startswith("0x03")
                     for p in glob.glob("/sys/bus/pci/devices/*/vendor"))
    return smbus and (not nvidia_gpu or any("NVIDIA i2c adapter" in n for n in namen))


def openrgb_aus() -> bool:
    """Mainboard, RAM, Grafikkarte: Modus «Direct», Farbe schwarz (= aus; keines dieser Geräte kennt «Off»)."""
    try:
        r = subprocess.run(OPENRGB + ["--mode", "direct", "--color", "000000"], capture_output=True, timeout=120,
                           stdin=subprocess.DEVNULL, env=kind_env())
    except (OSError, subprocess.TimeoutExpired):
        return False
    return r.returncode == 0


def boot() -> int:
    LAUFZEIT.mkdir(mode=0o755, exist_ok=True)
    if not os.path.lexists(REGEL) or os.path.islink(REGEL):
        notfall_verweis()  # bis der Dauerdienst schreibt, regelt OpenLinkHub nach der rohen CPU-Temperatur
    profil = profil_laden()
    pumpe = False
    for _ in range(15):  # die Pumpe meldet sich kurz nach dem USB-Start
        try:
            pumpe = kraken_einrichten(profil, initialisieren=True)
        except Exception as e:  # noqa: BLE001
            log.warning("Pumpe: %s", type(e).__name__)
        if pumpe:
            break
        time.sleep(2.0)
    if not warte_auf(i2c_bereit, 45.0):
        log.warning("SMBus/Grafikkarten-I2C nicht bereit — LEDs trotzdem versucht")
    board = openrgb_aus()
    LAUFZEIT.mkdir(mode=0o755, exist_ok=True)
    schreibe_atomar(BOOT_STAND, json.dumps({"am": jetzt_iso(), "profil": profil, "pumpe_leds_aus": pumpe,
                                            "pumpe_kurve": pumpe, "board_leds_aus": board}))
    log.info("Start: Profil %s, Pumpe %s, LEDs Mainboard/RAM/Grafikkarte %s", profil, "ok" if pumpe else "FEHLER",
             "aus" if board else "FEHLER")
    return 0 if pumpe and board else 1


# --- Unterbefehl dienst ---------------------------------------------------------------------------------------------


def sd_notify(text: str) -> None:
    adresse = os.environ.get("NOTIFY_SOCKET")
    if not adresse:
        return
    if adresse.startswith("@"):
        adresse = "\0" + adresse[1:]
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM | socket.SOCK_CLOEXEC) as s:
            s.connect(adresse)
            s.sendall(text.encode())
    except OSError:
        pass


class Dienst:
    def __init__(self) -> None:
        self.halt = False
        self.profil = profil_laden()
        self.profil_mtime = self._mtime(PROFIL_DATEI)
        self.wunsch_zuletzt: str | None = None
        self.wunsch_log: str | None = None
        self.glaetter = Glaetter()
        self.fuehler = cpu_fuehler()
        self.roh: float | None = None
        self.regel: float = REGEL_OHNE_FUEHLER_C
        self.kraken: dict[str, float] | None = None
        self.kraken_am = 0.0
        self.kraken_neu_am = 0.0
        self.kanaele: dict[int, int] | None = None
        self.olh_rgb: list[str] | None = None
        self.olh_zustand = "unbekannt"
        self.olh_profil_ok = False
        self.notbetrieb_kanaele: list[int] = []
        self.olh_gesund_am = time.monotonic()
        self.olh_aktiv_am = time.monotonic()
        self.olh_neustart_am = 0.0
        self.notbetrieb: HubDirekt | None = None
        self.sperre_fd: int | None = None
        self.log_zustand: str | None = None
        self.faellig: dict[str, float] = {}

    @staticmethod
    def _mtime(p: Path) -> float | None:
        try:
            return p.stat().st_mtime
        except OSError:
            return None

    def _faellig(self, was: str, takt: float) -> bool:
        jetzt = time.monotonic()
        if jetzt >= self.faellig.get(was, 0.0):
            self.faellig[was] = jetzt + takt
            return True
        return False

    def _zustand_loggen(self, text: str, warnung: bool = False) -> None:
        if text != self.log_zustand:
            (log.warning if warnung else log.info)("%s", text)
            self.log_zustand = text

    # Regeltemperatur alle 2 s
    def regeln(self, dt: float) -> None:
        if self.fuehler is None or not self.fuehler.exists():
            self.fuehler = cpu_fuehler()
        self.roh = lies_temp(self.fuehler)
        geglaettet = self.glaetter.neu(self.roh, dt) if self.roh is not None else None
        kuehlmittel = self.kraken.get("kuehlmittel_c") if self.kraken and \
            time.monotonic() - self.kraken_am < KUEHLMITTEL_MAX_ALTER_S else None
        self.regel = regel_berechnen(geglaettet, self.roh, kuehlmittel)
        schreibe_atomar(REGEL, f"{int(round(self.regel * 1000))}\n")

    # Profil: von Hand (Datei in /var/lib) oder Wunsch der App (Tresor)
    def profil_pruefen(self) -> None:
        mtime = self._mtime(PROFIL_DATEI)
        if mtime != self.profil_mtime:
            self.profil_mtime = mtime
            von_hand = profil_laden()
            if von_hand != self.profil:
                self.anwenden(von_hand, "von Hand")
        wunsch, grund = wunsch_lesen()
        if grund != self.wunsch_log:
            if grund == "ungueltig":
                log.warning("Wunschprofil der App ungültig — bisheriges bleibt")
            self.wunsch_log = grund
        if wunsch and wunsch != self.wunsch_zuletzt:
            self.wunsch_zuletzt = wunsch
            if wunsch != self.profil:
                self.anwenden(wunsch, "aus der App")

    def anwenden(self, profil: str, quelle: str) -> None:
        self.profil = profil
        profil_merken(profil)
        self.profil_mtime = self._mtime(PROFIL_DATEI)
        log.info("Profil %s (%s)", profil, quelle)
        self.kraken_neu(initialisieren=False)
        self.olh_pruefen()  # setzt das Profil am Hub, sobald OpenLinkHub antwortet

    def kraken_neu(self, initialisieren: bool) -> None:
        self.kraken_neu_am = time.monotonic()
        try:
            ok = kraken_einrichten(self.profil, initialisieren)
        except Exception as e:  # noqa: BLE001 — z. B. nach Stromverlust: einmal mit Initialisierung
            log.warning("Pumpe setzen: %s — mit Initialisierung erneut", type(e).__name__)
            try:
                ok = kraken_einrichten(self.profil, True)
            except Exception as e2:  # noqa: BLE001
                log.warning("Pumpe setzen gescheitert: %s", type(e2).__name__)
                ok = False
        if ok:
            boot_stand = lies_json(BOOT_STAND)
            if not boot_stand.get("pumpe_leds_aus"):
                boot_stand["pumpe_leds_aus"] = True
                schreibe_atomar(BOOT_STAND, json.dumps(boot_stand))

    def kraken_lesen(self) -> None:
        try:
            k = kraken_status()
        except Exception:  # noqa: BLE001
            k = None
        if k:
            self.kraken, self.kraken_am = k, time.monotonic()
        elif time.monotonic() - self.kraken_am > KUEHLMITTEL_MAX_ALTER_S:
            self.kraken = None

    # OpenLinkHub: gesund? Profil und LEDs richtig? Sonst Neustart bzw. Notbetrieb.
    def olh_pruefen(self) -> None:
        jetzt = time.monotonic()
        zustand = self.olh_zustand = olh_unit_zustand()
        if zustand in ("active", "activating", "reloading"):
            self.olh_aktiv_am = jetzt
            self.notbetrieb_ende()
        if zustand != "active":
            self.olh_rgb, self.olh_profil_ok = None, False
            if self.notbetrieb is None:
                self.kanaele = None
                if jetzt - self.olh_aktiv_am >= OLH_WEG_NOTBETRIEB_S:
                    self.notbetrieb_start()
            return
        try:
            hub = olh_hub()
        except (OSError, ValueError, urllib.error.URLError):
            hub = None
        if hub is None or not hub[1]:
            self.kanaele, self.olh_rgb, self.olh_profil_ok = None, None, False
            if jetzt - self.olh_gesund_am >= OLH_STUMM_NEUSTART_S and jetzt - self.olh_neustart_am >= OLH_NEUSTART_PAUSE_S:
                self.olh_neustart_am = jetzt
                log.warning("OpenLinkHub antwortet nicht — Neustart")
                subprocess.run(["systemctl", "restart", "--no-block", OLH_UNIT], capture_output=True, timeout=10,
                               env=kind_env())
            return
        self.olh_gesund_am = jetzt
        seriennummer, kanaele = hub
        soll = PROFILE[self.profil]["olh"]
        try:
            if any(v.get("profile") != soll for v in kanaele.values()):
                if olh_setzen("speed", seriennummer, soll):
                    log.info("Lüfterkurve %s am Hub gesetzt", self.profil)
            if any(v.get("rgb") != "off" for v in kanaele.values()):
                if olh_setzen("color", seriennummer, "off"):
                    log.info("Hub-LEDs aus")
            hub = olh_hub() or hub
        except (OSError, ValueError, urllib.error.URLError) as e:
            log.warning("OpenLinkHub setzen: %s", type(e).__name__)
        kanaele = hub[1]
        self.kanaele = {k: int(v.get("rpm") or 0) for k, v in kanaele.items() if v.get("description") == "Fan"} or \
            {k: int(v.get("rpm") or 0) for k, v in kanaele.items()}
        self.olh_rgb = [str(v.get("rgb")) for v in kanaele.values()]
        self.olh_profil_ok = all(v.get("profile") == soll for v in kanaele.values())
        if sorted(self.kanaele) != lies_json(KANAELE_DATEI).get("kanaele"):
            schreibe_atomar(KANAELE_DATEI, json.dumps({"kanaele": sorted(self.kanaele)}))

    # Notbetrieb: OpenLinkHub steht → Hub selbst auf 100 %, bis OpenLinkHub wieder startet.
    def notbetrieb_start(self) -> None:
        kanaele = lies_json(KANAELE_DATEI).get("kanaele")
        try:
            fd = os.open(HUB_SPERRE, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o644)
        except OSError as e:
            log.warning("Notbetrieb nicht möglich: %s", type(e).__name__)
            return
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            hub = HubDirekt()
        except OSError as e:
            os.close(fd)
            log.warning("Notbetrieb nicht möglich: %s", type(e).__name__)
            return
        try:
            hub.modus(software=True)
            if not kanaele:
                kanaele = sorted((hub.drehzahlen() or {}).keys())
            self.notbetrieb, self.sperre_fd = hub, fd
            self.notbetrieb_kanaele = [int(k) for k in kanaele if isinstance(k, int) and 0 <= k < 64]
            ok = hub.leistung(self.notbetrieb_kanaele, NOTBETRIEB_PROZENT)
        except OSError as e:
            log.warning("Notbetrieb: Hub antwortet nicht (%s)", type(e).__name__)
            ok = False
            if self.notbetrieb is None:
                hub.schliessen()
                os.close(fd)
                return
        log.warning("OpenLinkHub steht seit %d s — Notbetrieb: Hub selbst auf %d %% (%s)", int(OLH_WEG_NOTBETRIEB_S),
                    NOTBETRIEB_PROZENT, "ok" if ok else "ohne Bestätigung")

    def notbetrieb_takt(self) -> None:
        hub = self.notbetrieb
        if hub is None:
            return
        try:
            hub.modus(software=True)
            hub.leistung(self.notbetrieb_kanaele, NOTBETRIEB_PROZENT)
            self.kanaele = hub.drehzahlen()
        except OSError:
            self.kanaele = None

    def notbetrieb_ende(self) -> None:
        """Hub freigeben — im Software-Modus lassen: die Lüfter halten 100 %, bis OpenLinkHub übernimmt."""
        if self.notbetrieb is None:
            return
        try:
            self.notbetrieb.schliessen()
        except OSError:
            pass
        if self.sperre_fd is not None:
            os.close(self.sperre_fd)  # gibt die Sperre frei — OpenLinkHub wartet in ExecStartPre darauf
        self.notbetrieb, self.sperre_fd = None, None
        log.info("Notbetrieb beendet — OpenLinkHub übernimmt den Hub")

    def status(self) -> None:
        gruende = []
        if self.notbetrieb is not None:
            gruende.append("notbetrieb")
        elif self.kanaele is None:
            gruende.append("hub_antwortet_nicht" if self.olh_zustand == "active" else "hub_dienst_steht")
        if self.roh is None:
            gruende.append("cpu_fuehler_fehlt")
        if self.notbetrieb is not None:
            prozent: int | None = NOTBETRIEB_PROZENT
        elif self.kanaele is not None and getattr(self, "olh_profil_ok", False):
            prozent = soll_luefter(self.profil, self.regel)
        else:
            prozent = None
        block = status_bauen(profil=self.profil, gruende=gruende, kanaele=self.kanaele, prozent=prozent,
                             kraken=self.kraken, leds=leds_zustand(lies_json(BOOT_STAND), self.olh_rgb),
                             orte=orte_laden())
        schreibe_atomar(STATUS, json.dumps(block, separators=(",", ":")))
        kurz = f"Kühlung {block['status']}" + (f"/{block['grund']}" if "grund" in block else "") + f", {self.profil}"
        self._zustand_loggen(kurz, warnung=block["status"] != "ok")

    def lauf(self) -> None:
        signal.signal(signal.SIGTERM, lambda *_: setattr(self, "halt", True))
        signal.signal(signal.SIGINT, lambda *_: setattr(self, "halt", True))
        LAUFZEIT.mkdir(mode=0o755, exist_ok=True)
        ZUSTAND.mkdir(mode=0o755, exist_ok=True)
        log.info("Kühlung gestartet — Profil %s", self.profil)
        self.kraken_lesen()
        self.kraken_neu(initialisieren=False)
        vorher = time.monotonic()
        self.regeln(0.0)
        sd_notify("READY=1")
        while not self.halt:
            jetzt = time.monotonic()
            for was, takt, fn in (("wunsch", WUNSCH_S, self.profil_pruefen), ("olh", STATUS_S, self.olh_pruefen),
                                  ("kraken", STATUS_S, self.kraken_lesen), ("status", STATUS_S, self.status)):
                if self._faellig(was, takt):
                    try:
                        fn()
                    except Exception as e:  # noqa: BLE001 — ein Teil darf den Dienst nie beenden
                        log.warning("%s gescheitert (%s)", was, type(e).__name__)
            if self.notbetrieb is not None:
                if olh_unit_zustand() in ("active", "activating", "reloading"):
                    self.notbetrieb_ende()
                elif self._faellig("notbetrieb", STATUS_S):
                    self.notbetrieb_takt()
            if jetzt - self.kraken_neu_am >= KRAKEN_NEU_S:
                self.kraken_neu(initialisieren=False)
            try:
                self.regeln(jetzt - vorher)
            except OSError as e:
                log.warning("regel_temp schreiben gescheitert (%s)", type(e).__name__)
            vorher = jetzt
            sd_notify("WATCHDOG=1")
            schlaf = TAKT_S - (time.monotonic() - jetzt)
            if schlaf > 0:
                time.sleep(schlaf)
        self.notbetrieb_ende()
        log.info("Kühlung beendet")


# --- Unterbefehle ------------------------------------------------------------------------------------------------------


def olh_profile_schreiben(ordner: Path = OLH_PROFIL_ORDNER) -> None:
    import pwd  # noqa: PLC0415

    nutzer = pwd.getpwnam("openlinkhub")
    ordner.mkdir(parents=True, exist_ok=True)
    for profil, daten in PROFILE.items():
        ziel = ordner / f"{daten['olh']}.json"
        schreibe_atomar(ziel, json.dumps(olh_profil_daten(profil), indent=2))
        os.chown(ziel, nutzer.pw_uid, nutzer.pw_gid)
        print(f"{ziel}")


def hub_lesen(wach: bool) -> int:
    if olh_unit_zustand() in ("active", "activating"):
        print("OpenLinkHub läuft — erst stoppen (sonst stören sich beide am Hub)")
        return 2
    hub = HubDirekt()
    try:
        if wach:
            hub.modus(software=True)
        werte = hub.drehzahlen()
        print("Drehzahlen:", werte if werte is not None else "keine Antwort (Hub im Hardware-Modus? → --wach)")
    finally:
        if wach:
            hub.modus(software=False)
        hub.schliessen()
    return 0


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    logging.getLogger("liquidctl").setLevel(logging.WARNING)  # sonst 40 Zeilen je gesetzter Pumpenkurve
    befehl = argv[0] if argv else ""
    if befehl == "status":
        print(json.dumps(lies_json(STATUS), indent=2, ensure_ascii=False))
        return 0
    if os.geteuid() != 0:
        log.error("braucht root")
        return 1
    if befehl == "boot":
        return boot()
    if befehl == "dienst":
        Dienst().lauf()
        return 0
    if befehl == "notfall":
        return 0 if notfall_verweis() else 1
    if befehl == "profil" and len(argv) == 2 and profil_gueltig(argv[1]):
        profil_merken(argv[1])
        print(f"Profil {argv[1]} gemerkt — der Dienst übernimmt es innert 15 s")
        return 0
    if befehl == "olh-profile":
        olh_profile_schreiben()
        return 0
    if befehl == "hub-lesen":
        return hub_lesen("--wach" in argv)
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
