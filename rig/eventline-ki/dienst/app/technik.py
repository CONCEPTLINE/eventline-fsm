"""Technik-Melder (Technik-Dashboard, docs/technik-dashboard/VERTRAG.md §1.2): jede Minute ein Paket ans FSM.

Liest die Datei des Technik-Sammlers auf dem Host (/data/technik/stand.json, Blöcke «rig» und «nas»), ergänzt den
Block «ki» (beide Ollama-Instanzen nur über /api/ps, /api/tags, /api/version — nie etwas, das ein Modell lädt —,
dazu laufender Auftrag, Warteschlange, Archiv- und Tiefen-Index, Schalter, Tempo der letzten Antwort) und sendet
alles als POST /api/technik/messwerte mit der Rig-Anmeldung (KI_SYNC_TOKEN) über den Ausgang (egress).

Fehlt die Datei oder ist sie kaputt, fehlen nur «rig»/«nas» — der Melder bricht nie ab. Solange das FSM die Route
noch nicht kennt (404/405/501), wird still im Takt weiterversucht; geloggt wird nur ein Wechsel des Zustands und
nur der Statuscode (keine Log-Flut, keine Inhalte). Alte Pakete werden nie nachgesendet. Es hängt nichts am
2-s-Herzschlag /api/ki/sync.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import httpx

from . import VERSION
from .config import Einstellungen
from .llm import letztes_tempo

log = logging.getLogger("ki.technik")

TAKT_S = 60.0
ERSTER_VERSUCH_S = 15.0
OLLAMA_ZEITLIMIT_S = 3.0
SENDE_ZEITLIMIT_S = 15.0
PFAD = "/api/technik/messwerte"
# Älter als das sendet der Melder nicht (Sammler steht): das FSM sieht dann am Alter des letzten Stands, dass die
# Messwerte veraltet sind — ein immer gleiches Paket nachzuschieben, brächte nichts.
MAX_ALTER_S = 900
MAX_DATEI_B = 256 * 1024
MAX_PAKET_B = 60 * 1024  # FSM nimmt höchstens 64 KiB an

MODELLNAME = re.compile(r"^[a-z0-9][a-z0-9._:/-]{0,79}$", re.I)
VERSION_TEXT = re.compile(r"^[0-9][0-9a-z.+-]{0,39}$", re.I)
_ZEIT = re.compile(r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$")
DIENST_INSTANZ = {"ollama_schnell": "schnell", "ollama_gruendlich": "gruendlich"}


# --- Reine Helfer (getestet) -----------------------------------------------------------------------------------


def utc_iso(t: datetime | None = None) -> str:
    return (t or datetime.now(timezone.utc)).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def als_zeit(text: Any) -> datetime | None:
    """ISO-Zeit mit Zone (auch Ollamas Nanosekunden, «Z» oder «+02:00») → aware datetime. Ohne Zone: None."""
    if not isinstance(text, str):
        return None
    m = _ZEIT.match(text.strip())
    if not m or not m.group(3):
        return None
    zone = m.group(3)
    if zone == "Z":
        zone = "+00:00"
    elif ":" not in zone:
        zone = zone[:3] + ":" + zone[3:]
    try:
        return datetime.fromisoformat(f"{m.group(1)}T{m.group(2)}{zone}")
    except ValueError:
        return None


def zu_utc(text: Any) -> str | None:
    t = als_zeit(text)
    return utc_iso(t) if t is not None else None


def ganzzahl(wert: Any) -> int | None:
    if isinstance(wert, bool) or not isinstance(wert, (int, float)) or wert != wert or wert < 0:
        return None
    return int(wert)


def lies_sammler(pfad: Path, jetzt: datetime | None = None) -> dict[str, Any]:
    """Blöcke «rig» und «nas» aus der Sammler-Datei. Fehlt/kaputt/zu alt → leer bzw. ohne den Block."""
    jetzt = jetzt or datetime.now(timezone.utc)
    try:
        with open(pfad, "rb") as f:
            roh = f.read(MAX_DATEI_B + 1)
    except OSError:
        return {}
    if len(roh) > MAX_DATEI_B:
        return {}
    try:
        daten = json.loads(roh)
    except ValueError:
        return {}
    if not isinstance(daten, dict):
        return {}
    ergebnis: dict[str, Any] = {}
    for block in ("rig", "nas"):
        wert = daten.get(block)
        if not isinstance(wert, dict):
            continue
        gemessen = als_zeit(wert.get("gemessen_am"))
        if gemessen is None or (jetzt - gemessen).total_seconds() > MAX_ALTER_S:
            continue
        ergebnis[block] = wert
    return ergebnis


def _liste(antwort: Any, schluessel: str) -> list[Any]:
    wert = antwort.get(schluessel) if isinstance(antwort, dict) else None
    return wert if isinstance(wert, list) else []


def ollama_auswerten(name: str, version: Any, tags: Any, ps: Any, jetzt: datetime | None = None) -> dict[str, Any]:
    """Antworten einer Ollama-Instanz → {instanz, modelle, geladen}. Nur Namen, die der Weißliste genügen."""
    jetzt = jetzt or datetime.now(timezone.utc)
    erreichbar = isinstance(version, dict) and isinstance(version.get("version"), str)
    instanz: dict[str, Any] = {"name": name, "erreichbar": erreichbar}
    if erreichbar and VERSION_TEXT.match(version["version"]):
        instanz["version"] = version["version"]
    modelle = []
    for m in _liste(tags, "models"):
        if isinstance(m, dict) and isinstance(m.get("name"), str) and MODELLNAME.match(m["name"]):
            groesse = ganzzahl(m.get("size"))
            if groesse is not None:
                modelle.append({"name": m["name"], "groesse_b": groesse})
    geladen = []
    for m in _liste(ps, "models"):
        if not (isinstance(m, dict) and isinstance(m.get("name"), str) and MODELLNAME.match(m["name"])):
            continue
        eintrag: dict[str, Any] = {"name": m["name"], "instanz": name, "groesse_b": ganzzahl(m.get("size")) or 0,
                                   "vram_b": ganzzahl(m.get("size_vram")) or 0}
        ende = als_zeit(m.get("expires_at"))
        # keep_alive -1 ergibt ein Datum Jahrhunderte voraus — das ist «bleibt geladen», kein Zeitpunkt.
        if ende is not None and jetzt <= ende <= jetzt + timedelta(days=2):
            eintrag["entlaedt_am"] = utc_iso(ende)
        geladen.append(eintrag)
    return {"instanz": instanz, "modelle": modelle, "geladen": geladen}


def ki_block(
    cfg: Einstellungen,
    gesundheit: dict[str, Any],
    ollama: list[dict[str, Any]],
    *,
    auftrag: dict[str, Any] | None,
    tempo: dict[str, Any] | None,
    fsm_antwort_ms: int | None,
    fsm_fehler_in_folge: int,
    grenzen: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Block «ki» aus dem eigenen Zustand (/health-Bild), den Ollama-Antworten und den Sendezählern."""
    modelle: dict[str, int] = {}
    for o in ollama:
        for m in o["modelle"]:
            modelle.setdefault(m["name"], m["groesse_b"])
    instanzen = []
    for o in ollama:
        inst = dict(o["instanz"])
        if grenzen and grenzen.get(inst["name"]):
            inst["grenze_b"] = grenzen[inst["name"]]
        instanzen.append(inst)
    block: dict[str, Any] = {
        "version": f"{VERSION}+{cfg.build}",
        "instanzen": instanzen,
        "modelle": [{"name": n, "groesse_b": g} for n, g in sorted(modelle.items())][:50],
        "geladen": [m for o in ollama for m in o["geladen"]][:10],
        "auftrag": auftrag,
        "tempo": tempo,
        "schalter": {
            "suche": cfg.suche_aktiv, "archiv_frage": cfg.archiv_frage_aktiv, "hintergrund": cfg.hg_aktiv,
            "lernen": cfg.lernen_aktiv, "tiefe": cfg.tiefe_aktiv, "hauptmodell": cfg.hg_aktiv and bool(cfg.hg_modelle),
        },
        "fsm_antwort_ms": fsm_antwort_ms,
        "fsm_fehler_in_folge": fsm_fehler_in_folge,
    }
    if MODELLNAME.match(cfg.modell_text or ""):
        block["eingestellt"] = cfg.modell_text
    ws = ganzzahl(gesundheit.get("warteschlange"))
    if ws is not None:
        block["warteschlange"] = ws
    archiv = gesundheit.get("archiv")
    if isinstance(archiv, dict) and archiv.get("aktiv"):
        bilanz = archiv.get("letzte_bilanz") if isinstance(archiv.get("letzte_bilanz"), dict) else {}
        block["archiv"] = {k: v for k, v in {
            "anzahl": ganzzahl(archiv.get("anzahl")),
            "letzter_lauf": zu_utc(archiv.get("letzter_lauf")),
            "neu": ganzzahl(bilanz.get("neu")),
            "fehler": ganzzahl(bilanz.get("fehler")),
            "dauer_s": round(float(bilanz["dauer_s"]), 1) if isinstance(bilanz.get("dauer_s"), (int, float)) else None,
        }.items() if v is not None}
    tiefe = gesundheit.get("tiefe")
    if isinstance(tiefe, dict) and tiefe.get("aktiv"):
        nacht = tiefe.get("nacht") if isinstance(tiefe.get("nacht"), dict) else {}
        block["tiefen_index"] = {k: v for k, v in {
            "dateien": ganzzahl(tiefe.get("dateien")),
            "nas_dateien": ganzzahl(tiefe.get("nas_dateien")),
            "mit_text": ganzzahl(tiefe.get("mit_text")),
            "abschnitte": ganzzahl(tiefe.get("abschnitte")),
            "letzter_lauf": zu_utc(tiefe.get("letzter_lauf")),
            "nacht_fertig": nacht.get("fertig") if isinstance(nacht.get("fertig"), bool) else None,
        }.items() if v is not None}
    hg = gesundheit.get("hintergrund")
    block["hauptmodell_geladen"] = bool(isinstance(hg, dict) and hg.get("geladen"))
    return block


def paket_bauen(sammler: dict[str, Any], ki: dict[str, Any] | None, jetzt: datetime | None = None) -> dict[str, Any]:
    paket: dict[str, Any] = {"v": 1, "gesendet_am": utc_iso(jetzt)}
    if "rig" in sammler:
        paket["rig"] = sammler["rig"]
    if ki is not None:
        paket["ki"] = ki
    if "nas" in sammler:
        paket["nas"] = sammler["nas"]
    return paket


def kodieren(paket: dict[str, Any]) -> bytes:
    """JSON unter 60 KiB. Zu gross (sollte nie vorkommen) → erst Modellliste, dann Dienste, dann Minutenwerte weg."""
    roh = json.dumps(paket, separators=(",", ":"), ensure_ascii=False).encode()
    for kuerzen in (("ki", "modelle"), ("rig", "dienste"), ("rig", "minute"), ("rig", "ram")):
        if len(roh) <= MAX_PAKET_B:
            break
        block = paket.get(kuerzen[0])
        if isinstance(block, dict):
            block.pop(kuerzen[1], None)
        roh = json.dumps(paket, separators=(",", ":"), ensure_ascii=False).encode()
    return roh


def grenzen_aus(rig: dict[str, Any] | None) -> dict[str, int]:
    """Speicherdeckel der Ollama-Container (vom Sammler) → je Instanz."""
    grenzen: dict[str, int] = {}
    for d in (rig or {}).get("dienste") or []:
        if isinstance(d, dict) and d.get("name") in DIENST_INSTANZ and isinstance(d.get("grenze_b"), int):
            grenzen[DIENST_INSTANZ[d["name"]]] = d["grenze_b"]
    return grenzen


# --- Melder-Thread -------------------------------------------------------------------------------------------------


class TechnikMelder(threading.Thread):
    def __init__(self, cfg: Einstellungen, auftrag_art: Callable[[], str | None],
                 gesundheit: Callable[[], dict[str, Any]]) -> None:
        super().__init__(name="ki-technik", daemon=True)
        self.cfg = cfg
        self.auftrag_art = auftrag_art
        self.gesundheit = gesundheit
        self._halt = threading.Event()
        self._auftrag: tuple[str, str] | None = None  # (Art, seit ISO)
        self.fsm_antwort_ms: int | None = None
        self.fsm_fehler_in_folge = 0
        self._letzter_zustand: str | None = None
        self._fsm = httpx.Client(
            base_url=cfg.fsm_url,
            proxy=cfg.proxy,
            trust_env=False,
            timeout=httpx.Timeout(SENDE_ZEITLIMIT_S, connect=10.0),
            headers={
                "Authorization": f"Bearer {cfg.sync_token}",
                "User-Agent": f"eventline-ki/{VERSION}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        self._ollama = httpx.Client(trust_env=False, timeout=httpx.Timeout(OLLAMA_ZEITLIMIT_S))

    def stop(self) -> None:
        self._halt.set()

    def schliessen(self) -> None:
        self._fsm.close()
        self._ollama.close()

    # Laufender Auftrag: Art kommt vom Worker, «seit» merkt sich der Melder (Abtastung jede Sekunde).
    def _auftrag_verfolgen(self) -> None:
        try:
            art = self.auftrag_art()
        except Exception:  # noqa: BLE001
            art = None
        if not art:
            self._auftrag = None
        elif self._auftrag is None or self._auftrag[0] != art:
            self._auftrag = (art, utc_iso())

    def run(self) -> None:
        log.info("Technik-Melder gestartet — alle %d s an %s", TAKT_S, PFAD)
        naechster = time.monotonic() + ERSTER_VERSUCH_S
        while not self._halt.wait(1.0):
            self._auftrag_verfolgen()
            if time.monotonic() < naechster:
                continue
            naechster = time.monotonic() + TAKT_S
            try:
                self.einmal()
            except Exception as e:  # noqa: BLE001 — der Melder darf nie sterben
                self._zustand(f"Fehler {type(e).__name__}", warnung=True)

    def _ollama_frage(self, basis: str, pfad: str) -> Any:
        try:
            r = self._ollama.get(f"{basis}{pfad}")
            return r.json() if r.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            return None

    def ollama(self) -> list[dict[str, Any]]:
        ergebnisse = []
        for name, basis in (("schnell", self.cfg.ollama_url), ("gruendlich", self.cfg.hg_url)):
            version = self._ollama_frage(basis, "/api/version")
            tags = self._ollama_frage(basis, "/api/tags") if version is not None else None
            ps = self._ollama_frage(basis, "/api/ps") if version is not None else None
            ergebnisse.append(ollama_auswerten(name, version, tags, ps))
        return ergebnisse

    def paket(self) -> dict[str, Any]:
        sammler = lies_sammler(self.cfg.technik_datei)
        try:
            gesundheit = self.gesundheit() or {}
        except Exception:  # noqa: BLE001 — ohne eigenen Zustand trotzdem senden
            gesundheit = {}
        auftrag = None
        if self._auftrag is not None:
            auftrag = {"art": self._auftrag[0], "seit": self._auftrag[1]}
        ki = ki_block(
            self.cfg, gesundheit, self.ollama(),
            auftrag=auftrag, tempo=letztes_tempo(),
            fsm_antwort_ms=self.fsm_antwort_ms, fsm_fehler_in_folge=self.fsm_fehler_in_folge,
            grenzen=grenzen_aus(sammler.get("rig")),
        )
        return paket_bauen(sammler, ki)

    def einmal(self) -> int | None:
        """Ein Paket senden. Rückgabe: HTTP-Status oder None (Netzfehler)."""
        roh = kodieren(self.paket())
        start = time.monotonic()
        try:
            r = self._fsm.post(PFAD, content=roh)
        except httpx.HTTPError as e:
            self.fsm_fehler_in_folge += 1
            self.fsm_antwort_ms = None
            self._zustand(f"nicht zugestellt ({type(e).__name__})", warnung=True)
            return None
        dauer_ms = int((time.monotonic() - start) * 1000)
        if 200 <= r.status_code < 300:
            self.fsm_antwort_ms = dauer_ms
            self.fsm_fehler_in_folge = 0
            self._zustand("zugestellt")
        elif r.status_code in (404, 405, 501):
            # FSM-Route noch nicht live: still weiter versuchen (zählt nicht als Verbindungsfehler).
            self.fsm_antwort_ms = None
            self._zustand(f"FSM kennt die Route noch nicht (HTTP {r.status_code})")
        else:
            self.fsm_fehler_in_folge += 1
            self.fsm_antwort_ms = None
            self._zustand(f"FSM antwortet mit HTTP {r.status_code}", warnung=True)
        return r.status_code

    def _zustand(self, text: str, warnung: bool = False) -> None:
        """Nur Wechsel loggen — ein Dauerzustand erzeugt keine Zeile pro Minute."""
        if text == self._letzter_zustand:
            return
        self._letzter_zustand = text
        (log.warning if warnung else log.info)("Technik-Messwerte: %s", text)
