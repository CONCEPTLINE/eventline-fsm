"""Gemeinsamer Weg für Bildaufträge (Beleg, Warenkorb): Bild verkleinern,
Bildmodell mit JSON-Schema fragen, Antwort zurückgeben.

Die Prompts stammen 1:1 aus den bisherigen FSM-Routen (analyze-receipt,
analyze-material), damit sich das Verhalten für die Nutzer nicht ändert —
nur der Ort der Verarbeitung (Rig statt OpenAI).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from ..config import Einstellungen
from ..extract import ExtraktFehler, bild_base64
from ..llm import LlmFehler, Ollama
from . import VerarbeitungsFehler

log = logging.getLogger("ki.bild")


def bildmodell_json(
    llm: Ollama,
    cfg: Einstellungen,
    *,
    system: str,
    nutzer: str,
    schema: dict[str, Any],
    pfad: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    try:
        b64 = bild_base64(pfad, cfg.bild_max_px)
    except ExtraktFehler as e:
        raise VerarbeitungsFehler(str(e)) from e
    try:
        roh, meta = llm.chat_json(
            modell=cfg.modell_bild,
            system=system,
            nutzer=nutzer,
            schema=schema,
            num_ctx=cfg.bild_num_ctx,
            bilder=[b64],
            num_predict=800,
        )
    except LlmFehler as e:
        raise VerarbeitungsFehler(str(e)) from e
    log.info(
        "Bildmodell %s: %s ms (Laden %s ms, Prompt %s Tokens/%s ms, Antwort %s Tokens/%s ms, num_ctx %s)",
        meta["modell"], meta["dauer_ms"], meta["lade_ms"], meta["prompt_tokens"], meta["prompt_ms"],
        meta["antwort_tokens"], meta["antwort_ms"], meta["num_ctx"],
    )
    return roh, meta
