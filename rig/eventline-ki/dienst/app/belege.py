"""Belegstellen gegen Erfinden (Rezepte zz/v4 und fristen/v3, 16.10.2026).

Befund der Messnacht 15./16.10.: gemma3:4b schrieb vor dem Filter bei 32,7 % der geprüften Angaben Unbelegtes (Datum
50/80, Status 58/67), bei den Fristen waren 14 von 23 erfunden, und Beispiele aus der Anleitung tauchten in Beschrieben
auf («Verwaltungsvertrag Location» 7×, «zu Veranstaltung X» 2×, EVENTLINE als «Arbeitgeber» 22×).

Darum trägt jede Angabe der lokalen KI zu Datum, Zeitraum, Status, Bezug/Version, Absender/Empfänger und zu jeder
beteiligten Person/Firma (mit Rolle) — und jede Frist — eine Belegstelle: den Teil, den die KI gerade liest, und einen
Beleg von höchstens 8 Wörtern, buchstabengetreu aus diesem Teil. Hier wird das geprüft, deterministisch und ohne Modell:

1. anker_finden(): der Beleg steht im Teil — normalisiert (Gross/klein, ä/ae/a, ß/ss, Ligaturen, Satzzeichen,
   Silbentrennung am Zeilenende) und «fast wörtlich»: kein Wort des Belegs fehlt, im Dokument dürfen höchstens zwei
   Wörter dazwischen stehen. Die Seite kommt aus den Seitenmarken «[Seite N]».
2. Der Wert passt zum Beleg: datum_belegt (das Datum steht im Beleg, übliche Schreibweisen), zeitraum_belegt (Jahre und
   Monate), status_belegt (das Statuswort — eine Unterschriftszeile allein heisst nicht «unterschrieben»), name_belegt
   (die Wörter des Namens), bezug_belegt (Wörter und Zahlen des Bezugs), rolle_belegt (die Rolle steht im Teil).
   Erklärt das Firmenwissen einen Begriff, der im Beleg steht, zählen auch dessen Wörter (wissen.erweiterung).
   Passt der Beleg nicht, sucht das Rig den Wert selbst im Teil (wert_im_teil, gleiche Massstäbe, ohne Firmenwissen):
   steht er dort, ist seine Stelle die Belegstelle. Gemessen 16.10.: die KI schrieb oft eine ungenaue Stelle zu einem
   Wert, der wörtlich im Teil steht — Erfundenes steht nirgends und fällt weiter weg.
3. prompt_kopie(): Wortfolgen aus Beispielen der Anleitungen bis zum 15.10. (und «Dieser Vertrag …» ohne Vertrag im
   Dokument) gelten nur, wenn sie auch im Dokument stehen.

Unbelegtes wird verworfen und im Beschrieb als «unbekannt» geführt — nie geraten. Die Belege selbst bleiben auf dem Rig:
nie ans FSM, an Claude, ins Protokoll oder ins Log. Gezählt wird nur, ob belegt (Belegquote, Technik-Dashboard).
"""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable

# Gleiche Monatsnamen wie die Fristen-Prüfung (jobs/fristen._MONATE), gefaltet.
_MONATE_ROH: dict[int, tuple[str, ...]] = {
    1: ("januar", "janner", "jan", "january", "janvier", "janv", "gennaio"),
    2: ("februar", "feb", "febr", "february", "fevrier", "fevr", "febbraio"),
    3: ("marz", "mar", "mrz", "march", "mars", "marzo"),
    4: ("april", "apr", "avril", "avr", "aprile"),
    5: ("mai", "may", "maggio"),
    6: ("juni", "jun", "june", "juin", "giugno"),
    7: ("juli", "jul", "july", "juillet", "juil", "luglio"),
    8: ("august", "aug", "aout", "agosto"),
    9: ("september", "sept", "sep", "septembre", "settembre"),
    10: ("oktober", "okt", "october", "oct", "octobre", "ottobre"),
    11: ("november", "nov", "novembre"),
    12: ("dezember", "dez", "december", "dec", "decembre", "dicembre"),
}
MONAT_NR: dict[str, int] = {name: nr for nr, namen in _MONATE_ROH.items() for name in namen}

MAX_ANKER_WOERTER = 12          # Anleitung: höchstens 8 — etwas Spielraum, ein längerer Beleg ist nicht schwächer
MAX_LUECKE = 2                  # «fast wörtlich»: so viele Wörter im Dokument dürfen zwischen den Beleg-Wörtern stehen
UNBEKANNT = "unbekannt"

_FALTUNG = str.maketrans({"ä": "a", "ö": "o", "ü": "u", "ß": "ss", "é": "e", "è": "e", "ê": "e", "à": "a", "â": "a",
                          "ç": "c", "ô": "o", "î": "i", "ï": "i", "ë": "e", "ñ": "n", "ć": "c", "č": "c", "š": "s",
                          "ž": "z", "ø": "o", "å": "a"})
_UNSICHTBAR = re.compile(r"[­​‌‍⁠﻿]")
# Silbentrennung am Zeilenende («Kündi-\ngung»): Bindestrich + Zeilenumbruch zwischen zwei Buchstaben.
_TRENNUNG = re.compile(r"(?<=[^\W\d_])-[ \t]*\r?\n[ \t]*(?=[^\W\d_])")
_SEITENMARKE = re.compile(r"^\[Seite (\d{1,6})\]$", re.M)
_WORT = re.compile(r"[^\W_]+")
# Rechtsformen und Füllwörter zählen bei Namen nicht als Beleg-Wort.
_NAMEN_FUELL = frozenset({"gmbh", "ag", "sa", "sarl", "sagl", "kg", "ohg", "gbr", "ev", "inc", "ltd", "llc", "co",
                          "cie", "und", "the", "of", "et", "plc", "bv", "nv", "ug", "mbh", "verein"})
_STOPP = frozenset({"der", "die", "das", "den", "dem", "des", "ein", "eine", "einer", "eines", "zum", "zur", "fur",
                    "von", "vom", "mit", "und", "oder", "bei", "beim", "auf", "aus", "nach", "uber", "unter", "fuer",
                    "sowie", "als", "dieser", "diese", "dieses", "the", "and", "for", "les", "des", "pour", "avec",
                    "bis", "per", "pro", "via", "ins", "ans", "vor", "nur", "sur", "par", "une", "del", "con", "ohne"})


def falte(s: str) -> str:
    """Kleinbuchstaben, Ligaturen aufgelöst (NFKC), Umlaute in beiden Schreibweisen gleich (ä, ae → a), ß → ss."""
    t = unicodedata.normalize("NFKC", _UNSICHTBAR.sub("", s or "")).lower()
    return t.replace("ae", "a").replace("oe", "o").replace("ue", "u").translate(_FALTUNG)


def woerter(s: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", falte(s))


def _woerter_mit_lage(text: str) -> tuple[list[str], list[int]]:
    toks: list[str] = []
    lagen: list[int] = []
    for m in _WORT.finditer(text):
        for t in re.findall(r"[a-z0-9]+", falte(m.group())):
            toks.append(t)
            lagen.append(m.start())
    return toks, lagen


class Teil:
    """Ein gelesener Teil des Dokuments: Wortfolge (zweimal: wie gelesen und mit aufgelöster Silbentrennung),
    Lage jedes Worts und die Seitenmarken."""

    def __init__(self, nr: int, text: str) -> None:
        self.nr = nr
        self.text = _UNSICHTBAR.sub("", text or "")
        self.varianten: list[tuple[list[str], list[int], list[tuple[int, int]]]] = []
        for t in dict.fromkeys((self.text, _TRENNUNG.sub("", self.text))):
            toks, lagen = _woerter_mit_lage(t)
            marken = [(m.start(), int(m.group(1))) for m in _SEITENMARKE.finditer(t)]
            self.varianten.append((toks, lagen, marken))
        self.menge: frozenset[str] = frozenset(w for v in self.varianten for w in v[0])

    def seite_bei(self, variante: int, lage: int) -> int | None:
        seite = None
        for start, n in self.varianten[variante][2]:
            if start > lage:
                break
            seite = n
        return seite


@dataclass(frozen=True)
class Fund:
    """Belegstelle: Teil-Nr. und Seite (falls Seitenmarken) — der Beleg-Text selbst bleibt beim Aufrufer."""
    teil: int
    seite: int | None
    woerter: tuple[str, ...]


def anker_woerter(anker: object) -> list[str] | None:
    """Wörter eines Belegs, oder None (leer, «unbekannt», zu lang, ohne ein Wort aus mindestens 2 Zeichen)."""
    if not isinstance(anker, str):
        return None
    roh = anker.strip().strip("\"'«»„“”‚‘’ ").strip()
    if not roh or falte(roh) == UNBEKANNT or len(roh.split()) > MAX_ANKER_WOERTER:
        return None
    w = woerter(roh)
    if not w or not any(len(x) >= 2 for x in w):
        return None
    return w


def _suche(folge: list[str], toks: list[str], max_luecke: int = MAX_LUECKE) -> int | None:
    """Startposition der Folge in toks (fast wörtlich: höchstens max_luecke fremde Wörter dazwischen), sonst None."""
    n = len(folge)
    for i, t in enumerate(toks):
        if t != folge[0]:
            continue
        j, k, luecke = i + 1, 1, 0
        while k < n and j < len(toks):
            if toks[j] == folge[k]:
                k += 1
            else:
                luecke += 1
                if luecke > max_luecke:
                    break
            j += 1
        if k == n:
            return i
    return None


def anker_finden(anker: object, teil: Teil) -> Fund | None:
    w = anker_woerter(anker)
    if w is None:
        return None
    for v, (toks, lagen, _marken) in enumerate(teil.varianten):
        i = _suche(w, toks)
        if i is not None:
            return Fund(teil.nr, teil.seite_bei(v, lagen[i]), tuple(w))
    return None


# --- Wert passt zum Beleg -----------------------------------------------------------------------------------------


def _gleich(a: str, b: str) -> bool:
    """Wort a ist b — oder (ab 5 Zeichen) dieselbe Wortform mit Endung (Genitiv, Plural): «hassemers» ~ «hassemer»."""
    if a == b:
        return True
    k, l_ = (a, b) if len(a) <= len(b) else (b, a)
    return len(k) >= 5 and l_.startswith(k) and len(l_) - len(k) <= 3


def _belegt_in(w: str, woerter_: Iterable[str]) -> bool:
    return any(_gleich(w, x) for x in woerter_)


def datum_belegt(iso: str, anker: str) -> bool:
    """Steht das Datum (YYYY-MM-DD) im Beleg — als 31.03.2027, 31.3.27, 31. März 2027, 2027-03-31 …?"""
    from .jobs.fristen import datum_im_text  # spät: jobs.fristen importiert dieses Modul

    return datum_im_text(iso, anker or "")


def _monate(woerter_: list[str], roh: str) -> set[int]:
    aus = {MONAT_NR[w] for w in woerter_ if w in MONAT_NR}
    for m in re.finditer(r"(?<!\d)(\d{1,2})\s*[./]\s*(\d{1,2})\s*[./]\s*(\d{2}|\d{4})(?!\d)", roh or ""):
        if 1 <= int(m.group(2)) <= 12:
            aus.add(int(m.group(2)))
    for m in re.finditer(r"(?<!\d)(?:19|20)\d\d-(\d{2})-\d{2}(?!\d)", roh or ""):
        aus.add(int(m.group(1)))
    for m in re.finditer(r"(?<![\d.])(\d{1,2})\s*[./]\s*((?:19|20)\d\d)(?!\d)", roh or ""):  # 05.2026, 5/2026
        if 1 <= int(m.group(1)) <= 12:
            aus.add(int(m.group(1)))
    return aus


def zeitraum_belegt(wert: str, anker: str, extra: Iterable[str] = ()) -> bool:
    """Jahre und Monate des Zeitraums stehen im Beleg (Jahr auch zweistellig, «Saison 25/26»); ohne Jahr und Monat
    müssen die Wörter des Zeitraums im Beleg stehen."""
    w, a = woerter(wert), woerter(anker)
    if not w or not a:
        return False
    jahre = re.findall(r"(?<!\d)((?:19|20)\d\d)(?!\d)", wert)
    monate = {MONAT_NR[x] for x in w if x in MONAT_NR}
    if jahre or monate:
        if any(j not in a and j[2:] not in a for j in jahre):
            return False
        return monate <= _monate(a, anker)
    inhalt = [x for x in w if len(x) >= 4 and x not in _STOPP]
    pool = [*a, *extra]
    return bool(inhalt) and all(_belegt_in(x, pool) for x in inhalt)


# Statuswörter im Beleg (gefaltet). «Unterschrift»/«Unterschrift:» allein (eine Unterschriftszeile) belegt nichts.
STATUS_BELEG: dict[str, re.Pattern[str]] = {
    "entwurf": re.compile(r"entwurf|\bdraft|\bprojet\b|\bbozza"),
    "unterschrieben": re.compile(r"unterzeichnet|unterschrieben|signiert|\bsigned\b|\bsignee?s?\b|\bfirmato\b|"
                                 r"gegengezeichnet|visiert"),
    "final": re.compile(r"\bfinal|definitiv|endfassung|endversion|freigegeben|verabschiedet"),
    "version": re.compile(r"\bversion\b|\bfassung\b|(?<![a-z0-9])v\s?\d+(?:\.\d+)*(?![a-z])|\brev(?:ision)?\.?\s?\d|"
                          r"\bstand\s+(?:\d|[a-z]+\s+(?:19|20)\d\d\b)"),
    "vorlage": re.compile(r"vorlage|template|mustervertrag|mustervorlage|formular|blanko"),
}


def status_belegt(status: str, anker: str) -> bool:
    muster = STATUS_BELEG.get(status)
    return bool(muster and muster.search(" ".join(woerter(anker))))


def _noetig(n: int) -> int:
    return n if n <= 2 else math.ceil(n * 2 / 3)


def name_belegt(name: str, anker_woerter_: Iterable[str], extra: Iterable[str] = ()) -> bool:
    """Die Wörter des Namens (ohne Rechtsform) stehen im Beleg: bei bis zu zwei Wörtern alle, sonst zwei Drittel."""
    w = [x for x in woerter(name) if len(x) >= 2 and x not in _NAMEN_FUELL]
    if not w:
        return False
    pool = [*anker_woerter_, *extra]
    return sum(_belegt_in(x, pool) for x in w) >= _noetig(len(w))


def bezug_belegt(wert: str, anker_woerter_: Iterable[str], extra: Iterable[str] = ()) -> bool:
    """Bezug/Version: alle Zahlen stehen im Beleg, von den Wörtern ab 3 Zeichen (Kürzel wie «HTK», «Süd» zählen) bei
    bis zu zwei alle, sonst zwei Drittel («Beilage zum Mietvertrag» ist mit dem Beleg «Beilage zum Arbeitsvertrag»
    nicht belegt)."""
    w = woerter(wert)
    pool = [*anker_woerter_, *extra]
    zahlen = [x for x in w if x.isdigit()]
    inhalt = [x for x in w if not x.isdigit() and len(x) >= 3 and x not in _STOPP]
    if not zahlen and not inhalt:
        return False
    if any(z not in pool for z in zahlen):
        return False
    return not inhalt or sum(_belegt_in(x, pool) for x in inhalt) >= _noetig(len(inhalt))


def name_fund(name: str, teil: Teil) -> Fund | None:
    """Der Name selbst steht im Teil: seine Wörter (ohne Rechtsform) als Folge, «fast wörtlich» wie ein Beleg; bei zwei
    Wörtern auch umgekehrt («Muster Max»). Die Stelle des Namens ist dann die Belegstelle."""
    w = [x for x in woerter(name) if len(x) >= 2 and x not in _NAMEN_FUELL]
    if not w:
        return None
    for v, (toks, lagen, _marken) in enumerate(teil.varianten):
        for folge in ([w, w[::-1]] if len(w) == 2 else [w]):
            i = _suche(folge, toks)
            if i is not None:
                return Fund(teil.nr, teil.seite_bei(v, lagen[i]), tuple(folge))
    return None


def wert_im_teil(feld: str, wert: str, teil: Teil) -> Fund | None:
    """Rückfall, wenn der Beleg der KI nicht im Teil steht oder den Wert nicht trägt (gemessen 16.10.: gemma3:4b schreibt
    oft eine ungenaue Stelle zu einem richtigen Wert): steht der WERT selbst im Teil, findet das Rig die Belegstelle
    selbst. Gleiche Massstäbe wie beim Beleg — Datum in üblicher Schreibweise, Jahre und Monate des Zeitraums, das
    Statuswort, Namen als Wortfolge, beim Bezug alle Zahlen und zwei Drittel der Wörter. Kein Firmenwissen hier: der
    Wert muss im Dokument stehen. Die Seite ist nur bei Namen bekannt."""
    if feld == "datum":
        return Fund(teil.nr, None, ()) if datum_belegt(wert, teil.text) else None
    if feld == "zeitraum":
        return Fund(teil.nr, None, ()) if zeitraum_belegt(wert, teil.text) else None
    if feld == "status":
        return Fund(teil.nr, None, ()) if status_belegt(wert, teil.text) else None
    if feld == "bezug":
        return Fund(teil.nr, None, ()) if bezug_belegt(wert, teil.menge) else None
    return name_fund(wert, teil)  # absender, empfaenger, beteiligte


def _stamm(w: str) -> str:
    return w[:-2] if len(w) >= 8 else w[:-1] if len(w) >= 5 else w


def rolle_belegt(rolle: str, teil: Teil, extra: Iterable[str] = ()) -> bool:
    """Die Rolle steht im Teil (Wortstamm, «Arbeitnehmer» trifft «Arbeitnehmerin», nicht «Arbeitgeber») — oder im
    Firmenwissen zu einem Begriff aus dem Beleg. Wörter ab 4 Zeichen: bei bis zu zwei alle, sonst zwei Drittel."""
    w = [x for x in woerter(rolle) if len(x) >= 4 and x not in _STOPP]
    if not w:
        return False
    extra_ = set(extra)
    treffer = 0
    for x in w:
        s = _stamm(x)
        if x in extra_ or any(t.startswith(s) for t in teil.menge) or any(e.startswith(s) for e in extra_):
            treffer += 1
    return treffer >= _noetig(len(w))


# --- Prompt-Kopien (Messnacht 15./16.10.) -------------------------------------------------------------------------

# Beispiele der Beschrieb-Anleitung bis zum 15.10. (zz/v3) — das 4b-Modell übernahm sie in Beschriebe anderer
# Dokumente. Seit zz/v4 stehen keine Beispielwerte mehr in der Anleitung; die Liste bleibt als Prüfung.
FRUEHERE_BEISPIELE: tuple[str, ...] = (
    "Beilage zum Arbeitsvertrag", "Liste/Export", "Stellenbeschrieb Techniker", "Verwaltungsvertrag Location",
    "Leadliste Locations", "Veranstaltung X", "Location Y", "Verein EVENTLINE 2025", "Max Muster",
    "Arbeitnehmer, Techniker", "Mai–Juni 2026", "Muster AG",
)
_BEISPIELE = tuple((b, " ".join(woerter(b))) for b in FRUEHERE_BEISPIELE)
# «Dieser Vertrag …» ohne ein Vertragswort im Dokument (9× bei Tarifblatt, Konzept, Anleitung).
_VERTRAG_RAHMEN = re.compile(r"^(?:dieser|der|dieses|das|ein|eine)\s+(?:vertrag|dokument ist ein vertrag|vereinbarung)\b")
_VERTRAG_WORT = re.compile(r"vertrag|vereinbar|contract|agreement|contrat|accordo|convention")


def dokument_woerter(*texte: str) -> str:
    """« w1 w2 … » aus Dokumenttext, Dateiname und Ablageort — für Wortfolgen-Vergleiche."""
    return " " + " ".join(w for t in texte for w in woerter(t)) + " "


def prompt_kopie(wert: str, dokument: str) -> str | None:
    """Welches Anleitungs-Beispiel der Wert wörtlich enthält, ohne dass das Dokument es belegt (nicht jedes seiner
    Wörter steht in Text, Dateiname oder Ablageort) — sonst None. `dokument` aus dokument_woerter()."""
    w = " ".join(woerter(wert))
    if not w:
        return None
    s = f" {w} "
    for roh, folge in _BEISPIELE:
        if f" {folge} " in s and not all(f" {t} " in dokument for t in folge.split()):
            return roh
    if _VERTRAG_RAHMEN.match(w) and not _VERTRAG_WORT.search(dokument):
        return "Dieser Vertrag …"
    return None


def ist_unbekannt(wert: object) -> bool:
    return not isinstance(wert, str) or not wert.strip() or falte(wert.strip(" .-–")) in (UNBEKANNT, "unklar", "keine",
                                                                                     "keiner", "n/a", "na", "none")
