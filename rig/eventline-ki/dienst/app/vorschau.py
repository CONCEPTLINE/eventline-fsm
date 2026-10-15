"""Vorschaubild einer NAS-Datei (Auftragsart «vorschau», flüchtig wie die Inhaltssuche).

Statt die ganze Datei über den NAS-Sync in den Übergabe-Bucket zu laden (bis ~1 min, ganze Datei), rendert das Rig die
erste Seite direkt vom NAS-Mount (nur lesend) als kleines JPEG (höchstens VORSCHAU_BREITE px breit, Qualität 70) und gibt
es als Ergebnis zurück — das FSM liest es einmal, löscht die Auftragszeile sofort und reicht die Bytes ohne Zwischen-
speicher an den Browser (Cache-Control no-store). Nichts landet dauerhaft in einem Cloud-Speicher.

- PDF: pdftoppm (poppler, schon für OCR im Image) — Seite 1, -scale-to-x.
- Bilder (JPEG, PNG, GIF, WebP, TIFF, BMP): Pillow, Ausrichtung nach EXIF, Transparenz auf Weiss.
- Office/iWork (DOCX, XLSX, PPTX, ODT/ODS/ODP, Pages/Numbers/Keynote): eingebettetes Vorschaubild aus dem ZIP
  (docProps/thumbnail.*, Thumbnails/thumbnail.png, QuickLook/Preview.*) — ohne neue Abhängigkeit; fehlt es, «keine
  Vorschau» (die App zeigt ein Datei-Symbol).
- Alles andere: keine Vorschau.

Zwischenspeicher NUR im Tresor (<KI_DATA_DIR>/vorschau, Schlüssel sha256 aus Rezept, Pfad, Grösse, mtime und Breite;
höchstens VORSCHAU_MAX_MB, ältere Einträge zuerst weg, nichts älter als 30 Tage). Pfade nur relativ zur NAS-Wurzel, nie
ausserhalb (kein «..», keine Links nach draussen), versteckte Einträge und Systemordner nie.
"""

from __future__ import annotations

import base64
import hashlib
import io
import logging
import os
import subprocess
import tempfile
import time
import unicodedata
import zipfile
from pathlib import Path
from typing import Any

from .config import Einstellungen
from .handlers import VerarbeitungsFehler

log = logging.getLogger("ki.vorschau")

REZEPT = "vorschau/v1"
VORSCHAU_BREITE = 900
VORSCHAU_MAX_HOEHE = 1400
QUALITAET = 70
MAX_DATEI_BYTES = 200 * 1024 * 1024
MAX_ERGEBNIS_BYTES = 400 * 1024
VORSCHAU_MAX_MB = 512
VORSCHAU_MAX_ALTER_S = 30 * 24 * 3600
PDF_TIMEOUT_S = 25

BILDER = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".tif", ".tiff", ".bmp"}
OFFICE = {".docx", ".xlsx", ".pptx", ".docm", ".xlsm", ".odt", ".ods", ".odp", ".pages", ".numbers", ".key"}
_ZIP_BILDER = ("docProps/thumbnail.jpeg", "docProps/thumbnail.jpg", "docProps/thumbnail.png", "Thumbnails/thumbnail.png",
               "QuickLook/Preview.jpg", "QuickLook/Preview.png", "QuickLook/Thumbnail.jpg", "preview.jpg", "preview-web.jpg",
               "Data/PreviewImage.jpg")


def _nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def aufloesen(wurzel: Path, pfad: str) -> Path | None:
    """NAS-Pfad (relativ, NFC oder Schreibweise der Platte) → Datei unter der Wurzel; jedes Segment exakt oder per
    NFC-Vergleich (Mac-Namen sind oft NFD). None = nicht gefunden oder nicht erlaubt."""
    if not pfad or pfad.startswith("/") or "\\" in pfad or "\x00" in pfad:
        return None
    teile = pfad.split("/")
    if any(t in ("", ".", "..") or t.startswith((".", "@", "#", "~$")) for t in teile) or teile[0] == "99_System":
        return None
    aktuell = wurzel
    for t in teile:
        kandidat = aktuell / t
        try:
            if not kandidat.exists():
                ziel = _nfc(t)
                kandidat = next((e for e in aktuell.iterdir() if _nfc(e.name) == ziel), None)  # type: ignore[assignment]
                if kandidat is None:
                    return None
        except OSError:
            return None
        aktuell = kandidat
    try:
        echt = aktuell.resolve()
        basis = wurzel.resolve()
    except OSError:
        return None
    if basis not in echt.parents or not echt.is_file():
        return None
    return echt


def _schluessel(pfad: str, groesse: int, mtime_ns: int, breite: int) -> str:
    return hashlib.sha256(f"{REZEPT}|{_nfc(pfad)}|{groesse}|{mtime_ns}|{breite}".encode("utf-8")).hexdigest()


def _bild_zu_jpeg(daten: bytes | Path, breite: int) -> tuple[bytes, int, int]:
    from PIL import Image, ImageOps

    with Image.open(daten if isinstance(daten, Path) else io.BytesIO(daten)) as roh:
        try:
            roh.seek(0)
        except EOFError:
            pass
        if roh.format == "JPEG":
            # Grosse Fotos gleich verkleinert dekodieren (schnell, wenig Speicher).
            roh.draft("RGB", (breite * 2, VORSCHAU_MAX_HOEHE * 2))
        bild = ImageOps.exif_transpose(roh)
        if bild.mode in ("RGBA", "LA", "P"):
            bild = bild.convert("RGBA")
            weiss = Image.new("RGB", bild.size, (255, 255, 255))
            weiss.paste(bild, mask=bild.split()[-1])
            bild = weiss
        elif bild.mode != "RGB":
            bild = bild.convert("RGB")
        bild.thumbnail((breite, VORSCHAU_MAX_HOEHE))
        aus = io.BytesIO()
        bild.save(aus, "JPEG", quality=QUALITAET, optimize=True, progressive=True)
        return aus.getvalue(), bild.width, bild.height


def _pdf_zu_jpeg(datei: Path, breite: int, tmp: Path) -> tuple[bytes, int, int]:
    tmp.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=tmp) as d:
        ziel = Path(d) / "seite"
        r = subprocess.run(
            ["pdftoppm", "-f", "1", "-l", "1", "-singlefile", "-scale-to-x", str(breite), "-scale-to-y", "-1",
             "-jpeg", "-jpegopt", f"quality={QUALITAET}", str(datei), str(ziel)],
            capture_output=True, timeout=PDF_TIMEOUT_S, check=False,
        )
        aus = ziel.with_suffix(".jpg")
        if r.returncode != 0 or not aus.exists():
            raise VerarbeitungsFehler("PDF-Seite 1 nicht lesbar (verschlüsselt oder beschädigt)")
        # Sehr hohe Seiten (Pläne) auf VORSCHAU_MAX_HOEHE begrenzen — und als JPEG neu kodieren.
        return _bild_zu_jpeg(aus, breite)


def _office_vorschaubild(datei: Path) -> bytes | None:
    try:
        with zipfile.ZipFile(datei) as z:
            namen = {n.lower(): n for n in z.namelist()}
            for kandidat in _ZIP_BILDER:
                echt = namen.get(kandidat.lower())
                if echt and z.getinfo(echt).file_size < 20 * 1024 * 1024:
                    return z.read(echt)
    except (zipfile.BadZipFile, OSError, KeyError):
        return None
    return None


def erzeuge(datei: Path, breite: int, tmp: Path) -> tuple[bytes, int, int] | None:
    """(JPEG, Breite, Höhe) oder None, wenn es für diesen Typ keine Vorschau gibt."""
    endung = datei.suffix.lower()
    if endung == ".pdf":
        return _pdf_zu_jpeg(datei, breite, tmp)
    if endung in BILDER:
        return _bild_zu_jpeg(datei, breite)
    if endung in OFFICE:
        roh = _office_vorschaubild(datei)
        if roh is None:
            return None
        try:
            return _bild_zu_jpeg(roh, breite)
        except Exception:  # noqa: BLE001 — EMF/WMF-Vorschaubilder kann Pillow nicht: dann keins
            return None
    return None


class VorschauSpeicher:
    """Zwischenspeicher im Tresor: <schlüssel>.jpg bzw. <schlüssel>.keine (Typ ohne Vorschau)."""

    def __init__(self, ordner: Path, max_mb: int = VORSCHAU_MAX_MB) -> None:
        self.ordner = ordner
        self.max_bytes = max_mb * 1024 * 1024
        self._letzte_pflege = 0.0

    def lies(self, schluessel: str) -> bytes | None | bool:
        """Bytes, False (= bekannt: keine Vorschau) oder None (nicht im Speicher)."""
        jpg = self.ordner / f"{schluessel}.jpg"
        try:
            daten = jpg.read_bytes()
            os.utime(jpg)  # zuletzt benutzt → bleibt beim Aufräumen länger
            return daten
        except OSError:
            pass
        return False if (self.ordner / f"{schluessel}.keine").exists() else None

    def schreibe(self, schluessel: str, daten: bytes | None) -> None:
        try:
            self.ordner.mkdir(parents=True, exist_ok=True)
            ziel = self.ordner / (f"{schluessel}.jpg" if daten is not None else f"{schluessel}.keine")
            tmp = ziel.with_suffix(ziel.suffix + ".neu")
            tmp.write_bytes(daten or b"")
            tmp.replace(ziel)
        except OSError as e:
            log.warning("Vorschau nicht zwischengespeichert (%s)", type(e).__name__)
            return
        self.pflege()

    def pflege(self, *, sofort: bool = False) -> int:
        """Alte Einträge (> 30 Tage) und — über der Grenze — die am längsten unbenutzten löschen (bis 80 %)."""
        if not sofort and time.monotonic() - self._letzte_pflege < 300:
            return 0
        self._letzte_pflege = time.monotonic()
        try:
            eintraege = [(e, e.stat()) for e in self.ordner.iterdir() if e.is_file()]
        except OSError:
            return 0
        jetzt = time.time()
        weg = 0
        bleiben = []
        for e, st in eintraege:
            if jetzt - st.st_mtime > VORSCHAU_MAX_ALTER_S or e.name.endswith(".neu"):
                try:
                    e.unlink()
                    weg += 1
                except OSError:
                    pass
            else:
                bleiben.append((e, st))
        summe = sum(st.st_size for _e, st in bleiben)
        if summe > self.max_bytes:
            for e, st in sorted(bleiben, key=lambda x: x[1].st_mtime):
                if summe <= self.max_bytes * 0.8:
                    break
                try:
                    e.unlink()
                    summe -= st.st_size
                    weg += 1
                except OSError:
                    pass
        return weg


def vorschau(payload: dict[str, Any], cfg: Einstellungen, speicher: VorschauSpeicher) -> dict[str, Any]:
    """Ergebnis für das FSM: {mime, b64, breite, hoehe, quelle, dauer_ms} oder {keine: true, grund}. Nie Text."""
    start = time.monotonic()
    pfad = payload.get("pfad")
    breite = payload.get("breite")
    breite = int(breite) if isinstance(breite, int) and 200 <= breite <= VORSCHAU_BREITE else VORSCHAU_BREITE
    if not isinstance(pfad, str) or len(pfad) > 1000:
        raise VerarbeitungsFehler("Pfad fehlt")
    datei = aufloesen(cfg.nas_wurzel, pfad)
    if datei is None:
        return {"keine": True, "grund": "nicht_gefunden"}
    try:
        st = datei.stat()
    except OSError:
        return {"keine": True, "grund": "nicht_gefunden"}
    if st.st_size > MAX_DATEI_BYTES:
        return {"keine": True, "grund": "zu_gross"}
    schluessel = _schluessel(pfad, st.st_size, st.st_mtime_ns, breite)
    gemerkt = speicher.lies(schluessel)
    quelle = "cache"
    if gemerkt is False:
        return {"keine": True, "grund": "typ", "quelle": "cache"}
    if gemerkt is None:
        quelle = "neu"
        try:
            neu = erzeuge(datei, breite, cfg.tmp_dir)
        except VerarbeitungsFehler:
            raise
        except subprocess.TimeoutExpired as e:
            raise VerarbeitungsFehler("Vorschau dauerte zu lange") from e
        except Exception as e:  # noqa: BLE001 — kaputte Bilder/PDFs: Klartext, kein Stacktrace nach aussen
            raise VerarbeitungsFehler(f"Vorschau nicht möglich ({type(e).__name__})") from e
        if neu is None:
            speicher.schreibe(schluessel, None)
            return {"keine": True, "grund": "typ", "quelle": quelle}
        daten, w, h = neu
        if len(daten) > MAX_ERGEBNIS_BYTES:
            daten, w, h = _bild_zu_jpeg(daten, max(200, breite * 2 // 3))
        speicher.schreibe(schluessel, daten)
    else:
        daten = gemerkt
        w = h = 0
    return {
        "mime": "image/jpeg",
        "b64": base64.b64encode(daten).decode("ascii"),
        "bytes": len(daten),
        "breite": w,
        "hoehe": h,
        "quelle": quelle,
        "dauer_ms": int((time.monotonic() - start) * 1000),
    }
