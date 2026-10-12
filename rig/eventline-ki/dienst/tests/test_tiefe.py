"""Tiefen-Index (E2.5) ohne Datenbank und ohne Modell: Walker-Regeln, Abschnitte/Seitenmarken, inkrementeller Lauf,
Löschbremse, unvollständige Freigaben, Zeitbudget, Extraktion im Kindprozess, Planer-Thread der Nacht.

Läuft im Dienst-Image ohne Netz:
  docker run --rm --network none -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_tiefe.py
"""

from __future__ import annotations

import dataclasses
import os
import shutil
import sys
import tempfile
import threading
import time
import unicodedata
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app.tiefe as tiefe_modul  # noqa: E402
from app.config import laden  # noqa: E402
from app.jobs.tiefe import TiefenJob, lies_stand  # noqa: E402
from app.tiefe import (  # noqa: E402
    ABSCHNITT_ZEICHEN,
    ENTFERNEN_MAX_ANTEIL,
    UEBERLAPPUNG,
    Bestand,
    Text,
    TiefenIndexierer,
    abschnitt_rezept,
    ausgeschlossen,
    dateien,
    extrahiere_isoliert,
    freigaben_zustand,
    seiten,
    text_rezept,
    zerlege,
)

CFG = dataclasses.replace(laden(), tiefe_aktiv=True, tiefe_max_h=3.0, ocr_timeout_s=20)
ZH = ZoneInfo("Europe/Zurich")

# Alles, was der Tiefen-Index liest (NFC) — anders als der Vorbilder-Index auch ZZ_* (jede Tiefe) und 06_PERSONAL.
GELESEN = {
    "00_ADMIN_RECHT/03_Dauerverträge/Police Büro.txt",
    "02_LOCATIONS/100001_Halle_Nord/02_Plaene_Grundrisse/Grundriss EG.txt",
    "02_LOCATIONS/100001_Halle_Nord/ZZ_Archiv/alt.txt",
    "02_LOCATIONS/Freigabe-Wurzel.txt",
    "03_PROJEKTE_EVENTS/2026/INT-26-001-Firma_Alpha/Offerte_26-001.txt",
    "06_PERSONAL/0001_Anna_Muster/Arbeitsvertrag.txt",
    "ZZ_Dokumente_zum_Einsortieren/Scan_0042.txt",
}


def _nas(wurzel: Path) -> None:
    dateien_ = {
        "00_ADMIN_RECHT/03_Dauerverträge/Police Büro.txt": "Police Betriebshaftpflicht, Kündigungsfrist drei Monate",
        "02_LOCATIONS/100001_Halle_Nord/02_Plaene_Grundrisse/Grundriss EG.txt": "Grundriss Erdgeschoss Halle Nord",
        "02_LOCATIONS/100001_Halle_Nord/ZZ_Archiv/alt.txt": "alter Plan (ZZ auf Tiefe 2 — im Tiefen-Index enthalten)",
        "02_LOCATIONS/Freigabe-Wurzel.txt": "Datei direkt in der Freigabe",
        "02_LOCATIONS/99_System/log.txt": "nie",
        "02_LOCATIONS/.versteckt.txt": "nie",
        "02_LOCATIONS/~$Plan.docx": "nie",
        "02_LOCATIONS/@eaDir/x.txt": "nie",
        "02_LOCATIONS/Skizze.indd": "nie (nicht lesbar)",
        "03_PROJEKTE_EVENTS/2026/INT-26-001-Firma_Alpha/Offerte_26-001.txt": "Offerte Sommerfest Firma Alpha",
        "06_PERSONAL/0001_Anna_Muster/Arbeitsvertrag.txt": "Arbeitsvertrag Personalakte",
        "99_System/papierkorb.txt": "nie (99_System als Freigabe)",
        ".snapshot/a.txt": "nie (versteckte Freigabe)",
        "ZZ_Dokumente_zum_Einsortieren/Scan_0042.txt": "Rückstau ZZ — im Tiefen-Index enthalten",
        "lose_in_der_wurzel.txt": "nie (NAS-Wurzel, keine Freigabe)",
    }
    for rel, inhalt in dateien_.items():
        p = wurzel / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(inhalt, encoding="utf-8")
    # Zerlegte Umlaute (NFD) wie von einem Mac abgelegt
    alt = wurzel / "00_ADMIN_RECHT/03_Dauerverträge"
    nfd = wurzel / unicodedata.normalize("NFD", "00_ADMIN_RECHT/03_Dauerverträge")
    if alt != nfd:
        os.replace(alt, nfd)
        os.replace(nfd / "Police Büro.txt", nfd / unicodedata.normalize("NFD", "Police Büro.txt"))


# --- Regeln ---------------------------------------------------------------------------------------


def test_ausgeschlossen() -> None:
    assert ausgeschlossen("99_System") and ausgeschlossen(".git") and ausgeschlossen("@eaDir") and ausgeschlossen("#recycle")
    assert ausgeschlossen("~$x.docx")
    assert not ausgeschlossen("ZZ_Dokumente_zum_Einsortieren") and not ausgeschlossen("ZZ_Archiv"), "ZZ_* gehört dazu"
    assert not ausgeschlossen("06_PERSONAL"), "Personal gehört dazu (E4/E5)"


def test_walker() -> None:
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        _nas(w)
        lesbar, unvoll = freigaben_zustand(w)
        assert "ZZ_Dokumente_zum_Einsortieren" in lesbar and "06_PERSONAL" in lesbar, lesbar
        assert "99_System" not in lesbar and ".snapshot" not in lesbar and unvoll == []
        liste, fehlerhaft = dateien(w, lesbar)
        pfade = {x.pfad for x in liste}
        assert pfade == GELESEN, pfade ^ GELESEN
        assert fehlerhaft == set()
        assert all(unicodedata.is_normalized("NFC", p) for p in pfade), "Pfade immer NFC"
        assert not any("99_System" in p for p in pfade), "99_System nie"
        wurzel_datei = next(x for x in liste if x.name == "Freigabe-Wurzel.txt")
        assert wurzel_datei.ordner == "02_LOCATIONS"


def test_walker_unterordner_nicht_lesbar() -> None:
    if os.geteuid() == 0:
        print("        (übersprungen: als root sind Rechte wirkungslos)")
        return
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        _nas(w)
        gesperrt = w / "03_PROJEKTE_EVENTS/2026"
        gesperrt.chmod(0)
        try:
            liste, fehlerhaft = dateien(w, freigaben_zustand(w)[0])
            assert fehlerhaft == {"03_PROJEKTE_EVENTS"}, fehlerhaft
            assert not any(x.pfad.startswith("03_PROJEKTE_EVENTS/") for x in liste)
        finally:
            gesperrt.chmod(0o755)


# --- Abschnitte -----------------------------------------------------------------------------------


def test_seitenmarken() -> None:
    text = "[Seite 1]\nTitel\n\n[Seite 3]\nDritte Seite\n\n[Text gekürzt: nur die ersten 10 von 20 Zeichen]"
    assert seiten(text) == [(1, "\nTitel\n\n"), (3, "\nDritte Seite")], seiten(text)
    assert seiten("Ohne Marken\n\nzweiter Absatz") == [(None, "Ohne Marken\n\nzweiter Absatz")]
    assert seiten("") == [] and seiten("   ") == []
    # «[Seite 2]» mitten in einer Zeile ist keine Marke.
    assert seiten("siehe [Seite 2] im Anhang") == [(None, "siehe [Seite 2] im Anhang")]


def test_zerlege_grenzen_und_ueberlappung() -> None:
    worte = " ".join(f"Wort{i:04d}" for i in range(600))  # ~5400 Zeichen, ein einziger Absatz
    text = f"[Seite 1]\nKurzer Kopf mit genug Zeichen\n\n{worte}\n\n[Seite 2]\nZweite Seite mit Inhalt hier"
    teile = zerlege(text)
    assert [a.nr for a in teile] == list(range(len(teile))), "fortlaufende Nummern"
    assert all(len(a.text) <= ABSCHNITT_ZEICHEN + 5 for a in teile), max(len(a.text) for a in teile)
    s1 = [a for a in teile if a.seite == 1]
    s2 = [a for a in teile if a.seite == 2]
    assert len(s1) >= 7 and len(s2) == 1, (len(s1), len(s2))
    assert s2[0].text == "Zweite Seite mit Inhalt hier", "nie über die Seitengrenze"
    for vor, nach in zip(s1, s1[1:]):
        # Der nächste Abschnitt beginnt mit den letzten ~120 Zeichen des vorigen (an einer Wortgrenze).
        assert nach.text[:60] in vor.text[-UEBERLAPPUNG:], (vor.text[-UEBERLAPPUNG:], nach.text[:60])
    # Alle Wörter kommen vor (nichts verloren).
    zusammen = " ".join(a.text for a in s1)
    assert all(f"Wort{i:04d}" in zusammen for i in range(600))


def test_zerlege_absaetze_und_rauschen() -> None:
    absaetze = [f"Absatz {i}: " + "Inhalt " * 20 for i in range(10)]   # je ~150 Zeichen
    teile = zerlege("\n\n".join(absaetze))
    assert all(a.seite is None for a in teile)
    assert 2 <= len(teile) <= 4, len(teile)
    assert teile[0].text.startswith("Absatz 0:") and "\n\nAbsatz 1:" in teile[0].text, "an Absatzgrenzen gefügt"
    assert zerlege("[Seite 1]\n12\n\n[Seite 2]\n-- -- --") == [], "Seitenzahlen/Linien sind keine Abschnitte"
    assert zerlege("") == []


# --- Indexlauf mit Attrappen ----------------------------------------------------------------------


class _Index:
    """Attrappe von TiefenIndex (nur was der Lauf braucht)."""

    def __init__(self) -> None:
        self.zeilen: dict[str, dict] = {}
        self.ok = True

    def bereit(self) -> bool:
        return self.ok

    def bestand(self) -> dict[str, Bestand]:
        return {p: Bestand(z["groesse"], z["mtime"], z["sha"], z["rt"], z["ra"], z.get("fehler"), z.get("versuche", 0),
                           z.get("alter"))
                for p, z in self.zeilen.items()}

    def uebernehme(self, d, sha, rt, ra) -> bool:  # noqa: ANN001
        quelle = next((z for p, z in self.zeilen.items() if z["sha"] == sha and z["rt"] == rt and z["ra"] == ra
                       and not z.get("versuche") and p != d.pfad), None)
        if quelle is None:
            return False
        self.zeilen[d.pfad] = {**quelle, "groesse": d.groesse, "mtime": d.mtime}
        return True

    def speichere(self, d, sha, t, sprache, abschnitte, vektoren, rt, ra) -> None:  # noqa: ANN001
        assert len(abschnitte) == len(vektoren)
        self.zeilen[d.pfad] = {"groesse": d.groesse, "mtime": d.mtime, "sha": sha, "rt": rt, "ra": ra, "text": t.text,
                               "abschnitte": [a.text for a in abschnitte], "sprache": sprache, "fehler": t.fehler,
                               "versuche": 0, "alter": 0.0}

    def vormerken(self, d, sha, fehler, versuche, rt) -> None:  # noqa: ANN001
        self.zeilen[d.pfad] = {"groesse": d.groesse, "mtime": d.mtime, "sha": sha, "rt": rt, "ra": None, "text": "",
                               "abschnitte": [], "sprache": None, "fehler": fehler, "versuche": versuche, "alter": 0.0}

    def text_von(self, pfad: str):  # noqa: ANN201
        z = self.zeilen.get(pfad)
        return z["text"] if z else None

    def speichere_abschnitte(self, pfad, abschnitte, vektoren, ra) -> None:  # noqa: ANN001
        self.zeilen[pfad]["abschnitte"] = [a.text for a in abschnitte]
        self.zeilen[pfad]["ra"] = ra

    def entferne(self, pfade) -> None:  # noqa: ANN001
        for p in pfade:
            self.zeilen.pop(p, None)

    def zaehler(self, max_alter_s: float = 0.0) -> dict[str, int]:
        return {"dateien": sum(1 for z in self.zeilen.values() if not z.get("versuche")),
                "mit_text": sum(1 for z in self.zeilen.values() if z["text"]),
                "abschnitte": sum(len(z["abschnitte"]) for z in self.zeilen.values())}


class _Llm:
    def __init__(self) -> None:
        self.stapel: list[int] = []

    def einbetten(self, *, modell: str, texte: list[str], timeout_s: float = 120.0, keep_alive=None):  # noqa: ANN001
        self.stapel.append(len(texte))
        return [[1.0, 0.0] for _ in texte], {"modell": modell}

    def geladene_modelle(self) -> list[dict]:
        return []

    def entlade(self, modell=None) -> None:  # noqa: ANN001
        pass


def _lesen(d, cfg, halt) -> Text:  # noqa: ANN001 — Extraktion im selben Prozess (schnell, für die Lauf-Tests)
    return Text(d.voll.read_text(encoding="utf-8"))


def _ix(w: Path, idx: _Index | None = None, llm: _Llm | None = None, **kw) -> tuple[TiefenIndexierer, _Index, _Llm]:
    idx, llm = idx or _Index(), llm or _Llm()
    return TiefenIndexierer(CFG, idx, llm, lambda: True, wurzel=w, extraktor=_lesen, **kw), idx, llm  # type: ignore[arg-type]


def test_lauf_inkrementell_und_verschieben() -> None:
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        _nas(w)
        ix, idx, llm = _ix(w)
        b = ix.lauf()
        assert (b.nas_dateien, b.neu, b.unveraendert, b.entfernt, b.abgebrochen) == (7, 7, 0, 0, False), b
        assert b.vollstaendig and set(idx.zeilen) == GELESEN and ix.letzter_lauf
        assert all(z["rt"] == text_rezept(CFG) and z["ra"] == abschnitt_rezept(CFG) for z in idx.zeilen.values())
        assert idx.zeilen["ZZ_Dokumente_zum_Einsortieren/Scan_0042.txt"]["abschnitte"], "ZZ hat Abschnitte"
        # Zweiter Lauf: nichts geändert → nichts gelesen.
        n = len(llm.stapel)
        b2 = ix.lauf()
        assert (b2.unveraendert, b2.neu, b2.uebernommen) == (7, 0, 0) and len(llm.stapel) == n
        # Verschieben (gleicher Inhalt) → übernommen ohne Lesen, alter Pfad entfernt; Löschen → entfernt (2/7 < 50 %).
        os.replace(w / "02_LOCATIONS/Freigabe-Wurzel.txt", w / "02_LOCATIONS/100001_Halle_Nord/Freigabe-Wurzel.txt")
        (w / "03_PROJEKTE_EVENTS/2026/INT-26-001-Firma_Alpha/Offerte_26-001.txt").unlink()
        b3 = ix.lauf()
        assert (b3.uebernommen, b3.neu, b3.entfernt) == (1, 0, 2), b3
        assert "02_LOCATIONS/100001_Halle_Nord/Freigabe-Wurzel.txt" in idx.zeilen and len(llm.stapel) == n
        # Geänderter Inhalt → neu gelesen.
        p = w / "02_LOCATIONS/100001_Halle_Nord/02_Plaene_Grundrisse/Grundriss EG.txt"
        p.write_text("Grundriss Obergeschoss, neu gezeichnet", encoding="utf-8")
        os.utime(p, (1, 1))
        b4 = ix.lauf()
        assert b4.neu == 1 and b4.unveraendert == 5, b4
        # Neues Abschnitt-Rezept (z. B. anderes Einbettungsmodell) → nur neu zerlegen, nicht neu lesen.
        for z in idx.zeilen.values():
            z["ra"] = "alt|v0"
        b5 = ix.lauf()
        assert b5.neu_zerlegt == 6 and b5.neu == 0, b5


def test_bremse_bei_leerer_freigabe() -> None:
    # Eine Freigabe fehlt (nicht eingehängt = leerer Ordner): ihre Zeilen bleiben, der Lauf gilt als unvollständig.
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        _nas(w)
        ix, idx, _ = _ix(w)
        ix.lauf()
        shutil.rmtree(w / "ZZ_Dokumente_zum_Einsortieren")
        (w / "ZZ_Dokumente_zum_Einsortieren").mkdir()
        b = ix.lauf()
        assert b.unvollstaendig == 1 and b.entfernt == 0 and not b.vollstaendig, b
        assert "ZZ_Dokumente_zum_Einsortieren/Scan_0042.txt" in idx.zeilen, "Zeilen der fehlenden Freigabe bleiben"


def test_bremse_ab_50_prozent() -> None:
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        _nas(w)
        ix, idx, _ = _ix(w)
        ix.lauf()
        # 4 von 7 verschwinden auf einmal (≥ 50 %), alle Freigaben scheinbar vollständig → nichts entfernt.
        for rel in ("02_LOCATIONS/Freigabe-Wurzel.txt", "02_LOCATIONS/100001_Halle_Nord/ZZ_Archiv/alt.txt",
                    "02_LOCATIONS/100001_Halle_Nord/02_Plaene_Grundrisse/Grundriss EG.txt",
                    "03_PROJEKTE_EVENTS/2026/INT-26-001-Firma_Alpha/Offerte_26-001.txt"):
            (w / rel).unlink()
        assert 4 >= ENTFERNEN_MAX_ANTEIL * 7
        b = ix.lauf()
        assert b.entfernen_gebremst == 4 and b.entfernt == 0 and len(idx.zeilen) == 7 and not b.vollstaendig, b
        # Wurzel ganz weg: nichts gelesen, nichts entfernt.
        shutil.rmtree(w)
        w.mkdir()
        b2 = ix.lauf()
        assert b2.abgebrochen and b2.entfernt == 0 and len(idx.zeilen) == 7


def test_zeitbudget_und_halt() -> None:
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        _nas(w)
        ix, idx, _ = _ix(w)
        b = ix.lauf(frist=time.monotonic() - 1)
        assert b.frist_erreicht and b.offen == 7 and b.neu == 0 and not b.vollstaendig, b
        b2 = ix.lauf(weiter=lambda: False)
        assert b2.frist_erreicht and b2.offen == 7
        # Halt während des Wartens auf Ruhe: unterbrochen, nichts entfernt.
        ix2, idx2, _ = _ix(w)
        ix2.ruhig = lambda: False
        threading.Timer(0.3, ix2.stop).start()
        b3 = ix2.lauf()
        assert b3.abgebrochen and b3.neu == 0 and idx2.zeilen == {}


def test_wartet_auf_vorrang() -> None:
    # Der Vorbilder-Index (vorrang) und Aufträge (ruhig) haben Vorrang: der Lauf wartet vor jeder Datei.
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        _nas(w)
        frei = threading.Event()
        ix, idx, _ = _ix(w, vorrang=lambda: not frei.is_set())
        threading.Timer(2.5, frei.set).start()
        t0 = time.monotonic()
        b = ix.lauf()
        assert time.monotonic() - t0 >= 2.0 and b.neu == 7, b


def test_einbettung_in_stapeln() -> None:
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        (w / "02_LOCATIONS").mkdir()
        (w / "02_LOCATIONS/lang.txt").write_text("\n\n".join(f"Absatz {i} " + "x" * 700 for i in range(70)), encoding="utf-8")
        ix, idx, llm = _ix(w)
        ix.lauf()
        assert llm.stapel and max(llm.stapel) <= 32 and sum(llm.stapel) == len(idx.zeilen["02_LOCATIONS/lang.txt"]["abschnitte"])


def test_extraktion_im_kindprozess() -> None:
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        _nas(w)
        liste, _ = dateien(w, freigaben_zustand(w)[0])
        police = next(x for x in liste if x.name.startswith("Police"))
        t = extrahiere_isoliert(police, CFG, threading.Event())
        assert t.fehler is None and "Kündigungsfrist" in t.text, t
        # Unlesbar (leer) → Fehlercode statt Absturz, kein Name im Code.
        leer = w / "02_LOCATIONS/leer.txt"
        leer.write_bytes(b"")
        t2 = extrahiere_isoliert(dataclasses.replace(police, voll=leer, name="leer.txt"), CFG, threading.Event())
        assert t2.text == "" and t2.fehler == "unlesbar", t2
        # Zeitgrenze: der Kindprozess (samt Gruppe) wird beendet, Ergebnis «zeit» statt Hänger.
        alt = tiefe_modul.KIND_TIMEOUT_S
        tiefe_modul.KIND_TIMEOUT_S = 0.0
        try:
            t3 = extrahiere_isoliert(police, CFG, threading.Event())
            assert t3.fehler in ("zeit", None), t3  # None: Kind war vor der ersten Prüfung (1 s) schon fertig
        finally:
            tiefe_modul.KIND_TIMEOUT_S = alt
        # Halt: InterruptedError (oder fertig, wenn das Kind schneller war).
        halt = threading.Event()
        halt.set()
        tiefe_modul.KIND_TIMEOUT_S = 0.0
        try:
            try:
                extrahiere_isoliert(police, CFG, halt)
            except InterruptedError:
                pass
        finally:
            tiefe_modul.KIND_TIMEOUT_S = alt


def test_voruebergehender_fehler_nicht_als_gelesen() -> None:
    # Befund Review E2: «kind_-9» (OOM-Kill des Kindprozesses) oder «zeit» galt als fertig gelesen — für immer.
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        _nas(w)
        police = "00_ADMIN_RECHT/03_Dauerverträge/Police Büro.txt"
        kopie = "02_LOCATIONS/Police-Kopie.txt"
        (w / kopie).write_bytes((w / unicodedata.normalize("NFD", police)).read_bytes())  # auf der Platte NFD
        os.utime(w / kopie, (5, 5))
        fehler = {"code": "kind_-9"}

        def lesen(dd, cfg, halt):  # noqa: ANN001
            if dd.name.startswith("Police") and fehler["code"]:
                return Text("", fehler=fehler["code"])
            return _lesen(dd, cfg, halt)

        ix, idx, _ = _ix(w)
        ix.extraktor = lesen
        b = ix.lauf()
        assert b.fehler == 2 and b.fehler_arten.get("kind_-9") == 2 and b.neu == 6 and b.vollstaendig, b
        assert idx.zeilen[police]["versuche"] == 1 and idx.zeilen[police]["abschnitte"] == []
        assert idx.zaehler()["dateien"] == 6, "vorübergehend gescheitert zählt nicht als gelesen"
        assert tiefe_modul.voruebergehend("zeit") and tiefe_modul.voruebergehend("kind_ausgabe")
        assert not tiefe_modul.voruebergehend("unlesbar") and not tiefe_modul.voruebergehend(None)
        # Gleiche Nacht (10-min-Wiederholung): noch nicht fällig, nichts gelesen.
        b2 = ix.lauf()
        assert b2.wiederholen == 2 and b2.fehler == 0 and b2.neu == 0, b2
        # Nächste Nacht (≥ 6 h): neuer Versuch, scheitert wieder → Zähler 2; die Kopie wird nie «übernommen».
        for p in (police, kopie):
            idx.zeilen[p]["alter"] = tiefe_modul.VERSUCH_ABSTAND_S
        b3 = ix.lauf()
        assert b3.fehler == 2 and b3.uebernommen == 0 and idx.zeilen[police]["versuche"] == 2, b3
        # Dritte Nacht klappt: Text da, Zähler 0, Kopie danach übernommen statt gelesen wäre auch richtig.
        fehler["code"] = None
        for p in (police, kopie):
            idx.zeilen[p]["alter"] = tiefe_modul.VERSUCH_ABSTAND_S
        b4 = ix.lauf()
        assert b4.neu + b4.uebernommen == 2 and b4.fehler == 0, b4
        assert idx.zeilen[police]["versuche"] == 0 and "Kündigungsfrist" in idx.zeilen[police]["text"]
        assert idx.zaehler()["dateien"] == 8


def test_voruebergehender_fehler_hoechstens_drei_versuche() -> None:
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        _nas(w)
        police = "00_ADMIN_RECHT/03_Dauerverträge/Police Büro.txt"

        def lesen(dd, cfg, halt):  # noqa: ANN001
            return Text("", fehler="zeit") if dd.name.startswith("Police") else _lesen(dd, cfg, halt)

        ix, idx, _ = _ix(w)
        ix.extraktor = lesen
        for n in range(1, tiefe_modul.MAX_LESEVERSUCHE + 1):
            ix.lauf()
            assert idx.zeilen[police]["versuche"] == n
            idx.zeilen[police]["alter"] = tiefe_modul.VERSUCH_ABSTAND_S
        b = ix.lauf()
        assert b.fehler == 0 and b.wiederholen == 0 and b.unveraendert == 7, "aufgegeben — bis sich die Datei ändert"
        # Datei geändert → neuer Anlauf mit frischem Zähler.
        p = w / unicodedata.normalize("NFD", police)
        p.write_text("Neue Police, Kündigungsfrist 6 Monate", encoding="utf-8")
        os.utime(p, (9, 9))
        ix.lauf()
        assert idx.zeilen[police]["versuche"] == 1


# --- Planer-Thread der Nacht ----------------------------------------------------------------------


class _Uhr:
    def __init__(self, t: datetime) -> None:
        self.t = t

    def __call__(self) -> datetime:
        return self.t


def test_planer_nacht_budget_und_vorrang() -> None:
    with tempfile.TemporaryDirectory() as d:
        w = Path(d) / "nas"
        w.mkdir()
        _nas(w)
        stand = Path(d) / "tiefe-stand.json"
        ix, idx, _ = _ix(w)
        uhr = _Uhr(datetime(2026, 10, 12, 14, 0, tzinfo=ZH))
        vorbilder = {"laeuft": False}
        job = TiefenJob(CFG, ix, vorbilder_laeuft=lambda: vorbilder["laeuft"], uhr=uhr, stand_datei=stand)
        assert job.runde() == "tag" and idx.zeilen == {}, "tagsüber nie"
        uhr.t = datetime(2026, 10, 12, 6, 50, tzinfo=ZH)
        assert job.runde() == "vor_tag", "ab 06:45 nicht mehr"
        uhr.t = datetime(2026, 10, 12, 19, 10, tzinfo=ZH)
        vorbilder["laeuft"] = True
        assert job.runde() == "vorbilder", "der Vorbilder-Index hat Vorrang"
        vorbilder["laeuft"] = False
        assert job.runde() == "gelaufen" and len(idx.zeilen) == 7
        s = lies_stand(stand)
        assert s["fenster"] == "2026-10-12/nacht" and s["fertig"] is True and s["nas_dateien"] == 7, s
        assert job.runde() == "fertig", "einmal je Nacht"
        st = job.status()
        assert st["gelesen_anteil"] == 1.0 and st["dateien"] == 7 and st["nacht"]["fertig"] is True
        # Nächste Nacht: neues Fenster, Budget wieder voll; Neustart behält den Stand.
        uhr.t = datetime(2026, 10, 13, 23, 0, tzinfo=ZH)
        job2 = TiefenJob(CFG, ix, uhr=uhr, stand_datei=stand)
        assert job2.stand["fertig"] is True
        assert job2.runde() == "gelaufen" and job2.stand["fenster"] == "2026-10-13/nacht"
        # Budget aufgebraucht → keine weitere Runde in dieser Nacht.
        job2.stand["fertig"] = False
        job2.stand["sekunden"] = CFG.tiefe_max_h * 3600
        assert job2.runde() == "budget"


def test_planer_wartet_auf_hauptmodell() -> None:
    with tempfile.TemporaryDirectory() as d:
        w = Path(d) / "nas"
        w.mkdir()
        _nas(w)
        ix, idx, _ = _ix(w)
        geladen = {"ja": True}
        job = TiefenJob(CFG, ix, hauptmodell_aktiv=lambda: geladen["ja"], uhr=_Uhr(datetime(2026, 10, 12, 21, 0, tzinfo=ZH)),
                        stand_datei=Path(d) / "s.json")
        assert job.runde() == "hauptmodell" and idx.zeilen == {}, "neben dem geladenen Hauptmodell nicht lesen"
        geladen["ja"] = False
        assert job.runde() == "gelaufen" and len(idx.zeilen) == 7


def test_planer_budget_begrenzt_lauf() -> None:
    with tempfile.TemporaryDirectory() as d:
        w = Path(d) / "nas"
        w.mkdir()
        _nas(w)
        ix, idx, _ = _ix(w)
        cfg = dataclasses.replace(CFG, tiefe_max_h=0.1)
        uhr = _Uhr(datetime(2026, 10, 12, 1, 0, tzinfo=ZH))
        job = TiefenJob(cfg, ix, uhr=uhr, stand_datei=Path(d) / "s.json")
        # Rest 1 µs (nicht 1 ms: auf dem Rig liest der Lauf in 1 ms schon mehrere der kleinen Test-Dateien — flackerte
        # 12.10. in 3 von 4 Läufen, auch mit dem alten Stand).
        job.stand = {"fenster": "2026-10-11/nacht", "sekunden": 0.1 * 3600 - 1e-6, "fertig": False}
        time.sleep(0.01)
        assert job.runde() == "gelaufen"
        assert ix.letzte_bilanz.frist_erreicht and idx.zeilen == {} and job.stand["fertig"] is False
        assert job.runde() == "budget"


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
