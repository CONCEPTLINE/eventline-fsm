"""FastAPI-Einstieg: /health, Direkt-API (/v1/archiv/frage, Phase 3), Worker-Start.

Fehler kommen immer als JSON mit deutschem Klartext zurück — nie als
Stacktrace, nie mit Inhalten. CORS nur für die Ursprünge aus KI_CORS_ORIGINS.
Ein Prozess, ein Worker-Thread: uvicorn ohne --workers starten.

Das Diktat läuft über die Warteschlange des FSM (Auftragsart «diktat»), nicht
direkt aus dem Browser: ki.in.eventline-basel.com ist aus dem Büro-Netz wegen
des DNS-Rebind-Schutzes nicht auflösbar und unterwegs ohnehin nicht erreichbar.
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import VERSION
from .archiv import RUHE_S, ArchivIndex, Indexierer, rezept_fuer
from .config import EINSTELLUNGEN as cfg
from .fsm import FsmClient
from .gpu import gpu_info
from .hintergrund import Hintergrund
from .jobs import JobListe
from .jobs.lernen import Lernen
from .jobs.tiefe import STAND_DATEI, TiefenJob, lies_stand
from .llm import Ollama
from .nachtarbeit import RUHE_S as NACHT_RUHE_S, Nachtarbeit, fuer_dienst as nachtarbeit_fuer_dienst
from .protokoll import Protokoll
from .sicherheit import RUHE_S as SICHERHEIT_RUHE_S, SicherheitsRapport
from .speicher import Quellen, bild, messen
from .suche import Suche
from .technik import TechnikMelder
from .tiefe import RUHE_S as TIEFE_RUHE_S, TiefenIndex, TiefenIndexierer
from .ticket import TicketFehler, pruefe_ticket, ticket_aus_header
from .whisper import Whisper
from .worker import Worker, Zustand

logging.basicConfig(
    level=os.environ.get("KI_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
# httpx/httpcore schreiben auf INFO jede Anfrage samt Query-String ins Log — bei
# signierten Download-URLs wäre das die Signatur (SPEC §1.6: nie in Logs). Deshalb
# nur noch Warnungen dieser Bibliotheken, unabhängig von KI_LOG_LEVEL.
for _bib in ("httpx", "httpcore"):
    logging.getLogger(_bib).setLevel(logging.WARNING)
# pypdf meldet kaputte PDF-Strukturen («Ignoring wrong pointing object …») als Warnung — beim
# nächtlichen Indexlauf über das ganze NAS nur Rauschen; echte Lesefehler meldet extract.py selbst.
logging.getLogger("pypdf").setLevel(logging.ERROR)
log = logging.getLogger("ki.main")

zustand = Zustand()
protokoll = Protokoll(cfg.pg_dsn)
llm = Ollama(cfg)
whisper = Whisper(cfg)
fsm = FsmClient(cfg)
archiv = ArchivIndex(cfg.pg_dsn, rezept_fuer(cfg))
# Hauptmodell (Masterplan §2.2–§2.6): eigene Instanz «gruendlich», nie mit der GPU-Schleuse.
llm_hg = Ollama(cfg, base_url=cfg.hg_url, schleuse=False)
speicher_quellen = Quellen(slice_dir=cfg.hg_slice_dir)
worker: Worker | None = None
indexierer: Indexierer | None = None
hintergrund: Hintergrund | None = None
# Tiefen-Index (E2.5), Inhaltssuche/Frag das Archiv (E2.6), Live-Trefferquote (E2.7) — je hinter einem Schalter.
tiefen_job: TiefenJob | None = None
suche: Suche | None = None
lernen: Lernen | None = None
# Nachtarbeit (Masterplan Etappe 4: Fristen, Rückstau ZZ, Selbsttest) — nur mit einem Schalter KI_JOB_*.
nachtarbeit: Nachtarbeit | None = None
# Technik-Dashboard: Messwerte jede Minute ans FSM (KI_TECHNIK_AKTIV, Standard an).
technik: TechnikMelder | None = None
# Sicherheits-Rapport: Klartext zum täglichen Sicherheits-Check des FSM (KI_SICHERHEIT_AKTIV, Standard an).
sicherheit: SicherheitsRapport | None = None


def _vorbilder_laeuft() -> bool:
    return indexierer is not None and indexierer.laeuft


def _hauptmodell_aktiv() -> bool:
    """Hauptmodell geladen oder lädt: der Tiefen-Index liest dann nicht (OCR und Einbettungen nicht neben 16 GB)."""
    return hintergrund is not None and hintergrund.speicher_relevant()


@asynccontextmanager
async def lebenszyklus(_app: FastAPI):
    global worker, indexierer, hintergrund, tiefen_job, suche, lernen, nachtarbeit, technik, sicherheit
    log.info("EVENTLINE Lokale KI %s startet — %s", VERSION, cfg.uebersicht())
    try:
        cfg.tmp_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        log.error("Temp-Verzeichnis %s nicht beschreibbar (%s)", cfg.tmp_dir, type(e).__name__)
    await asyncio.to_thread(protokoll.start)
    if (cfg.suche_aktiv or cfg.archiv_frage_aktiv) and cfg.pg_dsn:
        # Eigene DB-Verbindung mit statement_timeout: eine Suche wartet nie hinter dem Indexlauf.
        suche = Suche(
            cfg, TiefenIndex(cfg.pg_dsn, statement_timeout_ms=5000), llm,
            stand=lambda: tiefen_job.stand if tiefen_job is not None else lies_stand(cfg.data_dir / STAND_DATEI),
        )
    elif cfg.suche_aktiv or cfg.archiv_frage_aktiv:
        log.error("KI_SUCHE_AKTIV/KI_ARCHIV_FRAGE_AKTIV=1, aber PG_PASSWORD fehlt — Arten bleiben aus")
    if cfg.lernen_aktiv and cfg.pg_dsn:
        lernen = Lernen(cfg.pg_dsn, vorbilder_lauf=lambda: indexierer.letzter_lauf if indexierer is not None else None)
        lernen.start()
    if not cfg.sync_token:
        log.error("KI_SYNC_TOKEN fehlt — die Warteschlange bleibt aus")
    else:
        worker = Worker(cfg, fsm, llm, whisper, protokoll, zustand, archiv=archiv, suche=suche, lernen=lernen)
        worker.start()
    if archiv.aktiv:
        # Vorbilder für die Ordnerwahl: Lauf beim Start (sobald Ruhe ist) und jede Nacht.
        indexierer = Indexierer(cfg, archiv, llm, lambda: zustand.ruhig(RUHE_S))
        indexierer.start()
    else:
        log.warning("Archiv-Index aus: PG_PASSWORD fehlt — Ordnerwahl ohne Vorbilder")
    if cfg.tiefe_aktiv and cfg.pg_dsn:
        # Nachts, höchstens KI_TIEFE_MAX_H; der Vorbilder-Index hat Vorrang (Reihenfolge der Nacht, §2.3), und
        # neben einem geladenen Hauptmodell wird nicht gelesen.
        tiefen_job = TiefenJob(
            cfg,
            TiefenIndexierer(
                cfg, TiefenIndex(cfg.pg_dsn), llm, lambda: zustand.ruhig(TIEFE_RUHE_S),
                vorrang=lambda: _vorbilder_laeuft() or _hauptmodell_aktiv(),
            ),
            vorbilder_laeuft=_vorbilder_laeuft,
            hauptmodell_aktiv=_hauptmodell_aktiv,
        )
        tiefen_job.start()
    elif cfg.tiefe_aktiv:
        log.error("KI_TIEFE_AKTIV=1, aber PG_PASSWORD fehlt — Tiefen-Index bleibt aus")
    if cfg.hg_aktiv:
        if not cfg.pg_dsn:
            log.error("KI_HG_AKTIV=1, aber PG_PASSWORD fehlt — Hauptmodell bleibt aus (Job-Liste im Tresor nötig)")
        elif not cfg.hg_modelle:
            log.error("KI_HG_AKTIV=1, aber KI_HG_MODELLE ist leer/ungültig — Hauptmodell bleibt aus")
        else:
            hintergrund = Hintergrund(
                cfg, llm_hg, JobListe(cfg.pg_dsn), protokoll, zustand,
                # Reihenfolge der Nacht (§2.3): erst Vorbilder-Index, dann Tiefen-Index, dann das Hauptmodell.
                vorarbeit_laeuft=lambda: _vorbilder_laeuft() or (tiefen_job is not None and tiefen_job.laeuft),
            )
            hintergrund.start()
    if cfg.nachtarbeit_aktiv:
        if not cfg.pg_dsn or not cfg.sync_token:
            log.error("KI_JOB_*=1, aber PG_PASSWORD oder KI_SYNC_TOKEN fehlt — Nachtarbeit bleibt aus")
        else:
            # Schnelles Modell auf der GPU-Instanz (llm, mit Schleuse); eigener FSM-Client, damit eine lange Meldung
            # nie das Abholen des Workers aufhält. Reihenfolge der Nacht: erst Vorbilder- und Tiefen-Index.
            nachtarbeit = nachtarbeit_fuer_dienst(
                cfg, FsmClient(cfg), llm, archiv, protokoll,
                ruhig=lambda: zustand.ruhig(NACHT_RUHE_S),
                vorarbeit_laeuft=lambda: _vorbilder_laeuft() or (tiefen_job is not None and tiefen_job.laeuft)
                or _hauptmodell_aktiv(),
            )
            nachtarbeit.start()
    if cfg.technik_aktiv and cfg.sync_token:
        technik = TechnikMelder(cfg, lambda: zustand.lies("laeuft"), lambda: health())
        technik.start()
    if cfg.sicherheit_aktiv and cfg.sync_token:
        # Schnelles Modell mit Schleuse (wie die Aufträge); gerechnet wird nur, wenn die Warteschlange ruht.
        sicherheit = SicherheitsRapport(cfg, llm, lambda: zustand.ruhig(SICHERHEIT_RUHE_S))
        sicherheit.start()
    yield
    if sicherheit is not None:
        sicherheit.stop()
        sicherheit.join(timeout=15)
        sicherheit.schliessen()
    if technik is not None:
        technik.stop()
        technik.join(timeout=20)
        technik.schliessen()
    if nachtarbeit is not None:
        nachtarbeit.stop()
        nachtarbeit.join(timeout=15)
        nachtarbeit.speicher.schliessen()
    if hintergrund is not None:
        # Zuerst: trennt einen laufenden Schritt und entlädt das Hauptmodell.
        hintergrund.stop()
        hintergrund.join(timeout=20)
        hintergrund.liste.schliessen()
    if tiefen_job is not None:
        # Beendet auch einen laufenden Extraktions-Kindprozess (Prozessgruppe).
        tiefen_job.stop()
    if indexierer is not None:
        indexierer.stop()
    if worker is not None:
        worker.stop()
        worker.join(timeout=15)
    if indexierer is not None:
        indexierer.join(timeout=15)
    if tiefen_job is not None:
        tiefen_job.join(timeout=15)
        tiefen_job.ix.index.schliessen()
    if lernen is not None:
        lernen.stop()
        lernen.join(timeout=35)
    if suche is not None:
        suche.index.schliessen()
    archiv.schliessen()
    protokoll.schliessen()
    fsm.schliessen()
    llm.schliessen()
    llm_hg.schliessen()
    whisper.schliessen()


app = FastAPI(
    title="EVENTLINE Lokale KI",
    version=VERSION,
    lifespan=lebenszyklus,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

if cfg.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(cfg.cors_origins),
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        max_age=600,
    )


def fehler(status: int, text: str) -> JSONResponse:
    return JSONResponse({"error": text}, status_code=status)


@app.exception_handler(Exception)
async def unerwartet(_request: Request, exc: Exception) -> JSONResponse:
    log.error("Unerwarteter Fehler in der API: %s", type(exc).__name__)
    return fehler(500, "Interner Fehler der lokalen KI")


@app.exception_handler(RequestValidationError)
async def ungueltig(_request: Request, _exc: RequestValidationError) -> JSONResponse:
    return fehler(400, "Ungültige Anfrage")


# --- Gesundheit ---------------------------------------------------------------


@app.get("/health")
def health() -> dict[str, Any]:
    # Archiv-Index (Vorbilder für die Ordnerwahl): Anzahl (höchstens 30 s alt), letzter Lauf, läuft gerade.
    if indexierer is not None:
        archiv_status = indexierer.status()
    else:
        archiv_status = {"aktiv": False, "anzahl": 0, "letzter_lauf": None, "laeuft": False, "letzte_bilanz": None}
    return {
        "ok": True,
        "version": f"{VERSION}+{cfg.build}",
        "modell": cfg.modell_text,
        "gpu": gpu_info(),
        "warteschlange": zustand.bild()["warteschlange"],
        # Art des Auftrags in Arbeit (nur der Name der Art) — der Trockenlauf der Nachtarbeit wartet darauf.
        "laeuft": zustand.bild()["laeuft"],
        "archiv": archiv_status,
        # Hauptmodell (Planer, Wächter, Job-Liste) und Speicher — nur Modellnamen, Zähler, Zahlen.
        "hintergrund": hintergrund.status() if hintergrund is not None else {"aktiv": False},
        "speicher": bild(messen(speicher_quellen)),
        # Tiefen-Index (Zähler, Anteil gelesen, Budget der Nacht), Arten ohne Datei, Live-Trefferquote — nur Zahlen.
        "tiefe": tiefen_job.status() if tiefen_job is not None else {"aktiv": False},
        "arten": worker.arten if worker is not None else None,
        "lernen": lernen.status() if lernen is not None else {"aktiv": False},
        # Nachtarbeit: Schalter, Stand der Nacht, Puffer, Meldungen, Selbsttest — nur Zahlen.
        "nachtarbeit": _nachtarbeit_status(),
        # Sicherheits-Rapport: letzte Abfrage, letzter Rapport, Quelle, Länge — nie Text.
        "sicherheit": sicherheit.status() if sicherheit is not None else {"aktiv": False},
    }


def _nachtarbeit_status() -> dict[str, Any]:
    if nachtarbeit is None:
        return {"aktiv": False}
    try:
        return nachtarbeit.status()
    except Exception as e:  # noqa: BLE001 — /health darf nie scheitern
        return {"aktiv": True, "fehler": type(e).__name__}


# --- Archiv (Phase 3) ---------------------------------------------------------


@app.post("/v1/archiv/frage")
async def archiv_frage(
    _request: Request,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    try:
        pruefe_ticket(ticket_aus_header(authorization), cfg.ticket_secret, "archiv")
    except TicketFehler as e:
        return fehler(401, str(e))
    return fehler(503, "Archiv-Index folgt in Phase 3")
