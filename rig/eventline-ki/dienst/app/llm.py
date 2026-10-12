"""Sprach-/Bildmodelle über Ollama (/api/chat mit JSON-Schema als `format`).

Das Schema zwingt das Modell in die gewünschte Form (Enums für Typ, Ordner,
Person) — nachträglich wird trotzdem validiert, weil kleine Modelle Felder
leer lassen oder Daten erfinden. keep_alive kommt aus der Umgebung, damit das
Modell nach Leerlauf wieder aus dem VRAM verschwindet (SPEC §1.4).

Das Kontextfenster (num_ctx) gibt jeder Aufrufer mit: es bestimmt den KV-Cache
und damit, ob das Modell ganz in den VRAM passt. Ein anderer Wert für dasselbe
Modell lässt Ollama das Modell neu laden.

Zwei Instanzen (Masterplan §2.2): «schnell» (Standard, GPU, nimmt die Schleuse) und
«gruendlich» (base_url = KI_HG-Instanz, schleuse=False: das Hauptmodell rechnet auf dem
Prozessor und hält die GPU-Schleuse nie — wartende Aufträge laufen unberührt weiter).
"""

from __future__ import annotations

import contextlib
import json
import logging
import re
import socket
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import httpx

from .config import Einstellungen
from .gpu import SCHLEUSE

log = logging.getLogger("ki.llm")

_JSON_BLOCK = re.compile(r"\{.*\}", re.S)
# Einbettungsmodell während des Planer-Tags warm (Masterplan §3.3), nur mit Inhaltssuche/Frag das Archiv
# eingeschaltet: keep_alive bis zum Nachtbeginn (KI_NACHT_START), mindestens EINBETTUNG_TAG_MIN_S. Platz kostet das
# keinen: braucht ein anderes Modell den VRAM, wirft Ollama das unbenutzte bge-m3 selbst hinaus, und vor einem Diktat
# entlädt der Dienst bei Enge alle Sprach-/Einbettungsmodelle (handlers/diktat.py).
EINBETTUNG_TAG_MIN_S = 300

# Tempo der letzten eigenen Antwort (Technik-Dashboard, VERTRAG §1.2): Tokens/s, Modell, Zeitpunkt (UTC) — nur Zahlen.
_TEMPO_LOCK = threading.Lock()
_letztes_tempo: dict[str, Any] | None = None
TEMPO_MIN_TOKENS = 10  # kürzere Antworten ergeben kein aussagekräftiges Tempo


def merke_tempo(modell: str, tokens: Any, dauer_ns: Any) -> None:
    global _letztes_tempo
    if isinstance(tokens, bool) or not isinstance(tokens, int) or not isinstance(dauer_ns, (int, float)):
        return
    if tokens < TEMPO_MIN_TOKENS or dauer_ns <= 0:
        return
    wert = {"tokens_s": round(tokens / (dauer_ns / 1e9), 1), "modell": modell,
            "am": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    with _TEMPO_LOCK:
        _letztes_tempo = wert


def letztes_tempo() -> dict[str, Any] | None:
    with _TEMPO_LOCK:
        return dict(_letztes_tempo) if _letztes_tempo is not None else None


def jetzt_zuerich() -> datetime | None:
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo("Europe/Zurich"))
    except Exception:  # noqa: BLE001 — ohne Zeitzonendaten lieber der bisherige keep_alive
        return None


def tag_keep_alive(cfg: Einstellungen, jetzt: datetime | None = None) -> str | None:
    """Während des Planer-Tags (KI_TAG_START–KI_NACHT_START, Europe/Zurich) keep_alive bis Tagesende als «<n>s»,
    nachts None (dann gilt KI_KEEP_ALIVE)."""
    from .planer import uhrzeit

    jetzt = jetzt if jetzt is not None else jetzt_zuerich()
    if jetzt is None:
        return None
    t_h, t_m = uhrzeit(cfg.tag_start, (7, 0))
    n_h, n_m = uhrzeit(cfg.nacht_start, (19, 0))
    minute, t, n = jetzt.hour * 60 + jetzt.minute, t_h * 60 + t_m, n_h * 60 + n_m
    tag = t <= minute < n if t < n else not (n <= minute < t)
    if not tag:
        return None
    ende = jetzt.replace(hour=n_h, minute=n_m, second=0, microsecond=0)
    if ende <= jetzt:
        ende += timedelta(days=1)
    return f"{max(EINBETTUNG_TAG_MIN_S, int((ende - jetzt).total_seconds()))}s"


class LlmFehler(Exception):
    """Klartext-Fehler des Modells (Modell fehlt, Zeitüberschreitung, kein JSON)."""


class LlmAbgebrochen(LlmFehler):
    """Gestreamter Aufruf bewusst beendet: grund «abbruch» (Event gesetzt), «zeit» (Frist) oder der Wert,
    den die Prüffunktion lieferte (z. B. «vorrang»). Ollama bricht beim Verbindungsabbruch selbst ab."""

    def __init__(self, grund: str) -> None:
        super().__init__(f"abgebrochen ({grund})")
        self.grund = grund


class _Unterbrecher(threading.Thread):
    """Schliesst eine laufende Antwort von aussen, sobald das Abbruch-Event gesetzt oder die Frist um ist.

    Während Ollama ein Modell lädt oder einen langen Prompt rechnet, kommt minutenlang kein Chunk — der
    lesende Thread hängt dann in recv(). shutdown() auf dem Socket weckt ihn sofort (EOF); nur close()
    der Antwort reicht dafür unter Linux nicht zuverlässig."""

    def __init__(self, antwort: httpx.Response, abbruch: threading.Event | None, frist: float | None) -> None:
        super().__init__(name="ki-llm-unterbrecher", daemon=True)
        self.antwort = antwort
        self.abbruch = abbruch
        self.frist = frist
        self.grund: str | None = None
        self._ende = threading.Event()

    def stop(self) -> None:
        self._ende.set()

    def run(self) -> None:
        while not self._ende.wait(0.1):
            if self.abbruch is not None and self.abbruch.is_set():
                self.grund = "abbruch"
            elif self.frist is not None and time.monotonic() >= self.frist:
                self.grund = "zeit"
            else:
                continue
            self._trennen()
            return

    def _trennen(self) -> None:
        sock = None
        try:
            netz = self.antwort.extensions.get("network_stream")
            sock = netz.get_extra_info("socket") if netz is not None else None
        except Exception:  # noqa: BLE001 — dann bleibt nur close()
            sock = None
        try:
            if isinstance(sock, socket.socket):
                sock.shutdown(socket.SHUT_RDWR)
            else:
                self.antwort.close()
        except OSError:
            pass


class Ollama:
    def __init__(self, cfg: Einstellungen, *, base_url: str | None = None, schleuse: bool = True) -> None:
        self.cfg = cfg
        self.base_url = (base_url or cfg.ollama_url).rstrip("/")
        # schleuse=False nur für «gruendlich» (Prozessor): nie gpu.SCHLEUSE nehmen (Masterplan §2.6).
        self.schleuse = schleuse
        self._client = httpx.Client(
            base_url=self.base_url,
            trust_env=False,
            timeout=httpx.Timeout(30.0, connect=5.0),
        )

    def _sperre(self) -> contextlib.AbstractContextManager[Any]:
        return SCHLEUSE if self.schleuse else contextlib.nullcontext()

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
        return self.geladene_modelle_oder_none() or []

    def geladene_modelle_oder_none(self) -> list[dict[str, Any]] | None:
        """Wie geladene_modelle(), aber None, wenn /api/ps nicht antwortet (Fehler, Zeitüberschreitung) —
        «unbekannt» ist nicht «nichts geladen» (Hauptmodell: kein OOM-Schluss, Entladen trotzdem senden)."""
        try:
            r = self._client.get("/api/ps", timeout=10.0)
            r.raise_for_status()
            return list(r.json().get("models", []))
        except (httpx.HTTPError, ValueError, AttributeError):
            return None

    def entlade(self, modell: str | None = None) -> bool:
        """Modell sofort aus dem VRAM werfen (vor Whisper auf der 8-GB-Karte). True = jeder Aufruf angenommen.
        keep_alive 0 ohne Prompt lädt ein nicht geladenes Modell nicht (Ollama 0.35.1, geprüft 2026-10-11:
        Antwort done_reason «unload» nach 0 s, /api/ps blieb leer, Speicher unverändert)."""
        namen = [modell] if modell else [str(m.get("name")) for m in self.geladene_modelle()]
        ok = True
        for name in namen:
            try:
                r = self._client.post("/api/generate", json={"model": name, "keep_alive": 0}, timeout=30.0)
                if r.status_code >= 400:
                    ok = False
                    log.warning("Entladen von %s: HTTP %d", name, r.status_code)
            except httpx.HTTPError as e:
                ok = False
                log.warning("Entladen von %s fehlgeschlagen: %s", name, type(e).__name__)
        return ok

    def _einbett_keep_alive(self, modell: str) -> str:
        warm = getattr(self.cfg, "suche_aktiv", False) or getattr(self.cfg, "archiv_frage_aktiv", False)
        if warm and modell == self.cfg.modell_embed:
            return tag_keep_alive(self.cfg) or self.cfg.keep_alive
        return self.cfg.keep_alive

    def vorladen(self, *, modell: str, keep_alive: str | None = None, timeout_s: float = 30.0) -> int | None:
        """Einbettungsmodell laden, ohne auf die GPU-Schleuse zu warten: ist sie belegt (ein Auftrag rechnet gerade),
        passiert nichts (None) — der Live-Pfad wartet nie auf ein Vorladen. Sonst hält der Aufruf die Schleuse nur
        für das Laden selbst (gemessen ~2 s; mit knappem VRAM lädt der Aufrufer gar nicht). Liefert die Ladezeit in
        ms; LlmFehler wie einbetten()."""
        if self.schleuse and not SCHLEUSE.acquire(blocking=False):
            return None
        try:
            body = {"model": modell, "input": ["."], "keep_alive": keep_alive or self._einbett_keep_alive(modell),
                    "truncate": True}
            try:
                r = self._client.post("/api/embed", json=body, timeout=httpx.Timeout(timeout_s, connect=5.0))
            except httpx.TimeoutException as e:
                raise LlmFehler(f"Einbettungsmodell {modell} hat nicht rechtzeitig geladen") from e
            except httpx.HTTPError as e:
                raise LlmFehler(f"Ollama nicht erreichbar ({type(e).__name__})") from e
        finally:
            if self.schleuse:
                SCHLEUSE.release()
        _pruefe_status(r, modell)
        try:
            return int((r.json().get("load_duration") or 0) / 1_000_000)
        except ValueError:
            return 0

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
        with self._sperre():
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
        merke_tempo(modell, antwort.get("eval_count"), antwort.get("eval_duration"))
        return daten, meta

    # --- Hauptmodell («gruendlich»): Laden und gestreamte Antwort ----------------------

    def lade(self, *, modell: str, optionen: dict[str, Any], keep_alive: str, timeout_s: float = 900.0) -> dict[str, Any]:
        """Modell laden, ohne etwas zu rechnen (POST /api/generate ohne Prompt), mit denselben Optionen wie die
        späteren Aufrufe (num_ctx, num_thread, use_mmap, num_gpu) — sonst lädt Ollama beim ersten Schritt neu.
        Blockiert bis das Modell geladen ist; lässt sich nicht sicher abbrechen (Masterplan §2.5)."""
        body = {"model": modell, "keep_alive": keep_alive, "options": optionen, "stream": False}
        start = time.monotonic()
        with self._sperre():
            try:
                r = self._client.post("/api/generate", json=body, timeout=httpx.Timeout(timeout_s, connect=5.0))
            except httpx.TimeoutException as e:
                raise LlmFehler(f"Modell {modell} wurde nicht rechtzeitig geladen") from e
            except httpx.HTTPError as e:
                raise LlmFehler(f"Ollama nicht erreichbar ({type(e).__name__})") from e
        _pruefe_status(r, modell)
        try:
            antwort = r.json()
        except ValueError:
            antwort = {}
        return {
            "modell": modell,
            "dauer_ms": int((time.monotonic() - start) * 1000),
            "lade_ms": int((antwort.get("load_duration") or 0) / 1_000_000),
        }

    def chat_stream(
        self,
        *,
        modell: str,
        nachrichten: list[dict[str, Any]],
        optionen: dict[str, Any],
        keep_alive: str,
        format: dict[str, Any] | None = None,
        think: bool = False,
        abbruch: threading.Event | None = None,
        frist_s: float | None = None,
        pruefe: Callable[[], str | None] | None = None,
    ) -> tuple[str, dict[str, Any]]:
        """Gestreamter /api/chat-Aufruf, jederzeit abbrechbar. Liefert (Antworttext, Metadaten).

        - abbruch gesetzt → Verbindung wird sofort getrennt, LlmAbgebrochen("abbruch"), auch mitten im Laden
          oder im Prompt (dort kommt kein Chunk).
        - frist_s überschritten → LlmAbgebrochen("zeit").
        - pruefe() nach jedem Chunk; liefert sie einen Grund (z. B. «vorrang»), wird abgebrochen.
        Der Denk-Text (think) wird nie gespeichert oder zurückgegeben, nur gezählt (Masterplan §2.3).
        """
        body: dict[str, Any] = {
            "model": modell,
            "messages": nachrichten,
            "stream": True,
            "keep_alive": keep_alive,
            "think": bool(think),
            "options": optionen,
        }
        if format is not None:
            body["format"] = format
        start = time.monotonic()
        frist = start + frist_s if frist_s else None
        lese_timeout = (frist_s + 30.0) if frist_s else None
        teile: list[str] = []
        denk_tokens = 0
        ende: dict[str, Any] | None = None
        grund: str | None = None
        with self._sperre():
            try:
                with self._client.stream(
                    "POST", "/api/chat", json=body,
                    timeout=httpx.Timeout(lese_timeout, connect=5.0, write=30.0, pool=10.0),
                ) as r:
                    if r.status_code >= 400:
                        r.read()
                        _pruefe_status(r, modell)
                    unterbrecher = _Unterbrecher(r, abbruch, frist)
                    unterbrecher.start()
                    try:
                        for zeile in r.iter_lines():
                            if unterbrecher.grund:
                                break
                            if not zeile.strip():
                                continue
                            try:
                                stueck = json.loads(zeile)
                            except ValueError as e:
                                raise LlmFehler("Ollama-Stream ist kein JSON") from e
                            if stueck.get("error"):
                                raise LlmFehler(f"Ollama-Fehler: {str(stueck.get('error'))[:160]}")
                            nachricht = stueck.get("message") or {}
                            if nachricht.get("thinking"):
                                denk_tokens += 1
                            if nachricht.get("content"):
                                teile.append(str(nachricht["content"]))
                            if stueck.get("done"):
                                ende = stueck
                                break
                            if pruefe is not None:
                                grund = pruefe()
                                if grund:
                                    break
                    except httpx.HTTPError as e:
                        if not unterbrecher.grund:
                            raise LlmFehler(f"Verbindung zu Ollama abgebrochen ({type(e).__name__})") from e
                    finally:
                        unterbrecher.stop()
                    grund = unterbrecher.grund or grund
            except httpx.TimeoutException as e:
                raise LlmFehler(f"Modell {modell} hat nicht rechtzeitig geantwortet") from e
            except httpx.HTTPError as e:
                raise LlmFehler(f"Ollama nicht erreichbar ({type(e).__name__})") from e
        if grund:
            raise LlmAbgebrochen(grund)
        if ende is None:
            raise LlmFehler(f"Modell {modell}: Antwort unvollständig (Stream ohne Abschluss)")
        meta = {
            "modell": modell,
            "dauer_ms": int((time.monotonic() - start) * 1000),
            "prompt_tokens": ende.get("prompt_eval_count"),
            "antwort_tokens": ende.get("eval_count"),
            "denk_tokens": denk_tokens,
            "lade_ms": int((ende.get("load_duration") or 0) / 1_000_000),
            "prompt_ms": int((ende.get("prompt_eval_duration") or 0) / 1_000_000),
            "antwort_ms": int((ende.get("eval_duration") or 0) / 1_000_000),
        }
        merke_tempo(modell, ende.get("eval_count"), ende.get("eval_duration"))
        return "".join(teile).strip(), meta

    # --- Einbettungen ------------------------------------------------------------

    def einbetten(
        self, *, modell: str, texte: list[str], timeout_s: float = 120.0, keep_alive: str | None = None,
    ) -> tuple[list[list[float]], dict[str, Any]]:
        """Einbettungen über /api/embed — je Text ein L2-normierter Vektor; Metadaten ohne Inhalte.

        Läuft durch dieselbe Schleuse wie die Sprachmodelle (Whisper und Modelle rechnen nie gleichzeitig).
        Zu lange Texte kürzt Ollama auf das Fenster des Modells (truncate). keep_alive: ohne Angabe
        KI_KEEP_ALIVE wie bisher — ausser mit KI_SUCHE_AKTIV/KI_ARCHIV_FRAGE_AKTIV während des Planer-Tags für das
        Einbettungsmodell bis Tagesende (tag_keep_alive, Masterplan §3.3): sonst setzte jede Ablage und jeder
        Index-Stapel bge-m3 auf 5 min zurück, und die nächste Suche lüde kalt.
        """
        if not texte:
            return [], {"modell": modell, "dauer_ms": 0, "lade_ms": 0, "prompt_tokens": 0}
        body = {"model": modell, "input": texte, "keep_alive": keep_alive or self._einbett_keep_alive(modell), "truncate": True}
        start = time.monotonic()
        with self._sperre():
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


def _pruefe_status(r: httpx.Response, modell: str) -> None:
    if r.status_code == 404:
        raise LlmFehler(f"Modell {modell} ist nicht installiert (ollama pull {modell})")
    if r.status_code >= 400:
        text = ""
        try:
            text = str(r.json().get("error") or "")[:160]
        except ValueError:
            pass
        raise LlmFehler(f"Ollama-Fehler {r.status_code}: {text or 'ohne Angabe'}")


def json_aus_text(text: str) -> dict[str, Any] | None:
    """Öffentliche Form von _json_lesen — für Jobs, die chat_stream mit format nutzen."""
    return _json_lesen(text)


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
