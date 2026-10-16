"""Zweiter Blick (jobs/zweiter_blick.py) ohne Netz und ohne Datenbank: Vergleich, offene/unentschiedene Vorschläge,
Einplanen (nur ZZ, höchstens 5 Teile, kurze zuerst), das Hauptmodell im Live-Code (gestreamt, ohne Denkmodus, Optionen
des Planers, Einbettungen auf «schnell»), Vorrang zwischen den Teilen und Abbruch in der Sperre.

  docker run --rm --network none -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_zweiter_blick.py
"""

from __future__ import annotations

import dataclasses
import json
import sys
import threading
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import laden  # noqa: E402
from app.jobs import Schritt, SchrittKontext  # noqa: E402
from app.jobs import zweiter_blick as zb  # noqa: E402
from app.jobs import zz as zj  # noqa: E402
from app.llm import LlmAbgebrochen, LlmFehler  # noqa: E402
from app.nachtarbeit import Kontext, TextZeile, ZbStand  # noqa: E402

CFG = dataclasses.replace(laden(), llm_num_ctx=8192, job_zweiter_blick=True, hg_aktiv=True)
SHA = "a" * 64
GROSS = "gemma4:26b-a4b-it-qat"
KLEIN = "gemma4:12b-it-qat"
KONTEXT = {
    "heute": "2026-10-16",
    "ordner": ["02_LOCATIONS/Volkshaus/01_Vertraege", "00_ADMIN/02_Versicherungen", "ZZ_Alt"],
    "dok_typen": [{"key": "vertrag", "label": "Vertrag", "person": False},
                  {"key": "korrespondenz", "label": "Korrespondenz", "person": False},
                  {"key": "sonstiges", "label": "Sonstiges", "person": False}],
    "mitarbeiter": [], "namen_alle": [],
    "vorschlaege_bekannt": [
        {"art": "zz", "pfad": "ZZ_Alt/miete.pdf", "status": "offen", "rezept": "zz/v3"},
        {"art": "zz", "pfad": "ZZ_Alt/miete.pdf", "status": "beschrieb_fertig", "rezept": "zz/v4"},
        {"art": "zz", "pfad": "ZZ_Alt/wartet.pdf", "status": "beschrieb_wartet", "rezept": "zz/v4"},
        {"art": "zz", "pfad": "ZZ_Alt/angenommen.pdf", "status": "angenommen", "rezept": "zz/v3"},
        {"art": "zz", "pfad": "ZZ_Alt/abgelehnt.pdf", "status": "abgelehnt", "rezept": "zz/v3"},
        {"art": "zz", "pfad": "ZZ_Alt/wieder.pdf", "status": "abgelehnt", "rezept": "zz/v2"},
        {"art": "zz", "pfad": "ZZ_Alt/wieder.pdf", "status": "offen", "rezept": "zz/v3"},
    ],
}
TEXT = "Mietvertrag Halle Nord zwischen Muster AG und EVENTLINE GmbH. Basel, 3. März 2025. " * 3


def _antwort_zz(**kw) -> dict:  # noqa: ANN003
    basis = {"typ": "sonstiges", "dokumentart": "Mietvertrag", "unterart": "Halle", "titel": "Mietvertrag Halle Nord",
             "zweck": "Miete der Halle Nord.", "bezug_beleg": "", "bezug": "unbekannt", "status_beleg": "",
             "status": "unbekannt", "datum_beleg": "Basel, 3. März 2025", "datum": "2025-03-03", "zeitraum_beleg": "",
             "zeitraum": "unbekannt", "sprache": "de", "absender_beleg": "", "absender": "unbekannt",
             "empfaenger_beleg": "", "empfaenger": "unbekannt",
             "beteiligte": [{"beleg": "zwischen Muster AG und EVENTLINE", "name": "Muster AG", "rolle": "unbekannt"}],
             "schlagworte": ["Miete"], "personenbezogen": False}
    return {**basis, **kw}


# --- Vergleich -------------------------------------------------------------------------------------------------


def test_vergleich() -> None:
    alt = {"typ": "korrespondenz", "dokumentart": "Brief", "datum": "2025-03-03", "beteiligte": [{"name": "Muster AG"}]}
    assert zb.vergleiche(alt, dict(alt)) == [], "gleich"
    assert zb.vergleiche(alt, {**alt, "zeitraum": "2025"}) == ["mehr_felder"]
    assert zb.vergleiche(alt, {**alt, "typ": "vertrag"}) == ["dokumentart"], "anderer Typ"
    assert zb.vergleiche(alt, {**alt, "dokumentart": "Offerte"}) == ["dokumentart"], "andere Art (Wörter)"
    assert zb.vergleiche({**alt, "dokumentart": "Vertrag"}, {**alt, "dokumentart": "Mietvertrag"}) == [], "Zusammensetzung"
    # Beteiligte zählen als EIN Feld: ein weiterer Name ist «andere Beteiligte», nicht «mehr Felder».
    assert zb.vergleiche(alt, {**alt, "beteiligte": [{"name": "Muster AG"}, {"name": "Halle Nord AG"}]}) == ["beteiligte"]
    assert zb.vergleiche(alt, {**alt, "beteiligte": [{"name": "Andere GmbH"}]}) == ["beteiligte"]
    assert zb.vergleiche(alt, {**alt, "beteiligte": [{"name": "AG Muster"}]}) == [], "gleicher Name, andere Reihenfolge"
    assert zb.vergleiche(alt, {**alt, "datum": "2025-04-01"}) == ["werte"]
    assert zb.vergleiche({**alt, "absender": "Muster AG"}, {**alt, "absender": "Volkshaus Basel"}) == ["werte"]
    assert zb.vergleiche({**alt, "bezug": "Halle Nord"}, {**alt, "bezug": "Miete Halle Nord 2025"}) == [], "gleiche Wörter"
    weniger = {k: v for k, v in alt.items() if k != "datum"}
    assert zb.vergleiche(alt, weniger) == [], "weniger Felder allein ist kein Grund"
    assert set(zb.vergleiche(alt, {})) <= set(zb.GRUENDE)


def test_unentschiedene_und_kandidaten() -> None:
    offen = zb.unentschiedene(KONTEXT)
    assert offen == {"ZZ_Alt/miete.pdf", "ZZ_Alt/wartet.pdf", "ZZ_Alt/wieder.pdf"}, offen
    zeilen = [("ZZ_Alt/miete.pdf", SHA, 2, 20000), ("ZZ_Alt/wartet.pdf", SHA, 1, 900), ("ZZ_Alt/angenommen.pdf", SHA, 1, 10),
              ("ZZ_Alt/wieder.pdf", SHA, 6, 60000), ("02_LOCATIONS/miete.pdf", SHA, 1, 10)]
    liste, zu_lang = zb.kandidaten(zeilen, KONTEXT, 5)
    assert liste == [("ZZ_Alt/wartet.pdf", SHA), ("ZZ_Alt/miete.pdf", SHA)], "kurze zuerst, nur ZZ, nur unentschieden"
    assert zu_lang == 1
    s = zb.schluessel("ZZ_Alt/a:b.pdf", SHA)
    assert zb.aus_schluessel(s) == ("ZZ_Alt/a:b.pdf", SHA)
    assert zb.rezept() == "zz/v4+zb" and len(zb.rezept()) <= 20
    j = zb.job(zb.ZbAbhaengigkeiten(CFG, None, None, None, None, lambda: True, lambda: None))  # type: ignore[arg-type]
    # Seit 16.10.2026 nachts und tagsüber — ob tagsüber gerechnet wird, entscheidet der Planer (KI_HG_TAG).
    assert j.art == "zweiter_blick" and j.modi == ("nacht", "tag") and j.max_s == CFG.zb_schritt_max_s
    assert j.modelle == zb.FREIGEGEBEN == (GROSS,) and KLEIN not in j.modelle, "nur das gemessene 26B, nie das 12B"
    assert j.aktiv(CFG) and not j.aktiv(dataclasses.replace(CFG, hg_aktiv=False))
    assert not j.aktiv(dataclasses.replace(CFG, job_zweiter_blick=False))


# --- Der Schritt mit Attrappen ---------------------------------------------------------------------------------


class _Stream:
    """chat_stream des Hauptmodells: Antwort je Schema (Beschrieb oder Fristen), merkt sich die Aufrufe."""

    def __init__(self, zz: list[dict], fristen: list[dict] | None = None) -> None:
        self.zz = list(zz)
        self.fristen = list(fristen or [])
        self.aufrufe: list[dict] = []

    def __call__(self, **kw):  # noqa: ANN003, ANN204
        self.aufrufe.append(kw)
        if "dokumentart" in kw["format"]["properties"]:
            a = self.zz.pop(0)
        else:
            a = self.fristen.pop(0)
        if isinstance(a, Exception):
            raise a
        return json.dumps(a), {"modell": kw["modell"], "dauer_ms": 5, "antwort_tokens": 12, "prompt_tokens": 100}


class _Schnell:
    def __init__(self) -> None:
        self.einbettungen = 0

    def einbetten(self, **kw):  # noqa: ANN003, ANN201
        self.einbettungen += 1
        raise LlmFehler("keine Einbettung im Test")

    def geladene_modelle(self) -> list:
        return []

    def entlade(self, modell=None) -> bool:  # noqa: ANN001
        return True


class _Speicher:
    def __init__(self, alt: dict | None, text: str = TEXT, zeichen: int | None = None,
                 stand: ZbStand | None = None) -> None:
        self.alt = alt
        self._text = text
        self.zeichen = len(text or "") if zeichen is None else zeichen
        self.stand = stand
        self.gespeichert: list[tuple] = []
        self.fristen: list = []

    def zb_stand(self, pfad: str, sha: str, rezept: str) -> ZbStand | None:
        assert rezept == zb.rezept()
        return self.stand

    def text_zeile(self, pfad: str, sha: str):  # noqa: ANN201
        return TextZeile(pfad, sha, pfad.rsplit("/", 1)[-1], False, 1, self.zeichen) if self._text is not None else None

    def text(self, pfad: str, sha: str) -> str | None:
        return self._text

    def zz_beschrieb(self, pfad: str, sha: str, rezept: str) -> dict | None:
        assert rezept == zj.REZEPT
        return self.alt

    def speichere_zb(self, pfad, sha, rezept, modell, status, **kw) -> None:  # noqa: ANN001, ANN003
        self.gespeichert.append((pfad, rezept, modell, status, kw))

    def speichere_fristen(self, pfad, sha, befund, lauf_id) -> int:  # noqa: ANN001
        self.fristen.append((pfad, [f.art for f in befund.fristen], lauf_id))
        return len(befund.fristen)


class _Kontext:
    def __init__(self, daten: dict | None) -> None:
        self.daten = daten

    def aktuell(self):  # noqa: ANN201
        return Kontext(self.daten, time.time()) if self.daten is not None else None

    @property
    def zuletzt(self):  # noqa: ANN201
        return self.aktuell()


def _ctx(stream: _Stream, abbruch: threading.Event | None = None) -> SchrittKontext:
    return SchrittKontext(modell=GROSS, optionen={"use_mmap": False, "num_gpu": 0, "num_ctx": 16384, "num_thread": 10},
                          abbruch=abbruch or threading.Event(), frist=time.monotonic() + 60, chat_stream=stream,
                          keep_alive="15m")


def _deps(speicher: _Speicher, *, frei=lambda: True, darf=lambda: None, kontext=KONTEXT) -> zb.ZbAbhaengigkeiten:  # noqa: ANN001
    return zb.ZbAbhaengigkeiten(CFG, speicher, _Kontext(kontext), None, _Schnell(), frei, darf,  # type: ignore[arg-type]
                                uhr_fenster=lambda: "2026-10-15/nacht")


def _schritt(pfad: str = "ZZ_Alt/miete.pdf") -> Schritt:
    return Schritt(1, zb.ART, zb.schluessel(pfad, SHA), zb.rezept(), "laeuft", 1)


def test_schritt_anders_mit_fristen() -> None:
    alt = {"typ": "korrespondenz", "typ_label": "Korrespondenz", "dokumentart": "Brief", "datum": "2025-03-03",
           "beteiligte": [{"name": "Muster AG", "rolle": ""}], "teile": 1}
    s = _Speicher(alt, text=TEXT + " Die Kündigungsfrist beträgt drei Monate.")
    frist = {"typ": "vertrag", "dok_datum": "", "partei": "Muster AG", "partei_art": "organisation",
             "personenbezogen": False, "fristen": []}
    stream = _Stream([_antwort_zz()], [frist])
    meta = zb.ausfuehren(_deps(s), _schritt(), _ctx(stream))
    assert meta["status"] == "anders" and meta["kennzahlen"]["teile"] == 1
    pfad, rezept, modell, status, kw = s.gespeichert[-1]
    assert (pfad, rezept, modell, status) == ("ZZ_Alt/miete.pdf", "zz/v4+zb", GROSS, "anders")
    assert kw["gruende"] == ["dokumentart"], kw["gruende"]
    assert kw["befund"].beschrieb["typ"] == "vertrag", "Typ aus der Beschreibung (Gemma 4 setzt «sonstiges»)"
    assert kw["lauf_id"] == "2026-10-15-nacht-zb" and kw["fristen_roh"] == 0
    # Gleicher Live-Code, nur das Modell: gestreamt, ohne Denkmodus, mit dem JSON-Schema, Optionen des Planers.
    a = stream.aufrufe[0]
    assert a["modell"] == GROSS and a["think"] is False and a["format"]["properties"]["dokumentart"]
    assert a["optionen"]["num_ctx"] == 16384 and a["optionen"]["num_thread"] == 10 and a["optionen"]["use_mmap"] is False
    assert a["optionen"]["num_predict"] == zj.ANTWORT_TOKENS_ZZ and a["optionen"]["temperature"] == 0
    assert a["nachrichten"][0]["content"] == zj.SYSTEM_ZZ, "derselbe Prompt wie beim schnellen Modell"
    assert len(stream.aufrufe) == 2, "Beschrieb + Fristen (Vorfilter trifft «Kündigungsfrist»)"


def test_schritt_gleich_meldet_nichts() -> None:
    # Hat das schnelle Modell dasselbe beschrieben, bleibt sein Vorschlag: Status «gleich», nichts geht ans FSM.
    erster = _Speicher({"typ": "x"})
    zb.ausfuehren(_deps(erster), _schritt(), _ctx(_Stream([_antwort_zz()])))
    s = _Speicher(erster.gespeichert[-1][4]["befund"].beschrieb)
    meta = zb.ausfuehren(_deps(s), _schritt(), _ctx(_Stream([_antwort_zz()])))
    assert meta["status"] == "gleich" and s.gespeichert[-1][3] == "gleich" and s.gespeichert[-1][4]["gruende"] == []


def test_schritt_entschieden_zu_lang_ohne_vergleich() -> None:
    s = _Speicher({"typ": "vertrag"})
    entschieden = {**KONTEXT, "vorschlaege_bekannt": [{"art": "zz", "pfad": "ZZ_Alt/miete.pdf", "status": "angenommen"}]}
    stream = _Stream([])
    assert zb.ausfuehren(_deps(s, kontext=entschieden), _schritt(), _ctx(stream))["status"] == "entschieden"
    assert not stream.aufrufe, "entschieden: kein Modellaufruf"
    lang = _Speicher({"typ": "vertrag"}, text="Allgemeine Bestimmungen. " * 3000)
    assert zb.ausfuehren(_deps(lang), _schritt(), _ctx(stream))["status"] == "zu_lang" and not stream.aufrufe
    assert lang.gespeichert[-1][4]["teile"] > CFG.zb_max_teile
    ohne = _Speicher(None)
    assert zb.ausfuehren(_deps(ohne), _schritt(), _ctx(stream))["status"] == "ohne_vergleich"
    weg = _Speicher({"typ": "vertrag"}, text=None)  # type: ignore[arg-type]
    assert zb.ausfuehren(_deps(weg), _schritt(), _ctx(stream))["status"] == "veraltet"


def test_nur_mit_freigegebenem_modell() -> None:
    """Mit dem 12B (nicht freigegeben) wird nichts gerechnet — der Schritt bleibt offen (der Hintergrund lädt dafür
    ohnehin kein anderes Modell; hier die zweite Sicherung). Gilt auch, wenn das 12B oben in der Leiter steht."""
    verkehrt = dataclasses.replace(CFG, hg_modelle=((KLEIN, 10.0), (GROSS, 17.0)))
    for cfg in (CFG, verkehrt):
        s = _Speicher({"typ": "vertrag", "dokumentart": "Vertrag"})
        stream = _Stream([_antwort_zz()])
        d = dataclasses.replace(_deps(s), cfg=cfg)
        try:
            zb.ausfuehren(d, _schritt(), dataclasses.replace(_ctx(stream), modell=KLEIN))
            raise AssertionError("LlmAbgebrochen erwartet")
        except LlmAbgebrochen as e:
            assert e.grund == "nicht_freigegeben" and stream.aufrufe == [] and s.gespeichert == [], \
                "nichts gerechnet, nichts gespeichert"
        assert zb.ausfuehren(d, _schritt(), _ctx(stream))["status"] == "anders", "das 26B rechnet, egal wo es steht"
    assert zb.freigegeben(GROSS) and zb.freigegeben(GROSS + ":latest"), "Schreibweise mit «:latest» wie bei Ollama"
    assert not zb.freigegeben(KLEIN) and not zb.freigegeben(None) and not zb.freigegeben("")


def test_ergebnis_eines_nicht_freigegebenen_modells_gilt_nicht() -> None:
    """16.10.2026: 13 Dokumente las das 12B (08:19–09:08), das FSM übernahm die Ergebnisse. Ein zweiter Blick zählt nur
    als erledigt, wenn ihn ein freigegebenes Modell gemacht hat: das 26B liest nochmals und meldet IMMER (Grund
    «vorlaeufig»), auch wenn sein Beschrieb dem des schnellen Modells gleicht — der Vorschlag soll auf dem 26B beruhen."""
    alt = {"typ": "korrespondenz", "dokumentart": "Brief", "teile": 1}
    # Beschrieb des 26B für die Vorlage «gleich» ermitteln (wie test_schritt_gleich_meldet_nichts).
    erster = _Speicher(alt)
    zb.ausfuehren(_deps(erster), _schritt(), _ctx(_Stream([_antwort_zz()])))
    gleich_wie_26b = erster.gespeichert[-1][4]["befund"].beschrieb
    vom_12b = ZbStand(KLEIN, "anders", True, "ok")
    s = _Speicher(gleich_wie_26b, stand=vom_12b)
    meta = zb.ausfuehren(_deps(s), _schritt(), _ctx(_Stream([_antwort_zz()])))
    pfad, rezept, modell, status, kw = s.gespeichert[-1]
    assert (modell, status, kw["gruende"]) == (GROSS, "anders", ["vorlaeufig"]), (modell, status, kw["gruende"])
    assert meta["status"] == "anders"
    # Mit inhaltlichem Unterschied: beide Gründe.
    alt2 = {"typ": "korrespondenz", "typ_label": "Korrespondenz", "dokumentart": "Brief", "datum": "2025-03-03",
            "beteiligte": [{"name": "Muster AG", "rolle": ""}], "teile": 1}
    s2 = _Speicher(alt2, stand=vom_12b)
    zb.ausfuehren(_deps(s2), _schritt(), _ctx(_Stream([_antwort_zz()])))
    assert s2.gespeichert[-1][3] == "anders" and s2.gespeichert[-1][4]["gruende"] == ["dokumentart", "vorlaeufig"], \
        s2.gespeichert[-1][4]["gruende"]
    # Hat das FSM das 12B-Ergebnis NICHT übernommen («gleich» oder abgewiesen), gilt der normale Vergleich.
    for stand in (ZbStand(KLEIN, "gleich", False, None), ZbStand(KLEIN, "anders", True, "pfad_bewegt"),
                  ZbStand(KLEIN, "anders", False, None)):
        s3 = _Speicher(gleich_wie_26b, stand=stand)
        assert zb.ausfuehren(_deps(s3), _schritt(), _ctx(_Stream([_antwort_zz()])))["status"] == "gleich", stand
    # Vorläufig gemeldet, aber der Beschrieb des schnellen Modells fehlt: trotzdem rechnen und melden.
    s4 = _Speicher(None, stand=vom_12b)
    zb.ausfuehren(_deps(s4), _schritt(), _ctx(_Stream([_antwort_zz()])))
    assert s4.gespeichert[-1][3] == "anders" and s4.gespeichert[-1][4]["gruende"] == ["vorlaeufig"]
    # Schon vom 26B erledigt (doppelt eingeplant): nichts rechnen, nichts speichern.
    s5 = _Speicher(alt, stand=ZbStand(GROSS, "anders", True, "ok"))
    stream5 = _Stream([])
    assert zb.ausfuehren(_deps(s5), _schritt(), _ctx(stream5)) == {"status": "erledigt"}
    assert stream5.aufrufe == [] and s5.gespeichert == []


def test_vorrang_zwischen_den_teilen_und_sperre() -> None:
    satz = "Allgemeine Bestimmungen zur Zusammenarbeit im Betrieb. "
    text = "Basel, 3. März 2025. " + satz * 420
    assert len(zj.text_teile(text)) == 3
    s = _Speicher({"typ": "vertrag", "dokumentart": "Vertrag"}, text=text)
    frei_aufrufe: list[int] = []

    def frei() -> bool:
        frei_aufrufe.append(1)
        return len(frei_aufrufe) % 2 == 0  # jedes zweite Mal ist der Rig frei

    alt_takt = zb.WARTEN_TAKT_S
    zb.WARTEN_TAKT_S = 0.01
    try:
        stream = _Stream([_antwort_zz(datum_beleg="", datum="unbekannt", beteiligte=[])] * 3)
        zb.ausfuehren(_deps(s, frei=frei), _schritt(), _ctx(stream))
        assert len(stream.aufrufe) == 3 and len(frei_aufrufe) >= 6, "vor jedem Teil auf Ruhe gewartet"
        # Sperre (05:25) zwischen den Teilen: Schritt bricht ab (der Hintergrund pausiert ihn und entlädt).
        zustaende = iter([None, None, "sperre"])
        stream2 = _Stream([_antwort_zz()] * 3)
        try:
            zb.ausfuehren(_deps(s, darf=lambda: next(zustaende, "sperre")), _schritt(), _ctx(stream2))
            raise AssertionError("LlmAbgebrochen erwartet")
        except LlmAbgebrochen as e:
            assert e.grund == "sperre" and len(stream2.aufrufe) == 2, "vor Teil 3 abgebrochen"
        # Wächter-Abbruch (Event) wird zwischen den Teilen ebenso bemerkt.
        ev = threading.Event()
        ev.set()
        try:
            zb.ausfuehren(_deps(s), _schritt(), _ctx(_Stream([_antwort_zz()] * 3), ev))
            raise AssertionError("LlmAbgebrochen erwartet")
        except LlmAbgebrochen as e:
            assert e.grund == "abbruch"
    finally:
        zb.WARTEN_TAKT_S = alt_takt


def test_hauptmodell_llm_einbettungen_auf_schnell() -> None:
    schnell = _Schnell()
    llm = zb.HauptmodellLlm(_ctx(_Stream([{"ok": True}])), schnell)  # type: ignore[arg-type]
    try:
        llm.einbetten(modell="bge-m3", texte=["x"])
    except LlmFehler:
        pass
    assert schnell.einbettungen == 1 and llm.geladene_modelle() == [] and llm.entlade("x") is True
    stream = _Stream([], [{"fristen": []}])
    llm2 = zb.HauptmodellLlm(_ctx(stream), schnell)  # type: ignore[arg-type]
    daten, meta = llm2.chat_json(modell="gemma3:4b", system="s", nutzer="n", schema={"type": "object", "properties": {}},
                                 num_ctx=8192, num_predict=900, optionen={"temperature": 0.3, "seed": 7})
    assert daten == {"fristen": []} and meta["modell"] == GROSS and meta["num_ctx"] == 16384
    o = stream.aufrufe[0]["optionen"]
    assert o["num_predict"] == 900 and o["temperature"] == 0.3 and o["seed"] == 7 and o["num_ctx"] == 16384, o
    assert stream.aufrufe[0]["frist_s"] <= zb.AUFRUF_MAX_S


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
