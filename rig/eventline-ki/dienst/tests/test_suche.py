"""Inhaltssuche und «Frag das Archiv» (E2.6) ohne Datenbank und ohne Modell: Schema (nie Abschnittstext), RRF,
je Datei die beste Stelle, fester Satz ohne Fundstelle, Arten im Herzschlag (MP-1), adaptiver Abholtakt (MP-2),
Schalter. Läuft im Dienst-Image ohne Netz:

  docker run --rm --network none -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_suche.py
"""

from __future__ import annotations

import dataclasses
import json
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.archiv_frage import KEINE_FUNDSTELLE, MIN_AEHNLICHKEIT, SCHEMA, archiv_frage, quellen_aus  # noqa: E402
from app.config import laden  # noqa: E402
from app.fsm import Auftrag, FsmClient, poll_ms_aus  # noqa: E402
from app.handlers import VerarbeitungsFehler  # noqa: E402
from app.llm import LlmFehler  # noqa: E402
from app.suche import TREFFER_FELDER, Stelle, Suche, je_datei, lies_limit, lies_text, nas_suche, vereine  # noqa: E402
from app.tiefe import Fund  # noqa: E402
from app.worker import ARTEN_MIT_DATEI, Worker, Zustand, arten_aktiv, pause_leer  # noqa: E402

CFG = dataclasses.replace(laden(), fsm_url="https://fsm.test", proxy=None, sync_token="t" * 64)
ZH = ZoneInfo("Europe/Zurich")
GEHEIM = "GEHEIMER-ABSCHNITTSTEXT"


class _Index:
    """Attrappe: zwei Listen (Vektor, Volltext) und Abschnittstexte, die nie in einem Suchergebnis stehen dürfen."""

    aktiv = True

    def __init__(self, vektor: list[Fund], volltext: list[Fund], fehler: Exception | None = None) -> None:
        self.vektor = vektor
        self.volltext = volltext
        self.fehler = fehler
        self.anfragen: list[str] = []

    def vektor_treffer(self, vektor, rezept, k):  # noqa: ANN001, ANN201
        if self.fehler:
            raise self.fehler
        return self.vektor[:k]

    def text_treffer(self, anfrage, rezept, k):  # noqa: ANN001, ANN201
        self.anfragen.append(anfrage)
        if self.fehler:
            raise self.fehler
        return self.volltext[:k]

    def abschnitt_texte(self, ids):  # noqa: ANN001, ANN201
        return {i: f"{GEHEIM} {i}: Die Kündigungsfrist beträgt sechs Monate." for i in ids}

    def zaehler(self, max_alter_s: float = 0.0) -> dict[str, int]:
        return {"dateien": 50, "mit_text": 40, "abschnitte": 900}


class _Llm:
    def __init__(self, antwort: dict | None = None, einbettung_fehler: bool = False) -> None:
        self.antwort = antwort
        self.einbettung_fehler = einbettung_fehler
        self.keep_alive: list = []
        self.chats: list[dict] = []

    def einbetten(self, *, modell, texte, timeout_s=120.0, keep_alive=None):  # noqa: ANN001, ANN201
        self.keep_alive.append(keep_alive)
        if self.einbettung_fehler:
            raise LlmFehler("Einbettungsmodell bge-m3 hat nicht rechtzeitig geantwortet")
        return [[1.0, 0.0] for _ in texte], {"modell": modell}

    def geladene_modelle(self) -> list[dict]:
        return []

    def entlade(self, modell=None) -> None:  # noqa: ANN001
        pass

    def chat_json(self, **kw):  # noqa: ANN003, ANN201
        self.chats.append(kw)
        if self.antwort is None:
            raise AssertionError("kein Modellaufruf erwartet")
        return self.antwort, {"dauer_ms": 5}


def _suche(index: _Index, llm: _Llm, stunde: int = 10) -> Suche:
    return Suche(CFG, index, llm, stand=lambda: {"nas_dateien": 100},  # type: ignore[arg-type]
                 uhr=lambda: datetime(2026, 10, 12, stunde, 0, tzinfo=ZH))


VEKTOR = [
    Fund(11, "02_LOCATIONS/Volkshaus/Mietvertrag_2025.pdf", 3, 0.71),
    Fund(12, "02_LOCATIONS/Volkshaus/Mietvertrag_2025.pdf", 5, 0.69),
    Fund(20, "00_ADMIN_RECHT/03_Dauervertraege/Leasing.pdf", 2, 0.55),
    Fund(30, "99_System/papierkorb/alt.pdf", 1, 0.54),
    Fund(40, "ZZ_Dokumente_zum_Einsortieren/Scan_0042.pdf", None, 0.50),
]
VOLLTEXT = [
    Fund(20, "00_ADMIN_RECHT/03_Dauervertraege/Leasing.pdf", 2, 0.4),
    Fund(11, "02_LOCATIONS/Volkshaus/Mietvertrag_2025.pdf", 3, 0.3),
    Fund(50, "06_PERSONAL/0001_Anna_Muster/Arbeitsvertrag.pdf", 1, 0.1),
]


# --- Suche ----------------------------------------------------------------------------------------


def test_eingaben() -> None:
    assert lies_text("  Miete Volkshaus ", 2, 200) == "Miete Volkshaus"
    assert lies_text("a", 2, 200) is None and lies_text("x" * 201, 2, 200) is None and lies_text(5, 2, 200) is None
    assert lies_limit(None) == 20 and lies_limit(3) == 3 and lies_limit(999) == 50 and lies_limit(0) == 1 and lies_limit(True) == 20


def test_rrf_und_je_datei() -> None:
    stellen = vereine(VEKTOR, VOLLTEXT)
    assert stellen[0].id in (11, 20) and {stellen[0].id, stellen[1].id} == {11, 20}, "in beiden Listen = vorne"
    assert all(a.rrf >= b.rrf for a, b in zip(stellen, stellen[1:]))
    s50 = next(s for s in stellen if s.id == 50)
    assert s50.aehnlichkeit is None and s50.im_volltext
    treffer = je_datei(stellen, 20)
    pfade = [t["pfad"] for t in treffer]
    assert len(pfade) == len(set(pfade)), "je Datei nur die beste Stelle"
    assert not any(p.startswith("99_System/") for p in pfade), "99_System nie"
    miete = next(t for t in treffer if t["pfad"].endswith("Mietvertrag_2025.pdf"))
    assert miete["seite"] == 3, "Seite der besten Stelle"
    assert all(set(t) == set(TREFFER_FELDER) for t in treffer)
    assert all(0.0 < t["score"] <= 1.0 for t in treffer) and treffer[0]["score"] > 0.9
    assert je_datei(stellen, 2) == treffer[:2]
    # Rang 1 in beiden Listen = score 1.
    assert je_datei(vereine([Fund(1, "a/x.pdf", 1, 0.9)], [Fund(1, "a/x.pdf", 1, 0.9)]), 5)[0]["score"] == 1.0


def test_nas_suche_schema_ohne_text() -> None:
    idx, llm = _Index(VEKTOR, VOLLTEXT), _Llm()
    e = nas_suche({"q": "Kündigungsfrist Miete", "limit": 20}, _suche(idx, llm))
    assert set(e) == {"treffer", "index", "dauer_ms"}, e.keys()
    assert e["index"] == {"dateien": 50, "gelesen_anteil": 0.5}
    assert all(set(t) == {"pfad", "seite", "score"} for t in e["treffer"])
    roh = json.dumps(e, ensure_ascii=False)
    assert GEHEIM not in roh and "Kündigungsfrist" not in roh, "nie Abschnittstext, nie der Suchbegriff"
    assert llm.keep_alive == ["2h"], "tagsüber bleibt bge-m3 2 h warm"
    _ = nas_suche({"q": "Miete"}, _suche(idx, llm, stunde=22))
    assert llm.keep_alive[-1] is None, "nachts Standard-keep_alive"


def test_nas_suche_fehler() -> None:
    idx, llm = _Index(VEKTOR, VOLLTEXT), _Llm()
    for payload in ({}, {"q": "x"}, {"q": "y" * 201}, {"q": 42}):
        try:
            nas_suche(payload, _suche(idx, llm))
            raise AssertionError(f"{payload}: Fehler erwartet")
        except VerarbeitungsFehler as e:
            assert "Zeichen" in str(e)
    # Einbettung nicht verfügbar → nur Volltext, kein Fehler.
    e = nas_suche({"q": "Leasing"}, _suche(idx, _Llm(einbettung_fehler=True)))
    assert [t["pfad"] for t in e["treffer"]] == [f.pfad for f in VOLLTEXT]
    # Datenbank weg → Klartext ohne Inhalte.
    try:
        nas_suche({"q": "Leasing Kopierer"}, _suche(_Index([], [], fehler=ConnectionError("x")), llm))
        raise AssertionError("Fehler erwartet")
    except VerarbeitungsFehler as e:
        assert "Leasing" not in str(e) and "Datenbank" in str(e)
    # Leerer Index → leere Liste, kein Fehler.
    e = nas_suche({"q": "nichts"}, _suche(_Index([], []), llm))
    assert e["treffer"] == []


# --- Frag das Archiv ------------------------------------------------------------------------------


def test_archiv_frage_ohne_fundstelle() -> None:
    llm = _Llm(antwort=None)
    e, modell = archiv_frage({"frage": "Wie lange ist die Kündigungsfrist?"}, _suche(_Index([], []), llm), llm, CFG)  # type: ignore[arg-type]
    assert e["antwort"] == KEINE_FUNDSTELLE and e["quellen"] == [] and modell is None and llm.chats == []
    # Nur schwache Vektor-Treffer, kein Volltext → fester Satz ohne Modellaufruf.
    schwach = [Fund(1, "a/b.pdf", 1, MIN_AEHNLICHKEIT - 0.05)]
    e2, _ = archiv_frage({"frage": "Wer ist der Vermieter?"}, _suche(_Index(schwach, []), llm), llm, CFG)  # type: ignore[arg-type]
    assert e2["antwort"] == KEINE_FUNDSTELLE and llm.chats == []
    # Modell schreibt den festen Satz (auch abgewandelt) oder nichts → fester Satz, keine Quellen.
    for roh in ({"antwort": "Dazu finde ich im Archiv nichts", "quellen": [1]}, {"antwort": "  ", "quellen": [2]},
                {"antwort": "Leider: dazu finde ich im Archiv nichts.", "quellen": []}):
        llm3 = _Llm(antwort=roh)
        e3, m3 = archiv_frage({"frage": "Wer ist der Vermieter?"}, _suche(_Index(VEKTOR, VOLLTEXT), llm3), llm3, CFG)  # type: ignore[arg-type]
        assert e3["antwort"] == KEINE_FUNDSTELLE and e3["quellen"] == [] and len(llm3.chats) == 1, roh
    assert SCHEMA["required"][0] == "antwort", "Antwort zuerst (kein «gefunden»-Feld davor, gemessen 2026-10-11)"


def test_archiv_frage_antwort_und_quellen() -> None:
    llm = _Llm(antwort={"antwort": "Die Kündigungsfrist beträgt sechs Monate (ß).", "quellen": [2, 2, 9, 1]})
    e, modell = archiv_frage({"frage": "Wie lange ist die Kündigungsfrist?"}, _suche(_Index(VEKTOR, VOLLTEXT), llm), llm, CFG)  # type: ignore[arg-type]
    assert set(e) == {"antwort", "quellen", "modell", "dauer_ms"}
    assert modell == CFG.modell_text == e["modell"], "immer das schnelle Modell (E1), nie das Hauptmodell"
    assert e["antwort"].endswith("(ss).") and GEHEIM not in e["antwort"]
    assert all(set(q) == {"pfad", "seite"} for q in e["quellen"]) and 1 <= len(e["quellen"]) <= 8
    assert not any(q["pfad"].startswith("99_System/") for q in e["quellen"])
    kw = llm.chats[0]
    assert kw["modell"] == CFG.modell_text and kw["num_ctx"] == CFG.llm_num_ctx, "gleiches Kontextfenster = kein Neuladen"
    assert GEHEIM in kw["nutzer"], "die Auszüge gehen nur an das lokale Modell"
    assert len(e["antwort"]) <= 4000


def test_quellen_aus() -> None:
    benutzt = [Stelle(1, "a/x.pdf", 2, 0.1, 0.7, True), Stelle(2, "a/x.pdf", 2, 0.09, 0.6, False),
               Stelle(3, "b/y.pdf", None, 0.08, 0.6, False), Stelle(4, "c/z.pdf", 7, 0.07, 0.5, True)]
    assert quellen_aus([1, 2, 3], benutzt) == [{"pfad": "a/x.pdf", "seite": 2}, {"pfad": "b/y.pdf", "seite": None}]
    assert quellen_aus([], benutzt) == [{"pfad": "a/x.pdf", "seite": 2}, {"pfad": "b/y.pdf", "seite": None}], "ohne Nummern: die besten drei"
    assert quellen_aus([True, 0, 99, "1"], benutzt)[0] == {"pfad": "a/x.pdf", "seite": 2}


def test_frage_ungueltig() -> None:
    llm = _Llm()
    for frage in (None, "ab", "x" * 501):
        try:
            archiv_frage({"frage": frage}, _suche(_Index([], []), llm), llm, CFG)  # type: ignore[arg-type]
            raise AssertionError("Fehler erwartet")
        except VerarbeitungsFehler:
            pass


# --- Worker: Arten (MP-1), Takt (MP-2), Schalter --------------------------------------------------


def test_arten_im_herzschlag() -> None:
    assert arten_aktiv(CFG) == ARTEN_MIT_DATEI == ("ablage_analyse", "beleg_analyse", "warenkorb_analyse", "diktat")
    an = dataclasses.replace(CFG, suche_aktiv=True, archiv_frage_aktiv=True)
    assert arten_aktiv(an) == ARTEN_MIT_DATEI + ("nas_suche", "archiv_frage")
    assert arten_aktiv(dataclasses.replace(CFG, archiv_frage_aktiv=True))[-1] == "archiv_frage"
    w = Worker(CFG, None, llm=None, whisper=None, protokoll=None, zustand=Zustand())  # type: ignore[arg-type]
    assert w._herzschlag_werte()["arten"] == "ablage_analyse,beleg_analyse,warenkorb_analyse,diktat"


def test_takt() -> None:
    assert pause_leer(CFG, None) == CFG.poll_intervall_s
    assert pause_leer(CFG, 300) == 0.3 and pause_leer(CFG, 100) == 0.25, "Untergrenze 250 ms"
    assert pause_leer(CFG, 60_000) == CFG.poll_intervall_s, "nie langsamer als normal"
    assert poll_ms_aus(300) == 300 and poll_ms_aus(None) is None and poll_ms_aus(0) is None
    assert poll_ms_aus("300") is None and poll_ms_aus(True) is None and poll_ms_aus(-5) is None


def test_fsm_liest_naechster_poll_ms() -> None:
    antworten = [{"success": True, "auftraege": [], "naechster_poll_ms": 300}, {"success": True, "auftraege": []}]
    gesehen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        gesehen.append(req)
        return httpx.Response(200, json=antworten[len(gesehen) - 1])

    c = FsmClient(CFG)
    c._sync._transport = httpx.MockTransport(handler)
    c.hole_auftraege({"modell": "m", "arten": "ablage_analyse,diktat,nas_suche"})
    assert c.naechster_poll_ms == 300
    assert dict(gesehen[0].url.params)["arten"] == "ablage_analyse,diktat,nas_suche"
    c.hole_auftraege({"modell": "m"})
    assert c.naechster_poll_ms is None, "Feld fehlt → normaler Takt"


class _Protokoll:
    def __init__(self) -> None:
        self.eintraege: list[tuple] = []

    def schreibe(self, *a) -> None:  # noqa: ANN002
        self.eintraege.append(a)


def test_worker_arten_ohne_datei() -> None:
    p = _Protokoll()
    idx, llm = _Index(VEKTOR, VOLLTEXT), _Llm()
    aus = Worker(CFG, None, llm=llm, whisper=None, protokoll=p, zustand=Zustand(), suche=_suche(idx, llm))  # type: ignore[arg-type]
    r = aus._verarbeite(Auftrag.aus({"id": "a1", "art": "nas_suche", "payload": {"q": "Miete Volkshaus", "limit": 5}}))
    assert r["ok"] is False and "nicht eingeschaltet" in r["fehler"] and "Miete" not in r["fehler"], "Schalter aus = abgewiesen"
    an = dataclasses.replace(CFG, suche_aktiv=True, archiv_frage_aktiv=True)
    w = Worker(an, None, llm=llm, whisper=None, protokoll=p, zustand=Zustand(), suche=_suche(idx, llm))  # type: ignore[arg-type]
    r = w._verarbeite(Auftrag.aus({"id": "a2", "art": "nas_suche", "payload": {"q": "Miete Volkshaus", "limit": 5}}))
    assert r["ok"] is True and set(r["ergebnis"]) == {"treffer", "index", "dauer_ms"} and len(r["ergebnis"]["treffer"]) <= 5
    llm.antwort = {"antwort": "Sechs Monate.", "quellen": [1]}
    r2 = w._verarbeite(Auftrag.aus({"id": "a3", "art": "archiv_frage", "payload": {"frage": "Kündigungsfrist Volkshaus?"}}))
    assert r2["ok"] is True and r2["ergebnis"]["antwort"] == "Sechs Monate."
    # Protokoll: Art, Quelle, Dauer, Modell, ok — nie Suchbegriff oder Frage.
    assert all("Miete" not in str(e) and "Kündigungsfrist" not in str(e) for e in p.eintraege), p.eintraege
    # Ohne Tiefen-Index (suche=None) → Klartext-Fehler.
    w2 = Worker(an, None, llm=llm, whisper=None, protokoll=p, zustand=Zustand())  # type: ignore[arg-type]
    r3 = w2._verarbeite(Auftrag.aus({"id": "a4", "art": "archiv_frage", "payload": {"frage": "abc?"}}))
    assert r3["ok"] is False and "nicht verfügbar" in r3["fehler"]
    # Phase-3-Arten gibt es nicht mehr (MP-9): unbekannt.
    r4 = w2._verarbeite(Auftrag.aus({"id": "a5", "art": "fristen_scan", "payload": {}}))
    assert r4["ok"] is False and "Unbekannte Auftragsart" in r4["fehler"]


def test_einbettung_tagsueber_warm_nur_mit_suche() -> None:
    # Befund Review E2: Ablage/Index-Stapel setzten bge-m3 auf 5 min zurück — mit Suche an tagsüber «2h» für alle.
    import app.llm as llm_modul

    alt = llm_modul.tagsueber_zuerich
    gesendet: list[dict] = []

    def antwort(req: httpx.Request) -> httpx.Response:
        gesendet.append(json.loads(req.content))
        return httpx.Response(200, json={"embeddings": [[1.0, 0.0]], "model": "bge-m3"})

    try:
        for suche_an, tag, erwartet in ((False, True, CFG.keep_alive), (True, True, "2h"), (True, False, CFG.keep_alive)):
            llm_modul.tagsueber_zuerich = lambda tag=tag: tag
            o = llm_modul.Ollama(dataclasses.replace(CFG, suche_aktiv=suche_an))
            o._client = httpx.Client(base_url="http://ollama.test", transport=httpx.MockTransport(antwort))
            o.einbetten(modell=CFG.modell_embed, texte=["x"])
            assert gesendet[-1]["keep_alive"] == erwartet, (suche_an, tag, gesendet[-1]["keep_alive"])
            o.einbetten(modell=CFG.modell_embed, texte=["x"], keep_alive="7m")
            assert gesendet[-1]["keep_alive"] == "7m", "ausdrücklicher Wert gilt"
            o._client.close()
    finally:
        llm_modul.tagsueber_zuerich = alt


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
