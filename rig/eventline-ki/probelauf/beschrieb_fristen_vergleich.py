"""Messnacht 15./16.10.2026 — Beschrieb (Rückstau ZZ, Rezept zz/v3) und Fristen (fristen/v2): gemma3:4b gegen
Gemma 4 26B, live-nah, nur Kennzahlen.

Gemessen werden NUR die zwei Aufgaben, die die lokale KI seit dem 15.10. hat (die Ordnerwahl macht Claude im FSM):
1. ausführlicher, gefilterter Beschrieb eines Dokuments — jobs/zz.zz_beschreiben (ganzes Dokument in Teilen zu
   10 000 Zeichen, Teil 2… ergänzt den Beschrieb, deterministischer Sensibel-Filter filtere_beschrieb);
2. Fristen aus allen Teilen — jobs/fristen.fristen_pruefen (Vorfilter, Auszüge, Prüfung gegen Erfindung).
Beides läuft unverändert über den Live-Code; umgeschaltet wird nur das Sprachmodell (cfg.modell_text) und für das
Hauptmodell die Instanz («gruendlich», Prozessor, gestreamt und abbrechbar wie der Planer: use_mmap false, num_gpu 0,
num_ctx 16384, num_thread 10 — derselbe Prompt-Text, nur ein grösseres Fenster, damit nichts neu lädt). Einbettungen
(Vorbilder für die Fakten-Hinweise) laufen wie live auf «schnell». Nichts geht ans FSM, nichts in die Nachtarbeit-
Tabellen; Texte nur aus archiv_text (Tresor); Kontext = gespeicherter Nacht-Kontext des Dienstes, bei der Auswahl
eingefroren (gleiches «heute», gleiche Typen und Mitarbeitende für beide Modelle).

Unterbefehle (im Dienst-Container; Ausgabe im Tresor, Standard /data/probelauf/messnacht-2026-10-15):
  auswahl    feste, geschichtete Stichprobe (Seed) — dieselben Dokumente für beide Modelle
  lauf       ein Modell über die Stichprobe (fortsetzbar: fertige Dokumente werden übersprungen)
  auswerten  Kennzahlen beider Läufe → bericht.json/bericht.md; Blind-Paare → blind/paare.jsonl + blind/schluessel.json
  paare      Blind-Paare lesbar ausgeben (nur GEFILTERTE Beschriebe + Dateiname, A/B zufällig)
  urteil     Blind-Urteile (blind/urteile.json: {"<paar>": "A"|"B"|"gleich"}) mit dem Schlüssel auflösen

Betrieb (Vorrang EVENTLINE): vor jedem Dokument und zwischen den Teilen eines Dokuments wird /health des Dienstes
geprüft — Warteschlange, laufender Auftrag, Nachtarbeit, Tiefen-/Vorbilder-Index, Planer → warten, bis 20 s Ruhe.
Sperrfenster (Standard 05:25–05:50, Selbsttest 05:30). Hauptmodell: Speicher-Tor wie der Planer (Bedarf 17 GB, Puffer
--puffer-gb) 60 s am Stück offen; Wächter alle 2 s, strenger als der Planer (MemAvailable < 3 GiB, Slice-Luft < 1,5 GiB,
PSI full avg10 > 10, Slice-Swap +256 MiB, Seitenfehler, anon von «gruendlich» > 18 GiB) → Stream trennen, entladen,
10 min Pause, Dokument einmal wiederholen. Prompt-Cache von llama-server (E2.4: bis 8 GiB im RAM, OOM nach ~8–10
Dateien) → entladen, sobald anon von «gruendlich» --cache-gib über dem Stand nach dem Laden liegt. Am Ende entladen.

Ausgaben: Zahlen, Felder-Zähler und der GEFILTERTE Beschrieb (geht laut Architektur ohnehin an Claude) — nie
Dokumenttext, nie Roh-Antworten des Modells. Pfade/Dateinamen nur im Tresor (auswahl.json, ergebnisse-*.jsonl).
Die Konsole/das Lauf-Log zeigen nur Nummern und Zahlen.

Aufruf (Rig):
  D="docker exec eventline-ki-dienst python /probelauf/beschrieb_fristen_vergleich.py"
  $D auswahl
  $D lauf --name g3 --modell gemma3:4b
  G=$(docker inspect -f '{{.Id}}' eventline-ki-ollama-gruendlich); S=$(docker inspect -f '{{.Id}}' eventline-ki-ollama)
  docker exec -d eventline-ki-dienst sh -c "python /probelauf/beschrieb_fristen_vergleich.py lauf --name g4 \\
      --modell gemma4:26b-a4b-it-qat --gruendlich --gruendlich-id $G --schnell-id $S >> /data/probelauf/…/g4.log 2>&1"
  $D auswerten && $D paare
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import os
import random
import re
import signal
import statistics
import sys
import threading
import time
import urllib.request
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

ZH = ZoneInfo("Europe/Zurich")
AUSGABE_STANDARD = "/data/probelauf/messnacht-2026-10-15"
KONTEXT_DATEI = "/data/nacht-kontext.json"
HEALTH_STANDARD = "http://127.0.0.1:8700/health"
SEED_STANDARD = 20261015
RUHE_S = 20.0
GIB = 1024 ** 3
# Schichten der Stichprobe (Reihenfolge = Vorrang beim Ziehen; jedes Dokument nur einmal).
SCHICHTEN: tuple[tuple[str, int], ...] = (
    ("fristen", 14), ("lang3", 2), ("lang2", 4), ("scan", 5), ("personal", 4), ("rechnung", 3), ("location", 4),
    ("rest", 4),
)
BEDARF_26B_GB = 17.0
CSV_SPALTEN = (
    "zeit", "mem_available_gib", "swap_free_gib", "slice_gib", "slice_nicht_rueck_gib", "slice_anon_gib",
    "slice_swap_gib", "psi_mem_full10", "psi_mem_some10", "psi_cpu_some10", "pgmajfault", "g_anon_gib", "g_swap_gib",
    "g_oom_kill", "s_anon_gib", "s_swap_gib", "vram_frei_mb", "scharf", "grund",
)

log = logging.getLogger("messnacht")


class Stopp(Exception):
    """Zeitgrenze erreicht oder Halt-Signal — laufendes Dokument wird nicht gewertet."""


def jetzt() -> datetime:
    return datetime.now(ZH)


def grenze_ab(start: datetime, hhmm: str) -> datetime:
    """HH:MM als nächster solcher Zeitpunkt ab start (über Mitternacht)."""
    h, m = (int(x) for x in hhmm.split(":"))
    t = start.replace(hour=h, minute=m, second=0, microsecond=0)
    return t if t > start else t + timedelta(days=1)


def lies_json(pfad: Path) -> Any:
    return json.loads(pfad.read_text(encoding="utf-8"))


def schreibe_json(pfad: Path, daten: Any) -> None:
    tmp = pfad.with_suffix(pfad.suffix + ".tmp")
    tmp.write_text(json.dumps(daten, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(pfad)


def app_laden(app_pfad: str) -> None:
    sys.path.insert(0, app_pfad)
    logging.getLogger("pypdf").setLevel(logging.ERROR)
    for bib in ("httpx", "httpcore"):
        logging.getLogger(bib).setLevel(logging.WARNING)


# --- Auswahl ---------------------------------------------------------------------------------------------------


def cmd_auswahl(a: argparse.Namespace) -> int:
    app_laden(a.app_pfad)
    from app import ablageregeln as ar
    from app.config import EINSTELLUNGEN as cfg
    from app.jobs import fristen as fj
    from app.jobs import zz as zj
    from app.nachtarbeit import NachtSpeicher

    aus = Path(a.ausgabe)
    aus.mkdir(parents=True, exist_ok=True)
    if (aus / "auswahl.json").exists() and not a.neu:
        print("auswahl.json existiert schon (--neu zum Überschreiben)", file=sys.stderr)
        return 1
    kontext = lies_json(Path(a.kontext))
    daten = kontext.get("daten", kontext)
    sp = NachtSpeicher(cfg.pg_dsn, trocken=True)
    try:
        pool = []
        for z in sp.texte():
            if z.zeichen <= 0:
                continue
            t = sp.text(z.pfad, z.sha256) or ""
            if not t.strip():
                continue
            pf = ar.falte(z.pfad)
            vf = fj.vorfilter(t)
            pool.append({
                "pfad": z.pfad, "sha256": z.sha256, "name": z.name, "ocr": bool(z.ocr), "seiten": z.seiten,
                "zeichen": len(t), "teile": len(zj.text_teile(t)), "vorfilter": vf,
                "fristen_teile": len(fj.auszug_teile(t)) if vf else 0,
                "zz": z.pfad.split("/", 1)[0].upper().startswith("ZZ_"),
                "personal": "personal" in pf,
                "rechnung": bool(re.search(r"rechnung|invoice|faktur|quittung|beleg|zahlung", pf)),
                "location": z.pfad.startswith("02_LOCATIONS") or "location" in pf,
            })
    finally:
        sp.schliessen()
    zufall = random.Random(a.seed)
    bedingung: dict[str, Callable[[dict], bool]] = {
        "fristen": lambda d: d["vorfilter"], "lang3": lambda d: d["teile"] >= 3, "lang2": lambda d: d["teile"] == 2,
        "scan": lambda d: d["ocr"], "personal": lambda d: d["personal"], "rechnung": lambda d: d["rechnung"],
        "location": lambda d: d["location"], "rest": lambda d: True,
    }
    gewaehlt: list[dict] = []
    gesehen: set[tuple[str, str]] = set()
    zaehler = Counter()
    for name, n in SCHICHTEN:
        kand = sorted((d for d in pool if (d["pfad"], d["sha256"]) not in gesehen and bedingung[name](d)),
                      key=lambda d: (d["pfad"], d["sha256"]))
        # «rest»: so auffüllen, dass genau a.anzahl Dokumente entstehen
        if name == "rest":
            n = max(0, a.anzahl - len(gewaehlt))
        for d in zufall.sample(kand, min(n, len(kand))):
            gewaehlt.append({**d, "schicht": name})
            gesehen.add((d["pfad"], d["sha256"]))
            zaehler[name] += 1
    # Reihenfolge: gemischt, lange Dokumente (≥ 3 Teile) zuletzt — reicht die Zeit nicht, fehlen sie, nicht 30 kurze.
    zufall.shuffle(gewaehlt)
    gewaehlt.sort(key=lambda d: d["teile"] >= 3)
    for i, d in enumerate(gewaehlt, start=1):
        d["id"] = f"d{i:02d}"
    schreibe_json(aus / "auswahl.json", {"seed": a.seed, "erstellt": jetzt().isoformat(), "pool": len(pool),
                                          "schichten": dict(zaehler), "dokumente": gewaehlt})
    schreibe_json(aus / "kontext.json", {"daten": daten, "eingefroren": jetzt().isoformat()})
    eig = Counter()
    for d in gewaehlt:
        for k in ("vorfilter", "ocr", "zz", "personal", "rechnung", "location"):
            eig[k] += bool(d[k])
    print(json.dumps({
        "pool": len(pool), "gewaehlt": len(gewaehlt), "schichten": dict(zaehler), "eigenschaften": dict(eig),
        "teile": dict(sorted(Counter(d["teile"] for d in gewaehlt).items())),
        "zeichen_median": int(statistics.median(d["zeichen"] for d in gewaehlt)) if gewaehlt else 0,
        "seiten_summe": sum(d["seiten"] or 0 for d in gewaehlt),
        "fristen_teile": sum(d["fristen_teile"] for d in gewaehlt),
    }, ensure_ascii=False))
    return 0


# --- Analyse eines Teils (Spiegel von jobs/zz.filtere_beschrieb, nur Zähler) -------------------------------------


def analysiere_teil(roh: dict[str, Any], *, dateiname: str, pfad: str, text: str, heute: str, **_: Any) -> Counter:
    """Roh-Antwort eines Teils → Zähler: was der Filter entfernen muss (sensibel/unbelegt) und was unbelegt ist.
    Deterministisch gegen den ganzen Dokumenttext, den Dateinamen und den bisherigen Ablageort (wie der Filter).
    «streng» = der ganze Name steht (normalisiert) wörtlich da; «unbelegt» = die Regel des Filters schlägt fehl."""
    from app import ablageregeln as ar
    from app.handlers import datum_gueltig, text_kurz
    from app.jobs import fristen as fj
    from app.jobs import zz as zj

    z: Counter = Counter()
    if not isinstance(roh, dict):
        z["roh_kein_objekt"] += 1
        return z
    herkunft = ar.herkunft_segmente(pfad)
    quelle = set(ar.woerter(text or "")) | set(ar.woerter(dateiname)) | {w for s in herkunft for w in ar.woerter(s)}
    flach = " " + " ".join(ar.woerter(f"{text or ''} {dateiname} {' '.join(herkunft)}")) + " "

    def streng(name: str) -> bool:
        n = " ".join(ar.woerter(name))
        return bool(n) and f" {n} " in flach

    def name_pruefen(roh_name: Any, n: int, art: str) -> None:
        if not text_kurz(roh_name, n):
            return
        z["namen_roh"] += 1
        wert = zj.sauber(roh_name, n)
        if not wert:
            z["filter_sensibel"] += 1
            z[f"filter_sensibel_{art}"] += 1
            return
        z["namen_geprueft"] += 1
        if not zj._belegt(wert, quelle):  # noqa: SLF001 — dieselbe Regel wie der Filter
            z["namen_unbelegt"] += 1
        if not streng(wert):
            z["namen_unbelegt_streng"] += 1

    for f, n in zj.MAX_ZEICHEN_ZZ.items():
        if f in ("datum", "sprache"):
            continue
        roh_wert = text_kurz(roh.get(f), n)
        if not roh_wert:
            continue
        z[f"roh_{f}"] += 1
        if zj._ZITAT.search(roh_wert):  # noqa: SLF001
            z["zitat_gefunden"] += 1
        if f in ("absender", "empfaenger"):
            name_pruefen(roh.get(f), n, f)
            continue
        if not zj.sauber(roh.get(f), n):
            z["filter_sensibel"] += 1
            z[f"filter_sensibel_{f}"] += 1
    status = str(roh.get("status") or "")
    if status:
        z["status_roh"] += 1
        belege = ar.falte(f"{dateiname} {' '.join(herkunft)} {text or ''}")
        if status not in zj.STATUS_WERTE or not re.search(zj._STATUS_BELEG[status], belege):  # noqa: SLF001
            z["status_unbelegt"] += 1
    roh_d = roh.get("datum")
    if roh_d not in (None, ""):
        z["datum_roh"] += 1
        d = datum_gueltig(roh_d)
        if not d or not ("2000-01-01" <= d <= f"{int(heute[:4]) + 1}-12-31"):
            z["datum_ungueltig"] += 1
        elif not (fj.datum_im_text(d, text or "") or fj.datum_im_text(d, dateiname)
                  or d.replace("-", "") in re.sub(r"\D", "", dateiname)):
            z["datum_unbelegt"] += 1
    for j in re.findall(r"(?<!\d)(?:19|20)\d\d(?!\d)", text_kurz(roh.get("zeitraum"), 40)):
        z["jahre_roh"] += 1
        if f" {j} " not in flach:
            z["jahre_unbelegt"] += 1
    for e in roh.get("beteiligte") or []:
        if not isinstance(e, dict):
            continue
        name_pruefen(e.get("name"), 80, "name")
        rolle_roh = text_kurz(e.get("rolle"), 60)
        if rolle_roh and text_kurz(e.get("name"), 80) and not zj.sauber(e.get("rolle"), 60):
            z["filter_sensibel"] += 1
            z["filter_sensibel_rolle"] += 1
    for w in roh.get("schlagworte") or []:
        if not text_kurz(w, 30):
            continue
        z["schlagworte_roh"] += 1
        ws = zj.sauber(w, 30)
        if not ws or re.fullmatch(r"(?i)(chf|eur|usd|fr\.?|franken|betrag|lohn|stundensatz|iban|ahv)", ws):
            z["filter_sensibel"] += 1
            z["filter_sensibel_schlagwort"] += 1
    if roh.get("personenbezogen"):
        z["personenbezogen_roh"] += 1
    return z


# --- Wächter (nur Zahlen) -------------------------------------------------------------------------------------


def _lies(p: Path) -> str | None:
    try:
        return p.read_text(encoding="ascii", errors="replace")
    except OSError:
        return None


def scope_werte(scope: Path | None) -> dict[str, int | None]:
    if scope is None:
        return {"anon": None, "swap": None, "oom_kill": None}
    stat = {}
    for zeile in (_lies(scope / "memory.stat") or "").splitlines():
        t = zeile.split()
        if len(t) == 2 and t[1].isdigit():
            stat[t[0]] = int(t[1])
    ev = {}
    for zeile in (_lies(scope / "memory.events") or "").splitlines():
        t = zeile.split()
        if len(t) == 2 and t[1].isdigit():
            ev[t[0]] = int(t[1])
    sw = (_lies(scope / "memory.swap.current") or "").strip()
    return {"anon": stat.get("anon"), "swap": int(sw) if sw.isdigit() else None, "oom_kill": ev.get("oom_kill")}


def psi_avg10(pfad: str, art: str) -> float | None:
    for zeile in (_lies(Path(pfad)) or "").splitlines():
        if zeile.startswith(art):
            for teil in zeile.split():
                if teil.startswith("avg10="):
                    try:
                        return float(teil[6:])
                    except ValueError:
                        return None
    return None


def vram_frei_mb() -> int | None:
    try:
        from app import gpu

        w = gpu._abfragen()  # noqa: SLF001
        v = w.get("frei_mb")
        return int(v) if isinstance(v, (int, float)) else None
    except Exception:  # noqa: BLE001
        return None


class Waechter(threading.Thread):
    """Alle 2 s ein Messpunkt in die CSV (nur Zahlen). scharf (nur während Arbeit an «gruendlich»): bei einem Auslöser
    wird abbruch gesetzt — der gestreamte Aufruf trennt sofort, der Lauf entlädt und pausiert."""

    def __init__(self, csv_pfad: Path, scope_g: Path | None, scope_s: Path | None, *, takt_s: float = 2.0,
                 anon_max_gib: float = 18.0, mem_min_gib: float = 3.0) -> None:
        super().__init__(daemon=True, name="mess-waechter")
        from app import speicher as sp_mod

        self.sp = sp_mod
        self.q = sp_mod.Quellen(slice_dir=Path(os.environ.get("KI_HG_SLICE_DIR", "/ki-slice")))
        self.regel = sp_mod.WaechterRegel(not_gb=1.5, psi_full_max=10.0)
        self.csv_pfad = csv_pfad
        self.scope_g, self.scope_s = scope_g, scope_s
        self.takt_s = takt_s
        self.anon_max = anon_max_gib * GIB
        self.mem_min = mem_min_gib * GIB
        self.abbruch = threading.Event()
        self.halt = threading.Event()
        self.scharf = False
        self.grund: str | None = None
        self.ausloeser: Counter = Counter()
        self.letzte: dict[str, Any] = {}
        self._n = 0
        self._lock = threading.Lock()

    def messung(self) -> Any:
        return self.sp.messen(self.q)

    def g_anon(self) -> int | None:
        return scope_werte(self.scope_g)["anon"]

    def scharf_schalten(self, an: bool) -> None:
        # Swap-Basis NICHT je Aufruf zurücksetzen: langsames Wachsen über viele Aufrufe (E2.4: bis 7,8 GB ausgelagert)
        # soll auffallen. Zurückgesetzt wird nur nach einer Wächter-Pause (quittieren).
        with self._lock:
            self.scharf = an

    def quittieren(self) -> str | None:
        with self._lock:
            g, self.grund = self.grund, None
            self.abbruch.clear()
            self.regel.zuruecksetzen()
            return g

    def run(self) -> None:
        neu = not self.csv_pfad.exists()
        with open(self.csv_pfad, "a", encoding="utf-8") as f:
            if neu:
                f.write(",".join(CSV_SPALTEN) + "\n")
            while not self.halt.wait(self.takt_s):
                try:
                    self._schritt(f)
                except Exception as e:  # noqa: BLE001 — Messen darf den Lauf nie beenden
                    log.warning("Wächter: %s", type(e).__name__)

    def _schritt(self, f: Any) -> None:
        m = self.messung()
        g = scope_werte(self.scope_g)
        s = scope_werte(self.scope_s)
        grund = self.regel.pruefe(m)
        if grund is None and m.mem_available is not None and m.mem_available < self.mem_min:
            grund = "mem_available_3gib"
        if grund is None and g["anon"] is not None and g["anon"] > self.anon_max:
            grund = "anon_gruendlich"
        self._n += 1
        vram = vram_frei_mb() if self._n % 5 == 1 else None

        def gib(v: int | None) -> str:
            return "" if v is None else f"{v / GIB:.3f}"

        def zahl(v: float | int | None) -> str:
            return "" if v is None else str(v)

        with self._lock:
            scharf = self.scharf
            if grund and scharf and not self.abbruch.is_set():
                self.grund = grund
                self.ausloeser[grund] += 1
                self.abbruch.set()
                log.warning("Wächter: Auslöser %s → Abbruch", grund)
        self.letzte = {"m": m, "g": g, "s": s}
        werte = [
            jetzt().strftime("%Y-%m-%dT%H:%M:%S"), gib(m.mem_available), gib(m.swap_free), gib(m.slice_current),
            gib(m.nicht_rueckgewinnbar), gib(m.slice_anon), gib(m.slice_swap),
            "" if m.psi_full_avg10 is None else f"{m.psi_full_avg10:.2f}",
            zahl(psi_avg10("/proc/pressure/memory", "some")), zahl(psi_avg10("/proc/pressure/cpu", "some")),
            zahl(m.pgmajfault), gib(g["anon"]), gib(g["swap"]), zahl(g["oom_kill"]),
            gib(s["anon"]), gib(s["swap"]), "" if vram is None else str(vram), "1" if scharf else "0", grund or "",
        ]
        f.write(",".join(werte) + "\n")
        f.flush()


# --- Lauf ---------------------------------------------------------------------------------------------------------


def cmd_lauf(a: argparse.Namespace) -> int:  # noqa: C901, PLR0915 — ein Ablauf, bewusst an einem Ort
    app_laden(a.app_pfad)
    from app.archiv import ArchivIndex, rezept_fuer
    from app.config import EINSTELLUNGEN
    from app.jobs import fristen as fj
    from app.jobs import zz as zj
    from app import speicher as sp_mod
    from app.llm import LlmAbgebrochen, LlmFehler, Ollama, json_aus_text
    from app.nachtarbeit import NachtSpeicher

    aus = Path(a.ausgabe)
    auswahl = lies_json(aus / "auswahl.json")["dokumente"]
    kontext = lies_json(aus / "kontext.json")["daten"]
    erg_pfad = aus / f"ergebnisse-{a.name}.jsonl"
    fertig: set[str] = set()
    if erg_pfad.exists():
        for zeile in erg_pfad.read_text(encoding="utf-8").splitlines():
            try:
                e = json.loads(zeile)
            except ValueError:
                continue
            if not e.get("fehler") or a.fehler_ueberspringen:
                fertig.add(e["id"])
    if a.nur:
        auswahl = [d for d in auswahl if d["id"] in set(a.nur)]
    if a.max:
        auswahl = auswahl[: a.max]
    start = jetzt()
    stopp = grenze_ab(start, a.stopp)
    hart = grenze_ab(start, a.hart)
    sperre = [grenze_ab(start - timedelta(hours=12), t) for t in a.sperre.split("-")] if a.sperre else None
    if sperre and sperre[1] <= sperre[0]:
        sperre[1] += timedelta(days=1)

    cfg = dataclasses.replace(EINSTELLUNGEN, modell_text=a.modell)
    halt = threading.Event()

    def beende(*_: Any) -> None:
        halt.set()

    signal.signal(signal.SIGTERM, beende)
    signal.signal(signal.SIGINT, beende)

    gid = a.gruendlich_id
    sid = a.schnell_id
    slice_dir = Path(os.environ.get("KI_HG_SLICE_DIR", "/ki-slice"))
    scope_g = slice_dir / f"docker-{gid}.scope" if gid else None
    scope_s = slice_dir / f"docker-{sid}.scope" if sid else None
    waechter = Waechter(aus / f"speicher-{a.name}.csv", scope_g, scope_s, anon_max_gib=a.anon_max_gib)
    waechter.start()

    ziel = Ollama(cfg, base_url=cfg.hg_url, schleuse=False) if a.gruendlich else None
    hg_opt = {"use_mmap": False, "num_gpu": 0, "num_thread": a.num_thread} if a.gruendlich else {}
    akt: dict[str, Any] = {"aufgabe": None, "aufrufe": [], "fehl": []}

    class MessOllama(Ollama):
        """Live-Weg (chat_json auf «schnell») oder — mit --gruendlich — gestreamt an «gruendlich» mit den Optionen des
        Planers; merkt sich je Aufruf nur Zähler. Einbettungen bleiben immer auf «schnell»."""

        def chat_json(self, **kw: Any) -> tuple[dict[str, Any], dict[str, Any]]:  # type: ignore[override]
            if halt.is_set() or jetzt() >= hart:
                raise Stopp("zeit")
            try:
                if ziel is None:
                    roh, meta = super().chat_json(**kw)
                else:
                    roh, meta = self._gestreamt(**kw)
            except LlmFehler as e:
                akt["fehl"].append({"aufgabe": akt["aufgabe"], "art": type(e).__name__,
                                    "grund": getattr(e, "grund", None)})
                raise
            akt["aufrufe"].append({**{k: meta.get(k) for k in (
                "dauer_ms", "prompt_tokens", "antwort_tokens", "lade_ms", "prompt_ms", "antwort_ms", "num_ctx")},
                "aufgabe": akt["aufgabe"]})
            return roh, meta

        def _gestreamt(self, *, modell: str, system: str, nutzer: str, schema: dict, num_ctx: int,
                       bilder: list[str] | None = None, num_predict: int = 1024, timeout_s: float | None = None,
                       optionen: dict | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
            del timeout_s, bilder  # Frist kommt aus --frist-s; Bilder gibt es in diesen Aufgaben nicht
            opts = {"temperature": 0, "num_ctx": a.num_ctx, "num_predict": num_predict, **hg_opt, **(optionen or {})}
            waechter.scharf_schalten(True)
            text, meta = ziel.chat_stream(
                modell=modell, nachrichten=[{"role": "system", "content": system}, {"role": "user", "content": nutzer}],
                optionen=opts, keep_alive=a.keep_alive, format=schema, think=False, abbruch=waechter.abbruch,
                frist_s=a.frist_s,
            )
            daten = json_aus_text(text) if text else None
            if daten is None:
                raise LlmFehler(f"Modell {modell} lieferte {'keine Antwort' if not text else 'kein gültiges JSON'}")
            return daten, {**meta, "num_ctx": a.num_ctx}

    llm = MessOllama(cfg)
    archiv = ArchivIndex(cfg.pg_dsn, rezept_fuer(cfg))
    sp = NachtSpeicher(cfg.pg_dsn, trocken=True)

    # Filter-Analyse je Teil: filtere_beschrieb im Modul zz umhüllen (gleiche Argumente, gleiches Ergebnis).
    teile_z: list[Counter] = []
    orig_filter = zj.filtere_beschrieb

    def mess_filter(roh: dict[str, Any], **kw: Any) -> dict[str, Any]:
        try:
            teile_z.append(analysiere_teil(roh, **kw))
        except Exception as e:  # noqa: BLE001
            teile_z.append(Counter({f"analyse_fehler_{type(e).__name__}": 1}))
        return orig_filter(roh, **kw)

    zj.filtere_beschrieb = mess_filter

    pausen: Counter = Counter()
    # tor_s_noetig: so lange muss das Speicher-Tor am Stück offen sein, bevor das Hauptmodell (wieder) lädt — am
    # Anfang und nach einer Wächter-Pause --tor-s, nach einem Cache-Entladen 0 (der Speicher ist gerade frei geworden).
    stand: dict[str, Any] = {"entladungen": 0, "basis_anon": None, "tor_offen_seit": None, "tor_s_noetig": a.tor_s,
                             "ruhig_seit": None}

    def belegt_grund(h: dict | None) -> str | None:
        if h is None:
            return "health_unerreichbar"
        if h.get("warteschlange"):
            return "warteschlange"
        if h.get("laeuft"):
            return "auftrag"
        if (h.get("nachtarbeit") or {}).get("laeuft"):
            return "nachtarbeit"
        if (h.get("tiefe") or {}).get("laeuft"):
            return "tiefen_index"
        if (h.get("archiv") or {}).get("laeuft"):
            return "vorbilder_index"
        hg = h.get("hintergrund") or {}
        if hg.get("aktiv") and (hg.get("geladen") or hg.get("laedt")):
            return "planer"
        return None

    def health() -> dict | None:
        try:
            with urllib.request.urlopen(a.health_url, timeout=5) as r:  # noqa: S310 — feste lokale Adresse
                return json.loads(r.read().decode("utf-8"))
        except Exception:  # noqa: BLE001
            return None

    def modell_geladen() -> bool | None:
        if ziel is None:
            return None
        ps = ziel.geladene_modelle_oder_none()
        if ps is None:
            return None
        return any(str(m.get("name")) == a.modell or str(m.get("model")) == a.modell for m in ps)

    def entladen(grund: str) -> None:
        if ziel is None:
            return
        ziel.entlade(a.modell)
        stand["entladungen"] += 1
        stand["basis_anon"] = None
        stand["tor_offen_seit"] = None
        stand["tor_s_noetig"] = 0.0 if grund == "cache" else a.tor_s
        stand.setdefault("entlade_gruende", Counter())[grund] += 1
        log.info("entladen (%s)", grund)
        time.sleep(3)

    def cache_pruefen() -> None:
        """Prompt-Cache-Schutz (E2.4): anon von «gruendlich» > Stand nach dem Laden + --cache-gib → entladen."""
        if ziel is None or scope_g is None:
            return
        anon = waechter.g_anon()
        if anon is None:
            return
        if modell_geladen() is False:
            stand["basis_anon"] = None
            return
        if stand["basis_anon"] is None or anon < stand["basis_anon"]:
            stand["basis_anon"] = anon
        if anon - stand["basis_anon"] > a.cache_gib * GIB:
            entladen("cache")

    def warte_frei(wo: str) -> None:
        """Bis der Dienst ruhig ist (20 s am Stück, über Aufrufe hinweg gemerkt), kein Sperrfenster und — vor dem
        (Wieder-)Laden des Hauptmodells — das Speicher-Tor offen ist."""
        while True:
            if halt.is_set():
                raise Stopp("halt")
            t = jetzt()
            if t >= hart or (wo == "dokument" and t >= stopp):
                raise Stopp("zeit")
            grund = belegt_grund(health())
            if grund is None and sperre and sperre[0] <= t < sperre[1]:
                grund = "sperrfenster"
            if grund is None and ziel is not None and modell_geladen() is False:
                tb = sp_mod.tor(waechter.messung(), BEDARF_26B_GB, a.puffer_gb)
                if not tb.offen:
                    grund = f"tor_{tb.grund}"
                    stand["tor_offen_seit"] = None
                else:
                    if stand["tor_offen_seit"] is None:
                        stand["tor_offen_seit"] = time.monotonic()
                    if time.monotonic() - stand["tor_offen_seit"] < stand["tor_s_noetig"]:
                        grund = "tor_warten"
            if grund is None:
                if stand["ruhig_seit"] is None:
                    stand["ruhig_seit"] = time.monotonic()
                if time.monotonic() - stand["ruhig_seit"] >= RUHE_S:
                    stand["tor_offen_seit"] = None
                    return
                time.sleep(2)
                pausen["ruhe_abwarten"] += 2
                continue
            if grund != "tor_warten":
                stand["ruhig_seit"] = None
                if pausen[grund] % 300 == 0:
                    log.info("warte: %s (%s)", grund, wo)
            time.sleep(5)
            pausen[grund] += 5

    def zwischen() -> None:
        """vorrang-Callback zwischen den Teilen eines Dokuments: Cache-Schutz, dann Wartende zuerst."""
        waechter.scharf_schalten(False)
        cache_pruefen()
        warte_frei("teil")

    def nach_abbruch(grund: str) -> None:
        waechter.scharf_schalten(False)
        entladen(f"waechter_{grund}")
        log.warning("Wächter-Pause %d s (%s)", a.pause_s, grund)
        ende = time.monotonic() + a.pause_s
        while time.monotonic() < ende:
            if halt.is_set() or jetzt() >= hart:
                raise Stopp("zeit")
            time.sleep(5)
        pausen[f"waechter_{grund}"] += a.pause_s
        waechter.quittieren()

    oom_start = scope_werte(scope_g)["oom_kill"]
    log.info("Lauf %s: Modell %s (%s), %d Dokumente (%d schon fertig), Stopp %s, hart %s", a.name, a.modell,
             "gruendlich" if ziel else "schnell", len(auswahl), len(fertig & {d["id"] for d in auswahl}),
             stopp.strftime("%H:%M"), hart.strftime("%H:%M"))
    gerechnet = 0
    grund_ende = "fertig"
    try:
        with open(erg_pfad, "a", encoding="utf-8") as out:
            for d in auswahl:
                if d["id"] in fertig:
                    continue
                try:
                    cache_pruefen()
                    warte_frei("dokument")
                except Stopp as e:
                    grund_ende = str(e)
                    break
                text = sp.text(d["pfad"], d["sha256"])
                zeile: dict[str, Any] = {"id": d["id"], "modell": a.modell, "lauf": a.name, "start": jetzt().isoformat(),
                                         "schicht": d["schicht"], "teile": d["teile"], "seiten": d["seiten"],
                                         "zeichen": d["zeichen"], "ocr": d["ocr"], "zz": d["zz"], "fehler": None}
                if text is None:
                    zeile["fehler"] = {"aufgabe": "text", "art": "text_fehlt"}
                    out.write(json.dumps(zeile, ensure_ascii=False) + "\n")
                    out.flush()
                    continue
                oom_vor = scope_werte(scope_g)["oom_kill"]
                abbruch_ende = False
                for aufgabe in ("beschrieb", "fristen"):
                    for versuch in (1, 2):
                        akt.update(aufgabe=aufgabe, aufrufe=[], fehl=[])
                        teile_z.clear()
                        t0 = time.monotonic()
                        try:
                            if aufgabe == "beschrieb":
                                b = zj.zz_beschreiben(
                                    pfad=d["pfad"], dateiname=d["name"], sha256=d["sha256"], text=text,
                                    seiten=d["seiten"], ocr=d["ocr"], kontext_roh=kontext, llm=llm, cfg=cfg,
                                    archiv=archiv, ohne_sha=(() if d["zz"] else {d["sha256"]}), vorrang=zwischen,
                                )
                                zeile["beschrieb"] = b.beschrieb
                                zeile["beschrieb_status"] = b.status
                                zeile["fakten_n"] = len(b.fakten)
                                zeile["kandidaten_n"] = len(b.kandidaten)
                                zeile["personenbezogen"] = b.personenbezogen
                                zeile["beschrieb_ms"] = int((time.monotonic() - t0) * 1000)
                                zeile["beschrieb_aufrufe"] = list(akt["aufrufe"])
                                zeile["teil_zaehler"] = [dict(c) for c in teile_z]
                            else:
                                f = fj.fristen_pruefen(
                                    pfad=d["pfad"], dateiname=d["name"], text=text, ocr=d["ocr"], kontext_roh=kontext,
                                    llm=llm, cfg=cfg, vorrang=zwischen,
                                )
                                zeile["fristen"] = {
                                    "status": f.status, "typ": f.typ, "dok_datum": bool(f.dok_datum),
                                    "partei": bool(f.partei), "personenbezogen": f.personenbezogen,
                                    "zaehler": dict(f.zaehler), "ms": int((time.monotonic() - t0) * 1000),
                                    "fristen": [{"art": x.art, "bedingungen": x.bedingungen, "seite": x.seite,
                                                 "sicherheit": x.sicherheit} for x in f.fristen],
                                    "aufrufe": list(akt["aufrufe"]),
                                }
                            if versuch > 1:
                                zeile.setdefault("wiederholt", []).append(aufgabe)
                            break
                        except Stopp as e:
                            zeile["fehler"] = {"aufgabe": aufgabe, "art": f"stopp_{e}"}
                            grund_ende = str(e)
                            abbruch_ende = True
                            break
                        except LlmFehler as e:
                            wg = waechter.grund
                            art = (f"waechter_{wg}" if wg else
                                   ("zeit" if isinstance(e, LlmAbgebrochen) and e.grund == "zeit" else "llm"))
                            zeile.setdefault("abbrueche", []).append({"aufgabe": aufgabe, "art": art,
                                                                      "ms": int((time.monotonic() - t0) * 1000)})
                            log.warning("%s %s: Abbruch %s (Versuch %d)", d["id"], aufgabe, art, versuch)
                            try:
                                if wg:
                                    nach_abbruch(wg)
                                elif ziel is not None:
                                    entladen(f"fehler_{art}")
                                if versuch == 1:
                                    warte_frei("teil")
                                    continue
                            except Stopp as s:
                                grund_ende = str(s)
                                abbruch_ende = True
                            zeile["fehler"] = {"aufgabe": aufgabe, "art": art}
                            break
                        finally:
                            waechter.scharf_schalten(False)
                    if zeile["fehler"]:
                        break
                oom_nach = scope_werte(scope_g)["oom_kill"]
                if oom_vor is not None and oom_nach is not None and oom_nach > oom_vor:
                    zeile["oom_kill"] = oom_nach - oom_vor
                zeile["ende"] = jetzt().isoformat()
                out.write(json.dumps(zeile, ensure_ascii=False) + "\n")
                out.flush()
                gerechnet += 1
                b_ms = zeile.get("beschrieb_ms")
                f_ms = (zeile.get("fristen") or {}).get("ms")
                log.info("%s fertig: Teile %d, Beschrieb %s ms, Fristen %s ms%s", d["id"], d["teile"], b_ms, f_ms,
                         f", FEHLER {zeile['fehler']['art']}" if zeile["fehler"] else "")
                if abbruch_ende:
                    break
                cache_pruefen()
    finally:
        zj.filtere_beschrieb = orig_filter
        if ziel is not None:
            try:
                ziel.entlade(a.modell)
                log.info("Ende: %s entladen", a.modell)
            except Exception:  # noqa: BLE001
                log.warning("Ende: Entladen fehlgeschlagen")
        waechter.halt.set()
        waechter.join(timeout=10)
        oom_ende = scope_werte(scope_g)["oom_kill"]
        lauf_info = {
            "name": a.name, "modell": a.modell, "instanz": "gruendlich" if ziel else "schnell", "start": start.isoformat(),
            "ende": jetzt().isoformat(), "grund_ende": grund_ende, "gerechnet": gerechnet,
            "optionen": {**hg_opt, "num_ctx": a.num_ctx, "keep_alive": a.keep_alive} if ziel else {"live": True},
            "entladungen": stand["entladungen"], "entlade_gruende": dict(stand.get("entlade_gruende") or {}),
            "pausen_s": dict(pausen), "waechter_ausloeser": dict(waechter.ausloeser),
            "oom_kill": (oom_ende - oom_start) if (oom_start is not None and oom_ende is not None) else None,
        }
        laeufe = aus / "laeufe.jsonl"
        with open(laeufe, "a", encoding="utf-8") as f:
            f.write(json.dumps(lauf_info, ensure_ascii=False) + "\n")
        sp.schliessen()
        archiv.schliessen()
        llm.schliessen()
        if ziel is not None:
            ziel.schliessen()
        log.info("Lauf %s Ende: %s, %d Dokumente gerechnet", a.name, grund_ende, gerechnet)
    return 0


# --- Auswertung -----------------------------------------------------------------------------------------------------

GRUPPEN = {
    "art": ("dokumentart",), "unterart": ("unterart",), "zweck": ("zweck",), "beteiligte": ("beteiligte",),
    "bezug_status": ("bezug", "status"), "datum_zeitraum": ("datum", "zeitraum"),
}


def _median(w: list[float]) -> float | None:
    return round(statistics.median(w), 1) if w else None


def _q(w: list[float], p: float) -> float | None:
    if not w:
        return None
    s = sorted(w)
    return round(s[min(len(s) - 1, int(p * len(s)))], 1)


def _anteil(z: int, n: int) -> float | None:
    return round(100.0 * z / n, 1) if n else None


def _woerter(s: str) -> set[str]:
    from app import ablageregeln as ar

    return {w for w in ar.woerter(s or "") if len(w) >= 3}


def _jaccard(a: set, b: set) -> float | None:
    if not a and not b:
        return None
    return len(a & b) / len(a | b)


def lies_ergebnisse(pfad: Path) -> dict[str, dict]:
    aus: dict[str, dict] = {}
    if not pfad.exists():
        return aus
    for zeile in pfad.read_text(encoding="utf-8").splitlines():
        try:
            e = json.loads(zeile)
        except ValueError:
            continue
        # letzte vollständige Zeile je Dokument zählt (Wiederaufnahme nach Fehler)
        if e["id"] not in aus or not e.get("fehler"):
            aus[e["id"]] = e
    return aus


def kennzahlen(erg: dict[str, dict], ids: list[str], auswahl: dict[str, dict]) -> dict[str, Any]:  # noqa: C901
    zeilen = [erg[i] for i in ids if i in erg]
    ok = [e for e in zeilen if not e.get("fehler")]
    k: dict[str, Any] = {"dokumente": len(zeilen), "ohne_fehler": len(ok),
                         "fehler": dict(Counter(e["fehler"]["art"] for e in zeilen if e.get("fehler"))),
                         "abbrueche": dict(Counter(x["art"] for e in zeilen for x in e.get("abbrueche", []))),
                         "wiederholt": sum(1 for e in zeilen if e.get("wiederholt")),
                         "oom_kill": sum(e.get("oom_kill", 0) for e in zeilen)}
    # Dauer
    b_ms = [e["beschrieb_ms"] for e in ok if e.get("beschrieb_ms") is not None]
    je_teil = [e["beschrieb_ms"] / max(1, e["teile"]) for e in ok if e.get("beschrieb_ms") is not None]
    je_seite = [e["beschrieb_ms"] / e["seiten"] for e in ok if e.get("beschrieb_ms") is not None and e.get("seiten")]
    lade = [x.get("lade_ms") or 0 for e in ok for x in e.get("beschrieb_aufrufe", []) + (e.get("fristen") or {}).get("aufrufe", [])]
    b_aufrufe = [x for e in ok for x in e.get("beschrieb_aufrufe", [])]
    f_aufrufe = [x for e in ok for x in (e.get("fristen") or {}).get("aufrufe", [])]
    f_ms = [e["fristen"]["ms"] for e in ok if e.get("fristen") and e["fristen"].get("aufrufe")]

    def tok_s(aufrufe: list[dict], tok: str, ms: str) -> float | None:
        t = sum(x.get(tok) or 0 for x in aufrufe)
        m = sum(x.get(ms) or 0 for x in aufrufe)
        return round(t / (m / 1000), 1) if m else None

    k["dauer"] = {
        "beschrieb_ms_median": _median(b_ms), "beschrieb_ms_p90": _q(b_ms, 0.9), "beschrieb_ms_max": max(b_ms) if b_ms else None,
        "beschrieb_ms_summe": sum(b_ms), "je_teil_ms_median": _median(je_teil), "je_seite_ms_median": _median(je_seite),
        "dokumente_mit_seiten": len(je_seite),
        "beschrieb_ohne_laden_ms_median": _median([e["beschrieb_ms"] - sum(x.get("lade_ms") or 0 for x in e.get("beschrieb_aufrufe", []))
                                                   for e in ok if e.get("beschrieb_ms") is not None]),
        "fristen_ms_median": _median(f_ms), "fristen_ms_max": max(f_ms) if f_ms else None, "fristen_ms_summe": sum(f_ms),
        "fristen_mit_modell": len(f_ms),
        "laden_ms_summe": sum(lade), "ladungen": sum(1 for x in lade if x > 1000),
        "prompt_tok_s": tok_s(b_aufrufe + f_aufrufe, "prompt_tokens", "prompt_ms"),
        "antwort_tok_s": tok_s(b_aufrufe + f_aufrufe, "antwort_tokens", "antwort_ms"),
        "prompt_tokens_median_beschrieb": _median([x.get("prompt_tokens") or 0 for x in b_aufrufe]),
        "antwort_tokens_median_beschrieb": _median([x.get("antwort_tokens") or 0 for x in b_aufrufe]),
        "aufruf_ms_median_beschrieb": _median([x.get("dauer_ms") or 0 for x in b_aufrufe]),
        "aufruf_ms_median_fristen": _median([x.get("dauer_ms") or 0 for x in f_aufrufe]),
        "ctx_knapp": sum(1 for x in b_aufrufe + f_aufrufe if (x.get("prompt_tokens") or 0) >= (x.get("num_ctx") or 1 << 30) - 300),
    }
    # Vollständigkeit (gefilterter, zusammengeführter Beschrieb)
    voll = Counter()
    gruppen_n = []
    for e in ok:
        b = e.get("beschrieb") or {}
        n = 0
        for g, felder in GRUPPEN.items():
            if g == "beteiligte":
                da = bool(b.get("beteiligte"))
                if da and any(x.get("rolle") for x in b["beteiligte"]):
                    voll["beteiligte_mit_rolle"] += 1
            else:
                da = any(b.get(f) for f in felder)
            voll[g] += da
            n += da
        voll["titel"] += bool(b.get("titel"))
        voll["schlagworte"] += bool(b.get("schlagworte"))
        voll["personenbezogen"] += bool(b.get("personenbezogen"))
        gruppen_n.append(n)
    k["vollstaendigkeit_pct"] = {g: _anteil(voll[g], len(ok)) for g in (*GRUPPEN, "beteiligte_mit_rolle", "titel", "schlagworte")}
    k["vollstaendigkeit_gruppen_mittel"] = round(statistics.mean(gruppen_n), 2) if gruppen_n else None
    k["beteiligte_mittel"] = round(statistics.mean(len((e.get("beschrieb") or {}).get("beteiligte") or []) for e in ok), 2) if ok else None
    k["zweck_zeichen_median"] = _median([len((e.get("beschrieb") or {}).get("zweck") or "") for e in ok])
    # Filter / Erfindung (über alle Teile)
    tz = Counter()
    for e in ok:
        for c in e.get("teil_zaehler", []):
            tz.update(c)
    k["teil_zaehler"] = dict(sorted(tz.items()))
    geprueft = tz["namen_geprueft"] + (tz["datum_roh"] - tz["datum_ungueltig"]) + tz["status_roh"] + tz["jahre_roh"]
    erfunden = tz["namen_unbelegt"] + tz["datum_unbelegt"] + tz["status_unbelegt"] + tz["jahre_unbelegt"]
    k["erfindung"] = {
        "angaben_geprueft": geprueft, "unbelegt": erfunden, "quote_pct": _anteil(erfunden, geprueft),
        "namen": f"{tz['namen_unbelegt']}/{tz['namen_geprueft']}", "namen_pct": _anteil(tz["namen_unbelegt"], tz["namen_geprueft"]),
        "namen_streng_pct": _anteil(tz["namen_unbelegt_streng"], tz["namen_geprueft"]),
        "datum": f"{tz['datum_unbelegt']}/{tz['datum_roh'] - tz['datum_ungueltig']}", "datum_ungueltig": tz["datum_ungueltig"],
        "status": f"{tz['status_unbelegt']}/{tz['status_roh']}", "jahre": f"{tz['jahre_unbelegt']}/{tz['jahre_roh']}",
    }
    teile_n = sum(len(e.get("teil_zaehler", [])) for e in ok)
    k["filter"] = {
        "teile": teile_n, "eingriffe_sensibel": tz["filter_sensibel"],
        "eingriffe_je_teil": round(tz["filter_sensibel"] / teile_n, 2) if teile_n else None,
        "teile_mit_eingriff_pct": _anteil(sum(1 for e in ok for c in e.get("teil_zaehler", []) if c.get("filter_sensibel")), teile_n),
        "unbelegt_entfernt": tz["namen_unbelegt"] + tz["datum_unbelegt"] + tz["status_unbelegt"],
        "zitate": tz["zitat_gefunden"],
        "nach_feld": {f[len("filter_sensibel_"):]: v for f, v in tz.items() if f.startswith("filter_sensibel_")},
    }
    # Fristen
    fz = Counter()
    fr_docs = [e for e in ok if e.get("fristen")]
    for e in fr_docs:
        fz.update({kk: v for kk, v in e["fristen"]["zaehler"].items() if isinstance(v, int)})
    status = Counter(e["fristen"]["status"] for e in fr_docs)
    angenommen = [x for e in fr_docs for x in e["fristen"]["fristen"]]

    def mit_wort(e: dict, x: dict) -> bool:
        return x["sicherheit"] == ("mittel" if e["ocr"] else "hoch")

    k["fristen"] = {
        "dokumente": len(fr_docs), "status": dict(status), "roh": fz["roh"], "angenommen": len(angenommen),
        "erfunden_verworfen": fz["erfunden"], "unvollstaendig": fz["unvollstaendig"], "ungueltig": fz["ungueltig"] + fz["ungueltig_zahl"],
        "leer": fz["leer"], "doppelt": fz["doppelt"] + fz["doppelt_teile"],
        "datum_unlesbar": fz["datum_unlesbar"], "frist_ohne_einheit": fz["frist_ohne_einheit"],
        "mit_schluesselwort": sum(1 for e in fr_docs for x in e["fristen"]["fristen"] if mit_wort(e, x)),
        "dokumente_mit_frist": sum(1 for e in fr_docs if e["fristen"]["fristen"]),
        "arten": dict(Counter(x["art"] for x in angenommen)),
        "sicherheit": dict(Counter(x["sicherheit"] for x in angenommen)),
        "erfindungsquote_roh_pct": _anteil(fz["erfunden"], fz["roh"]),
        "partei_gesetzt": sum(1 for e in fr_docs if e["fristen"].get("partei")),
    }
    return k


def _frist_schluessel(x: dict) -> str:
    return json.dumps({"art": x["art"], **x["bedingungen"]}, sort_keys=True, ensure_ascii=False)


def _frist_kern(x: dict) -> str:
    b = x["bedingungen"]
    return f"{x['art']}|{b.get('faellig') or b.get('ende') or ''}"


def vergleich(g3: dict[str, dict], g4: dict[str, dict], ids: list[str]) -> dict[str, Any]:
    paare = [(g3[i], g4[i]) for i in ids if i in g3 and i in g4 and not g3[i].get("fehler") and not g4[i].get("fehler")]
    v: dict[str, Any] = {"paare": len(paare)}
    gleich = Counter()
    jac_beteiligte, jac_art, jac_schlag, jac_zweck = [], [], [], []
    for x, y in paare:
        bx, by = x.get("beschrieb") or {}, y.get("beschrieb") or {}
        gleich["typ"] += bx.get("typ") == by.get("typ")
        gleich["dokumentart_gleich"] += (bx.get("dokumentart") or "").lower() == (by.get("dokumentart") or "").lower()
        gleich["status_gleich_inkl_leer"] += (bx.get("status") or "") == (by.get("status") or "")
        gleich["datum_gleich_inkl_leer"] += (bx.get("datum") or "") == (by.get("datum") or "")
        gleich["beide_datum"] += bool(bx.get("datum")) and bool(by.get("datum"))
        gleich["beide_datum_gleich"] += bool(bx.get("datum")) and bx.get("datum") == by.get("datum")
        gleich["personenbezogen_gleich"] += bool(bx.get("personenbezogen")) == bool(by.get("personenbezogen"))
        nx = {" ".join(sorted(_woerter(p["name"]))) for p in bx.get("beteiligte") or []}
        ny = {" ".join(sorted(_woerter(p["name"]))) for p in by.get("beteiligte") or []}
        j = _jaccard(nx, ny)
        if j is not None:
            jac_beteiligte.append(j)
        for liste, fx, fy in ((jac_art, _woerter(f"{bx.get('dokumentart', '')} {bx.get('unterart', '')}"),
                               _woerter(f"{by.get('dokumentart', '')} {by.get('unterart', '')}")),
                              (jac_schlag, {w.lower() for w in bx.get("schlagworte") or []}, {w.lower() for w in by.get("schlagworte") or []}),
                              (jac_zweck, _woerter(bx.get("zweck", "")), _woerter(by.get("zweck", "")))):
            j = _jaccard(fx, fy)
            if j is not None:
                liste.append(j)
    n = len(paare)
    v["beschrieb"] = {
        "typ_gleich_pct": _anteil(gleich["typ"], n), "dokumentart_gleich_pct": _anteil(gleich["dokumentart_gleich"], n),
        "status_gleich_pct": _anteil(gleich["status_gleich_inkl_leer"], n),
        "datum_gleich_pct": _anteil(gleich["datum_gleich_inkl_leer"], n),
        "beide_mit_datum": gleich["beide_datum"], "davon_gleich": gleich["beide_datum_gleich"],
        "personenbezogen_gleich_pct": _anteil(gleich["personenbezogen_gleich"], n),
        "beteiligte_jaccard_mittel": round(statistics.mean(jac_beteiligte), 2) if jac_beteiligte else None,
        "art_unterart_wortjaccard_mittel": round(statistics.mean(jac_art), 2) if jac_art else None,
        "schlagworte_jaccard_mittel": round(statistics.mean(jac_schlag), 2) if jac_schlag else None,
        "zweck_wortjaccard_mittel": round(statistics.mean(jac_zweck), 2) if jac_zweck else None,
    }
    fx_all, fy_all, kern_gleich, exakt_gleich, docs_beide, docs_nur3, docs_nur4 = 0, 0, 0, 0, 0, 0, 0
    for x, y in paare:
        fx = (x.get("fristen") or {}).get("fristen") or []
        fy = (y.get("fristen") or {}).get("fristen") or []
        fx_all += len(fx)
        fy_all += len(fy)
        sx, sy = {_frist_schluessel(f) for f in fx}, {_frist_schluessel(f) for f in fy}
        kx, ky = {_frist_kern(f) for f in fx}, {_frist_kern(f) for f in fy}
        exakt_gleich += len(sx & sy)
        kern_gleich += len(kx & ky)
        docs_beide += bool(fx) and bool(fy)
        docs_nur3 += bool(fx) and not fy
        docs_nur4 += bool(fy) and not fx
    v["fristen"] = {"g3": fx_all, "g4": fy_all, "exakt_gleich": exakt_gleich, "kern_gleich": kern_gleich,
                    "dokumente_beide": docs_beide, "dokumente_nur_g3": docs_nur3, "dokumente_nur_g4": docs_nur4}
    return v


def speicher_auswerten(pfad: Path, von: str | None, bis: str | None) -> dict[str, Any]:
    if not pfad.exists():
        return {}
    import csv

    zeilen = []
    with open(pfad, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if von and r["zeit"] < von[:19]:
                continue
            if bis and r["zeit"] > bis[:19]:
                continue
            zeilen.append(r)

    def werte(sp: str) -> list[float]:
        # Bis Build des Laufs g3/g4 (15.10.) schrieb der Wächter PSI «0» als leeres Feld — dort leer = 0.
        null_wenn_leer = sp in ("psi_mem_some10", "psi_cpu_some10")
        aus = []
        for r in zeilen:
            try:
                aus.append(float(r[sp]) if (r.get(sp) or not null_wenn_leer) else 0.0)
            except (ValueError, KeyError, TypeError):
                pass
        return aus

    def mx(sp: str) -> float | None:
        w = werte(sp)
        return round(max(w), 2) if w else None

    def mn(sp: str) -> float | None:
        w = werte(sp)
        return round(min(w), 2) if w else None

    sw = werte("slice_swap_gib")
    maj = werte("pgmajfault")
    raten = [max(0.0, (b - a_) / 2.0) for a_, b in zip(maj, maj[1:])]
    return {
        "messpunkte": len(zeilen), "mem_available_min_gib": mn("mem_available_gib"), "swap_free_min_gib": mn("swap_free_gib"),
        "slice_max_gib": mx("slice_gib"), "slice_nicht_rueck_max_gib": mx("slice_nicht_rueck_gib"),
        "slice_swap_start_gib": round(sw[0], 2) if sw else None, "slice_swap_max_gib": round(max(sw), 2) if sw else None,
        "psi_mem_full10_max": mx("psi_mem_full10"), "psi_mem_some10_max": mx("psi_mem_some10"),
        "psi_cpu_some10_max": mx("psi_cpu_some10"), "pgmajfault_max_pro_s": round(max(raten), 1) if raten else None,
        "g_anon_max_gib": mx("g_anon_gib"), "s_anon_max_gib": mx("s_anon_gib"), "s_swap_max_gib": mx("s_swap_gib"),
        "vram_frei_min_mb": mn("vram_frei_mb"),
        "ausloeser": dict(Counter(r["grund"] for r in zeilen if r.get("grund") and r.get("scharf") == "1")),
    }


def cmd_auswerten(a: argparse.Namespace) -> int:
    app_laden(a.app_pfad)
    aus = Path(a.ausgabe)
    auswahl = {d["id"]: d for d in lies_json(aus / "auswahl.json")["dokumente"]}
    ids = sorted(auswahl)
    g3 = lies_ergebnisse(aus / f"ergebnisse-{a.name_a}.jsonl")
    g4 = lies_ergebnisse(aus / f"ergebnisse-{a.name_b}.jsonl")
    beide = [i for i in ids if i in g3 and i in g4 and not g3[i].get("fehler") and not g4[i].get("fehler")]
    laeufe = []
    if (aus / "laeufe.jsonl").exists():
        laeufe = [json.loads(z) for z in (aus / "laeufe.jsonl").read_text(encoding="utf-8").splitlines() if z.strip()]
    bericht: dict[str, Any] = {
        "erstellt": jetzt().isoformat(), "stichprobe": len(ids), "beide_ohne_fehler": len(beide),
        "a": {"name": a.name_a, "alle": kennzahlen(g3, ids, auswahl), "gemeinsam": kennzahlen(g3, beide, auswahl)},
        "b": {"name": a.name_b, "alle": kennzahlen(g4, ids, auswahl), "gemeinsam": kennzahlen(g4, beide, auswahl)},
        "vergleich": vergleich(g3, g4, ids),
        "laeufe": laeufe,
    }
    for seite, name in (("a", a.name_a), ("b", a.name_b)):
        zl = [e for e in (g3 if seite == "a" else g4).values()]
        von = min((e["start"] for e in zl), default=None)
        bis = max((e.get("ende") or e["start"] for e in zl), default=None)
        bericht[seite]["speicher"] = speicher_auswerten(aus / f"speicher-{name}.csv", von, bis)
    schreibe_json(aus / "bericht.json", bericht)
    # Blind-Paare (A/B zufällig, Seed fest) — nur gefilterte Beschriebe + Dateiname (+ Ablageort in ZZ wie im Prompt)
    from app import ablageregeln as ar

    (aus / "blind").mkdir(exist_ok=True)
    zufall = random.Random(a.seed)
    schluessel: dict[str, dict[str, str]] = {}
    with open(aus / "blind" / "paare.jsonl", "w", encoding="utf-8") as f:
        for n, i in enumerate(beide, start=1):
            d = auswahl[i]
            seiten = [(a.name_a, g3[i]["beschrieb"]), (a.name_b, g4[i]["beschrieb"])]
            zufall.shuffle(seiten)
            pid = f"p{n:02d}"
            schluessel[pid] = {"A": seiten[0][0], "B": seiten[1][0], "id": i}
            weg = {"seiten", "ocr", "dateityp", "teile", "gelesen", "typ"}
            f.write(json.dumps({
                "paar": pid, "dateiname": d["name"], "ablageort_zz": "/".join(ar.herkunft_segmente(d["pfad"])) or None,
                "A": {k: v for k, v in seiten[0][1].items() if k not in weg},
                "B": {k: v for k, v in seiten[1][1].items() if k not in weg},
            }, ensure_ascii=False) + "\n")
    schreibe_json(aus / "blind" / "schluessel.json", schluessel)
    print(json.dumps({"stichprobe": len(ids), "a": len(g3), "b": len(g4), "beide": len(beide)}, ensure_ascii=False))
    return 0


def cmd_paare(a: argparse.Namespace) -> int:
    aus = Path(a.ausgabe)
    for zeile in (aus / "blind" / "paare.jsonl").read_text(encoding="utf-8").splitlines():
        p = json.loads(zeile)
        print(f"=== {p['paar']} · Datei: {p['dateiname']}" + (f" · ZZ-Ort: {p['ablageort_zz']}" if p["ablageort_zz"] else ""))
        for s in ("A", "B"):
            b = p[s]
            teile = []
            for k_, v in b.items():
                if k_ == "beteiligte":
                    v = "; ".join(f"{x['name']} ({x.get('rolle') or '-'})" for x in v)
                elif isinstance(v, list):
                    v = ", ".join(map(str, v))
                teile.append(f"{k_}={v}")
            print(f"  {s}: " + " | ".join(teile))
    return 0


def cmd_urteil(a: argparse.Namespace) -> int:
    aus = Path(a.ausgabe)
    schluessel = lies_json(aus / "blind" / "schluessel.json")
    urteile = lies_json(aus / "blind" / "urteile.json")
    z = Counter()
    je_schicht: dict[str, Counter] = {}
    auswahl = {d["id"]: d for d in lies_json(aus / "auswahl.json")["dokumente"]}
    for pid, wahl in urteile.items():
        if pid not in schluessel:
            continue
        sieger = schluessel[pid].get(wahl) if wahl in ("A", "B") else "gleich"
        z[sieger] += 1
        sch = auswahl[schluessel[pid]["id"]]["schicht"]
        je_schicht.setdefault(sch, Counter())[sieger] += 1
    n = sum(z.values())
    aus_d = {"paare": n, "stimmen": dict(z), "pct": {k: _anteil(v, n) for k, v in z.items()},
             "je_schicht": {k: dict(v) for k, v in je_schicht.items()}}
    schreibe_json(aus / "blind" / "ergebnis.json", aus_d)
    print(json.dumps(aus_d, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="beschrieb_fristen_vergleich", description=__doc__.split("\n")[0])
    p.add_argument("--ausgabe", default=AUSGABE_STANDARD)
    p.add_argument("--app-pfad", default="/srv/app")
    sub = p.add_subparsers(dest="befehl", required=True)
    s = sub.add_parser("auswahl")
    s.add_argument("--seed", type=int, default=SEED_STANDARD)
    s.add_argument("--anzahl", type=int, default=40)
    s.add_argument("--kontext", default=KONTEXT_DATEI)
    s.add_argument("--neu", action="store_true")
    s = sub.add_parser("lauf")
    s.add_argument("--name", required=True, help="Kurzname des Laufs (Dateinamen), z. B. g3 / g4")
    s.add_argument("--modell", required=True)
    s.add_argument("--gruendlich", action="store_true", help="an die Instanz «gruendlich» (Prozessor), gestreamt")
    s.add_argument("--gruendlich-id", help="Container-ID von eventline-ki-ollama-gruendlich (Speicher im Slice)")
    s.add_argument("--schnell-id", help="Container-ID von eventline-ki-ollama (nur Messung)")
    s.add_argument("--num-thread", type=int, default=10)
    s.add_argument("--num-ctx", type=int, default=16384)
    s.add_argument("--keep-alive", default="15m")
    s.add_argument("--frist-s", type=float, default=900.0)
    s.add_argument("--cache-gib", type=float, default=1.5)
    s.add_argument("--anon-max-gib", type=float, default=18.0)
    s.add_argument("--puffer-gb", type=float, default=2.0)
    s.add_argument("--tor-s", type=float, default=60.0)
    s.add_argument("--pause-s", type=int, default=600)
    s.add_argument("--stopp", default="05:15", help="ab dann kein neues Dokument")
    s.add_argument("--hart", default="06:20", help="ab dann Abbruch (auch mitten im Dokument)")
    s.add_argument("--sperre", default="05:25-05:50", help="Sperrfenster HH:MM-HH:MM (Selbsttest)")
    s.add_argument("--health-url", default=HEALTH_STANDARD)
    s.add_argument("--max", type=int, default=0)
    s.add_argument("--nur", nargs="*")
    s.add_argument("--fehler-ueberspringen", action="store_true", help="Dokumente mit Fehler nicht wiederholen")
    s = sub.add_parser("auswerten")
    s.add_argument("--name-a", default="g3")
    s.add_argument("--name-b", default="g4")
    s.add_argument("--seed", type=int, default=SEED_STANDARD)
    sub.add_parser("paare")
    sub.add_parser("urteil")
    a = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    return {"auswahl": cmd_auswahl, "lauf": cmd_lauf, "auswerten": cmd_auswerten, "paare": cmd_paare,
            "urteil": cmd_urteil}[a.befehl](a)


if __name__ == "__main__":
    sys.exit(main())
