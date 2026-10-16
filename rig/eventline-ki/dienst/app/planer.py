"""Planer für das Hauptmodell (Masterplan §2.3, §2.4): Tag/Nacht, Modell-Leiter, Speicher-Tor am Stück,
Nachlade-Begrenzung, Pause nach dem Wächter, 24-h-Sperre nach OOM. Reine Logik ohne Ein-/Ausgabe — die Zeit
kommt immer von aussen (Wanduhr in Europe/Zurich für den Modus, monotonic für Dauern), damit die Tests die
Grenzen (06:59/07:00/18:59/19:00) und Fristen exakt prüfen können.

Modus:  NACHT 19:00–07:00 (KI_NACHT_START/KI_TAG_START), Hauptmodell mit KI_HG_THREADS_NACHT, bis 06:45
        (15 min vor Tagesbeginn wird entladen); TAG 07:00–19:00 nur mit KI_HG_TAG=1, KI_HG_THREADS_TAG.
Fenster: eine Nacht (Schlüssel = Datum des Abends) bzw. ein Tag. Zähler (Ladungen, Rückfall) gelten je Fenster.
Leiter: KI_HG_MODELLE in Reihenfolge. In den ersten 30 min der Hauptmodell-Phase wird nur auf das oberste
        verfügbare Modell gewartet; öffnet dessen Tor bis dahin nie, gilt für den Rest des Fensters der Rückfall.
Tor:    2 min am Stück offen (nach einer Wächter-Pause: frühestens nach KI_HG_PAUSE_S und 5 min am Stück),
        mit KI_HG_PUFFER_GB Reserve im KI-Slice und MemAvailable ≥ Bedarf + 2 × KI_HG_NOT_GB (speicher.tor).
Sperre: KI_HG_SPERRE (05:25–05:50, Selbsttest 05:30) — kein Schritt, das Modell wird entladen (hintergrund.py);
        die Nachtarbeit (Planer.lage) bleibt davon unberührt.
Zustand: Ladungen, Rückfall, Phasenbeginn und Pause des Fensters überleben einen Neustart des Dienstes
        (Rückruf zustand_gespeichert → hg-planer.json im Tresor, wiederherstellen() beim Start) — sonst
        erlaubte jeder Neustart in der Nacht drei weitere Ladungen und höbe eine Wächter-Pause auf.
Hysterese: ein geladenes Modell bleibt bis zum Fensterende oder bis der Wächter auslöst — das Tor wird nur
        vor dem Laden geprüft (das geladene Modell schlösse es sonst selbst).
"""

from __future__ import annotations

from dataclasses import dataclass, field
import time
from datetime import datetime, timedelta
from typing import Any, Callable, Collection

from .speicher import Messung, tor

NACHT = "nacht"
TAG = "tag"
ENTLADEN_VOR_TAG_MIN = 15
TOR_DAUER_S = 120.0
TOR_DAUER_NACH_PAUSE_S = 300.0
RUECKFALL_NACH_S = 1800.0
SPERRE_S = 24 * 3600.0
# Liegen zwischen zwei Tor-Messungen mehr als so viele Sekunden, gilt «am Stück» als unterbrochen.
TOR_LUECKE_S = 60.0


def uhrzeit(wert: str, standard: tuple[int, int]) -> tuple[int, int]:
    stunde, _, minute = (wert or "").strip().partition(":")
    try:
        h, m = int(stunde), int(minute or 0)
    except ValueError:
        return standard
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return standard
    return h, m


def sperrfenster(wert: str) -> tuple[tuple[int, int], tuple[int, int]] | None:
    """«05:25-05:50» → ((5, 25), (5, 50)); leer, ungültig oder von = bis → None (keine Sperre)."""
    von, _, bis = (wert or "").strip().partition("-")
    if not von or not bis:
        return None
    a, b = uhrzeit(von, (-1, -1)), uhrzeit(bis, (-1, -1))
    if a == (-1, -1) or b == (-1, -1) or a == b:
        return None
    return a, b


def modell_kurz(name: str) -> str:
    """Ollama listet Modelle ohne Tag als «name:latest»."""
    return name[:-7] if name.endswith(":latest") else name


@dataclass(frozen=True)
class Lage:
    modus: str          # NACHT | TAG
    fenster: str        # z. B. «2026-10-11/nacht» (Datum des Abends) oder «2026-10-12/tag»
    erlaubt: bool       # darf das Hauptmodell jetzt arbeiten
    threads: int
    grund: str          # «nacht», «tag», «tag_aus» (KI_HG_TAG=0), «vor_tag» (06:45–07:00)


@dataclass(frozen=True)
class Wahl:
    modell: str | None
    bedarf_gb: float | None
    # «tor_offen», «tor_warten» (offen, noch nicht lang genug), «tor_zu», «pause», «nachlade_grenze»,
    # «kein_modell» (keines installiert/alle gesperrt)
    grund: str
    tor: str | None = None   # Grund des Tor-Befunds des betrachteten Modells


@dataclass
class Planer:
    leiter: tuple[tuple[str, float], ...]
    nacht_start: tuple[int, int] = (19, 0)
    tag_start: tuple[int, int] = (7, 0)
    tag_aktiv: bool = False
    threads_nacht: int = 10
    threads_tag: int = 6
    max_ladungen: int = 3
    pause_s: float = 600.0
    # Kalibriert 16.10.2026 an der Messnacht (README «Hauptmodell: Planer, Speicher-Tor, Wächter»): 2 statt 3.
    puffer_gb: float = 2.0
    # MemAvailable muss Bedarf + Reserve decken (2 × KI_HG_NOT_GB) — Trust one wird nicht verdrängt.
    reserve_gb: float = 2.0
    # Sperrfenster (Selbsttest der Nacht, 05:30): kein Schritt, Modell entladen; (von, bis) als (h, m), None = keins.
    sperrzeit: tuple[tuple[int, int], tuple[int, int]] | None = None
    tor_dauer_s: float = TOR_DAUER_S
    tor_dauer_nach_pause_s: float = TOR_DAUER_NACH_PAUSE_S
    rueckfall_nach_s: float = RUECKFALL_NACH_S
    sperre_s: float = SPERRE_S
    # Sperren (Modell → Ende als Unix-Zeit), überleben einen Neustart über den Speicher-Rückruf.
    sperren: dict[str, float] = field(default_factory=dict)
    sperren_gespeichert: Callable[[dict[str, float]], None] | None = None
    # Zustand des Fensters (Ladungen, Rückfall, Pause) — überlebt so einen Neustart.
    zustand_gespeichert: Callable[[dict[str, Any]], None] | None = None
    # --- Zustand je Fenster ---
    _fenster: str | None = field(default=None, init=False)
    _ladungen: int = field(default=0, init=False)
    _phase_start: float | None = field(default=None, init=False)
    _rueckfall: bool = field(default=False, init=False)
    _oben_geoeffnet: bool = field(default=False, init=False)
    _phase_start_wand: float | None = field(default=None, init=False)
    # --- fensterübergreifend ---
    _pause_bis: float = field(default=0.0, init=False)
    _pause_bis_wand: float = field(default=0.0, init=False)
    _nach_pause: bool = field(default=False, init=False)
    _offen_seit: dict[str, float] = field(default_factory=dict, init=False)
    _letzte_messung: float | None = field(default=None, init=False)

    @classmethod
    def aus_cfg(cls, cfg, **weiter) -> "Planer":  # noqa: ANN001 — Einstellungen (Zirkelimport vermeiden)
        return cls(
            leiter=tuple(cfg.hg_modelle),
            nacht_start=uhrzeit(cfg.nacht_start, (19, 0)),
            tag_start=uhrzeit(cfg.tag_start, (7, 0)),
            tag_aktiv=cfg.hg_tag,
            threads_nacht=cfg.hg_threads_nacht,
            threads_tag=cfg.hg_threads_tag,
            max_ladungen=cfg.hg_max_ladungen,
            pause_s=float(cfg.hg_pause_s),
            puffer_gb=float(cfg.hg_puffer_gb),
            reserve_gb=2.0 * float(cfg.hg_not_gb),
            sperrzeit=sperrfenster(getattr(cfg, "hg_sperre", "")),
            **weiter,
        )

    def in_sperre(self, jetzt: datetime) -> bool:
        """Liegt jetzt im Sperrfenster (z. B. 05:25–05:50, Selbsttest)? Auch über Mitternacht."""
        if self.sperrzeit is None:
            return False
        (vh, vm), (bh, bm) = self.sperrzeit
        minute, von, bis = jetzt.hour * 60 + jetzt.minute, vh * 60 + vm, bh * 60 + bm
        return von <= minute < bis if von < bis else (minute >= von or minute < bis)

    # --- Modus und Fenster ------------------------------------------------------------

    def modus(self, jetzt: datetime) -> str:
        minute = jetzt.hour * 60 + jetzt.minute
        n = self.nacht_start[0] * 60 + self.nacht_start[1]
        t = self.tag_start[0] * 60 + self.tag_start[1]
        if t < n:
            return TAG if t <= minute < n else NACHT
        return NACHT if n <= minute < t else TAG

    def lage(self, jetzt: datetime) -> Lage:
        modus = self.modus(jetzt)
        if modus == NACHT:
            n_h, n_m = self.nacht_start
            abend = jetzt.date() if (jetzt.hour, jetzt.minute) >= (n_h, n_m) else jetzt.date() - timedelta(days=1)
            fenster = f"{abend.isoformat()}/{NACHT}"
            tag_beginn = jetzt.replace(hour=self.tag_start[0], minute=self.tag_start[1], second=0, microsecond=0)
            if tag_beginn <= jetzt:
                tag_beginn += timedelta(days=1)
            vor_tag = tag_beginn - jetzt <= timedelta(minutes=ENTLADEN_VOR_TAG_MIN)
            return Lage(NACHT, fenster, not vor_tag, self.threads_nacht, "vor_tag" if vor_tag else NACHT)
        fenster = f"{jetzt.date().isoformat()}/{TAG}"
        return Lage(TAG, fenster, self.tag_aktiv, self.threads_tag, TAG if self.tag_aktiv else "tag_aus")

    def _fenster_pruefen(self, fenster: str) -> None:
        if fenster == self._fenster:
            return
        self._fenster = fenster
        self._ladungen = 0
        self._phase_start = None
        self._rueckfall = False
        self._oben_geoeffnet = False
        self._phase_start_wand = None

    # --- Zustand über einen Neustart -------------------------------------------------------

    def zustand(self) -> dict[str, Any]:
        """Nur Zahlen und der Fensterschlüssel; Zeiten als Unix-Zeit (monotonic gilt nur bis zum Neustart)."""
        return {
            "fenster": self._fenster, "ladungen": self._ladungen, "rueckfall": self._rueckfall,
            "oben_geoeffnet": self._oben_geoeffnet, "phase_start": self._phase_start_wand,
            "pause_bis": self._pause_bis_wand, "nach_pause": self._nach_pause,
        }

    def wiederherstellen(self, daten: Any, *, jetzt_mono: float, jetzt_wand: float) -> None:
        """Gespeicherten Zustand übernehmen (beim Start). Gehört er zu einem anderen Fenster, setzt das nächste
        waehle() die Zähler ohnehin zurück; die Pause gilt fensterübergreifend bis zu ihrem Ende."""
        if not isinstance(daten, dict):
            return
        try:
            fenster = daten.get("fenster")
            ladungen = max(0, int(daten.get("ladungen") or 0))
            phase = daten.get("phase_start")
            phase_wand = float(phase) if phase is not None else None
            pause_wand = float(daten.get("pause_bis") or 0.0)
        except (TypeError, ValueError):
            return
        if isinstance(fenster, str) and fenster:
            self._fenster = fenster
            self._ladungen = ladungen
            self._rueckfall = bool(daten.get("rueckfall"))
            self._oben_geoeffnet = bool(daten.get("oben_geoeffnet"))
            if phase_wand is not None and phase_wand <= jetzt_wand:
                self._phase_start_wand = phase_wand
                self._phase_start = jetzt_mono - (jetzt_wand - phase_wand)
        if pause_wand > jetzt_wand:
            self._pause_bis_wand = pause_wand
            self._pause_bis = jetzt_mono + (pause_wand - jetzt_wand)
            self._nach_pause = True
        elif daten.get("nach_pause"):
            # Pause vorbei, aber seither nicht geladen: weiter 5 min Tor am Stück.
            self._nach_pause = True

    def _merken(self) -> None:
        if self.zustand_gespeichert is not None:
            self.zustand_gespeichert(self.zustand())

    def soll_entladen(self, lage: Lage, geladen_fenster: str | None) -> bool:
        """Hysterese: nur bei Fensterende (anderes Fenster/nicht mehr erlaubt) — nie wegen des Tors."""
        return (not lage.erlaubt) or (geladen_fenster is not None and geladen_fenster != lage.fenster)

    # --- Sperren ------------------------------------------------------------------------

    def gesperrt(self, modell: str, jetzt_wand: float) -> bool:
        bis = self.sperren.get(modell)
        return bis is not None and bis > jetzt_wand

    def sperre(self, modell: str, jetzt_wand: float) -> None:
        """OOM erkannt: Modell 24 h sperren, nächste Stufe der Leiter."""
        self.sperren = {m: b for m, b in self.sperren.items() if b > jetzt_wand}
        self.sperren[modell] = jetzt_wand + self.sperre_s
        self._offen_seit.pop(modell, None)
        if self.sperren_gespeichert is not None:
            self.sperren_gespeichert(dict(self.sperren))

    # --- Wahl -----------------------------------------------------------------------------

    def kandidaten(self, installiert: Collection[str], jetzt_wand: float) -> list[tuple[str, float]]:
        vorhanden = {modell_kurz(n) for n in installiert}
        return [(n, gb) for n, gb in self.leiter if modell_kurz(n) in vorhanden and not self.gesperrt(n, jetzt_wand)]

    def waehle(
        self, m: Messung, installiert: Collection[str], lage: Lage, *, jetzt_mono: float, jetzt_wand: float,
    ) -> Wahl:
        """Welches Modell jetzt laden? Nur aufrufen, wenn Arbeit ansteht und nichts geladen ist (etwa alle 10 s)."""
        self._fenster_pruefen(lage.fenster)
        if self._letzte_messung is not None and jetzt_mono - self._letzte_messung > TOR_LUECKE_S:
            self._offen_seit.clear()
        self._letzte_messung = jetzt_mono
        if not lage.erlaubt:
            return Wahl(None, None, "nicht_erlaubt")
        if self._ladungen >= self.max_ladungen:
            return Wahl(None, None, "nachlade_grenze")
        if jetzt_mono < self._pause_bis:
            return Wahl(None, None, "pause")
        kandidaten = self.kandidaten(installiert, jetzt_wand)
        if not kandidaten:
            return Wahl(None, None, "kein_modell")
        if self._phase_start is None:
            self._phase_start = jetzt_mono
            self._phase_start_wand = jetzt_wand
            self._merken()
        oben = kandidaten[0]
        if not self._rueckfall and not self._oben_geoeffnet and len(kandidaten) > 1 \
                and jetzt_mono - self._phase_start >= self.rueckfall_nach_s:
            self._rueckfall = True
            self._merken()
        betrachtet = kandidaten[1:] if self._rueckfall and len(kandidaten) > 1 else [oben]
        dauer = self.tor_dauer_nach_pause_s if self._nach_pause else self.tor_dauer_s
        letzter_befund: str | None = None
        warten = False
        for name, gb in betrachtet:
            befund = tor(m, gb, self.puffer_gb, self.reserve_gb)
            letzter_befund = befund.grund
            if not befund.offen:
                self._offen_seit.pop(name, None)
                continue
            seit = self._offen_seit.setdefault(name, jetzt_mono)
            if jetzt_mono - seit >= dauer:
                return Wahl(name, gb, "tor_offen", befund.grund)
            warten = True
            break
        return Wahl(None, None, "tor_warten" if warten else "tor_zu", letzter_befund)

    def ladung_beginnt(self, modell: str) -> None:
        """Jeder Ladevorgang zählt gegen die Nachlade-Begrenzung (auch Rückfallwechsel und Wiederaufnahme)."""
        self._ladungen += 1
        self._offen_seit.clear()
        self._nach_pause = False
        if self.leiter and modell_kurz(modell) == modell_kurz(self.leiter[0][0]):
            self._oben_geoeffnet = True
        self._merken()

    def pausiere(self, jetzt_mono: float, jetzt_wand: float | None = None) -> None:
        """Wächter hat ausgelöst: frühestens nach pause_s und dann nur bei 5 min am Stück offenem Tor."""
        self._pause_bis = jetzt_mono + self.pause_s
        self._pause_bis_wand = (time.time() if jetzt_wand is None else jetzt_wand) + self.pause_s
        self._nach_pause = True
        self._offen_seit.clear()
        self._merken()

    def status(self, jetzt_mono: float, jetzt_wand: float) -> dict[str, object]:
        return {
            "fenster": self._fenster,
            "ladungen": self._ladungen,
            "max_ladungen": self.max_ladungen,
            "puffer_gb": self.puffer_gb,
            "reserve_gb": self.reserve_gb,
            "rueckfall": self._rueckfall,
            "pause_rest_s": max(0, int(self._pause_bis - jetzt_mono)),
            "gesperrt": {m: int(b - jetzt_wand) for m, b in self.sperren.items() if b > jetzt_wand},
        }
