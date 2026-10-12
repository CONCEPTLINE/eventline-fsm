"""Inhaltssuche im NAS — Auftragsart «nas_suche» (Masterplan §3.3, MP-3, E2.6). Schalter KI_SUCHE_AKTIV.

Verfahren: Einbettung der Frage (bge-m3 auf «schnell», ohne Präfix; während des Planer-Tags keep_alive bis
Tagesende, damit es warm bleibt) → Vektor-Top-50 der Abschnitte + Volltext-Top-50 (ts_rank, websearch_to_tsquery
'german') → Mindest-Ähnlichkeit für Stellen nur aus der Vektorliste (Wort-Anker oder dichte Nachbarschaft, siehe
filtere()) → vereint per Reciprocal Rank
Fusion (k = 60) → je Datei die beste Stelle → höchstens `limit` (Standard 20) Treffer, score 0..1 (1 = Rang 1 in
beiden Listen).

Ergebnis (nie ein Textfeld — der Abschnittstext bleibt im Tresor):
  { "treffer": [ { "pfad", "seite", "score" } ], "index": { "dateien", "gelesen_anteil" }, "dauer_ms",
    "modus": "kombiniert" | "volltext" }
Kaltstart: auf die Einbettung wird höchstens EINBETTUNG_WARTEN_S gewartet; ist sie bis dahin nicht da (Modell lädt,
Ollama weg), kommt sofort das Volltext-Ergebnis mit modus «volltext» — das Laden läuft im Hintergrund weiter, die
nächste Suche ist warm. «Frag das Archiv» (asynchron, ohne festes Zeitlimit) wartet die volle Ladefrist
EINBETTUNG_TIMEOUT_S (stellen(…, frist_s=…)). Vorladen beim Wach-Impuls des FSM (MP-2): vorwaermen().
Nie den Suchbegriff loggen (Masterplan §3.0).
"""

from __future__ import annotations

import logging
import threading
import time
import unicodedata
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FristAbgelaufen
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable

from .archiv import gleiches_modell, platz_fuer_einbettung
from .config import Einstellungen
from .gpu import gpu_info
from .handlers import VerarbeitungsFehler
from .llm import Ollama, tag_keep_alive
from .tiefe import Fund, TiefenIndex, abschnitt_rezept

log = logging.getLogger("ki.suche")

RRF_K = 60
LISTE_K = 50
STANDARD_LIMIT = 20
MAX_LIMIT = 50
Q_MIN, Q_MAX = 2, 200
# Kaltstart (Live-Test 12.10.: bge-m3 nicht geladen → bis 6 s Warten, mit Abholen > 8 s = FSM-Zeitlimit): die Suche
# wartet höchstens so lange auf die Einbettung und liefert sonst sofort nur Volltext. Warm dauert sie 7–12 ms.
EINBETTUNG_WARTEN_S = 2.0
# Das Laden selbst darf im Hintergrund länger dauern (normal ~2 s, mit knappem VRAM länger) — die nächste Suche ist
# dann warm. Hält die GPU-Schleuse nur, solange Ollama lädt.
EINBETTUNG_TIMEOUT_S = 30.0
# Wach-Impuls des FSM (MP-2, naechster_poll_ms kommt mit jedem Poll, solange eilig_bis läuft): höchstens so oft prüfen
# (ein /api/ps an das lokale Ollama, nvidia-smi nur wenn nicht geladen). Live-Test 12.10.: mit 30 s kam eine Suche
# 30 s nach dem Entladen noch kalt an — 5 s holen das Vorladen vor die Suche (Fokus bis Eingabe meist > 3 s).
VORWAERMEN_ABSTAND_S = 5.0
# Mindest-Ähnlichkeit (bge-m3, Kosinus) für Stellen, die NUR die Vektorliste findet. Kalibriert 12.10.2026 auf dem
# Tiefen-Index (449 Dateien, nur Scores; Tabelle im README «Mindest-Ähnlichkeit»): Unsinn-Zeichenfolgen ohne einen
# einzigen Volltext-Treffer erreichen trotzdem 0,37–0,60 (Median ~0,47) — echte Begriffe 0,49–0,70. Eine reine
# Schwelle trennt also nicht. Was trennt:
#  1. Wort-Anker (TiefenIndex.kennt_woerter): ein ganzes Wort der Anfrage steht im Index, ein Index-Wort ab 5
#     Buchstaben steckt in einem Wort der Anfrage (Komposita wie «Spesenabrechnung», viele Tippfehler) oder ein Wort
#     der Anfrage ab 5 Buchstaben ist Anfang eines Index-Worts (halb getippt). 2 von 290 zufälligen Zeichenfolgen haben
#     einen (je ein kurzes ganzes Wort, «foo bar baz» → «bar», wie bisher; Teilwort/Präfix: 0), echte Begriffe fast
#     immer. Mit Anker bleiben Vektor-Stellen ab MIN_AEHNLICHKEIT (gleich wie «Frag das Archiv»).
#  2. Ohne Anker (Englisch, Synonyme ohne gemeinsames Wort): dichte Nachbarschaft — mindestens VERTEILUNG_MIN
#     Stellen ab VERTEILUNG_SCHWELLE; dann bleiben genau diese. Unsinn hatte höchstens 5 solche Stellen (290
#     Zeichenfolgen), «invoice» 40, «salary» 34, «receipt» 28, «lease»/«cancellation» 15.
MIN_AEHNLICHKEIT = 0.45
VERTEILUNG_SCHWELLE = 0.53
VERTEILUNG_MIN = 10
MODUS_KOMBINIERT = "kombiniert"
MODUS_VOLLTEXT = "volltext"
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


def vektor_schwelle(stellen: list[Stelle], wort_anker: bool) -> float | None:
    """Ab welcher Ähnlichkeit Stellen nur aus der Vektorliste bleiben (None: keine). Mit Wort-Anker
    MIN_AEHNLICHKEIT; ohne nur bei dichter Nachbarschaft (≥ VERTEILUNG_MIN Stellen ab VERTEILUNG_SCHWELLE),
    dann VERTEILUNG_SCHWELLE (Kalibrierung bei MIN_AEHNLICHKEIT)."""
    if wort_anker:
        return MIN_AEHNLICHKEIT
    dicht = sum(1 for s in stellen if s.aehnlichkeit is not None and s.aehnlichkeit >= VERTEILUNG_SCHWELLE)
    return VERTEILUNG_SCHWELLE if dicht >= VERTEILUNG_MIN else None


def filtere(stellen: list[Stelle], wort_anker: bool) -> list[Stelle]:
    """Volltext-Stellen bleiben immer; Stellen nur aus der Vektorliste ab vektor_schwelle()."""
    schwelle = vektor_schwelle(stellen, wort_anker)
    return [
        s for s in stellen
        if s.im_volltext or (schwelle is not None and s.aehnlichkeit is not None and s.aehnlichkeit >= schwelle)
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
        # Ein Faden für Einbettungen der Suche und das Vorladen: läuft eine Einbettung über die Frist hinaus (Modell
        # lädt), lädt sie im Hintergrund fertig, ohne dass die Suche wartet.
        self._faden = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ki-suche-einbettung")
        self._lock = threading.Lock()
        self._laufend: Future | None = None
        self._letztes_vorwaermen = float("-inf")

    def _keep_alive(self) -> str | None:
        """Während des Planer-Tags bleibt das Einbettungsmodell bis Tagesende warm (Masterplan §3.3)."""
        try:
            jetzt = self.uhr() if self.uhr is not None else None
        except Exception:  # noqa: BLE001
            return None
        return tag_keep_alive(self.cfg, jetzt)

    # --- Einbettung mit Frist, Vorladen -----------------------------------------------------------

    def _einbetten(self, anfrage: str) -> list[float]:
        platz_fuer_einbettung(self.llm, self.cfg, grund="Inhaltssuche", max_alter_s=5.0)
        [v], _ = self.llm.einbetten(
            modell=self.cfg.modell_embed, texte=[anfrage], timeout_s=EINBETTUNG_TIMEOUT_S, keep_alive=self._keep_alive(),
        )
        return v

    def einbettung(self, anfrage: str, frist_s: float | None = None) -> list[float] | None:
        """Vektor der Anfrage oder None, wenn er nicht innerhalb frist_s (Standard EINBETTUNG_WARTEN_S) da ist
        (Kaltstart) oder das Modell fehlt. Bei Fristablauf lädt das Modell im Hintergrund weiter; eine noch nicht
        begonnene Einbettung wird verworfen."""
        frist_s = EINBETTUNG_WARTEN_S if frist_s is None else frist_s
        with self._lock:
            auftrag = self._faden.submit(self._einbetten, anfrage)
            self._laufend = auftrag
        try:
            return auftrag.result(timeout=frist_s)
        except FristAbgelaufen:
            auftrag.cancel()
            log.warning("Inhaltssuche: Einbettung nicht innert %.1f s (Modell lädt) — nur Volltext", frist_s)
        except Exception as e:  # noqa: BLE001 — LlmFehler, Ollama weg, Unerwartetes: die Suche läuft mit Volltext weiter
            log.warning("Inhaltssuche: Einbettung nicht verfügbar (%s) — nur Volltext", type(e).__name__)
        return None

    def vorwaermen(self) -> bool:
        """Wach-Impuls des FSM (MP-2): bge-m3 im Hintergrund laden, falls nicht geladen. Wartet nie und wirft nie;
        höchstens alle VORWAERMEN_ABSTAND_S; True = Prüfung angestossen."""
        with self._lock:
            jetzt = time.monotonic()
            if jetzt - self._letztes_vorwaermen < VORWAERMEN_ABSTAND_S:
                return False
            if self._laufend is not None and not self._laufend.done():
                return False   # eine Einbettung/Vorladung läuft schon
            self._letztes_vorwaermen = jetzt
            self._laufend = self._faden.submit(self._vorwaermen)
        return True

    def _vorwaermen(self) -> str:
        """Ergebnis nur für Log und Tests: «warm», «geladen», «kein_platz», «belegt», «unbekannt», «fehler»."""
        try:
            geladen = self.llm.geladene_modelle_oder_none()
            if geladen is None:
                return "unbekannt"
            if any(gleiches_modell(str(m.get("name") or ""), self.cfg.modell_embed) for m in geladen):
                return "warm"
            # Nie den Live-Pfad verdrängen: ohne genug freien VRAM (Whisper + Sprachmodell geladen) lädt die erste
            # Suche selbst (sie entlädt dann wie bisher, platz_fuer_einbettung) — hier wird nichts entladen.
            frei = gpu_info(max_alter_s=0).get("frei_mb")
            if isinstance(frei, int) and frei < self.cfg.embed_min_frei_mb:
                log.info("Inhaltssuche: Vorladen ausgelassen (%d MB VRAM frei < %d)", frei, self.cfg.embed_min_frei_mb)
                return "kein_platz"
            ms = self.llm.vorladen(modell=self.cfg.modell_embed, keep_alive=self._keep_alive(), timeout_s=EINBETTUNG_TIMEOUT_S)
            if ms is None:
                return "belegt"   # GPU-Schleuse belegt — der nächste Impuls (nach VORWAERMEN_ABSTAND_S) versucht es wieder
            log.info("Inhaltssuche: %s vorgeladen (Wach-Impuls), Laden %d ms", self.cfg.modell_embed, ms)
            return "geladen"
        except Exception as e:  # noqa: BLE001 — Vorladen ist nur ein Vorteil, nie ein Fehler
            log.warning("Inhaltssuche: Vorladen fehlgeschlagen (%s)", type(e).__name__)
            return "fehler"

    # --- Suche ------------------------------------------------------------------------------------

    def stellen(self, anfrage: str, frist_s: float | None = None) -> tuple[list[Stelle], dict[str, Any]]:
        """Vereinte, gefilterte Stellen (ohne Text) und Zähler zur Messung (ohne Inhalte); meta["modus"] ist
        «kombiniert» (Vektor + Volltext) oder «volltext» (Einbettung nicht rechtzeitig/nicht verfügbar).
        frist_s: so lange auf die Einbettung warten (Standard EINBETTUNG_WARTEN_S — die Suche hat ein festes
        FSM-Zeitlimit; «Frag das Archiv» läuft asynchron und wartet die volle Ladezeit)."""
        if not self.index.aktiv:
            raise VerarbeitungsFehler("Inhaltssuche: Tiefen-Index nicht verfügbar")
        v = self.einbettung(anfrage, frist_s)
        meta: dict[str, Any] = {"vektor": v is not None, "modus": MODUS_KOMBINIERT if v is not None else MODUS_VOLLTEXT}
        vektor_liste: list[Fund] = []
        anker = False
        try:
            if v is not None:
                vektor_liste = self.index.vektor_treffer(v, self.rezept, LISTE_K)
            volltext = self.index.text_treffer(anfrage, self.rezept, LISTE_K)
            if vektor_liste:
                # Volltext-Treffer heisst: alle Wörter stehen im Index. Sonst eigens prüfen, ob wenigstens eines.
                anker = bool(volltext) or self.index.kennt_woerter(anfrage, self.rezept)
        except Exception as e:  # noqa: BLE001 — Klartext ohne Inhalte
            log.warning("Inhaltssuche: Datenbank-Fehler (%s)", type(e).__name__)
            raise VerarbeitungsFehler("Inhaltssuche: Datenbank nicht erreichbar") from e
        alle = vereine(vektor_liste, volltext)
        stellen = filtere(alle, anker)
        meta.update(vektor_treffer=len(vektor_liste), volltext_treffer=len(volltext), wort_anker=anker,
                    verteilung=bool(vektor_liste) and not anker and vektor_schwelle(alle, anker) is not None,
                    unter_schwelle=len(alle) - len(stellen))
        return stellen, meta

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
    log.info("nas_suche: %d Treffer (Vektor %s, Volltext %d, verworfen %d, Wort-Anker %s) in %d ms",
             len(treffer), meta.get("vektor_treffer") if meta.get("vektor") else "aus", meta.get("volltext_treffer", 0),
             meta.get("unter_schwelle", 0),
             "ja" if meta.get("wort_anker") else ("Verteilung" if meta.get("verteilung") else "nein"), dauer)
    return {"treffer": treffer, "index": suche.index_info(), "dauer_ms": dauer, "modus": meta["modus"]}
