"""Antwortzeiten der Wartenden (Suche, Archiv-Frage, Ablage-Vorschlag mit dem schnellen Modell auf der GPU) — für den
Entscheid «zweiter Blick auch tagsüber» (16.10.2026, README «Tagsüber arbeiten»). Läuft als eigener Prozess im
Dienst-Container, ruft die Handler direkt auf (kein FSM, kein Protokoll, kein Claude), nur mit erfundenen Testdaten
(Mietvertrag als Text und als gerenderter Scan). Wartet vor jeder Runde, bis der Dienst nichts tut und nichts wartet.
Ausgabe: nur Zeiten und Zustände — nie Treffer, Antworten oder Inhalte.

    docker exec -i -w /srv/app eventline-ki-dienst python - <bedingung> <runden> < messung/wartende_messen.py
"""

import hashlib
import json
import statistics
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from app.archiv import ArchivIndex, rezept_fuer
from app.archiv_frage import archiv_frage
from app.config import EINSTELLUNGEN as cfg
from app.handlers.ablage import DOK_TYPEN_STANDARD, ablage_analyse
from app.llm import Ollama
from app.suche import Suche, nas_suche
from app.tiefe import TiefenIndex

BEDINGUNG = sys.argv[1] if len(sys.argv) > 1 else "ohne"
RUNDEN = int(sys.argv[2]) if len(sys.argv) > 2 else 5

TEXT = (
    "Mietvertrag\n\nZwischen der Muster Immobilien AG, Beispielstrasse 1, 4000 Basel (Vermieterin) und der "
    "Beispiel Events GmbH (Mieterin) wird folgender Vertrag über die Miete der Halle Nord geschlossen.\n"
    "1. Mietobjekt: Halle Nord, Erdgeschoss, ca. 800 m2, für Veranstaltungen.\n"
    "2. Mietdauer: Der Vertrag beginnt am 1. Januar 2026 und läuft unbefristet. Er kann von beiden Parteien mit einer "
    "Frist von sechs Monaten auf Ende eines Quartals gekündigt werden.\n"
    "3. Nebenkosten werden quartalsweise abgerechnet.\n4. Gerichtsstand ist Basel.\n\nBasel, 15. Dezember 2025\n"
)


def health() -> dict:
    return json.load(urllib.request.urlopen("http://localhost:8700/health", timeout=5))


def warte_auf_ruhe(max_s: float = 600.0) -> dict:
    """Nie neben einem echten Auftrag messen: warten, bis der Dienst nichts tut und nichts wartet."""
    ende = time.monotonic() + max_s
    while True:
        h = health()
        if not h.get("laeuft") and not h.get("warteschlange"):
            return h
        if time.monotonic() > ende:
            return h
        time.sleep(3)


def png_mit_text(pfad: Path) -> None:
    from PIL import Image, ImageDraw, ImageFont

    bild = Image.new("RGB", (1654, 2339), "white")  # A4 bei 200 dpi
    d = ImageDraw.Draw(bild)
    try:
        schrift = ImageFont.truetype("DejaVuSans.ttf", 34)
    except OSError:
        schrift = ImageFont.load_default()
    y = 140
    for zeile in TEXT.replace("\n\n", "\n \n").split("\n"):
        for teil in [zeile[i:i + 70] for i in range(0, max(1, len(zeile)), 70)]:
            d.text((140, y), teil, fill="black", font=schrift)
            y += 52
    bild.save(pfad)


def main() -> None:
    llm = Ollama(cfg)
    suche = Suche(cfg, TiefenIndex(cfg.pg_dsn, statement_timeout_ms=5000), llm)
    archiv = ArchivIndex(cfg.pg_dsn, rezept_fuer(cfg))
    try:
        ordner = json.loads((cfg.data_dir / "fsm-ordnerliste.json").read_text(encoding="utf-8"))
        ordner = ordner.get("ordner", ordner) if isinstance(ordner, dict) else ordner
    except (OSError, ValueError):
        ordner = []
    kontext = {"ordner": ordner, "dok_typen": [{"key": k, "label": l} for k, l in DOK_TYPEN_STANDARD], "mitarbeiter": [],
               "heute": time.strftime("%Y-%m-%d")}
    zeiten: dict[str, list[int]] = {"suche": [], "archiv_frage": [], "ablage_text": [], "ablage_scan": []}
    zustaende = []
    with tempfile.TemporaryDirectory(dir=cfg.tmp_dir) as d:
        txt = Path(d) / "messung-mietvertrag.txt"
        txt.write_text(TEXT, encoding="utf-8")
        png = Path(d) / "messung-mietvertrag-scan.png"
        png_mit_text(png)
        for runde in range(RUNDEN):
            h = warte_auf_ruhe()
            hg = h.get("hintergrund") or {}
            zustaende.append({"runde": runde, "geladen": hg.get("geladen"), "schritt": hg.get("schritt"),
                              "warte": hg.get("warte")})
            t = time.monotonic()
            nas_suche({"q": "Mietvertrag Kündigungsfrist", "limit": 10}, suche)
            zeiten["suche"].append(int((time.monotonic() - t) * 1000))
            t = time.monotonic()
            archiv_frage({"frage": "Mit welcher Frist kann der Mietvertrag gekündigt werden?"}, suche, llm, cfg)
            zeiten["archiv_frage"].append(int((time.monotonic() - t) * 1000))
            for art, pfad, mime in (("ablage_text", txt, "text/plain"), ("ablage_scan", png, "image/png")):
                sha = hashlib.sha256(pfad.read_bytes()).hexdigest()
                t = time.monotonic()
                ablage_analyse(pfad=pfad, dateiname=pfad.name, mime=mime, sha256=sha, kontext_roh=kontext, llm=llm, cfg=cfg,
                               archiv=archiv)
                zeiten[art].append(int((time.monotonic() - t) * 1000))
    print(json.dumps({
        "bedingung": BEDINGUNG,
        "runden": RUNDEN,
        "median_ms": {k: int(statistics.median(v)) for k, v in zeiten.items() if v},
        "alle_ms": zeiten,
        "hauptmodell": zustaende,
    }))


main()
