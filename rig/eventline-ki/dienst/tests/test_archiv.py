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
import sys
import tempfile
import unicodedata
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.archiv import (  # noqa: E402
    TEXT_ANFANG,
    ArchivIndex,
    Indexierer,
    NasDatei,
    _vektor_text,
    ausgeschlossen,
    einbettungstext,
    lesbarer_name,
    nas_dateien,
    nas_ordner,
    ordner_text,
    rezept_fuer,
)
from app.config import laden  # noqa: E402

CFG = dataclasses.replace(laden(), index_ocr_seiten=1, ocr_timeout_s=20)


def _nas(wurzel: Path) -> None:
    """Kleines NAS: zwei Freigaben, ZZ-Freigabe, 99_System, versteckte und nicht lesbare Dateien."""
    dateien = {
        "02_LOCATIONS/100001_Halle_Nord/02_Plaene_Grundrisse/Grundriss EG.txt": "Grundriss Erdgeschoss Halle Nord",
        "02_LOCATIONS/100001_Halle_Nord/02_Plaene_Grundrisse/Bestuhlung.txt": "Bestuhlungsplan 400 Personen",
        "03_PROJEKTE_EVENTS/2026/INT-26-001-Firma_Alpha/Offerte_26-001.txt": "Offerte Sommerfest Firma Alpha",
        "03_PROJEKTE_EVENTS/2026/INT-26-001-Firma_Alpha/.versteckt.txt": "nie",
        "03_PROJEKTE_EVENTS/2026/INT-26-001-Firma_Alpha/~$Offerte.docx": "nie",
        "03_PROJEKTE_EVENTS/2026/INT-26-001-Firma_Alpha/Skizze.indd": "nie (nicht lesbar)",
        "03_PROJEKTE_EVENTS/99_System/log.txt": "nie",
        "03_PROJEKTE_EVENTS/ZZ_Alt/alt.txt": "nie (ZZ auf erster Ebene)",
        "ZZ_Dokumente_zum_Einsortieren/neu.txt": "nie (ZZ-Freigabe)",
        "lose_in_der_wurzel.txt": "nie (Wurzel)",
    }
    for rel, inhalt in dateien.items():
        p = wurzel / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(inhalt, encoding="utf-8")
    (wurzel / "00_ADMIN_RECHT/02_Versicherungen").mkdir(parents=True)
    # Zerlegte Umlaute (NFD) wie von einem Mac abgelegt
    nfd = unicodedata.normalize("NFD", "00_ADMIN_RECHT/03_Dauerverträge")
    (wurzel / nfd).mkdir(parents=True)
    (wurzel / nfd / unicodedata.normalize("NFD", "Police Büro.txt")).write_text("Police", encoding="utf-8")


def test_ausgeschlossen() -> None:
    assert ausgeschlossen(".git", 3) and ausgeschlossen("@eaDir", 2) and ausgeschlossen("#recycle", 0) and ausgeschlossen("~$x.docx", 4)
    assert ausgeschlossen("ZZ_Dokumente_zum_Einsortieren", 0) and ausgeschlossen("ZZ_Alt", 1)
    assert not ausgeschlossen("ZZ_tief", 2), "ZZ_ zählt nur auf Freigabe- und erster Ebene (wie die FSM-Liste)"
    assert ausgeschlossen("99_System", 0) and ausgeschlossen("99_System", 3), "99_System nie"
    assert not ausgeschlossen("02_LOCATIONS", 0)


def test_nas_durchgang() -> None:
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        _nas(w)
        dateien = list(nas_dateien(w))
        pfade = [x.pfad for x in dateien]
        assert set(pfade) == {
            "00_ADMIN_RECHT/03_Dauerverträge/Police Büro.txt",
            "02_LOCATIONS/100001_Halle_Nord/02_Plaene_Grundrisse/Bestuhlung.txt",
            "02_LOCATIONS/100001_Halle_Nord/02_Plaene_Grundrisse/Grundriss EG.txt",
            "03_PROJEKTE_EVENTS/2026/INT-26-001-Firma_Alpha/Offerte_26-001.txt",
        }, pfade
        assert all(unicodedata.is_normalized("NFC", p) for p in pfade), "Pfade immer NFC"
        police = next(x for x in dateien if x.name.startswith("Police"))
        assert police.ordner == "00_ADMIN_RECHT/03_Dauerverträge" and police.voll.exists() and police.groesse == 6
        ordner = nas_ordner(w)
        assert "02_LOCATIONS" in ordner and "00_ADMIN_RECHT/02_Versicherungen" in ordner and "00_ADMIN_RECHT/03_Dauerverträge" in ordner
        assert not any(o.startswith("ZZ_") or "99_System" in o or "/ZZ_" in o for o in ordner)


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

    def einbetten(self, *, modell: str, texte: list[str], timeout_s: float = 120.0):
        self.texte += texte
        return [[1.0, 0.0] for _ in texte], {"modell": modell, "dauer_ms": 1, "lade_ms": 0, "prompt_tokens": 1}


def test_indexlauf_inkrementell() -> None:
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        _nas(w)
        idx, llm = _Index(), _Llm()
        ix = Indexierer(CFG, idx, llm, lambda: True, wurzel=w)  # type: ignore[arg-type]
        assert ix.status() == {"aktiv": True, "anzahl": 0, "letzter_lauf": None, "laeuft": False, "letzte_bilanz": None}
        b = ix.lauf()
        assert (b.geprueft, b.neu, b.uebernommen, b.unveraendert, b.entfernt, b.fehler, b.abgebrochen) == (4, 4, 0, 0, 0, 0, False), b
        assert idx.anzahl() == 4 and len(idx.ordner) == len(nas_ordner(w)), "Ordnerpfade gleich mit eingebettet"
        st = ix.status()
        assert st["anzahl"] == 4 and st["laeuft"] is False and isinstance(st["letzter_lauf"], str) and "T" in st["letzter_lauf"]
        assert st["letzte_bilanz"] == {"geprueft": 4, "neu": 4, "uebernommen": 0, "unveraendert": 0, "entfernt": 0, "fehler": 0,
                                       "dauer_s": b.gesamt_s, "unterbrochen": False}, "Status für /health: nur Zähler und Zeiten"
        assert any(t.startswith("Grundriss EG\nGrundriss Erdgeschoss") for t in llm.texte), "Dateiname + Textanfang"
        n_texte = len(llm.texte)
        # Zweiter Lauf: nichts geändert → nichts eingebettet.
        b2 = ix.lauf()
        assert (b2.unveraendert, b2.neu, b2.uebernommen) == (4, 0, 0) and len(llm.texte) == n_texte
        # Verschieben (gleicher Inhalt, neuer Ort) → Einbettung übernommen, alter Pfad entfernt; Löschen → entfernt.
        alt = w / "02_LOCATIONS/100001_Halle_Nord/02_Plaene_Grundrisse/Bestuhlung.txt"
        neu = w / "02_LOCATIONS/100001_Halle_Nord/Bestuhlung.txt"
        os.replace(alt, neu)
        (w / "03_PROJEKTE_EVENTS/2026/INT-26-001-Firma_Alpha/Offerte_26-001.txt").unlink()
        b3 = ix.lauf()
        assert (b3.uebernommen, b3.neu, b3.entfernt) == (1, 0, 2), b3
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
        assert b4.neu == 1 and b4.unveraendert == 2, b4


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


def test_nachtlauf_zeitfenster() -> None:
    ix = Indexierer(dataclasses.replace(CFG, index_nacht="02:30"), _Index(), _Llm(), lambda: True)  # type: ignore[arg-type]
    assert not ix._nacht_faellig(datetime(2026, 10, 4, 2, 29))
    assert ix._nacht_faellig(datetime(2026, 10, 4, 2, 30)) and ix._nacht_faellig(datetime(2026, 10, 4, 6, 29))
    assert not ix._nacht_faellig(datetime(2026, 10, 4, 6, 31)), "Neustart am Tag holt den Nachtlauf nicht nach"
    ix._letzte_nacht = "2026-10-04"
    assert not ix._nacht_faellig(datetime(2026, 10, 4, 3, 0)), "einmal je Nacht"
    assert ix._nacht_faellig(datetime(2026, 10, 5, 3, 0))


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
