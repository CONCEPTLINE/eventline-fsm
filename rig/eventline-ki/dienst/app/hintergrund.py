"""Hintergrund-Thread und Wächter für das Hauptmodell (Masterplan §2.3–§2.6).

Ablauf je Runde (alle 10–30 s, sonst ohne Pause von Schritt zu Schritt):
1. Planer: Modus/Fenster (Europe/Zurich). Nicht erlaubt oder Fenster gewechselt → nach dem laufenden Schritt
   entladen (keep_alive 0).
2. Nächster Schritt aus hg_auftraege (nur eingeschaltete Arten des Modus). Keiner → warten.
3. Kein Modell geladen → nur bei Ruhe (kein FSM-Auftrag läuft oder wartet, nachts 20 s, tagsüber KI_HG_RUHE_TAG_S)
   und wenn die Vorarbeit (Indexe, Arbeit des schnellen Modells, jemand sucht gerade) nicht läuft: Planer wählt nach
   Leiter + Speicher-Tor und Ladeabstand (KI_HG_LADE_ABSTAND_S, nach Fehlschlägen länger). Verlangt der Schritt eigene
   Modelle (Job.modelle, der zweite Blick: nur freigegebene), lädt nur eines davon — ein anderes geladenes wird entladen.

Tagsüber (seit 16.10.2026, KI_HG_TAG=1 Standard, Mischa: «falls nichts zu tun ist, soll sie arbeiten, wenn sie etwas
hat»): derselbe Ablauf mit KI_HG_THREADS_TAG Threads und niedrigem CPU-Gewicht der Instanz «gruendlich»
(docker-compose.yml) — Wartende rechnen auf der GPU und gewinnen jeden CPU-Wettstreit; zwischen den Teilen eines
Dokuments wartet der zweite Blick auf Ruhe (jobs/zweiter_blick.py). Gemessen: README «Tagsüber arbeiten».
4. Schritt rechnen (chat_stream an «gruendlich», nie mit gpu.SCHLEUSE), höchstens KI_HG_SCHRITT_MAX_S.

Wächter (eigener Thread, alle 2 s, nur wenn das Hauptmodell geladen ist oder lädt): bei einem Auslöser
(speicher.WaechterRegel) Abbruch-Event → der Stream wird getrennt (Ollama bricht ab) → Modell entladen →
Schritt «pausiert», Protokoll art=hg_<job>, fehler «speicher» → Planer-Pause (KI_HG_PAUSE_S, danach Tor 5 min
am Stück). Während des Ladens wird nicht abgebrochen; sobald das Modell geladen ist, wird es entladen.

OOM erkannt (Modell nach einem fehlgeschlagenen Schritt nicht mehr in /api/ps, oder «gruendlich» nicht
erreichbar/neu gestartet) → Modell 24 h gesperrt (Datei hg-sperren.json im Tresor), nächste Stufe der Leiter.
Antwortet /api/ps nicht (Fehler, Zeitüberschreitung — gerade bei Speichernot), ist der Stand «unbekannt»: das ist
kein OOM (keine Sperre), das Modell gilt weiter als geladen (der Wächter bleibt aktiv), und Entladen schickt
keep_alive 0 trotzdem (lädt nie, Ollama 0.35.1 geprüft). Schlägt auch das fehl, wird es in jeder Runde wiederholt.

Der Planer-Zustand (Ladungen und Rückfall des Fensters, Pause, letzte Ladung, Fehlschläge) liegt in hg-planer.json im
Tresor und übersteht einen Neustart des Dienstes.

Stufe B (KI_HG_GPU_NACHT=1): nach jedem Chunk Vorrang prüfen — läuft ein FSM-Auftrag, wird der Schritt
getrennt («pausiert», vorrang) und nach 20 s Ruhe neu gestartet; das Modell bleibt geladen.

Betrieb (im Dienst-Container):
    python -m app.hintergrund probe     harmlosen Probe-Schritt anlegen (Abnahme, kein Dokument)
    python -m app.hintergrund status    Zähler der Job-Liste
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable

from .config import Einstellungen
from .jobs import JOBS, Job, JobFehler, JobListe, Schritt, SchrittKontext, MAX_VERSUCHE, PROBE_REZEPT, job
from .llm import LlmAbgebrochen, LlmFehler, Ollama
from .planer import TAG, Lage, Planer, modell_in, modell_kurz
from .speicher import Messung, Quellen, WaechterRegel, messen

log = logging.getLogger("ki.hintergrund")

ZEITZONE = "Europe/Zurich"
KEEP_ALIVE = "15m"
RUHE_S = 20.0
SPERREN_DATEI = "hg-sperren.json"
PLANER_DATEI = "hg-planer.json"
INSTALLIERT_CACHE_S = 300.0
ZAEHLER_CACHE_S = 30.0
# Fehlt das Modell zwischen zwei Schritten in /api/ps, obwohl es kürzer als keep_alive ungenutzt war, wurde
# «gruendlich» neu gestartet oder der Runner beendet (OOM).
UNERWARTET_WEG_S = 14 * 60.0
# Kennzahlen, die ein Schritt fürs Protokoll liefern darf (= Protokoll.schreibe).
PROTOKOLL_KENNZAHLEN = ("seiten", "zeichen", "gescannt", "teile", "belege")


def jetzt_zuerich() -> datetime:
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo(ZEITZONE))
    except Exception:  # noqa: BLE001 — ohne Zeitzonendaten Ortszeit des Containers
        return datetime.now()


@dataclass
class Takt:
    """Wartezeiten der Schleife (Tests verkürzen sie)."""

    ruhe: float = 30.0          # nichts zu tun / nicht erlaubt
    warten: float = 10.0        # wartet auf Tor, Ruhe oder Vorarbeit
    waechter: float = 2.0       # Wächter-Intervall
    ruhe_s: float = RUHE_S      # «ruhig»: so lange kein FSM-Auftrag
    entlade_warten_s: float = 120.0  # nach Abbruch während des Ladens: so lange auf /api/ps warten
    fehler: float | None = None      # nach fehlgeschlagenem Laden (None = KI_HG_NEU_PRUEFEN_S)
    leer_entladen_s: float = 90.0    # Job-Liste so lange leer → geladenes Modell entladen (statt keep_alive 15 min)
    ruhe_tag_s: float | None = None  # tagsüber vor dem Laden so lange Ruhe (None = KI_HG_RUHE_TAG_S)


@dataclass
class _Geladen:
    modell: str
    fenster: str
    threads: int
    letzte_nutzung: float


class Hintergrund(threading.Thread):
    def __init__(
        self,
        cfg: Einstellungen,
        llm: Ollama,
        liste: JobListe,
        protokoll: Any,
        zustand: Any,
        *,
        planer: Planer | None = None,
        jobs: tuple[Job, ...] = JOBS,
        vorarbeit_laeuft: Callable[[], bool] = lambda: False,
        messung: Callable[[], Messung] | None = None,
        uhr: Callable[[], datetime] = jetzt_zuerich,
        takt: Takt | None = None,
    ) -> None:
        super().__init__(name="ki-hintergrund", daemon=True)
        if llm.schleuse:
            raise ValueError("Hintergrund braucht einen Ollama-Client mit schleuse=False (Masterplan §2.6)")
        self.cfg = cfg
        self.llm = llm
        self.liste = liste
        self.protokoll = protokoll
        self.zustand = zustand
        self.jobs = jobs
        self.vorarbeit_laeuft = vorarbeit_laeuft
        self.uhr = uhr
        self.takt = takt or Takt()
        quellen = Quellen(slice_dir=cfg.hg_slice_dir)
        self.messung = messung or (lambda: messen(quellen))
        self._sperren_datei = cfg.data_dir / SPERREN_DATEI
        self._planer_datei = cfg.data_dir / PLANER_DATEI
        self.planer = planer or Planer.aus_cfg(cfg, sperren=self._sperren_laden())
        if self.planer.sperren_gespeichert is None:
            self.planer.sperren_gespeichert = self._sperren_speichern
        self.planer.wiederherstellen(self._json_laden(self._planer_datei), jetzt_mono=time.monotonic(), jetzt_wand=time.time())
        if self.planer.zustand_gespeichert is None:
            self.planer.zustand_gespeichert = self._planer_speichern
        self._halt = threading.Event()
        self._abbruch = threading.Event()
        self._abbruch_grund: str | None = None
        self._lock = threading.Lock()
        self._geladen: _Geladen | None = None
        self._laedt: str | None = None
        # Entladen nicht bestätigt (gruendlich antwortete nicht): in jeder Runde erneut, Wächter bleibt aktiv.
        self._entladen_offen: str | None = None
        self._lage: Lage | None = None
        self._warte: str | None = None
        self._schritt_art: str | None = None
        self._leer_seit: float | None = None
        self._letzter_abbruch: dict[str, Any] | None = None
        self._installiert: tuple[float, list[str]] = (0.0, [])
        self._zaehler: tuple[float, dict[str, int]] = (0.0, {})
        self.waechter = Waechter(self, WaechterRegel(not_gb=cfg.hg_not_gb), self.takt.waechter)

    # --- Steuerung von aussen -------------------------------------------------------------

    def stop(self) -> None:
        self._halt.set()
        self._abbruch_setzen("halt")
        self.waechter.stop()

    def abbrechen(self, grund: str, ausloeser: str | None = None) -> None:
        """Vom Wächter: laufenden Schritt trennen, Modell entladen, pausieren."""
        if self._abbruch.is_set():
            return
        log.warning("Hauptmodell: Wächter löst aus (%s) — Schritt wird abgebrochen, Modell entladen", ausloeser or grund)
        with self._lock:
            self._letzter_abbruch = {"grund": grund, "ausloeser": ausloeser, "zeit": self.uhr().isoformat(timespec="seconds")}
        self._abbruch_setzen(grund)

    def _abbruch_setzen(self, grund: str) -> None:
        with self._lock:
            if self._abbruch_grund is None or grund == "halt":
                self._abbruch_grund = grund
        self._abbruch.set()

    def speicher_relevant(self) -> bool:
        with self._lock:
            return self._laedt is not None or self._geladen is not None or self._entladen_offen is not None

    def status(self) -> dict[str, Any]:
        """Für /health — Modellnamen, Zähler, Gründe; nie Schlüssel oder Inhalte."""
        jetzt = time.monotonic()
        if jetzt - self._zaehler[0] > ZAEHLER_CACHE_S:
            try:
                self._zaehler = (jetzt, self.liste.zaehler())
            except Exception as e:  # noqa: BLE001
                log.warning("Job-Liste nicht lesbar (%s)", type(e).__name__)
                self._zaehler = (jetzt, {})
        with self._lock:
            lage = self._lage
            return {
                "aktiv": True,
                "modus": lage.modus if lage else None,
                "erlaubt": lage.erlaubt if lage else None,
                "geladen": self._geladen.modell if self._geladen else None,
                "laedt": self._laedt,
                "entladen_offen": self._entladen_offen,
                "schritt": self._schritt_art,
                "warte": self._warte,
                "letzter_abbruch": self._letzter_abbruch,
                "planer": self.planer.status(jetzt, time.time()),
                "schritte": dict(self._zaehler[1]),
            }

    # --- Schleife ---------------------------------------------------------------------------

    def run(self) -> None:
        log.info("Hauptmodell-Hintergrund gestartet — Leiter %s, %s", [m for m, _ in self.planer.leiter], self.cfg.hg_url)
        try:
            n = self.liste.start()
            if n:
                log.info("Hauptmodell: %d unterbrochene Schritte wieder offen", n)
        except Exception as e:  # noqa: BLE001
            log.warning("Job-Liste beim Start nicht erreichbar (%s)", type(e).__name__)
        self.waechter.start()
        while not self._halt.is_set():
            try:
                pause = self._runde()
            except Exception:  # noqa: BLE001 — der Thread darf nie sterben
                log.exception("Hauptmodell: unerwarteter Fehler in der Runde")
                pause = self.takt.ruhe
            if pause:
                self._halt.wait(pause)
        self._entladen("halt")
        log.info("Hauptmodell-Hintergrund beendet")

    def _setze(self, **werte: Any) -> None:
        with self._lock:
            for k, v in werte.items():
                setattr(self, k, v)

    def _abbruch_quittieren(self) -> str | None:
        with self._lock:
            grund, self._abbruch_grund = self._abbruch_grund, None
            self._abbruch.clear()
        return grund

    def _runde(self) -> float:
        """Eine Runde; liefert die Wartezeit bis zur nächsten (0 = sofort weiter)."""
        if self._abbruch.is_set() and not self._halt.is_set():
            # Wächter hat zwischen zwei Schritten ausgelöst (kein Stream offen): entladen und pausieren.
            grund = self._abbruch_grund or "abbruch"
            self._entladen(grund)
            self._abbruch_quittieren()
            if grund == "speicher":
                self.planer.pausiere(time.monotonic(), time.time())
        elif self._entladen_offen is not None and self._geladen is None and self._laedt is None:
            self._entladen("nachholen")
            if self._entladen_offen is not None:
                # Erst laden, wenn das alte Modell sicher weg ist.
                self._setze(_warte="entladen_offen")
                return self.takt.warten
        jetzt = self.uhr()
        lage = self.planer.lage(jetzt)
        if lage.erlaubt and self.planer.in_sperre(jetzt):
            # Sperrfenster (KI_HG_SPERRE, Selbsttest 05:30): wie Fensterende — entladen, kein Schritt.
            lage = dataclasses.replace(lage, erlaubt=False, grund="sperre")
        self._setze(_lage=lage)
        geladen = self._geladen
        if geladen is not None and (self.planer.soll_entladen(lage, geladen.fenster) or geladen.threads != lage.threads):
            self._entladen("sperre" if lage.grund == "sperre" else "fenster")
            geladen = None
        if not lage.erlaubt:
            self._setze(_warte=lage.grund)
            return self.takt.ruhe
        arten = [j.art for j in self.jobs if lage.modus in j.modi and j.aktiv(self.cfg)]
        try:
            schritt = self.liste.naechster(arten)
        except Exception as e:  # noqa: BLE001
            log.warning("Job-Liste nicht erreichbar (%s)", type(e).__name__)
            self._setze(_warte="job_liste")
            return self.takt.ruhe
        if schritt is None:
            leer_seit = self._leer_seit = self._leer_seit or time.monotonic()
            if geladen is not None and time.monotonic() - leer_seit >= self.takt.leer_entladen_s:
                # Nichts mehr zu tun: nach kurzer Leerlaufzeit entladen (16.10.2026) statt keep_alive (15 min)
                # abzuwarten — 16 GB gehören dann wieder dem Rig (Trust one, Seitencache).
                self._entladen("keine_arbeit")
            self._setze(_warte="keine_arbeit")
            return self.takt.ruhe
        self._leer_seit = None
        j_naechster = job(schritt.art, self.jobs)
        nur = j_naechster.modelle if j_naechster is not None else ()
        if geladen is not None and nur and not modell_in(geladen.modell, nur):
            # Geladen ist ein Modell, mit dem dieser Schritt nicht rechnen darf (zweiter Blick: nur freigegebene, nie der
            # 12B-Rückfall): entladen und erst mit einem erlaubten weiterrechnen — der Schritt bleibt offen.
            self._entladen("nicht_freigegeben")
            self._setze(_warte="nicht_freigegeben")
            return self.takt.warten
        if self.cfg.hg_gpu_nacht and not self.zustand.ruhig(self.takt.ruhe_s):
            self._setze(_warte="vorrang")
            return self.takt.warten
        if geladen is not None:
            stand = self._noch_geladen(geladen)
            if stand is None:
                # /api/ps antwortet nicht: weder rechnen (ein Aufruf lüde das Modell ohne Tor neu) noch OOM annehmen.
                self._setze(_warte="ps_unbekannt")
                return self.takt.warten
            if not stand:
                geladen = None
        if geladen is None:
            if self.vorarbeit_laeuft():
                self._setze(_warte="vorarbeit")
                return self.takt.warten
            if not self.zustand.ruhig(self._ruhe_vor_dem_laden(lage)):
                self._setze(_warte="vorrang")
                return self.takt.warten
            geladen = self._laden(lage, nur=nur)
            if geladen is None:
                return self.takt.warten
        self._setze(_warte=None)
        self._schritt(schritt, geladen)
        return 0.0

    def _ruhe_vor_dem_laden(self, lage: Lage) -> float:
        """Sekunden ohne FSM-Auftrag, bevor das Modell lädt: nachts Takt.ruhe_s (20 s), tagsüber länger."""
        if lage.modus != TAG:
            return self.takt.ruhe_s
        tag = self.takt.ruhe_tag_s if self.takt.ruhe_tag_s is not None else float(getattr(self.cfg, "hg_ruhe_tag_s", 0))
        return max(self.takt.ruhe_s, tag)

    # --- Modell laden / entladen ------------------------------------------------------------

    def _optionen(self, threads: int) -> dict[str, Any]:
        # Immer gleich (sonst lädt Ollama neu): kein mmap (kein stilles Nachladen von der SSD), keine GPU (Stufe A).
        return {"use_mmap": False, "num_gpu": 0, "num_ctx": self.cfg.hg_num_ctx, "num_thread": threads}

    def _installierte(self) -> list[str]:
        zeit, liste = self._installiert
        if not liste or time.monotonic() - zeit > INSTALLIERT_CACHE_S:
            liste = self.llm.installierte_modelle()
            self._installiert = (time.monotonic(), liste)
        return liste

    def _geladen_stand(self, modell: str) -> bool | None:
        """True/False laut /api/ps; None, wenn /api/ps nicht antwortet (unbekannt — nie als «nicht geladen» werten)."""
        liste = self.llm.geladene_modelle_oder_none()
        if liste is None:
            return None
        return any(modell_kurz(str(m.get("name") or m.get("model") or "")) == modell_kurz(modell) for m in liste)

    def _noch_geladen(self, g: _Geladen) -> bool | None:
        stand = self._geladen_stand(g.modell)
        if stand is None:
            log.warning("Hauptmodell: /api/ps antwortet nicht — Stand von %s unbekannt, kein OOM-Schluss", g.modell)
            return None
        if stand:
            return True
        if time.monotonic() - g.letzte_nutzung < UNERWARTET_WEG_S:
            self._oom(g.modell, "zwischen Schritten verschwunden")
        self._setze(_geladen=None)
        return False

    def _laden(self, lage: Lage, *, nur: tuple[str, ...] = ()) -> _Geladen | None:
        wahl = self.planer.waehle(
            self.messung(), self._installierte(), lage, jetzt_mono=time.monotonic(), jetzt_wand=time.time(), nur=nur,
        )
        if wahl.modell is None:
            self._setze(_warte=wahl.grund if wahl.tor is None else f"{wahl.grund}:{wahl.tor}")
            return None
        modell = wahl.modell
        self._abbruch.clear()
        self._setze(_abbruch_grund=None, _laedt=modell, _warte="laden")
        self.planer.ladung_beginnt(modell, time.monotonic(), time.time())
        log.info("Hauptmodell: lade %s (Bedarf %.0f GB, %d Threads, Fenster %s)", modell, wahl.bedarf_gb or 0, lage.threads, lage.fenster)
        start = time.monotonic()
        try:
            self.llm.lade(modell=modell, optionen=self._optionen(lage.threads), keep_alive=KEEP_ALIVE)
        except LlmFehler as e:
            dauer = int((time.monotonic() - start) * 1000)
            log.warning("Hauptmodell: Laden von %s fehlgeschlagen nach %d ms: %s", modell, dauer, e)
            stand = self._geladen_stand(modell)
            weg = stand is False
            # Nicht sicher weg (geladen oder unbekannt): nicht unbeaufsichtigt liegen lassen — entladen.
            self._setze(_laedt=None, _entladen_offen=None if weg else modell)
            if weg and self._abbruch_grund is None:
                self._oom(modell, "beim Laden")   # sperrt und zählt als Fehlschlag
            else:
                self.planer.fehlschlag()           # nächster Ladeabstand doppelt so lang
            fehler = "oom" if weg else ("ps_unbekannt" if stand is None else str(e)[:120])
            self.protokoll.schreibe("hg_laden", "rig", dauer, modell, False, fehler)
            if not weg:
                self._entladen("laden_fehlgeschlagen")
            self._halt.wait(self.takt.fehler if self.takt.fehler is not None else self.cfg.hg_neu_pruefen_s)
            return None
        dauer = int((time.monotonic() - start) * 1000)
        g = _Geladen(modell, lage.fenster, lage.threads, time.monotonic())
        self._setze(_laedt=None, _geladen=g)
        if self._abbruch.is_set():
            # Wächter hat während des Ladens ausgelöst (oder Halt): jetzt, da das Modell da ist, entladen.
            grund = self._abbruch_grund or "abbruch"
            self.protokoll.schreibe("hg_laden", "rig", dauer, modell, False, grund)
            self._entladen(grund)
            if not self._halt.is_set():
                self._abbruch_quittieren()
            if grund == "speicher":
                self.planer.pausiere(time.monotonic(), time.time())
            return None
        self.protokoll.schreibe("hg_laden", "rig", dauer, modell, True)
        log.info("Hauptmodell: %s geladen in %d ms", modell, dauer)
        return g

    def _entladen(self, grund: str) -> None:
        """keep_alive 0 an «gruendlich». Ohne Prompt lädt dieser Aufruf ein nicht geladenes Modell nie (Ollama
        0.35.1, geprüft 2026-10-11) — er geht darum auch, wenn /api/ps nicht antwortet. Nur während eines
        laufenden Ladens wird erst gewartet, bis /api/ps das Modell zeigt (das Laden lässt sich nicht stoppen).
        Nimmt «gruendlich» den Aufruf nicht an, bleibt das Modell in _entladen_offen (Wächter aktiv, nächste
        Runde erneut)."""
        with self._lock:
            g, self._geladen = self._geladen, None
            laedt = self._laedt
            offen = self._entladen_offen
        modell = g.modell if g else (laedt or offen)
        if modell is None:
            return
        if laedt and not g:
            frist = time.monotonic() + self.takt.entlade_warten_s
            while not self._geladen_stand(modell) and time.monotonic() < frist:
                time.sleep(1.0)
        if self.llm.entlade(modell):
            self._setze(_entladen_offen=None)
            log.info("Hauptmodell: %s entladen (%s)", modell, grund)
        else:
            self._setze(_entladen_offen=modell)
            log.warning("Hauptmodell: Entladen von %s nicht bestätigt (%s) — nächste Runde erneut", modell, grund)

    def _oom(self, modell: str, wo: str) -> None:
        log.error("Hauptmodell: %s nicht mehr geladen (%s) — OOM/Neustart vermutet, 24 h gesperrt", modell, wo)
        self.planer.sperre(modell, time.time())
        self.protokoll.schreibe("hg_oom", "rig", None, modell, False, "oom")
        self._setze(_geladen=None)

    # --- Schritt ---------------------------------------------------------------------------------

    def _vorrang(self) -> str | None:
        return "vorrang" if self.zustand.lies("laeuft") is not None else None

    def _schritt(self, schritt: Schritt, g: _Geladen) -> None:
        j = job(schritt.art, self.jobs)
        art = f"hg_{schritt.art}"
        if j is None:
            self.liste.beende(schritt.id, "fehler", "unbekannte Art")
            return
        # Das Abbruch-Event wird hier NICHT zurückgesetzt: löst der Wächter genau jetzt aus, trennt der
        # Stream sofort, und _nach_abbruch quittiert es.
        self._setze(_schritt_art=schritt.art)
        ctx = SchrittKontext(
            modell=g.modell,
            optionen=self._optionen(g.threads),
            abbruch=self._abbruch,
            frist=time.monotonic() + (j.max_s or self.cfg.hg_schritt_max_s),
            chat_stream=self.llm.chat_stream,
            keep_alive=KEEP_ALIVE,
            pruefe=self._vorrang if self.cfg.hg_gpu_nacht else None,
        )
        self.liste.beginne(schritt.id)
        start = time.monotonic()
        try:
            meta = j.ausfuehren(schritt, ctx) or {}
            dauer = int((time.monotonic() - start) * 1000)
            self.liste.beende(schritt.id, "fertig")
            self.planer.schritt_fertig()
            # Kennzahlen des gelesenen Dokuments (nur Zahlen; zweiter Blick: Seiten, Zeichen, Teile, Belege).
            kennzahlen = meta.get("kennzahlen") if isinstance(meta.get("kennzahlen"), dict) else {}
            self.protokoll.schreibe(art, "rig", dauer, g.modell, True,
                                    **{k: v for k, v in kennzahlen.items() if k in PROTOKOLL_KENNZAHLEN})
            log.info("%s Schritt %d fertig in %d ms (Denk-Tokens %s, Antwort-Tokens %s)",
                     art, schritt.id, dauer, meta.get("denk_tokens"), meta.get("antwort_tokens"))
        except LlmAbgebrochen as e:
            self._nach_abbruch(schritt, art, g, e.grund, start)
        except LlmFehler as e:
            dauer = int((time.monotonic() - start) * 1000)
            stand = self._geladen_stand(g.modell)
            status = "offen" if schritt.versuche + 1 < MAX_VERSUCHE else "fehler"
            if stand is False:
                self._oom(g.modell, "während eines Schritts")
                self.liste.beende(schritt.id, status, "oom")
                self.protokoll.schreibe(art, "rig", dauer, g.modell, False, "oom")
            elif stand is None:
                # /api/ps antwortet nicht: kein OOM-Schluss, keine Sperre; Modell gilt weiter als geladen.
                self.liste.beende(schritt.id, status, "ps_unbekannt")
                self.protokoll.schreibe(art, "rig", dauer, g.modell, False, "ps_unbekannt")
            else:
                self.liste.beende(schritt.id, "fehler", str(e)[:200])
                self.protokoll.schreibe(art, "rig", dauer, g.modell, False, str(e)[:200])
        except JobFehler as e:
            dauer = int((time.monotonic() - start) * 1000)
            self.liste.beende(schritt.id, "fehler", str(e)[:200])
            self.protokoll.schreibe(art, "rig", dauer, g.modell, False, str(e)[:200])
        except Exception as e:  # noqa: BLE001 — Klartext ohne Inhalte, Details nur im Log
            dauer = int((time.monotonic() - start) * 1000)
            log.exception("%s Schritt %d: unerwarteter Fehler", art, schritt.id)
            text = f"Unerwarteter Fehler ({type(e).__name__})"
            self.liste.beende(schritt.id, "fehler", text)
            self.protokoll.schreibe(art, "rig", dauer, g.modell, False, text)
        finally:
            if self._geladen is not None:
                self._geladen.letzte_nutzung = time.monotonic()
            self._setze(_schritt_art=None)

    def _nach_abbruch(self, schritt: Schritt, art: str, g: _Geladen, grund_stream: str, start: float) -> None:
        dauer = int((time.monotonic() - start) * 1000)
        grund = (self._abbruch_grund or "abbruch") if grund_stream == "abbruch" else grund_stream
        if grund == "zeit":
            # Schritt dauerte länger als KI_HG_SCHRITT_MAX_S: «fehler», weiter mit dem nächsten (§2.3).
            self.liste.beende(schritt.id, "fehler", "zeit")
            self.protokoll.schreibe(art, "rig", dauer, g.modell, False, "zeit")
            return
        if grund == "vorrang":
            # Stufe B: Modell bleibt geladen, Schritt startet nach Ruhe neu; zählt nicht als Versuch.
            self.liste.beende(schritt.id, "pausiert", "vorrang", versuch_zaehlt=False)
            self.protokoll.schreibe(art, "rig", dauer, g.modell, False, "vorrang")
            return
        self.liste.beende(schritt.id, "pausiert", grund, versuch_zaehlt=False)
        self.protokoll.schreibe(art, "rig", dauer, g.modell, False, grund)
        self._entladen(grund)
        # Erst nach dem Entladen quittieren: ein zweiter Wächter-Alarm in der Zwischenzeit geht im selben auf.
        if not self._halt.is_set():
            self._abbruch_quittieren()
        if grund == "speicher":
            self.planer.pausiere(time.monotonic(), time.time())

    # --- Sperren und Planer-Zustand im Tresor -----------------------------------------------------------------------

    def _sperren_laden(self) -> dict[str, float]:
        try:
            daten = json.loads(self._sperren_datei.read_text(encoding="utf-8"))
            return {str(k): float(v) for k, v in daten.items() if float(v) > time.time()}
        except (OSError, ValueError, AttributeError, TypeError):
            return {}

    def _sperren_speichern(self, sperren: dict[str, float]) -> None:
        self._json_speichern(self._sperren_datei, sperren, "Modell-Sperren")

    def _planer_speichern(self, zustand: dict[str, Any]) -> None:
        self._json_speichern(self._planer_datei, zustand, "Planer-Zustand")

    @staticmethod
    def _json_laden(datei) -> Any:  # noqa: ANN001 — Path
        try:
            return json.loads(datei.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    @staticmethod
    def _json_speichern(datei, daten: Any, was: str) -> None:  # noqa: ANN001 — Path
        try:
            datei.parent.mkdir(parents=True, exist_ok=True)
            tmp = datei.with_suffix(".json.neu")
            tmp.write_text(json.dumps(daten), encoding="utf-8")
            tmp.replace(datei)
        except OSError as e:
            log.warning("%s nicht gespeichert (%s)", was, type(e).__name__)


class Waechter(threading.Thread):
    """Alle 2 s, nur solange das Hauptmodell geladen ist oder lädt (§2.5)."""

    def __init__(self, hg: Hintergrund, regel: WaechterRegel, intervall_s: float) -> None:
        super().__init__(name="ki-waechter", daemon=True)
        self.hg = hg
        self.regel = regel
        self.intervall_s = intervall_s
        self._halt = threading.Event()

    def stop(self) -> None:
        self._halt.set()

    def run(self) -> None:
        while not self._halt.wait(self.intervall_s):
            try:
                if not self.hg.speicher_relevant():
                    self.regel.zuruecksetzen()
                    continue
                ausloeser = self.regel.pruefe(self.hg.messung())
                if ausloeser:
                    self.hg.abbrechen("speicher", ausloeser)
                    self.regel.zuruecksetzen()
            except Exception:  # noqa: BLE001 — der Wächter darf nie sterben
                log.exception("Wächter: unerwarteter Fehler")


# --- Betrieb von Hand -----------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    from .config import EINSTELLUNGEN as cfg

    p = argparse.ArgumentParser(prog="app.hintergrund", description="Hauptmodell: Job-Liste von Hand")
    sub = p.add_subparsers(dest="befehl", required=True)
    sub.add_parser("probe", help="harmlosen Probe-Schritt anlegen (kein Dokument)")
    sub.add_parser("status", help="Zähler der Job-Liste")
    a = p.parse_args(argv)
    liste = JobListe(cfg.pg_dsn)
    if not liste.aktiv:
        print("PG_PASSWORD fehlt — keine Job-Liste", file=sys.stderr)
        return 1
    try:
        if a.befehl == "probe":
            schluessel = datetime.now().strftime("%Y%m%d-%H%M%S")
            neu = liste.anlegen("probe", schluessel, PROBE_REZEPT)
            print(f"Probe-Schritt {'angelegt' if neu else 'gab es schon'} ({schluessel})")
        print(json.dumps(liste.zaehler(), ensure_ascii=False))
    finally:
        liste.schliessen()
    return 0


if __name__ == "__main__":
    sys.exit(main())
