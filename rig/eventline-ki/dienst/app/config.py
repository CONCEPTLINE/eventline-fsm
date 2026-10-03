"""Konfiguration aus der Umgebung.

Werte kommen aus /etc/eventline-ki/env (SPEC §4) und den festen Variablen in
docker-compose.yml. Secrets werden hier nur gelesen — nie geloggt, nie
ausgegeben. Alles Weitere hat sinnvolle Standardwerte, damit der Dienst auch
mit einer minimalen env-Datei startet.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _text(name: str, standard: str = "") -> str:
    wert = os.environ.get(name)
    if wert is None:
        return standard
    wert = wert.strip()
    # env-Dateien enthalten gelegentlich Anführungszeichen um den Wert.
    if len(wert) >= 2 and wert[0] == wert[-1] and wert[0] in ("'", '"'):
        wert = wert[1:-1]
    return wert


def _zahl(name: str, standard: int) -> int:
    try:
        return int(_text(name, str(standard)))
    except ValueError:
        return standard


def _kommazahl(name: str, standard: float) -> float:
    try:
        return float(_text(name, str(standard)))
    except ValueError:
        return standard


def _liste(name: str, standard: str = "") -> tuple[str, ...]:
    return tuple(t.strip() for t in _text(name, standard).split(",") if t.strip())


@dataclass(frozen=True)
class Einstellungen:
    fsm_url: str
    sync_token: str
    ticket_secret: str
    cors_origins: tuple[str, ...]
    # Einziger Weg nach draussen (Squid mit Erlaubnisliste); None = direkt (nur Probelauf/Entwicklung).
    proxy: str | None
    ollama_url: str
    whisper_url: str
    modell_text: str
    modell_bild: str
    modell_embed: str
    modell_whisper: str
    keep_alive: str
    # Kontextfenster je Aufgabe (Tokens). Muss mit Modell, KV-Cache und Rechenpuffer in den
    # freien VRAM passen, sonst lagert llama.cpp Schichten auf die CPU aus (Faktor 10–20 langsamer).
    # Ablage: Systemregeln + Ordnerliste + Dokumenttext; Bild: Beleg/Warenkorb (Bild ≈ 1000–1600 Tokens).
    llm_num_ctx: int
    bild_num_ctx: int
    llm_timeout_s: int
    # Obergrenze Dokumenttext fürs Sprachmodell (Kopf + Schwanz); die Ablage kürzt zusätzlich
    # so, dass der ganze Prompt ins Kontextfenster passt.
    llm_max_zeichen: int
    bild_max_px: int
    pg_host: str
    pg_port: int
    pg_user: str
    pg_db: str
    pg_password: str
    data_dir: Path
    tmp_dir: Path
    poll_intervall_s: float
    max_datei_mb: int
    max_text_zeichen: int
    pdf_max_seiten: int
    ocr_max_seiten: int
    ocr_timeout_s: int
    diktat_max_mb: int
    diktat_timeout_s: int
    # Unter diesem freien VRAM wird das Sprachmodell vor einem Diktat entladen (8-GB-Karte).
    whisper_min_frei_mb: int
    # Whisper-Segmente mit höherer «kein Sprechen»-Wahrscheinlichkeit werden verworfen
    # (Stille/Rauschen erzeugt sonst erfundene Sätze).
    whisper_no_speech_max: float
    build: str

    @property
    def pg_dsn(self) -> str | None:
        if not self.pg_password:
            return None
        return (
            f"host={self.pg_host} port={self.pg_port} dbname={self.pg_db} "
            f"user={self.pg_user} password={self.pg_password} connect_timeout=5 "
            f"application_name=eventline-ki"
        )

    def uebersicht(self) -> dict[str, object]:
        """Für das Start-Log: zeigt, WAS gesetzt ist — nie die Werte der Geheimnisse."""
        return {
            "fsm_url": self.fsm_url,
            "sync_token": bool(self.sync_token),
            "ticket_secret": bool(self.ticket_secret),
            "proxy": self.proxy,
            "ollama_url": self.ollama_url,
            "whisper_url": self.whisper_url,
            "modell_text": self.modell_text,
            "modell_bild": self.modell_bild,
            "modell_whisper": self.modell_whisper,
            "num_ctx": {"ablage": self.llm_num_ctx, "bild": self.bild_num_ctx},
            "protokoll_db": bool(self.pg_password),
            "tmp_dir": str(self.tmp_dir),
            "build": self.build,
        }


def laden() -> Einstellungen:
    data_dir = Path(_text("KI_DATA_DIR", "/data"))
    tmp_dir = Path(_text("TMPDIR", str(data_dir / "tmp")))
    return Einstellungen(
        fsm_url=_text("FSM_URL", "https://eventline-fsm-usyk.vercel.app").rstrip("/"),
        sync_token=_text("KI_SYNC_TOKEN"),
        ticket_secret=_text("KI_TICKET_SECRET"),
        cors_origins=_liste("KI_CORS_ORIGINS"),
        proxy=_text("HTTPS_PROXY") or None,
        ollama_url=_text("OLLAMA_URL", "http://ollama:11434").rstrip("/"),
        whisper_url=_text("WHISPER_URL", "http://whisper:8000").rstrip("/"),
        # Entscheid 2026-10-03 (SPEC §2.1): ein Modell für Text und Bild — einziges, das Belege
        # und Ablage ganz in der GPU rechnet. Massgeblich bleibt /etc/eventline-ki/env.
        modell_text=_text("KI_MODELL_TEXT", "gemma3:4b"),
        modell_bild=_text("KI_MODELL_BILD", "gemma3:4b"),
        modell_embed=_text("KI_MODELL_EMBED", "bge-m3"),
        modell_whisper=_text("KI_MODELL_WHISPER", "Systran/faster-whisper-medium"),
        keep_alive=_text("KI_KEEP_ALIVE", "5m"),
        llm_num_ctx=_zahl("KI_LLM_NUM_CTX", 8192),
        bild_num_ctx=_zahl("KI_BILD_NUM_CTX", 4096),
        llm_timeout_s=_zahl("KI_LLM_TIMEOUT_S", 300),
        llm_max_zeichen=_zahl("KI_LLM_MAX_ZEICHEN", 24_000),
        bild_max_px=_zahl("KI_BILD_MAX_PX", 1280),
        pg_host=_text("PG_HOST", "db"),
        pg_port=_zahl("PG_PORT", 5432),
        pg_user=_text("PG_USER", "eventline"),
        pg_db=_text("PG_DB", "eventline_ki"),
        pg_password=_text("PG_PASSWORD"),
        data_dir=data_dir,
        tmp_dir=tmp_dir,
        poll_intervall_s=max(0.5, _zahl("KI_POLL_MS", 2000) / 1000.0),
        max_datei_mb=_zahl("KI_MAX_DATEI_MB", 50),
        max_text_zeichen=_zahl("KI_MAX_TEXT_ZEICHEN", 60_000),
        pdf_max_seiten=_zahl("KI_PDF_MAX_SEITEN", 300),
        ocr_max_seiten=_zahl("KI_OCR_MAX_SEITEN", 30),
        ocr_timeout_s=_zahl("KI_OCR_TIMEOUT_S", 600),
        # Wie im FSM (POST /api/ki/diktat nimmt höchstens 10 MB an).
        diktat_max_mb=_zahl("KI_DIKTAT_MAX_MB", 10),
        diktat_timeout_s=_zahl("KI_DIKTAT_TIMEOUT_S", 120),
        whisper_min_frei_mb=_zahl("KI_WHISPER_MIN_FREI_MB", 2000),
        whisper_no_speech_max=_kommazahl("KI_WHISPER_NO_SPEECH_MAX", 0.6),
        build=_text("KI_BUILD", "dev"),
    )


EINSTELLUNGEN = laden()
