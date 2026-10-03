"""diktat: Sprachaufnahme → Text, lokal mit Whisper (Vertrag V3).

Die Aufnahme kommt wie ein Beleg über den Übergabe-Bucket (ki-tmp/<uuid>, signierte
URL vom FSM). ffmpeg macht daraus 16 kHz Mono-WAV (webm, ogg, m4a, mp3, wav …),
Whisper erkennt Deutsch mit vorgeschaltetem VAD, und Segmente mit hoher
«kein Sprechen»-Wahrscheinlichkeit fallen weg — Stille ergibt so leeren Text
statt eines erfundenen Satzes.

Ergebnis: { text (höchstens 20 000 Zeichen, leer = nichts erkannt), dauer_ms }.
"""

from __future__ import annotations

import logging
import subprocess
import time
from pathlib import Path
from typing import Any

from ..config import Einstellungen
from ..gpu import SCHLEUSE, gpu_info
from ..llm import Ollama
from ..whisper import Whisper, WhisperFehler
from . import VerarbeitungsFehler

log = logging.getLogger("ki.diktat")

MAX_TEXT_ZEICHEN = 20_000
# 16 kHz × 16 bit Mono = 32 000 Byte/s; darunter ist die Umwandlung gescheitert.
MIN_WAV_BYTES = 1000


def text_aus_segmenten(segmente: list[dict[str, Any]], no_speech_max: float) -> tuple[str, int]:
    """Text der Segmente, deren no_speech_prob die Schwelle nicht übersteigt; dazu die Anzahl verworfener."""
    teile: list[str] = []
    verworfen = 0
    for s in segmente:
        try:
            no_speech = float(s.get("no_speech_prob") or 0.0)
        except (TypeError, ValueError):
            no_speech = 0.0
        text = " ".join(str(s.get("text") or "").split())
        if not text:
            continue
        if no_speech > no_speech_max:
            verworfen += 1
            continue
        teile.append(text)
    return " ".join(teile)[:MAX_TEXT_ZEICHEN].strip(), verworfen


def _nach_wav(quelle: Path) -> Path:
    # Eigener Name statt with_suffix: eine .wav-Quelle würde sonst von ffmpeg überschrieben.
    wav = quelle.with_name(f"{quelle.stem}-16k.wav")
    try:
        p = subprocess.run(
            ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(quelle),
             "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", str(wav)],
            capture_output=True, text=True, timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as e:
        wav.unlink(missing_ok=True)
        raise VerarbeitungsFehler(f"Audio-Umwandlung nicht möglich ({type(e).__name__})") from e
    if p.returncode != 0 or not wav.exists() or wav.stat().st_size < MIN_WAV_BYTES:
        wav.unlink(missing_ok=True)
        raise VerarbeitungsFehler("Audio konnte nicht gelesen werden")
    return wav


def diktat(*, pfad: Path, whisper: Whisper, llm: Ollama, cfg: Einstellungen) -> tuple[dict[str, Any], str]:
    start = time.monotonic()
    wav = _nach_wav(pfad)
    try:
        # Auf der 8-GB-Karte Platz schaffen: Sprachmodell weg, wenn es für Whisper zu eng wird.
        g = gpu_info(max_alter_s=0)
        if isinstance(g.get("frei_mb"), int) and g["frei_mb"] < cfg.whisper_min_frei_mb:
            llm.entlade()
        with SCHLEUSE:
            try:
                segmente = whisper.transkribiere(wav)
            except WhisperFehler as e:
                raise VerarbeitungsFehler(str(e)) from e
    finally:
        wav.unlink(missing_ok=True)
    text, verworfen = text_aus_segmenten(segmente, cfg.whisper_no_speech_max)
    dauer_ms = int((time.monotonic() - start) * 1000)
    log.info(
        "diktat: %d Segmente, %d verworfen (no_speech > %.2f), %d Zeichen, %d ms",
        len(segmente), verworfen, cfg.whisper_no_speech_max, len(text), dauer_ms,
    )
    return {"text": text, "dauer_ms": dauer_ms}, cfg.modell_whisper
