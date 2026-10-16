"""Warteschlange: Herzschlag (Vertrag V1), Sync-Timeout, Umgang mit abgewiesenen Ergebnissen.

Läuft im Dienst-Image (braucht httpx), ohne FSM — Anfragen gehen an httpx.MockTransport:
  docker run --rm -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_worker.py
"""

from __future__ import annotations

import dataclasses
import sys
import threading
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


def test_fsm_ordnerliste_wird_gemerkt() -> None:
    # Review [5]: die FSM-Ordnerliste (aktive Ordner, Vererbung angewandt) kommt nur mit einem Ablage-Auftrag — der
    # Dienst merkt sie im Tresor (nur Pfade), damit der Probelauf mit derselben Liste messen kann (--ordner-datei).
    import json
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        cfg = dataclasses.replace(CFG, data_dir=Path(d))
        w = Worker(cfg, _FsmAttrappe(), llm=None, whisper=None, protokoll=None, zustand=Zustand())  # type: ignore[arg-type]
        w._merke_ordnerliste({"ordner": ["02_LOCATIONS", "02_LOCATIONS/01_Halle", {"pfad": "03_PROJEKTE"}], "mitarbeiter": ["geheim"]})
        datei = Path(d) / "fsm-ordnerliste.json"
        daten = json.loads(datei.read_text(encoding="utf-8"))
        assert daten["ordner"] == ["02_LOCATIONS", "02_LOCATIONS/01_Halle", "03_PROJEKTE"] and daten["anzahl"] == 3 and "zeit" in daten
        assert "geheim" not in datei.read_text(encoding="utf-8"), "nur Ordnerpfade, nichts anderes aus dem Kontext"
        stand = datei.stat().st_mtime_ns
        w._merke_ordnerliste({"ordner": ["02_LOCATIONS", "02_LOCATIONS/01_Halle", "03_PROJEKTE"]})
        assert datei.stat().st_mtime_ns == stand, "unveränderte Liste wird nicht neu geschrieben"
        w._merke_ordnerliste({"ordner": []})
        w._merke_ordnerliste({})
        assert json.loads(datei.read_text(encoding="utf-8"))["anzahl"] == 3, "leerer/fehlender Kontext überschreibt nichts"


class _ProtokollAttrappe:
    def __init__(self) -> None:
        self.eintraege: list[dict] = []

    def schreibe(self, art, quelle, dauer_ms, modell, ok, fehler=None, **kennzahlen) -> None:  # noqa: ANN001
        self.eintraege.append({"art": art, "quelle": quelle, "ok": ok, "fehler": fehler, **kennzahlen})


class _DateiFsm(_FsmAttrappe):
    def lade_datei(self, url, pfad, max_bytes):  # noqa: ANN001, ANN201
        pfad.write_bytes(b"Probe")
        return 5, "0" * 64


def test_protokoll_mit_kennzahlen_je_auftrag() -> None:
    # Leistung (15.10.): je Auftrag mit Dokument Seiten, Zeichen, gescannt, Teile ins Protokoll — nur Zahlen.
    import tempfile

    import app.worker as worker_modul
    from app.fsm import Auftrag
    from app.handlers import VerarbeitungsFehler

    alt = (worker_modul.ablage_analyse, worker_modul.beleg_analyse)

    def ablage(*, kennzahlen=None, **_kw):  # noqa: ANN001, ANN202
        kennzahlen.update(seiten=3, zeichen=4200, gescannt=True, teile=1)
        if _kw["dateiname"] == "kaputt.pdf":
            raise VerarbeitungsFehler("Modell weg")
        return {"modell": "gemma3:4b"}

    with tempfile.TemporaryDirectory() as d:
        cfg = dataclasses.replace(CFG, tmp_dir=Path(d))
        prot = _ProtokollAttrappe()
        w = Worker(cfg, _DateiFsm(), llm=None, whisper=None, protokoll=prot, zustand=Zustand())  # type: ignore[arg-type]
        worker_modul.ablage_analyse = ablage
        worker_modul.beleg_analyse = lambda **_kw: ({"ok": True, "issues": [], "extracted": {}}, "gemma3:4b")
        try:
            def auftrag(art: str, name: str) -> Auftrag:
                return Auftrag(id="a", art=art, payload={"file_name": name, "mime": "application/pdf"}, url="https://x/y")

            assert w._verarbeite(auftrag("ablage_analyse", "vertrag.pdf"))["ok"] is True
            assert w._verarbeite(auftrag("ablage_analyse", "kaputt.pdf"))["ok"] is False
            assert w._verarbeite(auftrag("beleg_analyse", "beleg.jpg"))["ok"] is True
        finally:
            worker_modul.ablage_analyse, worker_modul.beleg_analyse = alt
    a, k, b = prot.eintraege
    assert a == {"art": "ablage_analyse", "quelle": "fsm", "ok": True, "fehler": None,
                 "seiten": 3, "zeichen": 4200, "gescannt": True, "teile": 1}, a
    assert k["ok"] is False and (k["seiten"], k["zeichen"]) == (3, 4200), "auch fehlgeschlagene mit Dokument-Grösse"
    assert {x: b.get(x) for x in ("seiten", "zeichen", "gescannt", "teile")} == {"seiten": 1, "zeichen": None, "gescannt": True,
                                                                                "teile": 1}, b


# --- Leichte Spur (16.10.2026): Vorschau neben einem langen Auftrag --------------------------------------------------


class _Bestand:
    """Gemeinsame Warteschlange des FSM im Speicher (wie ki_auftraege): offen → beansprucht → gemeldet."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.offen: list = []
        self.angelegt: dict[str, float] = {}
        self.gemeldet: dict[str, float] = {}
        self.ergebnisse: dict[str, dict] = {}

    def neu(self, auftrag) -> None:  # noqa: ANN001
        with self.lock:
            self.offen.append(auftrag)
            self.angelegt[auftrag.id] = time.monotonic()


class _SyncFsm:
    """Ein FSM-Client wie FsmClient (eigene leichte_arten/naechster_poll_ms je Client). `kennt_nur` = FSM mit leichter
    Spur (Antwort nennt leichte_arten, &nur= beansprucht nur diese Arten); sonst altes FSM: «nur» wird ignoriert."""

    PRIO = {"diktat": 100, "vorschau": 95}

    def __init__(self, bestand: _Bestand, *, kennt_nur: bool = True) -> None:
        self.b = bestand
        self.kennt_nur = kennt_nur
        self.leichte_arten: tuple[str, ...] = ()
        self.naechster_poll_ms = None
        self.polls: list = []
        self.geholt: list[str] = []

    def hole_auftraege(self, herzschlag: dict, nur=None):  # noqa: ANN001, ANN201
        assert "arten" in herzschlag and "vorschau" in herzschlag["arten"], "volle Fähigkeiten in jedem Poll"
        with self.b.lock:
            self.polls.append(nur)
            self.leichte_arten = ("vorschau",) if self.kennt_nur else ()
            kandidaten = [a for a in self.b.offen if nur is None or not self.kennt_nur or a.art in nur]
            if not kandidaten:
                return []
            a = sorted(kandidaten, key=lambda x: -self.PRIO.get(x.art, 50))[0]
            self.b.offen.remove(a)
            self.geholt.append(a.id)
            return [a]

    def melde_ergebnisse(self, liste: list) -> None:
        with self.b.lock:
            for e in liste:
                self.b.gemeldet[e["id"]] = time.monotonic()
                self.b.ergebnisse[e["id"]] = e

    def herzschlag(self, werte: dict) -> None:
        pass

    def lade_datei(self, url, pfad, max_bytes):  # noqa: ANN001, ANN201
        pfad.write_bytes(b"%PDF-1.4 Probe")
        return 14, "0" * 64


class _Leicht:
    """Patcht ablage_analyse (lang), vorschau (kurz, zählt Gleichzeitigkeit) und diktat im Worker-Modul."""

    def __init__(self, lang_s: float = 2.0, vorschau_s: float = 0.3) -> None:
        import app.worker as wm

        self.wm = wm
        self.alt = (wm.ablage_analyse, wm.vorschau, wm.diktat, wm.beleg_analyse)
        self.lang_s, self.vorschau_s = lang_s, vorschau_s
        self.lock = threading.Lock()
        self.gleichzeitig = 0
        self.hoechstens = 0
        self.lang_lief = threading.Event()

    def __enter__(self) -> "_Leicht":
        def lang(**_kw):  # noqa: ANN003, ANN202
            self.lang_lief.set()
            time.sleep(self.lang_s)
            return {"modell": "gemma3:4b"}

        def vorschau(_payload, _cfg, _speicher):  # noqa: ANN001, ANN202
            with self.lock:
                self.gleichzeitig += 1
                self.hoechstens = max(self.hoechstens, self.gleichzeitig)
            time.sleep(self.vorschau_s)
            with self.lock:
                self.gleichzeitig -= 1
            return {"mime": "image/jpeg", "b64": "", "bytes": 0}

        self.wm.ablage_analyse, self.wm.vorschau = lang, vorschau
        self.wm.diktat = lambda **_kw: ({"text": "", "dauer_ms": 0}, "whisper")
        self.wm.beleg_analyse = lambda **_kw: ({"ok": True, "issues": [], "extracted": {}}, "gemma3:4b")
        return self

    def __exit__(self, *_a) -> None:
        self.wm.ablage_analyse, self.wm.vorschau, self.wm.diktat, self.wm.beleg_analyse = self.alt


def _auftrag(i: str, art: str):  # noqa: ANN202
    from app.fsm import Auftrag

    if art == "vorschau":
        return Auftrag(id=i, art=art, payload={"pfad": "A/b.pdf", "breite": 900})
    return Auftrag(id=i, art=art, payload={"file_name": f"{i}.pdf", "mime": "application/pdf"}, url="https://x.test/d")


def _lauf(*, mit_spur: bool, kennt_nur: bool = True, schwer_fuer_spur: bool = False):  # noqa: ANN202
    """Langer Auftrag (2 s), 0,3 s nach dem Beginn drei Vorschauen. Liefert (Bestand, Worker, main-FSM, Spur-FSM, Patch)."""
    import tempfile

    d = tempfile.mkdtemp()
    cfg = dataclasses.replace(CFG, data_dir=Path(d), tmp_dir=Path(d) / "tmp", poll_intervall_s=0.1)
    b = _Bestand()
    haupt = _SyncFsm(b, kennt_nur=kennt_nur)
    spur = _SyncFsm(b, kennt_nur=kennt_nur and not schwer_fuer_spur)
    p = _Leicht().__enter__()
    w = Worker(cfg, haupt, llm=None, whisper=None, protokoll=_ProtokollAttrappe(), zustand=Zustand(),  # type: ignore[arg-type]
               fsm_leicht=spur if mit_spur else None)  # type: ignore[arg-type]
    b.neu(_auftrag("lang", "ablage_analyse"))
    w.start()
    assert p.lang_lief.wait(5), "langer Auftrag läuft"
    time.sleep(0.3)
    for i in range(3):
        b.neu(_auftrag(f"v{i}", "vorschau"))
    return b, w, haupt, spur, p


def _warte_bis(bedingung, s: float, was: str) -> None:  # noqa: ANN001
    frist = time.monotonic() + s
    while time.monotonic() < frist:
        if bedingung():
            return
        time.sleep(0.02)
    raise AssertionError(f"Zeitüberschreitung: {was}")


def test_leichte_spur_vorschau_neben_langem_auftrag() -> None:
    """Wartende haben Vorrang: drei Hover-Vorschauen während einer langen Ablage kommen zurück, BEVOR die Ablage fertig
    ist — höchstens zwei gleichzeitig; die Ablage selbst läuft unberührt weiter."""
    b, w, haupt, spur, p = _lauf(mit_spur=True)
    try:
        _warte_bis(lambda: "lang" in b.gemeldet and all(f"v{i}" in b.gemeldet for i in range(3)), 10, "alles gemeldet")
        assert all(b.gemeldet[f"v{i}"] < b.gemeldet["lang"] for i in range(3)), "Vorschauen vor dem Ende der Ablage"
        latenz = [b.gemeldet[f"v{i}"] - b.angelegt[f"v{i}"] for i in range(3)]
        assert max(latenz) < 1.2, latenz
        assert p.hoechstens == 2, f"höchstens zwei gleichzeitig, hier {p.hoechstens}"
        assert all(n == ("vorschau",) for n in spur.polls) and spur.polls, "die Spur fragt nur nach Vorschauen"
        assert all(n is None for n in haupt.polls), "der Worker holt wie bisher alles"
        assert b.ergebnisse["lang"]["ok"] and all(b.ergebnisse[f"v{i}"]["ok"] for i in range(3))
        st = w.leicht.status()
        assert st["bearbeitet"] == 3 and st["nicht_gemeldet"] == 0 and st["fsm_kennt"] == ["vorschau"]
        assert w.zustand.lies("verarbeitet") == 4 and w.zustand.lies("leicht_laeuft") == 0
    finally:
        w.stop()
        w.join(timeout=5)
        p.__exit__()


def test_ohne_leichte_spur_wartet_die_vorschau_bis_zum_ende() -> None:
    """Der Stand vorher (ein Worker, der Reihe nach): die Vorschauen kommen erst nach der langen Ablage."""
    b, w, _haupt, _spur, p = _lauf(mit_spur=False)
    try:
        _warte_bis(lambda: all(f"v{i}" in b.gemeldet for i in range(3)), 10, "alles gemeldet")
        assert all(b.gemeldet[f"v{i}"] > b.gemeldet["lang"] for i in range(3))
        assert p.hoechstens == 1 and w.leicht is None
    finally:
        w.stop()
        w.join(timeout=5)
        p.__exit__()


def test_leichte_spur_fragt_nicht_bei_altem_fsm_und_nicht_im_leerlauf() -> None:
    """Nennt das FSM keine leichten Arten (altes FSM), fragt die Spur nie — sonst bekäme sie einen beliebigen Auftrag. Ist
    der Worker frei, fragt sie ebenfalls nicht (er holt selbst ab)."""
    b, w, _haupt, spur, p = _lauf(mit_spur=True, kennt_nur=False)
    try:
        _warte_bis(lambda: all(f"v{i}" in b.gemeldet for i in range(3)), 10, "alles gemeldet")
        assert spur.polls == [] and all(b.gemeldet[f"v{i}"] > b.gemeldet["lang"] for i in range(3))
    finally:
        w.stop()
        w.join(timeout=5)
        p.__exit__()
    b, w, _haupt, spur, p = _lauf(mit_spur=True)
    try:
        _warte_bis(lambda: "lang" in b.gemeldet and all(f"v{i}" in b.gemeldet for i in range(3)), 10, "alles gemeldet")
        vorher = len(spur.polls)
        time.sleep(0.5)
        assert len(spur.polls) == vorher, "im Leerlauf fragt nur der Worker"
    finally:
        w.stop()
        w.join(timeout=5)
        p.__exit__()


def test_leichte_spur_uebergibt_einen_schweren_auftrag_dem_worker() -> None:
    """FSM zurückgerollt (ignoriert «nur», nennt keine leichten Arten): bekommt die Spur doch einen anderen Auftrag, ist er
    schon beansprucht — sie übergibt ihn dem Worker (nach dem laufenden) und fragt danach nicht mehr."""
    import tempfile

    d = tempfile.mkdtemp()
    cfg = dataclasses.replace(CFG, data_dir=Path(d), tmp_dir=Path(d) / "tmp", poll_intervall_s=0.1)
    b = _Bestand()
    haupt, spur = _SyncFsm(b), _SyncFsm(b, kennt_nur=False)
    with _Leicht() as p:
        w = Worker(cfg, haupt, llm=None, whisper=None, protokoll=_ProtokollAttrappe(), zustand=Zustand(),  # type: ignore[arg-type]
                   fsm_leicht=spur)  # type: ignore[arg-type]
        b.neu(_auftrag("lang", "ablage_analyse"))
        b.neu(_auftrag("b1", "beleg_analyse"))   # gleiche Priorität, später: der Worker nimmt zuerst «lang»
        w.start()
        try:
            assert p.lang_lief.wait(5)
            _warte_bis(lambda: "b1" in b.gemeldet, 10, "Beleg vom Worker bearbeitet")
            assert spur.geholt == ["b1"] and spur.polls == [("vorschau",)], (spur.geholt, spur.polls)
            assert b.gemeldet["b1"] >= b.gemeldet["lang"] and b.ergebnisse["b1"]["ok"], "nach dem laufenden, vom Worker"
            time.sleep(0.3)
            assert len(spur.polls) == 1, "danach fragt die Spur nicht mehr, bis das FSM sie wieder nennt"
        finally:
            w.stop()
            w.join(timeout=5)


def test_zustand_ruhig_zaehlt_die_leichte_spur() -> None:
    z = Zustand()
    assert z.ruhig(0)
    z.leicht_beginnt()
    assert not z.ruhig(0) and z.bild()["leicht_laeuft"] == 1 and z.lies("laeuft") is None
    z.leicht_endet()
    assert z.ruhig(0) and not z.ruhig(60), "das Ende zählt als letzte Arbeit"
    z.erhoehe("verarbeitet")
    assert z.lies("verarbeitet") == 1


def test_fsm_client_nur_und_leichte_arten() -> None:
    from app.fsm import arten_aus

    gesehen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        gesehen.append(req)
        return httpx.Response(200, json={"success": True, "auftraege": [], "leichte_arten": ["vorschau", "x" * 50, 3]})

    c = _client_mit(handler)
    c.hole_auftraege({"modell": "m", "arten": "vorschau"}, nur=("vorschau",))
    assert dict(gesehen[0].url.params) == {"modell": "m", "arten": "vorschau", "nur": "vorschau"}
    assert c.leichte_arten == ("vorschau",)
    c.hole_auftraege({"modell": "m"})
    assert "nur" not in dict(gesehen[1].url.params)
    assert arten_aus(None) == () and arten_aus("vorschau") == () and arten_aus(["a_b", "a_b"]) == ("a_b",)


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
