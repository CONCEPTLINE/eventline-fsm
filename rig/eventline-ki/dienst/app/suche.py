"""Inhaltssuche im NAS — Auftragsart «nas_suche» (Masterplan §3.3, MP-3, E2.6). Schalter KI_SUCHE_AKTIV.

Verfahren: Einbettung der Frage (bge-m3 auf «schnell», ohne Präfix; tagsüber keep_alive «2h», damit es warm bleibt)
→ Vektor-Top-50 der Abschnitte + Volltext-Top-50 (ts_rank, websearch_to_tsquery 'german') → vereint per Reciprocal
Rank Fusion (k = 60) → je Datei die beste Stelle → höchstens `limit` (Standard 20) Treffer, score 0..1 (1 = Rang 1 in
beiden Listen).

Ergebnis (nie ein Textfeld — der Abschnittstext bleibt im Tresor):
  { "treffer": [ { "pfad", "seite", "score" } ], "index": { "dateien", "gelesen_anteil" }, "dauer_ms" }
Ist die Einbettung nicht verfügbar (Modell lädt, Ollama weg), sucht sie nur im Volltext weiter.
Nie den Suchbegriff loggen (Masterplan §3.0).
"""

from __future__ import annotations

import logging
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable

from .archiv import platz_fuer_einbettung
from .config import Einstellungen
from .handlers import VerarbeitungsFehler
from .llm import LlmFehler, Ollama
from .tiefe import Fund, TiefenIndex, abschnitt_rezept

log = logging.getLogger("ki.suche")

RRF_K = 60
LISTE_K = 50
STANDARD_LIMIT = 20
MAX_LIMIT = 50
Q_MIN, Q_MAX = 2, 200
TAG_KEEP_ALIVE = "2h"
EINBETTUNG_TIMEOUT_S = 6.0
# Nur diese Schlüssel verlassen das Rig (Schema-Test in tests/test_suche.py).
TREFFER_FELDER = ("pfad", "seite", "score")


def lies_text(roh: object, minimum: int, maximum: int) -> str | None:
    """Suchbegriff/Frage: String, NFC, getrimmt, Länge min..max — sonst None."""
    if not isinstance(roh, str):
        return None
    text = unicodedata.normalize("NFC", roh).strip()
    return text if minimum <= len(text) <= maximum else None


def lies_limit(roh: object) -> int:
    if isinstance(roh, bool) or not isinstance(roh, (int, float)):
        return STANDARD_LIMIT
    return max(1, min(MAX_LIMIT, int(roh)))


@dataclass(frozen=True)
class Stelle:
    """Ein Abschnitt nach der Vereinigung (ohne Text)."""

    id: int
    pfad: str
    seite: int | None
    rrf: float
    aehnlichkeit: float | None   # Kosinus aus der Vektorliste (None: nur im Volltext gefunden)
    im_volltext: bool


def vereine(vektor: list[Fund], volltext: list[Fund], *, k: int = RRF_K) -> list[Stelle]:
    """Reciprocal Rank Fusion beider Listen; Reihenfolge: RRF absteigend, dann id (stabil)."""
    punkte: dict[int, float] = {}
    info: dict[int, Fund] = {}
    aehnlich: dict[int, float] = {}
    volltext_ids: set[int] = set()
    for rang, f in enumerate(vektor, start=1):
        punkte[f.id] = punkte.get(f.id, 0.0) + 1.0 / (k + rang)
        info.setdefault(f.id, f)
        aehnlich[f.id] = f.wert
    for rang, f in enumerate(volltext, start=1):
        punkte[f.id] = punkte.get(f.id, 0.0) + 1.0 / (k + rang)
        info.setdefault(f.id, f)
        volltext_ids.add(f.id)
    reihe = sorted(punkte, key=lambda i: (-punkte[i], i))
    return [
        Stelle(i, info[i].pfad, info[i].seite, punkte[i], aehnlich.get(i), i in volltext_ids)
        for i in reihe
    ]


def ist_systempfad(pfad: str) -> bool:
    return pfad == "99_System" or pfad.startswith("99_System/") or "/99_System/" in pfad


def je_datei(stellen: list[Stelle], limit: int, *, k: int = RRF_K) -> list[dict[str, Any]]:
    """Je Datei die beste Stelle, höchstens `limit` — nur pfad, seite, score (0..1; Bezug ist der bestmögliche
    RRF-Wert, Rang 1 in beiden Listen)."""
    rrf_max = 2.0 / (k + 1)
    aus: list[dict[str, Any]] = []
    gesehen: set[str] = set()
    for s in stellen:
        if s.pfad in gesehen or ist_systempfad(s.pfad):
            continue
        gesehen.add(s.pfad)
        seite = s.seite if isinstance(s.seite, int) and s.seite >= 1 else None
        aus.append({"pfad": s.pfad, "seite": seite, "score": round(min(1.0, max(0.0, s.rrf / rrf_max)), 4)})
        if len(aus) >= limit:
            break
    return aus


class Suche:
    """Gemeinsamer Kern von nas_suche und archiv_frage (eigene DB-Verbindung mit statement_timeout)."""

    def __init__(
        self,
        cfg: Einstellungen,
        index: TiefenIndex,
        llm: Ollama,
        *,
        stand: Callable[[], dict[str, Any]] = dict,
        uhr: Callable[[], datetime] | None = None,
    ) -> None:
        self.cfg = cfg
        self.index = index
        self.llm = llm
        self.stand = stand
        self.uhr = uhr
        self.rezept = abschnitt_rezept(cfg)

    def _keep_alive(self) -> str | None:
        """Tagsüber (07–19 Uhr) bleibt das Einbettungsmodell 2 h warm (Masterplan §3.3)."""
        try:
            if self.uhr is not None:
                jetzt = self.uhr()
            else:
                from zoneinfo import ZoneInfo

                jetzt = datetime.now(ZoneInfo("Europe/Zurich"))
        except Exception:  # noqa: BLE001
            return None
        return TAG_KEEP_ALIVE if 7 <= jetzt.hour < 19 else None

    def stellen(self, anfrage: str) -> tuple[list[Stelle], dict[str, Any]]:
        """Vereinte Stellen (ohne Text) und Zähler zur Messung (ohne Inhalte)."""
        if not self.index.aktiv:
            raise VerarbeitungsFehler("Inhaltssuche: Tiefen-Index nicht verfügbar")
        meta: dict[str, Any] = {"vektor": False}
        vektor_liste: list[Fund] = []
        try:
            platz_fuer_einbettung(self.llm, self.cfg, grund="Inhaltssuche", max_alter_s=5.0)
            [v], _ = self.llm.einbetten(
                modell=self.cfg.modell_embed, texte=[anfrage], timeout_s=EINBETTUNG_TIMEOUT_S, keep_alive=self._keep_alive(),
            )
            meta["vektor"] = True
        except (LlmFehler, ValueError) as e:
            log.warning("Inhaltssuche: Einbettung nicht verfügbar (%s) — nur Volltext", type(e).__name__)
            v = None
        try:
            if v is not None:
                vektor_liste = self.index.vektor_treffer(v, self.rezept, LISTE_K)
            volltext = self.index.text_treffer(anfrage, self.rezept, LISTE_K)
        except Exception as e:  # noqa: BLE001 — Klartext ohne Inhalte
            log.warning("Inhaltssuche: Datenbank-Fehler (%s)", type(e).__name__)
            raise VerarbeitungsFehler("Inhaltssuche: Datenbank nicht erreichbar") from e
        meta.update(vektor_treffer=len(vektor_liste), volltext_treffer=len(volltext))
        return vereine(vektor_liste, volltext), meta

    def index_info(self) -> dict[str, Any]:
        z = self.index.zaehler(max_alter_s=30.0)
        dateien = z.get("dateien") if z else None
        nas = (self.stand() or {}).get("nas_dateien")
        anteil = None
        if isinstance(dateien, int) and isinstance(nas, int) and nas > 0:
            anteil = round(min(1.0, dateien / nas), 3)
        elif dateien == 0:
            anteil = 0.0
        return {"dateien": dateien, "gelesen_anteil": anteil}


def nas_suche(payload: dict[str, Any], suche: Suche) -> dict[str, Any]:
    start = time.monotonic()
    q = lies_text(payload.get("q"), Q_MIN, Q_MAX)
    if q is None:
        raise VerarbeitungsFehler(f"Suchbegriff fehlt oder ist ungültig ({Q_MIN}–{Q_MAX} Zeichen)")
    limit = lies_limit(payload.get("limit"))
    stellen, meta = suche.stellen(q)
    treffer = je_datei(stellen, limit)
    dauer = int((time.monotonic() - start) * 1000)
    log.info("nas_suche: %d Treffer (Vektor %s, Volltext %d) in %d ms",
             len(treffer), meta.get("vektor_treffer") if meta.get("vektor") else "aus", meta.get("volltext_treffer", 0), dauer)
    return {"treffer": treffer, "index": suche.index_info(), "dauer_ms": dauer}
