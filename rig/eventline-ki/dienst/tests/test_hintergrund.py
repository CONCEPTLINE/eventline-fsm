"""Hintergrund-Thread des Hauptmodells (Masterplan §2.3–§2.6): gestreamter Aufruf mit Abbruch, Pause durch den
Wächter, Wiederaufnahme, OOM-Sperre, Fensterende, Vorrang — gegen eine Ollama-Attrappe auf 127.0.0.1 (echte
Sockets, damit das Trennen einer hängenden Verbindung wirklich geprüft wird). Läuft ohne Netz:

  docker run --rm --network none -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_hintergrund.py
"""

from __future__ import annotations

import dataclasses
import json
import sys
import tempfile
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import laden  # noqa: E402
from app.gpu import SCHLEUSE  # noqa: E402
from app.hintergrund import Hintergrund, Takt  # noqa: E402
from app.jobs import JOBS, STATUS, Schritt  # noqa: E402
from app.llm import LlmAbgebrochen, Ollama  # noqa: E402
from app.planer import Planer  # noqa: E402
from app.speicher import GIB, Messung  # noqa: E402
from app.worker import Zustand  # noqa: E402

GROSS, KLEIN = "gemma4:26b-a4b-it-qat", "gemma4:12b-it-qat"
LEITER = ((GROSS, 17.0), (KLEIN, 10.0))
ZH = ZoneInfo("Europe/Zurich")
DENKTEXT = "GEHEIMER-DENKTEXT"


# --- Ollama-Attrappe ------------------------------------------------------------------------------


class Attrappe:
    """Minimal-Ollama: /api/tags, /api/ps, /api/generate (Laden/Entladen), /api/chat (NDJSON-Stream).
    chat_modus: «normal», «stumm» (lange kein Chunk, wie beim Laden/Prompt), «langsam» (Denk-Chunks bis
    zum Verbindungsabbruch), «oom» (Runner stirbt mitten im Stream: Modell weg, Verbindung zu)."""

    def __init__(self) -> None:
        self.installiert = [GROSS, KLEIN]
        self.geladen: set[str] = set()
        self.chat_modus = "normal"
        self.chat_modus_danach: str | None = None
        self.ladungen: list[str] = []
        self.implizit_geladen = 0
        self.entladen: list[str] = []
        self.chats = 0
        self.chat_laeuft = threading.Event()
        self.getrennt = 0
        self.ende = threading.Event()
        self.optionen: list[dict] = []
        # /api/ps antwortet mit 500 (wie bei Speichernot hängendes gruendlich); Entladen schlägt fehl.
        self.ps_fehler = False
        self.entlade_fehler = False
        # Zusätzliche Felder je geladenem Modell in /api/ps (expires_at, context_length wie Ollama 0.35.1).
        self.ps_extra: dict[str, dict] = {}
        attrappe = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_a) -> None:  # noqa: D401 — still
                pass

            def _json(self, daten: dict, status: int = 200) -> None:
                roh = json.dumps(daten).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(roh)))
                self.end_headers()
                self.wfile.write(roh)

            def do_GET(self) -> None:  # noqa: N802
                if self.path == "/api/tags":
                    self._json({"models": [{"name": n} for n in attrappe.installiert]})
                elif self.path == "/api/ps" and attrappe.ps_fehler:
                    self._json({"error": "belegt"}, 500)
                elif self.path == "/api/ps":
                    self._json({"models": [{"name": n, "model": n, **attrappe.ps_extra.get(n, {})} for n in sorted(attrappe.geladen)]})
                else:
                    self._json({"error": "?"}, 404)

            def do_POST(self) -> None:  # noqa: N802
                laenge = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(laenge) or b"{}")
                if self.path == "/api/generate":
                    modell = body.get("model")
                    if body.get("keep_alive") in (0, "0") and attrappe.entlade_fehler:
                        self._json({"error": "belegt"}, 500)
                        return
                    if body.get("keep_alive") in (0, "0"):
                        attrappe.geladen.discard(modell)
                        attrappe.entladen.append(modell)
                    else:
                        attrappe.ladungen.append(modell)
                        attrappe.optionen.append(dict(body.get("options") or {}))
                        attrappe.geladen.add(modell)
                    self._json({"done": True, "load_duration": 1_000_000})
                elif self.path == "/api/chat":
                    self._chat(body)
                else:
                    self._json({"error": "?"}, 404)

            def _zeile(self, daten: dict) -> None:
                self.wfile.write((json.dumps(daten) + "\n").encode())
                self.wfile.flush()

            def _chat(self, body: dict) -> None:
                modell = body.get("model")
                attrappe.chats += 1
                attrappe.optionen.append(dict(body.get("options") or {}))
                if modell not in attrappe.geladen:
                    attrappe.implizit_geladen += 1
                    attrappe.geladen.add(modell)
                modus = attrappe.chat_modus
                if attrappe.chat_modus_danach is not None:
                    attrappe.chat_modus, attrappe.chat_modus_danach = attrappe.chat_modus_danach, None
                # HTTP/1.0 ohne Content-Length: der Körper endet mit dem Schliessen der Verbindung.
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.end_headers()
                attrappe.chat_laeuft.set()
                try:
                    if modus == "stumm":
                        frist = time.monotonic() + 20
                        while time.monotonic() < frist and not attrappe.ende.is_set():
                            time.sleep(0.05)
                    if modus == "langsam":
                        frist = time.monotonic() + 20
                        while time.monotonic() < frist and not attrappe.ende.is_set():
                            self._zeile({"message": {"role": "assistant", "content": "", "thinking": DENKTEXT}, "done": False})
                            time.sleep(0.05)
                    for _ in range(3):
                        self._zeile({"message": {"role": "assistant", "content": "", "thinking": DENKTEXT}, "done": False})
                    if modus == "oom":
                        attrappe.geladen.discard(modell)
                        self.close_connection = True
                        return
                    for teil in ('{"ok": true, ', '"summe": 42}'):
                        self._zeile({"message": {"role": "assistant", "content": teil}, "done": False})
                    self._zeile({"message": {"role": "assistant", "content": ""}, "done": True,
                                 "prompt_eval_count": 30, "eval_count": 8, "load_duration": 0})
                except (BrokenPipeError, ConnectionResetError):
                    attrappe.getrennt += 1
                finally:
                    attrappe.chat_laeuft.clear()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def schliessen(self) -> None:
        self.ende.set()
        self.server.shutdown()
        self.server.server_close()


# --- Attrappen für Liste, Protokoll -----------------------------------------------------------------


class Liste:
    """Wie jobs.JobListe, im Speicher."""

    def __init__(self) -> None:
        self.zeilen: dict[int, dict] = {}
        self._lock = threading.Lock()

    def anlegen(self, art: str, schluessel: str, rezept: str = "probe/v1") -> int:
        with self._lock:
            i = len(self.zeilen) + 1
            self.zeilen[i] = {"art": art, "schluessel": schluessel, "rezept": rezept, "status": "offen", "versuche": 0,
                              "fehler": None, "erstellt": i}
            return i

    def start(self) -> int:
        n = 0
        for z in self.zeilen.values():
            if z["status"] == "laeuft":
                z["status"] = "offen"
                n += 1
        return n

    def naechster(self, arten: list[str]) -> Schritt | None:
        with self._lock:
            kandidaten = [(i, z) for i, z in self.zeilen.items() if z["status"] in ("offen", "pausiert") and z["art"] in arten]
            if not kandidaten:
                return None
            i, z = sorted(kandidaten, key=lambda e: (arten.index(e[1]["art"]), e[1]["status"] != "pausiert", e[1]["erstellt"]))[0]
            return Schritt(i, z["art"], z["schluessel"], z["rezept"], z["status"], z["versuche"])

    def beginne(self, i: int) -> None:
        z = self.zeilen[i]
        z.update(status="laeuft", versuche=z["versuche"] + 1, fehler=None)

    def beende(self, i: int, status: str, fehler: str | None = None, *, versuch_zaehlt: bool = True) -> None:
        assert status in STATUS and status != "laeuft"
        z = self.zeilen[i]
        z.update(status=status, fehler=fehler)
        if not versuch_zaehlt:
            z["versuche"] = max(0, z["versuche"] - 1)

    def zaehler(self) -> dict[str, int]:
        werte = {s: 0 for s in STATUS}
        for z in self.zeilen.values():
            werte[z["status"]] += 1
        return werte

    def schliessen(self) -> None:
        pass


class Protokoll:
    def __init__(self) -> None:
        self.eintraege: list[tuple] = []
        self.kennzahlen: list[dict] = []

    def schreibe(self, art, quelle, dauer_ms, modell, ok, fehler=None, **kennzahlen) -> None:  # noqa: ANN001, ANN003
        self.eintraege.append((art, quelle, modell, ok, fehler))
        self.kennzahlen.append(kennzahlen)


def _messung(belegt_gb: float = 2.0, verfuegbar_gb: float = 30.0) -> Messung:
    return Messung(zeit=time.monotonic(), mem_available=int(verfuegbar_gb * GIB), slice_current=int(belegt_gb * GIB),
                   slice_inactive_file=0, slice_max=22 * GIB, psi_full_avg10=0.0, pgmajfault=0)


class Umgebung:
    def __init__(self, *, stunde: int = 21, gpu_nacht: bool = False, tag_aktiv: bool = False,
                 ruhe_tag_s: float | None = 0.0, jobs: tuple = JOBS, leiter: tuple = LEITER,
                 lade_abstand_s: float = 0.0) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.ollama = Attrappe()
        self.cfg = dataclasses.replace(
            laden(), hg_url=self.ollama.url, hg_modelle=leiter, hg_aktiv=True, hg_gpu_nacht=gpu_nacht,
            data_dir=Path(self.tmp.name), hg_schritt_max_s=30, hg_not_gb=1.0,
        )
        self.llm = Ollama(self.cfg, base_url=self.cfg.hg_url, schleuse=False)
        self.liste = Liste()
        self.protokoll = Protokoll()
        self.zustand = Zustand()
        self.speicher = _messung()
        self.zeit = datetime(2026, 10, 11, stunde, 0, tzinfo=ZH)
        # Ladeabstand im Test aus (eigener Test unten), sonst lüde jede Wiederaufnahme erst nach 15 min.
        self.planer = Planer(leiter=leiter, tor_dauer_s=0.0, tor_dauer_nach_pause_s=0.3, pause_s=0.5, tag_aktiv=tag_aktiv,
                             lade_abstand_s=lade_abstand_s)
        self.hg = Hintergrund(
            self.cfg, self.llm, self.liste, self.protokoll, self.zustand, planer=self.planer, jobs=jobs,
            messung=lambda: self.speicher, uhr=lambda: self.zeit,
            takt=Takt(ruhe=0.05, warten=0.05, waechter=0.05, ruhe_s=0.0, entlade_warten_s=1.0, fehler=0.1,
                      ruhe_tag_s=ruhe_tag_s),
        )
        self.planer.sperren_gespeichert = self.hg._sperren_speichern

    def warte(self, bedingung, s: float = 10.0, was: str = "") -> None:
        frist = time.monotonic() + s
        while time.monotonic() < frist:
            if bedingung():
                return
            time.sleep(0.02)
        raise AssertionError(f"Zeitüberschreitung: {was}")

    def __enter__(self) -> "Umgebung":
        return self

    def __exit__(self, *_a) -> None:
        self.hg.stop()
        if self.hg.ident is not None:
            self.hg.join(timeout=10)
        self.ollama.schliessen()
        self.llm.schliessen()
        self.tmp.cleanup()


# --- chat_stream -------------------------------------------------------------------------------------


def _stream(llm: Ollama, **k):
    return llm.chat_stream(
        modell=GROSS, nachrichten=[{"role": "user", "content": "x"}],
        optionen={"num_ctx": 16384}, keep_alive="15m", format={"type": "object"}, think=True, **k,
    )


def test_chat_stream_normal_ohne_denktext() -> None:
    with Umgebung() as u:
        text, meta = _stream(u.llm)
        assert json.loads(text) == {"ok": True, "summe": 42}
        assert meta["denk_tokens"] == 3 and meta["antwort_tokens"] == 8
        assert DENKTEXT not in text and DENKTEXT not in json.dumps(meta), "Denk-Text nie zurückgeben"


def test_abbruch_ohne_chunk_trennt_sofort() -> None:
    # Während Laden/Prompt kommt minutenlang kein Chunk: der Abbruch muss trotzdem sofort greifen.
    with Umgebung() as u:
        u.ollama.chat_modus = "stumm"
        abbruch = threading.Event()
        threading.Timer(0.3, abbruch.set).start()
        t0 = time.monotonic()
        try:
            _stream(u.llm, abbruch=abbruch)
            raise AssertionError("LlmAbgebrochen erwartet")
        except LlmAbgebrochen as e:
            assert e.grund == "abbruch"
        assert time.monotonic() - t0 < 1.5, time.monotonic() - t0


def test_frist_bricht_ab() -> None:
    with Umgebung() as u:
        u.ollama.chat_modus = "stumm"
        t0 = time.monotonic()
        try:
            _stream(u.llm, frist_s=0.5)
            raise AssertionError("LlmAbgebrochen erwartet")
        except LlmAbgebrochen as e:
            assert e.grund == "zeit"
        assert time.monotonic() - t0 < 1.5


def test_pruefe_vorrang_nach_chunk() -> None:
    with Umgebung() as u:
        u.ollama.chat_modus = "langsam"
        aufrufe = []

        def pruefe():
            aufrufe.append(1)
            return "vorrang" if len(aufrufe) >= 3 else None

        try:
            _stream(u.llm, pruefe=pruefe)
            raise AssertionError("LlmAbgebrochen erwartet")
        except LlmAbgebrochen as e:
            assert e.grund == "vorrang"
        u.warte(lambda: u.ollama.getrennt >= 1, 3, "Attrappe merkt den Verbindungsabbruch")


def test_schleuse_nie_gehalten_wartender_auftrag_unter_1s() -> None:
    with Umgebung() as u:
        u.ollama.chat_modus = "langsam"
        abbruch = threading.Event()
        fehler: list[BaseException] = []

        def lauf():
            try:
                _stream(u.llm, abbruch=abbruch)
            except LlmAbgebrochen:
                pass
            except BaseException as e:  # noqa: BLE001
                fehler.append(e)

        t = threading.Thread(target=lauf)
        t.start()
        u.warte(u.ollama.chat_laeuft.is_set, 3, "Stream läuft")
        t0 = time.monotonic()
        assert SCHLEUSE.acquire(timeout=1.0), "Diktat/Ablage bekäme die GPU-Schleuse nicht"
        SCHLEUSE.release()
        assert time.monotonic() - t0 < 1.0
        abbruch.set()
        t.join(timeout=3)
        assert not fehler, fehler
        try:
            Hintergrund(u.cfg, Ollama(u.cfg), u.liste, u.protokoll, u.zustand)
            raise AssertionError("Client mit Schleuse muss abgewiesen werden")
        except ValueError:
            pass


# --- Hintergrund-Thread ---------------------------------------------------------------------------------


def test_probe_ende_zu_ende() -> None:
    with Umgebung() as u:
        i = u.liste.anlegen("probe", "a")
        u.hg.start()
        u.warte(lambda: u.liste.zeilen[i]["status"] == "fertig", 10, "Probe fertig")
        assert u.ollama.ladungen == [GROSS] and u.ollama.implizit_geladen == 0, "genau ein Laden, nie implizit"
        opt = u.ollama.optionen[0]
        assert opt == {"use_mmap": False, "num_gpu": 0, "num_ctx": 16384, "num_thread": 10}, opt
        assert all(o.get("num_ctx") == 16384 and o.get("num_thread") == 10 for o in u.ollama.optionen)
        arten = [(e[0], e[3]) for e in u.protokoll.eintraege]
        assert ("hg_laden", True) in arten and ("hg_probe", True) in arten, arten
        st = u.hg.status()
        assert st["geladen"] == GROSS and st["planer"]["ladungen"] == 1 and st["uebernommen"] is None
        merker = json.loads((Path(u.tmp.name) / "hg-geladen.json").read_text())
        assert merker["modell"] == GROSS and merker["fenster"] == "2026-10-11/nacht" and merker["optionen"] == opt, merker
        u.hg.stop()
        u.hg.join(timeout=10)
        # Seit 16.10.2026: beim Beenden (Deploy) bleibt das Modell geladen — der nächste Start übernimmt es.
        assert GROSS in u.ollama.geladen and GROSS not in u.ollama.entladen, "bleibt beim Beenden geladen"
        assert (Path(u.tmp.name) / "hg-geladen.json").exists(), "Merker bleibt für den nächsten Start"


def test_waechter_abbruch_pause_wiederaufnahme() -> None:
    with Umgebung() as u:
        u.ollama.chat_modus = "langsam"
        i = u.liste.anlegen("probe", "a")
        u.hg.start()
        u.warte(u.ollama.chat_laeuft.is_set, 5, "Schritt streamt")
        t0 = time.monotonic()
        u.speicher = _messung(verfuegbar_gb=0.5)          # MemAvailable < KI_HG_NOT_GB
        u.warte(lambda: u.liste.zeilen[i]["status"] == "pausiert", 3, "Schritt pausiert")
        assert time.monotonic() - t0 < 1.0, "Wächter (2 s im Betrieb, hier 0,05 s) trennt sofort"
        u.warte(lambda: GROSS in u.ollama.entladen, 3, "Modell entladen")
        assert u.liste.zeilen[i]["versuche"] == 0, "Pause zählt nicht als Versuch"
        assert ("hg_probe", False, "speicher") in [(e[0], e[3], e[4]) for e in u.protokoll.eintraege]
        assert u.hg.status()["letzter_abbruch"]["ausloeser"] == "mem_available"
        # Speicher wieder frei: nach Pause (0,5 s) und Tor am Stück (0,3 s) neu laden und fertig rechnen.
        u.ollama.chat_modus = "normal"
        u.speicher = _messung()
        u.warte(lambda: u.liste.zeilen[i]["status"] == "fertig", 10, "Wiederaufnahme")
        assert u.ollama.ladungen == [GROSS, GROSS] and u.planer.status(time.monotonic(), time.time())["ladungen"] == 2
        assert u.ollama.implizit_geladen == 0
        assert u.liste.zeilen[i]["versuche"] == 1


def test_waechter_zwischen_schritten_entlaedt() -> None:
    with Umgebung() as u:
        i = u.liste.anlegen("probe", "a")
        u.hg.start()
        u.warte(lambda: u.liste.zeilen[i]["status"] == "fertig", 10, "erster Schritt")
        assert u.hg.status()["geladen"] == GROSS
        u.speicher = _messung(verfuegbar_gb=0.5)
        u.warte(lambda: GROSS in u.ollama.entladen, 3, "Wächter entlädt auch ohne laufenden Schritt")
        u.warte(lambda: u.hg.status()["geladen"] is None, 3, "Status")
        assert u.planer.status(time.monotonic(), time.time())["pause_rest_s"] >= 0


def test_oom_sperrt_26b_und_nimmt_12b() -> None:
    with Umgebung() as u:
        u.ollama.chat_modus, u.ollama.chat_modus_danach = "oom", "normal"
        i = u.liste.anlegen("probe", "a")
        u.hg.start()
        u.warte(lambda: u.liste.zeilen[i]["status"] == "fertig", 10, "nach OOM mit 12B fertig")
        assert u.ollama.ladungen == [GROSS, KLEIN], u.ollama.ladungen
        assert u.liste.zeilen[i]["versuche"] == 2
        assert ("hg_oom", False) in [(e[0], e[3]) for e in u.protokoll.eintraege]
        assert GROSS in u.hg.status()["planer"]["gesperrt"]
        gespeichert = json.loads((Path(u.tmp.name) / "hg-sperren.json").read_text())
        assert gespeichert[GROSS] > time.time() + 23 * 3600, "Sperre 24 h, im Tresor gespeichert"


def test_fensterende_entlaedt() -> None:
    with Umgebung() as u:
        i = u.liste.anlegen("probe", "a")
        u.hg.start()
        u.warte(lambda: u.liste.zeilen[i]["status"] == "fertig", 10, "Schritt")
        u.zeit = datetime(2026, 10, 12, 6, 50, tzinfo=ZH)       # nach 06:45: vor dem Tag entladen
        u.warte(lambda: GROSS in u.ollama.entladen, 3, "Entladen vor Tagesbeginn")
        u.liste.anlegen("probe", "b")
        time.sleep(0.4)
        assert u.ollama.ladungen == [GROSS], "tagsüber (KI_HG_TAG=0) kein neues Laden"
        assert u.hg.status()["warte"] == "vor_tag"


def test_tagsueber_aus_laedt_nicht() -> None:
    with Umgebung(stunde=12) as u:
        u.liste.anlegen("probe", "a")
        u.hg.start()
        time.sleep(0.4)
        assert u.ollama.ladungen == [] and u.ollama.chats == 0
        assert u.hg.status()["warte"] == "tag_aus"


def test_tagsueber_laedt_erst_nach_der_tagesruhe_mit_tag_threads() -> None:
    """Seit 16.10.2026 (KI_HG_TAG Standard an, «die KI arbeitet, wenn sie etwas zu tun hat»): tagsüber lädt das
    Hauptmodell erst nach KI_HG_RUHE_TAG_S ohne FSM-Auftrag (nachts 20 s) und mit KI_HG_THREADS_TAG Threads."""
    with Umgebung(stunde=12, tag_aktiv=True, ruhe_tag_s=0.8) as u:
        u.zustand.setze(letzte_arbeit=time.monotonic())  # ein Auftrag ist eben fertig geworden
        i = u.liste.anlegen("probe", "a")
        u.hg.start()
        time.sleep(0.3)
        assert u.ollama.ladungen == [] and u.hg.status()["warte"] == "vorrang", "Tagesruhe noch nicht erreicht"
        u.warte(lambda: u.liste.zeilen[i]["status"] == "fertig", 10, "nach der Tagesruhe gerechnet")
        assert u.ollama.ladungen == [GROSS] and u.ollama.optionen[0]["num_thread"] == u.planer.threads_tag == 4
        assert u.hg.status()["modus"] == "tag"
    # Ohne eigenen Takt-Wert gilt KI_HG_RUHE_TAG_S (120 s), nachts bleibt es bei Takt.ruhe_s.
    with Umgebung(stunde=12, tag_aktiv=True, ruhe_tag_s=None) as u:
        assert u.hg._ruhe_vor_dem_laden(u.planer.lage(u.zeit)) == 120.0
        assert u.hg._ruhe_vor_dem_laden(u.planer.lage(datetime(2026, 10, 11, 21, 0, tzinfo=ZH))) == 0.0


def test_nur_freigegebene_ohne_rueckfall_und_anderes_modell_wird_entladen() -> None:
    """16.10.2026: der zweite Blick (Job.modelle = freigegebene) rechnet nie mit einem Rückfall-Modell — tagsüber lief er
    nach 30 min geschlossenem Tor des 26B sonst mit dem 12B (13 Dokumente, 08:19–09:08)."""
    nur_oben = dataclasses.replace(JOBS[0], art="nur_oben", modelle=(GROSS,))
    with Umgebung(jobs=(*JOBS, nur_oben)) as u:
        u.planer._fenster = "2026-10-11/nacht"
        u.planer._rueckfall = True                  # Tor des 26B war 30 min zu: Rückfall des Fensters
        u.speicher = _messung(belegt_gb=4.0)        # 26B: 4 + 17 + 2 > 22 (zu); 12B: 4 + 10 + 2 (offen)
        i = u.liste.anlegen("nur_oben", "a")
        u.hg.start()
        time.sleep(0.4)
        assert u.ollama.ladungen == [] and u.hg.status()["warte"].startswith("tor_zu"), u.hg.status()["warte"]
        # Ein Schritt ohne diese Bedingung nimmt den Rückfall (12B) …
        p = u.liste.anlegen("probe", "b")
        u.warte(lambda: u.liste.zeilen[p]["status"] == "fertig", 10, "Probe mit dem 12B")
        assert u.ollama.ladungen == [KLEIN]
        # … danach steht wieder der Schritt an, der das 26B verlangt: 12B entladen, nicht damit gerechnet.
        u.warte(lambda: KLEIN in u.ollama.entladen, 5, "Rückfall-Modell entladen")
        assert u.liste.zeilen[i]["status"] == "offen" and u.liste.zeilen[i]["versuche"] == 0
        # Tor des 26B offen → mit dem 26B gerechnet.
        u.speicher = _messung(belegt_gb=2.0)
        u.warte(lambda: u.liste.zeilen[i]["status"] == "fertig", 10, "mit dem 26B")
        assert u.ollama.ladungen == [KLEIN, GROSS]


def test_zweiter_blick_nie_mit_dem_12b_auch_wenn_es_oben_in_der_leiter_steht() -> None:
    """Der echte Job des zweiten Blicks: nur freigegebene Modelle (das 26B). Selbst mit falsch konfigurierter Leiter
    (12B zuoberst, beide Tore offen) lädt der Hintergrund für ihn nur das 26B und rechnet nie mit dem 12B."""
    from app.jobs import zweiter_blick as zbj

    assert zbj.FREIGEGEBEN == (GROSS,) and not zbj.freigegeben(KLEIN) and zbj.freigegeben(GROSS)
    echt = zbj.job(zbj.ZbAbhaengigkeiten(laden(), None, None, None, None, lambda: True, lambda: None))  # type: ignore[arg-type]
    assert echt.modelle == zbj.FREIGEGEBEN and KLEIN not in echt.modelle
    gerechnet: list[str] = []

    def rechne(_s: Schritt, ctx) -> dict:  # noqa: ANN001
        gerechnet.append(ctx.modell)
        return {}

    zb_art = dataclasses.replace(echt, ausfuehren=rechne, aktiv=lambda _c: True)
    with Umgebung(jobs=(zb_art,), leiter=((KLEIN, 10.0), (GROSS, 17.0))) as u:
        i = u.liste.anlegen("zweiter_blick", "a")
        u.hg.start()
        u.warte(lambda: u.liste.zeilen[i]["status"] == "fertig", 10, "zweiter Blick fertig")
        assert u.ollama.ladungen == [GROSS] and gerechnet == [GROSS], (u.ollama.ladungen, gerechnet)
        assert u.ollama.implizit_geladen == 0


def test_ladeabstand_und_verdoppelung_nach_waechter() -> None:
    """Statt «höchstens 3 Ladungen je Fenster»: zwischen dem Beginn zweier Ladungen liegt der Ladeabstand (hier 1 s statt
    15 min), nach einem Wächter-Abbruch doppelt so lang — danach wird wieder geladen, beliebig oft im selben Fenster."""
    with Umgebung(lade_abstand_s=1.0) as u:
        u.hg.takt.leer_entladen_s = 0.1
        ladezeiten: list[float] = []
        original = u.planer.ladung_beginnt

        def merke(modell: str, jetzt_mono: float, jetzt_wand: float | None = None) -> None:
            ladezeiten.append(jetzt_mono)
            original(modell, jetzt_mono, jetzt_wand)

        u.planer.ladung_beginnt = merke  # type: ignore[method-assign]
        a = u.liste.anlegen("probe", "a")
        u.hg.start()
        u.warte(lambda: u.liste.zeilen[a]["status"] == "fertig", 10, "erste Ladung")
        u.warte(lambda: GROSS in u.ollama.entladen, 3, "Leerlauf entlädt")
        b = u.liste.anlegen("probe", "b")
        u.warte(lambda: u.liste.zeilen[b]["status"] == "fertig", 10, "zweite Ladung nach dem Abstand")
        assert len(ladezeiten) == 2 and ladezeiten[1] - ladezeiten[0] >= 0.95, ladezeiten
        # Wächter-Abbruch: Fehlschlag → nächster Abstand 2 s.
        u.ollama.chat_modus = "langsam"
        c = u.liste.anlegen("probe", "c")
        u.warte(u.ollama.chat_laeuft.is_set, 5, "Schritt streamt")
        u.speicher = _messung(verfuegbar_gb=0.5)
        u.warte(lambda: u.liste.zeilen[c]["status"] == "pausiert", 5, "Wächter pausiert")
        assert u.planer.status(time.monotonic(), time.time())["fehlschlaege"] == 1
        u.ollama.chat_modus = "normal"
        u.speicher = _messung()
        u.warte(lambda: u.liste.zeilen[c]["status"] == "fertig", 15, "Wiederaufnahme nach doppeltem Abstand")
        assert ladezeiten[-1] - ladezeiten[-2] >= 1.95, ladezeiten
        assert u.planer.status(time.monotonic(), time.time())["fehlschlaege"] == 0, "fertiger Schritt setzt zurück"
        assert u.hg.status()["planer"]["ladungen"] == len(ladezeiten) >= 3, "keine feste Grenze je Fenster"


def test_wartender_auftrag_hat_vorrang_vor_dem_laden() -> None:
    with Umgebung() as u:
        u.zustand.setze(laeuft="diktat")
        i = u.liste.anlegen("probe", "a")
        u.hg.start()
        time.sleep(0.4)
        assert u.ollama.ladungen == [] and u.hg.status()["warte"] == "vorrang"
        u.zustand.setze(laeuft=None, letzte_arbeit=time.monotonic())
        u.warte(lambda: u.liste.zeilen[i]["status"] == "fertig", 10, "danach lädt das Hauptmodell")


def test_stufe_b_vorrang_pausiert_und_behaelt_modell() -> None:
    with Umgebung(gpu_nacht=True) as u:
        u.ollama.chat_modus = "langsam"
        i = u.liste.anlegen("probe", "a")
        u.hg.start()
        u.warte(u.ollama.chat_laeuft.is_set, 5, "Schritt streamt")
        u.ollama.chat_modus = "normal"
        u.zustand.setze(laeuft="ablage_analyse")
        u.warte(lambda: u.liste.zeilen[i]["status"] == "pausiert", 3, "Vorrang pausiert")
        assert u.liste.zeilen[i]["fehler"] == "vorrang" and GROSS not in u.ollama.entladen, "Modell bleibt geladen"
        u.zustand.setze(laeuft=None, letzte_arbeit=time.monotonic())
        u.warte(lambda: u.liste.zeilen[i]["status"] == "fertig", 10, "Neustart nach Ruhe")
        assert u.ollama.ladungen == [GROSS], "kein erneutes Laden"


def test_tor_zu_laedt_nicht() -> None:
    with Umgebung() as u:
        u.speicher = _messung(belegt_gb=15.0)
        u.liste.anlegen("probe", "a")
        u.hg.start()
        time.sleep(0.4)
        assert u.ollama.ladungen == []
        assert u.hg.status()["warte"].startswith("tor_zu"), u.hg.status()["warte"]


def test_ps_fehler_beim_waechter_entlaedt_trotzdem_ohne_sperre() -> None:
    # Befund Review E2: /api/ps antwortet bei Speichernot nicht → früher «nicht geladen», kein Entladen.
    with Umgebung() as u:
        i = u.liste.anlegen("probe", "a")
        u.hg.start()
        u.warte(lambda: u.liste.zeilen[i]["status"] == "fertig", 10, "erster Schritt")
        u.ollama.ps_fehler = True
        u.speicher = _messung(verfuegbar_gb=0.5)
        u.warte(lambda: GROSS in u.ollama.entladen, 3, "keep_alive 0 trotz unbekanntem Stand")
        assert not u.ollama.geladen
        assert u.hg.status()["planer"]["gesperrt"] == {}, "unbekannt ist kein OOM"
        assert "hg_oom" not in [e[0] for e in u.protokoll.eintraege]


def test_ps_fehler_zwischen_schritten_keine_sperre() -> None:
    with Umgebung() as u:
        a = u.liste.anlegen("probe", "a")
        u.hg.start()
        u.warte(lambda: u.liste.zeilen[a]["status"] == "fertig", 10, "erster Schritt")
        u.ollama.ps_fehler = True
        b = u.liste.anlegen("probe", "b")
        time.sleep(0.4)
        st = u.hg.status()
        assert st["warte"] == "ps_unbekannt" and st["geladen"] == GROSS, st
        assert st["planer"]["gesperrt"] == {} and u.liste.zeilen[b]["status"] == "offen" and u.ollama.chats == 1
        assert u.hg.speicher_relevant(), "Wächter bleibt aktiv"
        u.ollama.ps_fehler = False
        u.warte(lambda: u.liste.zeilen[b]["status"] == "fertig", 10, "weiter, sobald /api/ps antwortet")
        assert u.ollama.ladungen == [GROSS] and u.ollama.implizit_geladen == 0


def test_entladen_nicht_bestaetigt_wird_wiederholt() -> None:
    with Umgebung() as u:
        i = u.liste.anlegen("probe", "a")
        u.hg.start()
        u.warte(lambda: u.liste.zeilen[i]["status"] == "fertig", 10, "erster Schritt")
        u.ollama.entlade_fehler = True
        u.speicher = _messung(verfuegbar_gb=0.5)
        u.warte(lambda: u.hg.status()["entladen_offen"] == GROSS, 3, "Entladen offen")
        assert u.hg.speicher_relevant() and GROSS in u.ollama.geladen
        u.ollama.entlade_fehler = False
        u.speicher = _messung()
        u.warte(lambda: u.hg.status()["entladen_offen"] is None and not u.ollama.geladen, 5, "nachgeholt")


def test_leerlauf_entlaedt_das_modell() -> None:
    # 16.10.2026: ist die Job-Liste leer, wird nach kurzer Zeit entladen (nicht erst nach keep_alive 15 min).
    with Umgebung() as u:
        u.hg.takt.leer_entladen_s = 0.3
        i = u.liste.anlegen("probe", "a")
        u.hg.start()
        u.warte(lambda: u.liste.zeilen[i]["status"] == "fertig", 10, "Schritt")
        u.warte(lambda: GROSS in u.ollama.entladen, 3, "nach Leerlauf entladen")
        assert u.hg.status()["geladen"] is None and u.hg.status()["warte"] == "keine_arbeit"


def test_sperre_selbsttest_entlaedt_und_laedt_danach() -> None:
    with Umgebung() as u:
        u.planer.sperrzeit = ((5, 25), (5, 50))
        u.zeit = datetime(2026, 10, 12, 5, 10, tzinfo=ZH)
        a = u.liste.anlegen("probe", "a")
        u.hg.start()
        u.warte(lambda: u.liste.zeilen[a]["status"] == "fertig", 10, "vor der Sperre")
        u.zeit = datetime(2026, 10, 12, 5, 30, tzinfo=ZH)
        u.warte(lambda: GROSS in u.ollama.entladen, 3, "in der Sperre entladen")
        b = u.liste.anlegen("probe", "b")
        time.sleep(0.4)
        assert u.liste.zeilen[b]["status"] == "offen" and u.hg.status()["warte"] == "sperre"
        assert u.ollama.ladungen == [GROSS]
        u.zeit = datetime(2026, 10, 12, 5, 50, tzinfo=ZH)
        u.warte(lambda: u.liste.zeilen[b]["status"] == "fertig", 10, "nach der Sperre weiter")
        assert u.ollama.ladungen == [GROSS, GROSS]


def test_job_mit_eigener_frist_und_kennzahlen() -> None:
    from app.jobs import Job

    gesehen: list[float] = []

    def zaehle(_s: Schritt, ctx) -> dict:  # noqa: ANN001
        gesehen.append(ctx.frist - time.monotonic())
        return {"kennzahlen": {"seiten": 3, "teile": 2, "geheim": "nie", "belege": {"datum": {"angegeben": 1, "belegt": 1}}}}

    with Umgebung() as u:
        hg = Hintergrund(u.cfg, u.llm, u.liste, u.protokoll, u.zustand, planer=u.planer,
                         messung=lambda: u.speicher, uhr=lambda: u.zeit,
                         takt=Takt(ruhe=0.05, warten=0.05, waechter=0.05, ruhe_s=0.0, entlade_warten_s=1.0, fehler=0.1),
                         jobs=(Job("lang", zaehle, lambda _c: True, modi=("nacht",), max_s=1800),))
        i = u.liste.anlegen("lang", "x")
        hg.start()
        try:
            u.warte(lambda: u.liste.zeilen[i]["status"] == "fertig", 10, "Schritt")
        finally:
            hg.stop()
            hg.join(timeout=10)
        assert gesehen and gesehen[0] > 1700, "eigene Höchstdauer statt KI_HG_SCHRITT_MAX_S (30 s im Test)"
        kz = u.protokoll.kennzahlen[[e[0] for e in u.protokoll.eintraege].index("hg_lang")]
        assert kz == {"seiten": 3, "teile": 2, "belege": {"datum": {"angegeben": 1, "belegt": 1}}}, kz


def test_planer_zustand_im_tresor() -> None:
    with Umgebung() as u:
        i = u.liste.anlegen("probe", "a")
        u.hg.start()
        u.warte(lambda: u.liste.zeilen[i]["status"] == "fertig", 10, "Schritt")
        gespeichert = json.loads((Path(u.tmp.name) / "hg-planer.json").read_text())
        assert gespeichert["ladungen"] == 1 and gespeichert["fenster"] == "2026-10-11/nacht", gespeichert
        assert time.time() - 60 < gespeichert["letzte_ladung"] <= time.time() and gespeichert["fehlschlaege"] == 0
        # Neustart des Dienstes: neuer Planer liest den Zustand des Fensters — der Ladeabstand (15 min) gilt weiter.
        neu = Hintergrund(u.cfg, u.llm, u.liste, u.protokoll, u.zustand,
                          planer=Planer(leiter=LEITER), messung=lambda: u.speicher, uhr=lambda: u.zeit)
        st = neu.planer.status(time.monotonic(), time.time())
        assert st["ladungen"] == 1 and 840 < st["lade_rest_s"] <= 900, st


# --- Neustart-Lücke (16.10.2026): tatsächlichen Ladezustand übernehmen -----------------------------------------------


def _neustart(u: Umgebung, *, jobs: tuple = JOBS, lade_abstand_s: float = 900.0, schnell: Ollama | None = None) -> Hintergrund:
    """Neuer Dienst nach einem Neustart: frischer Planer (liest hg-planer.json), gleiche Ollama-Attrappe, gleicher Tresor.
    Ladeabstand 15 min wie im Betrieb — ein neues Laden wäre damit sofort sichtbar blockiert."""
    planer = Planer(leiter=LEITER, tor_dauer_s=0.0, tor_dauer_nach_pause_s=0.3, pause_s=0.5, lade_abstand_s=lade_abstand_s)
    return Hintergrund(u.cfg, u.llm, u.liste, u.protokoll, u.zustand, planer=planer, jobs=jobs, messung=lambda: u.speicher,
                       uhr=lambda: u.zeit, schnell=schnell,
                       takt=Takt(ruhe=0.05, warten=0.05, waechter=0.05, ruhe_s=0.0, entlade_warten_s=1.0, fehler=0.1, ruhe_tag_s=0.0))


def _erster_lauf(u: Umgebung) -> None:
    """Dienst A: lädt das 26B, rechnet einen Schritt, wird beendet (Deploy) — das Modell bleibt geladen."""
    a = u.liste.anlegen("probe", "a")
    u.hg.start()
    u.warte(lambda: u.liste.zeilen[a]["status"] == "fertig", 10, "erster Schritt")
    u.hg.stop()
    u.hg.join(timeout=10)
    assert u.ollama.geladen == {GROSS} and u.ollama.ladungen == [GROSS]


def _mit(hg: Hintergrund, f) -> None:  # noqa: ANN001
    hg.start()
    try:
        f()
    finally:
        hg.stop()
        hg.join(timeout=10)


def test_neustart_uebernimmt_geladenes_modell_ohne_neues_laden() -> None:
    """Heute 12:23 → 12:41: nach dem Deploy blieb das 26B geladen, der neue Dienst wusste nichts davon, das Tor blieb zu,
    bis Ollama selbst entlud. Jetzt: übernommen (Merker, gleiche Optionen), sofort weitergerechnet, kein neues Laden —
    obwohl der Ladeabstand (15 min) ein neues Laden noch sperrte. Ladungen und Ladeabstand bleiben, wie sie waren."""
    with Umgebung() as u:
        _erster_lauf(u)
        b = _neustart(u)
        st0 = b.planer.status(time.monotonic(), time.time())
        assert st0["ladungen"] == 1 and st0["lade_rest_s"] > 800, st0
        n = u.liste.anlegen("probe", "b")

        def pruefe() -> None:
            u.warte(lambda: u.liste.zeilen[n]["status"] == "fertig", 10, "nach dem Neustart weitergerechnet")
            st = b.status()
            assert u.ollama.ladungen == [GROSS] and u.ollama.implizit_geladen == 0 and not u.ollama.entladen, u.ollama.ladungen
            assert st["geladen"] == GROSS and st["uebernommen"]["modell"] == GROSS and st["uebernommen"]["quelle"] == "merker"
            assert st["planer"]["ladungen"] == 1 and st["planer"]["lade_rest_s"] > 800, "Ladeabstand läuft weiter wie vorher"
            assert all(o.get("num_thread") == 10 for o in u.ollama.optionen), "gleiche Optionen — Ollama lädt nicht neu"

        _mit(b, pruefe)


def test_neustart_ohne_merker_im_selben_fenster() -> None:
    """Erster Start nach dem Einspielen (der alte Dienst schrieb keinen Merker): übernommen, wenn die letzte Ladung laut
    Planer-Zustand in diesem Fenster war — dann galten die Optionen dieses Fensters."""
    with Umgebung() as u:
        _erster_lauf(u)
        (Path(u.tmp.name) / "hg-geladen.json").unlink()
        b = _neustart(u)
        n = u.liste.anlegen("probe", "b")

        def pruefe() -> None:
            u.warte(lambda: u.liste.zeilen[n]["status"] == "fertig", 10, "weitergerechnet")
            assert u.ollama.ladungen == [GROSS] and b.status()["uebernommen"]["quelle"] == "fenster"
            assert json.loads((Path(u.tmp.name) / "hg-geladen.json").read_text())["modell"] == GROSS, "Merker neu geschrieben"

        _mit(b, pruefe)


def test_neustart_anderes_fenster_oder_andere_optionen_wird_entladen() -> None:
    """Optionen passen nicht (anderes Fenster → andere Threads, oder anderer Merker): ein Aufruf lüde ohne Tor neu — darum
    beim Start entladen und regulär geladen."""
    with Umgebung() as u:
        _erster_lauf(u)
        datei = Path(u.tmp.name) / "hg-geladen.json"
        merker = json.loads(datei.read_text())
        datei.write_text(json.dumps({**merker, "optionen": {**merker["optionen"], "num_thread": 4}}))
        b = _neustart(u, lade_abstand_s=0.0)
        n = u.liste.anlegen("probe", "b")

        def pruefe() -> None:
            u.warte(lambda: u.liste.zeilen[n]["status"] == "fertig", 10, "neu geladen und gerechnet")
            assert u.ollama.entladen == [GROSS] and u.ollama.ladungen == [GROSS, GROSS], (u.ollama.entladen, u.ollama.ladungen)
            assert b.status()["uebernommen"] is None and u.ollama.optionen[-1]["num_thread"] == 10

        _mit(b, pruefe)
    with Umgebung() as u:
        _erster_lauf(u)
        (Path(u.tmp.name) / "hg-geladen.json").unlink()
        u.zeit = datetime(2026, 10, 12, 20, 0, tzinfo=ZH)   # nächste Nacht: anderes Fenster, kein Merker
        b = _neustart(u, lade_abstand_s=0.0)
        n = u.liste.anlegen("probe", "b")

        def pruefe2() -> None:
            u.warte(lambda: u.liste.zeilen[n]["status"] == "fertig", 10, "neu geladen")
            assert u.ollama.entladen == [GROSS] and u.ollama.ladungen == [GROSS, GROSS]

        _mit(b, pruefe2)


def test_neustart_nicht_freigegebenes_modell_wird_entladen() -> None:
    """Steht ein Schritt an, der nur das 26B nehmen darf (zweiter Blick), wird ein geladenes 12B beim Start entladen —
    auch mit passendem Merker — und das 26B regulär geladen."""
    nur_oben = dataclasses.replace(JOBS[0], art="nur_oben", modelle=(GROSS,))
    with Umgebung() as u:
        u.ollama.geladen = {KLEIN}
        b0 = _neustart(u)
        b0._merker_schreiben(_geladen_fuer(b0, KLEIN, u))
        b = _neustart(u, jobs=(*JOBS, nur_oben), lade_abstand_s=0.0)
        n = u.liste.anlegen("nur_oben", "a")

        def pruefe() -> None:
            u.warte(lambda: u.liste.zeilen[n]["status"] == "fertig", 10, "mit dem 26B")
            assert u.ollama.entladen[0] == KLEIN and u.ollama.ladungen == [GROSS], (u.ollama.entladen, u.ollama.ladungen)
            assert b.status()["uebernommen"] is None

        _mit(b, pruefe)


def _geladen_fuer(hg: Hintergrund, modell: str, u: Umgebung):  # noqa: ANN202
    from app.hintergrund import _Geladen

    lage = hg.planer.lage(u.zeit)
    return _Geladen(modell, lage.fenster, lage.threads, time.monotonic())


def test_neustart_ohne_arbeit_oder_kurz_vor_ablauf_wird_entladen() -> None:
    with Umgebung() as u:
        _erster_lauf(u)
        b = _neustart(u)
        _mit(b, lambda: u.warte(lambda: GROSS in u.ollama.entladen, 5, "ohne Arbeit beim Start entladen"))
        assert not (Path(u.tmp.name) / "hg-geladen.json").exists(), "Merker weg, wenn nichts mehr geladen ist"
    with Umgebung() as u:
        _erster_lauf(u)
        # keep_alive läuft in 30 s ab: nicht übernehmen (der nächste Aufruf lüde ohne Tor neu), sondern entladen.
        ende = datetime.now(ZoneInfo("UTC")).timestamp() + 30
        u.ollama.ps_extra[GROSS] = {"expires_at": datetime.fromtimestamp(ende, ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%S.123456789Z")}
        b = _neustart(u, lade_abstand_s=0.0)
        n = u.liste.anlegen("probe", "b")

        def pruefe() -> None:
            u.warte(lambda: u.liste.zeilen[n]["status"] == "fertig", 10, "regulär neu geladen")
            assert u.ollama.entladen == [GROSS] and u.ollama.ladungen == [GROSS, GROSS] and b.status()["uebernommen"] is None

        _mit(b, pruefe)


def test_uebernahme_rechnet_letzte_nutzung_aus_expires_at() -> None:
    """Ollama entlädt keep_alive (15 min) nach dem letzten Aufruf. Die übernommene letzte Nutzung kommt aus expires_at —
    sonst gälte ein Modell, das nach der Übernahme regulär abläuft, als OOM (24-h-Sperre). Ein Schritt ohne Modellaufruf
    verlängert sie nicht, ein Aufruf schon."""
    from app.hintergrund import KEEP_ALIVE_S, UNERWARTET_WEG_S

    with Umgebung() as u:
        _erster_lauf(u)
        ende = datetime.now(ZoneInfo("UTC")).timestamp() + 600
        u.ollama.ps_extra[GROSS] = {"expires_at": datetime.fromtimestamp(ende, ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%S.250954911Z"),
                                    "context_length": 16384}
        ohne = dataclasses.replace(JOBS[0], art="ohne", ausfuehren=lambda _s, _ctx: {})
        b = _neustart(u, jobs=(*JOBS, ohne))
        n = u.liste.anlegen("ohne", "a")

        def pruefe() -> None:
            u.warte(lambda: u.liste.zeilen[n]["status"] == "fertig", 10, "Schritt ohne Modellaufruf")
            g = b._geladen
            assert g is not None and b.status()["uebernommen"]["modell"] == GROSS
            erwartet = time.monotonic() - (KEEP_ALIVE_S - 600)
            assert abs(g.letzte_nutzung - erwartet) < 5, (g.letzte_nutzung, erwartet)
            p = u.liste.anlegen("probe", "p")
            u.warte(lambda: u.liste.zeilen[p]["status"] == "fertig", 10, "Schritt mit Modellaufruf")
            assert time.monotonic() - b._geladen.letzte_nutzung < 5, "ein Aufruf ist eine Nutzung"

        _mit(b, pruefe)
    with Umgebung() as u:
        _erster_lauf(u)
        ohne = dataclasses.replace(JOBS[0], art="ohne", ausfuehren=lambda _s, _ctx: {})
        b = _neustart(u, jobs=(*JOBS, ohne))
        n = u.liste.anlegen("ohne", "a")

        def pruefe2() -> None:
            u.warte(lambda: u.liste.zeilen[n]["status"] == "fertig", 10, "Schritt")
            assert time.monotonic() - b._geladen.letzte_nutzung >= UNERWARTET_WEG_S - 5, "ohne expires_at: nie OOM schliessen"

        _mit(b, pruefe2)


def test_neustart_anderes_kontextfenster_wird_entladen() -> None:
    with Umgebung() as u:
        _erster_lauf(u)
        u.ollama.ps_extra[GROSS] = {"context_length": 8192}
        b = _neustart(u, lade_abstand_s=0.0)
        n = u.liste.anlegen("probe", "b")
        _mit(b, lambda: u.warte(lambda: u.liste.zeilen[n]["status"] == "fertig" and u.ollama.entladen == [GROSS], 10, "entladen, neu"))


def test_neustart_ps_unbekannt_laedt_erst_nach_dem_abgleich() -> None:
    """Antwortet /api/ps beim Start nicht, ist der Stand unbekannt: weder laden (das Tor sähe ein noch geladenes Modell
    nicht als solches) noch entladen — sobald /api/ps antwortet, übernommen."""
    with Umgebung() as u:
        _erster_lauf(u)
        u.ollama.ps_fehler = True
        b = _neustart(u, lade_abstand_s=0.0)
        n = u.liste.anlegen("probe", "b")

        def pruefe() -> None:
            u.warte(lambda: b.status()["warte"] == "abgleich", 5, "wartet auf den Abgleich")
            time.sleep(0.3)
            assert u.ollama.ladungen == [GROSS] and not u.ollama.entladen and b.status()["abgleich_offen"]
            u.ollama.ps_fehler = False
            u.warte(lambda: u.liste.zeilen[n]["status"] == "fertig", 10, "nach dem Abgleich übernommen")
            assert u.ollama.ladungen == [GROSS] and b.status()["uebernommen"]["modell"] == GROSS

        _mit(b, pruefe)


def test_periodisch_nur_uebernehmen_nie_entladen() -> None:
    """Nach dem Start-Abgleich wird nichts mehr entladen, was der Dienst nicht selbst führt — ein Messlauf im Container
    darf «gruendlich» selbst nutzen."""
    with Umgebung() as u:
        b = _neustart(u, lade_abstand_s=0.0)
        b.takt.abgleich = 0.05

        def pruefe() -> None:
            u.warte(lambda: not b.status()["abgleich_offen"], 5, "Start-Abgleich")
            u.ollama.geladen.add(KLEIN)          # ein Messlauf lädt das 12B
            time.sleep(0.4)
            assert KLEIN in u.ollama.geladen and KLEIN not in u.ollama.entladen

        _mit(b, pruefe)


def test_neustart_hauptmodell_auf_schnell_wird_entladen() -> None:
    """Auf der schnellen Instanz (GPU) rechnet das Hauptmodell nie (§2.6): ein Modell der Leiter dort wird beim Start
    entladen, die Modelle der Aufträge bleiben."""
    schnell = Attrappe()
    schnell.geladen = {GROSS, "gemma3:4b", "bge-m3:latest"}
    with Umgebung() as u:
        llm_schnell = Ollama(u.cfg, base_url=schnell.url, schleuse=True)
        try:
            b = _neustart(u, schnell=llm_schnell)
            _mit(b, lambda: u.warte(lambda: GROSS in schnell.entladen, 5, "Hauptmodell auf schnell entladen"))
            assert schnell.geladen == {"gemma3:4b", "bge-m3:latest"} and schnell.entladen == [GROSS]
        finally:
            llm_schnell.schliessen()
            schnell.schliessen()


def test_reste_entladen_ohne_hauptmodell() -> None:
    """Startet der Dienst ohne Hauptmodell (KI_HG_AKTIV=0), wird entladen, was der letzte Lauf geladen liess."""
    from app.hintergrund import reste_entladen

    with Umgebung() as u:
        _erster_lauf(u)
        assert reste_entladen(u.cfg, u.llm) == 1
        assert not u.ollama.geladen and not (Path(u.tmp.name) / "hg-geladen.json").exists()
        u.ollama.ps_fehler = True
        assert reste_entladen(u.cfg, u.llm) == 0, "ohne Antwort nichts, kein Fehler"


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
