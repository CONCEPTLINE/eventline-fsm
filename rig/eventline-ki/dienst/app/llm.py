"""Sprach-/Bildmodelle über Ollama (/api/chat mit JSON-Schema als `format`).

Das Schema zwingt das Modell in die gewünschte Form (Enums für Typ, Ordner,
Person) — nachträglich wird trotzdem validiert, weil kleine Modelle Felder
leer lassen oder Daten erfinden. keep_alive kommt aus der Umgebung, damit das
Modell nach Leerlauf wieder aus dem VRAM verschwindet (SPEC §1.4).

Das Kontextfenster (num_ctx) gibt jeder Aufrufer mit: es bestimmt den KV-Cache
und damit, ob das Modell ganz in den VRAM passt. Ein anderer Wert für dasselbe
Modell lässt Ollama das Modell neu laden.
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

import httpx

from .config import Einstellungen
from .gpu import SCHLEUSE

log = logging.getLogger("ki.llm")

_JSON_BLOCK = re.compile(r"\{.*\}", re.S)


class LlmFehler(Exception):
    """Klartext-Fehler des Modells (Modell fehlt, Zeitüberschreitung, kein JSON)."""


class Ollama:
    def __init__(self, cfg: Einstellungen) -> None:
        self.cfg = cfg
        self._client = httpx.Client(
            base_url=cfg.ollama_url,
            trust_env=False,
            timeout=httpx.Timeout(30.0, connect=5.0),
        )

    # --- Auskunft -----------------------------------------------------------

    def version(self) -> str | None:
        try:
            r = self._client.get("/api/version", timeout=5.0)
            if r.status_code == 200:
                return str(r.json().get("version"))
        except (httpx.HTTPError, ValueError):
            pass
        return None

    def installierte_modelle(self) -> list[str]:
        try:
            r = self._client.get("/api/tags", timeout=10.0)
            r.raise_for_status()
            return [str(m.get("name")) for m in r.json().get("models", [])]
        except (httpx.HTTPError, ValueError):
            return []

    def geladene_modelle(self) -> list[dict[str, Any]]:
        try:
            r = self._client.get("/api/ps", timeout=10.0)
            r.raise_for_status()
            return list(r.json().get("models", []))
        except (httpx.HTTPError, ValueError):
            return []

    def entlade(self, modell: str | None = None) -> None:
        """Modell sofort aus dem VRAM werfen (vor Whisper auf der 8-GB-Karte)."""
        namen = [modell] if modell else [str(m.get("name")) for m in self.geladene_modelle()]
        for name in namen:
            try:
                self._client.post("/api/generate", json={"model": name, "keep_alive": 0}, timeout=30.0)
            except httpx.HTTPError as e:
                log.warning("Entladen von %s fehlgeschlagen: %s", name, type(e).__name__)

    # --- Strukturierte Antwort -------------------------------------------------

    def chat_json(
        self,
        *,
        modell: str,
        system: str,
        nutzer: str,
        schema: dict[str, Any],
        num_ctx: int,
        bilder: list[str] | None = None,
        num_predict: int = 1024,
        timeout_s: float | None = None,
        optionen: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """Liefert (JSON-Antwort, Metadaten) — Metadaten ohne Inhalte, nur Zähler.

        optionen: zusätzliche Ollama-Optionen für diesen Aufruf (z. B. temperature/seed für einen
        zweiten Versuch nach einer Wiederholungsschleife); Standard ist temperature 0.
        """
        nachricht: dict[str, Any] = {"role": "user", "content": nutzer}
        if bilder:
            nachricht["images"] = bilder
        body = {
            "model": modell,
            "messages": [{"role": "system", "content": system}, nachricht],
            "format": schema,
            "stream": False,
            "keep_alive": self.cfg.keep_alive,
            # Kein «Denk»-Modus (qwen3): spart Zeit, und die Antwort ist ohnehin schemagebunden.
            "think": False,
            "options": {
                "temperature": 0,
                "num_ctx": num_ctx,
                "num_predict": num_predict,
                **(optionen or {}),
            },
        }
        start = time.monotonic()
        with SCHLEUSE:
            try:
                r = self._client.post(
                    "/api/chat",
                    json=body,
                    timeout=httpx.Timeout(timeout_s or self.cfg.llm_timeout_s, connect=5.0),
                )
            except httpx.TimeoutException as e:
                raise LlmFehler(f"Modell {modell} hat nicht rechtzeitig geantwortet") from e
            except httpx.HTTPError as e:
                raise LlmFehler(f"Ollama nicht erreichbar ({type(e).__name__})") from e
        if r.status_code == 404:
            raise LlmFehler(f"Modell {modell} ist nicht installiert (ollama pull {modell})")
        if r.status_code >= 400:
            text = ""
            try:
                text = str(r.json().get("error") or "")[:160]
            except ValueError:
                pass
            raise LlmFehler(f"Ollama-Fehler {r.status_code}: {text or 'ohne Angabe'}")
        try:
            antwort = r.json()
        except ValueError as e:
            raise LlmFehler("Ollama-Antwort ist kein JSON") from e
        inhalt = str((antwort.get("message") or {}).get("content") or "").strip()
        if not inhalt:
            raise LlmFehler(f"Modell {modell} lieferte keine Antwort")
        daten = _json_lesen(inhalt)
        if daten is None:
            raise LlmFehler(f"Modell {modell} lieferte kein gültiges JSON")
        meta = {
            "modell": modell,
            "num_ctx": num_ctx,
            "dauer_ms": int((time.monotonic() - start) * 1000),
            "prompt_tokens": antwort.get("prompt_eval_count"),
            "antwort_tokens": antwort.get("eval_count"),
            "lade_ms": int((antwort.get("load_duration") or 0) / 1_000_000),
            "prompt_ms": int((antwort.get("prompt_eval_duration") or 0) / 1_000_000),
            "antwort_ms": int((antwort.get("eval_duration") or 0) / 1_000_000),
        }
        return daten, meta

    # --- Einbettungen ------------------------------------------------------------

    def einbetten(self, *, modell: str, texte: list[str], timeout_s: float = 120.0) -> tuple[list[list[float]], dict[str, Any]]:
        """Einbettungen über /api/embed — je Text ein L2-normierter Vektor; Metadaten ohne Inhalte.

        Läuft durch dieselbe Schleuse wie die Sprachmodelle (Whisper und Modelle rechnen nie gleichzeitig).
        Zu lange Texte kürzt Ollama auf das Fenster des Modells (truncate).
        """
        if not texte:
            return [], {"modell": modell, "dauer_ms": 0, "lade_ms": 0, "prompt_tokens": 0}
        body = {"model": modell, "input": texte, "keep_alive": self.cfg.keep_alive, "truncate": True}
        start = time.monotonic()
        with SCHLEUSE:
            try:
                r = self._client.post("/api/embed", json=body, timeout=httpx.Timeout(timeout_s, connect=5.0))
            except httpx.TimeoutException as e:
                raise LlmFehler(f"Einbettungsmodell {modell} hat nicht rechtzeitig geantwortet") from e
            except httpx.HTTPError as e:
                raise LlmFehler(f"Ollama nicht erreichbar ({type(e).__name__})") from e
        if r.status_code == 404:
            raise LlmFehler(f"Modell {modell} ist nicht installiert (ollama pull {modell})")
        if r.status_code >= 400:
            text = ""
            try:
                text = str(r.json().get("error") or "")[:160]
            except ValueError:
                pass
            raise LlmFehler(f"Ollama-Fehler {r.status_code}: {text or 'ohne Angabe'}")
        try:
            antwort = r.json()
            roh = antwort.get("embeddings")
        except ValueError as e:
            raise LlmFehler("Ollama-Antwort ist kein JSON") from e
        if not isinstance(roh, list) or len(roh) != len(texte):
            raise LlmFehler(f"Einbettungsmodell {modell} lieferte keine passenden Vektoren")
        vektoren = [_normiert(v) for v in roh]
        meta = {
            "modell": modell,
            "dauer_ms": int((time.monotonic() - start) * 1000),
            "lade_ms": int((antwort.get("load_duration") or 0) / 1_000_000),
            "prompt_tokens": antwort.get("prompt_eval_count"),
        }
        return vektoren, meta

    def schliessen(self) -> None:
        self._client.close()


def _normiert(v: Any) -> list[float]:
    if not isinstance(v, list) or not v:
        raise LlmFehler("Einbettung ist leer")
    werte = [float(x) for x in v]
    laenge = sum(x * x for x in werte) ** 0.5
    if laenge <= 0:
        raise LlmFehler("Einbettung ist ein Nullvektor")
    return [x / laenge for x in werte]


def _json_lesen(text: str) -> dict[str, Any] | None:
    bereinigt = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
    bereinigt = re.sub(r"\s*```$", "", bereinigt).strip()
    for kandidat in (bereinigt, _JSON_BLOCK.search(bereinigt)):
        if kandidat is None:
            continue
        roh = kandidat if isinstance(kandidat, str) else kandidat.group(0)
        try:
            wert = json.loads(roh)
        except ValueError:
            continue
        if isinstance(wert, dict):
            return wert
    return None
