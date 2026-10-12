"""Technik-Dashboard (docs/technik-dashboard/VERTRAG.md §1–§2): Melder im Dienst (app/technik.py) und die reinen
Teile des Host-Sammlers (messung/technik_sammler.py). Ohne Netz, ohne Rig — das FSM und Ollama sind gestellt.

  docker run --rm --network none -v <repo>/rig/eventline-ki:/t:ro -w /t/dienst eventline-ki/dienst:local python tests/test_technik.py

Mit nur dienst/ eingebunden (-v …/dienst:/t) fehlen die Sammler-Tests (übersprungen), der Rest läuft.
"""

from __future__ import annotations

import dataclasses
import importlib.util
import json
import os
import re
import sys
import tempfile
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
