"""«Frag das Archiv» — Auftragsart «archiv_frage» (Masterplan §3.4, MP-4, E2.6). Schalter KI_ARCHIV_FRAGE_AKTIV.

Ablauf: Suche wie nas_suche (suche.Suche) → die besten 8 Abschnitte → Antwort NUR aus diesen Fundstellen, lokal mit
dem schnellen Modell (KI_MODELL_TEXT, gemma3:4b auf der GPU). Kein FSM-Auftrag geht ans Hauptmodell (Entscheid E1,
Masterplan §1.5: «immer gemma3:4b»). Gibt es keine passende Fundstelle, kommt der feste Satz KEINE_FUNDSTELLE und
keine Quelle — ohne Modellaufruf, wenn schon die Suche nichts Brauchbares findet.

Ergebnis: { "antwort", "quellen": [ { "pfad", "seite" } ] (≤ 8), "modell", "dauer_ms" } — kein Abschnittstext.
Weder Frage noch Antwort gehen in Logs oder Protokoll.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from .config import Einstellungen
from .handlers import VerarbeitungsFehler
from .llm import LlmFehler, Ollama
from .suche import Stelle, Suche, ist_systempfad, lies_text

log = logging.getLogger("ki.archiv_frage")

KEINE_FUNDSTELLE = "Dazu finde ich im Archiv nichts."
FRAGE_MIN, FRAGE_MAX = 3, 500
MAX_STELLEN = 8
MAX_QUELLEN = 8
ANTWORT_MAX = 4000
# Ohne Treffer im Volltext muss die beste Stelle der Vektorliste mindestens so ähnlich sein (bge-m3, Kosinus) —
# sonst gilt «keine passende Fundstelle», ohne Modellaufruf. Erst mit echten Fragen nachjustieren (offen).
MIN_AEHNLICHKEIT = 0.45
# Grob 6000 Tokens für die Fundstellen (Masterplan §3.4); die Abschnitte sind ~800 Zeichen.
MAX_KONTEXT_ZEICHEN = 18_000
ANTWORT_TOKENS = 700
TIMEOUT_S = 100.0

SYSTEM = (
    "Du beantwortest Fragen zum Dokumentarchiv der Firma EVENTLINE. Du bekommst nummerierte Auszüge aus Dokumenten. "
    "Antworte auf Deutsch (Schweizer Schreibweise, ss statt ß), knapp und sachlich, in höchstens fünf Sätzen. "
    "Verwende AUSSCHLIESSLICH Informationen aus den Auszügen — nichts erfinden, nichts aus eigenem Wissen ergänzen. "
    "Setze «quellen» auf die Nummern der Auszüge, auf die sich die Antwort stützt. "
    f"Beantworten die Auszüge die Frage nicht, schreibe als Antwort genau: «{KEINE_FUNDSTELLE}» und lasse «quellen» leer."
)

# Gemessen 2026-10-11 mit gemma3:4b: ein Feld «gefunden» VOR der Antwort war fast immer false (auch mit Antwort),
# NACH der Antwort immer true — als Schalter unbrauchbar. Der feste Satz in der Antwort selbst trennt sauber
# (4 von 4 unbeantwortbaren Fragen → Satz, 3 von 3 beantwortbaren → Antwort).
SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "antwort": {"type": "string", "maxLength": 1500},
        "quellen": {"type": "array", "items": {"type": "integer", "minimum": 1, "maximum": MAX_STELLEN}, "maxItems": MAX_STELLEN},
    },
    "required": ["antwort", "quellen"],
}
_KEINE_KERN = "finde ich im archiv nichts"


def ohne_antwort(antwort: str) -> bool:
    """Leer oder der feste Satz (auch leicht abgewandelt, z. B. ohne Punkt)."""
    return not antwort.strip() or _KEINE_KERN in antwort.lower()


def passend(stellen: list[Stelle]) -> bool:
    """Gibt es überhaupt eine brauchbare Fundstelle? Volltext-Treffer oder genug ähnlich im Vektor."""
    if not stellen:
        return False
    if any(s.im_volltext for s in stellen):
        return True
    return max((s.aehnlichkeit or 0.0) for s in stellen) >= MIN_AEHNLICHKEIT


def auswahl(stellen: list[Stelle]) -> list[Stelle]:
    return [s for s in stellen if not ist_systempfad(s.pfad)][:MAX_STELLEN]


def prompt(frage: str, beste: list[Stelle], texte: dict[int, str]) -> tuple[str, list[Stelle]]:
    """Nummerierte Auszüge (Dateiname, Seite, Text) + Frage; liefert auch die tatsächlich verwendeten Stellen."""
    teile: list[str] = []
    benutzt: list[Stelle] = []
    zeichen = 0
    for s in beste:
        text = (texte.get(s.id) or "").strip()
        if not text:
            continue
        if zeichen + len(text) > MAX_KONTEXT_ZEICHEN and benutzt:
            break
        zeichen += len(text)
        benutzt.append(s)
        name = s.pfad.rsplit("/", 1)[-1]
        ort = f"{name}, Seite {s.seite}" if s.seite else name
        teile.append(f"[{len(benutzt)}] ({ort})\n{text}")
    nutzer = "Auszüge:\n\n" + "\n\n".join(teile) + f"\n\nFrage: {frage}\n\nAntworte nur im verlangten JSON."
    return nutzer, benutzt


def quellen_aus(nummern: object, benutzt: list[Stelle]) -> list[dict[str, Any]]:
    """Nummern des Modells → Quellen (pfad, seite), ohne Doppel, höchstens 8. Ohne gültige Nummer: die drei besten
    verwendeten Stellen (die Antwort stammt dann trotzdem nur aus diesen Auszügen)."""
    gewaehlt: list[Stelle] = []
    if isinstance(nummern, list):
        for n in nummern:
            if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= len(benutzt):
                continue
            gewaehlt.append(benutzt[n - 1])
    if not gewaehlt:
        gewaehlt = benutzt[:3]
    aus: list[dict[str, Any]] = []
    for s in gewaehlt:
        eintrag = {"pfad": s.pfad, "seite": s.seite if isinstance(s.seite, int) and s.seite >= 1 else None}
        if eintrag not in aus:
            aus.append(eintrag)
        if len(aus) >= MAX_QUELLEN:
            break
    return aus


def archiv_frage(payload: dict[str, Any], suche: Suche, llm: Ollama, cfg: Einstellungen) -> tuple[dict[str, Any], str | None]:
    start = time.monotonic()
    frage = lies_text(payload.get("frage"), FRAGE_MIN, FRAGE_MAX)
    if frage is None:
        raise VerarbeitungsFehler(f"Frage fehlt oder ist ungültig ({FRAGE_MIN}–{FRAGE_MAX} Zeichen)")

    def ohne_fund(grund: str) -> tuple[dict[str, Any], None]:
        dauer = int((time.monotonic() - start) * 1000)
        log.info("archiv_frage: keine Fundstelle (%s) in %d ms", grund, dauer)
        return {"antwort": KEINE_FUNDSTELLE, "quellen": [], "modell": None, "dauer_ms": dauer}, None

    stellen, _meta = suche.stellen(frage)
    beste = auswahl(stellen)
    if not passend(beste):
        return ohne_fund("suche")
    try:
        texte = suche.index.abschnitt_texte([s.id for s in beste])
    except Exception as e:  # noqa: BLE001
        log.warning("archiv_frage: Abschnitte nicht lesbar (%s)", type(e).__name__)
        raise VerarbeitungsFehler("Frag das Archiv: Datenbank nicht erreichbar") from e
    nutzer, benutzt = prompt(frage, beste, texte)
    if not benutzt:
        return ohne_fund("leer")
    modell = cfg.modell_text
    try:
        roh, meta = llm.chat_json(
            modell=modell, system=SYSTEM, nutzer=nutzer, schema=SCHEMA, num_ctx=cfg.llm_num_ctx,
            num_predict=ANTWORT_TOKENS, timeout_s=TIMEOUT_S,
        )
    except LlmFehler as e:
        raise VerarbeitungsFehler(str(e)[:200]) from e
    antwort = roh.get("antwort") if isinstance(roh.get("antwort"), str) else ""
    antwort = antwort.strip().replace("ß", "ss")[:ANTWORT_MAX].strip()
    if ohne_antwort(antwort) or roh.get("gefunden") is False:
        return ohne_fund("modell")
    dauer = int((time.monotonic() - start) * 1000)
    quellen = quellen_aus(roh.get("quellen"), benutzt)
    log.info("archiv_frage: Antwort mit %d Quelle(n) aus %d Auszügen in %d ms (Modell %d ms)",
             len(quellen), len(benutzt), dauer, meta.get("dauer_ms") or 0)
    return {"antwort": antwort, "quellen": quellen, "modell": modell, "dauer_ms": dauer}, modell
