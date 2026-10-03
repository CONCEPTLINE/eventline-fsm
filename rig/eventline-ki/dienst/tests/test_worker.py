"""Warteschlange: Herzschlag (Vertrag V1), Sync-Timeout, Umgang mit abgewiesenen Ergebnissen.

Läuft im Dienst-Image (braucht httpx), ohne FSM — Anfragen gehen an httpx.MockTransport:
  docker run --rm -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_worker.py
"""

from __future__ import annotations

import dataclasses
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import laden  # noqa: E402
from app.fsm import SYNC_TIMEOUT_S, FsmAbgelehnt, FsmClient, FsmFehler  # noqa: E402
from app.worker import Herzschlag, Worker, Zustand  # noqa: E402

CFG = dataclasses.replace(laden(), fsm_url="https://fsm.test", proxy=None, sync_token="t" * 64)


def _client_mit(handler) -> FsmClient:
    """Echter FsmClient (Header, Basis-URL, Timeouts) — nur die Leitung ist eine Attrappe."""
    c = FsmClient(CFG)
    c._sync._transport = httpx.MockTransport(handler)
    c._puls._transport = httpx.MockTransport(handler)
    return c


def test_sync_timeout_90s() -> None:
    c = FsmClient(CFG)
    assert SYNC_TIMEOUT_S == 90.0
    assert c._sync.timeout.read == 90.0 and c._sync.timeout.connect == 10.0
    assert c._puls.timeout.read < 20.0, "Herzschlag darf den nächsten nicht überholen"


def test_herzschlag_anfrage() -> None:
    gesehen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        gesehen.append(req)
        return httpx.Response(200, json={"success": True, "auftraege": []})

    _client_mit(handler).herzschlag({"modell": "m", "version": "v", "gpu": "RTX|5000", "warteschlange": "1"})
    req = gesehen[0]
    assert req.method == "GET" and req.url.path == "/api/ki/sync"
    q = dict(req.url.params)
    assert q == {"modell": "m", "version": "v", "gpu": "RTX|5000", "warteschlange": "1", "nur_herzschlag": "1"}, q
    assert req.headers["authorization"] == "Bearer " + "t" * 64


def test_melden_status() -> None:
    def mit(status: int):
        return _client_mit(lambda _req: httpx.Response(status, json={"success": status < 400}))

    mit(200).melde_ergebnisse([{"id": "x", "ok": True}])
    for status in (400, 404, 413, 422):
        try:
            mit(status).melde_ergebnisse([{"id": "x", "ok": True}])
            raise AssertionError(f"{status}: FsmAbgelehnt erwartet")
        except FsmAbgelehnt:
            pass
    for status in (401, 408, 429, 500, 503):
        try:
            mit(status).melde_ergebnisse([{"id": "x", "ok": True}])
            raise AssertionError(f"{status}: FsmFehler erwartet")
        except FsmAbgelehnt:
            raise AssertionError(f"{status}: darf nicht als endgültig gelten") from None
        except FsmFehler:
            pass


class _FsmAttrappe:
    def __init__(self, fehler: Exception | None = None) -> None:
        self.fehler = fehler
        self.pulse: list[dict] = []
        self.meldungen: list[list] = []

    def herzschlag(self, werte: dict) -> None:
        self.pulse.append(werte)

    def melde_ergebnisse(self, liste: list) -> None:
        self.meldungen.append(liste)
        if self.fehler:
            raise self.fehler


def test_herzschlag_nur_waehrend_auftrag() -> None:
    fsm = _FsmAttrappe()
    zustand = Zustand()
    h = Herzschlag(fsm, zustand, lambda: {"modell": "m"})  # type: ignore[arg-type]
    h.start()
    try:
        time.sleep(1.6)
        assert fsm.pulse == [], "ohne laufenden Auftrag kein Herzschlag"
        zustand.setze(laeuft="ablage_analyse", letzter_kontakt=time.monotonic() - 25)
        time.sleep(1.6)
        assert len(fsm.pulse) == 1, fsm.pulse
        time.sleep(1.6)
        assert len(fsm.pulse) == 1, "frühestens 20 s nach dem letzten Kontakt wieder"
        zustand.setze(letzter_kontakt=time.monotonic() - 21)
        time.sleep(1.6)
        assert len(fsm.pulse) == 2, fsm.pulse
        assert zustand.lies("letzter_poll") is not None
    finally:
        h.stop()
        h.join(timeout=3)


def _worker(fsm) -> Worker:
    return Worker(CFG, fsm, llm=None, whisper=None, protokoll=None, zustand=Zustand())  # type: ignore[arg-type]


def test_abgewiesenes_ergebnis_wird_verworfen() -> None:
    w = _worker(_FsmAttrappe(FsmAbgelehnt("HTTP 400")))
    w._melde({"id": "a", "ok": True})
    assert w._ausstehend == []


def test_voruebergehender_fehler_wird_nachgemeldet() -> None:
    fsm = _FsmAttrappe(FsmFehler("HTTP 503"))
    w = _worker(fsm)
    w._melde({"id": "a", "ok": True})
    assert [e["id"] for e in w._ausstehend] == ["a"]
    w._nachmelden()  # scheitert erneut → bleibt, nächster Versuch frühestens in 30 s
    assert len(w._ausstehend) == 1 and len(fsm.meldungen) == 2
    w._nachmelden()
    assert len(fsm.meldungen) == 2, "Nachmelden darf nicht im Sekundentakt wiederholen"
    fsm.fehler = None
    w._naechstes_nachmelden = 0.0
    w._nachmelden()
    assert w._ausstehend == [] and len(fsm.meldungen) == 3


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
