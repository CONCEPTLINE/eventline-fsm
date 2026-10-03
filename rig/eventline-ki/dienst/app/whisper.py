"""Spracherkennung über den Whisper-Container (faster-whisper-server, OpenAI-kompatibel).

Nur im Netz ki-intern erreichbar. Neben /v1/audio/transcriptions kennt der Server
GET /api/ps (geladene Modelle). Sein DELETE /api/ps/<modell> (Entladen per API) wird
bewusst NICHT benutzt: in dieser Server-Version verklemmt es sich (das Modell wird
entladen, der Aufruf kehrt nie zurück, jede weitere Erkennung hängt bis zum Neustart
des Containers, der Healthcheck bleibt grün — gemessen 2026-10-03). Den VRAM gibt
Whisper selbst nach WHISPER__TTL frei (5 min Leerlauf); Whisper-Modell, gemma3:4b
und der Schwarm passen nebeneinander auf die 8-GB-Karte.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import httpx

from .config import Einstellungen

log = logging.getLogger("ki.whisper")


class WhisperFehler(Exception):
    """Klartext-Fehler der Spracherkennung (nicht erreichbar, Zeitüberschreitung, Antwort unlesbar)."""


class Whisper:
    def __init__(self, cfg: Einstellungen) -> None:
        self.cfg = cfg
        self._client = httpx.Client(
            base_url=cfg.whisper_url,
            trust_env=False,
            timeout=httpx.Timeout(float(cfg.diktat_timeout_s), connect=5.0),
        )

    def transkribiere(self, wav: Path) -> list[dict[str, Any]]:
        """Segmente der Aufnahme (verbose_json) — Sprache Deutsch, Stille per VAD herausgefiltert."""
        try:
            with open(wav, "rb") as f:
                r = self._client.post(
                    "/v1/audio/transcriptions",
                    files={"file": ("audio.wav", f, "audio/wav")},
                    data={
                        "model": self.cfg.modell_whisper,
                        "language": "de",
                        "response_format": "verbose_json",
                        "temperature": "0",
                        # Silero-VAD vor der Erkennung: reine Stille erreicht das Modell gar nicht
                        # erst (ohne VAD «hört» Whisper darin gern einen Abspann-Satz).
                        "vad_filter": "true",
                    },
                )
        except httpx.TimeoutException as e:
            raise WhisperFehler("Spracherkennung hat zu lange gebraucht") from e
        except httpx.HTTPError as e:
            raise WhisperFehler(f"Spracherkennung nicht erreichbar ({type(e).__name__})") from e
        if r.status_code >= 400:
            raise WhisperFehler(f"Spracherkennung meldet Fehler {r.status_code}")
        try:
            daten = r.json()
        except ValueError as e:
            raise WhisperFehler("Spracherkennung lieferte keine lesbare Antwort") from e
        segmente = daten.get("segments") if isinstance(daten, dict) else None
        if not isinstance(segmente, list):
            raise WhisperFehler("Spracherkennung lieferte keine Segmente")
        return [s for s in segmente if isinstance(s, dict)]

    def geladene_modelle(self) -> list[str]:
        """Was der Server gerade im VRAM hält (nur Auskunft — Entladen übernimmt sein TTL)."""
        try:
            r = self._client.get("/api/ps", timeout=5.0)
            r.raise_for_status()
            return [str(m) for m in (r.json().get("models") or [])]
        except (httpx.HTTPError, ValueError, AttributeError):
            return []

    def schliessen(self) -> None:
        self._client.close()
