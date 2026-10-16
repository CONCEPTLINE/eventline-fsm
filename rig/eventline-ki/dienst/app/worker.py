"""Hintergrund-Schleife: Aufträge beim FSM abholen, der Reihe nach verarbeiten, Ergebnis melden.

Alle 2 s pollen, nach Arbeit sofort erneut. Fehler werden als ok:false mit
Klartext gemeldet, nie als Absturz: die Schleife überlebt alles, meldet nicht
zustellbare Ergebnisse später nach und räumt Dateireste im Tresor weg. Jeder
Poll trägt den Herzschlag (SPEC §3.4); während ein Auftrag läuft, meldet ein
eigener Thread alle 20 s «lebt noch» (Vertrag V1), damit das FSM die KI auch
bei langen Aufträgen als online sieht.

Auf der 8-GB-Karte rechnet immer nur ein Modell (Schleuse in gpu.py); vor einem
Diktat wird das Sprachmodell entladen, wenn es eng wird. Whisper räumt seinen VRAM
selbst nach WHISPER__TTL — sein Entlade-Aufruf verklemmt den Server (whisper.py).

Leichte Spur (16.10.2026, «Wartende haben Vorrang»): solange der Worker an einem
Auftrag arbeitet (bis das Ergebnis gemeldet ist), holt LeichteSpur NUR leichte
Arten (ARTEN_LEICHT: Vorschau — ohne Modell, ohne GPU) mit eigenem FSM-Client ab
und bearbeitet höchstens LEICHT_PARALLEL gleichzeitig. Eine Hover-Vorschau wartet
so nie hinter einer Ablage mit Texterkennung.
"""

from __future__ import annotations

import hashlib
import json
import logging
import queue
import re
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

from . import VERSION
from .archiv import ArchivIndex
from .archiv_frage import archiv_frage
from .config import Einstellungen
from .fsm import Auftrag, FsmAbgelehnt, FsmClient, FsmFehler
from .gpu import gpu_kurz
from .handlers import VerarbeitungsFehler
from .handlers.ablage import ablage_analyse
from .handlers.beleg import beleg_analyse
from .handlers.diktat import diktat
from .handlers.warenkorb import warenkorb_analyse
from .llm import Ollama
from .protokoll import Protokoll
from .suche import Suche, nas_suche
from .vorschau import VorschauSpeicher, vorschau
from .whisper import Whisper

log = logging.getLogger("ki.worker")

ARTEN_MIT_LLM = ("ablage_analyse", "beleg_analyse", "warenkorb_analyse")
ARTEN_MIT_DATEI = ARTEN_MIT_LLM + ("diktat",)
# Arten ohne Datei (Masterplan MP-3/MP-4): nur mit Schalter angenommen und im Herzschlag gemeldet (MP-1).
# «vorschau» (vorschau.py): Vorschaubild direkt vom NAS-Mount — ohne Modell, ohne GPU, ohne Tiefen-Index.
ARTEN_OHNE_DATEI = ("nas_suche", "archiv_frage", "vorschau")
# Leichte Spur: Arten ohne Sprachmodell und ohne GPU, neben einem laufenden Auftrag parallel (vorschau rendert die erste
# Seite in 0,1–0,6 s). Inhaltssuche und Archiv-Frage gehören nicht dazu: Einbettungs- bzw. Sprachmodell auf der
# GPU-Schleuse — sie warteten dort ohnehin auf den laufenden Auftrag.
ARTEN_LEICHT = ("vorschau",)
LEICHT_PARALLEL = 2
# So oft schaut die leichte Spur, ob der Worker beschäftigt ist (sonst holt er selbst ab).
LEICHT_TAKT_S = 0.1
# Untergrenze des adaptiven Abholtakts (MP-2): max(250 ms, naechster_poll_ms).
EILIG_MIN_S = 0.25
# Kennzahlen eines Beleg-/Warenkorb-Fotos fürs Protokoll: eine Seite, als Bild gelesen (gescannt), ein Teil, ohne
# herausgezogenen Text (zeichen bleibt leer).
BILD_KENNZAHLEN: dict[str, Any] = {"seiten": 1, "gescannt": True, "teile": 1}
_ENDUNG = re.compile(r"\.([A-Za-z0-9]{1,8})$")


def arten_aktiv(cfg: Einstellungen) -> tuple[str, ...]:
    """Die Arten, die dieses Rig annimmt (MP-1): die vier Basis-Arten, dazu die eingeschalteten ohne Datei."""
    arten = list(ARTEN_MIT_DATEI)
    if cfg.suche_aktiv:
        arten.append("nas_suche")
    if cfg.archiv_frage_aktiv:
        arten.append("archiv_frage")
    if getattr(cfg, "vorschau_aktiv", False):
        arten.append("vorschau")
    return tuple(arten)


def pause_leer(cfg: Einstellungen, naechster_poll_ms: int | None) -> float:
    """Wartezeit nach einem leeren Poll: normal KI_POLL_MS; solange das FSM naechster_poll_ms schickt (jemand hat
    die Suche/das Archiv offen), max(250 ms, naechster_poll_ms) — höchstens der normale Takt."""
    if not naechster_poll_ms:
        return cfg.poll_intervall_s
    return min(cfg.poll_intervall_s, max(EILIG_MIN_S, naechster_poll_ms / 1000.0))
MAX_AUSSTEHEND = 50
RESTE_MAX_ALTER_S = 3600
HERZSCHLAG_S = 20.0
NACHMELDEN_PAUSE_S = 30.0
# Die Ordnerliste des FSM (aktive Ordner, Vererbung schon angewandt) kommt nur mit einem Ablage-Auftrag.
# Der Dienst merkt sie sich im Tresor (<KI_DATA_DIR>/fsm-ordnerliste.json, nur Pfade, keine Dokumente),
# damit der Probelauf mit derselben Liste messen kann (--ordner-datei). Bleibt auf dem Rig.
ORDNERLISTE_DATEI = "fsm-ordnerliste.json"


class Zustand:
    """Was /health und der Herzschlag zeigen — ohne Inhalte."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.warteschlange = 0
        self.laeuft: str | None = None
        self.letzter_poll: float | None = None
        # Letzte erfolgreiche Meldung ans FSM, die ki_status auffrischt (Poll oder Herzschlag).
        self.letzter_kontakt = 0.0
        self.letzter_fehler: str | None = None
        self.verarbeitet = 0
        self.fsm_ok = False
        # Ende des letzten Auftrags (monotonic) — der Archiv-Index wartet danach eine Ruhepause ab.
        self.letzte_arbeit = 0.0
        # Art, an der der Worker gerade ist — vom Abholen bis das Ergebnis gemeldet ist (die leichte Spur fragt nur dann).
        self.beschaeftigt: str | None = None
        # Aufträge der leichten Spur in Arbeit (zählen für ruhig() wie ein laufender Auftrag).
        self.leicht_laeuft = 0

    def setze(self, **werte: Any) -> None:
        with self._lock:
            for k, v in werte.items():
                setattr(self, k, v)

    def lies(self, name: str) -> Any:
        with self._lock:
            return getattr(self, name)

    def erhoehe(self, name: str) -> None:
        """Zähler +1 (Worker und leichte Spur zählen gleichzeitig)."""
        with self._lock:
            setattr(self, name, getattr(self, name) + 1)

    def leicht_beginnt(self) -> None:
        with self._lock:
            self.leicht_laeuft += 1

    def leicht_endet(self) -> None:
        with self._lock:
            self.leicht_laeuft = max(0, self.leicht_laeuft - 1)
            self.letzte_arbeit = time.monotonic()

    def ruhig(self, pause_s: float) -> bool:
        """Kein Auftrag läuft oder wartet (auch keiner der leichten Spur), und der letzte ist mindestens pause_s her."""
        with self._lock:
            return (self.laeuft is None and self.leicht_laeuft == 0 and self.warteschlange == 0
                    and time.monotonic() - self.letzte_arbeit >= pause_s)

    def bild(self) -> dict[str, Any]:
        with self._lock:
            return {
                "warteschlange": self.warteschlange,
                "laeuft": self.laeuft,
                "leicht_laeuft": self.leicht_laeuft,
                "letzter_poll": self.letzter_poll,
                "letzter_fehler": self.letzter_fehler,
                "verarbeitet": self.verarbeitet,
                "fsm_ok": self.fsm_ok,
            }


class Herzschlag(threading.Thread):
    """Solange ein Auftrag läuft: alle 20 s GET /api/ki/sync?nur_herzschlag=1 (Vertrag V1)."""

    def __init__(self, fsm: FsmClient, zustand: Zustand, werte: Callable[[], dict[str, str]]) -> None:
        super().__init__(name="ki-herzschlag", daemon=True)
        self.fsm = fsm
        self.zustand = zustand
        self.werte = werte
        self._halt = threading.Event()

    def stop(self) -> None:
        self._halt.set()

    def run(self) -> None:
        while not self._halt.wait(1.0):
            if self.zustand.lies("laeuft") is None:
                continue
            if time.monotonic() - self.zustand.lies("letzter_kontakt") < HERZSCHLAG_S:
                continue
            try:
                self.fsm.herzschlag(self.werte())
                self.zustand.setze(letzter_kontakt=time.monotonic(), letzter_poll=time.time())
            except FsmFehler as e:
                # Nächster Versuch nach dem regulären Abstand — nicht im Sekundentakt.
                self.zustand.setze(letzter_kontakt=time.monotonic())
                log.warning("%s", e)
            except Exception:  # noqa: BLE001 — der Herzschlag darf nie sterben
                self.zustand.setze(letzter_kontakt=time.monotonic())
                log.exception("Unerwarteter Fehler im Herzschlag")


class Worker(threading.Thread):
    def __init__(
        self,
        cfg: Einstellungen,
        fsm: FsmClient,
        llm: Ollama,
        whisper: Whisper,
        protokoll: Protokoll,
        zustand: Zustand,
        archiv: ArchivIndex | None = None,
        suche: Suche | None = None,
        lernen: Any = None,
        doppel: Callable[[str, str, str], dict[str, Any] | None] | None = None,
        fsm_leicht: FsmClient | None = None,
    ) -> None:
        super().__init__(name="ki-worker", daemon=True)
        # Doppel-Prüfung der Ablage gegen das NAS (duplikate.pruefe_neue_datei) — optional, wirft nie nach aussen.
        self.doppel = doppel
        # Vorschaubilder: Zwischenspeicher nur im Tresor (vorschau.py).
        self.vorschau_speicher = VorschauSpeicher(cfg.data_dir / "vorschau")
        self.cfg = cfg
        self.fsm = fsm
        self.llm = llm
        self.whisper = whisper
        self.protokoll = protokoll
        self.zustand = zustand
        self.archiv = archiv
        # Inhaltssuche / Frag das Archiv (E2.6) und Live-Trefferquote (E2.7, jobs/lernen.Lernen) — optional.
        self.suche = suche
        self.lernen = lernen
        self.arten = arten_aktiv(cfg)
        self._halt = threading.Event()
        self._ausstehend: list[dict[str, Any]] = []
        self._letzte_aufraeumung = 0.0
        self._naechstes_nachmelden = 0.0
        self._ordnerliste_hash: str | None = None
        self._herzschlag = Herzschlag(fsm, zustand, self._herzschlag_werte)
        # Aufträge, die die leichte Spur beansprucht bekam, aber nicht nehmen darf (nur bei einem FSM ohne «nur»): der
        # Worker bearbeitet sie vor dem nächsten Abholen.
        self._uebergabe: queue.Queue[Auftrag] = queue.Queue()
        # Leichte Spur mit eigenem FSM-Client — nur, wenn eine leichte Art eingeschaltet ist.
        self.leicht = LeichteSpur(self, fsm_leicht) if fsm_leicht is not None and any(a in self.arten for a in ARTEN_LEICHT) else None

    def stop(self) -> None:
        self._halt.set()
        self._herzschlag.stop()
        if self.leicht is not None:
            self.leicht.stop()

    def uebergeben(self, auftrag: Auftrag) -> None:
        self._uebergabe.put(auftrag)

    def _uebergebene(self) -> list[Auftrag]:
        aus: list[Auftrag] = []
        while True:
            try:
                aus.append(self._uebergabe.get_nowait())
            except queue.Empty:
                return aus

    # --- Schleife -----------------------------------------------------------

    def run(self) -> None:
        log.info("Worker gestartet — Abfrage alle %.1f s bei %s", self.cfg.poll_intervall_s, self.cfg.fsm_url)
        self._herzschlag.start()
        if self.leicht is not None:
            self.leicht.start()
        pause = self.cfg.poll_intervall_s
        while not self._halt.is_set():
            self._aufraeumen()
            self._nachmelden()
            auftraege = self._uebergebene()
            if not auftraege:
                try:
                    auftraege = self.fsm.hole_auftraege(self._herzschlag_werte())
                    self.zustand.setze(
                        letzter_poll=time.time(), letzter_kontakt=time.monotonic(), fsm_ok=True, letzter_fehler=None,
                    )
                    pause = self.cfg.poll_intervall_s
                except FsmFehler as e:
                    self.zustand.setze(fsm_ok=False, letzter_fehler=str(e))
                    log.warning("%s — nächster Versuch in %.0f s", e, pause)
                    self._halt.wait(pause)
                    pause = min(pause * 2, 30.0)
                    continue
                except Exception:  # noqa: BLE001 — die Schleife darf nie sterben
                    log.exception("Unerwarteter Fehler beim Abholen")
                    self._halt.wait(5)
                    continue

            if not auftraege:
                # Nur im Leerlauf vorladen: mit Arbeit in der Hand nähme das Laden der GPU-Schleuse ~2 s weg.
                self._wach_impuls()
                self._halt.wait(pause_leer(self.cfg, getattr(self.fsm, "naechster_poll_ms", None)))
                continue

            self.zustand.setze(warteschlange=len(auftraege))
            for i, auftrag in enumerate(auftraege):
                if self._halt.is_set():
                    break
                # Beschäftigt vom Abholen bis das Ergebnis gemeldet ist — so lange holt die leichte Spur Vorschauen.
                self.zustand.setze(beschaeftigt=auftrag.art)
                ergebnis = self._verarbeite(auftrag)
                self.zustand.setze(warteschlange=len(auftraege) - i - 1, laeuft=None, letzte_arbeit=time.monotonic())
                self._melde(ergebnis)
            self.zustand.setze(beschaeftigt=None)
            # Es gab Arbeit: sofort wieder nachfragen, ohne Pause.
        log.info("Worker beendet")

    def _wach_impuls(self) -> None:
        """MP-2: schickt das FSM naechster_poll_ms (jemand hat die Suche/das Archiv offen), lädt die Suche das
        Einbettungsmodell im Hintergrund vor — wartet nie, wirft nie (Suche.vorwaermen)."""
        if self.suche is None or not getattr(self.fsm, "naechster_poll_ms", None):
            return
        if "nas_suche" not in self.arten and "archiv_frage" not in self.arten:
            return
        try:
            self.suche.vorwaermen()
        except Exception:  # noqa: BLE001 — Vorladen ist nur ein Vorteil
            log.exception("Vorladen der Inhaltssuche fehlgeschlagen")

    def _herzschlag_werte(self) -> dict[str, str]:
        werte = {
            "modell": self.cfg.modell_text,
            "version": f"{VERSION}+{self.cfg.build}",
            "gpu": gpu_kurz(),
            "warteschlange": str(self.zustand.lies("warteschlange") + len(self._ausstehend)),
            # MP-1: an jedem Poll, auch nur_herzschlag — das FSM schaltet daran neue Funktionen ein und aus.
            "arten": ",".join(self.arten),
        }
        # Leere Angaben weglassen — das FSM behält dann den letzten bekannten Wert.
        return {k: v for k, v in werte.items() if v}

    def _melde(self, ergebnis: dict[str, Any]) -> None:
        try:
            self.fsm.melde_ergebnisse([ergebnis])
        except FsmAbgelehnt as e:
            log.warning("Ergebnis %s verworfen: %s", ergebnis.get("id"), e)
        except FsmFehler as e:
            log.warning("Ergebnis %s zurückgestellt: %s", ergebnis.get("id"), e)
            self._ausstehend.append(ergebnis)
            if len(self._ausstehend) > MAX_AUSSTEHEND:
                del self._ausstehend[: len(self._ausstehend) - MAX_AUSSTEHEND]

    def _nachmelden(self) -> None:
        """Zurückgestellte Ergebnisse höchstens alle 30 s erneut senden — blockiert das Abholen nie."""
        if not self._ausstehend or time.monotonic() < self._naechstes_nachmelden:
            return
        liste = self._ausstehend[:20]
        try:
            self.fsm.melde_ergebnisse(liste)
            log.info("%d zurückgestellte Ergebnisse nachgemeldet", len(liste))
        except FsmAbgelehnt as e:
            log.warning("%d zurückgestellte Ergebnisse verworfen: %s", len(liste), e)
        except FsmFehler as e:
            self._naechstes_nachmelden = time.monotonic() + NACHMELDEN_PAUSE_S
            log.warning("Nachmelden fehlgeschlagen (%s) — nächster Versuch in %.0f s", e, NACHMELDEN_PAUSE_S)
            return
        del self._ausstehend[: len(liste)]

    def _aufraeumen(self) -> None:
        """Reste abgebrochener Läufe (Absturz, Neustart) nach einer Stunde löschen."""
        if time.monotonic() - self._letzte_aufraeumung < 600:
            return
        self._letzte_aufraeumung = time.monotonic()
        try:
            self.cfg.tmp_dir.mkdir(parents=True, exist_ok=True)
            grenze = time.time() - RESTE_MAX_ALTER_S
            for eintrag in self.cfg.tmp_dir.iterdir():
                try:
                    if eintrag.is_file() and eintrag.stat().st_mtime < grenze:
                        eintrag.unlink()
                except OSError:
                    pass
        except OSError as e:
            log.warning("Aufräumen in %s nicht möglich (%s)", self.cfg.tmp_dir, type(e).__name__)

    def _merke_ordnerliste(self, kontext: dict[str, Any]) -> None:
        """Ordnerliste aus dem FSM-Kontext im Tresor ablegen (nur bei Änderung) — für den Probelauf."""
        ordner = kontext.get("ordner") if isinstance(kontext, dict) else None
        if not isinstance(ordner, list) or not ordner:
            return
        pfade = [o if isinstance(o, str) else str((o or {}).get("pfad") or "") for o in ordner]
        pfade = [p for p in pfade if p]
        h = hashlib.sha256("\n".join(pfade).encode("utf-8")).hexdigest()
        if h == self._ordnerliste_hash:
            return
        try:
            self.cfg.data_dir.mkdir(parents=True, exist_ok=True)
            ziel = self.cfg.data_dir / ORDNERLISTE_DATEI
            tmp = ziel.with_suffix(".json.neu")
            tmp.write_text(
                json.dumps(
                    {"zeit": datetime.now(timezone.utc).isoformat(timespec="seconds"), "anzahl": len(pfade), "ordner": pfade},
                    ensure_ascii=False, indent=0,
                ),
                encoding="utf-8",
            )
            tmp.replace(ziel)
            self._ordnerliste_hash = h
            log.info("FSM-Ordnerliste gemerkt: %d Pfade (%s)", len(pfade), ziel.name)
        except OSError as e:
            log.warning("FSM-Ordnerliste nicht gespeichert (%s)", type(e).__name__)

    # --- Verarbeitung -------------------------------------------------------

    @contextmanager
    def _datei(self, auftrag: Auftrag) -> Iterator[tuple[Path, int, str]]:
        self.cfg.tmp_dir.mkdir(parents=True, exist_ok=True)
        m = _ENDUNG.search(auftrag.dateiname or "")
        endung = f".{m.group(1).lower()}" if m else ""
        pfad = self.cfg.tmp_dir / f"{uuid.uuid4().hex}{endung}"
        max_mb = self.cfg.diktat_max_mb if auftrag.art == "diktat" else self.cfg.max_datei_mb
        try:
            groesse, sha = self.fsm.lade_datei(auftrag.url or "", pfad, max_mb * 1024 * 1024)
            yield pfad, groesse, sha
        finally:
            try:
                pfad.unlink(missing_ok=True)
            except OSError:
                pass

    def _ohne_datei(self, auftrag: Auftrag) -> tuple[dict[str, Any], str | None]:
        """nas_suche / archiv_frage (MP-3/MP-4). Nie den Suchbegriff oder die Frage loggen."""
        if auftrag.art not in self.arten:
            raise VerarbeitungsFehler(f"«{auftrag.art}» ist auf dem Rig nicht eingeschaltet")
        if auftrag.art == "vorschau":
            return vorschau(auftrag.payload, self.cfg, self.vorschau_speicher), None
        if self.suche is None:
            raise VerarbeitungsFehler("Inhaltssuche: Tiefen-Index nicht verfügbar")
        if auftrag.art == "nas_suche":
            return nas_suche(auftrag.payload, self.suche), self.cfg.modell_embed
        return archiv_frage(auftrag.payload, self.suche, self.llm, self.cfg)

    def _verarbeite(self, auftrag: Auftrag, *, leicht: bool = False) -> dict[str, Any]:
        """Einen Auftrag bearbeiten → Ergebnis fürs FSM. leicht = aus der leichten Spur (zählt in leicht_laeuft, nicht in
        laeuft — das bleibt der Auftrag des Workers)."""
        start = time.monotonic()
        if not leicht:
            self.zustand.setze(laeuft=auftrag.art)
        modell: str | None = None
        # Kennzahlen des Dokuments fürs Protokoll (Seiten, Zeichen, gescannt, Teile) — nur Zahlen, nie ans FSM.
        kennzahlen: dict[str, Any] = {}
        try:
            if auftrag.art in ARTEN_OHNE_DATEI:
                ergebnis, modell = self._ohne_datei(auftrag)
                dauer = int((time.monotonic() - start) * 1000)
                self.protokoll.schreibe(auftrag.art, "fsm", dauer, modell, True)
                self.zustand.erhoehe("verarbeitet")
                log.info("%s %s fertig in %d ms (%s)", auftrag.art, auftrag.id, dauer, modell)
                return {"id": auftrag.id, "ok": True, "ergebnis": ergebnis}
            if auftrag.art not in ARTEN_MIT_DATEI:
                raise VerarbeitungsFehler(f"Unbekannte Auftragsart «{auftrag.art or '?'}»")
            if not auftrag.url:
                raise VerarbeitungsFehler("Auftrag ohne signierte Datei-URL")
            with self._datei(auftrag) as (pfad, _groesse, sha):
                if auftrag.art == "ablage_analyse":
                    self._merke_ordnerliste(auftrag.kontext)
                    # messung bekommt nur Zähler/Quelle der Ordnerwahl (geht nie ans FSM, ändert das Ergebnis nicht).
                    messung: dict[str, Any] | None = {} if self.lernen is not None else None
                    ergebnis = ablage_analyse(
                        pfad=pfad,
                        dateiname=auftrag.dateiname,
                        mime=auftrag.mime,
                        sha256=sha,
                        kontext_roh=auftrag.kontext,
                        llm=self.llm,
                        cfg=self.cfg,
                        archiv=self.archiv,
                        messung=messung,
                        doppel=self.doppel,
                        kennzahlen=kennzahlen,
                    )
                    modell = str(ergebnis.get("modell"))
                    if self.lernen is not None:
                        # E2.7: nur sha256 + Ordnerpfade in die Warteschlange — wartet nie, wirft nie.
                        self.lernen.merke(ergebnis, messung)
                elif auftrag.art in ("beleg_analyse", "warenkorb_analyse"):
                    # Ein Foto: das Bildmodell liest es als Ganzes (eine Seite, ein Teil, kein herausgezogener Text).
                    kennzahlen.update(BILD_KENNZAHLEN)
                    analyse = beleg_analyse if auftrag.art == "beleg_analyse" else warenkorb_analyse
                    ergebnis, modell = analyse(pfad=pfad, llm=self.llm, cfg=self.cfg)
                else:
                    ergebnis, modell = diktat(pfad=pfad, whisper=self.whisper, llm=self.llm, cfg=self.cfg)
            dauer = int((time.monotonic() - start) * 1000)
            self.protokoll.schreibe(auftrag.art, "fsm", dauer, modell, True, **kennzahlen)
            self.zustand.erhoehe("verarbeitet")
            log.info("%s %s fertig in %d ms (%s)", auftrag.art, auftrag.id, dauer, modell)
            return {"id": auftrag.id, "ok": True, "ergebnis": ergebnis}
        except (VerarbeitungsFehler, FsmFehler) as e:
            text = str(e)[:300]
            dauer = int((time.monotonic() - start) * 1000)
            log.warning("%s %s fehlgeschlagen nach %d ms: %s", auftrag.art, auftrag.id, dauer, text)
            self.protokoll.schreibe(auftrag.art, "fsm", dauer, modell, False, text, **kennzahlen)
            return {"id": auftrag.id, "ok": False, "fehler": text}
        except Exception as e:  # noqa: BLE001 — Klartext nach aussen, Details nur im Log
            text = f"Unerwarteter Fehler ({type(e).__name__})"
            dauer = int((time.monotonic() - start) * 1000)
            log.exception("%s %s: unerwarteter Fehler", auftrag.art, auftrag.id)
            self.protokoll.schreibe(auftrag.art, "fsm", dauer, modell, False, text, **kennzahlen)
            return {"id": auftrag.id, "ok": False, "fehler": text}


class LeichteSpur(threading.Thread):
    """Leichte Spur (16.10.2026, «Wartende haben Vorrang»): solange der Worker beschäftigt ist (Auftrag in Arbeit bis zur
    Meldung, z. B. eine Ablage mit Texterkennung), holt dieser Thread NUR leichte Arten (ARTEN_LEICHT) beim FSM ab
    (GET /api/ki/sync?nur=…, eigener FSM-Client) und bearbeitet höchstens `parallel` gleichzeitig — jede in einem eigenen
    kurzen Thread. Ist der Worker frei, holt er selbst ab (kein doppeltes Abfragen, kein Mehrverkehr im Leerlauf).

    Gefragt wird nur, wenn die letzte Antwort des FSM die Arten als leicht nannte (leichte_arten); nennt eine Antwort sie
    nicht mehr (FSM zurückgerollt), schweigt die Spur, bis die normale Abholung sie wieder sieht. Bekäme die Spur doch
    einen anderen Auftrag, übergibt sie ihn dem Worker (er ist schon beansprucht). Ergebnisse gehen sofort ans FSM;
    scheitert die Meldung, verfällt die Vorschau (die Route wartet höchstens 9 s) — kein Nachmelden."""

    def __init__(self, worker: Worker, fsm: FsmClient, parallel: int = LEICHT_PARALLEL) -> None:
        super().__init__(name="ki-leicht", daemon=True)
        self.worker = worker
        self.fsm = fsm
        self.parallel = parallel
        self._platz = threading.Semaphore(parallel)
        self._halt = threading.Event()
        self._lock = threading.Lock()
        self.bearbeitet = 0
        self.nicht_gemeldet = 0

    def stop(self) -> None:
        self._halt.set()

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {"aktiv": self.is_alive(), "parallel": self.parallel, "bearbeitet": self.bearbeitet,
                    "nicht_gemeldet": self.nicht_gemeldet, "fsm_kennt": list(getattr(self.worker.fsm, "leichte_arten", ()))}

    def arten(self) -> tuple[str, ...]:
        """Was die Spur jetzt abholen darf: leicht, auf dem Rig eingeschaltet und vom FSM als leicht genannt."""
        fsm = set(getattr(self.worker.fsm, "leichte_arten", ()))
        return tuple(a for a in ARTEN_LEICHT if a in self.worker.arten and a in fsm)

    def gefragt(self) -> bool:
        """Nur während der Worker an einem Auftrag ist, der nicht selbst leicht ist — sonst holt er gleich selbst ab."""
        b = self.worker.zustand.lies("beschaeftigt")
        return b is not None and b not in ARTEN_LEICHT

    def run(self) -> None:
        log.info("Leichte Spur bereit — %s, höchstens %d gleichzeitig", ",".join(ARTEN_LEICHT), self.parallel)
        fehler_pause = 1.0
        while not self._halt.is_set():
            arten = self.arten()
            if not arten or not self.gefragt():
                self._halt.wait(LEICHT_TAKT_S)
                continue
            if not self._platz.acquire(timeout=0.5):
                continue
            try:
                auftraege = self.fsm.hole_auftraege(self.worker._herzschlag_werte(), nur=arten)
            except FsmFehler as e:
                self._platz.release()
                log.warning("Leichte Spur: %s — nächster Versuch in %.0f s", e, fehler_pause)
                self._halt.wait(fehler_pause)
                fehler_pause = min(fehler_pause * 2, 30.0)
                continue
            except Exception:  # noqa: BLE001 — die Spur darf nie sterben
                self._platz.release()
                log.exception("Leichte Spur: unerwarteter Fehler beim Abholen")
                self._halt.wait(5.0)
                continue
            fehler_pause = 1.0
            # Der Poll ist auch ein Herzschlag (ki_status.letzter_poll) — der Herzschlag-Thread spart sich seinen.
            self.worker.zustand.setze(letzter_poll=time.time(), letzter_kontakt=time.monotonic())
            if not set(arten) <= set(self.fsm.leichte_arten):
                self.worker.fsm.leichte_arten = ()
            erster = next((a for a in auftraege if a.art in ARTEN_LEICHT), None)
            for a in auftraege:
                if a is not erster:
                    # Schon beansprucht, aber nicht für die Spur (FSM ohne «nur», mehr als einer): der Worker nimmt ihn.
                    log.warning("Leichte Spur: %s %s an den Worker übergeben", a.art, a.id)
                    self.worker.uebergeben(a)
            if erster is None:
                self._platz.release()
                if not auftraege:
                    self._halt.wait(pause_leer(self.worker.cfg, self.fsm.naechster_poll_ms))
                continue
            # Sofort weiter: der nächste Poll, sobald ein Platz frei ist.
            threading.Thread(target=self._bearbeite, args=(erster,), name="ki-leicht-auftrag", daemon=True).start()
        log.info("Leichte Spur beendet")

    def _bearbeite(self, auftrag: Auftrag) -> None:
        """Bearbeiten und melden; der Platz wird erst nach der Meldung frei — so sind nie mehr als `parallel` Aufträge
        unterwegs, auch wenn das FSM langsam antwortet."""
        z = self.worker.zustand
        try:
            z.leicht_beginnt()
            try:
                ergebnis = self.worker._verarbeite(auftrag, leicht=True)
            except Exception:  # noqa: BLE001 — _verarbeite fängt selbst alles; nur zur Sicherheit
                log.exception("Leichte Spur: unerwarteter Fehler bei %s", auftrag.art)
                ergebnis = {"id": auftrag.id, "ok": False, "fehler": "Unerwarteter Fehler"}
            finally:
                z.leicht_endet()
            with self._lock:
                self.bearbeitet += 1
            try:
                self.fsm.melde_ergebnisse([ergebnis])
            except FsmFehler as e:
                with self._lock:
                    self.nicht_gemeldet += 1
                log.warning("Leichte Spur: Ergebnis %s nicht gemeldet (%s)", auftrag.id, e)
        finally:
            self._platz.release()
