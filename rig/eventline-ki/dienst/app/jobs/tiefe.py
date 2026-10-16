"""Planer-Thread des Tiefen-Index (Masterplan §2.3 Nacht-Reihenfolge, E2.5). Schalter KI_TIEFE_AKTIV.

Nachts (Planer: 19:00–07:00, ab 06:45 «vor_tag» nicht mehr) höchstens KI_TIEFE_MAX_H Stunden je Nacht-Fenster.
Tagsüber (seit 16.10.2026, mit KI_FREI_AKTIV — «die KI arbeitet, wenn sie etwas zu tun hat»): nach einem vollständigen
Durchgang alle KI_INDEX_TAG_ABSTAND_S (30 min) ein weiterer — gelesen werden nur neue und geänderte Dateien (16.10.:
449 Dateien ohne Neues in 1–2 s), so ist eine tagsüber abgelegte Datei bald durchsuchbar; Budget je Tag-Fenster wie
nachts. Gleiche Regeln wie nachts: nur bei Ruhe, nie neben dem geladenen Hauptmodell, der Vorbilder-Index zuerst.
Braucht das Hauptmodell nicht und läuft deshalb auch mit KI_HG_AKTIV=0. Reihenfolge der Nacht: der Vorbilder-Index
(archiv.py, nachts ab KI_INDEX_NACHT 19:05) hat Vorrang — läuft er, wartet der Tiefen-Index; der Hintergrund-Thread
des Hauptmodells lädt nicht, solange der Tiefen-Index läuft (main.py, vorarbeit_laeuft). Umgekehrt liest der
Tiefen-Index nicht, solange das Hauptmodell geladen ist oder lädt (z. B. in der 10-min-Pause nach einem
unvollständigen Durchgang geladen) — OCR und Einbettungen neben 16 GB machten den Extraktions-Kindprozess zum
OOM-Opfer. Aufträge vom FSM haben immer Vorrang (20 s Ruhe).

Stand je Fenster im Tresor (<KI_DATA_DIR>/tiefe-stand.json, nur Zahlen): verbrauchte Sekunden, «fertig» (ein
vollständiger Durchgang in dieser Nacht), Anzahl NAS-Dateien des letzten Durchgangs (für gelesen_anteil der Suche).
Ein Neustart in der Nacht setzt das Budget nicht zurück.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from ..config import Einstellungen
from ..planer import NACHT, TAG, Lage, Planer
from ..tiefe import TiefenIndexierer, nas_bereit

log = logging.getLogger("ki.tiefe")

STAND_DATEI = "tiefe-stand.json"
# Nach einem unvollständigen Durchgang (Freigabe fehlt, Bremse) so lange bis zum nächsten Versuch in derselben Nacht.
WIEDERHOLEN_S = 600.0


def jetzt_zuerich() -> datetime:
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo("Europe/Zurich"))
    except Exception:  # noqa: BLE001 — ohne Zeitzonendaten Ortszeit des Containers
        return datetime.now()


def lies_stand(datei: Path) -> dict[str, Any]:
    try:
        daten = json.loads(datei.read_text(encoding="utf-8"))
        return daten if isinstance(daten, dict) else {}
    except (OSError, ValueError):
        return {}


class TiefenJob(threading.Thread):
    def __init__(
        self,
        cfg: Einstellungen,
        indexierer: TiefenIndexierer,
        *,
        vorbilder_laeuft: Callable[[], bool] = lambda: False,
        hauptmodell_aktiv: Callable[[], bool] = lambda: False,
        uhr: Callable[[], datetime] = jetzt_zuerich,
        takt_s: float = 30.0,
        stand_datei: Path | None = None,
    ) -> None:
        super().__init__(name="ki-tiefe", daemon=True)
        self.cfg = cfg
        self.ix = indexierer
        self.vorbilder_laeuft = vorbilder_laeuft
        self.hauptmodell_aktiv = hauptmodell_aktiv
        self.uhr = uhr
        self.takt_s = takt_s
        self.planer = Planer.aus_cfg(cfg)
        self.stand_datei = stand_datei or (cfg.data_dir / STAND_DATEI)
        self._halt = threading.Event()
        self._naechster_versuch = 0.0
        self._nas_gemeldet = False
        self.stand: dict[str, Any] = lies_stand(self.stand_datei)

    @property
    def laeuft(self) -> bool:
        return self.ix.laeuft

    def stop(self) -> None:
        self._halt.set()
        self.ix.stop()

    def _speichern(self) -> None:
        try:
            self.stand_datei.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.stand_datei.with_suffix(".json.neu")
            tmp.write_text(json.dumps(self.stand), encoding="utf-8")
            tmp.replace(self.stand_datei)
        except OSError as e:
            log.warning("Tiefen-Index: Stand nicht gespeichert (%s)", type(e).__name__)

    def budget_s(self) -> float:
        return self.cfg.tiefe_max_h * 3600.0

    def _darf(self, lage: Lage) -> tuple[bool, str]:
        """Nachts im Planer-Fenster (ohne «vor_tag»), tagsüber mit KI_FREI_AKTIV."""
        if lage.modus == NACHT:
            return (True, NACHT) if lage.erlaubt else (False, lage.grund)
        return (True, TAG) if self.cfg.frei_aktiv else (False, "tag")

    def _wieder_dran(self, lage: Lage) -> bool:
        """Fertig in diesem Fenster — tagsüber nach KI_INDEX_TAG_ABSTAND_S trotzdem wieder (nur Neues wird gelesen)."""
        if lage.modus == NACHT:
            return False
        return time.time() - float(self.stand.get("fertig_um") or 0.0) >= self.cfg.index_tag_abstand_s

    def faellig(self) -> tuple[bool, str]:
        """(jetzt laufen?, Grund) — reine Zeit-/Budget-Prüfung, ohne Ruhe und NAS."""
        lage = self.planer.lage(self.uhr())
        ok, grund = self._darf(lage)
        if not ok:
            return False, grund
        if self.stand.get("fenster") != lage.fenster:
            self.stand = {"fenster": lage.fenster, "sekunden": 0.0, "fertig": False,
                          "nas_dateien": self.stand.get("nas_dateien"), "letzter_lauf": self.stand.get("letzter_lauf")}
            self._speichern()
        if self.stand.get("fertig") and not self._wieder_dran(lage):
            return False, "fertig"
        if float(self.stand.get("sekunden") or 0.0) >= self.budget_s():
            return False, "budget"
        if time.monotonic() < self._naechster_versuch:
            return False, "wiederholen"
        return True, grund

    def runde(self) -> str:
        """Eine Prüfung; startet bei Bedarf einen Durchgang. Liefert den Grund (für Tests und /health)."""
        ok, grund = self.faellig()
        if not ok:
            return grund
        if self.vorbilder_laeuft():
            return "vorbilder"
        if self.hauptmodell_aktiv():
            return "hauptmodell"
        if not self.ix.ruhig():
            return "vorrang"
        if not nas_bereit(self.ix.wurzel):
            if not self._nas_gemeldet:
                log.warning("Tiefen-Index wartet: keine lesbare Freigabe (NAS nicht gemountet?)")
                self._nas_gemeldet = True
            return "nas"
        self._nas_gemeldet = False
        rest = self.budget_s() - float(self.stand.get("sekunden") or 0.0)
        start = time.monotonic()

        def weiter() -> bool:
            lage = self.planer.lage(self.uhr())
            return self._darf(lage)[0] and lage.fenster == self.stand.get("fenster")

        try:
            b = self.ix.lauf(frist=start + rest, weiter=weiter)
        except Exception:  # noqa: BLE001 — der Thread darf nie sterben
            log.exception("Tiefen-Index: Lauf abgebrochen")
            self._naechster_versuch = time.monotonic() + WIEDERHOLEN_S
            return "fehler"
        self.stand["sekunden"] = round(float(self.stand.get("sekunden") or 0.0) + (time.monotonic() - start), 1)
        if b.nas_dateien:
            self.stand["nas_dateien"] = b.nas_dateien
        if b.vollstaendig:
            self.stand["fertig"] = True
            self.stand["fertig_um"] = time.time()
            self.stand["letzter_lauf"] = self.ix.letzter_lauf
        elif not b.frist_erreicht:
            self._naechster_versuch = time.monotonic() + WIEDERHOLEN_S
        self._speichern()
        return "gelaufen"

    def run(self) -> None:
        log.info("Tiefen-Index-Planer gestartet — je Fenster höchstens %.1f h, OCR bis %d Seiten; %s",
                 self.cfg.tiefe_max_h, self.cfg.tiefe_ocr_seiten,
                 f"tagsüber alle {self.cfg.index_tag_abstand_s // 60} min Neues" if self.cfg.frei_aktiv else "nur nachts")
        while not self._halt.wait(self.takt_s):
            try:
                self.runde()
            except Exception:  # noqa: BLE001 — der Thread darf nie sterben
                log.exception("Tiefen-Index-Planer: unerwarteter Fehler")

    def status(self) -> dict[str, Any]:
        """Für /health — nur Zahlen und Zeiten."""
        z = self.ix.index.zaehler(max_alter_s=30.0)
        nas = self.stand.get("nas_dateien")
        anteil = None
        if isinstance(nas, int) and nas > 0 and z:
            anteil = round(min(1.0, z.get("dateien", 0) / nas), 3)
        b = self.ix.letzte_bilanz
        return {
            "aktiv": True,
            "laeuft": self.ix.laeuft,
            **z,
            "nas_dateien": nas,
            "gelesen_anteil": anteil,
            "letzter_lauf": self.stand.get("letzter_lauf"),
            "nacht": {"fenster": self.stand.get("fenster"), "sekunden": self.stand.get("sekunden"),
                      "budget_s": int(self.budget_s()), "fertig": self.stand.get("fertig")},
            "letzte_bilanz": None if b is None else b.kurz(),
        }
