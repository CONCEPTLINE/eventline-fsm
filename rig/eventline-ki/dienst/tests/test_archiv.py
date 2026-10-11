"""Archiv-Index ohne Datenbank und ohne Modell: NAS-Durchgang, Einbettungstext, inkrementeller Indexlauf.

Läuft im Dienst-Image (oder mit jedem Python ≥ 3.11 und httpx), ohne Ollama, ohne Datenbank:
  docker run --rm --network none -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_archiv.py

Geprüft wird vor allem, was die Ordnerwahl als Vorbild sieht (nie ZZ_*, nie 99_System, keine versteckten
Dateien, NFC) und dass der Lauf nur Neues einbettet, Verschobenes übernimmt und Gelöschtes entfernt.
"""

from __future__ import annotations

import dataclasses
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unicodedata
from datetime import datetime
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app.archiv as archiv_modul  # noqa: E402
from app.archiv import (  # noqa: E402
    ENTFERNEN_MAX_ANTEIL,
    TEXT_ANFANG,
    ArchivIndex,
    Indexierer,
    NasDatei,
    _vektor_text,
    ausgeschlossen,
    einbettungstext,
    freigaben_zustand,
    lesbarer_name,
    nachtzeit,
    nas_bereit,
    nas_dateien,
    nas_ordner,
    ordner_text,
    platz_fuer_einbettung,
    rezept_fuer,
    unter_zz,
)
from app.config import laden  # noqa: E402
from app.gpu import SCHLEUSE  # noqa: E402
from app.llm import Ollama  # noqa: E402

CFG = dataclasses.replace(laden(), index_ocr_seiten=1, ocr_timeout_s=20)
# Alle lesbaren Vorbilder des Test-NAS (NFC) — Dateien in ZZ_*/99_System/versteckt/Wurzel fehlen.
VORBILDER = {
    "00_ADMIN_RECHT/03_Dauerverträge/Police Büro.txt",
    "02_LOCATIONS/100001_Halle_Nord/02_Plaene_Grundrisse/Bestuhlung.txt",
    "02_LOCATIONS/100001_Halle_Nord/02_Plaene_Grundrisse/Grundriss EG.txt",
    "02_LOCATIONS/100002_Saal_Sued/01_Plaene_Grundrisse/Plan OG.txt",
    "03_PROJEKTE_EVENTS/2026/INT-26-001-Firma_Alpha/Offerte_26-001.txt",
    "05_VERKAUF_MARKETING/01_Logos/Logo Beschrieb.txt",
}


def _nas(wurzel: Path) -> None:
    """Kleines NAS: vier Freigaben, ZZ-Freigabe, ZZ_ tief, 99_System, versteckte und nicht lesbare Dateien."""
    dateien = {
        "02_LOCATIONS/100001_Halle_Nord/02_Plaene_Grundrisse/Grundriss EG.txt": "Grundriss Erdgeschoss Halle Nord",
        "02_LOCATIONS/100001_Halle_Nord/02_Plaene_Grundrisse/Bestuhlung.txt": "Bestuhlungsplan 400 Personen",
        "02_LOCATIONS/100001_Halle_Nord/ZZ_Archiv/01_Plaene_Grundrisse/alt.txt": "nie (ZZ auf Tiefe 2)",
        "02_LOCATIONS/100002_Saal_Sued/01_Plaene_Grundrisse/Plan OG.txt": "Plan Obergeschoss Saal Sued",
        "03_PROJEKTE_EVENTS/2026/INT-26-001-Firma_Alpha/Offerte_26-001.txt": "Offerte Sommerfest Firma Alpha",
        "03_PROJEKTE_EVENTS/2026/INT-26-001-Firma_Alpha/.versteckt.txt": "nie",
        "03_PROJEKTE_EVENTS/2026/INT-26-001-Firma_Alpha/~$Offerte.docx": "nie",
        "03_PROJEKTE_EVENTS/2026/INT-26-001-Firma_Alpha/Skizze.indd": "nie (nicht lesbar)",
        "03_PROJEKTE_EVENTS/99_System/log.txt": "nie",
        "03_PROJEKTE_EVENTS/ZZ_Alt/alt.txt": "nie (ZZ auf erster Ebene)",
        "05_VERKAUF_MARKETING/01_Logos/Logo Beschrieb.txt": "Logo EVENTLINE rot",
        "ZZ_Dokumente_zum_Einsortieren/neu.txt": "nie (ZZ-Freigabe)",
        "lose_in_der_wurzel.txt": "nie (Wurzel)",
    }
    for rel, inhalt in dateien.items():
        p = wurzel / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(inhalt, encoding="utf-8")
    (wurzel / "00_ADMIN_RECHT/02_Versicherungen").mkdir(parents=True, exist_ok=True)
    # Zerlegte Umlaute (NFD) wie von einem Mac abgelegt
    nfd = unicodedata.normalize("NFD", "00_ADMIN_RECHT/03_Dauerverträge")
    (wurzel / nfd).mkdir(parents=True, exist_ok=True)
    (wurzel / nfd / unicodedata.normalize("NFD", "Police Büro.txt")).write_text("Police", encoding="utf-8")


def test_ausgeschlossen() -> None:
    assert ausgeschlossen(".git", 3) and ausgeschlossen("@eaDir", 2) and ausgeschlossen("#recycle", 0) and ausgeschlossen("~$x.docx", 4)
    assert ausgeschlossen("ZZ_Dokumente_zum_Einsortieren", 0) and ausgeschlossen("ZZ_Alt", 1)
    assert ausgeschlossen("ZZ_tief", 2) and ausgeschlossen("zz_klein", 5), "ZZ_ auf JEDER Tiefe (Entscheid 2026-10-11; die FSM-Liste filtert nicht nach Namen)"
    assert ausgeschlossen("99_System", 0) and ausgeschlossen("99_System", 3), "99_System nie"
    assert not ausgeschlossen("02_LOCATIONS", 0)
    assert unter_zz("02_LOCATIONS/100001_Halle_Nord/ZZ_Archiv/01_Plaene") and unter_zz("ZZ_Dokumente/x") and not unter_zz("02_LOCATIONS/ZZx")


def test_nas_durchgang() -> None:
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        _nas(w)
        dateien = list(nas_dateien(w))
        pfade = [x.pfad for x in dateien]
        assert set(pfade) == VORBILDER, pfade
        assert all(unicodedata.is_normalized("NFC", p) for p in pfade), "Pfade immer NFC"
        police = next(x for x in dateien if x.name.startswith("Police"))
        assert police.ordner == "00_ADMIN_RECHT/03_Dauerverträge" and police.voll.exists() and police.groesse == 6
        ordner = nas_ordner(w)
        assert "02_LOCATIONS" in ordner and "00_ADMIN_RECHT/02_Versicherungen" in ordner and "00_ADMIN_RECHT/03_Dauerverträge" in ordner
        assert not any(o.startswith("ZZ_") or "99_System" in o or "/ZZ_" in o for o in ordner)
        # Nur bestimmte Freigaben durchgehen (unvollständige werden ausgelassen).
        nur = {x.pfad for x in nas_dateien(w, freigaben=["02_LOCATIONS"])}
        assert nur == {p for p in VORBILDER if p.startswith("02_LOCATIONS/")}
        assert all(o.startswith("02_LOCATIONS") for o in nas_ordner(w, freigaben=["02_LOCATIONS"]))


def test_freigaben_zustand() -> None:
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        _nas(w)
        lesbar, unvoll = freigaben_zustand(w)
        assert lesbar == ["00_ADMIN_RECHT", "02_LOCATIONS", "03_PROJEKTE_EVENTS", "05_VERKAUF_MARKETING"] and unvoll == []
        assert nas_bereit(w)
        # Freigabe nicht eingehängt = leerer Ordner (so legt sie das Mount-Skript an) → unvollständig.
        shutil.rmtree(w / "03_PROJEKTE_EVENTS")
        (w / "03_PROJEKTE_EVENTS").mkdir()
        lesbar, unvoll = freigaben_zustand(w)
        assert unvoll == ["03_PROJEKTE_EVENTS"] and "02_LOCATIONS" in lesbar and nas_bereit(w)
        # Auf dem Rig ist jede Freigabe ein Mount-Punkt: ist eine keiner (aber andere schon), ist sie unvollständig —
        # auch wenn im Ordner etwas liegt (Reste, falsches Verzeichnis).
        echt = archiv_modul._ismount
        try:
            archiv_modul._ismount = lambda p: Path(p).name != "02_LOCATIONS"
            lesbar, unvoll = freigaben_zustand(w)
            assert set(unvoll) == {"02_LOCATIONS", "03_PROJEKTE_EVENTS"} and lesbar == ["00_ADMIN_RECHT", "05_VERKAUF_MARKETING"]
            archiv_modul._ismount = lambda p: False
            assert nas_bereit(w), "ohne jeden Mount-Punkt (Entwicklung/Test) zählt nur der Inhalt"
        finally:
            archiv_modul._ismount = echt
        # Leere Wurzel (NAS komplett weg): nichts lesbar.
        leer = w / "leer"
        leer.mkdir()
        for n in ("02_LOCATIONS", "03_PROJEKTE_EVENTS"):
            (leer / n).mkdir()
        assert freigaben_zustand(leer) == ([], ["02_LOCATIONS", "03_PROJEKTE_EVENTS"]) and not nas_bereit(leer)
        assert freigaben_zustand(w / "gibt_es_nicht") == ([], []) and not nas_bereit(w / "gibt_es_nicht")


def test_einbettungstext() -> None:
    assert lesbarer_name("Offerte_INT-26-014_Sommerfest.pdf") == "Offerte INT 26 014 Sommerfest"
    assert lesbarer_name("ohne_endung") == "ohne endung"
    t = einbettungstext("Grundriss_EG.pdf", "A" * 5000)
    assert t.startswith("Grundriss EG\n") and len(t) == len("Grundriss EG\n") + TEXT_ANFANG, "Dateiname + Textanfang"
    assert einbettungstext("", "") == "(leer)" and einbettungstext("Logo.png", "") == "Logo"
    assert ordner_text("02_LOCATIONS/100001_Halle_Nord/02_Plaene_Grundrisse") == "Halle Nord / Plaene Grundrisse"
    assert ordner_text("02_LOCATIONS") == "LOCATIONS", "Freigabe allein: ihr eigener Name"
    assert json.loads(_vektor_text([0.5, -0.25, 1e-9])) == [0.5, -0.25, 1e-9], "pgvector-Text = JSON-Liste"


def test_index_ohne_db() -> None:
    idx = ArchivIndex(None, rezept_fuer(CFG))
    assert not idx.aktiv and idx.anzahl() == 0 and idx.bestand() == {}
    aufrufe: list[list[str]] = []

    def einbetten(texte: list[str]) -> list[list[float]]:
        aufrufe.append(texte)
        return [[1.0, float(len(t))] for t in texte]

    pfade = [f"02_LOCATIONS/{i:03d}_Ort" for i in range(70)]
    v = idx.ordner_vektoren(pfade, einbetten)
    assert len(v) == 70 and [len(a) for a in aufrufe] == [64, 6], "in Stapeln zu 64"
    assert v["02_LOCATIONS/000_Ort"] == [1.0, float(len("Ort"))], "Text = Segmente ohne Nummern-Präfix"
    idx.ordner_vektoren(pfade[:5] + [unicodedata.normalize("NFD", "00_ADMIN_RECHT/Verträge")], einbetten)
    assert [len(a) for a in aufrufe] == [64, 6, 1], "nur Fehlendes wird berechnet (NFC-Schlüssel)"
    idx.entferne_ordner_ausser(pfade[:2])
    idx.ordner_vektoren(pfade[:3], einbetten)
    assert [len(a) for a in aufrufe] == [64, 6, 1, 1], "nach dem Aufräumen nur der entfernte neu"


class _Index:
    """Spielt archiv_dateien im Speicher (gleiche Schnittstelle wie ArchivIndex)."""

    def __init__(self) -> None:
        self.rezept = "test|v1"
        self.zeilen: dict[str, dict] = {}
        self.ordner: dict[str, list[float]] = {}

    def bereit(self) -> bool:
        return True

    def bestand(self) -> dict:
        return {p: (z["groesse"], z["mtime"], z["sha"], z["rezept"]) for p, z in self.zeilen.items()}

    def uebernehme(self, d: NasDatei, sha: str) -> bool:
        quelle = next((z for p, z in self.zeilen.items() if z["sha"] == sha and p != d.pfad and z["rezept"] == self.rezept), None)
        if quelle is None:
            return False
        self.zeilen[d.pfad] = {**quelle, "groesse": d.groesse, "mtime": d.mtime, "ordner": d.ordner}
        return True

    def speichere(self, d: NasDatei, sha: str, vektor: list[float]) -> None:
        self.zeilen[d.pfad] = {"groesse": d.groesse, "mtime": d.mtime, "sha": sha, "rezept": self.rezept, "vektor": vektor, "ordner": d.ordner}

    def entferne(self, pfade) -> None:
        for p in pfade:
            self.zeilen.pop(p, None)

    def anzahl(self, max_alter_s: float = 0.0) -> int:
        return len(self.zeilen)

    @property
    def aktiv(self) -> bool:
        return True

    def ordner_vektoren(self, pfade, einbetten) -> dict:
        fehlend = [p for p in pfade if p not in self.ordner]
        for p, v in zip(fehlend, einbetten(fehlend) if fehlend else []):
            self.ordner[p] = v
        return {p: self.ordner[p] for p in pfade if p in self.ordner}

    def entferne_ordner_ausser(self, pfade) -> None:
        for p in [p for p in self.ordner if p not in set(pfade)]:
            del self.ordner[p]


class _Llm:
    def __init__(self) -> None:
        self.texte: list[str] = []
        self.geladen: list[str] = []
        self.entladen: list[str] = []

    def einbetten(self, *, modell: str, texte: list[str], timeout_s: float = 120.0):
        self.texte += texte
        return [[1.0, 0.0] for _ in texte], {"modell": modell, "dauer_ms": 1, "lade_ms": 0, "prompt_tokens": 1}

    def geladene_modelle(self) -> list[dict]:
        return [{"name": n} for n in self.geladen]

    def entlade(self, modell: str | None = None) -> None:
        self.entladen.append(str(modell))


def _lauf_ohne_mounts(ix: Indexierer):
    """Attrappen-NAS hat keine Mount-Punkte — wie auf dem Rig ohne jeden Mount: nur Inhalt zählt."""
    return ix.lauf()


def test_indexlauf_inkrementell() -> None:
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        _nas(w)
        idx, llm = _Index(), _Llm()
        ix = Indexierer(CFG, idx, llm, lambda: True, wurzel=w)  # type: ignore[arg-type]
        assert ix.status() == {"aktiv": True, "anzahl": 0, "letzter_lauf": None, "laeuft": False, "letzte_bilanz": None}
        b = ix.lauf()
        assert (b.geprueft, b.neu, b.uebernommen, b.unveraendert, b.entfernt, b.fehler, b.abgebrochen) == (6, 6, 0, 0, 0, 0, False), b
        assert idx.anzahl() == 6 and set(idx.zeilen) == VORBILDER and len(idx.ordner) == len(nas_ordner(w)), "Ordnerpfade gleich mit eingebettet"
        st = ix.status()
        assert st["anzahl"] == 6 and st["laeuft"] is False and isinstance(st["letzter_lauf"], str) and "T" in st["letzter_lauf"]
        assert st["letzte_bilanz"] == {"geprueft": 6, "neu": 6, "uebernommen": 0, "unveraendert": 0, "entfernt": 0, "fehler": 0,
                                       "dauer_s": b.gesamt_s, "unterbrochen": False, "freigaben_unvollstaendig": 0}, "Status für /health: nur Zähler und Zeiten"
        assert any(t.startswith("Grundriss EG\nGrundriss Erdgeschoss") for t in llm.texte), "Dateiname + Textanfang"
        n_texte = len(llm.texte)
        # Zweiter Lauf: nichts geändert → nichts eingebettet.
        b2 = ix.lauf()
        assert (b2.unveraendert, b2.neu, b2.uebernommen) == (6, 0, 0) and len(llm.texte) == n_texte
        # Verschieben (gleicher Inhalt, neuer Ort) → Einbettung übernommen, alter Pfad entfernt; Löschen → entfernt
        # (2 von 6 = 33 % — unter der Bremse).
        alt = w / "02_LOCATIONS/100001_Halle_Nord/02_Plaene_Grundrisse/Bestuhlung.txt"
        neu = w / "02_LOCATIONS/100001_Halle_Nord/Bestuhlung.txt"
        os.replace(alt, neu)
        (w / "03_PROJEKTE_EVENTS/2026/INT-26-001-Firma_Alpha/Offerte_26-001.txt").unlink()
        b3 = ix.lauf()
        assert (b3.uebernommen, b3.neu, b3.entfernt, b3.abgebrochen) == (1, 0, 2, False), b3
        assert "02_LOCATIONS/100001_Halle_Nord/Bestuhlung.txt" in idx.zeilen and len(llm.texte) == n_texte
        # Verschwundener Ordner: seine Einbettung fällt weg.
        (w / "00_ADMIN_RECHT/02_Versicherungen").rmdir()
        ix.lauf()
        assert "00_ADMIN_RECHT/02_Versicherungen" not in idx.ordner and set(idx.ordner) == set(nas_ordner(w))
        n_texte = len(llm.texte)
        # Geänderter Inhalt → neu eingebettet.
        (w / "02_LOCATIONS/100001_Halle_Nord/02_Plaene_Grundrisse/Grundriss EG.txt").write_text("Grundriss OG neu", encoding="utf-8")
        os.utime(w / "02_LOCATIONS/100001_Halle_Nord/02_Plaene_Grundrisse/Grundriss EG.txt", (1, 1))
        b4 = ix.lauf()
        assert b4.neu == 1 and b4.unveraendert == 4, b4


def test_indexlauf_wartet_und_bricht_ab() -> None:
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        _nas(w)
        idx, llm = _Index(), _Llm()
        ix = Indexierer(CFG, idx, llm, lambda: False, wurzel=w)  # type: ignore[arg-type]
        ix.stop()  # Worker nie ruhig + Halt: der Lauf bettet nichts ein und meldet «unterbrochen»
        b = ix.lauf()
        assert b.abgebrochen and b.neu == 0 and llm.texte == [] and b.entfernt == 0
        assert ix.status()["letzter_lauf"] is None and ix.status()["letzte_bilanz"]["unterbrochen"] is True, "unterbrochen zählt nicht als Lauf"


def _voller_index(w: Path) -> tuple[Indexierer, _Index, _Llm]:
    idx, llm = _Index(), _Llm()
    ix = Indexierer(CFG, idx, llm, lambda: True, wurzel=w)  # type: ignore[arg-type]
    b = ix.lauf()
    assert idx.anzahl() == 6 and not b.abgebrochen
    return ix, idx, llm


def test_indexlauf_leere_wurzel_loescht_nichts() -> None:
    # Review [1]: NAS nicht gemountet = die Freigaben sind leere Ordner (so legt sie das Mount-Skript an). Vorher:
    # «geprüft 0, entfernt 4» — alle Vorbilder weg. Jetzt: nichts geprüft, nichts entfernt, Lauf unterbrochen.
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        _nas(w)
        ix, idx, _ = _voller_index(w)
        n_ordner = len(idx.ordner)
        for e in list(w.iterdir()):
            shutil.rmtree(e) if e.is_dir() else e.unlink()
            if e.is_dir() or not e.exists():
                pass
        for n in ("00_ADMIN_RECHT", "02_LOCATIONS", "03_PROJEKTE_EVENTS", "05_VERKAUF_MARKETING"):
            (w / n).mkdir(exist_ok=True)
        assert not nas_bereit(w), "run() würde gar nicht erst laufen"
        b = ix.lauf()
        assert (b.geprueft, b.entfernt, b.abgebrochen) == (0, 0, True), b
        assert idx.anzahl() == 6 and len(idx.ordner) == n_ordner, "Index und Ordner-Einbettungen unangetastet"
        assert ix.status()["letzte_bilanz"]["unterbrochen"] is True
        # Wurzel komplett weg (Pfad existiert nicht): dasselbe.
        shutil.rmtree(w)
        b2 = ix.lauf()
        assert (b2.geprueft, b2.entfernt, b2.abgebrochen) == (0, 0, True) and idx.anzahl() == 6
        w.mkdir()


def test_indexlauf_fehlende_freigabe() -> None:
    # Eine einzelne Freigabe nicht eingehängt (leer): ihre Zeilen bleiben, die anderen Freigaben werden normal
    # geprüft (auch Entfernen dort), der Lauf gilt als unterbrochen und wird wiederholt.
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        _nas(w)
        ix, idx, llm = _voller_index(w)
        shutil.rmtree(w / "03_PROJEKTE_EVENTS")
        (w / "03_PROJEKTE_EVENTS").mkdir()
        (w / "05_VERKAUF_MARKETING/01_Logos/Logo Beschrieb.txt").unlink()  # echtes Löschen in einer lesbaren Freigabe
        b = ix.lauf()
        assert (b.geprueft, b.entfernt, b.unvollstaendig, b.abgebrochen) == (4, 1, 1, True), b
        assert "03_PROJEKTE_EVENTS/2026/INT-26-001-Firma_Alpha/Offerte_26-001.txt" in idx.zeilen, "nicht gelesene Freigabe: nichts entfernt"
        assert "05_VERKAUF_MARKETING/01_Logos/Logo Beschrieb.txt" not in idx.zeilen, "lesbare Freigabe: Gelöschtes fällt weg"
        assert any(o.startswith("03_PROJEKTE_EVENTS/") for o in idx.ordner), "Ordner-Einbettungen der fehlenden Freigabe bleiben"
        assert ix.status()["letzte_bilanz"]["freigaben_unvollstaendig"] == 1 and ix.status()["letzter_lauf"] is not None
        # Freigabe wieder da → vollständiger Lauf, nichts mehr unvollständig (die Dateien sind neu geschrieben, also
        # neu eingebettet — das ist das normale Inkrement, kein Entfernen).
        shutil.rmtree(w / "03_PROJEKTE_EVENTS")
        _nas(w)
        (w / "05_VERKAUF_MARKETING/01_Logos/Logo Beschrieb.txt").unlink()
        b2 = ix.lauf()
        assert (b2.unvollstaendig, b2.abgebrochen, b2.entfernt, b2.geprueft) == (0, False, 0, 5), b2
        assert set(idx.zeilen) == VORBILDER - {"05_VERKAUF_MARKETING/01_Logos/Logo Beschrieb.txt"}


def test_unvollstaendig_pause_statt_dauerschleife() -> None:
    # Fehlt eine Freigabe dauerhaft, läuft der Index nicht alle 30 s übers ganze NAS, sondern erst nach
    # WIEDERHOLEN_UNVOLLSTAENDIG_S erneut; ist alles da, endet die Wiederholung.
    takt, pause = archiv_modul.NACHHOLEN_ALLE_S, archiv_modul.WIEDERHOLEN_UNVOLLSTAENDIG_S
    try:
        archiv_modul.NACHHOLEN_ALLE_S, archiv_modul.WIEDERHOLEN_UNVOLLSTAENDIG_S = 0.05, 0.6
        with tempfile.TemporaryDirectory() as d:
            w = Path(d)
            _nas(w)
            shutil.rmtree(w / "03_PROJEKTE_EVENTS")
            (w / "03_PROJEKTE_EVENTS").mkdir()
            ix = Indexierer(dataclasses.replace(CFG, index_start_s=0, index_nacht="xx"), _Index(), _Llm(), lambda: True, wurzel=w)  # type: ignore[arg-type]
            laeufe: list[float] = []
            echt_lauf = ix.lauf

            def zaehle() -> object:
                laeufe.append(time.monotonic())
                return echt_lauf()

            ix.lauf = zaehle  # type: ignore[method-assign]
            ix.start()
            time.sleep(0.45)
            assert len(laeufe) == 1, f"unvollständig: einmal, dann Pause (gesehen {len(laeufe)})"
            time.sleep(0.6)
            assert len(laeufe) == 2 and laeufe[1] - laeufe[0] >= 0.6, laeufe
            shutil.rmtree(w / "03_PROJEKTE_EVENTS")
            _nas(w)
            time.sleep(0.9)
            n = len(laeufe)
            assert n == 3 and ix.letzte_bilanz is not None and not ix.letzte_bilanz.abgebrochen, (n, ix.letzte_bilanz)
            time.sleep(0.3)
            assert len(laeufe) == n, "vollständig: Start-Lauf erledigt, keine Wiederholung"
            ix.stop()
            ix.join(timeout=5)
    finally:
        archiv_modul.NACHHOLEN_ALLE_S, archiv_modul.WIEDERHOLEN_UNVOLLSTAENDIG_S = takt, pause


def test_indexlauf_bremse() -> None:
    # Plausibilitätsbremse: verschwinden ≥ 50 % des Bestands auf einmal (hier 4 von 6 — Freigabe-Ordner mit
    # fremdem Inhalt, Mount daneben), wird nichts entfernt.
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        _nas(w)
        ix, idx, _ = _voller_index(w)
        for rel in ("02_LOCATIONS/100001_Halle_Nord/02_Plaene_Grundrisse", "02_LOCATIONS/100002_Saal_Sued/01_Plaene_Grundrisse",
                    "03_PROJEKTE_EVENTS/2026"):
            shutil.rmtree(w / rel)
        (w / "02_LOCATIONS/100001_Halle_Nord/leer.txt").write_text("x", encoding="utf-8")  # Freigaben bleiben «lesbar»
        (w / "03_PROJEKTE_EVENTS/leer.txt").write_text("x", encoding="utf-8")
        vorher = ix.letzter_lauf
        time.sleep(1.1)
        b = ix.lauf()
        assert b.entfernt == 0 and b.entfernen_gebremst == 4 and b.abgebrochen and b.neu + b.uebernommen == 2, b
        assert VORBILDER <= set(idx.zeilen), "Bremse: alter Bestand bleibt (Neues kommt trotzdem dazu)"
        assert ix.letzter_lauf == vorher and ix.status()["letzte_bilanz"]["unterbrochen"], "gebremster Lauf zählt nicht als vollständig"
        assert ENTFERNEN_MAX_ANTEIL == 0.5


def test_index_wartet_auf_auftrag() -> None:
    # Review [9] (statt Live-Test mit Diktat): läuft ein Auftrag (Worker nicht ruhig), bettet der Index nichts ein,
    # bis Ruhe ist — die Einbettung selbst läuft dann durch die Schleuse (test_einbettung_durch_schleuse).
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        _nas(w)
        idx, llm = _Index(), _Llm()
        ruhig = threading.Event()
        ix = Indexierer(CFG, idx, llm, ruhig.is_set, wurzel=w)  # type: ignore[arg-type]
        ergebnis: list = []
        t = threading.Thread(target=lambda: ergebnis.append(ix.lauf()), daemon=True)
        t.start()
        time.sleep(0.8)
        assert llm.texte == [] and t.is_alive() and ix.laeuft, "Auftrag läuft (Diktat): Index wartet vor der ersten Einbettung"
        ruhig.set()
        t.join(timeout=15)
        assert not t.is_alive() and ergebnis and not ergebnis[0].abgebrochen and ergebnis[0].neu == 6
        assert not ix.laeuft


def test_einbettung_durch_schleuse() -> None:
    # Dieselbe Schleuse wie Whisper/Sprachmodell: hält ein Diktat sie, wartet /api/embed — nie gleichzeitig auf der GPU.
    gesehen: list[float] = []

    def handler(_req: httpx.Request) -> httpx.Response:
        gesehen.append(time.monotonic())
        return httpx.Response(200, json={"embeddings": [[3.0, 4.0]]})

    llm = Ollama(CFG)
    llm._client._transport = httpx.MockTransport(handler)
    SCHLEUSE.acquire()
    t0 = time.monotonic()
    t = threading.Thread(target=lambda: llm.einbetten(modell="bge-m3", texte=["x"]), daemon=True)
    t.start()
    time.sleep(0.5)
    assert gesehen == [], "Einbettung wartet, solange die Schleuse besetzt ist"
    SCHLEUSE.release()
    t.join(timeout=5)
    assert len(gesehen) == 1 and gesehen[0] - t0 >= 0.5
    vektoren, _ = llm.einbetten(modell="bge-m3", texte=["y"])
    assert [round(x, 3) for x in vektoren[0]] == [0.6, 0.8], "L2-normiert"


def test_vram_vor_einbettung() -> None:
    # Review [8]: derselbe VRAM-Schritt wie in der Ablage — knapper VRAM → Sprachmodell entladen, bge-m3 bleibt.
    echt = archiv_modul.gpu_info
    try:
        llm = _Llm()
        llm.geladen = ["gemma3:4b", CFG.modell_embed + ":latest"]
        archiv_modul.gpu_info = lambda max_alter_s=10.0: {"name": "RTX", "frei_mb": 1024}
        assert platz_fuer_einbettung(llm, CFG, grund="Test") == 1 and llm.entladen == ["gemma3:4b"]  # type: ignore[arg-type]
        archiv_modul.gpu_info = lambda max_alter_s=10.0: {"name": "RTX", "frei_mb": 5000}
        assert platz_fuer_einbettung(llm, CFG, grund="Test") == 0 and len(llm.entladen) == 1  # type: ignore[arg-type]
        archiv_modul.gpu_info = lambda max_alter_s=10.0: {"name": None, "frei_mb": None}
        assert platz_fuer_einbettung(llm, CFG, grund="Test") == 0, "ohne GPU-Auskunft nichts entladen"  # type: ignore[arg-type]
        # Im Indexlauf wird er vor jeder Einbettung aufgerufen.
        archiv_modul.gpu_info = lambda max_alter_s=10.0: {"name": "RTX", "frei_mb": 1024}
        with tempfile.TemporaryDirectory() as d:
            w = Path(d)
            _nas(w)
            llm2 = _Llm()
            llm2.geladen = ["gemma3:4b"]
            Indexierer(CFG, _Index(), llm2, lambda: True, wurzel=w).lauf()  # type: ignore[arg-type]
            assert llm2.entladen and set(llm2.entladen) == {"gemma3:4b"}
    finally:
        archiv_modul.gpu_info = echt


def test_nachtlauf_zeitfenster() -> None:
    ix = Indexierer(dataclasses.replace(CFG, index_nacht="02:30"), _Index(), _Llm(), lambda: True)  # type: ignore[arg-type]
    assert not ix._nacht_faellig(datetime(2026, 10, 4, 2, 29))
    assert ix._nacht_faellig(datetime(2026, 10, 4, 2, 30)) and ix._nacht_faellig(datetime(2026, 10, 4, 6, 29))
    assert not ix._nacht_faellig(datetime(2026, 10, 4, 6, 31)), "Neustart am Tag holt den Nachtlauf nicht nach"
    ix._letzte_nacht = "2026-10-04"
    assert not ix._nacht_faellig(datetime(2026, 10, 4, 3, 0)), "einmal je Nacht"
    assert ix._nacht_faellig(datetime(2026, 10, 5, 3, 0))
    # Review [8]: Fenster als Zeitdifferenz — über Mitternacht (23:30 → bis 03:30), kein verkürztes Fenster ab 20:00.
    spaet = Indexierer(dataclasses.replace(CFG, index_nacht="23:30"), _Index(), _Llm(), lambda: True)  # type: ignore[arg-type]
    assert not spaet._nacht_faellig(datetime(2026, 10, 4, 23, 29))
    assert spaet._nacht_faellig(datetime(2026, 10, 4, 23, 30)) and spaet._nacht_faellig(datetime(2026, 10, 5, 0, 30))
    assert spaet._nacht_schluessel(datetime(2026, 10, 5, 3, 29)) == "2026-10-04", "Schlüssel = Tag der Startzeit"
    assert not spaet._nacht_faellig(datetime(2026, 10, 5, 3, 30))
    spaet._letzte_nacht = "2026-10-04"
    assert not spaet._nacht_faellig(datetime(2026, 10, 5, 1, 0)) and spaet._nacht_faellig(datetime(2026, 10, 5, 23, 45))
    abend = Indexierer(dataclasses.replace(CFG, index_nacht="20:00"), _Index(), _Llm(), lambda: True)  # type: ignore[arg-type]
    assert abend._nacht_faellig(datetime(2026, 10, 4, 23, 59)) and not abend._nacht_faellig(datetime(2026, 10, 5, 0, 1))
    assert nachtzeit("02:30") == (2, 30) and nachtzeit("7") == (7, 0) and nachtzeit(" 23:59 ") == (23, 59)
    for kaputt in ("25:00", "02:60", "abc", "", "2:3:4", "-1:00"):
        assert nachtzeit(kaputt) is None, kaputt
    kaputt_ix = Indexierer(dataclasses.replace(CFG, index_nacht="25:00"), _Index(), _Llm(), lambda: True)  # type: ignore[arg-type]
    assert kaputt_ix._nacht is None and not kaputt_ix._nacht_faellig(datetime(2026, 10, 4, 3, 0)), "ungültig: kein Nachtlauf, beim Start geloggt"


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
