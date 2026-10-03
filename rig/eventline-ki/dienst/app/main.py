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
from .config import EINSTELLUNGEN as cfg
from .fsm import FsmClient
from .gpu import gpu_info
from .llm import Ollama
from .protokoll import Protokoll
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
log = logging.getLogger("ki.main")

zustand = Zustand()
protokoll = Protokoll(cfg.pg_dsn)
llm = Ollama(cfg)
whisper = Whisper(cfg)
fsm = FsmClient(cfg)
worker: Worker | None = None


@asynccontextmanager
async def lebenszyklus(_app: FastAPI):
    global worker
    log.info("EVENTLINE Lokale KI %s startet — %s", VERSION, cfg.uebersicht())
    try:
        cfg.tmp_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        log.error("Temp-Verzeichnis %s nicht beschreibbar (%s)", cfg.tmp_dir, type(e).__name__)
    await asyncio.to_thread(protokoll.start)
    if not cfg.sync_token:
        log.error("KI_SYNC_TOKEN fehlt — die Warteschlange bleibt aus")
    else:
        worker = Worker(cfg, fsm, llm, whisper, protokoll, zustand)
        worker.start()
    yield
    if worker is not None:
        worker.stop()
        worker.join(timeout=15)
    protokoll.schliessen()
    fsm.schliessen()
    llm.schliessen()
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
    return {
        "ok": True,
        "version": f"{VERSION}+{cfg.build}",
        "modell": cfg.modell_text,
        "gpu": gpu_info(),
        "warteschlange": zustand.bild()["warteschlange"],
    }


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
