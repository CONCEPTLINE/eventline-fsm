"""Technik-Dashboard (docs/technik-dashboard/VERTRAG.md §1–§2): Melder im Dienst (app/technik.py) und die reinen
Teile des Host-Sammlers (messung/technik_sammler.py). Ohne Netz, ohne Rig — das FSM und Ollama sind gestellt.

  docker run --rm --network none -v <repo>/rig/eventline-ki:/t:ro -w /t/dienst eventline-ki/dienst:local python tests/test_technik.py

Mit nur dienst/ eingebunden (-v …/dienst:/t) fehlen die Sammler-Tests (übersprungen), der Rest läuft.
"""

from __future__ import annotations

import base64
import dataclasses
import http.server
import importlib.util
import json
import os
import re
import socket
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402

from app import llm  # noqa: E402
from app.config import laden  # noqa: E402
from app.technik import (  # noqa: E402
    MAX_PAKET_B, TechnikMelder, als_zeit, grenzen_aus, ki_block, kodieren, lies_sammler, ollama_auswerten,
    paket_bauen, zu_utc,
)

CFG = dataclasses.replace(laden(), sync_token="geheim-test", fsm_url="https://fsm.test", proxy=None,
                          ollama_url="http://ollama:11434", hg_url="http://ollama-gruendlich:11434")
JETZT = datetime(2026, 10, 12, 5, 53, 10, tzinfo=timezone.utc)

SAMMLER_PFAD = Path(__file__).resolve().parents[2] / "messung" / "technik_sammler.py"
sammler = None
if SAMMLER_PFAD.exists():
    _spec = importlib.util.spec_from_file_location("technik_sammler", SAMMLER_PFAD)
    sammler = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
    _spec.loader.exec_module(sammler)  # type: ignore[union-attr]

GESUNDHEIT = {
    "ok": True, "warteschlange": 0, "laeuft": None,
    "archiv": {"aktiv": True, "anzahl": 165, "letzter_lauf": "2026-10-12T07:51:43+02:00", "laeuft": False,
               "letzte_bilanz": {"neu": 0, "fehler": 0, "dauer_s": 2.14}},
    "tiefe": {"aktiv": True, "dateien": 449, "nas_dateien": 449, "mit_text": 395, "abschnitte": 2309,
              "letzter_lauf": "2026-10-11T22:25:45+02:00", "nacht": {"fertig": True}},
    "hintergrund": {"aktiv": False},
}


def _datei(inhalt: object) -> Path:
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    f.write(inhalt if isinstance(inhalt, str) else json.dumps(inhalt))
    f.close()
    return Path(f.name)


# --- Zeiten -------------------------------------------------------------------------------------------------------


def test_zeiten_mit_zone_und_nanosekunden():
    assert zu_utc("2026-10-12T07:51:43+02:00") == "2026-10-12T05:51:43Z"
    assert zu_utc("2026-10-12T19:00:00.123456789+02:00") == "2026-10-12T17:00:00Z"
    assert zu_utc("2026-10-12T05:00:00Z") == "2026-10-12T05:00:00Z"
    assert zu_utc("2026-10-12T05:00:00") is None, "ohne Zone keine Annahme"
    assert zu_utc(None) is None and zu_utc("gestern") is None
    assert als_zeit("2026-10-12T05:00:00+0200") == datetime(2026, 10, 12, 3, 0, tzinfo=timezone.utc)


# --- Sammler-Datei ----------------------------------------------------------------------------------------------------


def test_sammler_datei_fehlt_kaputt_alt_frisch():
    assert lies_sammler(Path("/gibt/es/nicht.json"), JETZT) == {}
    assert lies_sammler(_datei("{kaputt"), JETZT) == {}
    assert lies_sammler(_datei([1, 2]), JETZT) == {}
    frisch = {"rig": {"gemessen_am": "2026-10-12T05:53:04Z", "uptime_s": 1},
              "nas": {"gemessen_am": "2026-10-12T05:30:00Z", "erreichbar": True}}
    d = lies_sammler(_datei(frisch), JETZT)
    assert d["rig"]["uptime_s"] == 1
    assert "nas" not in d, "NAS-Stand älter als 15 min wird nicht nachgeschoben"
    assert lies_sammler(_datei({"rig": {"uptime_s": 1}}), JETZT) == {}, "ohne gemessen_am kein Block"


def test_sammler_datei_zu_gross():
    assert lies_sammler(_datei({"rig": {"gemessen_am": "2026-10-12T05:53:04Z", "x": "a" * 300_000}}), JETZT) == {}


# --- Ollama -------------------------------------------------------------------------------------------------------


def test_ollama_auswerten_filtert_und_rechnet():
    tags = {"models": [{"name": "gemma3:4b", "size": 3_300_000_000}, {"name": "<script>", "size": 1},
                       {"name": "bge-m3:latest", "size": "viel"}]}
    ps = {"models": [
        {"name": "gemma3:4b", "size": 4_000_000_000, "size_vram": 3_900_000_000,
         "expires_at": "2026-10-12T08:00:00.5+02:00"},
        {"name": "gemma4:26b-a4b-it-qat", "size": 17_000_000_000, "size_vram": 0,
         "expires_at": "2318-01-01T00:00:00Z"},
    ]}
    o = ollama_auswerten("schnell", {"version": "0.35.1"}, tags, ps, JETZT)
    assert o["instanz"] == {"name": "schnell", "erreichbar": True, "version": "0.35.1"}
    assert o["modelle"] == [{"name": "gemma3:4b", "groesse_b": 3_300_000_000}]
    assert o["geladen"][0]["entlaedt_am"] == "2026-10-12T06:00:00Z"
    assert "entlaedt_am" not in o["geladen"][1], "keep_alive -1 ist kein Zeitpunkt"
    weg = ollama_auswerten("gruendlich", None, None, None, JETZT)
    assert weg == {"instanz": {"name": "gruendlich", "erreichbar": False}, "modelle": [], "geladen": []}
    assert ollama_auswerten("schnell", {"version": "x y z"}, [], "kaputt", JETZT)["instanz"] == {
        "name": "schnell", "erreichbar": True}


# --- Block ki und Paket -------------------------------------------------------------------------------------------


def test_ki_block_aus_gesundheit():
    o = [ollama_auswerten("schnell", {"version": "0.35.1"}, {"models": [{"name": "gemma3:4b", "size": 5}]}, {}, JETZT),
         ollama_auswerten("gruendlich", {"version": "0.35.1"}, {"models": [{"name": "gemma3:4b", "size": 5}]}, {}, JETZT)]
    ki = ki_block(CFG, GESUNDHEIT, o, auftrag={"art": "ablage_analyse", "seit": "2026-10-12T05:52:00Z"},
                  tempo={"tokens_s": 61.2, "modell": "gemma3:4b", "am": "2026-10-12T05:52:30Z"},
                  fsm_antwort_ms=210, fsm_fehler_in_folge=0, grenzen={"schnell": 12884901888})
    assert ki["version"].startswith("0.1.0+")
    assert ki["modelle"] == [{"name": "gemma3:4b", "groesse_b": 5}], "doppelte Modelle nur einmal"
    assert ki["instanzen"][0]["grenze_b"] == 12884901888 and "grenze_b" not in ki["instanzen"][1]
    assert ki["archiv"] == {"anzahl": 165, "letzter_lauf": "2026-10-12T05:51:43Z", "neu": 0, "fehler": 0, "dauer_s": 2.1}
    assert ki["tiefen_index"]["letzter_lauf"] == "2026-10-11T20:25:45Z" and ki["tiefen_index"]["nacht_fertig"] is True
    assert ki["warteschlange"] == 0 and ki["hauptmodell_geladen"] is False
    assert set(ki["schalter"]) == {"suche", "archiv_frage", "hintergrund", "lernen", "tiefe", "hauptmodell"}
    assert all(isinstance(v, bool) for v in ki["schalter"].values())
    leer = ki_block(CFG, {}, [], auftrag=None, tempo=None, fsm_antwort_ms=None, fsm_fehler_in_folge=3)
    assert "archiv" not in leer and "tiefen_index" not in leer and leer["fsm_fehler_in_folge"] == 3


def test_grenzen_aus_diensten():
    rig = {"dienste": [{"name": "ollama_schnell", "grenze_b": 1}, {"name": "ki_dienst", "grenze_b": 2},
                       {"name": "ollama_gruendlich", "grenze_b": None}, "kaputt"]}
    assert grenzen_aus(rig) == {"schnell": 1}
    assert grenzen_aus(None) == {}


def test_paket_und_groesse():
    p = paket_bauen({"rig": {"gemessen_am": "x"}}, {"version": "1"}, JETZT)
    assert p == {"v": 1, "gesendet_am": "2026-10-12T05:53:10Z", "rig": {"gemessen_am": "x"}, "ki": {"version": "1"}}
    gross = paket_bauen({"rig": {"gemessen_am": "x", "minute": {f"k{i}": i for i in range(9000)}}},
                        {"modelle": [{"name": f"m{i}", "groesse_b": i} for i in range(3000)]}, JETZT)
    roh = kodieren(gross)
    assert len(roh) <= MAX_PAKET_B
    assert json.loads(roh)["rig"]["gemessen_am"] == "x"


# --- Senden -------------------------------------------------------------------------------------------------------


def _melder(fsm_antwort, datei: Path | None = None) -> tuple[TechnikMelder, list[httpx.Request]]:
    cfg = dataclasses.replace(CFG, technik_datei=datei or Path("/gibt/es/nicht.json"))
    m = TechnikMelder(cfg, lambda: None, lambda: GESUNDHEIT)
    gesendet: list[httpx.Request] = []

    def fsm(request: httpx.Request) -> httpx.Response:
        gesendet.append(request)
        return fsm_antwort(request)

    def ollama(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET" and request.url.path in ("/api/version", "/api/tags", "/api/ps"), \
            "nie etwas, das ein Modell lädt"
        daten = {"/api/version": {"version": "0.35.1"}, "/api/tags": {"models": []}, "/api/ps": {"models": []}}
        return httpx.Response(200, json=daten[request.url.path])

    m._fsm.close()
    m._ollama.close()
    m._fsm = httpx.Client(base_url=cfg.fsm_url, transport=httpx.MockTransport(fsm), headers=m._fsm.headers)
    m._ollama = httpx.Client(transport=httpx.MockTransport(ollama))
    return m, gesendet


def test_senden_ok_misst_antwortzeit():
    jetzt = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    datei = _datei({"rig": {"gemessen_am": jetzt, "dienste": [{"name": "ollama_schnell", "grenze_b": 7}]},
                    "nas": {"gemessen_am": jetzt, "erreichbar": True, "snmp": {"status": "nicht_eingerichtet"}}})
    m, gesendet = _melder(lambda r: httpx.Response(200, json={"success": True}), datei)
    assert m.einmal() == 200
    r = gesendet[0]
    assert r.method == "POST" and r.url.path == "/api/technik/messwerte"
    assert r.headers["authorization"] == "Bearer geheim-test"
    assert r.headers["user-agent"].startswith("eventline-ki/")
    p = json.loads(r.content)
    assert p["v"] == 1 and set(p) == {"v", "gesendet_am", "rig", "ki", "nas"}
    assert p["ki"]["instanzen"][0] == {"name": "schnell", "erreichbar": True, "version": "0.35.1", "grenze_b": 7}
    assert p["ki"]["fsm_antwort_ms"] is None, "Laufzeit erst im nächsten Paket"
    assert m.fsm_antwort_ms is not None and m.fsm_fehler_in_folge == 0
    m.einmal()
    assert isinstance(json.loads(gesendet[1].content)["ki"]["fsm_antwort_ms"], int)
    m.schliessen()


def test_senden_route_fehlt_still_und_fehler_zaehlen():
    m, _ = _melder(lambda r: httpx.Response(404))
    assert m.einmal() == 404 and m.fsm_fehler_in_folge == 0
    zustand = m._letzter_zustand
    m.einmal()
    assert m._letzter_zustand == zustand, "kein neuer Logeintrag bei gleichem Zustand"
    m2, _ = _melder(lambda r: httpx.Response(503))
    m2.einmal()
    m2.einmal()
    assert m2.fsm_fehler_in_folge == 2 and m2.fsm_antwort_ms is None

    def netzfehler(r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("weg")

    m3, _ = _melder(netzfehler)
    assert m3.einmal() is None and m3.fsm_fehler_in_folge == 1
    for x in (m, m2, m3):
        x.schliessen()


def test_auftrag_seit_bleibt_stehen():
    art = {"wert": None}
    m = TechnikMelder(CFG, lambda: art["wert"], lambda: {})
    m._auftrag_verfolgen()
    assert m._auftrag is None
    art["wert"] = "diktat"
    m._auftrag_verfolgen()
    seit = m._auftrag
    time.sleep(1.1)
    m._auftrag_verfolgen()
    assert m._auftrag == seit, "seit = Beginn, nicht letzte Abtastung"
    art["wert"] = None
    m._auftrag_verfolgen()
    assert m._auftrag is None
    m.schliessen()


def test_tempo_merken():
    llm.merke_tempo("gemma3:4b", 120, 2_000_000_000)
    t = llm.letztes_tempo()
    assert t is not None and t["tokens_s"] == 60.0 and t["modell"] == "gemma3:4b" and t["am"].endswith("Z")
    llm.merke_tempo("gemma3:4b", 3, 1_000_000)  # zu kurz → bleibt beim alten Wert
    llm.merke_tempo("gemma3:4b", None, None)
    assert llm.letztes_tempo()["tokens_s"] == 60.0


# --- Sammler (Host), reine Teile ------------------------------------------------------------------------------------


def _ohne_sammler() -> bool:
    if sammler is None:
        print("        (Sammler nicht eingebunden — übersprungen)")
        return True
    return False


def test_sammler_snmp_auswerten():
    if _ohne_sammler():
        return
    s = sammler
    skalare = {s.OID_HR_UPTIME: "123456", s.OID_SS_CPU_IDLE: "90",
               s.OID_MEM["total"]: "8000000", s.OID_MEM["frei"]: "1000000", s.OID_MEM["puffer"]: "500000",
               s.OID_MEM["cache"]: "2500000"}
    temps = {f"{s.OID_LM_TEMP}.2.1": "coretemp Package id 0", f"{s.OID_LM_TEMP}.3.1": "52000",
             f"{s.OID_LM_TEMP}.2.2": "acpitz-1", f"{s.OID_LM_TEMP}.3.2": "41000",
             f"{s.OID_LM_TEMP}.2.3": "drivetemp-scsi-0-0", f"{s.OID_LM_TEMP}.3.3": "36000",
             f"{s.OID_LM_TEMP}.2.4": "drivetemp-scsi-1-0", f"{s.OID_LM_TEMP}.3.4": "39000",
             f"{s.OID_LM_TEMP}.2.5": "kaputt", f"{s.OID_LM_TEMP}.3.5": "999999"}
    geraete = {f"{s.OID_HR_GERAETE}.2.10": s.TYP_PLATTE, f"{s.OID_HR_GERAETE}.3.10": "SCSI disk", f"{s.OID_HR_GERAETE}.5.10": "2",
               f"{s.OID_HR_GERAETE}.2.11": s.TYP_PLATTE, f"{s.OID_HR_GERAETE}.3.11": "SCSI disk", f"{s.OID_HR_GERAETE}.5.11": "3",
               f"{s.OID_HR_GERAETE}.2.12": ".1.3.6.1.2.1.25.3.1.1", f"{s.OID_HR_GERAETE}.3.12": "md0 raid1", f"{s.OID_HR_GERAETE}.5.12": "2"}
    e = s.snmp_auswerten(skalare, {f"{s.OID_HR_PROZESSOR}.196608": "20", f"{s.OID_HR_PROZESSOR}.196609": "40"}, geraete, temps)
    assert e["uptime_s"] == 1234 and e["last_prozent"] == 30 and e["ram_prozent"] == 50
    assert e["cpu_temp_c"] == 52 and e["system_temp_c"] == 41
    assert e["platten"] == [{"schacht": 1, "temp_c": 36, "gesundheit": "ok"},
                            {"schacht": 2, "temp_c": 39, "gesundheit": "warnung"}]
    assert e["raid"] == "normal"
    leer = s.snmp_auswerten({s.OID_SYS_UPTIME: "No Such Object available on this agent at this OID"}, {}, {}, {})
    assert leer == {}, "fehlende OIDs fehlen im Paket"
    assert "kaputt" not in json.dumps(e) and "drivetemp" not in json.dumps(e), "keine Namen ins Paket"


def test_sammler_snmp_ruht_ohne_zugang():
    if _ohne_sammler():
        return
    assert sammler.snmp_messen("nas.test") == {"status": "nicht_eingerichtet"} or os.geteuid() == 0
    assert sammler.snmp_grund(None, "zeitlimit") == "zeitlimit"
    assert sammler.snmp_grund(1, "snmpget: Authentication failure (incorrect password)") == "anmeldung"
    assert sammler.snmp_grund(1, "Timeout: No Response from udp") == "keine_antwort"
    assert sammler.snmp_grund(None, "werkzeug_fehlt") == "werkzeug_fehlt"


def test_sammler_snmp_zugang_pruefen_nennt_nur_feld():
    if _ohne_sammler():
        return
    gut = {"NAS_SNMP_BENUTZER": "leser", "NAS_SNMP_AUTH_PROTOKOLL": "sha", "NAS_SNMP_AUTH_PASSWORT": "geheim-123",
           "NAS_SNMP_PRIV_PROTOKOLL": "AES", "NAS_SNMP_PRIV_PASSWORT": "geheim-456"}
    assert sammler.snmp_pruefen(gut) is None
    fall = {
        "NAS_SNMP_BENUTZER": ("", "NAS_SNMP_BENUTZER fehlt"),
        "NAS_SNMP_AUTH_PASSWORT": ("ab#cdefgh", "NAS_SNMP_AUTH_PASSWORT enthält"),
        "NAS_SNMP_PRIV_PASSWORT": ("kurz", "NAS_SNMP_PRIV_PASSWORT kürzer"),
        "NAS_SNMP_AUTH_PROTOKOLL": ("SHA1", "NAS_SNMP_AUTH_PROTOKOLL unbekannt"),
    }
    for feld, (wert, grund) in fall.items():
        g = sammler.snmp_pruefen({**gut, feld: wert})
        assert g and g.startswith(grund), (feld, g)
        assert not wert or wert not in g, "nie Werte im Grund"


def test_sammler_werkzeugsperre_haengt_nicht_nach():
    if _ohne_sammler():
        return
    sp = sammler.Werkzeugsperre("Test")
    t0 = time.monotonic()
    rc, _, grund = sammler.befehl(["sleep", "5"], 0.2, sperre=sp)
    assert rc is None and grund == "zeitlimit"
    assert sp.gesperrt(), "nach Zeitlimit ruht das Werkzeug"
    rc, _, grund = sammler.befehl(["sleep", "5"], 0.2, sperre=sp)
    assert rc is None and grund == "gesperrt", "kein neuer Prozess, solange gesperrt"
    assert time.monotonic() - t0 < 4.0
    sp.ruht_bis = 0.0
    assert not sp.gesperrt(), "ohne hängenden Prozess und nach der Ruhe wieder frei"
    rc, aus, _ = sammler.befehl(["echo", "ok"], 2.0, sperre=sp)
    assert rc == 0 and aus.strip() == "ok"


def test_sammler_oom_nur_frisch():
    if _ohne_sammler():
        return
    o = sammler.OomMerker()
    assert o.neu("a", 3, 1000.0) is False, "Altlast beim Start ist kein neuer Speichermangel"
    assert o.neu("a", 3, 1010.0) is False
    assert o.neu("a", 4, 1020.0) is True
    assert o.neu("a", 4, 1020.0 + sammler.OOM_FENSTER_S - 1) is True
    assert o.neu("a", 4, 1020.0 + sammler.OOM_FENSTER_S + 1) is False


def test_sammler_speicher_und_minute():
    if _ohne_sammler():
        return
    sp = sammler.Speicher()
    for i in range(70):
        sp.neu(1000.0 + i * 10, {"cpu_temp": 60 + (i % 2) * 10, "gpu_temp": None})
    t = 1000.0 + 69 * 10
    assert len(sp.punkte) <= 61
    assert sp.maximum("cpu_temp", 60, t) == 70 and 60 < sp.mittel("cpu_temp", 300, t) < 70
    assert sp.mittel("gpu_temp", 60, t) is None


def test_sammler_zeit_und_freigaben_ohne_namen():
    if _ohne_sammler():
        return
    assert sammler._zeit_iso("2026-10-12T05:50:00.123456789Z") == "2026-10-12T05:50:00Z"
    assert sammler._zeit_iso("0001-01-01T00:00:00Z") is None
    fr = sammler.freigaben_ist({"host": None, "lesend": {"a", "b"}, "schreibend": {"c"}})
    assert fr["soll"] == 3 and fr["ist"] == 0 and fr["pfad"] is None
    assert sammler.freigaben_ist({"host": None, "lesend": None, "schreibend": None})["soll"] is None


# --- NAS-Hardware über die Mess-Container (Exporter, VERTRAG.md §1.4) --------------------------------------------------
# Beispieldaten im Prometheus-Textformat, nachgebaut aus echten Ausgaben von node_exporter 1.12.1 und
# smartctl_exporter 0.15.0 (Probelauf am Rig 13.10.) und ergänzt um das, was ein NAS hat (md-Verbund, /volume1,
# Super-I/O-Fühler, 10-GbE-Karte, NVMe-Systemplatte). Modelle/Seriennummern sind erfunden.

def _md(zustand: str = "active", aktiv: int = 2, ausgefallen: int = 0, degradiert: int = 0, geraet: str = "md1") -> str:
    zeilen = [f'node_md_degraded{{device="{geraet}"}} {degradiert}',
              f'node_md_disks{{device="{geraet}",state="active"}} {aktiv}',
              f'node_md_disks{{device="{geraet}",state="failed"}} {ausgefallen}',
              f'node_md_disks{{device="{geraet}",state="spare"}} 0',
              f'node_md_disks_required{{device="{geraet}"}} 2']
    for z in ("active", "check", "inactive", "recovering", "resync"):
        zeilen.append(f'node_md_state{{device="{geraet}",state="{z}"}} {1 if z == zustand else 0}')
    return "\n".join(zeilen) + "\n"


VOL = 'device="/dev/mapper/ug_7F3A21_1700000000_pool1-volume1",device_error="",fstype="ext4",mountpoint="/volume1"'
NODE_KOPF = f"""\
# HELP node_boot_time_seconds Node boot time, in unixtime.
# TYPE node_boot_time_seconds gauge
node_boot_time_seconds 1.7601e+09
# HELP node_cpu_seconds_total Seconds the CPUs spent in each mode.
# TYPE node_cpu_seconds_total counter
node_cpu_seconds_total{{cpu="0",mode="idle"}} 9000
node_cpu_seconds_total{{cpu="0",mode="iowait"}} 100
node_cpu_seconds_total{{cpu="0",mode="irq"}} 0
node_cpu_seconds_total{{cpu="0",mode="system"}} 300
node_cpu_seconds_total{{cpu="0",mode="user"}} 600
node_cpu_seconds_total{{cpu="1",mode="idle"}} 9200
node_cpu_seconds_total{{cpu="1",mode="iowait"}} 50
node_cpu_seconds_total{{cpu="1",mode="system"}} 250
node_cpu_seconds_total{{cpu="1",mode="user"}} 500
# HELP node_filesystem_size_bytes Filesystem size in bytes.
# TYPE node_filesystem_size_bytes gauge
node_filesystem_device_error{{{VOL}}} 0
node_filesystem_free_bytes{{{VOL}}} 7.436031677184e+12
node_filesystem_size_bytes{{{VOL}}} 7.968531677184e+12
node_memory_MemAvailable_bytes 6e+09
node_memory_MemTotal_bytes 8e+09
"""
NODE_TEMPS = """\
node_hwmon_chip_names{chip="nvme_nvme0",chip_name="nvme"} 1
node_hwmon_chip_names{chip="platform_coretemp_0",chip_name="coretemp"} 1
node_hwmon_chip_names{chip="platform_it87_2608",chip_name="it8613"} 1
node_hwmon_chip_names{chip="thermal_thermal_zone0",chip_name="acpitz"} 1
node_hwmon_chip_names{chip="pci0000:00_0000:00:1c_4_0000:03:00_0",chip_name="atlantic"} 1
node_hwmon_sensor_label{chip="nvme_nvme0",label="Composite",sensor="temp1"} 1
node_hwmon_sensor_label{chip="platform_coretemp_0",label="Package id 0",sensor="temp1"} 1
node_hwmon_sensor_label{chip="platform_coretemp_0",label="Core 0",sensor="temp2"} 1
node_hwmon_sensor_label{chip="platform_coretemp_0",label="Core 1",sensor="temp3"} 1
node_hwmon_temp_celsius{chip="nvme_nvme0",sensor="temp1"} 61.85
node_hwmon_temp_celsius{chip="pci0000:00_0000:00:1c_4_0000:03:00_0",sensor="temp1"} 71
node_hwmon_temp_celsius{chip="platform_coretemp_0",sensor="temp1"} 52
node_hwmon_temp_celsius{chip="platform_coretemp_0",sensor="temp2"} 50
node_hwmon_temp_celsius{chip="platform_coretemp_0",sensor="temp3"} 49
node_hwmon_temp_celsius{chip="platform_it87_2608",sensor="temp1"} 38
node_hwmon_temp_celsius{chip="platform_it87_2608",sensor="temp2"} 127
node_hwmon_temp_celsius{chip="platform_it87_2608",sensor="temp3"} -128
node_hwmon_temp_celsius{chip="thermal_thermal_zone0",sensor="temp1"} 27.8
node_hwmon_temp_max_celsius{chip="platform_coretemp_0",sensor="temp1"} 100
"""
NODE_TEXT = NODE_KOPF + NODE_TEMPS + _md()


def _smart(geraet: str, modell: str, serie: str, status: int | None, exit_code: int, temp: float | None,
           stunden: int | None, roh: dict[int, float], protokoll: str = "ATA") -> str:
    zeilen = [f'smartctl_device{{ata_additional_product_id="unknown",ata_version="ACS-3",device="{geraet}",'
              f'firmware_version="SC60",form_factor="3.5 inches",interface="sat",model_family="Familie {modell}",'
              f'model_name="{modell}",protocol="{protokoll}",sata_version="SATA 3.3",scsi_product="",scsi_revision="",'
              f'scsi_vendor="",scsi_version="",serial_number="{serie}"}} 1',
              f'smartctl_device_smartctl_exit_status{{device="{geraet}"}} {exit_code}',
              f'smartctl_device_critical_warning{{device="{geraet}"}} 0',
              f'smartctl_device_media_errors{{device="{geraet}"}} 0']
    if status is not None:
        zeilen.append(f'smartctl_device_smart_status{{device="{geraet}"}} {status}')
    if temp is not None:
        zeilen.append(f'smartctl_device_temperature{{device="{geraet}",temperature_type="current"}} {temp}')
        zeilen.append(f'smartctl_device_temperature{{device="{geraet}",temperature_type="lifetime_max"}} 58')
    if stunden is not None:
        zeilen.append(f'smartctl_device_power_on_seconds{{device="{geraet}"}} {stunden * 3600:e}')
    namen = {5: "Reallocated_Sector_Ct", 9: "Power_On_Hours", 194: "Temperature_Celsius", 197: "Current_Pending_Sector",
             198: "Offline_Uncorrectable", 199: "UDMA_CRC_Error_Count"}
    for nr, wert in roh.items():
        for art, w in (("value", 100), ("worst", 100), ("thresh", 10), ("raw", wert)):
            zeilen.append(f'smartctl_device_attribute{{attribute_flags_long="prefailure,updated_online",'
                          f'attribute_flags_short="PO----",attribute_id="{nr}",attribute_name="{namen[nr]}",'
                          f'attribute_value_type="{art}",device="{geraet}"}} {w}')
    return "\n".join(zeilen) + "\n"


SMART_KOPF = "# HELP smartctl_device Device info\n# TYPE smartctl_device gauge\nsmartctl_devices 5\n"
SMART_SDA = _smart("sda", "ST4000VN006-3CW104", "ZW60ABCD", 1, 0, 34, 12000,
                   {5: 0, 9: 12000, 194: 185757286434, 197: 0, 198: 0, 199: 0})
SMART_SDB = _smart("sdb", "WD40EFPX-68C6CN0", "WD-WX12A3456789", 1, 0, 38, 9000, {5: 8, 197: 0})
SMART_SDC = _smart("sdc", "ST4000VN006-3CW104", "ZW60EFGH", 1, 64, None, 100, {5: 0})  # liefert keine Temperatur
SMART_SDD = _smart("sdd", "ST4000VN006-3CW104", "ZW60IJKL", 0, 8, 45, None, {5: 1200, 197: 16})
SMART_NVME = _smart("nvme0", "UGREEN-SYS-128G", "SN0001", 1, 0, 41, 300, {}, protokoll="NVMe")
SMART_TEXT = SMART_KOPF + SMART_SDA + SMART_SDB + SMART_SDC + SMART_SDD + SMART_NVME


def test_sammler_prom_parsen():
    if _ohne_sammler():
        return
    text = ('# HELP x Hilfe\n# TYPE x gauge\nx 1\nx{a="b"} 2.5 1700000000000\n'
            'x{a="mit \\"Zitat\\" und \\\\ und \\n",b="}{,=",} 3\n'
            'x{kaputt} 4\nx{a="b"} NaN\nx{a="c"} +Inf\nx{a="d"} -1e-3\ny{a="b"} 5\nkeine zahl\n\n  \n')
    f = sammler.prom_parsen(text, frozenset({"x"}))
    assert set(f) == {"x"}, "nur verlangte Familien"
    assert f["x"][0] == ({}, 1.0) and f["x"][1] == ({"a": "b"}, 2.5), "Zeitstempel wird ignoriert"
    assert f["x"][2] == ({"a": 'mit "Zitat" und \\ und \n', "b": "}{,="}, 3.0)
    assert [w for _, w in f["x"]] == [1.0, 2.5, 3.0, -0.001], "kaputte Labels, NaN und Inf fallen weg"
    assert sammler.prom_parsen("") == {} and "y" in sammler.prom_parsen(text)


def test_sammler_exporter_system_auswerten():
    if _ohne_sammler():
        return
    s = sammler
    w = s.system_auswerten(s.prom_parsen(NODE_TEXT, s.SYSTEM_FAMILIEN))
    assert w["cpu"] == {"gesamt": 20000.0, "leerlauf": 18350.0}
    assert w["ram_prozent"] == 25.0
    assert w["cpu_temp_c"] == 52, "Paket-Fühler vor den Kernen"
    assert w["system_temp_c"] == 38, "Super-I/O vor acpitz; 127/−128 sind unbeschaltet; NVMe und Netzwerkkarte zählen nicht"
    assert w["raid"] == "normal"
    assert w["volume"] == {"gesamt_b": 7968531677184, "belegt_b": 532500000000}
    assert w["boot_s"] == 1.7601e9
    text = json.dumps(w)
    assert "ug_7F3A21" not in text and "volume1" not in text and "it8613" not in text, "keine Namen/Pfade"

    def raid(*md: str) -> str | None:
        return s.system_auswerten(s.prom_parsen(NODE_KOPF + "".join(md), s.SYSTEM_FAMILIEN)).get("raid")

    assert raid(_md("active", aktiv=1, ausgefallen=1, degradiert=1)) == "degradiert", "degradiertes RAID"
    assert raid(_md("active", aktiv=1, degradiert=1)) == "degradiert", "Platte gezogen (nicht als ausgefallen markiert)"
    assert raid(_md("recovering", aktiv=1, degradiert=1)) == "wiederaufbau"
    assert raid(_md("resync")) == "wiederaufbau"
    assert raid(_md("check")) == "normal", "die monatliche Prüfung ist kein Problem"
    assert raid(_md("inactive", aktiv=0)) == "degradiert"
    assert raid(_md(geraet="md0"), _md("active", aktiv=1, degradiert=1)) == "degradiert", "der schlechteste Verbund zählt"
    assert raid() is None, "ohne md-Verbund kein Wort"
    ohne_temp = s.system_auswerten(s.prom_parsen(NODE_KOPF + _md(), s.SYSTEM_FAMILIEN))
    assert "cpu_temp_c" not in ohne_temp and "system_temp_c" not in ohne_temp, "fehlende Temperatur fehlt im Paket"
    nur_acpi = s.system_auswerten(s.prom_parsen(NODE_TEMPS.replace('chip_name="it8613"', 'chip_name="sonstwas"'),
                                                s.SYSTEM_FAMILIEN))
    assert nur_acpi["system_temp_c"] == 28, "ohne Super-I/O zählt acpitz"


def test_sammler_exporter_platten_auswerten():
    if _ohne_sammler():
        return
    s = sammler
    p = s.platten_auswerten(s.prom_parsen(SMART_TEXT, s.PLATTEN_FAMILIEN))
    assert p == [
        {"schacht": 1, "temp_c": 34, "gesundheit": "ok", "betriebsstunden": 12000, "umgelagert": 0, "ausstehend": 0,
         "nicht_korrigierbar": 0, "crc_fehler": 0},
        {"schacht": 2, "temp_c": 38, "gesundheit": "warnung", "betriebsstunden": 9000, "umgelagert": 8, "ausstehend": 0},
        {"schacht": 3, "gesundheit": "ok", "betriebsstunden": 100, "umgelagert": 0},
        {"schacht": 4, "temp_c": 45, "gesundheit": "fehler", "umgelagert": 1200, "ausstehend": 16},
    ], p
    text = json.dumps(p)
    for verboten in ("ST4000", "WD40", "ZW60", "WD-WX", "sda", "nvme", "Familie", "UGREEN", "SN0001"):
        assert verboten not in text, verboten
    schlaeft = s.platten_auswerten(s.prom_parsen(SMART_KOPF + SMART_SDB + SMART_SDC, s.PLATTEN_FAMILIEN))
    assert [x["schacht"] for x in schlaeft] == [2, 3], "schlafende Platte sda: die anderen behalten ihre Nummer"
    nur_194 = _smart("sda", "M", "S", 1, 0, None, None, {194: 0x330027})
    assert s.platten_auswerten(s.prom_parsen(nur_194, s.PLATTEN_FAMILIEN)) == [
        {"schacht": 1, "temp_c": 39, "gesundheit": "ok"}], "Rohwert 194 (gepackt) als Ersatz"
    vorwarnung = _smart("sda", "M", "S", 1, 32, 30, None, {})
    assert s.platten_auswerten(s.prom_parsen(vorwarnung, s.PLATTEN_FAMILIEN))[0]["gesundheit"] == "warnung"
    assert s.sata_nummer("sda") == 1 and s.sata_nummer("sdd") == 4 and s.sata_nummer("sdaa") == 27
    assert s.sata_nummer("nvme0") is None and s.sata_nummer("sda1") is None


def test_sammler_exporter_block_rate_und_fehler():
    if _ohne_sammler():
        return
    s = sammler
    system = s.system_auswerten(s.prom_parsen(NODE_TEXT, s.SYSTEM_FAMILIEN))
    platten = s.platten_auswerten(s.prom_parsen(SMART_TEXT, s.PLATTEN_FAMILIEN))
    t0 = 1.7601e9 + 3600
    ok = {"system": {"name": "system", "ok": True, "werte": system},
          "platten": {"name": "platten", "ok": True, "werte": {"platten": platten}}}
    block, volume, cpu, hinweis = s.exporter_block(ok, None, t0)
    assert block["status"] == "ok" and block["quelle"] == "exporter" and hinweis is None
    assert "last_prozent" not in block, "erste Abfrage: noch keine Rate"
    assert block["uptime_s"] == 3600 and block["raid"] == "normal" and block["ram_prozent"] == 25
    assert block["system_temp_c"] == 38 and block["cpu_temp_c"] == 52 and len(block["platten"]) == 4
    assert volume == {"gesamt_b": 7968531677184, "belegt_b": 532500000000}
    weiter = json.loads(json.dumps(ok))
    weiter["system"]["werte"]["cpu"] = {"gesamt": 21000.0, "leerlauf": 19100.0}
    block2, _, cpu2, _ = s.exporter_block(weiter, cpu, t0 + 60)
    assert block2["last_prozent"] == 25, "Last = 1 − Δleer/Δgesamt"
    block3, _, _, _ = s.exporter_block(weiter, cpu2, t0 + 120)
    assert "last_prozent" not in block3, "Zähler unverändert → keine Rate statt 0 %"

    teil = {"system": ok["system"], "platten": {"name": "platten", "ok": False, "grund": "anmeldung"}}
    block, _, _, hinweis = s.exporter_block(teil, None, t0)
    assert block["status"] == "ok" and "platten" not in block and hinweis == "platten: anmeldung"
    beide = {"system": {"name": "system", "ok": False, "grund": "zeitlimit"},
             "platten": {"name": "platten", "ok": False, "grund": "keine_antwort"}}
    block, volume, cpu_x, _ = s.exporter_block(beide, cpu, t0)
    assert block == {"status": "fehler", "grund": "keine_antwort", "quelle": "exporter",
                     "gemessen_am": block["gemessen_am"]} and volume is None and cpu_x == cpu
    block, _, _, hinweis = s.exporter_block({}, None, t0)
    assert block["grund"] == "zeitlimit" and hinweis == "system: zeitlimit, platten: zeitlimit", "Kind hing: Zeitlimit"
    assert s.exporter_block({"system": {"name": "system", "ok": False, "grund": "anmeldung"}}, None, t0)[0]["grund"] \
        == "anmeldung", "Anmeldung ist der hilfreichste Grund"


def test_sammler_exporter_zugang():
    if _ohne_sammler():
        return
    s = sammler
    gut = {"NAS_EXPORTER_BENUTZER": "messung", "NAS_EXPORTER_PASSWORT": "x" * 32}
    assert s.exporter_pruefen(gut, "nas.test") is None
    assert s.exporter_pruefen({**gut, "NAS_EXPORTER_ADRESSE": "192.168.1.20"}, None) is None
    assert s.exporter_pruefen({**gut, "NAS_EXPORTER_ADRESSE": "[fd00::20]"}, None) is None
    fall = {
        "NAS_EXPORTER_BENUTZER": ("", "NAS_EXPORTER_BENUTZER fehlt"),
        "NAS_EXPORTER_PASSWORT": ("geheim#geheim-geheim", "NAS_EXPORTER_PASSWORT enthält"),
        "NAS_EXPORTER_ADRESSE": ("nas test", "NAS_EXPORTER_ADRESSE ungültig"),
        "NAS_EXPORTER_PORT_SYSTEM": ("99999", "NAS_EXPORTER_PORT_SYSTEM ungültig"),
    }
    for feld, (wert, grund) in fall.items():
        g = s.exporter_pruefen({**gut, feld: wert}, "nas.test")
        assert g and g.startswith(grund), (feld, g)
        assert not wert or wert not in g, "nie Werte im Grund"
    assert s.exporter_pruefen({**gut, "NAS_EXPORTER_PASSWORT": "kurz-kurz"}, "nas.test").startswith(
        "NAS_EXPORTER_PASSWORT muss 12")
    assert s.exporter_pruefen(gut, None).startswith("NAS_EXPORTER_ADRESSE fehlt")
    assert s.exporter_url("192.168.1.20", 9100) == "http://192.168.1.20:9100/metrics"
    assert s.exporter_url("fd00::20", 9633) == "http://[fd00::20]:9633/metrics"

    alt = s.NAS_ENV
    try:
        s.NAS_ENV = Path("/gibt/es/nicht.env")
        assert s.exporter_zugang() is None, "ohne Datei ruht der Exporter"
        langsam = s.Langsam(threading.Event())
        langsam._hardware()
        assert langsam.bild()["snmp"] == {"status": "nicht_eingerichtet"} or os.path.exists(s.SNMP_ENV), \
            "ohne technik-nas.env alles wie heute"
        offen = _datei("NAS_EXPORTER_BENUTZER=messung\nNAS_EXPORTER_PASSWORT=" + "y" * 32 + "\nNAS_EXPORTER_ADRESSE=nas.test\n")
        os.chmod(offen, 0o644)
        s.NAS_ENV = offen
        assert s.exporter_zugang() == "zugang_ungueltig", "für alle lesbar → ungültig"
        langsam._hardware()
        assert langsam.bild()["snmp"] == {"status": "nicht_eingerichtet", "grund": "zugang_ungueltig",
                                          "quelle": "exporter"}
        os.chmod(offen, 0o600)
        z = s.exporter_zugang()
        if os.geteuid() == 0:
            assert z == {"benutzer": "messung", "passwort": "y" * 32, "adresse": "nas.test",
                         "ports": {"system": 9100, "platten": 9633}}
        else:
            assert z == "zugang_ungueltig", "nicht root → ungültig"
    finally:
        s.NAS_ENV = alt


class _Exporter(http.server.BaseHTTPRequestHandler):
    """Gestellter Exporter auf 127.0.0.1 (kein Netz nötig): /system, /platten, /langsam (3 s), /weiter (302)."""

    KOPF = "Basic " + base64.b64encode(b"messung:richtig-passwort-123").decode()
    gesehen: list[str] = []

    def do_GET(self) -> None:  # noqa: N802
        _Exporter.gesehen.append(self.path)
        if self.headers.get("Authorization") != self.KOPF:
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="x"')
            self.end_headers()
            return
        if self.path == "/weiter":
            self.send_response(302)
            self.send_header("Location", "/system")
            self.end_headers()
            return
        if self.path == "/langsam":
            time.sleep(3)
        text = {"/system": NODE_TEXT, "/platten": SMART_TEXT}.get(self.path, NODE_TEXT).encode()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4")
            self.send_header("Content-Length", str(len(text)))
            self.end_headers()
            self.wfile.write(text)
        except OSError:
            pass  # der Abfragende hat nach seinem Zeitlimit schon aufgelegt

    def log_message(self, *_a) -> None:  # noqa: ANN002
        return


def test_sammler_exporter_http_im_kind():
    if _ohne_sammler():
        return
    s = sammler
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Exporter)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    basis = f"http://127.0.0.1:{server.server_address[1]}"
    with socket.socket() as frei:
        frei.bind(("127.0.0.1", 0))
        zu = f"http://127.0.0.1:{frei.getsockname()[1]}/metrics"  # Port ohne Dienst
    try:
        def lauf(passwort: str, ziele: dict[str, str], zeitlimit_s: float = 3.0, hart: float = 10.0) -> dict:
            kind = s.Kindprozess("--exporter-probe", hart)
            zeilen = kind.zeilen({"benutzer": "messung", "passwort": passwort, "zeitlimit_s": zeitlimit_s,
                                  "ziele": [{"name": n, "url": u} for n, u in ziele.items()]})
            assert passwort not in json.dumps(zeilen or []), "Passwort nie in der Ausgabe des Kindes"
            return {z["name"]: z for z in zeilen or []}

        e = lauf("richtig-passwort-123", {"system": f"{basis}/system", "platten": f"{basis}/platten"})
        assert e["system"]["ok"] and e["system"]["werte"]["raid"] == "normal"
        assert [p["schacht"] for p in e["platten"]["werte"]["platten"]] == [1, 2, 3, 4]
        block, volume, _, _ = s.exporter_block(e, None, time.time())
        assert block["status"] == "ok" and volume is not None

        e = lauf("falsches-passwort-1", {"system": f"{basis}/system", "platten": f"{basis}/platten"})
        assert e["system"] == {"name": "system", "ok": False, "grund": "anmeldung"}, "401 → anmeldung"
        assert s.exporter_block(e, None, time.time())[0]["grund"] == "anmeldung"

        e = lauf("richtig-passwort-123", {"system": f"{basis}/langsam", "platten": zu}, zeitlimit_s=0.5)
        assert e["system"]["grund"] == "zeitlimit" and e["platten"]["grund"] == "keine_antwort"

        _Exporter.gesehen.clear()
        e = lauf("richtig-passwort-123", {"system": f"{basis}/weiter"})
        assert e["system"]["grund"] == "unbekannt" and _Exporter.gesehen == ["/weiter"], "Weiterleitung nicht folgen"

        t0 = time.monotonic()
        e = lauf("richtig-passwort-123", {"system": f"{basis}/langsam"}, zeitlimit_s=10.0, hart=1.0)
        assert e == {} and time.monotonic() - t0 < 2.5, "hartes Zeitlimit beendet das Kind"
        block = s.exporter_block(e, None, time.time())[0]
        assert block["status"] == "fehler" and block["grund"] == "zeitlimit"
    finally:
        server.shutdown()
        server.server_close()


def test_paket_ohne_adressen():
    jetzt = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    m, gesendet = _melder(lambda r: httpx.Response(200), _datei({"rig": {"gemessen_am": jetzt}}))
    m.einmal()
    text = gesendet[0].content.decode()
    assert not re.search(r"\b\d{1,3}(\.\d{1,3}){3}\b", text), "keine IP-Adressen"
    assert not re.search(r"([0-9a-f]{2}:){5}[0-9a-f]{2}", text, re.I), "keine MAC-Adressen"
    assert "ollama:11434" not in text and "/mnt/" not in text
    m.schliessen()


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    fehler = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok      {name}")
        except Exception as e:  # noqa: BLE001
            fehler += 1
            print(f"FEHLER  {name}: {type(e).__name__}: {e}")
    print(f"{len(tests) - fehler}/{len(tests)} bestanden")
    sys.exit(1 if fehler else 0)
