"""Sicherheits-Rapport (SPEC §2.2 «Sicherheits-Rapport»): Klartext zum täglichen Sicherheits-Check des FSM.

Das FSM prüft sich jeden Morgen selbst (Cron /api/cron/security-audit, 05:00 UTC = 07:00 Sommer- bzw. 06:00
Winterzeit; dazu «Jetzt prüfen» von Hand) und legt Lauf + Befunde in security_runs/security_findings ab. Dieser
Thread fragt alle 5 min GET /api/ki/sicherheit (Rig-Anmeldung KI_SYNC_TOKEN, über den Ausgang): Antwort ist der
neueste fertige Lauf ohne Klartext — nur Zähler und Metadaten der Befunde (Schwere, Kategorie, Titel, aus detail
nur name/kind/missing; Info-Befunde nur gezählt), keine Dokumentinhalte. Daraus entstehen 1–3 Sätze Deutsch, die
per POST /api/ki/sicherheit in security_runs.narrative kommen (nur wenn dort noch nichts steht).

Zahlen schreibt nie das Modell: der erste Satz entsteht deterministisch aus critical/warnings/checks. Das schnelle
Modell (KI_MODELL_TEXT, GPU-Schleuse wie jeder Auftrag) erklärt nur die Befund-Titel in höchstens zwei Sätzen —
und nur, wenn es kritische Befunde oder Warnungen gibt. Seine Antwort wird deterministisch geprüft (Länge, jede
Ziffer aus Zählern/Titeln, die Namen der betroffenen Objekte genannt, keine Entwarnung, Deutsch); fällt sie durch
oder scheitert das Modell, kommt ein Ersatztext aus den Titeln. Das FSM prüft dieselben Zahlen ein zweites Mal
(422 → einmal nur der Ersatztext).

Aufträge der Warteschlange haben Vorrang: läuft oder wartet einer, wird erst im nächsten Takt gerechnet. Nach einem
Neustart des Rigs startet der Thread mit dem Dienst; ein verpasster Lauf (bis 7 Tage alt) wird nachgeholt. Logs
nur mit Statuscodes und Längen — nie Titel oder Text.
"""

from __future__ import annotations

import logging
import re
import threading
import time
import unicodedata
from datetime import datetime, timezone
from typing import Any, Callable

import httpx

from . import VERSION
from .config import Einstellungen
from .llm import LlmFehler

log = logging.getLogger("ki.sicherheit")

PFAD = "/api/ki/sicherheit"
TAKT_S = 300.0
ERSTER_VERSUCH_S = 90.0
RUHE_S = 20.0
ZEITLIMIT_S = 60.0
MAX_JE_RUNDE = 5
TEXT_MAX = 600            # = RAPPORT_MAX im FSM (src/lib/ki/sicherheit-rapport.ts)
ERKLAERUNG_MAX = 360
ERKLAERUNG_MIN = 20
MODELL_BEFUNDE = 6        # so viele Titel sieht das Modell (Rest: Ersatz nennt «weitere»)
NAMEN_PFLICHT = 3         # die ersten so vielen Objektnamen müssen im Modelltext stehen
ANTWORT_TOKENS = 220
MODELL_ZEITLIMIT_S = 120.0

KATEGORIEN = {
    "anon-read": "Daten ohne Anmeldung abrufbar",
    "anon-exec": "Datenbank-Funktion ohne Anmeldung aufrufbar",
    "headers": "Schutz-Einstellungen der Webseite",
    "signup": "Selbst-Registrierung offen",
    "rollen": "Rollen und Rechte",
}

SYSTEM = (
    "Du schreibst für die Geschäftsleitung einer Eventfirma (keine Informatiker) eine kurze Erklärung auf Deutsch "
    "in Schweizer Schreibweise (ss statt ß). Eine automatische Sicherheitsprüfung der Firmen-App hat die folgenden "
    "Befunde gemeldet. Erkläre in höchstens zwei kurzen Sätzen verständlich, was das bedeutet und was zu tun ist. "
    "Nenne die Namen der betroffenen Tabellen, Ansichten oder Funktionen genau so, wie sie angegeben sind. "
    "Schreibe keine Zahlen und keine Anzahl. Verharmlose nichts. Kein Markdown, keine Aufzählung, keine Anrede."
)
SCHEMA = {
    "type": "object",
    "properties": {"erklaerung": {"type": "string", "maxLength": ERKLAERUNG_MAX}},
    "required": ["erklaerung"],
}

_ENTWARNUNG = re.compile(
    r"unauff[äa]llig|keine\s+(befunde|probleme|gefahr|sorge)|alles\s+(in\s+ordnung|ok|gut|sicher)"
    r"|kein\s+(risiko|handlungsbedarf|grund)|nicht\s+(kritisch|schlimm|gef[äa]hrlich)|harmlos",
    re.I,
)
_DEUTSCH = re.compile(r"\b(der|die|das|ist|sind|war|und|nicht|sollte|sollten|bitte|ohne|wurde|werden|kann)\b", re.I)
_SATZENDE = re.compile(r"(?<=[.!?])\s+")


# --- Reine Helfer (getestet) -----------------------------------------------------------------------------------


def _mehrzahl(n: int, eins: str, viele: str) -> str:
    return f"{n} {eins if n == 1 else viele}"


def _ganz(wert: Any) -> int:
    try:
        n = int(wert)
    except (TypeError, ValueError):
        return 0
    return n if n >= 0 else 0


def saeubern(text: Any) -> str:
    """Wie saeubereRapport im FSM: Steuerzeichen/Markdown weg, Leerraum zusammen, ß → ss."""
    if not isinstance(text, str):
        return ""
    t = unicodedata.normalize("NFC", text)
    t = "".join(
        " " if (ord(c) < 0x20 or ord(c) == 0x7F or 0x200B <= ord(c) <= 0x200F or 0x2028 <= ord(c) <= 0x202E
                or 0x2066 <= ord(c) <= 0x2069) else c
        for c in t
    )
    t = re.sub(r"[*#`]+", "", t).replace("ß", "ss")
    return re.sub(r"\s+", " ", t).strip()


def befunde(lauf: dict[str, Any]) -> list[dict[str, Any]]:
    """Kritische/Warn-Befunde in der Form des FSM; Unbrauchbares fällt weg."""
    aus = []
    for b in lauf.get("befunde") or []:
        if not isinstance(b, dict) or b.get("severity") not in ("critical", "warn"):
            continue
        titel = saeubern(b.get("title"))[:200]
        if not titel:
            continue
        detail = b.get("detail") if isinstance(b.get("detail"), dict) else {}
        name = saeubern(detail.get("name"))[:120]
        aus.append({"severity": b["severity"], "category": saeubern(b.get("category"))[:40], "title": titel,
                    "name": name or None})
    aus.sort(key=lambda b: 0 if b["severity"] == "critical" else 1)
    return aus


def zaehler(lauf: dict[str, Any]) -> tuple[int, int, int, int]:
    """(kritisch, warnungen, prüfungen, hinweise) — immer aus den Daten."""
    hinweise = sum(_ganz(v) for v in (lauf.get("hinweise") or {}).values()) if isinstance(lauf.get("hinweise"), dict) else 0
    return _ganz(lauf.get("critical")), _ganz(lauf.get("warnings")), _ganz(lauf.get("checks")), hinweise


def zahlen_satz(lauf: dict[str, Any]) -> str:
    """Der erste Satz — deterministisch aus den Zählern des Laufs."""
    k, w, c, h = zaehler(lauf)
    pruefungen = _mehrzahl(c, "Prüfung", "Prüfungen")
    if k > 0:
        satz = "⚠ " + _mehrzahl(k, "kritischer Befund", "kritische Befunde")
        if w > 0:
            satz += " und " + _mehrzahl(w, "Warnung", "Warnungen")
        return f"{satz} bei {pruefungen}."
    if w > 0:
        return f"{_mehrzahl(w, 'Warnung', 'Warnungen')} bei {pruefungen}, nichts Kritisches."
    satz = f"Alles unauffällig: {pruefungen}, keine Befunde."
    if h > 0:
        arten = [KATEGORIEN.get(str(k_), str(k_)) for k_, v in (lauf.get("hinweise") or {}).items() if _ganz(v) > 0]
        satz += f" Dazu {_mehrzahl(h, 'Hinweis', 'Hinweise')} zur Kenntnis ({', '.join(arten)})."
    return satz


def ersatz_erklaerung(lauf: dict[str, Any]) -> str:
    """Ohne Modell: die Titel der wichtigsten Befunde (sie sind schon deutsch und verständlich)."""
    liste = befunde(lauf)
    if not liste:
        return ""
    titel = [b["title"].rstrip(".") for b in liste[:3]]
    mehr = len(liste) > 3 or _ganz(lauf.get("weitere")) > 0
    return "Betroffen: " + "; ".join(titel) + ("; dazu weitere, siehe Liste." if mehr else ".")


def erlaubte_zahlen(lauf: dict[str, Any]) -> set[str]:
    """Wie erlaubteZahlen im FSM: Zähler des Laufs und Ziffernfolgen aus den Titeln."""
    k, w, c, h = zaehler(lauf)
    erlaubt = {str(k), str(w), str(c), str(h)}
    for b in lauf.get("befunde") or []:
        if isinstance(b, dict):
            erlaubt.update(re.findall(r"\d+", saeubern(b.get("title"))))
    return erlaubt


def pruefe_erklaerung(text: str, lauf: dict[str, Any], gezeigt: list[dict[str, Any]]) -> str | None:
    """Antwort des Modells prüfen. None = brauchbar, sonst der Grund (nur fürs Log)."""
    if len(text) < ERKLAERUNG_MIN:
        return "zu_kurz"
    if len(text) > ERKLAERUNG_MAX:
        return "zu_lang"
    if any(z not in erlaubte_zahlen(lauf) for z in re.findall(r"\d+", text)):
        return "zahl"
    klein = text.casefold()
    for b in gezeigt[:NAMEN_PFLICHT]:
        if b["name"] and b["name"].casefold() not in klein:
            return "name_fehlt"
    if _ENTWARNUNG.search(text):
        return "entwarnung"
    if not _DEUTSCH.search(text):
        return "sprache"
    if "http" in klein or "www." in klein or "@" in text:
        return "adresse"
    return None


def pruefe_rapport(text: str, lauf: dict[str, Any]) -> str | None:
    """Gleiche Regel wie pruefeRapport im FSM (sonst 422)."""
    k, _w, c, _h = zaehler(lauf)
    if not 10 <= len(text) <= TEXT_MAX:
        return "laenge"
    zahlen = re.findall(r"\d+", text)
    if any(z not in erlaubte_zahlen(lauf) for z in zahlen):
        return "zahl"
    if str(c) not in zahlen:
        return "pruefungen"
    if k > 0 and ("kritisch" not in text.casefold() or str(k) not in zahlen):
        return "kritisch"
    return None


def _zwei_saetze(text: str) -> str:
    saetze = [s for s in _SATZENDE.split(text) if s]
    t = " ".join(saetze[:2])
    return t if t[-1:] in ".!?" else t + "."


def nutzer_prompt(gezeigt: list[dict[str, Any]], weitere: bool) -> str:
    zeilen = []
    for b in gezeigt:
        schwere = "kritisch" if b["severity"] == "critical" else "Warnung"
        art = KATEGORIEN.get(b["category"], b["category"] or "sonstiges")
        zeilen.append(f"- [{schwere}] {art}: {b['title']}")
    if weitere:
        zeilen.append("- (weitere ähnliche Befunde)")
    return "Befunde:\n" + "\n".join(zeilen)


def modell_erklaerung(lauf: dict[str, Any], llm: Any, cfg: Einstellungen) -> tuple[str | None, str]:
    """(geprüfte Erklärung oder None, Grund/«ok»). Wirft nie."""
    liste = befunde(lauf)
    if not liste:
        return None, "keine_befunde"
    gezeigt = liste[:MODELL_BEFUNDE]
    weitere = len(liste) > MODELL_BEFUNDE or _ganz(lauf.get("weitere")) > 0
    try:
        roh, _meta = llm.chat_json(
            modell=cfg.modell_text, system=SYSTEM, nutzer=nutzer_prompt(gezeigt, weitere), schema=SCHEMA,
            # Gleiches Kontextfenster wie die Aufträge: ein anderes num_ctx liesse Ollama das Modell neu laden.
            num_ctx=cfg.llm_num_ctx, num_predict=ANTWORT_TOKENS, timeout_s=MODELL_ZEITLIMIT_S,
        )
    except LlmFehler as e:
        return None, f"modell:{str(e)[:60]}"
    except Exception as e:  # noqa: BLE001 — der Rapport kommt dann aus dem Ersatz
        return None, f"modell:{type(e).__name__}"
    text = saeubern(roh.get("erklaerung") if isinstance(roh, dict) else None)
    if text:
        text = _zwei_saetze(text)
    grund = pruefe_erklaerung(text, lauf, gezeigt)
    return (None, grund) if grund else (text, "ok")


def rapport(lauf: dict[str, Any], llm: Any, cfg: Einstellungen, *, mit_modell: bool = True) -> tuple[str, str]:
    """(Text, Quelle «zahlen»|«modell»|«ersatz»). Der Text besteht pruefe_rapport immer."""
    satz = zahlen_satz(lauf)
    if not befunde(lauf):
        return saeubern(satz), "zahlen"
    erklaerung, quelle = None, "ersatz"
    if mit_modell:
        erklaerung, grund = modell_erklaerung(lauf, llm, cfg)
        if erklaerung:
            quelle = "modell"
        else:
            log.info("Sicherheits-Rapport: Modelltext verworfen (%s) — Ersatztext", grund)
    for teil in ([erklaerung] if erklaerung else []) + [ersatz_erklaerung(lauf)]:
        text = saeubern(f"{satz} {teil}")
        if len(text) > TEXT_MAX:
            text = text[:TEXT_MAX].rsplit(" ", 1)[0].rstrip(";,: ") + "."
        if pruefe_rapport(text, lauf) is None:
            return text, quelle
        quelle = "ersatz"
    return saeubern(satz), "zahlen"


# --- Thread ---------------------------------------------------------------------------------------------------


def _utc_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class SicherheitsRapport(threading.Thread):
    def __init__(self, cfg: Einstellungen, llm: Any, ruhig: Callable[[], bool]) -> None:
        super().__init__(name="ki-sicherheit", daemon=True)
        self.cfg = cfg
        self.llm = llm
        self.ruhig = ruhig
        self._halt = threading.Event()
        self._lock = threading.Lock()
        self._aufgegeben: set[str] = set()
        self._stand: dict[str, Any] = {"letzte_abfrage": None, "letzter_rapport": None, "quelle": None,
                                       "laenge": None, "rapporte": 0, "fehler": None}
        self._fsm = httpx.Client(
            base_url=cfg.fsm_url,
            proxy=cfg.proxy,
            trust_env=False,
            timeout=httpx.Timeout(ZEITLIMIT_S, connect=10.0),
            headers={
                "Authorization": f"Bearer {cfg.sync_token}",
                "User-Agent": f"eventline-ki/{VERSION}",
                "Accept": "application/json",
            },
        )

    def stop(self) -> None:
        self._halt.set()

    def schliessen(self) -> None:
        self._fsm.close()

    def status(self) -> dict[str, Any]:
        """Für /health — Zeiten, Zähler, Quelle, Länge; nie Text oder Titel."""
        with self._lock:
            return {"aktiv": True, **self._stand}

    def _setze(self, **werte: Any) -> None:
        with self._lock:
            self._stand.update(werte)

    def run(self) -> None:
        log.info("Sicherheits-Rapport gestartet — alle %d s an %s", TAKT_S, PFAD)
        naechster = time.monotonic() + ERSTER_VERSUCH_S
        while not self._halt.wait(5.0):
            if time.monotonic() < naechster:
                continue
            naechster = time.monotonic() + TAKT_S
            try:
                self.runde()
            except Exception as e:  # noqa: BLE001 — der Thread darf nie sterben
                log.warning("Sicherheits-Rapport: unerwarteter Fehler (%s)", type(e).__name__)
                self._setze(fehler=type(e).__name__)

    def hole(self) -> dict[str, Any] | None:
        """Neuester Lauf ohne Klartext oder None. Fehler → FsmFehler-artig als RuntimeError."""
        r = self._fsm.get(PFAD)
        if r.status_code in (404, 405):
            return None  # FSM kennt die Route (noch) nicht
        if r.status_code >= 400:
            raise RuntimeError(f"HTTP {r.status_code}")
        daten = r.json()
        lauf = daten.get("lauf") if isinstance(daten, dict) else None
        if not isinstance(lauf, dict) or not isinstance(lauf.get("id"), str):
            return None
        return lauf

    def melde(self, run_id: str, text: str) -> int:
        try:
            r = self._fsm.post(PFAD, json={"run_id": run_id, "text": text})
        except httpx.HTTPError as e:
            raise RuntimeError(f"nicht zugestellt ({type(e).__name__})") from e
        return r.status_code

    def runde(self) -> str:
        """Bis MAX_JE_RUNDE Läufe; liefert, warum die Runde endete (Tests)."""
        for _ in range(MAX_JE_RUNDE):
            if self._halt.is_set():
                return "halt"
            self._setze(letzte_abfrage=_utc_iso())
            try:
                lauf = self.hole()
            except (httpx.HTTPError, RuntimeError, ValueError) as e:
                self._setze(fehler=f"abholen:{type(e).__name__}" if not isinstance(e, RuntimeError) else f"abholen:{e}")
                return "fehler"
            if lauf is None:
                return "nichts"
            run_id = lauf["id"]
            if run_id in self._aufgegeben:
                return "aufgegeben"
            if not self.ruhig():
                return "vorrang"
            text, quelle = rapport(lauf, self.llm, self.cfg)
            try:
                status = self.melde(run_id, text)
                if status == 422 and quelle == "modell":
                    # Das FSM sieht es strenger: einmal nur Zahlen-Satz + Ersatztext.
                    text, quelle = rapport(lauf, self.llm, self.cfg, mit_modell=False)
                    status = self.melde(run_id, text)
            except RuntimeError as e:
                self._setze(fehler=f"melden:{e}")
                return "fehler"
            if status == 200:
                self._setze(letzter_rapport=_utc_iso(), quelle=quelle, laenge=len(text), fehler=None,
                            rapporte=self._stand["rapporte"] + 1)
                log.info("Sicherheits-Rapport gesetzt (%s, %d Zeichen)", quelle, len(text))
                continue
            if status in (404, 409):
                # Schon gesetzt oder nicht mehr da — nicht noch einmal versuchen.
                self._aufgegeben.add(run_id)
                continue
            if status in (400, 422):
                log.warning("Sicherheits-Rapport: FSM weist ab (HTTP %d) — Lauf übersprungen", status)
                self._aufgegeben.add(run_id)
                self._setze(fehler=f"melden:HTTP {status}")
                continue
            self._setze(fehler=f"melden:HTTP {status}")
            return "fehler"
        return "voll"
