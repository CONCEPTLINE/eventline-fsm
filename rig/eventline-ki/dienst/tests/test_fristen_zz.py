"""Nachtarbeit E4.3–E4.5 ohne Netz und ohne Datenbank: Vorfilter, Prüfung gegen Erfindung, Bedingungen, Karte und
Minimierung (Fristen), Sicherheit/Ziele/Begründung (Rückstau ZZ), Stichprobe/Kennzahlen/Egress (Selbsttest).

  docker run --rm --network none -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_fristen_zz.py
"""

from __future__ import annotations

import dataclasses
import json
import re
import sys
import tempfile
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402

from app.config import laden  # noqa: E402
from app.jobs import fristen as fj  # noqa: E402
from app.jobs import selbsttest as sj  # noqa: E402
from app.jobs import zz as zj  # noqa: E402
from app.llm import LlmFehler  # noqa: E402

CFG = dataclasses.replace(laden(), llm_num_ctx=8192, proxy="http://egress:3128")
KONTEXT = {
    "heute": "2026-10-12",
    "ordner": [
        "00_ADMIN_RECHT/02_Versicherungen", "02_LOCATIONS/Volkshaus/01_Vertraege", "ZZ_Alt", "ZZ_Alt/Scans",
        "99_System/Papierkorb", "06_PERSONAL/0012_Anna_Muster",
    ],
    "dok_typen": [{"key": "vertrag", "label": "Vertrag", "person": False},
                  {"key": "versicherungspolice", "label": "Versicherungspolice", "person": False},
                  {"key": "zertifikat", "label": "Zertifikat", "person": True},
                  {"key": "sonstiges", "label": "Sonstiges", "person": False}],
    "mitarbeiter": ["Anna Muster"],
    "namen_alle": ["Anna Muster", "Peter Beispiel"],
    "vorschlaege_bekannt": [], "fristen_bekannt": [],
}

VERTRAG = """[Seite 1]
Leasingvertrag Kopierer zwischen Canon (Schweiz) AG und EVENTLINE GmbH, Basel, 12. Januar 2024.

[Seite 2]
Der Vertrag beginnt am 01.01.2024 und hat eine feste Laufzeit von 36 Monaten. Er verlängert sich jeweils um ein
weiteres Jahr, wenn er nicht unter Einhaltung einer Kündigungsfrist von drei (3) Monaten auf das Ende der Laufzeit
gekündigt wird."""


class _Llm:
    def __init__(self, *antworten: dict | Exception) -> None:
        self.antworten = list(antworten)
        self.aufrufe: list[dict] = []

    def chat_json(self, **kw):  # noqa: ANN003, ANN201
        self.aufrufe.append(kw)
        a = self.antworten[len(self.aufrufe) - 1]
        if isinstance(a, Exception):
            raise a
        return dict(a), {"modell": kw["modell"], "dauer_ms": 1, "prompt_tokens": 1}

    def geladene_modelle(self) -> list[dict]:
        return []

    def entlade(self, modell: str | None = None) -> None:
        pass

    def einbetten(self, *, modell: str, texte: list[str], timeout_s: float = 120.0):  # noqa: ANN201
        raise LlmFehler("keine Einbettung im Test")


def _frist(**kw) -> dict:  # noqa: ANN003
    basis = {"abschnitt": 2, "beleg": "", "art": "kuendigung", "beginn": "", "ende": "", "faellig": "", "laufzeit_monate": 0,
             "verlaengerung_monate": 0, "kuendigungsfrist_anzahl": 0, "kuendigungsfrist_einheit": ""}
    return {**basis, **kw}


BELEG_VERTRAG = "Kündigungsfrist von drei (3) Monaten"


# --- Fristen: Vorfilter und Auszüge ------------------------------------------------------------------------


def test_vorfilter() -> None:
    for treffer in ("ist jederzeit KÜNDBAR", "Kuendigung", "Die Laufzeit beträgt", "gültig bis 31.12.", "gueltig  bis",
                    "Ablauf der Police", "Vertragsende", "verlängert sich", "Zahlungsfrist 30 Tage", "zahlbar bis"):
        assert fj.vorfilter(treffer), treffer
    for kein in ("Rechnung für Lichttechnik", "Offerte Bühne", ""):
        assert not fj.vorfilter(kein), kein


def test_auszuege_mit_kopf_und_seite() -> None:
    a = fj.auszuege(VERTRAG)
    assert a[0].nr == 1 and a[0].seite == 1, "Kopf (Parteien, Datum) zuerst"
    assert any(x.seite == 2 and "Kündigungsfrist" in x.text for x in a)
    assert fj.auszuege("[Seite 1]\nNur eine Rechnung über Licht.") == []
    lang = "\n\n".join(f"Absatz {i} mit Kündigung und viel weiterem Text " * 3 for i in range(40))
    assert len(fj.auszuege(lang)) <= fj.MAX_AUSZUEGE + 1


# --- Fristen: Prüfung gegen Erfindung ------------------------------------------------------------------------


def test_datum_schreibweisen() -> None:
    for text in ("bis 31.03.2027", "bis 31.3.27", "am 31. März 2027", "am 31 Maerz 2027", "2027-03-31",
                 "March 31, 2027", "le 31 mars 2027", "31/03/2027", "31. 03. 2027"):
        assert fj.datum_im_text("2027-03-31", text), text
    for text in ("bis 30.03.2027", "bis 31.03.2028", "131.03.2027", "31.03.20271", "Ende März 2027", ""):
        assert not fj.datum_im_text("2027-03-31", text), text
    assert not fj.datum_im_text("2027-02-30", "30.02.2027"), "ungültiges Datum nie belegt"


def test_zahl_mit_einheit() -> None:
    assert fj.zahl_mit_einheit(3, "monate", "Kündigungsfrist von 3 Monaten")
    assert fj.zahl_mit_einheit(3, "monate", "drei Monate vor Ablauf")
    assert fj.zahl_mit_einheit(3, "monate", "eine dreimonatige Frist")
    assert fj.zahl_mit_einheit(3, "monate", "mit 3-monatiger Frist")
    assert fj.zahl_mit_einheit(3, "monate", "drei (3) Monaten")
    assert fj.zahl_mit_einheit(30, "tage", "zahlbar innert 30 Tagen")
    assert fj.zahl_mit_einheit(2, "wochen", "zwei Wochen")
    assert fj.zahl_mit_einheit(24, "monate", "vierundzwanzig Monate")
    assert not fj.zahl_mit_einheit(3, "monate", "Seite 3 von 5")
    assert not fj.zahl_mit_einheit(3, "monate", "am 31.03.2027 Monatsende"), "Teil eines Datums zählt nicht"
    assert not fj.zahl_mit_einheit(3, "monate", "13 Monate")
    assert not fj.zahl_mit_einheit(3, "monate", "3 Jahre")
    assert fj.monate_im_text(36, "feste Laufzeit von 3 Jahren")
    assert fj.monate_im_text(12, "verlängert sich um ein weiteres Jahr")
    assert fj.monate_im_text(36, "Laufzeit 36 Monate")
    assert not fj.monate_im_text(18, "1.5 Jahre"), "halbe Jahre werden nicht umgerechnet"


def test_einheit_nur_mit_endung_und_wortgrenze() -> None:
    # Review-Befund: Zusammensetzungen mit fremder Zahl belegen keine Laufzeit/Frist.
    assert not fj.zahl_mit_einheit(3, "monate", "Kaution: 3 Monatsmieten")
    assert not fj.zahl_mit_einheit(3, "monate", "3 Monatsraten à CHF 500")
    assert not fj.zahl_mit_einheit(3, "monate", "zahlbar 3 monatlich")
    assert not fj.monate_im_text(12, "gemaess Ziffer 1 Jahresbeitrag")
    assert not fj.zahl_mit_einheit(1, "jahre", "1 Jahresrechnung")
    assert not fj.zahl_mit_einheit(2, "wochen", "Seite 2 Wochenplan")
    assert not fj.zahl_mit_einheit(2, "wochen", "2 wöchentlich")
    assert not fj.zahl_mit_einheit(5, "tage", "5 Tagessatz")
    assert not fj.zahl_mit_einheit(5, "tage", "5 Tageskarten")
    assert not fj.zahl_mit_einheit(3, "monate", "3 monthly")
    assert not fj.belegt({"beginn": None, "ende": "2027-03-31", "faellig": None, "laufzeit_monate": None,
                          "verlaengerung_monate": None, "kuendigungsfrist": {"anzahl": 3, "einheit": "monate"}},
                         "Mietende 31.03.2027. Kaution: 3 Monatsmieten.")
    # Die echten Formen bleiben belegt (Endungen, Adjektive, Fremdsprachen, Abkürzungen).
    for n, einheit, text in [
        (3, "monate", "3 Monate"), (3, "monate", "drei Monaten"), (1, "monate", "einen Monat"),
        (3, "monate", "3-Monats-Frist"), (3, "monate", "dreimonatigen"), (3, "monate", "3 Mte."),
        (3, "monate", "3 Mt. auf Monatsende"), (6, "monate", "6 months"), (3, "monate", "3 mois"),
        (3, "monate", "3 mesi"), (1, "monate", "un mese"), (2, "jahre", "2 Jahren"), (1, "jahre", "ein Jahr."),
        (2, "jahre", "zweijährige Laufzeit"), (2, "jahre", "2 years"), (2, "jahre", "2 ans"), (2, "jahre", "2 années"),
        (2, "jahre", "2 anni"), (2, "wochen", "2 Wochen"), (2, "wochen", "zweiwöchige"), (1, "wochen", "1 Woche,"),
        (2, "wochen", "2 weeks"), (2, "wochen", "2 semaines"), (2, "wochen", "2 settimane"), (30, "tage", "30 Tage"),
        (14, "tage", "14-tägig"), (10, "tage", "10 days"), (30, "tage", "30 jours"), (30, "tage", "30 giorni"),
    ]:
        assert fj.zahl_mit_einheit(n, einheit, text), (n, einheit, text)


def test_bedingungen_und_vollstaendig() -> None:
    b, g = fj.bedingungen_aus(_frist(beginn="2024-01-01", laufzeit_monate=36, kuendigungsfrist_anzahl=3,
                                     kuendigungsfrist_einheit="monate", verlaengerung_monate=12))
    assert g is None and b == {"beginn": "2024-01-01", "ende": None, "faellig": None, "laufzeit_monate": 36,
                               "verlaengerung_monate": 12, "kuendigungsfrist": {"anzahl": 3, "einheit": "monate"}}
    assert fj.bedingungen_aus(_frist(ende="31.12.2026"))[0]["ende"] == "2026-12-31", "Schweizer Schreibweise gelesen"
    assert fj.bedingungen_aus(_frist(ende="31.12.26"))[0]["ende"] == "2026-12-31"
    h = fj.Counter()
    b2, g2 = fj.bedingungen_aus(_frist(ende="Ende 2026", faellig="30.02.2026"), h)
    assert g2 is None and b2["ende"] is None and b2["faellig"] is None and h["datum_unlesbar"] == 2, "nie geraten"
    b4, _ = fj.bedingungen_aus(_frist(beginn="unbekannt", ende="Unbekannt", faellig="2027-03-31"), h)
    assert b4["beginn"] is None and b4["ende"] is None and b4["faellig"] == "2027-03-31"
    assert h["datum_unlesbar"] == 2, "«unbekannt» ist leer (seit fristen/v3 erlaubt), kein unlesbares Datum"
    assert fj.bedingungen_aus(_frist(laufzeit_monate=200))[1] == "ungueltig_zahl"
    b3, _ = fj.bedingungen_aus(_frist(kuendigungsfrist_anzahl=3), h)
    assert b3["kuendigungsfrist"] is None and h["frist_ohne_einheit"] == 1, "Anzahl ohne Einheit: nicht raten"
    assert fj.bedingungen_aus(_frist(kuendigungsfrist_anzahl=30, kuendigungsfrist_einheit="tage"))[1] == "ungueltig_zahl"
    leer = {"beginn": None, "ende": None, "faellig": None, "laufzeit_monate": None, "verlaengerung_monate": None,
            "kuendigungsfrist": None}
    assert not fj.vollstaendig("zahlung", leer)
    assert fj.vollstaendig("zahlung", {**leer, "faellig": "2026-11-30"})
    assert fj.vollstaendig("kuendigung", {**leer, "faellig": "2027-06-30"}), "ausdrücklicher Termin genügt"
    assert not fj.vollstaendig("kuendigung", {**leer, "ende": "2027-12-31"}), "Kündigung braucht die Frist"
    assert fj.vollstaendig("kuendigung", {**leer, "ende": "2027-12-31", "kuendigungsfrist": {"anzahl": 3, "einheit": "monate"}})
    assert fj.vollstaendig("ablauf", {**leer, "beginn": "2024-01-01", "laufzeit_monate": 12})
    assert not fj.vollstaendig("ablauf", {**leer, "beginn": "2024-01-01"})


def test_pruefe_fristen_erfunden_und_belegt() -> None:
    quellen = fj.auszuege(VERTRAG)
    nr = next(a.nr for a in quellen if a.seite == 2)
    gut = _frist(abschnitt=nr, beleg=BELEG_VERTRAG, beginn="2024-01-01", laufzeit_monate=36, verlaengerung_monate=12,
                 kuendigungsfrist_anzahl=3, kuendigungsfrist_einheit="monate")
    erfunden = _frist(abschnitt=nr, beleg=BELEG_VERTRAG, beginn="2024-01-01", laufzeit_monate=24, kuendigungsfrist_anzahl=3,
                      kuendigungsfrist_einheit="monate")
    # Beispieldatum der früheren Anleitung (2026-12-31) — steht nicht im Dokument: erfunden, als Prompt-Kopie gezählt.
    falsches_datum = _frist(art="vertragsende", abschnitt=nr, beleg="feste Laufzeit von 36 Monaten", ende="2026-12-31")
    unvollst = _frist(abschnitt=nr, beleg=BELEG_VERTRAG, beginn="2024-01-01", laufzeit_monate=36)
    fristen, z = fj.pruefe_fristen([gut, erfunden, falsches_datum, unvollst, gut, "kaputt"], quellen, ocr=False)
    assert len(fristen) == 1 and fristen[0].seite == 2 and fristen[0].sicherheit == "hoch"
    assert z["erfunden"] == 2 and z["unvollstaendig"] == 1 and z["doppelt"] == 1 and z["ungueltig"] == 1
    assert z["prompt_kopie"] == 1
    # fristen/v3: ohne Beleg, mit erfundenem oder fremdem Beleg — verworfen, auch wenn die Werte stimmen.
    for beleg in ("", "Kündigungsfrist von sechs Monaten", "zwischen Canon (Schweiz) AG und EVENTLINE"):
        ohne, zo = fj.pruefe_fristen([{**gut, "beleg": beleg}], quellen, ocr=False)
        assert not ohne and zo["ohne_beleg"] == 1, beleg
    # Beleg fast wörtlich (ein Wort ausgelassen) und anders geschrieben (Gross/klein, ue) zählt.
    for beleg in ("Kündigungsfrist von drei Monaten", "KUENDIGUNGSFRIST VON DREI (3) MONATEN"):
        assert fj.pruefe_fristen([{**gut, "beleg": beleg}], quellen, ocr=False)[0], beleg
    # Datum + Fristwort nur zusammen: das Datum steht im Kopf, dort aber kein Fristwort → verworfen.
    kopf, zk = fj.pruefe_fristen([_frist(art="zahlung", abschnitt=1, beleg="Basel, 12. Januar 2024", faellig="2024-01-12")],
                                 quellen, ocr=False)
    assert not kopf and zk["ohne_fristwort"] == 1
    assert fj.belege_kennzahlen(z) == {"fristen": {"angegeben": 3, "belegt": 1}}
    assert fj.belege_kennzahlen(fj.Counter()) == {}, "ohne geprüfte Frist keine Kennzahl"
    # Falsche Abschnittsnummer: ein anderer Auszug mit ALLEN Werten zählt.
    verzaehlt, _ = fj.pruefe_fristen([{**gut, "abschnitt": 99}], quellen, ocr=False)
    assert verzaehlt and verzaehlt[0].seite == 2
    # OCR: eine Stufe tiefer.
    ocr, _ = fj.pruefe_fristen([gut], quellen, ocr=True)
    assert ocr[0].sicherheit == "mittel"
    assert fj.pruefe_fristen(None, quellen, ocr=False) == ([], fj.Counter())
    assert fj.pruefe_fristen([_frist()], quellen, ocr=False)[1]["leer"] == 1, "Platzhalter-Frist ohne Werte"


def test_karte_minimierung() -> None:
    q = VERTRAG
    roh = {"typ": "vertrag", "dok_datum": "2024-01-12", "partei": "Canon (Schweiz) AG", "partei_art": "organisation",
           "personenbezogen": False}
    typ, dok, partei, pers = fj.karte_aus(roh, pfad="00_ADMIN_RECHT/x.pdf", volltext=q, quelltext=q,
                                          typ_keys=["vertrag"], personen_typen=None, namen=["Anna Muster"])
    assert (typ, dok, partei, pers) == ("vertrag", "2024-01-12", "Canon (Schweiz) AG", False)
    # Partei steht nicht im Dokument → weg; Profilname → personenbezogen, keine Partei; EVENTLINE nie.
    assert fj.karte_aus({**roh, "partei": "Swisscom AG"}, pfad="a/b.pdf", volltext=q, quelltext=q, typ_keys=["vertrag"],
                        personen_typen=None, namen=[])[2] is None
    _, _, p2, pers2 = fj.karte_aus({**roh, "partei": "Anna Muster"}, pfad="a/b.pdf", volltext=q + " Anna Muster",
                                   quelltext=q, typ_keys=["vertrag"], personen_typen=None, namen=["Anna Muster"])
    assert p2 is None and pers2
    assert fj.karte_aus({**roh, "partei": "EVENTLINE GmbH"}, pfad="a/b.pdf", volltext=q, quelltext=q,
                        typ_keys=["vertrag"], personen_typen=None, namen=[])[2] is None
    _, _, p3, pers3 = fj.karte_aus(roh, pfad="06_PERSONAL/0012_Anna_Muster/v.pdf", volltext=q, quelltext=q,
                                   typ_keys=["vertrag"], personen_typen=None, namen=[])
    assert pers3 and p3 is None, "Personalakte: nie eine Partei"
    # Erfundenes Dokumentdatum fällt weg, unbekannter Typ ebenso.
    t4, d4, _, _ = fj.karte_aus({**roh, "dok_datum": "2023-05-05", "typ": "erfunden"}, pfad="a/b.pdf", volltext=q,
                                quelltext=q, typ_keys=["vertrag"], personen_typen=None, namen=[])
    assert t4 is None and d4 is None


def test_fristen_pruefen_ohne_treffer_ohne_modell() -> None:
    llm = _Llm()
    b = fj.fristen_pruefen(pfad="a/b.pdf", dateiname="b.pdf", text="[Seite 1]\nRechnung Licht", ocr=False,
                           kontext_roh=KONTEXT, llm=llm, cfg=CFG)  # type: ignore[arg-type]
    assert b.status == "ohne_treffer" and not llm.aufrufe
    assert fj.fristen_pruefen(pfad="a", dateiname="a", text="  ", ocr=False, kontext_roh=KONTEXT, llm=llm,
                              cfg=CFG).status == "leer"  # type: ignore[arg-type]


def test_fristen_pruefen_mit_modell() -> None:
    quellen = fj.auszuege(VERTRAG)
    nr = next(a.nr for a in quellen if a.seite == 2)
    antwort = {"typ": "vertrag", "dok_datum": "2024-01-12", "partei": "Canon (Schweiz) AG", "partei_art": "organisation",
               "personenbezogen": False, "fristen": [_frist(abschnitt=nr, beleg=BELEG_VERTRAG, beginn="2024-01-01",
                                                            laufzeit_monate=36, verlaengerung_monate=12,
                                                            kuendigungsfrist_anzahl=3, kuendigungsfrist_einheit="monate")]}
    llm = _Llm(antwort)
    b = fj.fristen_pruefen(pfad="00_ADMIN_RECHT/03_Dauervertraege/Leasing.pdf", dateiname="Leasing.pdf", text=VERTRAG,
                           ocr=False, kontext_roh=KONTEXT, llm=llm, cfg=CFG)  # type: ignore[arg-type]
    assert b.status == "fertig" and len(b.fristen) == 1 and b.partei == "Canon (Schweiz) AG"
    kw = llm.aufrufe[0]
    assert kw["modell"] == CFG.modell_text and kw["num_ctx"] == CFG.llm_num_ctx, "schnelles Modell, kein Neuladen"
    assert kw["schema"]["properties"]["typ"]["enum"] == ["vertrag", "versicherungspolice", "zertifikat", "sonstiges"]
    frist_felder = list(kw["schema"]["properties"]["fristen"]["items"]["properties"])
    assert frist_felder.index("beleg") < frist_felder.index("art") < frist_felder.index("faellig"), "Beleg vor den Werten"
    assert "Heutiges Datum" not in kw["nutzer"], "fristen/v3: kein heutiges Datum im Prompt"
    assert not re.search(r"\d{1,2}\.\d{1,2}\.\d{2,4}|20\d\d", fj.SYSTEM), "keine Beispieldaten in der Anleitung"
    assert b.zaehler["angegeben"] == 1 and fj.belege_kennzahlen(b.zaehler) == {"fristen": {"angegeben": 1, "belegt": 1}}
    m = fj.meldung("00_ADMIN_RECHT/03_Dauervertraege/Leasing.pdf", "a" * 64, b.fristen[0], b.partei)
    assert set(m) == {"pfad", "sha256", "art", "bedingungen", "seite", "sicherheit", "partei"}
    assert m["bedingungen"]["kuendigungsfrist"] == {"anzahl": 3, "einheit": "monate"}
    assert "partei" not in fj.meldung("x/y.pdf", "a" * 64, b.fristen[0], None)
    # NFD-Pfad wird NFC gemeldet.
    nfd = unicodedata.normalize("NFD", "x/Büro.pdf")
    assert fj.meldung(nfd, "a" * 64, b.fristen[0], None)["pfad"] == unicodedata.normalize("NFC", "x/Büro.pdf")


def test_fristen_wiederholungsschleife() -> None:
    llm = _Llm(LlmFehler("Ollama-Fehler 500: repeat limit"), {"typ": "vertrag", "dok_datum": "", "partei": "",
                                                              "partei_art": "", "personenbezogen": False, "fristen": []})
    b = fj.fristen_pruefen(pfad="a/b.pdf", dateiname="b.pdf", text=VERTRAG, ocr=False, kontext_roh=KONTEXT, llm=llm,
                           cfg=CFG)  # type: ignore[arg-type]
    assert b.status == "fertig" and not b.fristen and len(llm.aufrufe) == 2 and "optionen" in llm.aufrufe[1]


# --- Rückstau ZZ (zz/v3: Beschrieb + Fakten, Claude entscheidet im FSM) -------------------------------------


def test_zz_gesperrt_und_kontext() -> None:
    assert zj.gesperrt("ZZ_Alt") and zj.gesperrt("02_LOCATIONS/zz_alt/x") and zj.gesperrt("99_System/Papierkorb")
    assert not zj.gesperrt("02_LOCATIONS/Volkshaus") and not zj.gesperrt("02_LOCATIONS/BUZZ_Halle")
    k = zj.gefilterter_kontext(KONTEXT)
    assert k["ordner"] == ["00_ADMIN_RECHT/02_Versicherungen", "02_LOCATIONS/Volkshaus/01_Vertraege",
                           "06_PERSONAL/0012_Anna_Muster"]
    assert zj.ordner_von("ZZ_Alt/Scans/a.pdf") == "ZZ_Alt/Scans"


ZZ_STUFE = {"typ": "versicherungspolice", "dokumentart": "Versicherungspolice", "unterart": "Betriebshaftpflicht",
            "titel": "Police Betriebshaftpflicht", "zweck": "Police der Betriebshaftpflicht der Firma, Prämie CHF 1'200.–",
            "bezug_beleg": "", "bezug": "unbekannt", "status_beleg": "", "status": "final",
            "datum_beleg": "Basel, 15.01.2026", "datum": "2026-01-15", "zeitraum_beleg": "", "zeitraum": "2025",
            "sprache": "de", "absender_beleg": "Betriebshaftpflicht der Mobiliar", "absender": "Mobiliar",
            "empfaenger_beleg": "Versicherungsnehmerin EVENTLINE GmbH", "empfaenger": "EVENTLINE GmbH",
            "beteiligte": [{"beleg": "der Mobiliar, Versicherungsnehmerin", "name": "Mobiliar", "rolle": "Versicherer"},
                           {"beleg": "", "name": "Erfundene Person", "rolle": "Agent"}],
            "schlagworte": ["Haftpflicht", "IBAN CH93 0076 2011 6238 5295 7", "Versicherung"], "personenbezogen": False}
POLICE = ("[Seite 1]\nVersicherungen: Police der Betriebshaftpflicht der Mobiliar, Versicherungsnehmerin EVENTLINE GmbH. "
          * 3) + "Basel, 15.01.2026"


def _leer(**kw) -> dict:  # noqa: ANN003
    """Antwort ohne Angaben (alles «unbekannt») — Basis für gezielte Fälle."""
    basis = {"typ": "vertrag", "dokumentart": "", "unterart": "unbekannt", "titel": "", "zweck": "",
             "bezug_beleg": "", "bezug": "unbekannt", "status_beleg": "", "status": "unbekannt", "datum_beleg": "",
             "datum": "unbekannt", "zeitraum_beleg": "", "zeitraum": "unbekannt", "sprache": "de", "absender_beleg": "",
             "absender": "unbekannt", "empfaenger_beleg": "", "empfaenger": "unbekannt", "beteiligte": [],
             "schlagworte": [], "personenbezogen": False}
    return {**basis, **kw}


def _filter(roh: dict, text: str, dateiname: str = "a.pdf", pfad: str = "ZZ_Alt/a.pdf", wissen=None) -> dict:  # noqa: ANN001
    return zj.filtere_beschrieb(roh, typ="vertrag", typ_label="Vertrag", dateiname=dateiname, pfad=pfad, text=text,
                                heute="2026-10-16", seiten=None, ocr=False, endung=".pdf", wissen=wissen)


def test_zz_beschrieb_gefiltert_und_meldung() -> None:
    llm = _Llm(ZZ_STUFE)
    b = zj.zz_beschreiben(pfad="ZZ_Alt/Scans/Scan_0042.pdf", dateiname="Scan_0042.pdf", sha256="a" * 64, text=POLICE,
                          seiten=1, ocr=True, kontext_roh=KONTEXT, llm=llm, cfg=CFG, archiv=None)  # type: ignore[arg-type]
    assert b.status == "vorschlag" and b.ordner_ist == "ZZ_Alt/Scans" and len(llm.aufrufe) == 1, "ein Modellaufruf"
    s = b.beschrieb or {}
    assert s["dokumentart"] == "Versicherungspolice" and s["titel"] == "Police Betriebshaftpflicht"
    assert "zweck" not in s, "Betrag im Zweck → Feld fällt ganz weg"
    assert s["schlagworte"] == ["Haftpflicht", "Versicherung"], "IBAN fällt weg"
    assert s["beteiligte"] == [{"name": "Mobiliar", "rolle": "Versicherer"}], "ohne Beleg fällt der Name weg"
    assert s["datum"] == "2026-01-15" and s["absender"] == "Mobiliar" and s["empfaenger"] == "EVENTLINE GmbH"
    assert "status" not in s and "zeitraum" not in s, "ohne Beleg: nicht im Beschrieb …"
    assert s["unbekannt"] == ["zeitraum", "status", "bezug"], "… sondern als «unbekannt» geführt"
    assert b.belege == {"datum": {"angegeben": 1, "belegt": 1}, "zeitraum": {"angegeben": 1, "belegt": 0},
                        "status": {"angegeben": 1, "belegt": 0}, "absender": {"angegeben": 1, "belegt": 1},
                        "empfaenger": {"angegeben": 1, "belegt": 1}, "beteiligte": {"angegeben": 2, "belegt": 1},
                        "rolle": {"angegeben": 1, "belegt": 1}}, b.belege
    kw = llm.aufrufe[0]
    felder = list(kw["schema"]["properties"])
    assert felder.index("datum_beleg") < felder.index("datum") and felder.index("status_beleg") < felder.index("status")
    assert kw["schema"]["properties"]["status"]["enum"][0] == "unbekannt", "«unbekannt» ist eine erlaubte Antwort"
    assert "Heutiges Datum" not in kw["nutzer"], "zz/v4: kein heutiges Datum (wurde als Dokumentdatum übernommen)"
    assert "Mitarbeitende" not in kw["nutzer"] and "Anna Muster" not in kw["nutzer"], \
        "zz/v4: keine Liste der Mitarbeitenden (Namen daraus landeten als Beteiligte in fremden Beschrieben)"
    for beispiel in ("Verwaltungsvertrag", "Veranstaltung X", "Max Muster", "Arbeitgeber", "Arbeitsvertrag", "Mietvertrag"):
        assert beispiel not in zj.SYSTEM_ZZ, f"keine Beispielwerte in der Anleitung: {beispiel}"
    assert any("ohne Aussage" in f for f in b.fakten), "Scanner-Name → neuer Name nötig"
    assert all(not zj.gesperrt(p) for p in b.kandidaten)
    m = zj.meldung("ZZ_Alt/Scans/Scan_0042.pdf", "a" * 64, {"ordner_ist": b.ordner_ist, "beschrieb": b.beschrieb,
                                                          "fakten": b.fakten, "kandidaten": b.kandidaten})
    assert m["art"] == "zz" and m["rezept"] == zj.REZEPT == "zz/v4" and "ziel_ordner" not in m
    text = json.dumps(m, ensure_ascii=False)
    assert "1'200" not in text and "CH93" not in text and "Seite 1" not in text, "nie Inhalt/sensible Werte"
    assert "Versicherungsnehmerin" not in text and "15.01.2026" not in text, "Belege bleiben auf dem Rig"


def test_zz_personendokument_ohne_akte() -> None:
    kontext = {**KONTEXT, "ordner": [*KONTEXT["ordner"], "06_PERSONAL/02_Personalakten_Ehmalige",
                                     "06_PERSONAL/01_Festangestellt/1001_Anna_Muster/01_Vertraege_Anstellung"]}
    stufe = {**ZZ_STUFE, "typ": "vertrag", "dokumentart": "Beilage zum Arbeitsvertrag", "zweck": "Stellenbeschrieb",
             "absender": "", "beteiligte": [{"beleg": "Volker Hassemer", "name": "Volker Hassemer",
                                              "rolle": "Arbeitnehmer, Techniker"}],
             "schlagworte": [], "personenbezogen": True}
    b = zj.zz_beschreiben(
        pfad="ZZ_X/_EVENTLINE/Vertraege_und_Recht/Verein EVENTLINE/2025-Personal/Volker Hassemer/"
             "Beilage zum Arbeitsvertrag – Techniker Volker Hassemer .pdf",
        dateiname="Beilage zum Arbeitsvertrag – Techniker Volker Hassemer .pdf", sha256="b" * 64,
        text="Beilage zum Arbeitsvertrag. Funktion Techniker. Volker Hassemer. " * 3, seiten=2, ocr=False,
        kontext_roh=kontext, llm=_Llm(stufe), cfg=CFG, archiv=None)  # type: ignore[arg-type]
    f = " | ".join(b.fakten)
    assert "Person erkannt im Dateinamen: Volker Hassemer" in f and "Keine Personalakte für Volker Hassemer" in f, f
    assert "Personendokument" in f and "SCALA" not in f
    assert b.personenbezogen and b.kandidaten[0] == "06_PERSONAL/02_Personalakten_Ehmalige", b.kandidaten
    s = b.beschrieb or {}
    assert s["dokumentart"] == "Beilage zum Arbeitsvertrag", "früheres Beispiel, aber im Dokument belegt → bleibt"
    assert s["beteiligte"] == [{"name": "Volker Hassemer", "rolle": ""}], "«Arbeitnehmer» steht nicht im Text"


def test_zz_ohne_text_und_modellfehler() -> None:
    b = zj.zz_beschreiben(pfad="ZZ_Alt/IMG_0001.jpg", dateiname="IMG_0001.jpg", sha256="a" * 64, text="", seiten=None,
                          ocr=True, kontext_roh=KONTEXT, llm=_Llm({**ZZ_STUFE, "zweck": "", "titel": ""}), cfg=CFG,
                          archiv=None)  # type: ignore[arg-type]
    assert b.status == "vorschlag" and (b.beschrieb or {}).get("dateityp") == "jpg"
    assert "datum" not in (b.beschrieb or {}), "ohne Text gibt es keinen Beleg"
    try:
        zj.zz_beschreiben(pfad="ZZ_Alt/a.pdf", dateiname="a.pdf", sha256="a" * 64, text=POLICE, seiten=1, ocr=False,
                          kontext_roh=KONTEXT, llm=_Llm(LlmFehler("weg")), cfg=CFG, archiv=None)  # type: ignore[arg-type]
        raise AssertionError("Modellfehler muss als LlmFehler hinaus (Schritt «fehler»)")
    except LlmFehler:
        pass


def test_zz_erfundenes_datum_verworfen_belegtes_bleibt() -> None:
    liste = "Name;Ort\nA;Basel\nUnterschrift: ________"
    # Heutiges Datum ohne Beleg, Status «unterschrieben» nur wegen einer Unterschriftszeile: beides weg.
    erfunden = _filter(_leer(datum_beleg="Name;Ort", datum="2026-10-16", status_beleg="Unterschrift:",
                             status="unterschrieben"), liste, dateiname="a.csv")
    assert "datum" not in erfunden and "status" not in erfunden
    assert {"datum", "status"} <= set(erfunden["unbekannt"])
    # Beleg mit einem anderen Datum als dem Wert: weg; Beleg erfunden (nicht im Text): weg.
    text = "ENTWURF\nMietvertrag Halle Nord\nBasel, 3. März 2025\nDer Vertrag beginnt am 01.04.2025."
    assert "datum" not in _filter(_leer(datum_beleg="Basel, 3. März 2025", datum="2025-03-04"), text)
    assert "datum" not in _filter(_leer(datum_beleg="Basel, 4. März 2025", datum="2025-03-04"), text)
    # Belegt: bleibt — auch mit anderer Schreibweise des Datums im Beleg und Schweizer Datum als Wert.
    gut = _filter(_leer(datum_beleg="Basel, 3. März 2025", datum="2025-03-03", status_beleg="ENTWURF",
                        status="entwurf"), text)
    assert gut["datum"] == "2025-03-03" and gut["status"] == "entwurf" and "datum" not in gut["unbekannt"]
    assert _filter(_leer(datum_beleg="Basel, 3. März 2025", datum="03.03.2025"), text)["datum"] == "2025-03-03"
    # Ungenauer Beleg zu einem richtigen Wert (häufig bei gemma3:4b): das Rig findet den Wert selbst im Teil.
    vermiet = text + "\nVermieterin: Muster Immobilien AG, vertreten durch Peter Beispiel."
    ungenau = _filter(_leer(datum_beleg="Basel, den 03.03.2025", datum="2025-03-03", status_beleg="Status: Entwurf",
                            status="entwurf", absender_beleg="Vermieter Muster AG", absender="Muster Immobilien AG",
                            zeitraum_beleg="ab April", zeitraum="April 2025",
                            beteiligte=[{"beleg": "", "name": "Beispiel Peter", "rolle": "Vertreter"},
                                        {"beleg": "Max Muster, Vermieterin", "name": "Max Muster", "rolle": "Vermieter"}]),
                      vermiet)
    assert ungenau["datum"] == "2025-03-03" and ungenau["status"] == "entwurf" and ungenau["zeitraum"] == "April 2025"
    assert ungenau["absender"] == "Muster Immobilien AG"
    assert ungenau["beteiligte"] == [{"name": "Beispiel Peter", "rolle": "Vertreter"}], \
        "Name (umgekehrt) und Rolle («vertreten durch») gefunden; erfundener Name weg"
    # Steht der Wert nirgends im Teil, hilft auch der Rückfall nicht.
    nirgends = _filter(_leer(datum_beleg="", datum="2025-05-05", zeitraum_beleg="", zeitraum="Mai 2024",
                             absender_beleg="", absender="Muster Bau AG"), vermiet)
    assert not {"datum", "zeitraum", "absender"} & set(nirgends) and {"datum", "zeitraum", "absender"} <= set(nirgends["unbekannt"])
    # «unbekannt» überall ist eine gültige Antwort: nichts angegeben, nichts gezählt.
    leer = _filter(_leer(), text)
    assert leer["unbekannt"] == ["datum", "zeitraum", "status", "bezug", "absender", "empfaenger", "beteiligte"]
    assert "unterart" not in leer, "«unbekannt» in freien Feldern fällt weg"


def test_zz_prompt_kopien_und_rollen() -> None:
    tarif = "Tarifblatt Lichttechnik 2026\nGrundpauschale je Einsatz, Zuschläge nach Aufwand.\nEVENTLINE GmbH, Basel"
    roh = _leer(dokumentart="Tarifblatt", unterart="Verwaltungsvertrag Location",
                zweck="Dieser Vertrag regelt die Tarife für Lichttechnik.", bezug_beleg="Tarifblatt Lichttechnik 2026",
                bezug="zu Veranstaltung X", titel="Tarifblatt Lichttechnik",
                beteiligte=[{"beleg": "EVENTLINE GmbH, Basel", "name": "EVENTLINE GmbH", "rolle": "Arbeitgeber"}])
    b = _filter(roh, tarif)
    assert b["dokumentart"] == "Tarifblatt" and b["titel"] == "Tarifblatt Lichttechnik"
    assert "unterart" not in b and "zweck" not in b and "bezug" not in b, "kopierte Beispiele ohne Beleg fallen weg"
    assert b["beteiligte"] == [{"name": "EVENTLINE GmbH", "rolle": ""}], "Rolle ohne Beleg im Teil: unbekannt"
    # Steht das Beispiel wirklich im Dokument, bleibt es.
    vertrag = "Verwaltungsvertrag Location SCALA zwischen Muster AG (Arbeitgeber) und EVENTLINE GmbH. Dieser Vertrag regelt …"
    b2 = _filter(_leer(unterart="Verwaltungsvertrag Location", zweck="Dieser Vertrag regelt die Verwaltung.",
                       beteiligte=[{"beleg": "Muster AG (Arbeitgeber)", "name": "Muster AG", "rolle": "Arbeitgeber"}]),
                 vertrag)
    assert b2["unterart"] == "Verwaltungsvertrag Location" and b2["zweck"].startswith("Dieser Vertrag")
    assert b2["beteiligte"] == [{"name": "Muster AG", "rolle": "Arbeitgeber"}]
    # Ein Jahr im Zweck, das nirgends im Dokument steht, ist erfunden.
    assert "zweck" not in _filter(_leer(zweck="Tarife der Saison 2024 für Lichttechnik."), tarif)
    assert _filter(_leer(zweck="Tarife 2026 für Lichttechnik."), tarif)["zweck"] == "Tarife 2026 für Lichttechnik."


def test_zz_adressen_nie_als_beteiligte() -> None:
    text = ("Muster AG, Muster-Strasse 6, Hinterer-Weg 12, Bahnhofstr. 12, Muster-Gasse 4, Barfüsser-Platz 1, "
            "Freie Strasse 3, St. Alban-Vorstadt 6, 4051 Basel")
    for adresse in ("Muster-Strasse 6", "Muster AG, Muster-Strasse 6", "Hinterer-Weg 12", "Bahnhofstr. 12", "Muster-Gasse 4",
                    "Barfüsser-Platz 1", "Freie Strasse 3", "St. Alban-Vorstadt 6", "Musterstrasse 6", "Muster AG, 4051 Basel"):
        b = _filter(_leer(beteiligte=[{"beleg": adresse, "name": adresse, "rolle": "Adresse"}],
                          absender_beleg=adresse, absender=adresse), text)
        assert "beteiligte" not in b and "absender" not in b, adresse
    assert _filter(_leer(beteiligte=[{"beleg": "Muster AG", "name": "Muster AG", "rolle": ""}]), text)["beteiligte"]


def test_zz_firmenwissen_im_prompt_und_als_beleg() -> None:
    wissen = [{"kategorie": "abkuerzung", "begriff": "BSU", "erklaerung": "Basler Stadtunterhaltung, Kunde seit 2024"},
              {"kategorie": "benennung", "begriff": "Offerten", "erklaerung": "immer JJJJ-MM-TT_Offerte_Kunde"},
              {"kategorie": "ansprechpartner", "begriff": "Peter Beispiel", "erklaerung": "Hauswart der Halle Nord"}]
    kontext = {**KONTEXT, "wissen": wissen}
    text = "Ablauf Sommerfest der BSU am Rhein. Kontakt vor Ort: Peter Beispiel."
    antwort = _leer(bezug_beleg="Sommerfest der BSU", bezug="Sommerfest Basler Stadtunterhaltung",
                    beteiligte=[{"beleg": "Kontakt vor Ort: Peter Beispiel", "name": "Peter Beispiel", "rolle": "Hauswart"}])
    llm = _Llm(antwort)
    b = zj.zz_beschreiben(pfad="ZZ_Alt/ablauf.pdf", dateiname="ablauf.pdf", sha256="d" * 64, text=text, seiten=1,
                          ocr=False, kontext_roh=kontext, llm=llm, cfg=CFG, archiv=None)  # type: ignore[arg-type]
    nutzer = llm.aufrufe[0]["nutzer"]
    assert "Firmenwissen" in nutzer and "Basler Stadtunterhaltung" in nutzer and "Hauswart der Halle Nord" in nutzer
    assert "JJJJ-MM-TT_Offerte" not in nutzer, "Benennungsregeln braucht Claude, nicht der Beschrieb"
    s = b.beschrieb or {}
    assert s["bezug"] == "Sommerfest Basler Stadtunterhaltung", "Erklärung zum Begriff im Beleg zählt als Beleg"
    assert s["beteiligte"] == [{"name": "Peter Beispiel", "rolle": "Hauswart"}], "Rolle aus dem Firmenwissen zum Namen"
    # Ohne passenden Begriff im Dokument kein Abschnitt.
    llm2 = _Llm(_leer())
    zj.zz_beschreiben(pfad="ZZ_Alt/b.pdf", dateiname="b.pdf", sha256="e" * 64, text="Rechnung Lichttechnik Halle", seiten=1,
                      ocr=False, kontext_roh=kontext, llm=llm2, cfg=CFG, archiv=None)  # type: ignore[arg-type]
    assert "Firmenwissen" not in llm2.aufrufe[0]["nutzer"]


def test_zz_teil_passt_ins_fenster() -> None:
    # Voller Teil + langer bisheriger Beschrieb + Firmenwissen am Budget: gleiches num_ctx (kein Neuladen), nichts gekürzt.
    from app.handlers.ablage import lese_kontext, prompt_fuer
    from app.extract import Extrakt
    from app import wissen as wi

    k = lese_kontext({**KONTEXT, "mitarbeiter": [f"Vorname{i} Nachname{i}" for i in range(15)]}, "2026-10-16")
    teil = ("Allgemeine Bestimmungen zur Zusammenarbeit im Betrieb. " * 200)[: zj.TEIL_ZEICHEN]
    stand = zj._Stand(werte={"datum": "2025-03-03", "bezug": "x" * 160, "absender": "y" * 80, "empfaenger": "z" * 80},
                      beteiligte=[{"name": "n" * 80, "rolle": "r" * 60} for _ in range(8)],
                      frei={"dokumentart": "d" * 60, "unterart": "u" * 80, "titel": "t" * 60, "zweck": "w" * 300,
                            "schlagworte": ["s" * 30] * 10})
    hinweis = zj.teil_hinweis(2, 3, stand)
    eintraege = [wi.WissenEintrag("abkuerzung", f"B{i}", "e" * 200) for i in range(10)]
    block = wi.block(eintraege[:3])
    assert len(block) <= wi.BUDGET_ZEICHEN + 200
    nutzer, num_ctx = prompt_fuer(k, Extrakt(text=teil, mime="application/pdf", seiten=12, hinweis=hinweis),
                                  "datei.pdf (bisheriger Ablageort: A/B)", CFG, stufe2=False,
                                  system_zeichen=len(zj.SYSTEM_ZZ), antwort_tokens=zj.ANTWORT_TOKENS_ZZ, zusatz=block,
                                  mit_heute=False)
    assert num_ctx == CFG.llm_num_ctx and teil in nutzer and "gekürzt" not in nutzer


def test_fristen_ganzes_dokument_frist_im_mittelteil() -> None:
    # 12 Seiten mit Vorfilter-Treffer ohne Datum, die echte Frist nur auf Seite 9 — bis v1 sah das Modell nur die
    # ersten 6 Treffer-Abschnitte (+ Kopf) und fand sie nie.
    seiten = [f"[Seite {i}]\nAbschnitt {i}: Die Laufzeit richtet sich nach der Vereinbarung der Parteien." for i in range(1, 13)]
    seiten[8] = "[Seite 9]\nDer Vertrag endet am 31.03.2027 ohne Kündigung."
    text = "Rahmenvertrag Bühnentechnik zwischen Muster AG und EVENTLINE GmbH.\n\n" + "\n\n".join(seiten)
    teile = fj.auszug_teile(text)
    assert len(teile) >= 2, "alle Treffer-Abschnitte in Teilen"
    t_i, nr = next((i, a.nr) for i, t in enumerate(teile) for a in t if "31.03.2027" in a.text)
    assert t_i >= 1, "die Frist steht nicht im ersten Teil"
    leer = {"typ": "vertrag", "dok_datum": "", "partei": "Muster AG", "partei_art": "organisation", "personenbezogen": False,
            "fristen": []}
    antworten = [dict(leer) for _ in teile]
    antworten[t_i] = {**leer, "fristen": [_frist(art="vertragsende", abschnitt=nr, beleg="Der Vertrag endet am 31.03.2027",
                                                  ende="2027-03-31")]}
    llm = _Llm(*antworten)
    gewartet = []
    b = fj.fristen_pruefen(pfad="a/rahmen.pdf", dateiname="rahmen.pdf", text=text, ocr=False, kontext_roh=KONTEXT,
                           llm=llm, cfg=CFG, vorrang=lambda: gewartet.append(1))  # type: ignore[arg-type]
    assert len(llm.aufrufe) == len(teile) and len(gewartet) == len(teile) - 1, "zwischen den Teilen Vorrang prüfen"
    assert [f.art for f in b.fristen] == ["vertragsende"] and b.fristen[0].bedingungen["ende"] == "2027-03-31"
    assert b.zaehler["teile"] == len(teile) and b.fristen[0].seite == 9, "Frist im Mittelteil mit Beleg bleibt (Seite 9)"
    # Dieselbe Frist ohne Beleg aus dem Mittelteil: verworfen.
    antworten[t_i] = {**leer, "fristen": [_frist(art="vertragsende", abschnitt=nr, ende="2027-03-31")]}
    b2 = fj.fristen_pruefen(pfad="a/rahmen.pdf", dateiname="rahmen.pdf", text=text, ocr=False, kontext_roh=KONTEXT,
                            llm=_Llm(*antworten), cfg=CFG)  # type: ignore[arg-type]
    assert not b2.fristen and b2.zaehler["ohne_beleg"] == 1


def test_zz_ganzes_dokument_person_aus_teil_3() -> None:
    satz = "Allgemeine Bestimmungen zur Zusammenarbeit im Betrieb. "
    text = "Basel, 3. März 2025. " + satz * 420 + "Arbeitnehmer ist Max Beispiel, Funktion Techniker. " + satz * 30
    teile = zj.text_teile(text)
    assert len(teile) == 3 and all(len(t) <= zj.TEIL_ZEICHEN for t in teile)
    assert "Max Beispiel" in teile[2]
    a1 = _leer(dokumentart="Vertrag", zweck="Bestimmungen zur Zusammenarbeit", schlagworte=["Zusammenarbeit"],
               datum_beleg="Basel, 3. März 2025", datum="2025-03-03")
    # Teil 2 behauptet eine Person ohne Beleg (steht nicht in Teil 2), Teil 3 belegt sie mit Rolle.
    a2 = {**a1, "datum_beleg": "", "datum": "2025-03-03",
          "beteiligte": [{"beleg": "Arbeitnehmer ist Max Beispiel", "name": "Max Beispiel", "rolle": "Arbeitnehmer"}]}
    a3 = {**a1, "dokumentart": "Arbeitsvertrag", "datum_beleg": "", "datum": "unbekannt", "schlagworte": ["Techniker"],
          "beteiligte": [{"beleg": "Arbeitnehmer ist Max Beispiel", "name": "Max Beispiel",
                          "rolle": "Arbeitnehmer, Techniker"}], "personenbezogen": True}
    llm = _Llm(a1, a2, a3)
    b = zj.zz_beschreiben(pfad="ZZ_Alt/Vertrag.pdf", dateiname="Vertrag.pdf", sha256="c" * 64, text=text, seiten=8,
                          ocr=False, kontext_roh=KONTEXT, llm=llm, cfg=CFG, archiv=None)  # type: ignore[arg-type]
    s = b.beschrieb or {}
    assert len(llm.aufrufe) == 3
    nutzer3 = llm.aufrufe[2]["nutzer"]
    assert "Teil 3 von 3" in nutzer3 and "schon belegt" in nutzer3 and "2025-03-03" in nutzer3 and "Noch unbekannt" in nutzer3
    assert s["dokumentart"] == "Arbeitsvertrag" and s["datum"] == "2025-03-03", "erster belegter Wert gilt"
    assert s["beteiligte"] == [{"name": "Max Beispiel", "rolle": "Arbeitnehmer, Techniker"}]
    assert set(s["schlagworte"]) == {"Techniker", "Zusammenarbeit"}, "Belegtes aus Teil 1 bleibt"
    assert s["gelesen"] == "ganz gelesen (3 Teile)" and s["teile"] == 3
    # Teil 2 zählt als unbelegte Angabe, die Wiederholung des Datums in Teil 2 zählt nicht.
    assert b.belege["beteiligte"] == {"angegeben": 2, "belegt": 1} and b.belege["datum"] == {"angegeben": 1, "belegt": 1}


# --- Selbsttest -------------------------------------------------------------------------------------------


def test_stichprobe_rotiert() -> None:
    zeilen = [(f"02_LOCATIONS/A/{i}.pdf", "02_LOCATIONS/A", f"{i}.pdf", f"{i:064d}") for i in range(100)]
    zeilen += [("05_X/inaktiv.pdf", "05_X", "inaktiv.pdf", "f" * 64)]
    erlaubt = {"02_LOCATIONS/A"}
    a = sj.stichprobe(zeilen, erlaubt, sj.seed_fuer("2026-10-12/nacht"), 40)
    assert len(a) == 40 and all(p.ordner == "02_LOCATIONS/A" for p in a)
    assert a == sj.stichprobe(list(reversed(zeilen)), erlaubt, 20261012, 40), "deterministisch je Seed"
    assert a != sj.stichprobe(zeilen, erlaubt, sj.seed_fuer("2026-10-13/nacht"), 40), "rotiert mit der Nacht"
    assert len(sj.stichprobe(zeilen[:5], erlaubt, 1, 40)) == 5
    assert sj.neutraler_name("Offerte_INT-26-014.PDF") == "dokument.pdf"


def test_auf_platte_nfd() -> None:
    with tempfile.TemporaryDirectory() as d:
        wurzel = Path(d)
        ordner = wurzel / unicodedata.normalize("NFD", "02_Büro")
        ordner.mkdir()
        (ordner / unicodedata.normalize("NFD", "Prüfung.pdf")).write_bytes(b"%PDF")
        gefunden = sj.auf_platte(wurzel, unicodedata.normalize("NFC", "02_Büro/Prüfung.pdf"))
        assert gefunden is not None and gefunden.is_file()
        assert sj.auf_platte(wurzel, "02_Büro/fehlt.pdf") is None


def test_kennzahlen() -> None:
    e = [{"variante": "einsortiert", "top1": True, "top3": True, "kategorie": True, "leer": False, "ms": 100},
         {"variante": "einsortiert", "top1": False, "top3": True, "kategorie": True, "leer": False, "ms": 300},
         {"variante": "neutral", "fehler": "fehlt", "ms": 0}]
    k = sj.kennzahlen(e)
    assert k["einsortiert"] == {"dateien": 2, "gewertet": 2, "fehler": 0, "top1": 0.5, "top3": 1.0, "kategorie": 1.0,
                                "leer": 0.0, "ms_median": 200}
    assert k["neutral"]["fehler"] == 1 and k["neutral"]["top1"] is None


class _Client:
    def __init__(self, verhalten: dict[str | None, object], **kw) -> None:  # noqa: ANN003
        self.proxy = kw.get("proxy")
        self.verhalten = verhalten

    def __enter__(self):  # noqa: ANN204
        return self

    def __exit__(self, *a) -> None:  # noqa: ANN002
        pass

    def get(self, url: str):  # noqa: ANN201
        v = self.verhalten.get(self.proxy if "anthropic" in url else "fsm")
        if isinstance(v, Exception):
            raise v
        return httpx.Response(int(v or 200))


def test_egress() -> None:
    def fabrik(verhalten):  # noqa: ANN001, ANN202
        return lambda **kw: _Client(verhalten, **kw)

    gesperrt = {"http://egress:3128": httpx.ProxyError("403 Forbidden"), None: httpx.ConnectError("kein Netz"), "fsm": 200}
    r = sj.egress_test(CFG, client_fabrik=fabrik(gesperrt))
    assert r == {"ok": True, "anthropic_proxy": "proxy_abgewiesen", "anthropic_direkt": "ConnectError", "fsm_proxy": "http_200"}
    offen = {**gesperrt, None: 404}
    assert sj.egress_test(CFG, client_fabrik=fabrik(offen))["ok"] is False, "direkt erreichbar = Befund"


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
