"""Sicherheits-Rapport (SPEC §2.2): Zahlen-Satz, Ersatztext, Prüfung der Modell-Antwort und der Thread gegen ein
gestelltes FSM. Ohne Netz, ohne Modell.

  docker run --rm --network none -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_sicherheit.py

Läuft auch mit pytest (python -m pytest tests/test_sicherheit.py).
"""

from __future__ import annotations

import dataclasses
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402

from app import sicherheit as s  # noqa: E402
from app.config import laden  # noqa: E402
from app.llm import LlmFehler  # noqa: E402

CFG = dataclasses.replace(laden(), sync_token="geheim-test", fsm_url="https://fsm.test", proxy=None)
RUN = "747b1f8d-37d8-49b0-a148-566c9339d3ed"

KRITISCH = {"severity": "critical", "category": "anon-read", "title": "View „vertrieb_counts\" ist ohne Login lesbar",
            "detail": {"name": "vertrieb_counts", "kind": "VIEW"}}
HEADER = {"severity": "warn", "category": "headers", "title": "Sicherheits-Header fehlen: x-frame-options",
          "detail": {"missing": ["x-frame-options"]}}


def lauf(**over):
    d = {"id": RUN, "critical": 0, "warnings": 0, "checks": 112, "hinweise": {}, "befunde": [], "weitere": 0}
    d.update(over)
    return d


class Modell:
    """Gestelltes Ollama: liefert die vorgegebene Erklärung oder wirft."""

    def __init__(self, antwort=None, fehler: Exception | None = None):
        self.antwort, self.fehler, self.aufrufe = antwort, fehler, []

    def chat_json(self, **kw):
        self.aufrufe.append(kw)
        if self.fehler:
            raise self.fehler
        return {"erklaerung": self.antwort}, {}


# --- Zahlen-Satz und Ersatz --------------------------------------------------------------------------------------


def test_zahlen_satz_alle_faelle():
    assert s.zahlen_satz(lauf()) == "Alles unauffällig: 112 Prüfungen, keine Befunde."
    assert s.zahlen_satz(lauf(hinweise={"rollen": 2})) == \
        "Alles unauffällig: 112 Prüfungen, keine Befunde. Dazu 2 Hinweise zur Kenntnis (Rollen und Rechte)."
    assert s.zahlen_satz(lauf(critical=1)) == "⚠ 1 kritischer Befund bei 112 Prüfungen."
    assert s.zahlen_satz(lauf(critical=2, warnings=1)) == "⚠ 2 kritische Befunde und 1 Warnung bei 112 Prüfungen."
    assert s.zahlen_satz(lauf(warnings=3)) == "3 Warnungen bei 112 Prüfungen, nichts Kritisches."
    assert s.zahlen_satz(lauf(checks="kaputt", critical=-4)) == "Alles unauffällig: 0 Prüfungen, keine Befunde."


def test_ohne_befunde_kein_modell():
    m = Modell("egal")
    text, quelle = s.rapport(lauf(), m, CFG)
    assert (text, quelle) == ("Alles unauffällig: 112 Prüfungen, keine Befunde.", "zahlen")
    assert m.aufrufe == [], "ohne kritische Befunde/Warnungen rechnet das Modell nicht"


def test_ersatz_aus_titeln():
    l_ = lauf(critical=1, befunde=[KRITISCH])
    text, quelle = s.rapport(l_, Modell(fehler=LlmFehler("Modell gemma3:4b hat nicht rechtzeitig geantwortet")), CFG)
    assert quelle == "ersatz"
    assert text == "⚠ 1 kritischer Befund bei 112 Prüfungen. Betroffen: View „vertrieb_counts\" ist ohne Login lesbar."
    assert s.pruefe_rapport(text, l_) is None
    viele = lauf(critical=4, befunde=[KRITISCH] * 4)
    assert s.ersatz_erklaerung(viele).endswith("; dazu weitere, siehe Liste.")
    assert not re.search(r"\d", s.ersatz_erklaerung(viele)), "Ersatz erfindet keine Anzahl"


# --- Modell-Antwort prüfen ---------------------------------------------------------------------------------------

GUT = ("Die Ansicht vertrieb_counts war ohne Anmeldung aus dem Internet lesbar. "
       "Sie sollte sofort für Gäste gesperrt werden.")


def test_modell_text_angenommen():
    l_ = lauf(critical=1, befunde=[KRITISCH])
    m = Modell(GUT)
    text, quelle = s.rapport(l_, m, CFG)
    assert quelle == "modell"
    assert text == "⚠ 1 kritischer Befund bei 112 Prüfungen. " + GUT
    assert m.aufrufe[0]["modell"] == CFG.modell_text and m.aufrufe[0]["num_ctx"] == CFG.llm_num_ctx
    assert "vertrieb_counts" in m.aufrufe[0]["nutzer"] and "112" not in m.aufrufe[0]["nutzer"], \
        "das Modell sieht keine Zähler"


def test_modell_text_verworfen():
    l_ = lauf(critical=1, befunde=[KRITISCH])
    faelle = {
        "zahl": "Die Ansicht vertrieb_counts war für 37 Personen offen und sollte gesperrt werden.",
        "name_fehlt": "Eine Ansicht war ohne Anmeldung lesbar und sollte gesperrt werden.",
        "entwarnung": "Die Ansicht vertrieb_counts ist offen, das ist aber harmlos und kein Risiko.",
        "sprache": "The view vertrieb_counts was readable without login, please fix it now.",
        "zu_kurz": "vertrieb_counts.",
        "adresse": "Die Ansicht vertrieb_counts war offen, siehe https://example.com für mehr.",
    }
    for grund, antwort in faelle.items():
        text = s._zwei_saetze(s.saeubern(antwort))
        assert s.pruefe_erklaerung(text, l_, s.befunde(l_)) == grund, grund
        voll, quelle = s.rapport(l_, Modell(antwort), CFG)
        assert quelle == "ersatz", grund
        assert voll.startswith("⚠ 1 kritischer Befund bei 112 Prüfungen. Betroffen:"), grund


def test_hoechstens_zwei_saetze_und_saeuberung():
    l_ = lauf(critical=1, befunde=[KRITISCH])
    antwort = "**Achtung:** Die Ansicht vertrieb_counts ist offen. Das muss weg. Sofort! Und noch mehr."
    text, quelle = s.rapport(l_, Modell(antwort), CFG)
    assert quelle == "modell"
    assert text == "⚠ 1 kritischer Befund bei 112 Prüfungen. Achtung: Die Ansicht vertrieb_counts ist offen. Das muss weg."
    assert s.saeubern("Grüße​ aus\x00 der  Strasse") == "Grüsse aus der Strasse"


def test_ziffern_aus_titeln_erlaubt():
    b = {**KRITISCH, "title": "Tabelle „v2_leads\" ist ohne Login lesbar", "detail": {"name": "v2_leads"}}
    l_ = lauf(critical=1, befunde=[b])
    text, quelle = s.rapport(l_, Modell("Die Tabelle v2_leads war ohne Anmeldung lesbar und sollte gesperrt werden."), CFG)
    assert quelle == "modell" and "v2_leads" in text


def test_warnung_ohne_namen():
    l_ = lauf(warnings=1, befunde=[HEADER])
    text, quelle = s.rapport(l_, Modell("Der Webseite fehlt ein Schutz gegen das Einbetten in fremde Seiten; "
                                        "das sollte die Informatik nachtragen."), CFG)
    assert quelle == "modell"
    assert text.startswith("1 Warnung bei 112 Prüfungen, nichts Kritisches. Der Webseite")


def test_text_immer_im_rahmen():
    l_ = lauf(critical=20, befunde=[{**KRITISCH, "title": "X" * 200}] * 20)
    text, _ = s.rapport(l_, Modell(fehler=LlmFehler("weg")), CFG)
    assert len(text) <= s.TEXT_MAX and s.pruefe_rapport(text, l_) is None


# --- Thread gegen ein gestelltes FSM -----------------------------------------------------------------------------


def _rapport_thread(antworten, modell=None, ruhig=True):
    t = s.SicherheitsRapport(CFG, modell or Modell(GUT), lambda: ruhig)
    gesendet: list[httpx.Request] = []
    folge = list(antworten)

    def fsm(request: httpx.Request) -> httpx.Response:
        gesendet.append(request)
        assert request.headers["authorization"] == "Bearer geheim-test"
        assert request.url.path == "/api/ki/sicherheit"
        return folge.pop(0)(request) if folge else httpx.Response(200, json={"success": True, "lauf": None})

    t._fsm.close()
    t._fsm = httpx.Client(base_url=CFG.fsm_url, transport=httpx.MockTransport(fsm), headers=t._fsm.headers)
    return t, gesendet


def _lauf_antwort(l_):
    return lambda r: httpx.Response(200, json={"success": True, "lauf": l_})


def test_runde_setzt_rapport():
    l_ = lauf(critical=1, befunde=[KRITISCH])
    t, gesendet = _rapport_thread([_lauf_antwort(l_), lambda r: httpx.Response(200, json={"success": True})])
    assert t.runde() == "nichts"
    post = [r for r in gesendet if r.method == "POST"]
    assert len(post) == 1
    body = json.loads(post[0].content)
    assert body == {"run_id": RUN, "text": "⚠ 1 kritischer Befund bei 112 Prüfungen. " + GUT}
    st = t.status()
    assert st["quelle"] == "modell" and st["rapporte"] == 1 and st["fehler"] is None
    assert "vertrieb" not in json.dumps(st), "Status ohne Text"
    t.schliessen()


def test_runde_422_dann_ersatz():
    l_ = lauf(critical=1, befunde=[KRITISCH])
    t, gesendet = _rapport_thread([
        _lauf_antwort(l_),
        lambda r: httpx.Response(422, json={"success": False}),
        lambda r: httpx.Response(200, json={"success": True}),
    ])
    t.runde()
    posts = [json.loads(r.content)["text"] for r in gesendet if r.method == "POST"]
    assert len(posts) == 2 and "Betroffen:" in posts[1]
    assert t.status()["quelle"] == "ersatz"
    t.schliessen()


def test_runde_vorrang_und_fehler():
    l_ = lauf()
    t, gesendet = _rapport_thread([_lauf_antwort(l_)], ruhig=False)
    assert t.runde() == "vorrang"
    assert all(r.method == "GET" for r in gesendet), "bei laufendem Auftrag nichts rechnen/senden"
    t.schliessen()
    t, _ = _rapport_thread([lambda r: httpx.Response(500)])
    assert t.runde() == "fehler" and t.status()["fehler"] == "abholen:HTTP 500"
    t.schliessen()
    t, _ = _rapport_thread([lambda r: httpx.Response(404)])
    assert t.runde() == "nichts", "Route fehlt (altes FSM) → still nichts tun"
    t.schliessen()
    t, _ = _rapport_thread([_lauf_antwort(l_), lambda r: httpx.Response(503)])
    assert t.runde() == "fehler", "5xx beim Melden → nächster Takt"
    t.schliessen()


def test_runde_409_kein_endlosversuch():
    l_ = lauf()
    t, gesendet = _rapport_thread([_lauf_antwort(l_), lambda r: httpx.Response(409), _lauf_antwort(l_)])
    assert t.runde() == "aufgegeben"
    assert sum(r.method == "POST" for r in gesendet) == 1
    t.schliessen()


def test_runde_mehrere_laeufe():
    a, b = lauf(), lauf(id="682c6014-1014-47d6-80bc-d4967f11ccb2")
    ok = lambda r: httpx.Response(200, json={"success": True})  # noqa: E731
    t, gesendet = _rapport_thread([_lauf_antwort(a), ok, _lauf_antwort(b), ok])
    assert t.runde() == "nichts"
    assert [json.loads(r.content)["run_id"] for r in gesendet if r.method == "POST"] == [a["id"], b["id"]]
    t.schliessen()


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
