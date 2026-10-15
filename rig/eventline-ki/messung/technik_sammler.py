#!/usr/bin/env python3
"""EVENTLINE Lokale KI — Technik-Sammler (Technik-Dashboard, docs/technik-dashboard/VERTRAG.md §1.1/§1.3).

Dauerdienst auf dem Rig-Host (eventline-ki-technik.service, als root, nur Python-Standardbibliothek). Misst alle
10 s Prozessor, Grafikkarte, Arbeitsspeicher, Platten-/Netz-Zähler, übernimmt die Kühlung (Lüfter, Pumpe, LEDs) aus
der Status-Datei des Dienstes eventline-kuehlung (rig.kuehlung, nur geprüfte Zahlen und Zustandswörter) und schreibt
den Block «rig» und den Block «nas» des Pakets (§2) atomar nach /srv/eventline-ki/data/dienst/technik/stand.json.
Der KI-Dienst liest die Datei als
/data/technik/stand.json und sendet sie jede Minute ans FSM (dienst/app/technik.py).

Was langsam ist oder hängen kann, läuft in einem eigenen Thread mit harten Zeitlimits, damit der 10-s-Takt nie
stockt: Dienste (docker, 30 s), Platten-Belegung (60 s), SSD-Gesundheit (smartctl, 5 min), RAM-Module (dmidecode,
beim Start und täglich), NAS-Basis (60 s, eigener Unterprozess mit 5 s Zeitlimit — eine hängende CIFS-Einhängung
blockiert nie den Sammler) und NAS-Hardware: über die Mess-Container auf dem NAS (60 s, eigener Unterprozess mit 15 s
Zeitlimit; ruht, solange /etc/eventline-ki/technik-nas.env fehlt, und hat dann Vorrang) oder sonst über SNMP (5 min,
10 s Zeitlimit; ruht, solange /etc/eventline-ki/technik-snmp.env fehlt). Dazu alle 10 min die Leistung der lokalen KI
(§2.6, rig.leistung): Kennzahlen aus der Rig-DB, NUR LESEND (Transaktion read-only, 30 s Zeitlimit) — nur Zähler,
Dauern, Seiten/Zeichen und Selbsttest-Anteile, nie Pfade, Namen oder Texte.

Arbeitsspeicher (Neuregel 15.10.2026): neben verfügbarem RAM und Speicherdruck (PSI) misst der Sammler das aktive
Ein- und Auslagern (/proc/vmstat pswpin/pswpout, Bytes/s, 5-Minuten-Mittel und Minutenreihen). Die Seitenfehler
(pgmajfault) entfallen: sie zählen auch das Lesen von Dateien und taugen nicht als Zeichen für Speichermangel.

Grenzen (§1.1, §7): Trust one wird nur als Summe gelesen (system-trustone.slice: memory.current/high/max, cpu.stat),
docker-Abfragen sind auf das Compose-Projekt eventline-ki gefiltert. Ins Paket und ins Log kommen nur Zahlen und
Zustandswörter — keine Hostnamen, Adressen, Freigabe-Namen, Pfade unter /mnt, Hersteller, Modelle, Seriennummern
und keine Fehlertexte fremder Werkzeuge.

  python3 technik_sammler.py                 Dauerbetrieb (systemd)
  python3 technik_sammler.py --einmal        eine Messung schreiben und beenden (Prüfung von Hand, mit sudo)
"""

from __future__ import annotations

import base64
import ipaddress
import json
import logging
import os
import re
import select
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger("technik")

# --- Pfade und Takte ---------------------------------------------------------------------------------------------

TRESOR = "/srv/eventline-ki/data"
AUSGABE_ORDNER = Path(TRESOR) / "dienst" / "technik"
AUSGABE = AUSGABE_ORDNER / "stand.json"
DIENST_GID = 1500  # Gruppe eventline-ki: der Dienst-Container (uid/gid 1500) liest die Datei

CG = Path("/sys/fs/cgroup")
KI_SLICE = CG / "system.slice" / "system-eventlineki.slice"
TO_SLICE = CG / "system.slice" / "system-trustone.slice"  # nur Summe lesen, nie mehr

KI_ENV = Path("/etc/eventline-ki/env")
SYNC_ENV = Path("/etc/eventline-sync/env")
SNMP_ENV = Path("/etc/eventline-ki/technik-snmp.env")
NAS_LESEND = "/mnt/eventline-nas"
NAS_SCHREIBEND = "/mnt/eventline-nas-rw"
LAUFZEIT_ORDNER = Path(os.environ.get("RUNTIME_DIRECTORY", "/run/eventline-technik").split(":")[0])

TAKT_S = 10.0
DIENSTE_S = 30.0
PLATTEN_S = 60.0
SMART_S = 300.0
DMI_S = 86_400.0
NAS_S = 60.0
NAS_ZEITLIMIT_S = 5.0
SNMP_S = 300.0
SNMP_ZEITLIMIT_S = 10.0
LEISTUNG_S = 600.0  # Leistung der lokalen KI (§2.6) aus der Rig-DB
LEISTUNG_ZEITLIMIT_S = 30.0
FENSTER_S = 600.0  # Messspeicher: 10 Minuten (5- und 10-Minuten-Mittel)

COMPOSE_PROJEKT = "eventline-ki"
# Container → generischer Name im Paket (§1.1). Einweg-Container (ollama-modelle, whisper-modelle) fehlen bewusst.
DIENST_NAMEN = {
    "eventline-ki-dienst": "ki_dienst",
    "eventline-ki-ollama": "ollama_schnell",
    "eventline-ki-ollama-gruendlich": "ollama_gruendlich",
    "eventline-ki-whisper": "whisper",
    "eventline-ki-db": "datenbank",
    "eventline-ki-caddy": "webserver",
    "eventline-ki-egress": "ausgang",
}

GIB = 1024 ** 3
WEB_PORTS = (9443, 9999, 443, 80)  # Weboberfläche des NAS: nur TCP-Verbindungstest, nie eine Anfrage
try:  # Seitengrösse für pswpin/pswpout (Seiten → Bytes); ohne sysconf (nur Tests ausserhalb Linux) 4 KiB
    SEITE_B = int(os.sysconf("SC_PAGE_SIZE"))
except (AttributeError, ValueError, OSError):
    SEITE_B = 4096


# --- Kleine Helfer -----------------------------------------------------------------------------------------------


def jetzt_iso(t: float | None = None) -> str:
    return datetime.fromtimestamp(time.time() if t is None else t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def lies(pfad: str | Path, n: int = 65536) -> str | None:
    try:
        with open(pfad, encoding="utf-8", errors="replace") as f:
            return f.read(n)
    except OSError:
        return None


def lies_int(pfad: str | Path) -> int | None:
    t = lies(pfad, 64)
    if t is None:
        return None
    t = t.strip()
    try:
        return int(t)
    except ValueError:
        return None  # z. B. «max»


def zahl(wert: Any, stellen: int = 1) -> float | int | None:
    if wert is None or isinstance(wert, bool):
        return None
    try:
        f = float(wert)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return int(round(f)) if stellen == 0 else round(f, stellen)


def ganz(wert: Any) -> int | None:
    z = zahl(wert, 0)
    return None if z is None else int(z)


def ganz_pos(wert: Any) -> int | None:
    """Ganze Zahl ≥ 0 aus einer Zahl (kein Text), sonst None."""
    if not isinstance(wert, (int, float)):
        return None
    z = ganz(wert)
    return z if z is not None and z >= 0 else None


def ohne_none(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def mittel(werte: list[float]) -> float | None:
    return sum(werte) / len(werte) if werte else None


def env_datei(pfad: Path) -> dict[str, str]:
    """KEY=wert-Datei lesen (Anführungszeichen ab). Nur der Aufrufer entscheidet, welche Schlüssel er nimmt."""
    werte: dict[str, str] = {}
    text = lies(pfad)
    if not text:
        return werte
    for zeile in text.splitlines():
        zeile = zeile.strip()
        if not zeile or zeile.startswith("#") or "=" not in zeile:
            continue
        k, _, v = zeile.partition("=")
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
            v = v[1:-1]
        werte[k.strip()] = v
    return werte


class Werkzeugsperre:
    """Schutz gegen ein hängendes Werkzeug (z. B. nvidia-smi bei einem Treiberfehler, smartctl bei einer hängenden
    SSD): Ein Prozess im D-Zustand überlebt SIGKILL. Solange so ein Prozess lebt, wird kein neuer gestartet, und nach
    jeder Zeitüberschreitung ruht das Werkzeug WARTE_S Sekunden. Der Wert fehlt dann im Paket («nicht lesbar»)."""

    WARTE_S = 300.0

    def __init__(self, name: str) -> None:
        self.name = name
        self.haengend: list[subprocess.Popen] = []
        self.ruht_bis = 0.0

    def gesperrt(self) -> bool:
        self.haengend = [p for p in self.haengend if p.poll() is None]
        return bool(self.haengend) or time.monotonic() < self.ruht_bis

    def zeitlimit(self, p: subprocess.Popen) -> None:
        if p.poll() is None:
            self.haengend.append(p)
        if time.monotonic() >= self.ruht_bis:
            log.warning("%s antwortet nicht — ruht %d min", self.name, int(self.WARTE_S // 60))
        self.ruht_bis = time.monotonic() + self.WARTE_S


GPU_SPERRE = Werkzeugsperre("Grafikkarten-Abfrage")
SSD_SPERRE = Werkzeugsperre("SSD-Abfrage")


def befehl(args: list[str], zeitlimit: float, env: dict[str, str] | None = None,
           sperre: Werkzeugsperre | None = None) -> tuple[int | None, str, str]:
    """Externes Werkzeug mit hartem Zeitlimit. (Rückgabecode | None bei Zeitüberschreitung/fehlt, stdout, stderr).
    stderr wird nur zur Einordnung benutzt, nie geloggt. Mit `sperre` startet kein neuer Lauf, solange ein alter
    hängt oder das Werkzeug nach einer Zeitüberschreitung ruht."""
    if sperre is not None and sperre.gesperrt():
        return None, "", "gesperrt"
    try:
        p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                             env=env, start_new_session=True)
    except OSError:
        return None, "", "werkzeug_fehlt"
    try:
        aus, err = p.communicate(timeout=zeitlimit)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            p.communicate(timeout=2)
        except (subprocess.TimeoutExpired, OSError):
            pass
        if sperre is not None:
            sperre.zeitlimit(p)
        return None, "", "zeitlimit"
    return p.returncode, aus.decode("utf-8", "replace"), err.decode("utf-8", "replace")


_ESCAPE = re.compile(r"\\([0-7]{3})")


def einhaengungen() -> list[tuple[str, str, str]]:
    """(Mount-Punkt, Dateisystem, Optionen) aus Sicht des Hosts (/proc/1/mountinfo) — liest nur den Kernel, fasst
    nie ein Dateisystem an (eine hängende CIFS-Einhängung kann hier nicht blockieren). Nicht /proc/self: Die
    Unit-Härtung gibt dem Sammler einen eigenen Mount-Namespace, in dem ein auf dem Host ausgehängter Tresor
    weiter eingehängt bliebe (Review 2026-10-12)."""
    ergebnis = []
    text = lies("/proc/1/mountinfo", 1 << 20) or lies("/proc/self/mountinfo", 1 << 20) or ""
    for zeile in text.splitlines():
        teile = zeile.split(" - ", 1)
        if len(teile) != 2:
            continue
        links, rechts = teile[0].split(), teile[1].split()
        if len(links) < 6 or len(rechts) < 3:
            continue
        punkt = _ESCAPE.sub(lambda m: chr(int(m.group(1), 8)), links[4])
        ergebnis.append((punkt, rechts[0], links[5] + "," + rechts[2]))
    return ergebnis


def ist_eingehaengt(pfad: str) -> bool:
    return any(p == pfad for p, _, _ in einhaengungen())


# --- Messspeicher ------------------------------------------------------------------------------------------------


class Speicher:
    """Messungen der letzten 10 Minuten: (Zeit, {schluessel: wert}). Liefert Mittel/Maximum über ein Fenster."""

    def __init__(self) -> None:
        self.punkte: deque[tuple[float, dict[str, float]]] = deque()

    def neu(self, t: float, werte: dict[str, float | None]) -> None:
        self.punkte.append((t, {k: float(v) for k, v in werte.items() if v is not None}))
        while self.punkte and self.punkte[0][0] < t - FENSTER_S:
            self.punkte.popleft()

    def reihe(self, schluessel: str, fenster_s: float, t: float) -> list[float]:
        return [w[schluessel] for ts, w in self.punkte if ts >= t - fenster_s - 0.5 and schluessel in w]

    def mittel(self, schluessel: str, fenster_s: float, t: float) -> float | None:
        return mittel(self.reihe(schluessel, fenster_s, t))

    def maximum(self, schluessel: str, fenster_s: float, t: float) -> float | None:
        r = self.reihe(schluessel, fenster_s, t)
        return max(r) if r else None


# Minutenwerte (§2.3): Schlüssel im Paket ← Messgrösse im Speicher; «.max» = Maximum der Minute.
MINUTE_MITTEL = {
    "cpu.temp": "cpu_temp", "cpu.last": "cpu_last", "cpu.takt_mhz": "cpu_takt",
    "gpu.temp": "gpu_temp", "gpu.last": "gpu_last", "gpu.vram_mib": "gpu_vram", "gpu.watt": "gpu_watt",
    "ram.verfuegbar_gb": "ram_verfuegbar_gb", "ram.ki_gb": "ram_ki_gb", "ram.ki_fest_gb": "ram_ki_fest_gb",
    "ram.trustone_gb": "ram_trustone_gb", "ram.swap_gb": "ram_swap_gb", "ram.psi_full": "ram_psi_full",
    "ram.swap_ein_bps": "ram_swap_ein_bps", "ram.swap_aus_bps": "ram_swap_aus_bps",
    "netz.rx_bps": "netz_rx_bps", "netz.tx_bps": "netz_tx_bps",
    "platte.lesen_bps": "platte_lesen_bps", "platte.schreiben_bps": "platte_schreiben_bps", "ssd.temp": "ssd_temp",
    "kuehlung.kuehlmittel_c": "kuehlmittel_c", "kuehlung.pumpe_rpm": "pumpe_rpm", "kuehlung.luefter_rpm": "luefter_rpm",
}
MINUTE_MAX = {
    "cpu.temp.max": "cpu_temp", "cpu.last.max": "cpu_last", "gpu.temp.max": "gpu_temp", "gpu.last.max": "gpu_last",
    "ram.psi_full.max": "ram_psi_full",
}


# --- Prozessor ---------------------------------------------------------------------------------------------------


def hwmon_geraete() -> list[tuple[str, Path]]:
    """(Treibername, Ordner) je hwmon-Gerät. Der Treibername dient nur der Zuordnung, er verlässt den Sammler nie."""
    geraete = []
    for d in sorted(Path("/sys/class/hwmon").glob("hwmon*")):
        name = (lies(d / "name", 64) or "").strip()
        geraete.append((name, d))
    return geraete


def temp(d: Path, n: int) -> float | None:
    v = lies_int(d / f"temp{n}_input")
    return None if v is None else v / 1000.0


def cpu_temperaturen(geraete: list[tuple[str, Path]]) -> dict[str, Any]:
    paket: float | None = None
    kerne: list[float] = []
    chipsatz: float | None = None
    for name, d in geraete:
        if name == "coretemp" or name == "k10temp":
            for eingang in sorted(d.glob("temp*_input")):
                n = eingang.name[4:-6]
                wert = temp(d, int(n)) if n.isdigit() else None
                if wert is None:
                    continue
                label = (lies(d / f"temp{n}_label", 64) or "").strip().lower()
                if label.startswith("package") or label in ("tctl", "tdie"):
                    paket = wert if paket is None else max(paket, wert)
                elif label.startswith("core") or label.startswith("tccd"):
                    kerne.append(wert)
        elif name.startswith("pch_"):
            chipsatz = temp(d, 1)
    if paket is None and kerne:
        paket = max(kerne)
    return {"paket": paket, "kerne": kerne, "chipsatz": chipsatz}


def luefter(geraete: list[tuple[str, Path]]) -> list[int] | None:
    """Drehzahlen aller fan*_input. Ohne Super-I/O-Treiber gibt es keine — dann None (Seite: «kommt mit Freigabe»)."""
    rpm: list[int] = []
    for _name, d in geraete:
        for eingang in sorted(d.glob("fan*_input")):
            v = lies_int(eingang)
            if v is not None and 0 <= v < 30_000:
                rpm.append(v)
    return rpm[:8] or None


# --- Kühlung (kuehlung/kuehlung.py, eigener Host-Dienst) ----------------------------------------------------------
# Der Dienst eventline-kuehlung schreibt alle 10 s /run/eventline-kuehlung/status.json; hier wird sie nur geprüft und
# auf den Vertrag zugeschnitten (rig.kuehlung). Fehlt sie, obwohl die Kühlung eingerichtet ist (/var/lib/…), oder ist
# sie älter als 60 s, steht der Dienst.

KUEHLUNG_STATUS = Path("/run/eventline-kuehlung/status.json")
KUEHLUNG_EINGERICHTET = Path("/var/lib/eventline-kuehlung")
KUEHLUNG_MAX_ALTER_S = 60.0
KUEHLUNG_PROFILE = ("leise", "ausgewogen", "kuehl")
KUEHLUNG_ORTE = ("radiator", "front", "heck", "boden", "unbekannt")
_KUEHLUNG_GRUND = re.compile(r"^[a-z][a-z0-9_]{0,39}$")


def _zahl_in(wert: Any, lo: float, hi: float, stellen: int) -> float | int | None:
    z = zahl(wert, stellen)
    return z if z is not None and lo <= z <= hi else None


def kuehlung_block(text: str | None, jetzt: float, eingerichtet: bool = True) -> dict[str, Any]:
    """Status-Datei der Kühlung → Block rig.kuehlung (nur Vertragsfelder, alle Zahlen geprüft; was nicht passt, fehlt)."""
    if text is None:
        return {"status": "fehler", "grund": "dienst_steht"} if eingerichtet else {"status": "nicht_eingerichtet"}
    try:
        d = json.loads(text)
    except ValueError:
        d = None
    if not isinstance(d, dict):
        return {"status": "fehler", "grund": "status_kaputt"}
    try:
        gemessen = datetime.strptime(str(d.get("gemessen_am")), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return {"status": "fehler", "grund": "status_kaputt"}
    alter = jetzt - gemessen.timestamp()
    if alter > KUEHLUNG_MAX_ALTER_S or alter < -KUEHLUNG_MAX_ALTER_S:
        return {"status": "fehler", "grund": "dienst_steht"}
    status = d.get("status") if d.get("status") in ("ok", "fehler", "nicht_eingerichtet") else "fehler"
    grund = d.get("grund") if isinstance(d.get("grund"), str) and _KUEHLUNG_GRUND.match(d["grund"]) else None
    luefter_liste = []
    for eintrag in d.get("luefter") if isinstance(d.get("luefter"), list) else []:
        if not isinstance(eintrag, dict) or len(luefter_liste) >= 16:
            continue
        nr = _zahl_in(eintrag.get("nr"), 1, 64, 0)
        if nr is None:
            continue
        luefter_liste.append(ohne_none({
            "nr": nr,
            "ort": eintrag.get("ort") if eintrag.get("ort") in KUEHLUNG_ORTE else "unbekannt",
            "rpm": _zahl_in(eintrag.get("rpm"), 0, 10_000, 0),
            "prozent": _zahl_in(eintrag.get("prozent"), 0, 100, 0),
        }))
    pumpe_rpm = _zahl_in(d.get("pumpe_rpm"), 0, 10_000, 0)
    if status == "ok" and pumpe_rpm is None:  # «ok» ohne Drehzahl hiesse für die Seite «Pumpe steht» — nicht lesbar ≠ steht
        status, grund = "fehler", "pumpe_nicht_lesbar"
    return ohne_none({
        "status": status,
        "grund": grund if status != "ok" else None,
        "profil_aktiv": d.get("profil_aktiv") if d.get("profil_aktiv") in KUEHLUNG_PROFILE else None,
        "luefter": luefter_liste or None,
        "pumpe_rpm": pumpe_rpm,
        "pumpe_prozent": _zahl_in(d.get("pumpe_prozent"), 0, 100, 0),
        "kuehlmittel_c": _zahl_in(d.get("kuehlmittel_c"), 0, 100, 1),
        "leds": d.get("leds") if d.get("leds") in ("aus", "an", "unbekannt") else None,
    })


def kuehlung_luefter_rpm(block: dict[str, Any]) -> list[int]:
    """Für rig.cpu.luefter_rpm: die Radiator-Lüfter, sonst (Ort unbekannt) alle LINK-Lüfter."""
    alle = [l for l in block.get("luefter") or [] if isinstance(l.get("rpm"), int)]
    radiator = [l["rpm"] for l in alle if l.get("ort") == "radiator"]
    return (radiator or [l["rpm"] for l in alle])[:8]


def cpu_zaehler() -> tuple[int, int] | None:
    """(beschäftigt, gesamt) in Jiffies aus /proc/stat."""
    text = lies("/proc/stat", 4096) or ""
    for zeile in text.splitlines():
        if zeile.startswith("cpu "):
            w = [int(x) for x in zeile.split()[1:]]
            leerlauf = w[3] + (w[4] if len(w) > 4 else 0)
            gesamt = sum(w[:8])
            return gesamt - leerlauf, gesamt
    return None


def cpu_aufbau() -> tuple[int | None, int]:
    """(Kerne, Threads) aus /proc/cpuinfo."""
    kerne = set()
    paket = kern = None
    for zeile in (lies("/proc/cpuinfo", 1 << 20) or "").splitlines():
        if zeile.startswith("physical id"):
            paket = zeile.split(":", 1)[1].strip()
        elif zeile.startswith("core id"):
            kern = zeile.split(":", 1)[1].strip()
        elif not zeile.strip() and paket is not None and kern is not None:
            kerne.add((paket, kern))
            paket = kern = None
    if paket is not None and kern is not None:
        kerne.add((paket, kern))
    return (len(kerne) or None), (os.cpu_count() or 0)


def cpu_takt() -> tuple[float | None, float | None]:
    """(Mittel, höchster Kern) in MHz."""
    werte = []
    for f in Path("/sys/devices/system/cpu").glob("cpu[0-9]*/cpufreq/scaling_cur_freq"):
        v = lies_int(f)
        if v:
            werte.append(v / 1000.0)
    if not werte:
        for zeile in (lies("/proc/cpuinfo", 1 << 20) or "").splitlines():
            if zeile.startswith("cpu MHz"):
                try:
                    werte.append(float(zeile.split(":", 1)[1]))
                except ValueError:
                    pass
    return (mittel(werte), max(werte)) if werte else (None, None)


def drossel_zaehler() -> int | None:
    summe, gesehen = 0, set()
    for d in sorted(Path("/sys/devices/system/cpu").glob("cpu[0-9]*")):
        paket = lies_int(d / "topology" / "physical_package_id")
        if paket in gesehen:
            continue
        v = lies_int(d / "thermal_throttle" / "package_throttle_count")
        if v is None:
            continue
        gesehen.add(paket)
        summe += v
    return summe if gesehen else None


def cgroup_cpu_usec(slice_dir: Path) -> int | None:
    for zeile in (lies(slice_dir / "cpu.stat", 4096) or "").splitlines():
        if zeile.startswith("usage_usec "):
            try:
                return int(zeile.split()[1])
            except (IndexError, ValueError):
                return None
    return None


# --- Grafikkarte -------------------------------------------------------------------------------------------------

GPU_FELDER = ("temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,power.limit,fan.speed,"
              "pstate,driver_version,clocks.gr,clocks.max.gr")


def gpu_messen() -> dict[str, Any] | None:
    # Nie «name» abfragen: der Kartenname gehört nicht ins Paket (§1.1, §7).
    rc, aus, _ = befehl(["nvidia-smi", f"--query-gpu={GPU_FELDER}", "--format=csv,noheader,nounits"], 5.0,
                        sperre=GPU_SPERRE)
    if rc != 0 or not aus.strip():
        return None
    teile = [t.strip() for t in aus.strip().splitlines()[0].split(",")]
    if len(teile) < 11:
        return None

    def f(i: int) -> float | None:
        try:
            return float(teile[i])
        except ValueError:  # «[N/A]», «[Not Supported]»
            return None

    pstate = teile[7] if re.fullmatch(r"P\d{1,2}", teile[7]) else None
    treiber = teile[8] if re.fullmatch(r"[0-9][0-9A-Za-z.+-]{0,39}", teile[8]) else None
    return {
        "temp_c": f(0), "last_prozent": f(1), "vram_belegt_mib": f(2), "vram_gesamt_mib": f(3),
        "watt": f(4), "watt_grenze": f(5), "luefter_prozent": f(6), "pstate": pstate, "treiber": treiber,
        "takt_mhz": f(9), "takt_max_mhz": f(10),
    }


# --- Arbeitsspeicher ---------------------------------------------------------------------------------------------


def meminfo() -> dict[str, int]:
    werte = {}
    for zeile in (lies("/proc/meminfo", 8192) or "").splitlines():
        k, _, rest = zeile.partition(":")
        teile = rest.split()
        if teile and teile[0].isdigit():
            werte[k] = int(teile[0]) * (1024 if len(teile) > 1 and teile[1] == "kB" else 1)
    return werte


def psi_speicher() -> dict[str, float]:
    werte = {}
    for zeile in (lies("/proc/pressure/memory", 1024) or "").splitlines():
        teile = zeile.split()
        if not teile:
            continue
        for t in teile[1:]:
            if t.startswith("avg10="):
                try:
                    werte[teile[0]] = float(t[6:])
                except ValueError:
                    pass
    return werte


VMSTAT_SWAP = ("pswpin", "pswpout")  # Seiten, seit dem Start aus der Auslagerung geholt / dorthin geschrieben


def vmstat_werte(namen: tuple[str, ...], text: str | None = None) -> dict[str, int]:
    """Zähler aus /proc/vmstat (ein Lesen für alle Namen); fehlende oder kaputte Zeilen fehlen im Ergebnis."""
    gesucht = set(namen)
    werte: dict[str, int] = {}
    quelle = lies("/proc/vmstat", 1 << 16) if text is None else text
    for zeile in (quelle or "").splitlines():
        teile = zeile.split()
        if len(teile) == 2 and teile[0] in gesucht and teile[1].isdigit():
            werte[teile[0]] = int(teile[1])
    return werte


def memory_stat(slice_dir: Path) -> dict[str, int]:
    werte = {}
    for zeile in (lies(slice_dir / "memory.stat", 1 << 16) or "").splitlines():
        teile = zeile.split()
        if len(teile) == 2 and teile[1].isdigit():
            werte[teile[0]] = int(teile[1])
    return werte


def ki_slice_speicher() -> dict[str, Any] | None:
    if not KI_SLICE.is_dir():
        return None
    stat = memory_stat(KI_SLICE)
    return ohne_none({
        "belegt_b": lies_int(KI_SLICE / "memory.current"),
        "fest_b": stat.get("anon"),
        "cache_b": stat.get("file"),
        "grenze_b": lies_int(KI_SLICE / "memory.max"),
        "swap_b": lies_int(KI_SLICE / "memory.swap.current"),
    })


def trustone_summe() -> dict[str, Any] | None:
    """Trust one: ausschliesslich die Summe der Slice (memory.current/high/max). Sonst liest nur die Belegung (§2.7)
    den festen Speicher der Slice (memory.stat, Zeile anon) — nie Container, Prozesse oder Logs von Trust one."""
    if not TO_SLICE.is_dir():
        return None
    return ohne_none({
        "summe_b": lies_int(TO_SLICE / "memory.current"),
        "grenze_hoch_b": lies_int(TO_SLICE / "memory.high"),
        "grenze_max_b": lies_int(TO_SLICE / "memory.max"),
    }) or None


_GROESSE = re.compile(r"^\s*Size:\s*(\d+)\s*(GB|MB|TB)\b", re.I)


def ram_module() -> list[dict[str, Any]] | None:
    """Steckplatz-Nummer (1…n in der Reihenfolge der Firmware) und Grösse in GB — nie Hersteller, Teile- oder
    Seriennummer (dmidecode liefert sie, sie werden hier nicht einmal gelesen)."""
    rc, aus, _ = befehl(["dmidecode", "-t", "17"], 10.0)
    if rc != 0 or "Memory Device" not in aus:
        return None
    module = []
    platz = 0
    for block in aus.split("Memory Device")[1:]:
        platz += 1
        for zeile in block.splitlines():
            m = _GROESSE.match(zeile)
            if m:
                n = int(m.group(1))
                gb = n / 1024 if m.group(2).upper() == "MB" else n * 1024 if m.group(2).upper() == "TB" else n
                if gb > 0:
                    module.append({"platz": platz, "groesse_gb": zahl(gb, 1)})
                break
    return module[:8] or None


def modul_temperaturen(geraete: list[tuple[str, Path]]) -> dict[int, float]:
    """jc42-Fühler auf den Riegeln: i2c-Adresse 0x18+n gehört zum SPD 0x50+n, also zum n-ten Steckplatz der Firmware
    (auf dem Rig geprüft: Fühler auf 0x18 und 0x1a = Plätze 1 und 3, die beiden Riegel mit Kühlblech)."""
    temps: dict[int, float] = {}
    for name, d in geraete:
        if name != "jc42":
            continue
        try:
            adresse = int(os.path.basename(os.path.realpath(d / "device")).rsplit("-", 1)[1], 16)
        except (IndexError, ValueError):
            continue
        wert = temp(d, 1)
        if wert is not None and 0x18 <= adresse <= 0x1F:
            temps[adresse - 0x18 + 1] = wert
    return temps


# --- Platten und Netz --------------------------------------------------------------------------------------------


def belegung(pfad: str) -> dict[str, int] | None:
    try:
        s = os.statvfs(pfad)
    except OSError:
        return None
    gesamt = s.f_blocks * s.f_frsize
    return {"gesamt_b": gesamt, "belegt_b": (s.f_blocks - s.f_bfree) * s.f_frsize} if gesamt > 0 else None


def system_platte() -> str | None:
    """Name der Platte unter «/» (sda, nvme0n1): Partition → Platte, device-mapper → darunterliegende Geräte."""
    try:
        dev = os.stat("/").st_dev
    except OSError:
        return None
    pfad = Path(os.path.realpath(f"/sys/dev/block/{os.major(dev)}:{os.minor(dev)}"))
    for _ in range(8):
        if (pfad / "partition").exists():
            pfad = pfad.parent
            continue
        unter = sorted((pfad / "slaves").glob("*")) if (pfad / "slaves").is_dir() else []
        if unter:
            pfad = Path(os.path.realpath(unter[0]))
            continue
        break
    name = pfad.name
    return name if name and (Path("/sys/block") / name).exists() else None


def platten_zaehler(platte: str | None) -> tuple[int, int] | None:
    """(gelesen_b, geschrieben_b) seit dem Start aus /proc/diskstats (Sektoren à 512 B)."""
    if not platte:
        return None
    for zeile in (lies("/proc/diskstats", 1 << 16) or "").splitlines():
        t = zeile.split()
        if len(t) > 9 and t[2] == platte:
            return int(t[5]) * 512, int(t[9]) * 512
    return None


def netz_zaehler() -> dict[str, int]:
    """Summen in Bytes seit dem Start: physische Schnittstellen (netz) und WireGuard (vpn). Namen verlassen den
    Sammler nicht."""
    summe = {"netz_rx_b": 0, "netz_tx_b": 0, "vpn_rx_b": 0, "vpn_tx_b": 0}
    gefunden = {"netz": False, "vpn": False}
    for zeile in (lies("/proc/net/dev", 1 << 16) or "").splitlines()[2:]:
        name, _, rest = zeile.partition(":")
        name = name.strip()
        t = rest.split()
        if len(t) < 9:
            continue
        if name.startswith("wg"):
            art = "vpn"
        elif name != "lo" and Path(f"/sys/class/net/{name}/device").exists():
            art = "netz"
        else:
            continue
        gefunden[art] = True
        summe[f"{art}_rx_b"] += int(t[0])
        summe[f"{art}_tx_b"] += int(t[8])
    return {k: v for k, v in summe.items() if gefunden[k.split("_")[0]]}


# --- SSD (smartctl) ----------------------------------------------------------------------------------------------

# Normierte Restlebensdauer (100 = neu) — die SSD-Hersteller nutzen verschiedene Attribute dafür.
VERSCHLEISS_ATTRIBUTE = (177, 231, 233, 202, 169)
WARN_ATTRIBUTE = (5, 187, 197, 198)  # umgelagerte / ausstehende / nicht korrigierbare Sektoren


def ssd_messen(platte: str | None) -> dict[str, Any]:
    if not platte:
        return {"status": "nicht_verfuegbar"}
    rc, aus, _ = befehl(["smartctl", "-H", "-A", "--json=c", f"/dev/{platte}"], 30.0, sperre=SSD_SPERRE)
    if rc is None:
        return {"status": "nicht_verfuegbar"}
    try:
        d = json.loads(aus)
    except ValueError:
        return {"status": "nicht_verfuegbar"}
    if not isinstance(d, dict) or rc & 0b11:  # Bit 0/1: Aufruf oder Gerät gescheitert
        return {"status": "nicht_verfuegbar"}
    gesundheit: str | None = None
    passed = (d.get("smart_status") or {}).get("passed")
    if passed is True:
        gesundheit = "ok"
    elif passed is False:
        gesundheit = "fehler"
    abnutzung: float | None = None
    nvme = d.get("nvme_smart_health_information_log") or {}
    if isinstance(nvme.get("percentage_used"), (int, float)):
        abnutzung = float(nvme["percentage_used"])
    tabelle = ((d.get("ata_smart_attributes") or {}).get("table")) or []
    for a in tabelle if isinstance(tabelle, list) else []:
        if not isinstance(a, dict):
            continue
        nr, wert = a.get("id"), a.get("value")
        if abnutzung is None and nr in VERSCHLEISS_ATTRIBUTE and isinstance(wert, int) and 0 <= wert <= 100:
            abnutzung = 100.0 - wert
        roh = (a.get("raw") or {}).get("value")
        if gesundheit == "ok" and nr in WARN_ATTRIBUTE and isinstance(roh, int) and roh > 0:
            gesundheit = "warnung"
        if gesundheit == "ok" and str(a.get("when_failed") or "") in ("past", "now"):
            gesundheit = "warnung"
    if nvme and gesundheit == "ok" and nvme.get("critical_warning"):
        gesundheit = "warnung"
    temp_c = (d.get("temperature") or {}).get("current")
    stunden = (d.get("power_on_time") or {}).get("hours")
    return {
        "status": "ok",
        "temp_c": zahl(temp_c, 0) if isinstance(temp_c, (int, float)) and -20 < temp_c < 150 else None,
        "gesundheit": gesundheit,
        "abnutzung_prozent": zahl(max(0.0, min(100.0, abnutzung)), 0) if abnutzung is not None else None,
        "betriebsstunden": int(stunden) if isinstance(stunden, int) and stunden >= 0 else None,
    }


# --- Dienste (docker, nur Projekt eventline-ki) --------------------------------------------------------------------


def _zeit_iso(text: Any) -> str | None:
    if not isinstance(text, str) or text.startswith("0001-"):
        return None
    m = re.match(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$", text)
    if not m:
        return None
    try:
        t = datetime.fromisoformat(m.group(1) + ("+00:00" if m.group(2) == "Z" else m.group(2)))
    except ValueError:
        return None
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def container_cgroup(pid: int) -> Path | None:
    if not pid:
        return None
    for zeile in (lies(f"/proc/{pid}/cgroup", 4096) or "").splitlines():
        if zeile.startswith("0::"):
            pfad = zeile[3:].strip()
            return None if ".." in pfad else CG / pfad.lstrip("/")
    return None


def oom_kills(cgroup: Path | None) -> int | None:
    for zeile in (lies(cgroup / "memory.events", 4096) or "").splitlines() if cgroup else []:
        if zeile.startswith("oom_kill "):
            try:
                return int(zeile.split()[1])
            except (IndexError, ValueError):
                return None
    return None


OOM_FENSTER_S = 900.0


class OomMerker:
    """«oom» im Paket = in den letzten 15 min hat der Kernel im Container einen Prozess wegen Speichermangel beendet
    (Zähler oom_kill der Container-Cgroup gestiegen), oder der Container ist daran gestorben. Dockers OOMKilled bleibt
    bis zum nächsten Neustart des Containers stehen — ein Ereignis von gestern wäre sonst dauerhaft «kritisch»."""

    def __init__(self) -> None:
        self.stand: dict[str, tuple[int, float]] = {}

    def neu(self, cid: str, zaehler: int | None, jetzt: float) -> bool:
        if zaehler is None:
            return False
        alt = self.stand.get(cid)
        gestiegen_am = alt[1] if alt else 0.0
        if alt is not None and zaehler > alt[0]:
            gestiegen_am = jetzt
        self.stand[cid] = (zaehler, gestiegen_am)
        return gestiegen_am > 0 and jetzt - gestiegen_am < OOM_FENSTER_S


def dienste_messen(oom: OomMerker | None = None, kennungen: dict[str, str] | None = None,
                   ollama: dict[str, dict[str, str]] | None = None) -> list[dict[str, Any]] | None:
    """Zustand der KI-Container (nur Label eventline-ki). `kennungen` bekommt je generischem Namen die Container-ID
    laufender Container — nur für den Sammler selbst (Leistung liest die Rig-DB im Container «datenbank»), nie ins
    Paket. `ollama` bekommt je Instanz (schnell/gruendlich) Container-ID und Adresse im internen Netz — für die
    Abfrage /api/ps und die Prozesse der Modelle (geladene Modelle), ebenfalls nie ins Paket."""
    rc, aus, _ = befehl(["docker", "ps", "-aq", "--no-trunc", "--filter",
                         f"label=com.docker.compose.project={COMPOSE_PROJEKT}"], 10.0)
    if rc != 0:
        return None
    ids = [i for i in aus.split() if re.fullmatch(r"[0-9a-f]{12,64}", i)]
    if not ids:
        return []
    rc, aus, _ = befehl(["docker", "inspect", *ids], 10.0)
    if rc != 0:
        return None
    try:
        liste = json.loads(aus)
    except ValueError:
        return None
    dienste: dict[str, dict[str, Any]] = {}
    for c in liste if isinstance(liste, list) else []:
        if not isinstance(c, dict):
            continue
        # Doppelte Absicherung: auch ein falsch gefilterter Container fremder Projekte kommt nie ins Paket.
        if ((c.get("Config") or {}).get("Labels") or {}).get("com.docker.compose.project") != COMPOSE_PROJEKT:
            continue
        name = DIENST_NAMEN.get(str(c.get("Name") or "").lstrip("/"))
        if not name:
            continue
        st = c.get("State") or {}
        status = st.get("Status")
        cid = str(c.get("Id") or "")
        if kennungen is not None and status == "running" and re.fullmatch(r"[0-9a-f]{12,64}", cid):
            kennungen[name] = cid
        if ollama is not None and status == "running" and name in OLLAMA_DIENSTE and re.fullmatch(r"[0-9a-f]{64}", cid):
            netze = (c.get("NetworkSettings") or {}).get("Networks") or {}
            ip = next((str(n.get("IPAddress")) for n in netze.values() if isinstance(n, dict) and n.get("IPAddress")), "")
            ollama[OLLAMA_DIENSTE[name]] = {"cid": cid, "ip": ip if interne_adresse(ip) else ""}
        health = (st.get("Health") or {}).get("Status")
        if status == "running":
            zustand = "startet" if health == "starting" else "laeuft"
        elif status == "restarting":
            zustand = "neustart"
        else:
            zustand = "gestoppt"
        grenze = (c.get("HostConfig") or {}).get("Memory")
        cgroup = container_cgroup(int(st.get("Pid") or 0)) if status == "running" else None
        if status == "running":
            oom_jetzt = oom.neu(str(c.get("Id")), oom_kills(cgroup), time.time()) if oom is not None else False
        else:
            oom_jetzt = bool(st.get("OOMKilled"))  # am Speichermangel gestorben und nicht wieder gestartet
        dienste[name] = ohne_none({
            "name": name,
            "zustand": zustand,
            "gesund": True if health == "healthy" else False if health == "unhealthy" else None,
            "gestartet_am": _zeit_iso(st.get("StartedAt")) if status in ("running", "restarting") else None,
            "neustarts": ganz(c.get("RestartCount")),
            "oom": oom_jetzt,
            "speicher_b": lies_int(cgroup / "memory.current") if cgroup else None,
            "grenze_b": int(grenze) if isinstance(grenze, int) and grenze > 0 else None,
        })
        dienste[name].setdefault("gesund", None)
    reihenfolge = list(DIENST_NAMEN.values())
    return sorted(dienste.values(), key=lambda d: reihenfolge.index(d["name"]))


# --- Geladene KI-Modelle (beide Ollama-Instanzen, Nachtrag 15.10.2026) ---------------------------------------------
# Mischa: «Warum sehe ich das grosse Modell nicht, wenn es aktiv ist?» und «es soll auch RAM abfragen». Der Dienst kennt
# nur seine eigenen Aufträge — ein Modell kann aber auch ausserhalb rechnen (Messung, Test, Hauptmodell). Darum misst der
# Sammler je geladenem Modell selbst: Ollama /api/ps beider Instanzen (Name, Grösse, davon im Grafikspeicher, Kontext,
# entlädt um) und den llama-server-Prozess dazu (Rechenlast = CPU im 10-s-Mittel, Arbeitsspeicher RSS und anonym —
# anonym enthält den Prompt-Cache, das war das 8,8-GiB-Problem). Gelesen werden nur die Prozesse in den zwei
# Ollama-Containern (cgroup.procs der Container) — nie andere Prozesse, nie Trust one. Ins Paket: nur Modellnamen
# (Weissliste wie im Dienst) und Zahlen.

OLLAMA_DIENSTE = {"ollama_schnell": "schnell", "ollama_gruendlich": "gruendlich"}
OLLAMA_PORT = 11434
KI_PS_S = 10.0
KI_PS_ZEITLIMIT_S = 3.0
MODELLE_ORDNER = Path(TRESOR) / "ollama" / "models"  # Manifeste und Blobs, gemeinsam für beide Instanzen
MANIFEST_NEU_S = 300.0  # Zuordnung Blob → Modellname höchstens so oft neu einlesen (und wenn ein Blob unbekannt ist)
RECHNET_AB_PROZENT = 25.0  # CPU eines llama-server im 10-s-Mittel (100 = ein Kern): Leerlauf ~0–2 %, GPU-Rechnen ~100 %
KI_MODELLE_MAX = 6
MODELL_NAME = re.compile(r"^[a-z0-9][a-z0-9._:/-]{0,79}$", re.I)  # = MODELLNAME im Dienst und MODELL_RE im FSM
TICKS_S = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100
_OHNE_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def interne_adresse(ip: str) -> bool:
    """Nur private IPv4/IPv6 (internes Docker-Netz) — nie eine Adresse von aussen."""
    try:
        return ipaddress.ip_address(ip).is_private
    except ValueError:
        return False


def ollama_ps(ip: str) -> list[dict[str, Any]] | None:
    """GET /api/ps einer Instanz (lädt nie ein Modell). None = nicht erreichbar/unlesbar."""
    if not interne_adresse(ip):
        return None
    adresse = f"[{ip}]" if ":" in ip else ip
    try:
        with _OHNE_PROXY.open(f"http://{adresse}:{OLLAMA_PORT}/api/ps", timeout=KI_PS_ZEITLIMIT_S) as r:
            daten = json.loads(r.read(1 << 20))
    except (OSError, ValueError, urllib.error.URLError):
        return None
    modelle = daten.get("models") if isinstance(daten, dict) else None
    return [m for m in modelle if isinstance(m, dict)] if isinstance(modelle, list) else None


def ps_auswerten(modelle: list[dict[str, Any]], jetzt: float) -> list[dict[str, Any]]:
    """Antwort von /api/ps → geprüfte Einträge: Name (Weissliste), Grösse, davon im Grafikspeicher, Kontext, entlädt um
    (nur ein Zeitpunkt innerhalb von 2 Tagen — keep_alive -1 ergibt ein Datum Jahrhunderte voraus)."""
    aus = []
    for m in modelle:
        name = m.get("name") if isinstance(m.get("name"), str) else None
        if not name or not MODELL_NAME.match(name):
            continue
        e: dict[str, Any] = {"name": name, "groesse_b": ganz_pos(m.get("size")), "vram_b": ganz_pos(m.get("size_vram")),
                             "kontext": ganz_pos(m.get("context_length"))}
        ende = _zeit_iso(m.get("expires_at"))
        if ende:
            t_ende = datetime.fromisoformat(ende.replace("Z", "+00:00")).timestamp()
            if jetzt <= t_ende <= jetzt + 2 * 86_400:
                e["entlaedt_am"] = ende
        aus.append(ohne_none(e))
    return aus


def manifest_name(teile: tuple[str, ...]) -> str | None:
    """Pfad unter manifests/ (Registry, Namensraum, Modell, Tag) → Name wie Ollama ihn zeigt («gemma3:4b»)."""
    if len(teile) != 4:
        return None
    registry, raum, modell, tag = teile
    name = f"{modell}:{tag}" if raum == "library" else f"{raum}/{modell}:{tag}"
    if registry != "registry.ollama.ai":
        name = f"{registry}/{raum}/{modell}:{tag}"
    return name if MODELL_NAME.match(name) else None


def blob_namen(ordner: Path = MODELLE_ORDNER) -> dict[str, list[str]]:
    """Blob (sha256 der GGUF-Schicht «model») → Modellnamen aus den Manifesten (ein Blob kann mehrere Namen tragen)."""
    karte: dict[str, list[str]] = {}
    basis = ordner / "manifests"
    try:
        dateien = [p for p in basis.rglob("*") if p.is_file()]
    except OSError:
        return karte
    for datei in sorted(dateien)[:500]:
        name = manifest_name(datei.relative_to(basis).parts)
        if not name:
            continue
        try:
            daten = json.loads(lies(datei, 1 << 16) or "")
        except ValueError:
            continue
        for schicht in daten.get("layers") or [] if isinstance(daten, dict) else []:
            if isinstance(schicht, dict) and str(schicht.get("mediaType", "")).endswith(".model"):
                m = re.fullmatch(r"sha256:([0-9a-f]{64})", str(schicht.get("digest", "")))
                if m:
                    karte.setdefault(m.group(1), []).append(name)
    return karte


def llama_prozesse(cgroup: Path, proc: Path = Path("/proc")) -> list[dict[str, Any]]:
    """llama-server-Prozesse in einem Ollama-Container: Blob des Modells, Kontext, Einbettung ja/nein, CPU-Zeit (Ticks),
    Startzeit (eindeutig mit der PID), RSS und anonymer Speicher. Nur PIDs aus cgroup.procs dieses Containers."""
    aus = []
    for zeile in (lies(cgroup / "cgroup.procs", 1 << 16) or "").split():
        if not zeile.isdigit():
            continue
        p = proc / zeile
        if (lies(p / "comm", 64) or "").strip() != "llama-server":
            continue
        argv = (lies(p / "cmdline", 1 << 15) or "").split("\0")
        stat = lies(p / "stat", 4096) or ""
        felder = stat[stat.rfind(")") + 2:].split() if ")" in stat else []
        if len(felder) < 20:
            continue
        status = {z.split(":")[0]: z.split()[1] for z in (lies(p / "status", 1 << 14) or "").splitlines()
                  if z.startswith(("VmRSS:", "RssAnon:")) and len(z.split()) >= 2}
        blob = kontext = None
        for i, a in enumerate(argv[:-1]):
            if a == "--model":
                m = re.search(r"sha256-([0-9a-f]{64})$", argv[i + 1])
                blob = m.group(1) if m else None
            elif a in ("-c", "--ctx-size") and argv[i + 1].isdigit():
                kontext = int(argv[i + 1])
        aus.append({
            "pid": int(zeile), "start": felder[19], "ticks": int(felder[11]) + int(felder[12]),
            "blob": blob, "kontext": kontext, "einbettung": "--embedding" in argv,
            "rss_b": int(status["VmRSS"]) * 1024 if status.get("VmRSS", "").isdigit() else None,
            "ram_b": int(status["RssAnon"]) * 1024 if status.get("RssAnon", "").isdigit() else None,
        })
    return aus


def ki_modelle_bauen(prozesse: dict[str, list[dict[str, Any]]], ps: dict[str, list[dict[str, Any]] | None],
                     namen: dict[str, list[str]], cpu: dict[tuple[int, str], float]) -> list[dict[str, Any]]:
    """Je Instanz Prozesse und /api/ps zusammenführen. Ein Prozess ohne /api/ps-Eintrag lädt gerade («laedt»), ein
    Eintrag ohne Prozess ist geladen, aber ohne Messung. `cpu` = CPU-Prozent je (PID, Start) aus der letzten Messung."""
    aus: list[dict[str, Any]] = []
    for inst in ("schnell", "gruendlich"):
        eintraege = list(ps.get(inst) or [])
        for p in prozesse.get(inst) or []:
            kandidaten = namen.get(p["blob"] or "", [])
            treffer = next((e for e in eintraege if e["name"] in kandidaten), None)
            if treffer is not None:
                eintraege.remove(treffer)
            prozent = cpu.get((p["pid"], p["start"]))
            name = treffer["name"] if treffer else (sorted(kandidaten)[0] if kandidaten else None)
            aus.append(ohne_none({
                **(treffer or {}),
                "instanz": inst,
                "name": name,
                "rolle": "einbettung" if p["einbettung"] else "sprache",
                "kontext": (treffer or {}).get("kontext") or p["kontext"],
                "zustand": "geladen" if treffer is not None or ps.get(inst) is None else "laedt",
                "cpu_prozent": round(prozent, 1) if prozent is not None else None,
                "rechnet": (prozent >= RECHNET_AB_PROZENT) if prozent is not None else None,
                "rss_b": p["rss_b"], "ram_b": p["ram_b"],
            }))
        for e in eintraege:  # geladen laut Ollama, Prozess (noch) nicht gefunden
            aus.append({**e, "instanz": inst, "zustand": "geladen"})
    return aus[:KI_MODELLE_MAX]


def ram_belegung(mi: dict[str, int], ki: dict[str, Any] | None, to_anon: int | None,
                 modelle: list[dict[str, Any]]) -> dict[str, int] | None:
    """Wer belegt den Arbeitsspeicher (nicht rückgewinnbar, anonym): KI-Modelle (Summe der llama-server), übriger
    KI-Bereich, Trust one (nur Summe), System und übrige Programme (Rest bis «nicht verfügbar»), verfügbar."""
    gesamt, verfuegbar = mi.get("MemTotal"), mi.get("MemAvailable")
    ki_anon = (ki or {}).get("fest_b")
    if gesamt is None or verfuegbar is None or ki_anon is None or to_anon is None:
        return None
    modelle_b = sum(m.get("ram_b") or 0 for m in modelle)
    belegt = max(0, gesamt - verfuegbar)
    return {
        "ki_modelle_b": min(modelle_b, ki_anon),
        "ki_rest_b": max(0, ki_anon - modelle_b),
        "trustone_b": to_anon,
        "system_b": max(0, belegt - ki_anon - to_anon),
        "verfuegbar_b": verfuegbar,
    }


# --- NAS -----------------------------------------------------------------------------------------------------------


def nas_konfiguration() -> dict[str, Any]:
    """Adresse und Soll der Freigaben aus der Einhänge-Konfiguration (eventline-ki-nas-mount liest NAS_HOST/
    NAS_SHARES aus /etc/eventline-ki/env, eventline-sync-nas-mount aus /etc/eventline-sync/env). Nur diese beiden
    Schlüssel werden genommen; die Adresse bleibt im Sammler."""
    ki, sync = env_datei(KI_ENV), env_datei(SYNC_ENV)
    host = (ki.get("NAS_HOST") or sync.get("NAS_HOST") or "").strip()

    def namen(werte: dict[str, str]) -> set[str] | None:
        if "NAS_SHARES" not in werte:
            return None
        return {s.strip() for s in werte["NAS_SHARES"].split(",") if s.strip()}

    return {"host": host or None, "lesend": namen(ki), "schreibend": namen(sync)}


def freigaben_ist(konf: dict[str, Any]) -> dict[str, Any]:
    eingehaengt: dict[str, set[str]] = {NAS_LESEND: set(), NAS_SCHREIBEND: set()}
    for punkt, fs, _opt in einhaengungen():
        if fs not in ("cifs", "smb3"):
            continue
        basis, _, name = punkt.rpartition("/")
        if basis in eingehaengt and name:
            eingehaengt[basis].add(name)
    lesend = eingehaengt[NAS_LESEND] & konf["lesend"] if konf["lesend"] is not None else eingehaengt[NAS_LESEND]
    schreibend = (eingehaengt[NAS_SCHREIBEND] & konf["schreibend"] if konf["schreibend"] is not None
                  else eingehaengt[NAS_SCHREIBEND])
    soll = None
    if konf["lesend"] is not None or konf["schreibend"] is not None:
        soll = len(konf["lesend"] or ()) + len(konf["schreibend"] or ())
    pfad = None
    for basis, namen in ((NAS_LESEND, lesend), (NAS_SCHREIBEND, schreibend)):
        if namen:
            pfad = f"{basis}/{sorted(namen)[0]}"
            break
    return {"soll": soll, "ist": len(lesend) + len(schreibend), "schreibend": len(schreibend),
            "lesend": len(lesend), "pfad": pfad}


def nas_probe_kind() -> int:
    """Unterprozess (--nas-probe): liest {host, pfad} von stdin, schreibt je Ergebnis eine JSON-Zeile. Erst die
    TCP-Tests (kurze Zeitlimits), dann statvfs — hängt die CIFS-Einhängung, hat der Elternprozess die TCP-Zeile
    schon und beendet dieses Kind nach dem Zeitlimit."""
    try:
        auftrag = json.loads(sys.stdin.readline() or "{}")
    except ValueError:
        auftrag = {}
    host, pfad = auftrag.get("host"), auftrag.get("pfad")

    def offen(port: int) -> bool:
        try:
            with socket.create_connection((host, port), timeout=1.5):
                return True
        except OSError:
            return False

    smb = bool(host) and offen(445)
    web = bool(host) and any(offen(p) for p in WEB_PORTS)
    print(json.dumps({"dateifreigabe": smb, "weboberflaeche": web}), flush=True)
    if pfad:
        try:
            s = os.statvfs(pfad)
            print(json.dumps({"gesamt_b": s.f_blocks * s.f_frsize,
                              "belegt_b": (s.f_blocks - s.f_bfree) * s.f_frsize}), flush=True)
        except OSError:
            print(json.dumps({"volume": None}), flush=True)
    return 0


class Kindprozess:
    """Startet dieses Skript als Kind (`modus`, z. B. --nas-probe), gibt ihm den Auftrag als eine JSON-Zeile über
    stdin (Zugangsdaten so nie auf der Kommandozeile), wartet höchstens `zeitlimit` Sekunden und liest die
    JSON-Zeilen, die bis dahin da sind. Ein hängendes Kind (CIFS im D-Zustand) wird getötet und später eingesammelt;
    solange es lebt, startet kein zweites (dann None)."""

    def __init__(self, modus: str, zeitlimit: float) -> None:
        self.modus = modus
        self.zeitlimit = zeitlimit
        self.haengend: list[subprocess.Popen[bytes]] = []

    def aufraeumen(self) -> None:
        self.haengend = [p for p in self.haengend if p.poll() is None]

    def zeilen(self, auftrag: dict[str, Any]) -> list[dict[str, Any]] | None:
        self.aufraeumen()
        if self.haengend:
            return None
        try:
            p = subprocess.Popen([sys.executable, os.path.abspath(__file__), self.modus], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        except OSError:
            return None
        assert p.stdin is not None and p.stdout is not None
        try:
            p.stdin.write((json.dumps(auftrag) + "\n").encode())
            p.stdin.close()
        except OSError:
            pass
        os.set_blocking(p.stdout.fileno(), False)
        puffer = b""
        ende = time.monotonic() + self.zeitlimit
        while True:
            rest = ende - time.monotonic()
            if rest <= 0:
                break
            bereit, _, _ = select.select([p.stdout], [], [], min(rest, 0.25))
            if bereit:
                try:
                    teil = p.stdout.read()
                except OSError:
                    teil = None
                if teil:
                    puffer += teil
                elif teil == b"":
                    break  # EOF: Kind fertig
            elif p.poll() is not None:
                break
        if p.poll() is None:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except OSError:
                pass
            self.haengend.append(p)
        else:
            p.wait()
        try:
            p.stdout.close()
        except OSError:
            pass
        zeilen: list[dict[str, Any]] = []
        for zeile in puffer.decode("utf-8", "replace").splitlines():
            try:
                teil = json.loads(zeile)
            except ValueError:
                continue
            if isinstance(teil, dict):
                zeilen.append(teil)
        return zeilen


class NasProbe(Kindprozess):
    """NAS-Basis im Kind (--nas-probe), höchstens NAS_ZEITLIMIT_S."""

    def __init__(self) -> None:
        super().__init__("--nas-probe", NAS_ZEITLIMIT_S)

    def messen(self, host: str | None, pfad: str | None) -> dict[str, Any] | None:
        zeilen = self.zeilen({"host": host, "pfad": pfad})
        if zeilen is None:
            return None
        ergebnis: dict[str, Any] = {}
        for teil in zeilen:
            ergebnis.update(teil)
        return ergebnis


# --- NAS-SNMP (ruhend bis Zugangsdaten hinterlegt sind) --------------------------------------------------------------

SNMP_AUTH = {"SHA", "SHA-224", "SHA-256", "SHA-384", "SHA-512", "MD5"}
SNMP_PRIV = {"AES", "AES-128", "AES-192", "AES-256", "AES128", "AES192", "AES256", "DES"}
SNMP_FELDER = ("NAS_SNMP_BENUTZER", "NAS_SNMP_AUTH_PROTOKOLL", "NAS_SNMP_AUTH_PASSWORT",
               "NAS_SNMP_PRIV_PROTOKOLL", "NAS_SNMP_PRIV_PASSWORT")

OID_HR_UPTIME = ".1.3.6.1.2.1.25.1.1.0"
OID_SYS_UPTIME = ".1.3.6.1.2.1.1.3.0"
OID_SS_CPU_IDLE = ".1.3.6.1.4.1.2021.11.11.0"
OID_MEM = {"total": ".1.3.6.1.4.1.2021.4.5.0", "frei": ".1.3.6.1.4.1.2021.4.6.0",
           "puffer": ".1.3.6.1.4.1.2021.4.14.0", "cache": ".1.3.6.1.4.1.2021.4.15.0"}
OID_HR_PROZESSOR = ".1.3.6.1.2.1.25.3.3.1.2"
OID_HR_GERAETE = ".1.3.6.1.2.1.25.3.2.1"  # .2 Typ, .3 Beschreibung (nur zur Einordnung), .5 Zustand
OID_LM_TEMP = ".1.3.6.1.4.1.2021.13.16.2.1"  # .2 Fühlername (nur zur Einordnung), .3 Wert in m°C
TYP_PLATTE = ".1.3.6.1.2.1.25.3.1.6"


_snmp_meldung: list[str | None] = [None]  # letzter gemeldeter Grund (nur je Zustandswechsel loggen)


def _snmp_befund(grund: str | None) -> None:
    if grund != _snmp_meldung[0]:
        if grund:
            log.warning("technik-snmp.env ungültig: %s — SNMP bleibt aus", grund)
        _snmp_meldung[0] = grund


def snmp_pruefen(werte: dict[str, str]) -> str | None:
    """Grund, warum die Zugangsdaten nicht taugen (nur Feldname und Art, nie Werte), sonst None."""
    for k in SNMP_FELDER:
        if not werte.get(k):
            return f"{k} fehlt"
    for k in SNMP_FELDER:
        if re.search(r"[\s#\"']", werte[k]):
            return f"{k} enthält Leerzeichen, # oder Anführungszeichen"
    for k in ("NAS_SNMP_AUTH_PASSWORT", "NAS_SNMP_PRIV_PASSWORT"):
        if len(werte[k]) < 8:
            return f"{k} kürzer als 8 Zeichen"
    if werte["NAS_SNMP_AUTH_PROTOKOLL"].upper() not in SNMP_AUTH:
        return "NAS_SNMP_AUTH_PROTOKOLL unbekannt (SHA, SHA-256 … oder MD5)"
    if werte["NAS_SNMP_PRIV_PROTOKOLL"].upper() not in SNMP_PRIV:
        return "NAS_SNMP_PRIV_PROTOKOLL unbekannt (AES, AES-256 … oder DES)"
    return None


def snmp_zugang() -> dict[str, str] | str | None:
    """Zugangsdaten nur aus /etc/eventline-ki/technik-snmp.env (root 0600). Datei fehlt → None; vorhanden, aber
    unvollständig/ungültig → "zugang_ungueltig" (Warnung im Journal je Zustandswechsel, nur Feldname und Grund)."""
    try:
        st = SNMP_ENV.stat()
    except OSError:
        _snmp_befund(None)
        return None
    if st.st_uid != 0 or st.st_mode & 0o077:
        _snmp_befund("Datei nicht root 0600")
        return "zugang_ungueltig"
    werte = env_datei(SNMP_ENV)
    grund = snmp_pruefen(werte)
    _snmp_befund(grund)
    if grund:
        return "zugang_ungueltig"
    auth, priv = werte["NAS_SNMP_AUTH_PROTOKOLL"].upper(), werte["NAS_SNMP_PRIV_PROTOKOLL"].upper()
    return {**werte, "NAS_SNMP_AUTH_PROTOKOLL": auth, "NAS_SNMP_PRIV_PROTOKOLL": priv.replace("AES-", "AES")}


def snmp_zeilen(text: str) -> dict[str, str]:
    """Ausgabe mit -On -OQ -Oe -Ot: «.1.3.6… = wert» → {oid: wert}."""
    werte = {}
    for zeile in text.splitlines():
        oid, sep, wert = zeile.partition(" = ")
        if sep and oid.startswith("."):
            werte[oid.strip()] = wert.strip().strip('"')
    return werte


def snmp_grund(rc: int | None, fehler: str) -> str:
    f = fehler.lower()
    if rc is None and fehler == "werkzeug_fehlt":
        return "werkzeug_fehlt"
    if rc is None:
        return "zeitlimit"
    if "authentication" in f or "unknown user" in f or "decryption" in f or "usm" in f or "authorization" in f:
        return "anmeldung"
    if "timeout" in f or "no response" in f:
        return "keine_antwort"
    return "unbekannt"


def snmp_messen(host: str | None) -> dict[str, Any]:
    zugang = snmp_zugang()
    if zugang == "zugang_ungueltig":
        return {"status": "nicht_eingerichtet", "grund": "zugang_ungueltig", "quelle": "snmp"}
    if not isinstance(zugang, dict) or not host:
        return {"status": "nicht_eingerichtet"}
    if not any(os.access(os.path.join(p, "snmpwalk"), os.X_OK) for p in os.environ.get("PATH", "/usr/bin").split(":")):
        return {"status": "nicht_eingerichtet", "grund": "werkzeug_fehlt", "quelle": "snmp"}
    LAUFZEIT_ORDNER.mkdir(mode=0o700, parents=True, exist_ok=True)
    ordner = tempfile.mkdtemp(prefix="snmp-", dir=LAUFZEIT_ORDNER)
    try:
        # Zugangsdaten über eine eigene snmp.conf (0600) statt über Argumente — die stünden in /proc/<pid>/cmdline.
        conf = os.path.join(ordner, "snmp.conf")
        fd = os.open(conf, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(
                "defVersion 3\n"
                "defSecurityLevel authPriv\n"
                f"defSecurityName {zugang['NAS_SNMP_BENUTZER']}\n"
                f"defAuthType {zugang['NAS_SNMP_AUTH_PROTOKOLL']}\n"
                f"defAuthPassphrase {zugang['NAS_SNMP_AUTH_PASSWORT']}\n"
                f"defPrivType {zugang['NAS_SNMP_PRIV_PROTOKOLL']}\n"
                f"defPrivPassphrase {zugang['NAS_SNMP_PRIV_PASSWORT']}\n"
            )
        env = {"PATH": "/usr/bin:/bin", "SNMPCONFPATH": ordner, "SNMP_PERSISTENT_DIR": ordner,
               "MIBS": "", "MIBDIRS": ordner, "HOME": ordner}
        ziel = f"udp:{host}:161"
        ende = time.monotonic() + SNMP_ZEITLIMIT_S
        gemeinsam = ["-On", "-OQ", "-Oe", "-Ot", "-t", "2", "-r", "0", ziel]

        def frage(werkzeug: str, *oids: str) -> tuple[dict[str, str] | None, str | None]:
            rest = ende - time.monotonic()
            if rest <= 0.5:
                return None, "zeitlimit"
            rc, aus, err = befehl([werkzeug, *gemeinsam, *oids], rest, env=env)
            werte = snmp_zeilen(aus)
            if rc == 0 or werte:
                return werte, None
            return None, snmp_grund(rc, err)

        skalare, grund = frage("snmpget", OID_HR_UPTIME, OID_SS_CPU_IDLE, *OID_MEM.values())
        if skalare is None:
            # snmpget scheitert als Ganzes, wenn eine OID fehlt (noSuchName) — dann die Systemlaufzeit allein.
            skalare, grund = frage("snmpget", OID_SYS_UPTIME)
        if skalare is None:
            return {"status": "fehler", "grund": grund or "unbekannt", "quelle": "snmp", "gemessen_am": jetzt_iso()}
        prozessoren, _ = frage("snmpwalk", OID_HR_PROZESSOR)
        geraete, _ = frage("snmpwalk", OID_HR_GERAETE)
        temps, _ = frage("snmpwalk", OID_LM_TEMP)
        return {"status": "ok", "quelle": "snmp", "gemessen_am": jetzt_iso(),
                **snmp_auswerten(skalare, prozessoren or {}, geraete or {}, temps or {})}
    finally:
        for name in os.listdir(ordner):
            try:
                os.unlink(os.path.join(ordner, name))
            except OSError:
                pass
        try:
            os.rmdir(ordner)
        except OSError:
            pass


def _snmp_zahl(text: str | None) -> float | None:
    if text is None:
        return None
    m = re.match(r"^-?\d+(\.\d+)?", text.strip())
    return float(m.group(0)) if m else None


def snmp_auswerten(skalare: dict[str, str], prozessoren: dict[str, str], geraete: dict[str, str],
                   temps: dict[str, str]) -> dict[str, Any]:
    """Nur Zahlen und Zustandswörter. Beschreibungen/Fühlernamen dienen allein der Einordnung (Platte? Prozessor?)
    und verlassen die Funktion nie. Was das NAS nicht liefert, fehlt (Seite: «nicht lesbar»)."""
    ergebnis: dict[str, Any] = {}
    ticks = _snmp_zahl(skalare.get(OID_HR_UPTIME)) or _snmp_zahl(skalare.get(OID_SYS_UPTIME))
    if ticks is not None and ticks >= 0:
        ergebnis["uptime_s"] = int(ticks / 100)
    lasten = [v for v in (_snmp_zahl(w) for w in prozessoren.values()) if v is not None and 0 <= v <= 100]
    if lasten:
        ergebnis["last_prozent"] = zahl(mittel(lasten), 0)
    else:
        idle = _snmp_zahl(skalare.get(OID_SS_CPU_IDLE))
        if idle is not None and 0 <= idle <= 100:
            ergebnis["last_prozent"] = zahl(100 - idle, 0)
    mem = {k: _snmp_zahl(skalare.get(o)) for k, o in OID_MEM.items()}
    if mem["total"] and mem["frei"] is not None:
        belegt = mem["total"] - mem["frei"] - (mem["puffer"] or 0) - (mem["cache"] or 0)
        ergebnis["ram_prozent"] = zahl(max(0.0, min(100.0, belegt / mem["total"] * 100)), 0)

    # Temperaturen (LM-SENSORS-MIB): Fühler nach Name einordnen.
    namen = {oid.rsplit(".", 1)[1]: wert.lower() for oid, wert in temps.items() if oid.startswith(OID_LM_TEMP + ".2.")}
    cpu, system, platten_t = [], [], []
    for index in sorted(namen, key=lambda i: int(i) if i.isdigit() else 0):
        wert = _snmp_zahl(temps.get(f"{OID_LM_TEMP}.3.{index}"))
        if wert is None:
            continue
        c = wert / 1000.0
        if not -20 <= c <= 150:
            continue
        name = namen[index]
        if re.search(r"drivetemp|\bsd[a-z]\b|nvme|hdd|disk|sata|\bata\d", name):
            platten_t.append(c)
        elif re.search(r"cpu|core|package|k10temp|coretemp|tctl|tdie|soc", name):
            cpu.append(c)
        else:
            system.append(c)
    if system:
        ergebnis["system_temp_c"] = zahl(max(system), 0)
    if cpu:
        ergebnis["cpu_temp_c"] = zahl(max(cpu), 0)

    # Platten und Pool (HOST-RESOURCES-MIB hrDeviceTable): Zustand 2 läuft, 3 Warnung, 5 ausgefallen.
    typen = {oid.rsplit(".", 1)[1]: w for oid, w in geraete.items() if oid.startswith(OID_HR_GERAETE + ".2.")}
    beschreibung = {oid.rsplit(".", 1)[1]: w.lower() for oid, w in geraete.items() if oid.startswith(OID_HR_GERAETE + ".3.")}
    zustand = {oid.rsplit(".", 1)[1]: _snmp_zahl(w) for oid, w in geraete.items() if oid.startswith(OID_HR_GERAETE + ".5.")}
    gesundheit_platten: list[str] = []
    raid: str | None = None
    for index in sorted(typen, key=lambda i: int(i) if i.isdigit() else 0):
        z = zustand.get(index)
        wort = {2: "ok", 3: "warnung", 5: "fehler"}.get(int(z)) if z is not None else None
        if re.search(r"\braid|\bmd\d+\b|\bpool\b", beschreibung.get(index, "")):
            raid_wort = {2: "normal", 3: "wiederaufbau", 4: "wiederaufbau", 5: "degradiert"}.get(int(z)) if z is not None else None
            if raid_wort:
                raid = raid_wort if raid is None or raid == "normal" else raid
            continue
        if typen[index].endswith(TYP_PLATTE) and wort:
            gesundheit_platten.append(wort)
    anzahl = min(8, max(len(platten_t), len(gesundheit_platten)))
    if anzahl:
        ergebnis["platten"] = [ohne_none({
            "schacht": i + 1,
            "temp_c": zahl(platten_t[i], 0) if i < len(platten_t) else None,
            "gesundheit": gesundheit_platten[i] if i < len(gesundheit_platten) else None,
        }) for i in range(anzahl)]
    if raid:
        ergebnis["raid"] = raid
    return ergebnis


# --- NAS-Hardware über die Mess-Container (Exporter, VERTRAG.md §1.4) --------------------------------------------------
#
# Zwei Container auf dem NAS (rig/eventline-ki/nas-messung/): node_exporter («system», Port 9100) und
# smartctl_exporter («platten», Port 9633), beide mit Basic-Auth. Ruht, solange /etc/eventline-ki/technik-nas.env
# fehlt; ist sie da, hat der Exporter Vorrang vor SNMP. Abgefragt wird alle 60 s in einem Kind (--exporter-probe) mit
# hartem Zeitlimit; das Kind wertet auch gleich aus und gibt nur Zahlen und Zustandswörter zurück — Geräte-, Modell-,
# Seriennummern- und Fühlernamen verlassen das Kind nie. Platten heissen im Paket nur «Schacht n» (Reihenfolge der
# Geräte, siehe platten_auswerten); Nummern über NAS_SCHAECHTE (technik-nas.env, Standard 4) sind externe Platten
# (USB) und tragen `extern: true`.

NAS_ENV = Path("/etc/eventline-ki/technik-nas.env")
NAS_SCHAECHTE_STANDARD = 4  # eingebaute Schächte des NAS; sda … sdN = Schacht 1 … N, alles danach extern
NAS_SCHAECHTE_MAX = 16
EXPORTER_S = 60.0
EXPORTER_ZEITLIMIT_S = 15.0  # hartes Zeitlimit des Kindes für beide Abfragen
EXPORTER_ANFRAGE_S = 6.0  # Zeitlimit je Verbindungsaufbau / Lesen
EXPORTER_MAX_B = 8 << 20  # so viel liefert keiner der beiden Exporter (heute < 100 KB)
EXPORTER_PORTS = {"system": 9100, "platten": 9633}
EXPORTER_FELDER = ("NAS_EXPORTER_BENUTZER", "NAS_EXPORTER_PASSWORT")
EXPORTER_GRUND_RANG = ("anmeldung", "keine_antwort", "zeitlimit", "unbekannt")  # bei Doppelfehler der hilfreichste

_HOSTNAME = re.compile(r"(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*")

_exporter_meldung: list[str | None] = [None]


def _exporter_befund(grund: str | None) -> None:
    if grund != _exporter_meldung[0]:
        if grund:
            log.warning("technik-nas.env ungültig: %s — NAS-Exporter bleibt aus", grund)
        _exporter_meldung[0] = grund


def gueltige_adresse(adresse: str) -> bool:
    try:
        ipaddress.ip_address(adresse)
        return True
    except ValueError:
        return bool(_HOSTNAME.fullmatch(adresse))


def exporter_pruefen(werte: dict[str, str], host: str | None) -> str | None:
    """Grund, warum die Zugangsdaten nicht taugen (nur Feldname und Art, nie Werte), sonst None."""
    for k in EXPORTER_FELDER:
        if not werte.get(k):
            return f"{k} fehlt"
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", werte["NAS_EXPORTER_BENUTZER"]):
        return "NAS_EXPORTER_BENUTZER enthält unerlaubte Zeichen (erlaubt: Buchstaben, Ziffern, . _ -)"
    passwort = werte["NAS_EXPORTER_PASSWORT"]
    if re.search(r"[\s#\"']", passwort):
        return "NAS_EXPORTER_PASSWORT enthält Leerzeichen, # oder Anführungszeichen"
    if not 12 <= len(passwort) <= 128:
        return "NAS_EXPORTER_PASSWORT muss 12 bis 128 Zeichen lang sein"
    adresse = (werte.get("NAS_EXPORTER_ADRESSE") or "").strip("[]")
    if not adresse:
        if not host:
            return "NAS_EXPORTER_ADRESSE fehlt (und keine NAS-Adresse in der Einhänge-Konfiguration)"
        adresse = host.strip("[]")
    if not gueltige_adresse(adresse):
        return "NAS_EXPORTER_ADRESSE ungültig"
    for k in ("NAS_EXPORTER_PORT_SYSTEM", "NAS_EXPORTER_PORT_PLATTEN"):
        v = werte.get(k)
        if v and not (v.isdigit() and 1 <= int(v) <= 65535):
            return f"{k} ungültig (1 bis 65535)"
    schaechte = werte.get("NAS_SCHAECHTE")
    if schaechte and not (re.fullmatch(r"[0-9]{1,2}", schaechte) and 1 <= int(schaechte) <= NAS_SCHAECHTE_MAX):
        return f"NAS_SCHAECHTE ungültig (ganze Zahl 1 bis {NAS_SCHAECHTE_MAX})"
    return None


def exporter_zugang() -> dict[str, Any] | str | None:
    """Zugang nur aus /etc/eventline-ki/technik-nas.env (root 0600). Datei fehlt → None (Exporter ruht, SNMP wie
    bisher); vorhanden, aber ungültig → "zugang_ungueltig" (Warnung im Journal je Zustandswechsel, nur Feldname
    und Grund). Ohne NAS_EXPORTER_ADRESSE gilt die Adresse aus der Einhänge-Konfiguration, ohne NAS_SCHAECHTE 4."""
    try:
        st = NAS_ENV.stat()
    except OSError:
        _exporter_befund(None)
        return None
    if st.st_uid != 0 or st.st_mode & 0o077:
        _exporter_befund("Datei nicht root 0600")
        return "zugang_ungueltig"
    werte = env_datei(NAS_ENV)
    host = nas_konfiguration()["host"]
    grund = exporter_pruefen(werte, host)
    _exporter_befund(grund)
    if grund:
        return "zugang_ungueltig"
    return {
        "benutzer": werte["NAS_EXPORTER_BENUTZER"],
        "passwort": werte["NAS_EXPORTER_PASSWORT"],
        "adresse": ((werte.get("NAS_EXPORTER_ADRESSE") or "").strip("[]") or str(host).strip("[]")),
        "ports": {n: int(werte.get(f"NAS_EXPORTER_PORT_{n.upper()}") or p) for n, p in EXPORTER_PORTS.items()},
        "schaechte": int(werte.get("NAS_SCHAECHTE") or NAS_SCHAECHTE_STANDARD),
    }


def exporter_url(adresse: str, port: int) -> str:
    return f"http://{f'[{adresse}]' if ':' in adresse else adresse}:{port}/metrics"


# Prometheus-Textformat (eigener kleiner Leser, keine Abhängigkeit): «name{a="b",c="d"} wert [zeitstempel]».
_PROM_ZEILE = re.compile(r"^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?[ \t]+(\S+)(?:[ \t]+-?\d+)?[ \t]*$")
_PROM_LABEL = re.compile(r'[ \t]*([a-zA-Z_][a-zA-Z0-9_]*)[ \t]*=[ \t]*"((?:[^"\\]|\\.)*)"[ \t]*(?:,|$)')
_PROM_ESCAPE = re.compile(r"\\(.)")

PromFamilien = dict[str, list[tuple[dict[str, str], float]]]


def prom_parsen(text: str, familien: set[str] | frozenset[str] | None = None, max_zeilen: int = 200_000) -> PromFamilien:
    """{metrikname: [(labels, wert), …]}. Nur die genannten Familien; Kommentare, kaputte Zeilen und NaN/±Inf
    fallen still weg."""
    ergebnis: PromFamilien = {}
    for i, zeile in enumerate(text.splitlines()):
        if i >= max_zeilen:
            break
        if not zeile or zeile[0] == "#":
            continue
        m = _PROM_ZEILE.match(zeile)
        if not m or (familien is not None and m.group(1) not in familien):
            continue
        labels: dict[str, str] = {}
        roh = m.group(2) or ""
        pos, kaputt = 0, False
        while pos < len(roh) and roh[pos:].strip():
            lm = _PROM_LABEL.match(roh, pos)
            if not lm or lm.end() == pos:
                kaputt = True
                break
            labels[lm.group(1)] = _PROM_ESCAPE.sub(lambda e: "\n" if e.group(1) == "n" else e.group(1), lm.group(2))
            pos = lm.end()
        if kaputt:
            continue
        try:
            wert = float(m.group(3))
        except ValueError:
            continue
        if wert != wert or wert in (float("inf"), float("-inf")):
            continue
        ergebnis.setdefault(m.group(1), []).append((labels, wert))
    return ergebnis


SYSTEM_FAMILIEN = frozenset({
    "node_cpu_seconds_total", "node_memory_MemTotal_bytes", "node_memory_MemAvailable_bytes",
    "node_hwmon_temp_celsius", "node_hwmon_chip_names", "node_hwmon_sensor_label",
    "node_md_state", "node_md_disks", "node_md_disks_required", "node_md_degraded",
    "node_filesystem_size_bytes", "node_filesystem_free_bytes", "node_filesystem_device_error",
    "node_boot_time_seconds",
})
PLATTEN_FAMILIEN = frozenset({
    "smartctl_device", "smartctl_device_smart_status", "smartctl_device_smartctl_exit_status",
    "smartctl_device_temperature", "smartctl_device_power_on_seconds", "smartctl_device_attribute",
    "smartctl_device_critical_warning", "smartctl_device_media_errors",
})

CPU_CHIPS = frozenset({"coretemp", "k10temp", "zenpower"})
# Board-Fühler nach Verlässlichkeit: Super-I/O vor Chipsatz vor ACPI (acpitz steht auf vielen Boards fest).
BOARD_RANG = (re.compile(r"^(it8\w*|nct\w*|f71\w*|w83\w*|sch5\w*)$"), re.compile(r"^pch_\w*$"), re.compile(r"^acpitz$"))
_CPU_LABEL = re.compile(r"cpu|core|peci|package|tctl|tdie")


def _plausibel_c(wert: float) -> bool:
    """Unbeschaltete Fühler melden oft 0, −128, 127 oder 128 °C — das ist keine Messung."""
    return 5.0 <= wert <= 115.0 and wert not in (127.0, 128.0)


def nas_temperaturen(f: PromFamilien) -> tuple[float | None, float | None]:
    """(Prozessor, System/Board) in °C aus hwmon. Platten-, NVMe-, RAM-, Netzwerk- und WLAN-Fühler zählen nicht."""
    chips = {lab.get("chip", ""): lab.get("chip_name", "").lower() for lab, _ in f.get("node_hwmon_chip_names", [])}
    labels = {(lab.get("chip", ""), lab.get("sensor", "")): lab.get("label", "").lower()
              for lab, _ in f.get("node_hwmon_sensor_label", [])}
    paket: list[float] = []
    kerne: list[float] = []
    cpu_board: list[float] = []
    board: list[list[float]] = [[] for _ in BOARD_RANG]
    for lab, wert in f.get("node_hwmon_temp_celsius", []):
        if not _plausibel_c(wert):
            continue
        chip, sensor = lab.get("chip", ""), lab.get("sensor", "")
        name, label = chips.get(chip, ""), labels.get((chip, sensor), "")
        if name in CPU_CHIPS:
            (paket if label.startswith("package") or label in ("tctl", "tdie") else kerne).append(wert)
            continue
        for rang, muster in enumerate(BOARD_RANG):
            if muster.match(name):
                (cpu_board if _CPU_LABEL.search(label) else board[rang]).append(wert)
                break
    cpu = max(paket) if paket else max(kerne) if kerne else max(cpu_board) if cpu_board else None
    system = next((max(werte) for werte in board if werte), None)
    return cpu, system


RAID_RANG = {"normal": 0, "wiederaufbau": 1, "degradiert": 2}


def md_zustand(f: PromFamilien) -> str | None:
    """Schlechtester Zustand aller md-Verbünde: Wiederaufbau/Resync → «wiederaufbau», fehlende/ausgefallene Platte
    oder nicht aktiv → «degradiert», sonst (auch während der Prüfung «check») «normal». Ohne md → None."""
    verbuende: dict[str, dict[str, Any]] = {}

    def v(lab: dict[str, str]) -> dict[str, Any]:
        return verbuende.setdefault(lab.get("device", ""), {})

    for lab, wert in f.get("node_md_state", []):
        if wert == 1:
            v(lab)["zustand"] = lab.get("state")
    for lab, wert in f.get("node_md_disks", []):
        v(lab)[f"platten_{lab.get('state', '')}"] = wert
    for lab, wert in f.get("node_md_disks_required", []):
        v(lab)["noetig"] = wert
    for lab, wert in f.get("node_md_degraded", []):
        v(lab)["degradiert"] = wert
    schlimmster: str | None = None
    for d in verbuende.values():
        zustand = d.get("zustand")
        aktiv, noetig = d.get("platten_active"), d.get("noetig")
        fehlt = (d.get("degradiert") or 0) > 0 or (d.get("platten_failed") or 0) > 0 or (
            aktiv is not None and noetig is not None and aktiv < noetig)
        if zustand in ("recovering", "resync"):
            wort = "wiederaufbau"
        elif zustand == "inactive" or fehlt:
            wort = "degradiert"
        elif zustand in ("active", "check") or (aktiv is not None and noetig):
            wort = "normal"
        else:
            continue
        if schlimmster is None or RAID_RANG[wort] > RAID_RANG[schlimmster]:
            schlimmster = wort
    return schlimmster


def nas_volume(f: PromFamilien) -> dict[str, int] | None:
    """Grösstes Daten-Volume (/volume1, /volume2 …) — belegt wie statvfs: Grösse − frei."""
    def schluessel(lab: dict[str, str]) -> tuple[str, str]:
        return lab.get("mountpoint", ""), lab.get("device", "")

    groesse = {schluessel(lab): w for lab, w in f.get("node_filesystem_size_bytes", [])
               if re.fullmatch(r"/volume\d+", lab.get("mountpoint", ""))}
    frei = {schluessel(lab): w for lab, w in f.get("node_filesystem_free_bytes", [])}
    kaputt = {schluessel(lab) for lab, w in f.get("node_filesystem_device_error", []) if w > 0}
    kandidaten = [(g, frei[k]) for k, g in groesse.items() if k in frei and k not in kaputt and g > 0]
    if not kandidaten:
        return None
    gesamt, frei_b = max(kandidaten)
    return {"gesamt_b": int(gesamt), "belegt_b": int(max(0.0, gesamt - frei_b))}


def system_auswerten(f: PromFamilien) -> dict[str, Any]:
    """node_exporter → Zahlen: CPU-Zeit (Summe über alle Kerne; Leerlauf = idle + iowait wie /proc/stat am Rig),
    RAM-Belegung, Temperaturen, RAID, Volume, Startzeit."""
    gesamt = leer = 0.0
    n = 0
    for lab, wert in f.get("node_cpu_seconds_total", []):
        if wert < 0:
            continue
        n += 1
        gesamt += wert
        if lab.get("mode") in ("idle", "iowait"):
            leer += wert
    total = next((w for _, w in f.get("node_memory_MemTotal_bytes", [])), None)
    verfuegbar = next((w for _, w in f.get("node_memory_MemAvailable_bytes", [])), None)
    ram = None
    if total and total > 0 and verfuegbar is not None and 0 <= verfuegbar <= total:
        ram = (total - verfuegbar) / total * 100
    cpu_c, system_c = nas_temperaturen(f)
    boot = next((w for _, w in f.get("node_boot_time_seconds", [])), None)
    return ohne_none({
        "cpu": {"gesamt": round(gesamt, 3), "leerlauf": round(leer, 3)} if n else None,
        "ram_prozent": zahl(ram, 1),
        "cpu_temp_c": zahl(cpu_c, 0),
        "system_temp_c": zahl(system_c, 0),
        "raid": md_zustand(f),
        "volume": nas_volume(f),
        "boot_s": boot if boot and boot > 0 else None,
    })


SMART_WARN_ROH = (5, 187, 197, 198)  # umgelagerte / gemeldete unkorrigierbare / ausstehende / nicht korrigierbare Sektoren
SMART_ZAEHLER = {"umgelagert": 5, "ausstehend": 197, "nicht_korrigierbar": 198, "crc_fehler": 199}
SMART_ROH_IDS = frozenset({5, 187, 194, 197, 198, 199})


def sata_nummer(name: str) -> int | None:
    """sda → 1, sdb → 2, … sdz → 26, sdaa → 27; andere Geräte (NVMe, USB-Sticks ohne sdX) → None."""
    m = re.fullmatch(r"sd([a-z]{1,2})", name)
    if not m:
        return None
    n = 0
    for c in m.group(1):
        n = n * 26 + ord(c) - 96
    return n


def platten_auswerten(f: PromFamilien) -> list[dict[str, Any]]:
    """smartctl_exporter → je SATA-Platte Temperatur, Gesundheit, Betriebsstunden und die wichtigen SMART-Zähler.
    «schacht» = Buchstabe des Geräts (sda = 1, sdb = 2 …): bleibt stabil, auch wenn eine Platte gerade schläft und
    nichts liefert (sie fehlt dann im Paket). Dass sda im Schacht 1 steckt, ist eine Annahme (README nas-messung);
    welche Nummern extern sind, entscheidet exporter_block (NAS_SCHAECHTE).
    Gerätenamen, Modelle und Seriennummern bleiben in dieser Funktion."""
    geraete: dict[str, dict[str, float | str]] = {}

    def g(lab: dict[str, str]) -> dict[str, float | str] | None:
        name = re.sub(r"^/dev/", "", lab.get("device", ""))
        return geraete.setdefault(name, {}) if name else None

    def setze(familie: str, schluessel: str, bedingung: Callable[[dict[str, str]], bool] = lambda _l: True) -> None:
        for lab, wert in f.get(familie, []):
            d = g(lab)
            if d is not None and bedingung(lab):
                d[schluessel] = wert

    for lab, _wert in f.get("smartctl_device", []):
        d = g(lab)
        if d is not None:
            d["protokoll"] = lab.get("protocol", "").lower()
    setze("smartctl_device_smart_status", "bestanden")
    setze("smartctl_device_smartctl_exit_status", "exit")
    setze("smartctl_device_temperature", "temp", lambda lab: lab.get("temperature_type") == "current")
    setze("smartctl_device_power_on_seconds", "sekunden")
    setze("smartctl_device_critical_warning", "nvme_warnung")
    setze("smartctl_device_media_errors", "medienfehler")
    for lab, wert in f.get("smartctl_device_attribute", []):
        nr = lab.get("attribute_id", "")
        d = g(lab)
        if d is not None and lab.get("attribute_value_type") == "raw" and nr.isdigit() and int(nr) in SMART_ROH_IDS:
            d[f"a{int(nr)}"] = wert

    def zaehler(d: dict[str, float | str], schluessel: str) -> int | None:
        w = d.get(schluessel)
        return int(w) if isinstance(w, float) and 0 <= w < 2 ** 53 else None

    nummern: list[tuple[int, str]] = []
    for name, d in geraete.items():
        nr = sata_nummer(name)
        if nr is not None and nr <= 64 and d.get("protokoll", "ata") in ("ata", "scsi", ""):
            nummern.append((nr, name))
    nummern.sort()
    platten: list[dict[str, Any]] = []
    for nummer, name in nummern:
        d = geraete[name]
        temp_c = d.get("temp")
        if not isinstance(temp_c, float) and isinstance(d.get("a194"), float):
            temp_c = float(int(d["a194"]) & 0xFF)  # Rohwert 194: tiefstes Byte = aktuelle Temperatur
        exit_code = int(d["exit"]) if isinstance(d.get("exit"), float) else 0
        gesundheit: str | None = None
        if d.get("bestanden") == 0.0 or exit_code & 0x08:  # SMART meldet «DISK FAILING»
            gesundheit = "fehler"
        elif d.get("bestanden") == 1.0:
            gesundheit = "ok"
            if (any((zaehler(d, f"a{i}") or 0) > 0 for i in SMART_WARN_ROH)
                    or exit_code & (0x10 | 0x20 | 0x80)  # Vorwarn-Attribut jetzt/früher unter Schwelle, Selbsttest-Fehler
                    or (zaehler(d, "nvme_warnung") or 0) > 0 or (zaehler(d, "medienfehler") or 0) > 0):
                gesundheit = "warnung"
        sekunden = zaehler(d, "sekunden")
        eintrag = ohne_none({
            "temp_c": zahl(temp_c, 0) if isinstance(temp_c, float) and 1 <= temp_c <= 99 else None,
            "gesundheit": gesundheit,
            "betriebsstunden": sekunden // 3600 if sekunden is not None else None,
            **{k: zaehler(d, f"a{nr}") for k, nr in SMART_ZAEHLER.items()},
        })
        if eintrag:
            platten.append({"schacht": nummer, **eintrag})
    return platten[:8]


class _KeineWeiterleitung(urllib.request.HTTPRedirectHandler):
    """Eine Weiterleitung würde die Zugangsdaten an ein anderes Ziel tragen — sie zählt als Fehler."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201
        return None


def exporter_grund(fehler: BaseException) -> str:
    if isinstance(fehler, urllib.error.HTTPError):
        return "anmeldung" if fehler.code in (401, 403) else "unbekannt"
    ursache = fehler.reason if isinstance(fehler, urllib.error.URLError) else fehler
    if isinstance(ursache, TimeoutError):
        return "zeitlimit"
    if isinstance(ursache, OSError):
        return "keine_antwort"  # abgelehnt, keine Route, Name unbekannt, Verbindung abgebrochen
    return "unbekannt"


def exporter_probe_kind() -> int:
    """Unterprozess (--exporter-probe): liest {benutzer, passwort, ziele, zeitlimit_s} von stdin, fragt die Ziele
    nacheinander ab (ohne Proxy, ohne Weiterleitungen) und schreibt je Ziel eine JSON-Zeile mit den ausgewerteten
    Zahlen oder dem Fehlergrund. Fehlertexte, Adressen und Rohdaten verlassen das Kind nicht."""
    try:
        auftrag = json.loads(sys.stdin.readline() or "{}")
    except ValueError:
        auftrag = {}
    kopf = "Basic " + base64.b64encode(
        f"{auftrag.get('benutzer', '')}:{auftrag.get('passwort', '')}".encode()).decode()
    oeffner = urllib.request.build_opener(urllib.request.ProxyHandler({}), _KeineWeiterleitung())
    zeitlimit = float(auftrag.get("zeitlimit_s") or EXPORTER_ANFRAGE_S)
    for ziel in auftrag.get("ziele") or []:
        name = ziel.get("name")
        try:
            anfrage = urllib.request.Request(str(ziel.get("url")), headers={
                "Authorization": kopf, "Accept": "text/plain", "User-Agent": "eventline-technik"})
            with oeffner.open(anfrage, timeout=zeitlimit) as antwort:
                roh = antwort.read(EXPORTER_MAX_B + 1)
            if len(roh) > EXPORTER_MAX_B:
                raise ValueError("zu gross")
            text = roh.decode("utf-8", "replace")
            if name == "system":
                werte: dict[str, Any] = system_auswerten(prom_parsen(text, SYSTEM_FAMILIEN))
            else:
                werte = {"platten": platten_auswerten(prom_parsen(text, PLATTEN_FAMILIEN))}
            print(json.dumps({"name": name, "ok": True, "werte": werte}), flush=True)
        except Exception as e:  # noqa: BLE001 — jeder Fehler wird zu einem Grund-Wort
            print(json.dumps({"name": name, "ok": False, "grund": exporter_grund(e)}), flush=True)
    return 0


def exporter_block(ergebnisse: dict[str, dict[str, Any]], cpu_vorher: dict[str, float] | None, jetzt: float,
                   schaechte: int = NAS_SCHAECHTE_STANDARD,
                   ) -> tuple[dict[str, Any], dict[str, int] | None, dict[str, float] | None, str | None]:
    """Ergebnisse des Kindes → (Block nas.snmp, Volume-Ersatz, CPU-Zähler fürs nächste Mal, Hinweis fürs Journal).
    Ein Ziel genügt für «ok» (was fehlt, zeigt die Seite als «nicht lesbar»); scheitern beide → «fehler» mit dem
    hilfreichsten Grund. Ein Ziel ohne Antwortzeile ist im harten Zeitlimit hängen geblieben. Platten mit einer
    Nummer über `schaechte` stecken nicht im Gehäuse (USB) und bekommen `extern: true`; ihre Nummer bleibt."""
    gruende: dict[str, str] = {}
    for n in EXPORTER_PORTS:
        e = ergebnisse.get(n) or {}
        gruende[n] = "" if e.get("ok") else str(e.get("grund") or "zeitlimit")
    hinweis = ", ".join(f"{n}: {g}" for n, g in gruende.items() if g) or None
    if all(gruende.values()):
        grund = next(g for g in EXPORTER_GRUND_RANG if g in gruende.values())
        return ({"status": "fehler", "grund": grund, "quelle": "exporter", "gemessen_am": jetzt_iso(jetzt)},
                None, cpu_vorher, hinweis)
    block: dict[str, Any] = {"status": "ok", "quelle": "exporter", "gemessen_am": jetzt_iso(jetzt)}
    volume = None
    cpu_neu = cpu_vorher
    if not gruende["system"]:
        w = ergebnisse["system"].get("werte") or {}
        cpu = w.get("cpu") if isinstance(w.get("cpu"), dict) else None
        last = None
        if cpu and cpu_vorher and 0 < jetzt - cpu_vorher["t"] <= 600:
            d_gesamt = cpu["gesamt"] - cpu_vorher["gesamt"]
            d_leer = cpu["leerlauf"] - cpu_vorher["leerlauf"]
            if d_gesamt > 0 and 0 <= d_leer <= d_gesamt:
                last = (1 - d_leer / d_gesamt) * 100
        cpu_neu = {"t": jetzt, "gesamt": float(cpu["gesamt"]), "leerlauf": float(cpu["leerlauf"])} if cpu else None
        boot = w.get("boot_s")
        block.update(ohne_none({
            "system_temp_c": zahl(w.get("system_temp_c"), 0),
            "cpu_temp_c": zahl(w.get("cpu_temp_c"), 0),
            "raid": w.get("raid") if w.get("raid") in RAID_RANG else None,
            "last_prozent": zahl(last, 0),
            "ram_prozent": zahl(w.get("ram_prozent"), 0),
            "uptime_s": int(jetzt - boot) if isinstance(boot, (int, float)) and 0 < boot <= jetzt else None,
        }))
        v = w.get("volume")
        if isinstance(v, dict) and isinstance(v.get("gesamt_b"), int) and isinstance(v.get("belegt_b"), int):
            volume = {"gesamt_b": v["gesamt_b"], "belegt_b": v["belegt_b"]}
    if not gruende["platten"]:
        platten = (ergebnisse["platten"].get("werte") or {}).get("platten")
        if isinstance(platten, list) and platten:
            block["platten"] = [{**p, "extern": True} if isinstance(p.get("schacht"), int) and p["schacht"] > schaechte
                                else p for p in platten[:8] if isinstance(p, dict)]
    return block, volume, cpu_neu, hinweis


class NasExporter:
    """Fragt beide Exporter im Kind ab und merkt sich die CPU-Zähler für die Last (Rate zwischen zwei Abfragen)."""

    def __init__(self) -> None:
        self.kind = Kindprozess("--exporter-probe", EXPORTER_ZEITLIMIT_S)
        self.cpu_vorher: dict[str, float] | None = None

    def messen(self, zugang: dict[str, Any]) -> tuple[dict[str, Any], dict[str, int] | None, str | None]:
        ziele = [{"name": n, "url": exporter_url(zugang["adresse"], zugang["ports"][n])} for n in EXPORTER_PORTS]
        zeilen = self.kind.zeilen({"benutzer": zugang["benutzer"], "passwort": zugang["passwort"], "ziele": ziele,
                                   "zeitlimit_s": EXPORTER_ANFRAGE_S})
        ergebnisse = {z["name"]: z for z in zeilen or [] if z.get("name") in EXPORTER_PORTS}
        block, volume, self.cpu_vorher, hinweis = exporter_block(
            ergebnisse, self.cpu_vorher, time.time(), zugang.get("schaechte", NAS_SCHAECHTE_STANDARD))
        return block, volume, hinweis


# --- Leistung der lokalen KI (VERTRAG §2.6) -------------------------------------------------------------------------
#
# Alle 10 min im Container «datenbank» (Label eventline-ki, ID aus der Dienst-Abfrage) mit psql gerechnet — NUR LESEN:
# PGOPTIONS setzt jede Transaktion read-only und ein Zeitlimit von 8 s je Anweisung, das Ganze hat 30 s. Gefragt
# werden nur Zähler, Dauern, Seiten/Zeichen, Grössen und Selbsttest-Anteile; Pfade, Namen und Texte stehen in keiner
# Anweisung. Jede Anweisung liefert eine JSON-Zeile mit «teil» und darf einzeln scheitern (Tabelle fehlt). Was
# zurückkommt, wird hier nochmals geprüft (Weissliste der Arten, Zahlenbereiche) — erst dann geht es ins Paket.

LEISTUNG_DB_BENUTZER = "eventline"  # = docker-compose.yml, Dienst db (POSTGRES_USER)
LEISTUNG_DB_NAME = "eventline_ki"  # = POSTGRES_DB
LEISTUNG_PGOPTIONS = "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=8000"
LEISTUNG_ZEITRAEUME = ("7d", "30d", "alle")
# Auftraege der App (= KI_ARTEN im FSM), die Nachtarbeit und die Sicherheits-Rapporte; alles andere (z. B.
# Hauptmodell-Proben) zählt nicht
LEISTUNG_ARTEN = ("ablage_analyse", "beleg_analyse", "warenkorb_analyse", "diktat", "nas_suche", "archiv_frage",
                  "nacht_fristen", "nacht_zz", "sicherheit_rapport")
# Arten mit einem gelesenen Dokument: ki_protokoll trägt dort Seiten, Zeichen, gescannt und Teile (seit 15.10.2026)
LEISTUNG_DOKUMENT_ARTEN = ("ablage_analyse", "beleg_analyse", "warenkorb_analyse", "nacht_zz")
LEISTUNG_SELBSTTEST_MAX = 30
LEISTUNG_TEILE = ("auftraege", "dokumente", "gelesen", "lesezeit", "fristen", "selbsttest", "belege")
# Belegquote (ki_protokoll.belege seit 16.10.2026, = dienst/app/protokoll.BELEG_FELDER)
LEISTUNG_BELEG_FELDER = ("datum", "zeitraum", "status", "bezug", "absender", "empfaenger", "beteiligte", "rolle", "fristen")

_Z = ("WITH z(zr, von) AS (VALUES ('7d', now() - interval '7 days'), ('30d', now() - interval '30 days'), "
      "('alle', '-infinity'::timestamptz))")


def _iso_sql(ausdruck: str) -> str:
    return f"to_char(({ausdruck}) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')"


def _anteil_sql(pfad: str) -> str:
    """Zahl aus kennzahlen (jsonb) an `pfad` — nur wenn es wirklich eine Zahl ist (sonst NULL statt Abbruch)."""
    return (f"CASE WHEN jsonb_typeof(kennzahlen #> '{{{pfad}}}') = 'number' "
            f"THEN (kennzahlen #>> '{{{pfad}}}')::numeric END")


_ARTEN_SQL = ", ".join(f"'{a}'" for a in LEISTUNG_ARTEN)
_DOK_ARTEN_SQL = ", ".join(f"'{a}'" for a in LEISTUNG_DOKUMENT_ARTEN)

# Jede Anweisung läuft als eigenes «-c»: scheitert eine (z. B. eine Spalte, die der Dienst erst beim nächsten Start
# anlegt), fehlt nur ihr Teil. Darum stehen die neuen Spalten (ki_protokoll.seiten …, archiv_text.dauer_ms) in eigenen
# Teilen («dokumente», «lesezeit») und nicht in «auftraege»/«gelesen».
LEISTUNG_SQL = (
    # Protokoll der Aufträge (ki_protokoll): je Art Anzahl, ok, Dauer der erfolgreichen
    f"""{_Z}
SELECT jsonb_build_object('teil', 'auftraege',
  'seit', (SELECT {_iso_sql('min(zeit)')} FROM ki_protokoll),
  'werte', (SELECT jsonb_object_agg(z.zr, (
    SELECT coalesce(jsonb_agg(jsonb_build_object('art', p.art, 'n', p.n, 'ok', p.ok, 'median_ms', p.median_ms,
                                                 'max_ms', p.max_ms) ORDER BY p.n DESC), '[]'::jsonb)
    FROM (SELECT art, count(*) AS n, count(*) FILTER (WHERE ok) AS ok,
                 round(percentile_cont(0.5) WITHIN GROUP (ORDER BY dauer_ms) FILTER (WHERE ok AND dauer_ms IS NOT NULL))::bigint AS median_ms,
                 max(dauer_ms) FILTER (WHERE ok) AS max_ms
          FROM ki_protokoll WHERE zeit >= z.von AND art IN ({_ARTEN_SQL}) GROUP BY art) p)) FROM z))""",
    # Dokumente der Aufträge (ki_protokoll seit 15.10.2026): Rechenzeit je Seite (Median über die erfolgreichen
    # Aufträge mit Seitenzahl, getrennt nach Text und gescannt), grösstes Dokument, meiste Teile
    f"""{_Z}
SELECT jsonb_build_object('teil', 'dokumente', 'werte', (SELECT jsonb_object_agg(z.zr, (
  SELECT coalesce(jsonb_agg(jsonb_build_object('art', d.art, 'mit_seiten', d.mit_seiten,
                                               'ms_seite_text', d.ms_seite_text, 'ms_seite_gescannt', d.ms_seite_gescannt,
                                               'seiten_max', d.seiten_max, 'zeichen_max', d.zeichen_max,
                                               'teile_max', d.teile_max) ORDER BY d.art), '[]'::jsonb)
  FROM (SELECT art, count(*) FILTER (WHERE seiten > 0) AS mit_seiten,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY dauer_ms::numeric / seiten)
                     FILTER (WHERE seiten > 0 AND gescannt IS FALSE))::bigint AS ms_seite_text,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY dauer_ms::numeric / seiten)
                     FILTER (WHERE seiten > 0 AND gescannt IS TRUE))::bigint AS ms_seite_gescannt,
               max(seiten) AS seiten_max, max(zeichen) AS zeichen_max, max(teile) AS teile_max
        FROM ki_protokoll
        WHERE zeit >= z.von AND ok AND dauer_ms IS NOT NULL AND art IN ({_DOK_ARTEN_SQL})
          AND (seiten IS NOT NULL OR zeichen IS NOT NULL OR teile IS NOT NULL)
        GROUP BY art) d)) FROM z))""",
    # Tiefen-Index (archiv_text): gelesene Dateien und die grössten Werte
    f"""{_Z}
SELECT jsonb_build_object('teil', 'gelesen', 'werte', (SELECT jsonb_object_agg(z.zr, (
  SELECT jsonb_build_object(
    'dateien', count(*) FILTER (WHERE fehler IS NULL),
    'mit_text', count(*) FILTER (WHERE fehler IS NULL AND zeichen > 0),
    'gescannt', count(*) FILTER (WHERE fehler IS NULL AND ocr),
    'seiten', coalesce(sum(seiten) FILTER (WHERE fehler IS NULL), 0),
    'seiten_max', max(seiten) FILTER (WHERE fehler IS NULL),
    'zeichen_max', max(zeichen) FILTER (WHERE fehler IS NULL),
    'mb_max', round((max(groesse) FILTER (WHERE fehler IS NULL) / 1e6)::numeric, 1))
  FROM archiv_text a WHERE a.extrahiert >= z.von)) FROM z))""",
    # Lesezeit (archiv_text.dauer_ms seit 15.10.2026): exakt gemessene Dauer der Textextraktion je gelesener Datei.
    # Je Seite = Dauer / gelesene Seiten; bei gescannten Dateien erkennt der Index höchstens die ersten N Seiten
    # (N steht im Text-Rezept als «ocrN»), darum dort durch min(Seiten, N).
    f"""{_Z},
l AS (SELECT dauer_ms, ocr, extrahiert,
             CASE WHEN seiten > 0 AND ocr AND substring(rezept_text FROM 'ocr([0-9]+)') IS NOT NULL
                  THEN least(seiten, substring(rezept_text FROM 'ocr([0-9]+)')::int)
                  WHEN seiten > 0 THEN seiten END AS seiten_gelesen
      FROM archiv_text WHERE fehler IS NULL AND dauer_ms IS NOT NULL)
SELECT jsonb_build_object('teil', 'lesezeit', 'werte', (SELECT jsonb_object_agg(z.zr, (
  SELECT jsonb_build_object(
    'gemessen', count(*),
    's_seite_text', round((percentile_cont(0.5) WITHIN GROUP (ORDER BY dauer_ms / 1000.0 / seiten_gelesen)
                           FILTER (WHERE NOT ocr AND seiten_gelesen > 0))::numeric, 2),
    's_seite_gescannt', round((percentile_cont(0.5) WITHIN GROUP (ORDER BY dauer_ms / 1000.0 / seiten_gelesen)
                               FILTER (WHERE ocr AND seiten_gelesen > 0))::numeric, 2),
    's_datei_median', round((percentile_cont(0.5) WITHIN GROUP (ORDER BY dauer_ms / 1000.0))::numeric, 2),
    's_datei_max', round((max(dauer_ms) / 1000.0)::numeric, 1))
  FROM l WHERE l.extrahiert >= z.von)) FROM z))""",
    # Nachtarbeit Fristen (archiv_karte): geprüfte Dateien, davon mit Frist-Hinweis
    f"""{_Z}
SELECT jsonb_build_object('teil', 'fristen', 'werte', (SELECT jsonb_object_agg(z.zr, (
  SELECT jsonb_build_object('dateien', count(*), 'mit_frist', count(*) FILTER (WHERE status = 'fertig'))
  FROM archiv_karte WHERE erstellt >= z.von)) FROM z))""",
    # Selbsttest der Nacht (selbsttest_laeufe): Mittel je Zeitraum und die letzten 30 Läufe
    f"""{_Z},
s AS (SELECT zeit,
             {_anteil_sql('ordnerwahl,einsortiert,dateien')} AS dateien,
             {_anteil_sql('ordnerwahl,einsortiert,top1')} AS top1,
             {_anteil_sql('ordnerwahl,einsortiert,top3')} AS top3,
             {_anteil_sql('ordnerwahl,neutral,top1')} AS top1_n,
             {_anteil_sql('ordnerwahl,neutral,top3')} AS top3_n,
             {_anteil_sql('ordnerwahl,einsortiert,ms_median')} AS ms
      FROM selbsttest_laeufe)
SELECT jsonb_build_object('teil', 'selbsttest',
  'werte', (SELECT jsonb_object_agg(z.zr, (
    SELECT jsonb_build_object('laeufe', count(*), 'top1', round(avg(top1), 3), 'top3', round(avg(top3), 3),
                              'top1_ohne_name', round(avg(top1_n), 3), 'top3_ohne_name', round(avg(top3_n), 3),
                              'ms_median', round(avg(ms)))
    FROM s WHERE s.zeit >= z.von)) FROM z),
  'laeufe', (SELECT coalesce(jsonb_agg(jsonb_build_object('am', {_iso_sql('x.zeit')}, 'dateien', x.dateien,
                                       'top1', round(x.top1, 3), 'top3', round(x.top3, 3),
                                       'top1_ohne_name', round(x.top1_n, 3), 'top3_ohne_name', round(x.top3_n, 3),
                                       'ms_median', round(x.ms)) ORDER BY x.zeit DESC), '[]'::jsonb)
             FROM (SELECT * FROM s ORDER BY zeit DESC LIMIT {LEISTUNG_SELBSTTEST_MAX}) x))""",
    # Belegquote (ki_protokoll.belege seit 16.10.2026, zz/v4 und fristen/v3): je Feld die Angaben der lokalen KI und
    # davon die mit wörtlichem Beleg im Dokument; dazu wie viele Dateien (Rückstau ZZ, Fristen). Nur Zahlen.
    f"""{_Z},
b AS (SELECT p.zeit, p.art, CASE WHEN jsonb_typeof(p.belege) = 'object' THEN p.belege END AS belege
      FROM ki_protokoll p WHERE p.ok AND p.art IN ('nacht_zz', 'nacht_fristen'))
SELECT jsonb_build_object('teil', 'belege', 'werte', (SELECT jsonb_object_agg(z.zr, jsonb_build_object(
  'zz', (SELECT count(*) FROM b WHERE b.zeit >= z.von AND b.art = 'nacht_zz' AND b.belege IS NOT NULL),
  'fristen', (SELECT count(*) FROM b WHERE b.zeit >= z.von AND b.art = 'nacht_fristen' AND b.belege IS NOT NULL),
  'felder', (SELECT coalesce(jsonb_object_agg(f.feld, jsonb_build_object('angegeben', f.a, 'belegt', f.b)), '{{}}'::jsonb)
    FROM (SELECT e.key AS feld,
                 sum(CASE WHEN jsonb_typeof(e.value -> 'angegeben') = 'number' THEN (e.value ->> 'angegeben')::numeric END)::bigint AS a,
                 sum(CASE WHEN jsonb_typeof(e.value -> 'belegt') = 'number' THEN (e.value ->> 'belegt')::numeric END)::bigint AS b
          FROM b CROSS JOIN LATERAL jsonb_each(b.belege) e
          WHERE b.zeit >= z.von AND b.belege IS NOT NULL AND jsonb_typeof(e.value) = 'object'
          GROUP BY e.key) f))) FROM z))""",
)


def _wert(x: Any, hoechst: float, stellen: int = 0) -> int | float | None:
    """Zahl 0…hoechst (gerundet), sonst None — bool, Text, NaN und Negatives fallen weg."""
    if isinstance(x, bool) or not isinstance(x, (int, float)) or x != x or x < 0 or x > hoechst:
        return None
    return int(round(x)) if stellen == 0 else round(float(x), stellen)


def _zeitraum(teile: dict[str, Any], teil: str, z: str) -> Any:
    werte = (teile.get(teil) or {}).get("werte")
    return werte.get(z) if isinstance(werte, dict) else None


def _selbsttest_werte(roh: dict[str, Any], ziel: dict[str, Any]) -> dict[str, Any]:
    for k in ("top1", "top3", "top1_ohne_name", "top3_ohne_name"):
        v = _wert(roh.get(k), 1, 3)
        if v is not None:
            ziel[k] = v
    ms = _wert(roh.get("ms_median"), 86_400_000)
    if ms is not None:
        ziel["ms_median"] = ms
    return ziel


# Kennzahlen je Art aus dem Teil «dokumente» (Name, Höchstwert, Stellen) — nur, wenn die Art auch in «auftraege» steht
_DOKUMENT_FELDER = (("mit_seiten", 1e9, 0), ("ms_seite_text", 86_400_000, 0), ("ms_seite_gescannt", 86_400_000, 0),
                    ("seiten_max", 100_000, 0), ("zeichen_max", 1e9, 0), ("teile_max", 100_000, 0))
# Lesezeit des Tiefen-Index aus dem Teil «lesezeit» (Sekunden) — ersetzt seit 15.10. den Abstand der Zeitstempel
_LESEZEIT_FELDER = (("s_seite_text", 86_400, 2), ("s_seite_gescannt", 86_400, 2), ("s_datei_median", 86_400, 2),
                    ("s_datei_max", 86_400, 2))


def _belege_werte(roh: Any) -> dict[str, Any] | None:
    """Belegquote eines Zeitraums: Dateien (zz, fristen) und je bekanntem Feld {angegeben, belegt} mit belegt ≤ angegeben.
    Ohne eine Datei mit Belegen: None (das Panel sagt dann «noch keine Messung»)."""
    if not isinstance(roh, dict):
        return None
    dz, df = _wert(roh.get("zz"), 1e9), _wert(roh.get("fristen"), 1e9)
    felder: dict[str, dict[str, int]] = {}
    roh_felder = roh.get("felder")
    for feld, w in roh_felder.items() if isinstance(roh_felder, dict) else []:
        if feld not in LEISTUNG_BELEG_FELDER or not isinstance(w, dict):
            continue
        a, b = _wert(w.get("angegeben"), 1e9), _wert(w.get("belegt"), 1e9)
        if a is not None and b is not None and 0 < a and b <= a:
            felder[feld] = {"angegeben": a, "belegt": b}
    if not (dz or df or felder):
        return None
    return {"zz": dz or 0, "fristen": df or 0, "felder": felder}


def _dokumente(teile: dict[str, Any], z: str) -> dict[str, dict[str, Any]]:
    """Je Dokument-Art die geprüften Kennzahlen aus «dokumente» (fehlt der Teil: leer)."""
    aus: dict[str, dict[str, Any]] = {}
    roh = _zeitraum(teile, "dokumente", z)
    for d in roh if isinstance(roh, list) else []:
        if not isinstance(d, dict) or d.get("art") not in LEISTUNG_DOKUMENT_ARTEN or d["art"] in aus:
            continue
        werte: dict[str, Any] = {}
        for k, hoechst, stellen in _DOKUMENT_FELDER:
            v = _wert(d.get(k), hoechst, stellen)
            if v is not None:
                werte[k] = v
        if werte:
            aus[d["art"]] = werte
    return aus


def leistung_block(teile: dict[str, Any], stand: str) -> dict[str, Any] | None:
    """Prüft die JSON-Zeilen der Rig-DB und baut rig.leistung (§2.6). Ohne einen einzigen lesbaren Teil: None."""
    if not any(t in teile for t in LEISTUNG_TEILE):
        return None
    zeitraeume: dict[str, Any] = {}
    for z in LEISTUNG_ZEITRAEUME:
        auftraege: list[dict[str, Any]] = []
        roh = _zeitraum(teile, "auftraege", z)
        dokumente = _dokumente(teile, z)
        gesehen: set[str] = set()
        for a in roh if isinstance(roh, list) else []:
            if not isinstance(a, dict) or a.get("art") not in LEISTUNG_ARTEN or a["art"] in gesehen:
                continue
            n, ok = _wert(a.get("n"), 1e9), _wert(a.get("ok"), 1e9)
            if n is None or ok is None or ok > n:
                continue
            gesehen.add(a["art"])
            eintrag = {"art": a["art"], "n": n, "ok": ok}
            for k in ("median_ms", "max_ms"):
                v = _wert(a.get(k), 86_400_000)
                if v is not None:
                    eintrag[k] = v
            for k, v in dokumente.get(a["art"], {}).items():
                if k != "mit_seiten" or v <= ok:   # mit Seitenzahl: nie mehr als erfolgreiche Aufträge
                    eintrag[k] = v
            auftraege.append(eintrag)
        block: dict[str, Any] = {"auftraege": auftraege[:12]}

        g = _zeitraum(teile, "gelesen", z)
        dateien = _wert(g.get("dateien"), 1e9) if isinstance(g, dict) else None
        if dateien is not None:
            gelesen: dict[str, Any] = {"dateien": dateien}
            for k, hoechst, stellen in (("mit_text", dateien, 0), ("gescannt", dateien, 0), ("seiten", 1e9, 0),
                                        ("seiten_max", 1e6, 0), ("zeichen_max", 1e9, 0), ("mb_max", 1e6, 1)):
                v = _wert(g.get(k), hoechst, stellen)
                if v is not None:
                    gelesen[k] = v
            lz = _zeitraum(teile, "lesezeit", z)
            gemessen = _wert(lz.get("gemessen"), dateien) if isinstance(lz, dict) else None
            if gemessen is not None:   # gemessene Dateien sind eine Teilmenge der gelesenen
                gelesen["gemessen"] = gemessen
                for k, hoechst, stellen in _LESEZEIT_FELDER:
                    v = _wert(lz.get(k), hoechst, stellen)
                    if v is not None and gemessen > 0:
                        gelesen[k] = v
            block["gelesen"] = gelesen

        f = _zeitraum(teile, "fristen", z)
        if isinstance(f, dict):
            fd, fm = _wert(f.get("dateien"), 1e9), _wert(f.get("mit_frist"), 1e9)
            if fd is not None and fm is not None and fm <= fd:
                block["fristen_geprueft"] = {"dateien": fd, "mit_frist": fm}

        s = _zeitraum(teile, "selbsttest", z)
        laeufe = _wert(s.get("laeufe"), 1e6) if isinstance(s, dict) else None
        if laeufe is not None:
            block["selbsttest"] = _selbsttest_werte(s, {"laeufe": laeufe})

        belege = _belege_werte(_zeitraum(teile, "belege", z))
        if belege is not None:
            block["belege"] = belege
        zeitraeume[z] = block

    aus: dict[str, Any] = {"stand": stand, "zeitraeume": zeitraeume}
    seit = _zeit_iso((teile.get("auftraege") or {}).get("seit"))
    if seit:
        aus["seit"] = seit
    laeufe_roh = (teile.get("selbsttest") or {}).get("laeufe")
    laeufe: list[dict[str, Any]] = []
    for l in laeufe_roh[:LEISTUNG_SELBSTTEST_MAX] if isinstance(laeufe_roh, list) else []:
        if not isinstance(l, dict):
            continue
        am, dateien_l = _zeit_iso(l.get("am")), _wert(l.get("dateien"), 1e6)
        if am and dateien_l is not None:
            laeufe.append(_selbsttest_werte(l, {"am": am, "dateien": dateien_l}))
    if laeufe:
        aus["selbsttest"] = sorted(laeufe, key=lambda x: x["am"], reverse=True)
    return aus


def leistung_messen(cid: str) -> dict[str, Any] | None:
    """Rig-DB im Container `cid` lesend abfragen. None, wenn psql nicht lief oder nichts Lesbares kam."""
    args = ["docker", "exec", "-e", LEISTUNG_PGOPTIONS, cid, "psql", "-X", "-q", "-A", "-t",
            "-U", LEISTUNG_DB_BENUTZER, "-d", LEISTUNG_DB_NAME]
    for sql in LEISTUNG_SQL:
        args += ["-c", sql]
    rc, aus, _ = befehl(args, LEISTUNG_ZEITLIMIT_S)
    if rc is None:
        return None
    teile: dict[str, Any] = {}
    for zeile in aus.splitlines():
        try:
            d = json.loads(zeile)
        except ValueError:
            continue
        if isinstance(d, dict) and d.get("teil") in LEISTUNG_TEILE:
            teile[d["teil"]] = d
    return leistung_block(teile, jetzt_iso())


# --- Der Sammler -----------------------------------------------------------------------------------------------------


class Langsam(threading.Thread):
    """Alles, was dauern oder hängen kann, mit eigenen Takten. Ergebnisse liegen unter Lock in self.stand."""

    def __init__(self, halt: threading.Event) -> None:
        super().__init__(name="technik-langsam", daemon=True)
        self.halt = halt
        self.lock = threading.Lock()
        self.stand: dict[str, Any] = {}
        self.faellig: dict[str, float] = {}
        self.platte = system_platte()
        self.nas_probe = NasProbe()
        self.oom = OomMerker()
        self.erste_runde = threading.Event()
        self.nas_fehlversuche = 0
        self.fehlt_seit: str | None = None
        self.exporter = NasExporter()
        self.hw_quelle: str | None = None  # wer den Block nas.snmp zuletzt gefüllt hat: "exporter" | "snmp"
        self.snmp_naechste = 0.0
        self.hw_log: str | None = None
        self.nas_log: bool | None = None
        self.ids: dict[str, str] = {}  # Container-IDs der KI-Dienste (nur intern, für die Leistung)
        self.leistung_log: bool | None = None
        # je Ollama-Instanz Container-ID und interne Adresse (aus der Dienst-Abfrage; nur intern, nie ins Paket)
        self.ollama: dict[str, dict[str, str]] = {}

    def setze(self, **werte: Any) -> None:
        with self.lock:
            self.stand.update(werte)

    def bild(self) -> dict[str, Any]:
        with self.lock:
            return dict(self.stand)

    def _faellig(self, was: str, takt: float) -> bool:
        jetzt = time.monotonic()
        if jetzt >= self.faellig.get(was, 0.0):
            self.faellig[was] = jetzt + takt
            return True
        return False

    def runde(self) -> None:
        for was, takt, fn in (
            ("dienste", DIENSTE_S, self._dienste),
            ("platten", PLATTEN_S, self._platten),
            ("nas", NAS_S, self._nas),
            ("ssd", SMART_S, self._ssd),
            ("module", DMI_S, self._module),
            ("hardware", EXPORTER_S, self._hardware),
            ("leistung", LEISTUNG_S, self._leistung),
            ("ki_ps", KI_PS_S, self._ki_ps),
        ):
            if self.halt.is_set():
                return
            if self._faellig(was, takt):
                try:
                    fn()
                except Exception as e:  # noqa: BLE001 — eine Messung darf den Sammler nie beenden
                    log.warning("Messung %s gescheitert (%s)", was, type(e).__name__)

    def run(self) -> None:
        while not self.halt.is_set():
            self.runde()
            self.erste_runde.set()
            self.halt.wait(2.0)

    def _dienste(self) -> None:
        kennungen: dict[str, str] = {}
        ollama: dict[str, dict[str, str]] = {}
        d = dienste_messen(self.oom, kennungen, ollama)
        if d is not None:
            self.ids = kennungen
            self.ollama = ollama
            self.setze(dienste=d)

    def _ki_ps(self) -> None:
        """/api/ps beider Instanzen (3 s Zeitlimit je Instanz). None je Instanz = nicht erreichbar."""
        ziele = self.ollama
        self.setze(ki_ps={inst: (ps_auswerten(m, time.time()) if (m := ollama_ps(z.get("ip", ""))) is not None else None)
                          for inst, z in ziele.items()})

    def _leistung(self) -> None:
        """Leistung der lokalen KI (§2.6), lesend aus der Rig-DB. Ohne DB-Container oder ohne Antwort bleibt der
        letzte Stand stehen (er trägt seine Zeit in «stand»)."""
        cid = self.ids.get("datenbank")
        block = leistung_messen(cid) if cid else None
        ok = block is not None
        if ok:
            self.setze(leistung=block)
        if ok is not self.leistung_log:
            (log.info if ok else log.warning)("Leistung der KI %s", "ausgewertet" if ok else "nicht lesbar")
            self.leistung_log = ok

    def _platten(self) -> None:
        self.setze(system=belegung("/"), tresor=belegung(TRESOR) if ist_eingehaengt(TRESOR) else None)

    def _ssd(self) -> None:
        self.setze(ssd=ssd_messen(self.platte))

    def _module(self) -> None:
        m = ram_module()
        if m is not None:
            self.setze(module=m)

    def _nas(self) -> None:
        konf = nas_konfiguration()
        fr = freigaben_ist(konf)
        ergebnis = self.nas_probe.messen(konf["host"], fr["pfad"])
        ergebnis = ergebnis or {}
        erreichbar = bool(ergebnis.get("dateifreigabe"))
        self.nas_fehlversuche = 0 if erreichbar else self.nas_fehlversuche + 1
        if self.nas_log is not erreichbar:
            log.info("NAS %s", "erreichbar" if erreichbar else "nicht erreichbar")
            self.nas_log = erreichbar
        if fr["soll"] is not None and fr["ist"] < fr["soll"]:
            self.fehlt_seit = self.fehlt_seit or jetzt_iso()
        else:
            self.fehlt_seit = None
        volume = None
        if isinstance(ergebnis.get("gesamt_b"), int) and ergebnis["gesamt_b"] > 0:
            volume = {"gesamt_b": ergebnis["gesamt_b"], "belegt_b": max(0, int(ergebnis.get("belegt_b") or 0))}
        self.setze(nas=ohne_none({
            "gemessen_am": jetzt_iso(),
            "erreichbar": erreichbar,
            "fehlversuche_in_folge": self.nas_fehlversuche,
            "dateifreigabe": ergebnis.get("dateifreigabe") if "dateifreigabe" in ergebnis else None,
            "weboberflaeche": ergebnis.get("weboberflaeche") if "weboberflaeche" in ergebnis else None,
            "volume": volume,
            "freigaben": {"soll": fr["soll"], "ist": fr["ist"], "schreibend": fr["schreibend"],
                          "lesend": fr["lesend"], "fehlt_seit": self.fehlt_seit},
        }))

    def _hardware(self) -> None:
        """NAS-Hardware (Block nas.snmp): Mess-Container, sobald technik-nas.env da ist (alle 60 s, Vorrang), sonst
        SNMP wie bisher (alle 5 min, ruht ohne technik-snmp.env). Fällt die Exporter-Datei weg, fragt SNMP sofort."""
        zugang = exporter_zugang()
        volume = None
        hinweis = None
        if zugang is None:
            jetzt = time.monotonic()
            if self.hw_quelle == "snmp" and jetzt < self.snmp_naechste:
                return
            self.snmp_naechste = jetzt + SNMP_S
            quelle, block = "snmp", snmp_messen(nas_konfiguration()["host"])
        elif zugang == "zugang_ungueltig":
            quelle, block = "exporter", {"status": "nicht_eingerichtet", "grund": "zugang_ungueltig", "quelle": "exporter"}
        else:
            quelle = "exporter"
            block, volume, hinweis = self.exporter.messen(zugang)  # type: ignore[arg-type]
        self.hw_quelle = quelle
        kurz = f"{'SNMP' if quelle == 'snmp' else 'Exporter'} {block.get('status')}/{block.get('grund', '-')}"
        if hinweis and block.get("status") == "ok":
            kurz += f" (ohne {hinweis})"
        if kurz != self.hw_log:
            log.info("NAS-%s", kurz)
            self.hw_log = kurz
        self.setze(snmp=block, nas_hw_volume=volume)


class Sammler:
    def __init__(self) -> None:
        self.halt = threading.Event()
        self.langsam = Langsam(self.halt)
        self.speicher = Speicher()
        self.vorher: dict[str, Any] = {}
        self.drossel: deque[tuple[float, int]] = deque()
        self.cg_vorher: deque[tuple[float, int | None, int | None]] = deque()
        self.kerne, self.threads = cpu_aufbau()
        self.schreib_log: bool | None = None
        # Geladene KI-Modelle: CPU-Ticks je llama-server (PID, Startzeit) aus der letzten Messung, Blob → Modellname
        self.llama_vorher: dict[tuple[int, str], tuple[float, int]] = {}
        self.blob_karte: dict[str, list[str]] = {}
        self.blob_zeit = 0.0

    def ki_modelle(self, t: float, ziele: dict[str, dict[str, str]], ps: dict[str, Any]) -> list[dict[str, Any]] | None:
        """Je geladenem Modell beider Instanzen: Prozess (CPU im Mittel seit der letzten Messung, RSS, anonym) + /api/ps.
        Ohne bekannte Ollama-Container (Dienst-Abfrage noch nicht gelaufen): None."""
        if not ziele:
            return None
        prozesse = {inst: llama_prozesse(KI_SLICE / f"docker-{z['cid']}.scope") for inst, z in ziele.items() if z.get("cid")}
        cpu: dict[tuple[int, str], float] = {}
        vorher: dict[tuple[int, str], tuple[float, int]] = {}
        for p in (p for liste in prozesse.values() for p in liste):
            k = (p["pid"], p["start"])
            alt = self.llama_vorher.get(k)
            vorher[k] = (t, p["ticks"])
            if alt is not None and t > alt[0] and p["ticks"] >= alt[1]:
                cpu[k] = (p["ticks"] - alt[1]) / TICKS_S / (t - alt[0]) * 100
        self.llama_vorher = vorher
        blobs = {p["blob"] for liste in prozesse.values() for p in liste if p["blob"]}
        if t - self.blob_zeit > MANIFEST_NEU_S or (blobs - set(self.blob_karte) and t - self.blob_zeit > 60):
            self.blob_karte, self.blob_zeit = blob_namen(), t
        return ki_modelle_bauen(prozesse, ps or {}, self.blob_karte, cpu)

    # Zähler → Raten (je Sekunde) gegenüber der letzten Messung.
    def _rate(self, name: str, wert: int | None, t: float) -> float | None:
        alt = self.vorher.get(name)
        self.vorher[name] = (t, wert)
        if wert is None or alt is None or alt[1] is None or t <= alt[0] or wert < alt[1]:
            return None
        return (wert - alt[1]) / (t - alt[0])

    def messen(self) -> dict[str, Any]:
        t = time.time()
        geraete = hwmon_geraete()
        temps = cpu_temperaturen(geraete)

        z = cpu_zaehler()
        last = None
        if z is not None:
            alt = self.vorher.get("cpu")
            self.vorher["cpu"] = z
            if alt is not None and z[1] > alt[1]:
                last = max(0.0, min(100.0, (z[0] - alt[0]) / (z[1] - alt[1]) * 100))
        takt, takt_max = cpu_takt()

        drossel = drossel_zaehler()
        if drossel is not None:
            self.drossel.append((t, drossel))
            while self.drossel and self.drossel[0][0] < t - 70:
                self.drossel.popleft()
        gedrosselt = (self.drossel[-1][1] > self.drossel[0][1]) if len(self.drossel) >= 2 else False

        # Kernanteil (Kerne im Mittel der letzten Minute) des KI-Slices und — nur als Summe — von Trust one.
        self.cg_vorher.append((t, cgroup_cpu_usec(KI_SLICE), cgroup_cpu_usec(TO_SLICE)))
        while len(self.cg_vorher) > 2 and self.cg_vorher[1][0] <= t - 60:
            self.cg_vorher.popleft()
        anteil: dict[str, float] = {}
        if len(self.cg_vorher) >= 2:
            (t0, ki0, to0), (t1, ki1, to1) = self.cg_vorher[0], self.cg_vorher[-1]
            if t1 > t0:
                if ki0 is not None and ki1 is not None and ki1 >= ki0:
                    anteil["ki"] = round((ki1 - ki0) / 1e6 / (t1 - t0), 1)
                if to0 is not None and to1 is not None and to1 >= to0:
                    anteil["trustone"] = round((to1 - to0) / 1e6 / (t1 - t0), 1)

        gpu = gpu_messen()

        mi = meminfo()
        psi = psi_speicher()
        vm = vmstat_werte(VMSTAT_SWAP)
        swap_ein = self._rate("pswpin", vm.get("pswpin"), t)
        swap_aus = self._rate("pswpout", vm.get("pswpout"), t)
        ki = ki_slice_speicher()
        to = trustone_summe()

        langsam = self.langsam.bild()
        ki_modelle = self.ki_modelle(t, self.langsam.ollama, langsam.get("ki_ps") or {})
        # Trust one: nur die Summe (memory.stat anon der Slice); ohne Slice belegt Trust one nichts
        to_anon = memory_stat(TO_SLICE).get("anon") if TO_SLICE.is_dir() else 0
        platte = self.langsam.platte
        pz = platten_zaehler(platte)
        nz = netz_zaehler()
        lesen_bps = self._rate("platte_lesen", pz[0] if pz else None, t)
        schreiben_bps = self._rate("platte_schreiben", pz[1] if pz else None, t)
        rx_bps = self._rate("netz_rx", nz.get("netz_rx_b"), t)
        tx_bps = self._rate("netz_tx", nz.get("netz_tx_b"), t)

        swap_belegt = (mi["SwapTotal"] - mi["SwapFree"]) if "SwapTotal" in mi and "SwapFree" in mi else None
        ssd = langsam.get("ssd") or {"status": "nicht_verfuegbar"}
        kuehlung = kuehlung_block(lies(KUEHLUNG_STATUS, 16384), t, KUEHLUNG_EINGERICHTET.is_dir())
        link_rpm = [l["rpm"] for l in kuehlung.get("luefter") or [] if isinstance(l.get("rpm"), int)]
        self.speicher.neu(t, {
            "cpu_temp": temps["paket"], "cpu_last": last, "cpu_takt": takt,
            "gpu_temp": (gpu or {}).get("temp_c"), "gpu_last": (gpu or {}).get("last_prozent"),
            "gpu_vram": (gpu or {}).get("vram_belegt_mib"), "gpu_watt": (gpu or {}).get("watt"),
            "ram_verfuegbar_gb": mi["MemAvailable"] / GIB if "MemAvailable" in mi else None,
            "ram_ki_gb": ki["belegt_b"] / GIB if ki and "belegt_b" in ki else None,
            "ram_ki_fest_gb": ki["fest_b"] / GIB if ki and "fest_b" in ki else None,
            "ram_trustone_gb": to["summe_b"] / GIB if to and "summe_b" in to else None,
            "ram_swap_gb": swap_belegt / GIB if swap_belegt is not None else None,
            "ram_psi_full": psi.get("full"),
            "ram_swap_ein_bps": swap_ein * SEITE_B if swap_ein is not None else None,
            "ram_swap_aus_bps": swap_aus * SEITE_B if swap_aus is not None else None,
            "netz_rx_bps": rx_bps, "netz_tx_bps": tx_bps,
            "platte_lesen_bps": lesen_bps, "platte_schreiben_bps": schreiben_bps,
            "ssd_temp": ssd.get("temp_c"),
            "kuehlmittel_c": kuehlung.get("kuehlmittel_c"), "pumpe_rpm": kuehlung.get("pumpe_rpm"),
            "luefter_rpm": mittel(link_rpm),
        })
        sp = self.speicher

        minute: dict[str, float] = {}
        for k, quelle in MINUTE_MITTEL.items():
            v = sp.mittel(quelle, 60, t)
            if v is not None:
                minute[k] = round(v, 2) if k.endswith("_gb") else int(round(v)) if k.endswith("_rpm") else round(v, 1)
        for k, quelle in MINUTE_MAX.items():
            v = sp.maximum(quelle, 60, t)
            if v is not None:
                minute[k] = round(v, 1)

        modul_temps = modul_temperaturen(geraete)
        module = [ohne_none({**m, "temp_c": zahl(modul_temps.get(m["platz"]), 0)})
                  for m in (langsam.get("module") or [])]

        cpu = ohne_none({
            "temp_c": zahl(temps["paket"], 0),
            "temp_c_5min": zahl(sp.mittel("cpu_temp", 300, t), 1),
            "temp_c_max_1min": zahl(sp.maximum("cpu_temp", 60, t), 0),
            "kerne_temp_c": [zahl(min(temps["kerne"]), 0), zahl(max(temps["kerne"]), 0)] if temps["kerne"] else None,
            "chipsatz_temp_c": zahl(temps["chipsatz"], 0),
            "last_prozent": zahl(last, 0),
            "last_prozent_5min": zahl(sp.mittel("cpu_last", 300, t), 0),
            "last_prozent_10min": zahl(sp.mittel("cpu_last", 600, t), 0),
            "takt_mhz": zahl(takt, 0), "takt_mhz_max_kern": zahl(takt_max, 0),
            "kerne": self.kerne, "threads": self.threads or None,
            "drosselung": gedrosselt if drossel is not None else None,
            "luefter_rpm": kuehlung_luefter_rpm(kuehlung) or luefter(geraete),
            "anteil_kerne": anteil or None,
        })
        gpu_block = None
        if gpu:
            gpu_block = ohne_none({
                **{k: zahl(v, 1) if k in ("watt", "watt_grenze") else zahl(v, 0) if isinstance(v, float) else v
                   for k, v in gpu.items()},
                "temp_c_max_1min": zahl(sp.maximum("gpu_temp", 60, t), 0),
            })
        ram = ohne_none({
            "eingebaut_gb": zahl(sum(m["groesse_gb"] for m in module), 0) if module else None,
            "module": module or None,
            "gesamt_b": mi.get("MemTotal"), "verfuegbar_b": mi.get("MemAvailable"), "frei_b": mi.get("MemFree"),
            "swap_gesamt_b": mi.get("SwapTotal"), "swap_belegt_b": swap_belegt,
            "psi_full_avg10": psi.get("full"), "psi_some_avg10": psi.get("some"),
            # aktives Ein-/Auslagern (Bytes/s), 5-Minuten-Mittel — bewertet die Ampel «Ein- und Auslagern»
            "swap_ein_bps_5min": zahl(sp.mittel("ram_swap_ein_bps", 300, t), 0),
            "swap_aus_bps_5min": zahl(sp.mittel("ram_swap_aus_bps", 300, t), 0),
            "ki": ki or None, "trustone": to,
            # Wer belegt den Arbeitsspeicher: KI-Modelle, übriger KI-Bereich, Trust one (Summe), System, verfügbar
            "belegung": ram_belegung(mi, ki, to_anon, ki_modelle or []),
        })
        platten = ohne_none({"system": langsam.get("system"), "tresor": langsam.get("tresor"), "ssd": ohne_none(ssd)})
        io = ohne_none({"gelesen_b": pz[0] if pz else None, "geschrieben_b": pz[1] if pz else None, **nz})
        uptime = (lies("/proc/uptime", 64) or "").split()
        rig = ohne_none({
            "gemessen_am": jetzt_iso(t),
            "uptime_s": int(float(uptime[0])) if uptime else None,
            "cpu": cpu or None, "gpu": gpu_block, "ram": ram or None, "platten": platten or None, "io": io or None,
            "kuehlung": kuehlung,
            "dienste": langsam.get("dienste"),
            # Geladene KI-Modelle beider Instanzen mit Rechenlast und Speicher (leer = keines geladen)
            "ki_modelle": ki_modelle,
            "leistung": langsam.get("leistung"),
            "minute": minute or None,
        })
        ergebnis: dict[str, Any] = {"rig": rig}
        nas = langsam.get("nas")
        if nas:
            ergebnis["nas"] = {**nas, "snmp": langsam.get("snmp") or {"status": "nicht_eingerichtet"}}
            if ergebnis["nas"].get("volume") is None and langsam.get("nas_hw_volume"):
                ergebnis["nas"]["volume"] = langsam["nas_hw_volume"]  # Freigabe nicht lesbar → Volume vom Exporter
        return ergebnis

    def schreiben(self, daten: dict[str, Any]) -> bool:
        """Atomar: stand.json.tmp im selben Ordner, fsync, os.replace. Ohne eingehängten Tresor nichts."""
        if not ist_eingehaengt(TRESOR):
            self._schreib_log(False, "Tresor nicht eingehängt — nichts geschrieben")
            return False
        try:
            if not AUSGABE_ORDNER.is_dir():
                AUSGABE_ORDNER.mkdir(mode=0o750)
                os.chown(AUSGABE_ORDNER, 0, DIENST_GID)
            tmp = AUSGABE_ORDNER / "stand.json.tmp"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
            try:
                os.fchown(fd, 0, DIENST_GID)
                os.fchmod(fd, 0o640)
                os.write(fd, json.dumps(daten, separators=(",", ":"), ensure_ascii=False).encode())
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(tmp, AUSGABE)
        except OSError as e:
            self._schreib_log(False, f"Schreiben gescheitert ({type(e).__name__})")
            return False
        self._schreib_log(True, "schreibt Messwerte")
        return True

    def _schreib_log(self, ok: bool, text: str) -> None:
        if self.schreib_log is not ok:
            (log.info if ok else log.warning)("%s", text)
            self.schreib_log = ok

    def lauf(self, einmal: bool = False) -> None:
        signal.signal(signal.SIGTERM, lambda *_: self.halt.set())
        signal.signal(signal.SIGINT, lambda *_: self.halt.set())
        if einmal:
            self.langsam.runde()
            self.messen()
            time.sleep(1.0)
            self.schreiben(self.messen())
            return
        self.langsam.start()
        log.info("Technik-Sammler gestartet (Takt %d s)", TAKT_S)
        # Erste Datei erst mit Diensten, Platten, SSD und NAS (sonst fehlen sie im ersten Paket); höchstens 20 s.
        self.messen()  # Grundlage für Raten und Last
        self.langsam.erste_runde.wait(20.0)
        naechste = time.monotonic()
        while not self.halt.is_set():
            if not ist_eingehaengt(TRESOR):
                # Tresor auf dem Host ausgehängt: beenden, damit der eigene Mount-Namespace ihn nicht festhält
                # (sonst scheitert «cryptsetup close»). Wieder an geht der Sammler mit dem Tresor
                # (Unit: BindsTo/WantedBy eventline-ki-vault.service, ConditionPathIsMountPoint).
                log.warning("Tresor nicht eingehängt — Sammler beendet sich")
                break
            try:
                self.schreiben(self.messen())
            except Exception as e:  # noqa: BLE001 — der Takt läuft weiter
                log.warning("Messung gescheitert (%s)", type(e).__name__)
            naechste += TAKT_S
            warte = naechste - time.monotonic()
            if warte < 0:
                naechste = time.monotonic()
                warte = 0
            self.halt.wait(warte)
        log.info("Technik-Sammler beendet")


def main(argv: list[str]) -> int:
    if "--nas-probe" in argv:
        return nas_probe_kind()
    if "--exporter-probe" in argv:
        return exporter_probe_kind()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if os.geteuid() != 0:
        log.error("braucht root (smartctl, dmidecode, Tresor)")
        return 1
    Sammler().lauf(einmal="--einmal" in argv)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
