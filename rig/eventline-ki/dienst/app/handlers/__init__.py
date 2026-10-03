"""Verarbeitung je Auftragsart (SPEC §2.2) plus gemeinsame Prüf-Helfer.

Alle Handler liefern genau die Ergebnisform aus SPEC §3 und werfen bei
Problemen VerarbeitungsFehler mit einem deutschen Klartext — der geht so ans
FSM (ok:false, fehler) und nie mit Dokumentinhalt.
"""

from __future__ import annotations

import re
from datetime import date

_DATUM = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class VerarbeitungsFehler(Exception):
    """Klartext-Fehler für das FSM (ok:false, fehler)."""


def datum_gueltig(wert: object) -> str | None:
    """YYYY-MM-DD, nur wenn es ein echtes Datum in plausiblem Rahmen ist."""
    if not isinstance(wert, str):
        return None
    s = wert.strip()
    if not _DATUM.match(s):
        return None
    try:
        d = date.fromisoformat(s)
    except ValueError:
        return None
    if d.year < 1950 or d.year > 2100:
        return None
    return s


def text_kurz(wert: object, max_zeichen: int) -> str:
    """Whitespace glätten, Schweizer Schreibweise (ss statt ß), Länge begrenzen."""
    if not isinstance(wert, str):
        return ""
    s = re.sub(r"\s+", " ", wert).strip().replace("ß", "ss")
    return s[:max_zeichen].strip()


def zahl_oder_none(wert: object) -> float | None:
    if isinstance(wert, bool):
        return None
    if isinstance(wert, (int, float)):
        return float(wert)
    if isinstance(wert, str):
        s = wert.strip().replace("'", "").replace("CHF", "").replace(" ", "")
        s = s.replace(",", ".")
        try:
            return float(s)
        except ValueError:
            return None
    return None


def liste_von_texten(wert: object, max_eintraege: int, max_zeichen: int = 160) -> list[str]:
    if not isinstance(wert, list):
        return []
    aus = []
    for eintrag in wert:
        if isinstance(eintrag, str) and eintrag.strip():
            aus.append(text_kurz(eintrag, max_zeichen))
        if len(aus) >= max_eintraege:
            break
    return aus
