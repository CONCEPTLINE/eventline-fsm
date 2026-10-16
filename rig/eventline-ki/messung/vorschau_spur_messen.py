"""Vorschau-Latenz während eines langen Auftrags — ohne und mit leichter Spur (16.10.2026, README «Leichte Spur»).

Eigener Prozess im Dienst-Container: ein Mini-FSM auf 127.0.0.1 (Abhol-API wie /api/ki/sync: ein Auftrag je Abholung,
&nur= nur leichte Arten, leichte_arten in jeder Antwort, naechster_poll_ms 300 wie beim Darüberfahren) und ein echter
Worker (app.worker — «ohne» = der Worker allein wie bis heute, «mit» = mit LeichteSpur). Der lange Auftrag ist eine echte
Ablage einer erfundenen, gescannten PDF (mehrere Seiten → Texterkennung, dann das schnelle Modell auf der GPU); die
Vorschauen rendern echte PDFs vom NAS-Mount mit leerem Zwischenspeicher (jedes Mal neu). Nichts geht an das echte FSM,
nichts ins Protokoll, kein Claude. Vor jeder Runde wird gewartet, bis der Dienst nichts tut und nichts wartet; die
Runden wechseln ab (ohne, mit, ohne, …), damit beide unter denselben Bedingungen laufen. Ausgabe nur Zahlen.

    docker exec -i -w /srv/app eventline-ki-dienst python - <runden> < messung/vorschau_spur_messen.py
"""

import dataclasses
import json
import os
import statistics
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from app.config import EINSTELLUNGEN as cfg_basis
from app.fsm import FsmClient
from app.handlers.ablage import DOK_TYPEN_STANDARD
from app.llm import Ollama
from app.worker import Worker, Zustand

RUNDEN = int(sys.argv[1]) if len(sys.argv) > 1 else 4
SEITEN = 6
VORSCHAUEN_MAX = 8
ERSTE_NACH_S = 1.0
ABSTAND_S = 1.2
LEICHT = ("vorschau",)
PRIO = {"diktat": 100, "vorschau": 95}

TEXT = (
    "Mietvertrag Seite {n}\n\nZwischen der Muster Immobilien AG, Beispielstrasse 1, 4000 Basel (Vermieterin) und der "
    "Beispiel Events GmbH (Mieterin) wird folgender Vertrag über die Miete der Halle Nord geschlossen.\n"
    "1. Mietobjekt: Halle Nord, Erdgeschoss, ca. 800 m2, für Veranstaltungen.\n"
    "2. Mietdauer: Der Vertrag beginnt am 1. Januar 2026 und läuft unbefristet. Er kann von beiden Parteien mit einer "
    "Frist von sechs Monaten auf Ende eines Quartals gekündigt werden.\n"
    "3. Nebenkosten werden quartalsweise abgerechnet.\n4. Gerichtsstand ist Basel.\n\nBasel, 15. Dezember 2025\n"
)


def health() -> dict:
    return json.load(urllib.request.urlopen("http://localhost:8700/health", timeout=5))


def warte_auf_ruhe(max_s: float = 900.0) -> bool:
    """Nie neben einem echten Auftrag messen: warten, bis der Dienst nichts tut und nichts wartet."""
    ende = time.monotonic() + max_s
    while time.monotonic() < ende:
        h = health()
        leicht = (h.get("leicht") or {}).get("laeuft") or 0
        if not h.get("laeuft") and not h.get("warteschlange") and not leicht:
            return True
        time.sleep(3)
    return False


def scan_pdf(pfad: Path) -> None:
    """Erfundener Mietvertrag, SEITEN Seiten nur als Bild (A4, 200 dpi) — ohne Textebene, also mit Texterkennung."""
    from PIL import Image, ImageDraw, ImageFont

    try:
        schrift = ImageFont.truetype("DejaVuSans.ttf", 34)
    except OSError:
        schrift = ImageFont.load_default()
    seiten = []
    for n in range(1, SEITEN + 1):
        bild = Image.new("RGB", (1654, 2339), "white")
        d = ImageDraw.Draw(bild)
        y = 140
        for zeile in TEXT.format(n=n).replace("\n\n", "\n \n").split("\n"):
            for teil in [zeile[i:i + 70] for i in range(0, max(1, len(zeile)), 70)]:
                d.text((140, y), teil, fill="black", font=schrift)
                y += 52
        seiten.append(bild)
    seiten[0].save(pfad, "PDF", resolution=200, save_all=True, append_images=seiten[1:])


def nas_pdfs(wurzel: Path, n: int = 12) -> list[str]:
    """Feste Auswahl echter PDFs (100 KB – 8 MB) vom NAS, ohne versteckte Einträge und Systemordner — nur Pfade, nie
    ausgegeben."""
    gefunden: list[str] = []
    for freigabe in sorted(p for p in wurzel.iterdir() if p.is_dir() and not p.name.startswith((".", "@", "#", "99_"))):
        for stamm, ordner, dateien in os.walk(freigabe):
            ordner[:] = sorted(o for o in ordner if not o.startswith((".", "@", "#", "~$")))
            for name in sorted(dateien):
                if not name.lower().endswith(".pdf") or name.startswith((".", "~$")):
                    continue
                p = Path(stamm) / name
                try:
                    groesse = p.stat().st_size
                except OSError:
                    continue
                if 100_000 <= groesse <= 8_000_000:
                    gefunden.append(str(p.relative_to(wurzel)))
                    break
            if len(gefunden) >= n:
                return gefunden
    return gefunden


class MiniFsm:
    """Abhol-API wie /api/ki/sync (Batch 1, &nur=, leichte_arten, naechster_poll_ms) und eine Datei-URL."""

    def __init__(self, datei: bytes) -> None:
        self.lock = threading.Lock()
        self.offen: list[dict] = []
        self.angelegt: dict[str, float] = {}
        self.beansprucht: dict[str, float] = {}
        self.gemeldet: dict[str, float] = {}
        self.ok: dict[str, bool] = {}
        mini = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *_a) -> None:  # noqa: D401
                pass

            def _json(self, daten: dict) -> None:
                roh = json.dumps(daten).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(roh)))
                self.end_headers()
                self.wfile.write(roh)

            def do_GET(self) -> None:  # noqa: N802
                u = urlparse(self.path)
                if u.path == "/datei":
                    self.send_response(200)
                    self.send_header("Content-Type", "application/pdf")
                    self.send_header("Content-Length", str(len(datei)))
                    self.end_headers()
                    self.wfile.write(datei)
                    return
                q = {k: v[0] for k, v in parse_qs(u.query).items()}
                if q.get("nur_herzschlag") == "1":
                    self._json({"success": True, "auftraege": []})
                    return
                nur = [a for a in q["nur"].split(",") if a in LEICHT] if "nur" in q else None
                with mini.lock:
                    kandidaten = [a for a in mini.offen if nur is None or a["art"] in nur]
                    auftraege = []
                    if kandidaten:
                        a = sorted(kandidaten, key=lambda x: -PRIO.get(x["art"], 50))[0]
                        mini.offen.remove(a)
                        mini.beansprucht[a["id"]] = time.monotonic()
                        auftraege = [a]
                self._json({"success": True, "auftraege": auftraege, "leichte_arten": list(LEICHT), "naechster_poll_ms": 300})

            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                with mini.lock:
                    for e in body.get("ergebnisse") or []:
                        mini.gemeldet[str(e.get("id"))] = time.monotonic()
                        mini.ok[str(e.get("id"))] = e.get("ok") is True
                self._json({"success": True})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def neu(self, auftrag: dict) -> None:
        with self.lock:
            self.offen.append(auftrag)
            self.angelegt[auftrag["id"]] = time.monotonic()

    def schliessen(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class Stumm:
    def schreibe(self, *_a, **_k) -> None:  # noqa: ANN002, ANN003
        pass


def runde(mit_spur: bool, pdf: bytes, kontext: dict, vorschauen: list[str], nr: int, langer: bool = True) -> dict:
    mini = MiniFsm(pdf)
    with tempfile.TemporaryDirectory(dir=cfg_basis.tmp_dir) as d:
        cfg = dataclasses.replace(cfg_basis, fsm_url=mini.url, proxy=None, sync_token="m" * 64, data_dir=Path(d),
                                  tmp_dir=Path(d) / "tmp", poll_intervall_s=2.0)
        fsm, leicht, llm = FsmClient(cfg), (FsmClient(cfg) if mit_spur else None), Ollama(cfg)
        w = Worker(cfg, fsm, llm, None, Stumm(), Zustand(), fsm_leicht=leicht)  # type: ignore[arg-type]
        ids: list[str] = []
        try:
            if langer:
                mini.neu({"id": "lang", "art": "ablage_analyse", "versuche": 1, "kontext": kontext,
                          "payload": {"file_name": "messung-mietvertrag-scan.pdf", "mime": "application/pdf",
                                      "size": len(pdf), "url": f"{mini.url}/datei"}})
            w.start()
            if langer:
                frist = time.monotonic() + 30
                while "lang" not in mini.beansprucht and time.monotonic() < frist:
                    time.sleep(0.02)
                t0 = mini.beansprucht["lang"]
            else:
                t0 = time.monotonic()
            for k in range(VORSCHAUEN_MAX):
                ziel = t0 + ERSTE_NACH_S + k * ABSTAND_S
                while time.monotonic() < ziel:
                    time.sleep(0.01)
                if langer and "lang" in mini.gemeldet:
                    break
                i = f"v{k}"
                ids.append(i)
                mini.neu({"id": i, "art": "vorschau", "versuche": 1,
                          "payload": {"pfad": vorschauen[(nr + k) % len(vorschauen)], "breite": 900}})
            frist = time.monotonic() + 120
            while time.monotonic() < frist and not all(i in mini.gemeldet for i in ids + (["lang"] if langer else [])):
                time.sleep(0.05)
        finally:
            w.stop()
            w.join(timeout=15)
            for c in (fsm, leicht):
                if c is not None:
                    c.schliessen()
            llm.schliessen()
            mini.schliessen()
    ende_lang = mini.gemeldet.get("lang")
    waehrend = [i for i in ids if not langer or (ende_lang is not None and mini.angelegt[i] < ende_lang)]
    return {
        "latenz_ms": [int((mini.gemeldet[i] - mini.angelegt[i]) * 1000) for i in waehrend if i in mini.gemeldet],
        "fehlend": sum(1 for i in ids if i not in mini.gemeldet),
        "nicht_ok": sum(1 for i in ids if i in mini.gemeldet and not mini.ok.get(i)),
        "lang_ms": int((ende_lang - mini.beansprucht["lang"]) * 1000) if langer and ende_lang else None,
        "lang_ok": mini.ok.get("lang") if langer else None,
    }


def kennzahlen(werte: list[int]) -> dict:
    if not werte:
        return {"n": 0}
    s = sorted(werte)
    return {"n": len(s), "median_ms": int(statistics.median(s)), "p90_ms": s[min(len(s) - 1, int(round(0.9 * (len(s) - 1))))],
            "max_ms": s[-1], "min_ms": s[0]}


def main() -> None:
    try:
        ordner = json.loads((cfg_basis.data_dir / "fsm-ordnerliste.json").read_text(encoding="utf-8"))
        ordner = ordner.get("ordner", ordner) if isinstance(ordner, dict) else ordner
    except (OSError, ValueError):
        ordner = []
    kontext = {"ordner": ordner, "dok_typen": [{"key": k, "label": l} for k, l in DOK_TYPEN_STANDARD], "mitarbeiter": [],
               "heute": time.strftime("%Y-%m-%d")}
    vorschauen = nas_pdfs(cfg_basis.nas_wurzel)
    if not vorschauen:
        print(json.dumps({"fehler": "keine PDFs auf dem NAS-Mount gefunden"}))
        return
    with tempfile.TemporaryDirectory(dir=cfg_basis.tmp_dir) as d:
        p = Path(d) / "scan.pdf"
        scan_pdf(p)
        pdf = p.read_bytes()
    erg: dict[str, list[dict]] = {"ohne": [], "mit": [], "frei": []}
    gestoert = 0
    for nr in range(RUNDEN * 2):
        art = "ohne" if nr % 2 == 0 else "mit"
        if not warte_auf_ruhe():
            gestoert += 1
            continue
        erg[art].append(runde(art == "mit", pdf, kontext, vorschauen, nr))
        h = health()
        if h.get("laeuft") or h.get("warteschlange"):
            gestoert += 1   # ein echter Auftrag kam dazwischen (nur gezählt)
    for nr in range(2):
        if warte_auf_ruhe():
            erg["frei"].append(runde(False, pdf, kontext, vorschauen, nr, langer=False))
    aus = {"runden_je_art": RUNDEN, "pdfs": len(vorschauen), "seiten_scan": SEITEN, "gestoert": gestoert}
    for art, liste in erg.items():
        aus[art] = {
            "vorschau": kennzahlen([x for r in liste for x in r["latenz_ms"]]),
            "fehlend": sum(r["fehlend"] for r in liste),
            "nicht_ok": sum(r["nicht_ok"] for r in liste),
        }
        lang = [r["lang_ms"] for r in liste if r.get("lang_ms")]
        if lang:
            aus[art]["langer_auftrag_ms"] = {"median": int(statistics.median(lang)), "alle": lang,
                                             "ok": all(r.get("lang_ok") for r in liste)}
    print(json.dumps(aus))


main()
