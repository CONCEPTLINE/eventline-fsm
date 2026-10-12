"""Inhaltssuche und «Frag das Archiv» (E2.6) ohne Datenbank und ohne Modell: Schema (nie Abschnittstext), RRF,
je Datei die beste Stelle, fester Satz ohne Fundstelle, Arten im Herzschlag (MP-1), adaptiver Abholtakt (MP-2),
Schalter, Kaltstart-Rückfall auf Volltext (Suche) bzw. volle Ladefrist («Frag das Archiv»), Vorladen beim Wach-Impuls,
Mindest-Ähnlichkeit mit Wort-Anker oder dichter Nachbarschaft. Läuft im Dienst-Image ohne Netz:

  docker run --rm --network none -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_suche.py
"""

from __future__ import annotations

import dataclasses
import json
import sys
import time
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
import app.suche as suche_modul  # noqa: E402
from app.gpu import SCHLEUSE  # noqa: E402
from app.llm import tag_keep_alive  # noqa: E402
from app.suche import (  # noqa: E402
    MIN_AEHNLICHKEIT as SUCHE_SCHWELLE, TREFFER_FELDER, Stelle, Suche, filtere, je_datei, lies_limit, lies_text, nas_suche,
    vereine,
)
from app.tiefe import Fund  # noqa: E402
from app.worker import ARTEN_MIT_DATEI, Worker, Zustand, arten_aktiv, pause_leer  # noqa: E402

CFG = dataclasses.replace(laden(), fsm_url="https://fsm.test", proxy=None, sync_token="t" * 64)
ZH = ZoneInfo("Europe/Zurich")
GEHEIM = "GEHEIMER-ABSCHNITTSTEXT"


class _Index:
    """Attrappe: zwei Listen (Vektor, Volltext) und Abschnittstexte, die nie in einem Suchergebnis stehen dürfen."""

    aktiv = True

    def __init__(self, vektor: list[Fund], volltext: list[Fund], fehler: Exception | None = None, woerter: bool = True) -> None:
        self.vektor = vektor
        self.volltext = volltext
        self.fehler = fehler
        self.woerter = woerter   # kommt ein Wort der Anfrage im Index vor (Wort-Anker)?
        self.anfragen: list[str] = []
        self.anker_fragen = 0

    def vektor_treffer(self, vektor, rezept, k):  # noqa: ANN001, ANN201
        if self.fehler:
            raise self.fehler
        return self.vektor[:k]

    def text_treffer(self, anfrage, rezept, k):  # noqa: ANN001, ANN201
        self.anfragen.append(anfrage)
        if self.fehler:
            raise self.fehler
        return self.volltext[:k]

    def kennt_woerter(self, anfrage, rezept):  # noqa: ANN001, ANN201
        self.anker_fragen += 1
        return self.woerter

    def abschnitt_texte(self, ids):  # noqa: ANN001, ANN201
        return {i: f"{GEHEIM} {i}: Die Kündigungsfrist beträgt sechs Monate." for i in ids}

    def zaehler(self, max_alter_s: float = 0.0) -> dict[str, int]:
        return {"dateien": 50, "mit_text": 40, "abschnitte": 900}


class _Llm:
    def __init__(self, antwort: dict | None = None, einbettung_fehler: bool = False, laden_s: float = 0.0) -> None:
        self.antwort = antwort
        self.einbettung_fehler = einbettung_fehler
        self.laden_s = laden_s          # Kaltstart: die erste Einbettung wartet so lange (Modell lädt)
        self.keep_alive: list = []
        self.chats: list[dict] = []
        self.geladen: list[dict] | None = []
        self.vorgeladen: list = []
        self.vorladen_wert: int | None = 1800

    def einbetten(self, *, modell, texte, timeout_s=120.0, keep_alive=None):  # noqa: ANN001, ANN201
        if self.laden_s:
            time.sleep(self.laden_s)
            self.laden_s = 0.0
        self.keep_alive.append(keep_alive)
        if self.einbettung_fehler:
            raise LlmFehler("Einbettungsmodell bge-m3 hat nicht rechtzeitig geantwortet")
        return [[1.0, 0.0] for _ in texte], {"modell": modell}

    def geladene_modelle(self) -> list[dict]:
        return self.geladen or []

    def geladene_modelle_oder_none(self) -> list[dict] | None:
        return self.geladen

    def vorladen(self, *, modell, keep_alive=None, timeout_s=30.0):  # noqa: ANN001, ANN201
        self.vorgeladen.append((modell, keep_alive))
        return self.vorladen_wert

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
    assert set(e) == {"treffer", "index", "dauer_ms", "modus"}, e.keys()
    assert e["modus"] == "kombiniert"
    assert e["index"] == {"dateien": 50, "gelesen_anteil": 0.5}
    assert all(set(t) == {"pfad", "seite", "score"} for t in e["treffer"])
    roh = json.dumps(e, ensure_ascii=False)
    assert GEHEIM not in roh and "Kündigungsfrist" not in roh, "nie Abschnittstext, nie der Suchbegriff"
    assert llm.keep_alive == ["32400s"], "um 10 Uhr bleibt bge-m3 bis 19 Uhr (Nachtbeginn) warm"
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
    assert [t["pfad"] for t in e["treffer"]] == [f.pfad for f in VOLLTEXT] and e["modus"] == "volltext"
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
    assert r["ok"] is True and set(r["ergebnis"]) == {"treffer", "index", "dauer_ms", "modus"} and len(r["ergebnis"]["treffer"]) <= 5
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
    # Befund Review E2: Ablage/Index-Stapel setzten bge-m3 auf 5 min zurück — mit Suche an während des Planer-Tags
    # keep_alive bis Tagesende für alle bge-m3-Einbettungen.
    import app.llm as llm_modul

    alt = llm_modul.jetzt_zuerich
    gesendet: list[dict] = []

    def antwort(req: httpx.Request) -> httpx.Response:
        gesendet.append(json.loads(req.content))
        return httpx.Response(200, json={"embeddings": [[1.0, 0.0]], "model": "bge-m3"})

    try:
        for suche_an, stunde, erwartet in ((False, 10, CFG.keep_alive), (True, 10, "32400s"), (True, 22, CFG.keep_alive)):
            llm_modul.jetzt_zuerich = lambda stunde=stunde: datetime(2026, 10, 12, stunde, 0, tzinfo=ZH)
            o = llm_modul.Ollama(dataclasses.replace(CFG, suche_aktiv=suche_an))
            o._client = httpx.Client(base_url="http://ollama.test", transport=httpx.MockTransport(antwort))
            o.einbetten(modell=CFG.modell_embed, texte=["x"])
            assert gesendet[-1]["keep_alive"] == erwartet, (suche_an, stunde, gesendet[-1]["keep_alive"])
            o.einbetten(modell=CFG.modell_embed, texte=["x"], keep_alive="7m")
            assert gesendet[-1]["keep_alive"] == "7m", "ausdrücklicher Wert gilt"
            o._client.close()
    finally:
        llm_modul.jetzt_zuerich = alt


def test_tag_keep_alive_bis_tagesende() -> None:
    def um(h: int, m: int = 0) -> datetime:
        return datetime(2026, 10, 12, h, m, tzinfo=ZH)

    assert tag_keep_alive(CFG, um(7)) == "43200s" and tag_keep_alive(CFG, um(12, 30)) == "23400s"
    assert tag_keep_alive(CFG, um(18, 58)) == "300s", "mindestens 5 min"
    assert tag_keep_alive(CFG, um(19)) is None and tag_keep_alive(CFG, um(6, 59)) is None and tag_keep_alive(CFG, um(2)) is None
    spaet = dataclasses.replace(CFG, nacht_start="20:30", tag_start="06:00")
    assert tag_keep_alive(spaet, um(19)) == "5400s" and tag_keep_alive(spaet, um(6)) == "52200s", "Planer-Zeiten aus der Konfiguration"


# --- Kaltstart: höchstens EINBETTUNG_WARTEN_S, dann nur Volltext; Vorladen beim Wach-Impuls ---------------------


def test_kaltstart_rueckfall_volltext() -> None:
    alt = suche_modul.EINBETTUNG_WARTEN_S
    suche_modul.EINBETTUNG_WARTEN_S = 0.2
    try:
        idx, llm = _Index(VEKTOR, VOLLTEXT), _Llm(laden_s=0.8)   # Modell lädt 0,8 s
        s = _suche(idx, llm)
        t0 = time.monotonic()
        e = nas_suche({"q": "Kündigungsfrist Miete"}, s)
        dauer = time.monotonic() - t0
        assert dauer < 0.6, f"wartet nicht aufs Laden ({dauer:.2f} s)"
        assert e["modus"] == "volltext" and [t["pfad"] for t in e["treffer"]] == [f.pfad for f in VOLLTEXT], e
        assert idx.anker_fragen == 0, "ohne Vektor kein Wort-Anker nötig"
        # Das Laden läuft im Hintergrund fertig — die nächste Suche ist warm und kombiniert.
        time.sleep(0.8)
        assert llm.keep_alive == ["32400s"], "die abgebrochene Suche hat das Modell trotzdem geladen"
        e2 = nas_suche({"q": "Kündigungsfrist Miete"}, s)
        assert e2["modus"] == "kombiniert" and len(e2["treffer"]) > len(e["treffer"])
        # Während eine Einbettung noch lädt, verwirft eine zweite Suche ihre wartende Einbettung (kein Stau).
        llm.laden_s = 0.8
        e3 = nas_suche({"q": "a b"}, s)
        e4 = nas_suche({"q": "c d"}, s)
        assert e3["modus"] == e4["modus"] == "volltext"
        time.sleep(1.0)
        assert len(llm.keep_alive) == 3, f"nur die laufende Einbettung lief fertig ({len(llm.keep_alive)})"
    finally:
        suche_modul.EINBETTUNG_WARTEN_S = alt


def test_vorwaermen() -> None:
    alt_gpu = suche_modul.gpu_info
    frei = {"wert": 5000}
    suche_modul.gpu_info = lambda max_alter_s=10.0: {"name": "RTX", "frei_mb": frei["wert"]}
    try:
        llm = _Llm()
        s = _suche(_Index(VEKTOR, VOLLTEXT), llm)
        assert s.vorwaermen() is True
        assert s._laufend.result(timeout=2) == "geladen" and llm.vorgeladen == [(CFG.modell_embed, "32400s")]
        assert s.vorwaermen() is False, "höchstens alle VORWAERMEN_ABSTAND_S (5 s)"
        # Schon geladen («bge-m3:latest») → nichts tun.
        llm2 = _Llm()
        llm2.geladen = [{"name": "bge-m3:latest"}]
        s2 = _suche(_Index([], []), llm2)
        s2.vorwaermen()
        assert s2._laufend.result(timeout=2) == "warm" and llm2.vorgeladen == []
        # Zu wenig VRAM (Whisper + Sprachmodell geladen) → nichts laden, nichts entladen.
        frei["wert"] = 1000
        llm3 = _Llm()
        llm3.geladen = [{"name": "gemma3:4b"}]
        s3 = _suche(_Index([], []), llm3)
        s3.vorwaermen()
        assert s3._laufend.result(timeout=2) == "kein_platz" and llm3.vorgeladen == []
        # GPU-Schleuse belegt → «belegt», neuer Versuch beim nächsten Impuls nach VORWAERMEN_ABSTAND_S.
        frei["wert"] = 5000
        llm4 = _Llm()
        llm4.vorladen_wert = None
        s4 = _suche(_Index([], []), llm4)
        s4.vorwaermen()
        assert s4._laufend.result(timeout=2) == "belegt" and s4.vorwaermen() is False
        s4._letztes_vorwaermen -= suche_modul.VORWAERMEN_ABSTAND_S
        assert s4.vorwaermen() is True
        # /api/ps antwortet nicht → nichts.
        llm5 = _Llm()
        llm5.geladen = None
        s5 = _suche(_Index([], []), llm5)
        s5.vorwaermen()
        assert s5._laufend.result(timeout=2) == "unbekannt" and llm5.vorgeladen == []
    finally:
        suche_modul.gpu_info = alt_gpu


def test_vorladen_wartet_nie_auf_die_schleuse() -> None:
    import app.llm as llm_modul

    gesendet: list[dict] = []

    def antwort(req: httpx.Request) -> httpx.Response:
        gesendet.append(json.loads(req.content))
        return httpx.Response(200, json={"embeddings": [[1.0, 0.0]], "load_duration": 1_800_000_000})

    o = llm_modul.Ollama(dataclasses.replace(CFG, suche_aktiv=True))
    o._client = httpx.Client(base_url="http://ollama.test", transport=httpx.MockTransport(antwort))
    with SCHLEUSE:
        t0 = time.monotonic()
        assert o.vorladen(modell=CFG.modell_embed) is None and time.monotonic() - t0 < 0.1 and gesendet == []
    assert o.vorladen(modell=CFG.modell_embed, keep_alive="600s") == 1800
    assert gesendet[-1]["input"] == ["."] and gesendet[-1]["keep_alive"] == "600s"
    assert SCHLEUSE.acquire(blocking=False), "Schleuse wieder frei"
    SCHLEUSE.release()
    o._client.close()


class _FsmWach:
    def __init__(self, poll_ms: int | None) -> None:
        self.naechster_poll_ms = poll_ms


class _SucheWach:
    def __init__(self) -> None:
        self.aufrufe = 0

    def vorwaermen(self) -> bool:
        self.aufrufe += 1
        raise RuntimeError("darf den Worker nie stören")


def test_worker_wach_impuls() -> None:
    an = dataclasses.replace(CFG, suche_aktiv=True)
    for poll_ms, cfg, erwartet in ((300, an, 1), (None, an, 0), (300, CFG, 0)):
        sw = _SucheWach()
        w = Worker(cfg, _FsmWach(poll_ms), llm=None, whisper=None, protokoll=None, zustand=Zustand(), suche=sw)  # type: ignore[arg-type]
        w._wach_impuls()
        assert sw.aufrufe == erwartet, (poll_ms, cfg.suche_aktiv, sw.aufrufe)


# --- Mindest-Ähnlichkeit mit Wort-Anker (kalibriert 12.10., siehe suche.MIN_AEHNLICHKEIT) -----------------------


UNSINN_VEKTOR = [Fund(61, "a/x.pdf", 1, 0.6031), Fund(62, "b/y.pdf", 2, 0.5273), Fund(63, "c/z.pdf", 1, 0.47)]


def test_schwelle_unsinn_keine_treffer() -> None:
    # Gemessen: Unsinn ohne Volltext-Treffer erreicht bis 0,603 — ohne Wort im Index bleibt davon nichts.
    idx = _Index(UNSINN_VEKTOR, [], woerter=False)
    e = nas_suche({"q": "xqzvwkjj"}, _suche(idx, _Llm()))
    assert e["treffer"] == [] and e["modus"] == "kombiniert" and idx.anker_fragen == 1
    llm = _Llm(antwort=None)
    e2, modell = archiv_frage({"frage": "xqzvwkjj?"}, _suche(_Index(UNSINN_VEKTOR, [], woerter=False), llm), llm, CFG)  # type: ignore[arg-type]
    assert e2["antwort"] == KEINE_FUNDSTELLE and modell is None and llm.chats == [], "kein Modellaufruf für Unsinn"


def test_schwelle_echte_begriffe_behalten() -> None:
    assert SUCHE_SCHWELLE == MIN_AEHNLICHKEIT == 0.45, "eine Schwelle für Suche und Frag das Archiv"
    # Wort im Index, aber kein Volltext-Treffer (alle Wörter zusammen kommen nirgends vor): Vektor ab 0,45.
    vek = [Fund(71, "a/miete.pdf", 2, 0.58), Fund(72, "b/vertrag.pdf", 1, 0.45), Fund(73, "c/fern.pdf", 1, 0.4499)]
    idx = _Index(vek, [], woerter=True)
    e = nas_suche({"q": "Kündigungsfrist Halle"}, _suche(idx, _Llm()))
    assert [t["pfad"] for t in e["treffer"]] == ["a/miete.pdf", "b/vertrag.pdf"], e["treffer"]
    # Mit Volltext-Treffern: die bleiben immer (auch wenn ihre Vektor-Ähnlichkeit tief ist), keine Extra-Abfrage.
    vt = [Fund(73, "c/fern.pdf", 1, 0.2), Fund(80, "d/nur_text.pdf", 4, 0.1)]
    idx2 = _Index(vek, vt, woerter=False)
    e2 = nas_suche({"q": "Vertrag"}, _suche(idx2, _Llm()))
    pfade = {t["pfad"] for t in e2["treffer"]}
    assert pfade == {"a/miete.pdf", "b/vertrag.pdf", "c/fern.pdf", "d/nur_text.pdf"}, pfade
    assert idx2.anker_fragen == 0, "Volltext-Treffer = alle Wörter im Index"
    # filtere() direkt: Grenze inklusive, Volltext immer, ohne Anker nur Volltext.
    st = vereine(vek, [Fund(80, "d/nur_text.pdf", 4, 0.1)])
    assert {s.id for s in filtere(st, True)} == {71, 72, 80}
    assert {s.id for s in filtere(st, False)} == {80}


def test_verteilung_ohne_wort_anker() -> None:
    """Englisch/Synonym ohne gemeinsames Wort (gemessen: «invoice» 40 Stellen ≥ 0,53, Unsinn höchstens 5): ab
    VERTEILUNG_MIN Stellen ≥ VERTEILUNG_SCHWELLE bleiben genau diese; darunter nichts."""
    assert (suche_modul.VERTEILUNG_SCHWELLE, suche_modul.VERTEILUNG_MIN) == (0.53, 10)
    dicht = [Fund(100 + i, f"r/rechnung_{i}.pdf", 1, 0.60 - i * 0.005) for i in range(10)]   # 0,60 … 0,555
    schwach = [Fund(200 + i, f"s/x_{i}.pdf", 1, 0.52 - i * 0.01) for i in range(5)]           # unter 0,53
    idx = _Index(dicht + schwach, [], woerter=False)
    e = nas_suche({"q": "invoice"}, _suche(idx, _Llm()))
    assert [t["pfad"] for t in e["treffer"]] == [f.pfad for f in dicht], e["treffer"]
    # Eine Stelle weniger (9 ≥ 0,53) → wie Unsinn: nichts.
    idx2 = _Index(dicht[:9] + schwach, [], woerter=False)
    assert nas_suche({"q": "invoice"}, _suche(idx2, _Llm()))["treffer"] == []
    # Grenze inklusive: genau 0,53 zählt.
    grenze = [Fund(300 + i, f"g/{i}.pdf", 1, 0.53) for i in range(10)]
    assert len(filtere(vereine(grenze, []), False)) == 10
    # Gemessener Unsinn-Höchstwert (5 Stellen ≥ 0,53) bleibt leer — auch für «Frag das Archiv», ohne Modellaufruf.
    unsinn = [Fund(400 + i, f"u/{i}.pdf", 1, 0.56 - i * 0.005) for i in range(5)] + schwach
    llm = _Llm(antwort=None)
    e2, modell = archiv_frage({"frage": "xks1nof6tvwhqr"}, _suche(_Index(unsinn, [], woerter=False), llm), llm, CFG)  # type: ignore[arg-type]
    assert e2["antwort"] == KEINE_FUNDSTELLE and modell is None and llm.chats == []


# --- «Frag das Archiv» beim Kaltstart: volle Ladefrist, nie fälschlich «nichts gefunden» ----------------------------


def test_archiv_frage_kaltstart_wartet_aufs_modell() -> None:
    import app.archiv_frage as frage_modul

    alt = suche_modul.EINBETTUNG_WARTEN_S
    suche_modul.EINBETTUNG_WARTEN_S = 0.2     # die Suche gäbe nach 0,2 s auf …
    try:
        # … die Frage wartet die volle Ladefrist: Modell lädt 0,8 s, kein Volltext-Treffer → trotzdem Vektor-Stellen.
        llm = _Llm(antwort={"antwort": "Der Mietvertrag endet am 31. März 2027.", "quellen": [1]}, laden_s=0.8)
        e, modell = archiv_frage({"frage": "Wann endet der Mietvertrag mit dem Volkshaus?"},
                                 _suche(_Index(VEKTOR, []), llm), llm, CFG)  # type: ignore[arg-type]
        assert modell == CFG.modell_text and e["antwort"] != KEINE_FUNDSTELLE and e["quellen"], e
        assert len(llm.chats) == 1
    finally:
        suche_modul.EINBETTUNG_WARTEN_S = alt
    # Einbettung bleibt aus (Ollama weg / Frist abgelaufen) und der Volltext findet nichts → Fehler mit Hinweis,
    # nie der feste Satz «nichts gefunden», kein Modellaufruf.
    llm2 = _Llm(antwort=None, einbettung_fehler=True)
    try:
        archiv_frage({"frage": "Wann endet der Mietvertrag mit dem Volkshaus?"}, _suche(_Index(VEKTOR, []), llm2), llm2, CFG)  # type: ignore[arg-type]
        raise AssertionError("erwartet VerarbeitungsFehler")
    except VerarbeitungsFehler as fe:
        assert str(fe) == frage_modul.EINBETTUNG_NICHT_BEREIT and llm2.chats == []
    alt_frist = frage_modul.EINBETTUNG_TIMEOUT_S
    frage_modul.EINBETTUNG_TIMEOUT_S = 0.2
    try:
        llm3 = _Llm(antwort=None, laden_s=0.8)
        try:
            archiv_frage({"frage": "Wer ist der Vermieter?"}, _suche(_Index(VEKTOR, []), llm3), llm3, CFG)  # type: ignore[arg-type]
            raise AssertionError("erwartet VerarbeitungsFehler")
        except VerarbeitungsFehler as fe:
            assert "nochmals" in str(fe)
        # Nur Volltext, aber mit Treffern → normale Antwort aus diesen Stellen.
        llm4 = _Llm(antwort={"antwort": "Die Frist beträgt sechs Monate.", "quellen": [1]}, einbettung_fehler=True)
        e4, m4 = archiv_frage({"frage": "Kündigungsfrist Leasing?"}, _suche(_Index(VEKTOR, VOLLTEXT), llm4), llm4, CFG)  # type: ignore[arg-type]
        assert m4 == CFG.modell_text and e4["antwort"].startswith("Die Frist") and len(llm4.chats) == 1
    finally:
        frage_modul.EINBETTUNG_TIMEOUT_S = alt_frist
    time.sleep(0.8)   # Hintergrund-Laden von llm3 auslaufen lassen


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
