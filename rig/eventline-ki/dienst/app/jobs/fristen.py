"""Fristen der Nachtarbeit (Masterplan E4.3, §3.6 «Fristen», §3.7). Schalter KI_JOB_FRISTEN.

Je Datei des Tiefen-Index (archiv_text — der Volltext bleibt im Tresor):
1. Vorfilter ohne Modell: kündbar, Kündigung, Laufzeit, gültig bis, Ablauf, Vertragsende, verlängert sich, Frist,
   zahlbar bis. Kein Treffer → keine Modellarbeit (Karte «ohne_treffer»).
2. Auszüge: die Abschnitte des Tiefen-Index (tiefe.zerlege, gleiche Grenzen und Seiten), die den Vorfilter
   treffen (höchstens MAX_AUSZUEGE), dazu der Kopf des Dokuments für die Dokumentkarte.
3. gemma3:4b (KI_MODELL_TEXT, Entscheid nach der Messung E2.4 — das Hauptmodell bleibt aus) schemagebunden:
   Dokumentkarte (typ, dok_datum, partei, partei_art, personenbezogen) und Bedingungen je Frist. Gleiches num_ctx wie
   die Ablage (KI_LLM_NUM_CTX) — kein Neuladen des Modells.
4. Prüfung gegen Erfindung (Pflicht, §3.6): jedes Datum (übliche Schreibweisen) und jede Zahl (Ziffer oder Zahlwort,
   mit ihrer Einheit; Monate auch als ganze Jahre) muss im Quellabschnitt stehen — sonst wird die Frist verworfen.
   Unvollständige Bedingungen (das FSM könnte kein Datum rechnen) werden ebenfalls verworfen.
5. Minimierung: partei nur bei Organisationen und nicht personenbezogen, minimiert (einordnung.minimiere_text),
   höchstens 60 Zeichen, und nur wenn sie im Dokument steht.
6. Das Datum rechnet das FSM (berechneFrist, src/lib/ki/fristen.ts) — das Rig liefert nur Bedingungen.

Nie Inhalte in Log, Protokoll oder Rückgabe-Zählern; Auszüge und Antwort bleiben im Prozess.
"""

from __future__ import annotations

import logging
import re
import time
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Callable

from ..archiv import nfc
from ..config import Einstellungen
from ..einordnung import MITARBEITER_PLATZHALTER, PLATZHALTER, kuerze_auf_wort, minimiere_text, unter_personal
from ..handlers import datum_gueltig, text_kurz
from ..handlers.ablage import DOK_TYPEN_STANDARD, ZWEITER_VERSUCH, heute_zuerich, lese_kontext
from ..llm import LlmFehler, Ollama
from ..tiefe import zerlege

log = logging.getLogger("ki.nacht.fristen")

# v2 (15.10., Mischa «das ganze Dokument»): ALLE Abschnitte mit Vorfilter-Treffer, in Teilen zu je MAX_AUSZUEGE
# (+ Kopf) ans Modell — vorher nur die ersten 6. Fristen je Teil gegen Erfindung geprüft, danach zusammengeführt.
REZEPT = "fristen/v2"
ARTEN = ("kuendigung", "ablauf", "vertragsende", "verlaengerung", "zahlung", "sonstige")
EINHEITEN = ("tage", "wochen", "monate")
SICHERHEITEN = ("hoch", "mittel", "niedrig")
MAX_AUSZUEGE = 6
MAX_FRISTEN_JE_DATEI = 5
ANTWORT_TOKENS = 900
PARTEI_MAX = 60
# Gleiche Grenzen wie das FSM (leseBedingungen, src/lib/ki/nachtarbeit.ts).
LAUFZEIT_MAX = 120
VERLAENGERUNG_MAX = 60
KUENDIGUNGSFRIST_MAX = 24

_U = r"(?:ü|ue|u)"
VORFILTER = re.compile(
    rf"k{_U}ndbar|k{_U}ndigung|laufzeit|g{_U}ltig\s+bis|ablauf|vertragsende|verl(?:ä|ae|a)ngert\s+sich|frist|zahlbar\s+bis",
    re.I,
)
# Wort der Art im Quellabschnitt → Sicherheit «hoch» (sonst «mittel»); OCR-Text eine Stufe tiefer.
ART_WORT = {
    "kuendigung": re.compile(rf"k{_U}nd", re.I),
    "ablauf": re.compile(rf"ablauf|l(?:ä|ae|a)uft\s+ab|g{_U}ltig|valable|valid", re.I),
    "vertragsende": re.compile(r"vertragsende|laufzeit|endet|dauer", re.I),
    "verlaengerung": re.compile(r"verl(?:ä|ae|a)nger", re.I),
    "zahlung": re.compile(r"zahlbar|zahlung|f(?:ä|ae|a)llig|payable", re.I),
    "sonstige": re.compile(r"frist|termin", re.I),
}

SYSTEM = """Du bist die lokale Fristen-KI der EVENTLINE GmbH (Eventtechnik-Firma, Basel). Du bekommst nummerierte Auszüge aus EINEM Dokument und erfasst dessen Fristen. Du lieferst ausschliesslich die geforderten JSON-Felder.

Regeln:
- Übernimm nur, was wörtlich in den Auszügen steht. Nichts erfinden, nichts ausrechnen, nichts schätzen.
- Daten immer als YYYY-MM-DD und nur, wenn der Tag im Auszug steht. Schweizer Kontext: "15.1.26" bedeutet 2026-01-15.
- art: "kuendigung" (Kündigungstermin oder Kündigungsfrist eines Vertrags), "ablauf" (Ablauf einer Gültigkeit: Police, Bewilligung, Zertifikat, Offerte gültig bis), "vertragsende" (Ende der Vertragslaufzeit), "verlaengerung" (Termin, an dem sich ein Vertrag verlängert), "zahlung" (zahlbar bis, Zahlungsfrist mit Datum), "sonstige" (andere Frist mit festem Datum).
- beginn / ende: Beginn und Ende der Vertragslaufzeit, sonst "".
- faellig: ein ausdrücklich genannter Termin (z. B. "zahlbar bis 30.11.2026", "kündbar bis 30.6.2027", "gültig bis 31.12.2026"), sonst "".
- laufzeit_monate: feste Laufzeit in Monaten ("3 Jahre" = 36, "24 Monate" = 24), sonst 0.
- verlaengerung_monate: um wie viele Monate sich der Vertrag stillschweigend verlängert ("um ein Jahr" = 12), sonst 0.
- kuendigungsfrist_anzahl und kuendigungsfrist_einheit ("tage", "wochen", "monate"): die Kündigungsfrist ("3 Monate vor Ablauf" = 3 und "monate"), sonst 0 und "".
- abschnitt: Nummer des Auszugs, in dem diese Frist steht.
- Steht keine Frist in den Auszügen: fristen = [].
- typ: der passendste Dokumenttyp aus der Liste; partei: Gegenpartei oder Aussteller aus Sicht der EVENTLINE GmbH (nie EVENTLINE selbst), sonst ""; partei_art: "organisation" bei Firma, Behörde, Verein, Location — "person" bei einer Privatperson — sonst ""; dok_datum: Datum des Dokuments (Ausstellungs-/Briefdatum), sonst "".
- personenbezogen: true bei Dokumenten über eine einzelne Person (Lohn, Arbeitsvertrag, Anstellung, Zeugnis, Bewilligung oder Kursbestätigung einer Person); sonst false."""


@dataclass(frozen=True)
class Auszug:
    nr: int            # 1-basiert, so im Prompt
    seite: int | None
    text: str


@dataclass(frozen=True)
class Frist:
    art: str
    bedingungen: dict[str, Any]
    seite: int | None
    sicherheit: str


@dataclass
class FristBefund:
    status: str                      # «fertig» (Modell lief) | «ohne_treffer» (Vorfilter) | «leer» (kein Text)
    typ: str | None = None
    dok_datum: str | None = None
    partei: str | None = None
    personenbezogen: bool = False
    fristen: list[Frist] = field(default_factory=list)
    # Nur Zähler: roh, angenommen, erfunden, unvollstaendig, ungueltig, doppelt, art_*, sicherheit_*.
    zaehler: Counter = field(default_factory=Counter)
    modell: str | None = None
    dauer_ms: int = 0


# --- Text-Helfer --------------------------------------------------------------------------------------


def _glatt(text: str) -> str:
    """NFC, geschützte und schmale Leerzeichen als normale Leerzeichen (OCR, Word)."""
    return re.sub(r"[    ]", " ", unicodedata.normalize("NFC", text or ""))


def vorfilter(text: str) -> bool:
    return bool(VORFILTER.search(_glatt(text)))


def auszuege(text: str) -> list[Auszug]:
    """Erster Teil (wie bis v1): Abschnitte mit Vorfilter-Treffer (höchstens MAX_AUSZUEGE), davor der Kopf."""
    teile = auszug_teile(text)
    return teile[0] if teile else []


def auszug_teile(text: str) -> list[list[Auszug]]:
    """Das ganze Dokument: ALLE Abschnitte mit Vorfilter-Treffer in Dokumentreihenfolge, in Teilen zu höchstens
    MAX_AUSZUEGE; jeder Teil beginnt mit dem Kopf des Dokuments (Titel, Parteien, Datum), wenn er nicht dabei ist."""
    abschnitte = zerlege(_glatt(text))
    if not abschnitte:
        return []
    treffer = [a for a in abschnitte if VORFILTER.search(a.text)]
    aus = []
    for i in range(0, len(treffer), MAX_AUSZUEGE):
        stueck = treffer[i : i + MAX_AUSZUEGE]
        auswahl = stueck if stueck[0].nr == abschnitte[0].nr else [abschnitte[0], *stueck]
        aus.append([Auszug(j, a.seite, a.text) for j, a in enumerate(auswahl, start=1)])
    return aus


# --- Prüfung gegen Erfindung ------------------------------------------------------------------------------

_MONATE: dict[int, tuple[str, ...]] = {
    1: ("januar", "jänner", "jaenner", "jan", "january", "janvier", "janv", "gennaio"),
    2: ("februar", "feb", "febr", "february", "février", "fevrier", "févr", "fevr", "febbraio"),
    3: ("märz", "maerz", "marz", "mär", "mrz", "march", "mar", "mars", "marzo"),
    4: ("april", "apr", "avril", "avr", "aprile"),
    5: ("mai", "may", "maggio"),
    6: ("juni", "jun", "june", "juin", "giugno"),
    7: ("juli", "jul", "july", "juillet", "juil", "luglio"),
    8: ("august", "aug", "août", "aout", "agosto"),
    9: ("september", "sept", "sep", "septembre", "settembre"),
    10: ("oktober", "okt", "october", "oct", "octobre", "ottobre"),
    11: ("november", "nov", "novembre"),
    12: ("dezember", "dez", "december", "dec", "décembre", "decembre", "déc", "dicembre"),
}


def _alternativen(woerter: tuple[str, ...] | list[str]) -> str:
    return "|".join(re.escape(w) for w in sorted(set(woerter), key=lambda w: (-len(w), w)))


def datum_im_text(iso: str, text: str) -> bool:
    """Steht das Datum (YYYY-MM-DD) im Text — als 31.03.2027, 31.3.27, 31/03/2027, 2027-03-31, 31. März 2027 oder
    March 31, 2027?"""
    if not datum_gueltig(iso):
        return False
    j, m, t = (int(x) for x in iso.split("-"))
    text = _glatt(text)
    tag = rf"0?{t}"
    jahr = rf"(?:{j}|{j % 100:02d})"
    monat = rf"(?:{_alternativen(_MONATE[m])})"
    muster = (
        rf"(?<![\d.]){tag}\s*[./]\s*0?{m}\s*[./]\s*{jahr}(?!\d)",
        rf"(?<!\d){j}-{m:02d}-{t:02d}(?!\d)",
        rf"(?<![\d.]){tag}\.?\s*{monat}\.?\s*,?\s*{j}(?!\d)",
        rf"(?<![\w]){monat}\.?\s+{tag}(?:st|nd|rd|th)?,?\s+{j}(?!\d)",
    )
    return any(re.search(p, text, re.I) for p in muster)


_EINER = {
    1: ("ein", "eins", "eine", "einen", "einem", "einer"), 2: ("zwei",), 3: ("drei",), 4: ("vier",),
    5: ("fünf", "fuenf"), 6: ("sechs",), 7: ("sieben",), 8: ("acht",), 9: ("neun",), 10: ("zehn",), 11: ("elf",),
    12: ("zwölf", "zwoelf"), 13: ("dreizehn",), 14: ("vierzehn",), 15: ("fünfzehn", "fuenfzehn"), 16: ("sechzehn",),
    17: ("siebzehn",), 18: ("achtzehn",), 19: ("neunzehn",),
}
_ZEHNER = {2: ("zwanzig",), 3: ("dreissig", "dreißig"), 4: ("vierzig",), 5: ("fünfzig", "fuenfzig"), 6: ("sechzig",),
           7: ("siebzig",), 8: ("achtzig",), 9: ("neunzig",)}
_EINER_IN_ZUSAMMENSETZUNG = {1: "ein", 2: "zwei", 3: "drei", 4: "vier", 5: "fünf", 6: "sechs", 7: "sieben", 8: "acht", 9: "neun"}
_FREMD = {
    1: ("one", "un", "une", "uno", "una"), 2: ("two", "deux", "due"), 3: ("three", "trois", "tre"),
    4: ("four", "quatre", "quattro"), 5: ("five", "cinq", "cinque"), 6: ("six", "sei"), 7: ("seven", "sept", "sette"),
    8: ("eight", "huit", "otto"), 9: ("nine", "neuf", "nove"), 10: ("ten", "dix", "dieci"), 11: ("eleven", "onze", "undici"),
    12: ("twelve", "douze", "dodici"), 24: ("twenty-four", "vingt-quatre"), 36: ("thirty-six", "trente-six"),
}


def zahlwoerter(n: int) -> tuple[str, ...]:
    """Deutsche Zahlwörter 1–99 (mit ue/ss-Varianten) und die häufigsten französisch/englisch/italienisch."""
    aus: list[str] = list(_EINER.get(n, ())) + list(_FREMD.get(n, ()))
    if 20 <= n <= 99:
        z, e = divmod(n, 10)
        for zehner in _ZEHNER[z]:
            if e == 0:
                aus.append(zehner)
            else:
                einer = _EINER_IN_ZUSAMMENSETZUNG[e]
                aus.append(f"{einer}und{zehner}")
                if "ü" in einer:
                    aus.append(f"{einer.replace('ü', 'ue')}und{zehner}")
    return tuple(aus)


# Nach der Einheit nur ihre Endungen und dann eine Wortgrenze: «3 Monate», «drei Monaten», «3-monatige», «12 mois»
# zählen; Zusammensetzungen wie «3 Monatsmieten», «1 Jahresbeitrag», «2 Wochenplan», «5 Tagessatz» oder «3 monatlich»
# belegen keine Laufzeit oder Frist (sonst bestätigte eine fremde Zahl die vom Modell falsch zugeordnete).
_ADJ = r"ig(?:e[nmrs]?)?"  # -monatig, -jährige, -wöchigen, -tägiger
_EINHEIT = {
    "monate": rf"(?:monat(?:e|en|es|s|{_ADJ})?\b|mte\b|mt\.|mon\.|months?\b|mois\b|mes[ei]\b)",
    "jahre": rf"(?:jahr(?:e|en|es|s)?\b|(?:jähr|jaehr){_ADJ}\b|years?\b|ans?\b|ann[ée]es?\b|ann[io]\b)",
    "wochen": rf"(?:woche(?:n)?\b|(?:wöch|woech){_ADJ}\b|weeks?\b|semaines?\b|settiman[ae]\b)",
    "tage": rf"(?:tag(?:e|en|es)?\b|(?:täg|taeg){_ADJ}\b|days?\b|jours?\b|giorn[oi]\b)",
}
_FUELLWORT = r"(?:(?:weitere[nsmr]?|zusätzliche[nsmr]?|zusaetzliche[nsmr]?|volle[nsmr]?|ganze[nsmr]?|aufeinanderfolgende[nsmr]?|additional|further|full)\s+)?"


def zahl_mit_einheit(n: int, einheit: str, text: str) -> bool:
    """Steht «n <Einheit>» im Text — als Ziffer oder Zahlwort, auch «3-monatig», «dreimonatige», «drei (3) Monate»,
    «ein weiteres Jahr»? Eine Zahl ohne ihre Einheit zählt nicht (sonst bestätigte jede Seitenzahl die Laufzeit)."""
    if n < 1 or einheit not in _EINHEIT:
        return False
    woerter = zahlwoerter(n)
    wort = rf"|(?<![\w])(?:{_alternativen(woerter)})" if woerter else ""
    zahl = rf"(?:(?<![\w.,'’]){n}(?!\d){wort})"
    muster = rf"{zahl}\s*(?:\(\s*\d{{1,3}}\s*\)\s*)?(?:-\s*)?{_FUELLWORT}{_EINHEIT[einheit]}"
    return bool(re.search(muster, _glatt(text), re.I))


def monate_im_text(n: int, text: str) -> bool:
    """Laufzeit/Verlängerung in Monaten: «n Monate» oder — bei vollen Jahren — «n/12 Jahre»."""
    return zahl_mit_einheit(n, "monate", text) or (n % 12 == 0 and zahl_mit_einheit(n // 12, "jahre", text))


def vollstaendig(art: str, b: dict[str, Any]) -> bool:
    """Reicht es dem FSM für ein Datum (berechneFrist, Schritte 1, 2 und 5)? Vergangen/zu fern entscheidet das FSM."""
    if art in ("zahlung", "sonstige") or b.get("faellig"):
        return bool(b.get("faellig"))
    if not (b.get("ende") or (b.get("beginn") and b.get("laufzeit_monate"))):
        return False
    return art != "kuendigung" or bool(b.get("kuendigungsfrist"))


def _ganzzahl(roh: object) -> int | None:
    """0/leer → None; sonst nur echte Ganzzahlen."""
    if isinstance(roh, bool) or roh is None:
        return None
    if isinstance(roh, float) and roh.is_integer():
        roh = int(roh)
    if not isinstance(roh, int):
        return None
    return roh or None


_CH_DATUM = re.compile(r"^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{2}|\d{4})$")


def _datum_feld(roh: object) -> tuple[str | None, str | None]:
    """(Datum|None, Hinweis) — leer = None ohne Hinweis. Schreibt das Modell trotz Vorgabe «31.12.2026» oder «31.12.26»,
    wird das gelesen (die Prüfung gegen den Text folgt ohnehin); Unlesbares («Ende 2026», «2026-12») zählt als nicht
    angegeben (Hinweis «datum_unlesbar») — die Frist ist dann meist unvollständig, nie geraten."""
    s = text_kurz(roh, 20) if isinstance(roh, str) else ""
    if not s:
        return None, None
    d = datum_gueltig(s)
    if d:
        return d, None
    m = _CH_DATUM.match(s)
    if m:
        t, mo, j = int(m.group(1)), int(m.group(2)), int(m.group(3))
        j = j + 2000 if j < 100 else j
        d = datum_gueltig(f"{j:04d}-{mo:02d}-{t:02d}")
        if d:
            return d, None
    return None, "datum_unlesbar"


def bedingungen_aus(roh: dict[str, Any], hinweise: Counter | None = None) -> tuple[dict[str, Any] | None, str | None]:
    """Modell-Antwort einer Frist → Bedingungen in der Vertragsform (§3.6), oder (None, «ungueltig_zahl»).
    Hinweise (nur Zähler): datum_unlesbar, frist_ohne_einheit."""
    werte: dict[str, Any] = {}
    for feld in ("beginn", "ende", "faellig"):
        d, hinweis = _datum_feld(roh.get(feld))
        if hinweis and hinweise is not None:
            hinweise[hinweis] += 1
        werte[feld] = d
    for feld, grenze in (("laufzeit_monate", LAUFZEIT_MAX), ("verlaengerung_monate", VERLAENGERUNG_MAX)):
        z = _ganzzahl(roh.get(feld))
        if z is not None and not 1 <= z <= grenze:
            return None, "ungueltig_zahl"
        werte[feld] = z
    anzahl = _ganzzahl(roh.get("kuendigungsfrist_anzahl"))
    einheit = text_kurz(roh.get("kuendigungsfrist_einheit"), 10).lower()
    if anzahl is None:
        werte["kuendigungsfrist"] = None
    elif not 1 <= anzahl <= KUENDIGUNGSFRIST_MAX:
        return None, "ungueltig_zahl"
    elif einheit in EINHEITEN:
        werte["kuendigungsfrist"] = {"anzahl": anzahl, "einheit": einheit}
    else:
        # Anzahl ohne Einheit: nicht raten — Frist gilt als nicht angegeben.
        werte["kuendigungsfrist"] = None
        if hinweise is not None:
            hinweise["frist_ohne_einheit"] += 1
    return werte, None


def belegt(b: dict[str, Any], text: str) -> bool:
    """Prüfung gegen Erfindung: jedes Datum und jede Zahl der Bedingungen steht im Text."""
    for feld in ("beginn", "ende", "faellig"):
        if b.get(feld) and not datum_im_text(b[feld], text):
            return False
    for feld in ("laufzeit_monate", "verlaengerung_monate"):
        if b.get(feld) and not monate_im_text(int(b[feld]), text):
            return False
    k = b.get("kuendigungsfrist")
    if k:
        n, einheit = int(k["anzahl"]), str(k["einheit"])
        if not (zahl_mit_einheit(n, einheit, text) or (einheit == "monate" and monate_im_text(n, text))):
            return False
    return True


def sicherheit_fuer(art: str, quelltext: str, ocr: bool) -> str:
    stufe = 0 if ART_WORT.get(art, ART_WORT["sonstige"]).search(_glatt(quelltext)) else 1
    if ocr:
        stufe += 1
    return SICHERHEITEN[min(stufe, 2)]


def pruefe_fristen(roh_liste: object, quellen: list[Auszug], *, ocr: bool) -> tuple[list[Frist], Counter]:
    """Alle Fristen der Antwort prüfen. Quellabschnitt = der genannte Auszug; stehen die Werte dort nicht, zählt ein
    anderer Auszug, in dem ALLE Werte stehen (das Modell verzählt sich gelegentlich in der Nummer)."""
    z: Counter = Counter()
    aus: list[Frist] = []
    gesehen: set[tuple[str, str]] = set()
    if not isinstance(roh_liste, list):
        return aus, z
    for roh in roh_liste[: MAX_FRISTEN_JE_DATEI * 2]:
        z["roh"] += 1
        if not isinstance(roh, dict):
            z["ungueltig"] += 1
            continue
        art = text_kurz(roh.get("art"), 20).lower()
        if art not in ARTEN:
            z["ungueltig"] += 1
            continue
        b, grund = bedingungen_aus(roh, z)
        if b is None:
            z[grund or "ungueltig"] += 1
            continue
        if not any(b.values()):
            z["leer"] += 1
            continue
        if not vollstaendig(art, b):
            z["unvollstaendig"] += 1
            continue
        nr = _ganzzahl(roh.get("abschnitt"))
        reihe = sorted(quellen, key=lambda a: 0 if a.nr == nr else 1)
        quelle = next((a for a in reihe if belegt(b, a.text)), None)
        if quelle is None:
            z["erfunden"] += 1
            continue
        schluessel = (art, repr(sorted(b.items())))
        if schluessel in gesehen:
            z["doppelt"] += 1
            continue
        gesehen.add(schluessel)
        if len(aus) >= MAX_FRISTEN_JE_DATEI:
            z["zu_viele"] += 1
            continue
        s = sicherheit_fuer(art, quelle.text, ocr)
        aus.append(Frist(art=art, bedingungen=b, seite=quelle.seite, sicherheit=s))
        z["angenommen"] += 1
        z[f"art_{art}"] += 1
        z[f"sicherheit_{s}"] += 1
    return aus, z


def _steht_im_text(wert: str, text: str) -> bool:
    def falte(s: str) -> str:
        return re.sub(r"\s+", " ", _glatt(s)).strip().lower()

    w = falte(wert)
    return len(w) >= 2 and w in falte(text)


def karte_aus(
    roh: dict[str, Any], *, pfad: str, volltext: str, quelltext: str, typ_keys: list[str],
    personen_typen: frozenset[str] | None, namen: list[str],
) -> tuple[str | None, str | None, str | None, bool]:
    """(typ, dok_datum, partei, personenbezogen) — partei minimiert und nur bei Organisationen; dok_datum nur, wenn es
    in den Auszügen steht."""
    typ = text_kurz(roh.get("typ"), 40)
    typ = typ if typ in typ_keys else None
    dok_datum = datum_gueltig(text_kurz(roh.get("dok_datum"), 20))
    if dok_datum and not datum_im_text(dok_datum, quelltext):
        dok_datum = None
    partei_roh = text_kurz(roh.get("partei"), 200)
    partei_art = text_kurz(roh.get("partei_art"), 20).lower()
    mini = minimiere_text(partei_roh, namen) if partei_roh else ""
    personen = personen_typen if personen_typen is not None else frozenset({"lohnabrechnung", "behoerde", "zertifikat"})
    personenbezogen = (
        roh.get("personenbezogen") is True
        or unter_personal(pfad)
        or (typ is not None and typ in personen)
        or partei_art == "person"
        or MITARBEITER_PLATZHALTER in mini
    )
    partei: str | None = None
    if (partei_roh and not personenbezogen and partei_art == "organisation"
            and not re.fullmatch(r"\s*eventline(\s+gmbh)?\s*", partei_roh, re.I)
            and _steht_im_text(partei_roh, volltext)):
        partei = kuerze_auf_wort(mini, PARTEI_MAX) or None
        if partei == PLATZHALTER:
            partei = None
    return typ, dok_datum, partei, bool(personenbezogen)


# --- Modell -----------------------------------------------------------------------------------------------


def schema_fuer(typ_keys: list[str]) -> dict[str, Any]:
    datum = {"type": "string", "maxLength": 10}
    frist = {
        "type": "object",
        "properties": {
            "art": {"type": "string", "enum": list(ARTEN)},
            "abschnitt": {"type": "integer"},
            "beginn": datum, "ende": datum, "faellig": datum,
            "laufzeit_monate": {"type": "integer"},
            "verlaengerung_monate": {"type": "integer"},
            "kuendigungsfrist_anzahl": {"type": "integer"},
            "kuendigungsfrist_einheit": {"type": "string", "enum": ["", *EINHEITEN]},
        },
    }
    frist["required"] = list(frist["properties"].keys())
    felder: dict[str, Any] = {
        "typ": {"type": "string", "enum": typ_keys},
        "dok_datum": datum,
        "partei": {"type": "string", "maxLength": 120},
        "partei_art": {"type": "string", "enum": ["", "organisation", "person"]},
        "personenbezogen": {"type": "boolean"},
        "fristen": {"type": "array", "maxItems": MAX_FRISTEN_JE_DATEI, "items": frist},
    }
    return {"type": "object", "properties": felder, "required": list(felder.keys())}


def prompt_fuer(dateiname: str, heute: str, typen: list[tuple[str, str]], quellen: list[Auszug]) -> str:
    teile = [
        "Erlaubte Dokumenttypen (key – Bezeichnung):\n" + "\n".join(f"{k} – {label}" for k, label in typen),
        f"Heutiges Datum: {heute}\nDateiname: {dateiname or '(unbekannt)'}",
        "Auszüge aus dem Dokument:",
    ]
    for a in quellen:
        kopf = f"[{a.nr}]" + (f" (Seite {a.seite})" if a.seite else "")
        teile.append(f"{kopf}\n<<<\n{a.text}\n>>>")
    return "\n\n".join(teile)


def _chat(llm: Ollama, **kw: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    try:
        return llm.chat_json(**kw)
    except LlmFehler as e:
        if "repeat limit" not in str(e):
            raise
        # Wie in der Ablage: Wiederholungsschleife bei temperature 0 → ein zweiter Versuch mit etwas Zufall.
        return llm.chat_json(**kw, optionen=ZWEITER_VERSUCH)


def fristen_pruefen(
    *, pfad: str, dateiname: str, text: str, ocr: bool, kontext_roh: dict[str, Any], llm: Ollama, cfg: Einstellungen,
    vorrang: Callable[[], None] | None = None,
) -> FristBefund:
    """Eine Datei. Wirft LlmFehler (Schritt «fehler», nächster Versuch in einer späteren Nacht)."""
    start = time.monotonic()
    if not (text or "").strip():
        return FristBefund(status="leer")
    if not vorfilter(text):
        return FristBefund(status="ohne_treffer")
    teile = auszug_teile(text)
    if not teile:
        return FristBefund(status="ohne_treffer")
    k = lese_kontext(kontext_roh, heute_zuerich())
    typen = k.typen or DOK_TYPEN_STANDARD
    typ_keys = [t[0] for t in typen]
    fristen: list[Frist] = []
    z: Counter = Counter()
    roh: dict[str, Any] = {}
    meta: dict[str, Any] = {}
    for n, quellen in enumerate(teile):
        if n and vorrang is not None:
            vorrang()  # zwischen den Teilen: Wartende (Suche, Archiv-Frage, Beleg) haben Vorrang
        roh_teil, meta = _chat(
            llm, modell=cfg.modell_text, system=SYSTEM, nutzer=prompt_fuer(dateiname, k.heute, typen, quellen),
            schema=schema_fuer(typ_keys), num_ctx=cfg.llm_num_ctx, num_predict=ANTWORT_TOKENS,
        )
        if n == 0:
            roh = roh_teil  # Karte (Typ, Datum, Partei) aus dem ersten Teil mit dem Kopf
        neu, zt = pruefe_fristen(roh_teil.get("fristen"), quellen, ocr=ocr)
        z.update(zt)
        for f in neu:
            if any(f.art == g.art and f.bedingungen == g.bedingungen for g in fristen):
                z["doppelt_teile"] += 1
                continue
            fristen.append(f)
    z["teile"] = len(teile)
    z["angenommen"] = len(fristen)
    quellen = [a for t in teile for a in t]
    quelltext = "\n\n".join(a.text for a in quellen)
    typ, dok_datum, partei, personenbezogen = karte_aus(
        roh, pfad=nfc(pfad), volltext=text, quelltext=quelltext, typ_keys=typ_keys,
        personen_typen=k.personen_typen, namen=[*k.namen_alle, *k.mitarbeiter],
    )
    dauer = int((time.monotonic() - start) * 1000)
    log.info("Fristen: %d Teile, %d Auszüge, Modell %s ms (Prompt %s Tokens), roh %d, angenommen %d, erfunden %d, unvollständig %d",
             len(teile), len(quellen), meta.get("dauer_ms"), meta.get("prompt_tokens"), z["roh"], z["angenommen"], z["erfunden"],
             z["unvollstaendig"])
    return FristBefund(
        status="fertig", typ=typ, dok_datum=dok_datum, partei=partei, personenbezogen=personenbezogen,
        fristen=fristen, zaehler=z, modell=str(meta.get("modell") or cfg.modell_text), dauer_ms=dauer,
    )


def meldung(pfad: str, sha256: str, f: Frist, partei: str | None) -> dict[str, Any]:
    """Eintrag für POST /api/ki/nachtarbeit (§3.6, Liste «fristen») — partei nur, wenn gesetzt."""
    eintrag: dict[str, Any] = {
        "pfad": nfc(pfad), "sha256": sha256, "art": f.art, "bedingungen": f.bedingungen,
        "seite": f.seite, "sicherheit": f.sicherheit,
    }
    if partei:
        eintrag["partei"] = partei
    return eintrag
