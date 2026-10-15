"""Vorschaubild (Auftragsart «vorschau») ohne Netz: Pfad sicher auflösen (NFC/NFD, nie ausserhalb), PDF Seite 1 per
pdftoppm, Bild verkleinert, Office-Vorschaubild aus dem ZIP, keine Vorschau für andere Typen, Zwischenspeicher im Tresor
(zweites Mal aus dem Speicher, Grösse begrenzt, Altes weg).

  docker run --rm --network none -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_vorschau.py
"""

from __future__ import annotations

import base64
import dataclasses
import io
import os
import sys
import tempfile
import time
import unicodedata
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image  # noqa: E402

from app import vorschau as vs  # noqa: E402
from app.config import laden  # noqa: E402
from app.worker import arten_aktiv  # noqa: E402


def _png(pfad: Path, w: int = 2400, h: int = 1600, alpha: bool = False) -> None:
    Image.new("RGBA" if alpha else "RGB", (w, h), (10, 120, 200, 128) if alpha else (10, 120, 200)).save(pfad)


def _pdf(pfad: Path) -> None:
    from pypdf import PdfWriter

    w = PdfWriter()
    w.add_blank_page(width=595, height=842)
    with open(pfad, "wb") as f:
        w.write(f)


def _cfg(wurzel: Path, daten: Path):  # noqa: ANN202
    return dataclasses.replace(laden(), nas_wurzel=wurzel, data_dir=daten, tmp_dir=daten / "tmp")


def _jpeg(b64: str) -> Image.Image:
    roh = base64.b64decode(b64)
    assert roh[:3] == b"\xff\xd8\xff", "JPEG"
    return Image.open(io.BytesIO(roh))


def test_aufloesen_sicher() -> None:
    with tempfile.TemporaryDirectory() as d:
        w = Path(d) / "nas"
        (w / "02_LOC" / "Grundrisse").mkdir(parents=True)
        (w / "02_LOC" / "Grundrisse" / "plan.pdf").write_bytes(b"x")
        nfd = unicodedata.normalize("NFD", "Übersicht.pdf")
        (w / "02_LOC" / nfd).write_bytes(b"x")
        (w / "99_System").mkdir()
        (w / "99_System" / "x.pdf").write_bytes(b"x")
        (w / "02_LOC" / ".versteckt.pdf").write_bytes(b"x")
        draussen = Path(d) / "geheim.pdf"
        draussen.write_bytes(b"x")
        os.symlink(draussen, w / "02_LOC" / "link.pdf")
        assert vs.aufloesen(w, "02_LOC/Grundrisse/plan.pdf") == (w / "02_LOC/Grundrisse/plan.pdf").resolve()
        assert vs.aufloesen(w, "02_LOC/Übersicht.pdf") is not None, "NFC-Pfad findet den NFD-Namen"
        for schlecht in ("../geheim.pdf", "/etc/passwd", "02_LOC/../../geheim.pdf", "99_System/x.pdf", "02_LOC/.versteckt.pdf",
                         "02_LOC/link.pdf", "02_LOC/Grundrisse", "02_LOC/fehlt.pdf", ""):
            assert vs.aufloesen(w, schlecht) is None, schlecht


def test_pdf_bild_office_und_keine() -> None:
    with tempfile.TemporaryDirectory() as d:
        w, daten = Path(d) / "nas", Path(d) / "daten"
        (w / "A").mkdir(parents=True)
        _pdf(w / "A" / "vertrag.pdf")
        _png(w / "A" / "foto.png", alpha=True)
        with zipfile.ZipFile(w / "A" / "brief.docx", "w") as z:
            buf = io.BytesIO()
            Image.new("RGB", (300, 420), (250, 250, 250)).save(buf, "JPEG")
            z.writestr("docProps/thumbnail.jpeg", buf.getvalue())
            z.writestr("word/document.xml", "<w/>")
        with zipfile.ZipFile(w / "A" / "ohne.xlsx", "w") as z:
            z.writestr("xl/workbook.xml", "<w/>")
        (w / "A" / "musik.mp3").write_bytes(b"ID3")
        cfg = _cfg(w, daten)
        sp = vs.VorschauSpeicher(daten / "vorschau")
        pdf = vs.vorschau({"pfad": "A/vertrag.pdf"}, cfg, sp)
        bild = _jpeg(pdf["b64"])
        assert bild.width == vs.VORSCHAU_BREITE and bild.height > bild.width, (bild.size, "A4 hoch")
        assert pdf["quelle"] == "neu" and pdf["bytes"] < vs.MAX_ERGEBNIS_BYTES
        foto = _jpeg(vs.vorschau({"pfad": "A/foto.png"}, cfg, sp)["b64"])
        assert foto.width == vs.VORSCHAU_BREITE and foto.getpixel((5, 5))[0] > 100, "Transparenz auf Weiss"
        doc = vs.vorschau({"pfad": "A/brief.docx"}, cfg, sp)
        assert _jpeg(doc["b64"]).size == (300, 420), "eingebettetes Vorschaubild, nicht vergrössert"
        assert vs.vorschau({"pfad": "A/ohne.xlsx"}, cfg, sp) == {"keine": True, "grund": "typ", "quelle": "neu"}
        assert vs.vorschau({"pfad": "A/musik.mp3"}, cfg, sp)["keine"] is True
        assert vs.vorschau({"pfad": "A/fehlt.pdf"}, cfg, sp) == {"keine": True, "grund": "nicht_gefunden"}


def test_zwischenspeicher_und_pflege() -> None:
    with tempfile.TemporaryDirectory() as d:
        w, daten = Path(d) / "nas", Path(d) / "daten"
        (w / "A").mkdir(parents=True)
        _pdf(w / "A" / "v.pdf")
        cfg = _cfg(w, daten)
        sp = vs.VorschauSpeicher(daten / "vorschau")
        erst = vs.vorschau({"pfad": "A/v.pdf"}, cfg, sp)
        zweit = vs.vorschau({"pfad": "A/v.pdf"}, cfg, sp)
        assert erst["quelle"] == "neu" and zweit["quelle"] == "cache" and erst["b64"] == zweit["b64"]
        dateien = list((daten / "vorschau").iterdir())
        assert len(dateien) == 1 and dateien[0].suffix == ".jpg" and len(dateien[0].stem) == 64, "Schlüssel sha256"
        # Geänderte Datei (Grösse/mtime) → neuer Schlüssel, neu gerechnet.
        time.sleep(0.01)
        _pdf(w / "A" / "v.pdf")
        os.utime(w / "A" / "v.pdf", (time.time() + 5, time.time() + 5))
        assert vs.vorschau({"pfad": "A/v.pdf"}, cfg, sp)["quelle"] == "neu"
        # Pflege: über der Grenze die am längsten unbenutzten weg; älter als 30 Tage weg.
        klein = vs.VorschauSpeicher(daten / "vorschau", max_mb=0)
        alt = daten / "vorschau" / ("a" * 64 + ".jpg")
        alt.write_bytes(b"\xff\xd8\xff" + b"0" * 100)
        os.utime(alt, (time.time() - vs.VORSCHAU_MAX_ALTER_S - 10,) * 2)
        weg = klein.pflege(sofort=True)
        assert weg >= 1 and not alt.exists()
        assert not any((daten / "vorschau").iterdir()), "Grenze 0 MB → alles weg"


def test_art_nur_mit_schalter() -> None:
    assert "vorschau" in arten_aktiv(dataclasses.replace(laden(), vorschau_aktiv=True))
    assert "vorschau" not in arten_aktiv(dataclasses.replace(laden(), vorschau_aktiv=False))


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
