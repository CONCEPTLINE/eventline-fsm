"""Firmenwissen (Technik-Seite, Tab «Wissen», Migration 344 im FSM): Einträge, die Admins pflegen — Abkürzung/Begriff,
Benennungsregel, Zuordnung «X gehört zu Y», Ansprechpartner/Rolle, Ordner-Hinweis, Sonstiges.

Das FSM schickt die AKTIVEN Einträge im Nacht-Kontext (GET /api/ki/kontext, Feld `wissen`: kategorie, begriff,
erklaerung, bezug). Hier, alles deterministisch und ohne Modell:
- lese_wissen(): Einträge prüfen (bekannte Kategorie, Längen, ohne Steuerzeichen), höchstens MAX_EINTRAEGE.
- relevante(): die zum Dokument passenden — Begriff oder Bezug steht (normalisiert, als ganze Wortfolge) im gelesenen
  Teil, im Dateinamen oder im bisherigen Ablageort; gekürzt auf ein Zeichen-Budget. Für den Beschrieb nur die
  Kategorien, die beim VERSTEHEN helfen (Abkürzung, Zuordnung, Ansprechpartner, Sonstiges); Benennungsregeln und
  Ordner-Hinweise braucht Claude im FSM (lib/ki/wissen.ts).
- block(): der Abschnitt «Firmenwissen» im Prompt.
- erweiterung(): Wörter der Einträge, deren Begriff in einem Beleg steht — damit gilt z. B. ein Bezug, den das Team
  zur Abkürzung im Dokument erklärt hat, als belegt (belege.py).
Nie im Protokoll, nie geraten.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable

from .belege import woerter

KATEGORIEN = ("abkuerzung", "benennung", "zuordnung", "ansprechpartner", "ordner", "sonstiges")
KATEGORIE_TEXT = {
    "abkuerzung": "Abkürzung/Begriff", "benennung": "Benennungsregel", "zuordnung": "Zuordnung",
    "ansprechpartner": "Ansprechpartner/Rolle", "ordner": "Ordner-Hinweis", "sonstiges": "Sonstiges",
}
# Beim Beschreiben helfen nur diese (Benennung und Ordner entscheidet Claude im FSM).
BESCHRIEB_KATEGORIEN = ("abkuerzung", "zuordnung", "ansprechpartner", "sonstiges")
MAX_EINTRAEGE = 500
MAX_BEGRIFF = 120
MAX_ERKLAERUNG = 600
MAX_BEZUG = 120
# Zeichen für den Abschnitt «Firmenwissen» im Beschrieb-Prompt (~320 Tokens; passt mit dem ganzen Teil in num_ctx 8192,
# jobs/zz.TEIL_ZEICHEN).
BUDGET_ZEICHEN = 800
MAX_JE_EINTRAG = 320

_STEUER = re.compile(r"[\u0000-\u001f\u007f]")


@dataclass(frozen=True)
class WissenEintrag:
    kategorie: str
    begriff: str
    erklaerung: str
    bezug: str | None = None


def _text(roh: object, n: int) -> str:
    if not isinstance(roh, str):
        return ""
    s = _STEUER.sub(" ", unicodedata.normalize("NFC", roh))
    return re.sub(r"\s+", " ", s).strip()[:n].strip()


def lese_wissen(roh: object) -> list[WissenEintrag]:
    """Nacht-Kontext `wissen` → geprüfte Einträge (Unbekanntes fällt weg, doppelte Begriffe je Kategorie einmal)."""
    aus: list[WissenEintrag] = []
    gesehen: set[tuple[str, str]] = set()
    for e in roh if isinstance(roh, list) else []:
        if len(aus) >= MAX_EINTRAEGE:
            break
        if not isinstance(e, dict):
            continue
        kategorie = e.get("kategorie")
        begriff = _text(e.get("begriff"), MAX_BEGRIFF)
        erklaerung = _text(e.get("erklaerung"), MAX_ERKLAERUNG)
        if kategorie not in KATEGORIEN or not begriff or not erklaerung:
            continue
        schluessel = (kategorie, " ".join(woerter(begriff)))
        if schluessel in gesehen:
            continue
        gesehen.add(schluessel)
        aus.append(WissenEintrag(kategorie, begriff, erklaerung, _text(e.get("bezug"), MAX_BEZUG) or None))
    return aus


def _folge_in(folge: list[str], text: str) -> bool:
    return bool(folge) and f" {' '.join(folge)} " in text


def relevante(eintraege: Iterable[WissenEintrag], *texte: str, kategorien: Iterable[str] = BESCHRIEB_KATEGORIEN,
              budget: int = BUDGET_ZEICHEN) -> list[WissenEintrag]:
    """Einträge, deren Begriff (oder Bezug) als ganze Wortfolge in einem der Texte steht. Reihenfolge: Treffer des
    Begriffs vor Treffern des Bezugs, längere Begriffe zuerst (spezifischer); gekürzt auf `budget` Zeichen."""
    erlaubt = set(kategorien)
    quelle = " " + " ".join(w for t in texte for w in woerter(t)) + " "
    treffer: list[tuple[int, int, int, WissenEintrag]] = []
    for i, e in enumerate(eintraege):
        if e.kategorie not in erlaubt:
            continue
        b = woerter(e.begriff)
        if _folge_in(b, quelle):
            treffer.append((0, -len(" ".join(b)), i, e))
        elif e.bezug and _folge_in(woerter(e.bezug), quelle):
            treffer.append((1, -len(e.bezug), i, e))
    aus: list[WissenEintrag] = []
    rest = budget
    for _, _, _, e in sorted(treffer, key=lambda x: (x[0], x[1], x[2])):
        n = len(zeile(e))
        if n > rest:
            continue
        aus.append(e)
        rest -= n
    return aus


def zeile(e: WissenEintrag) -> str:
    text = f"- [{KATEGORIE_TEXT[e.kategorie]}] {e.begriff}: {e.erklaerung}"
    if e.bezug:
        text += f" (Bezug: {e.bezug})"
    return text if len(text) <= MAX_JE_EINTRAG else text[: MAX_JE_EINTRAG - 1].rstrip() + "…"


def block(eintraege: list[WissenEintrag]) -> str:
    """Abschnitt für den Beschrieb-Prompt — leer ohne Einträge."""
    if not eintraege:
        return ""
    return ("Firmenwissen (vom Team gepflegt, hilft beim Verstehen; Belege trotzdem nur aus dem Dokumentteil):\n"
            + "\n".join(zeile(e) for e in eintraege) + "\n\n")


def erweiterung(eintraege: Iterable[WissenEintrag], anker_woerter: list[str]) -> set[str]:
    """Wörter aus Erklärung und Bezug der Einträge, deren Begriff im Beleg steht (als ganze Wortfolge) — nur Kategorien,
    die etwas über das Dokument sagen (keine Benennungsregeln, keine Ordner-Hinweise)."""
    anker = " " + " ".join(anker_woerter) + " "
    aus: set[str] = set()
    for e in eintraege:
        if e.kategorie in BESCHRIEB_KATEGORIEN and _folge_in(woerter(e.begriff), anker):
            aus.update(woerter(e.erklaerung))
            aus.update(woerter(e.bezug or ""))
    return aus
