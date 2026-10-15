"""Doppel-Prüfung (Masterplan E4.7, freigegeben von Mischa 15.10.2026: «ja Duplikate») — nur auf dem Rig, ohne Modell.

Vergleicht alle Dateien des NAS (Tiefen-Index `archiv_text`: sha256 + gelesener Text, auch unter ZZ_*; dazu sha256 aller
übrigen Dateien, Tabelle `doppel_hash`) und meldet dem FSM NUR Pfade, Grössen, Zeiten und Ähnlichkeitswerte — nie Text
(POST /api/ki/doppel). Drei Fälle je Dateipaar:

  exakt   — gleicher sha256 (Bytes gleich, jeder Dateityp).
  inhalt  — gleicher Inhalt, andere Form oder anderer Name, z. B. DOCX ↔ PDF, Scan, umbenannt:
            (a) andere Format-Familie: Schindel-Jaccard J ≥ 0,75 und Enthaltensein C ≥ 0,85;
            (b) gleiche Familie: J ≥ 0,97 und C ≥ 0,98 (praktisch derselbe Text, nur neu gespeichert/umbenannt);
            beides nur mit Belegen — mindestens 3 gemeinsame seltene Wörter (in höchstens 5 Dateien des NAS), dieselben
            Zahlen (≥ 3 Ziffern, Jaccard ≥ 0,8) und KEIN Versions-Unterschied im Namen. Ohne Belege (reines Formular-
            gerüst, z. B. Rapporte, deren Werte nicht im Text stehen) bleibt es bei «exakt».
  fassung — dasselbe Dokument in einer anderen Fassung: ähnlicher Namensstamm (≥ 0,5, ohne Versions-/Datums-/Kopie-
            marken), viel gemeinsamer Text (J ≥ 0,5 oder C ≥ 0,7) UND ein Fassungs-Zeichen: andere Versionsmarke
            (V01 → V02, rev.01, _v2), genau eine Datei in einem «Historie»-Ordner, oder anderes Datum im Namen bei
            J ≥ 0,8. Nie bei Datenexporten (CSV). Neuer = höhere Version, nicht in Historie, späteres Datum im Namen,
            sonst jüngere Änderungszeit.

Kalibriert am echten NAS (15.10.2026, 449 Dateien im Tiefen-Index, 342 mit Text): DOCX ↔ PDF derselben Datei J 0,77–0,97
/ C 0,88–1,0 (AGB, Stellungnahme SCALA, Haftungsbeschränkung, Barakuba-Vertrag, Kooperationskonzept, Schlüsselquittung);
SCALA-Vereinbarung V02 ↔ Historie (V01) J 0,98 (Word) bzw. 0,83–0,87 (über die Form) → «fassung» dank Versionsmarke und
Historie; Arbeitsvertrag-Vorlagen LKA/LKB/LKC (gleiches Muster, verschiedene Dokumente) J 0,90–0,94 bei gleicher Form →
kein Alarm (unter 0,97, gleiche Versionsmarke); Rechnungen 290332/-33/-34 (gleiches Muster) J 0,62–0,96 → kein Alarm;
zehn Rapporte mit identischem Formular-Text ohne seltene Wörter → kein Alarm (nur exakte Kopien zählen).

Ablauf (Thread «ki-doppel»): alle 60 s prüfen; neu gerechnet wird, wenn sich der Stand geändert hat (Anzahl/Zeiten im
Tiefen-Index, Dateiliste des NAS) oder nach 24 h, nur wenn kein Auftrag läuft oder wartet (20 s Ruhe) und kein Index
läuft. Rechnen dauert Sekunden (CPU, kein Modell, keine GPU), die Rechnung gibt zwischendurch den Interpreter frei.
Gemeldet wird das GANZE Ergebnis in Paketen; das FSM ersetzt damit die alte Liste (lauf_id). Nichts wird verschoben
oder gelöscht — das tut nur ein Mensch im FSM (Quarantäne-Ordner 99_System/Duplikate/…, nie endgültig).
"""

from __future__ import annotations

import hashlib
import heapq
import json
import logging
import re
import threading
import time
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from .archiv import nfc, sha256_von
from .config import Einstellungen
from .fsm import FsmAbgelehnt, FsmFehler
from .tiefe import ausgeschlossen, freigaben_zustand

log = logging.getLogger("ki.doppel")

REZEPT = "doppel/v1"
SCHINDEL_K = 5
MIN_WOERTER = 40
SKIZZE_K = 128
SKIZZE_MAX_LISTE = 60
SKIZZE_MIN_GEMEINSAM = 3
INHALT_FORM_J = 0.75
INHALT_FORM_C = 0.85
INHALT_GLEICH_J = 0.97
INHALT_GLEICH_C = 0.98
FASSUNG_J = 0.5
FASSUNG_C = 0.7
FASSUNG_DATUM_J = 0.8
STAMM_MIN = 0.5
SELTEN_DF = 5
BELEG_MIN = 3
ZAHLEN_MIN = 0.8
PAKET = 150
# Erster Lauf 60 s nach dem Start, danach alle 10 min ein Blick auf den Stand (eine Ordner-Liste über SMB); nach einer
# Unterbrechung (Vorrang, Index, FSM nicht erreichbar) schon nach 60 s wieder.
ERSTER_LAUF_S = 60.0
TAKT_S = 600.0
KURZ_S = 60.0
SPAETESTENS_S = 24 * 3600.0
RUHE_S = 20.0
STAND_DATEI = "doppel-stand.json"
MAX_DATEI_MB_HASH = 2048

FALT = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})
FAMILIE = {
    "pdf": "pdf",
    "docx": "word", "doc": "word", "odt": "word", "rtf": "word", "pages": "word", "dotx": "word",
    "xlsx": "tabelle", "xls": "tabelle", "xlsm": "tabelle", "ods": "tabelle", "numbers": "tabelle", "xltx": "tabelle",
    "csv": "daten",
    "jpg": "bild", "jpeg": "bild", "png": "bild", "tif": "bild", "tiff": "bild", "webp": "bild", "heic": "bild",
    "txt": "text", "md": "text",
}
# Unter-Version nur mit Punkt (V1.2); «v13_2» ist eine Kopie von v13 (Download-Zähler), keine Unter-Version.
_VERSION = re.compile(r"(?:^|[^a-z0-9])(?:v|ver|version|rev)[ ._-]?(\d{1,3})(?:\.(\d{1,2}))?(?!\d)", re.I)
_DATUM_ISO = re.compile(r"(?<!\d)(20\d{2}|19\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)")
_DATUM_CH = re.compile(r"(?<!\d)([0-3]?\d)\.([01]?\d)\.((?:19|20)?\d{2})(?!\d)")
_KOPIE = re.compile(r"\(\d{1,3}\)|[ _-]\d{1,2}$|\b(?:kopie|copy|final|entwurf|draft|unterschrieben|signiert|scan|neu|alt|def|definitiv)\b",
                    re.I)
_HISTORIE = re.compile(r"histor", re.I)


# --- Merkmale ---------------------------------------------------------------------------------------------------


def woerter(text: str) -> list[str]:
    """Kleinbuchstaben, Umlaute gefaltet, Akzente weg, nur Buchstaben/Ziffern — gleich für jede Form der Datei."""
    t = unicodedata.normalize("NFKC", text or "").lower().translate(FALT)
    t = "".join(c for c in unicodedata.normalize("NFKD", t) if not unicodedata.combining(c))
    return re.findall(r"[a-z0-9]+", t)


def schindeln(w: list[str], k: int = SCHINDEL_K) -> set[int]:
    """Wort-k-Gramme als Ganzzahlen (hash() nur innerhalb eines Laufs — nichts davon wird gespeichert)."""
    if len(w) < k:
        return {hash(" ".join(w))} if w else set()
    return {hash(" ".join(w[i:i + k])) for i in range(len(w) - k + 1)}


def endung(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def familie(name: str) -> str:
    e = endung(name)
    return FAMILIE.get(e, e or "?")


def _basis(name: str) -> str:
    b = name.rsplit(".", 1)[0] if "." in name else name
    return unicodedata.normalize("NFKC", b).lower().translate(FALT)


def version(name: str) -> tuple[int, int] | None:
    """Versionsmarke im Dateinamen (V02, v13, rev.01, Version 3, V1.2) — die letzte zählt."""
    treffer = list(_VERSION.finditer(_basis(name)))
    if not treffer:
        return None
    m = treffer[-1]
    return int(m.group(1)), int(m.group(2) or 0)


def datum_im_namen(name: str) -> str | None:
    """Datum im Dateinamen als JJJJ-MM-TT (2026-09-07, 20260907, 7.9.2026, 07.09.26) — das erste zählt."""
    b = _basis(name)
    m = _DATUM_ISO.search(b)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = _DATUM_CH.search(b)
    if m:
        tag, monat, jahr = int(m.group(1)), int(m.group(2)), m.group(3)
        jahr4 = int(jahr) if len(jahr) == 4 else 2000 + int(jahr)
        if 1 <= tag <= 31 and 1 <= monat <= 12:
            return f"{jahr4:04d}-{monat:02d}-{tag:02d}"
    return None


def stamm(name: str) -> set[str]:
    """Namensstamm: Wörter des Dateinamens ohne Endung, Versions-, Datums- und Kopie-Marken (Vorlage bleibt drin)."""
    b = _basis(name)
    b = _VERSION.sub(" ", b)
    b = _DATUM_ISO.sub(" ", b)
    b = _DATUM_CH.sub(" ", b)
    b = re.sub(r"[_\-.]+", " ", b).strip()
    b = _KOPIE.sub(" ", b)
    return {t for t in re.findall(r"[a-z]{2,}|\d{3,}", b)}


def in_historie(pfad: str) -> bool:
    """Liegt die Datei in einem Ordner «…Historie…» (jede Tiefe)?"""
    return any(_HISTORIE.search(seg) for seg in pfad.split("/")[:-1])


def jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    i = len(a & b)
    return i / (len(a) + len(b) - i)


# --- Daten ------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Datei:
    pfad: str        # NFC, relativ zur NAS-Wurzel
    sha256: str
    groesse: int
    mtime: float


@dataclass
class Dok:
    datei: Datei
    name: str
    familie: str
    sch: set[int]
    tok: set[str]
    zahlen: set[str]
    skizze: set[int] = field(default_factory=set)
    selten: set[str] = field(default_factory=set)


@dataclass(frozen=True)
class Paar:
    art: str                 # exakt | inhalt | fassung
    a: str                   # bei fassung: der NEUERE Pfad
    b: str                   # bei fassung: der ÄLTERE Pfad
    j: float
    c: float


@dataclass
class Ergebnis:
    gruppen: list[dict[str, Any]]
    zaehler: dict[str, int]
    dauer_ms: int


def baue_dok(d: Datei, text: str) -> Dok | None:
    w = woerter(text)
    if len(w) < MIN_WOERTER:
        return None
    tok = set(w)
    name = d.pfad.rsplit("/", 1)[-1]
    return Dok(d, name, familie(name), schindeln(w), tok, {t for t in tok if t.isdigit() and len(t) >= 3})


def _fassungs_zeichen(a: Dok, b: Dok, j: float) -> bool:
    va, vb = version(a.name), version(b.name)
    if va is not None and vb is not None and va != vb:
        return True
    # Nur eine trägt eine Marke: ab V02 neben dem unmarkierten Original eine neuere Fassung (V01 ist oft das Original).
    if (va is None) != (vb is None) and (va or vb or (0, 0)) >= (2, 0):
        return True
    if in_historie(a.datei.pfad) != in_historie(b.datei.pfad):
        return True
    da, db = datum_im_namen(a.name), datum_im_namen(b.name)
    return da is not None and db is not None and da != db and j >= FASSUNG_DATUM_J


def _neuer_zuerst(a: Dok, b: Dok) -> tuple[Dok, Dok]:
    """(neuer, älter): höhere Version, nicht in Historie, späteres Datum im Namen, sonst jüngere mtime."""
    va, vb = version(a.name), version(b.name)
    if va is not None and vb is not None and va != vb:
        return (a, b) if va > vb else (b, a)
    ha, hb = in_historie(a.datei.pfad), in_historie(b.datei.pfad)
    if ha != hb:
        return (b, a) if ha else (a, b)
    if (va is None) != (vb is None):
        # Nur eine trägt eine Versionsmarke (V02 neben dem unmarkierten Original): die markierte ist neuer.
        return (a, b) if va is not None else (b, a)
    da, db = datum_im_namen(a.name), datum_im_namen(b.name)
    if da and db and da != db:
        return (a, b) if da > db else (b, a)
    return (a, b) if a.datei.mtime >= b.datei.mtime else (b, a)


def klassifiziere(a: Dok, b: Dok) -> Paar | None:
    """Beziehung zweier Dateien mit Text (sha256 verschieden) — None = keine (kein Fehlalarm bei gleichem Muster)."""
    if a.datei.sha256 == b.datei.sha256:
        return Paar("exakt", a.datei.pfad, b.datei.pfad, 1.0, 1.0)
    inter = len(a.sch & b.sch)
    if not inter:
        return None
    j = inter / (len(a.sch) + len(b.sch) - inter)
    c = inter / max(1, min(len(a.sch), len(b.sch)))
    stamm_j = jaccard(stamm(a.name), stamm(b.name))
    belege = len(a.selten & b.selten)
    va, vb = version(a.name), version(b.name)
    # Ohne Belege im Text (Formular, Grafik) nur, wenn BEIDE Namen eine Versionsmarke tragen (Organigramm v12 → v13).
    beide_markiert = va is not None and vb is not None and va != vb
    if "daten" not in (a.familie, b.familie) and stamm_j >= STAMM_MIN and (j >= FASSUNG_J or c >= FASSUNG_C) \
            and _fassungs_zeichen(a, b, j) and (beide_markiert or belege >= BELEG_MIN):
        neu, alt = _neuer_zuerst(a, b)
        return Paar("fassung", neu.datei.pfad, alt.datei.pfad, round(j, 3), round(c, 3))
    zahlen_ok = len(a.zahlen) < 3 or len(b.zahlen) < 3 or jaccard(a.zahlen, b.zahlen) >= ZAHLEN_MIN
    versionen_gleich = va == vb or va is None or vb is None
    if belege < BELEG_MIN or not zahlen_ok or not versionen_gleich:
        return None
    if a.familie != b.familie:
        if j >= INHALT_FORM_J and c >= INHALT_FORM_C:
            return Paar("inhalt", a.datei.pfad, b.datei.pfad, round(j, 3), round(c, 3))
        return None
    if j >= INHALT_GLEICH_J and c >= INHALT_GLEICH_C:
        return Paar("inhalt", a.datei.pfad, b.datei.pfad, round(j, 3), round(c, 3))
    return None


def _kandidaten(docs: list[Dok], pause: Callable[[], None]) -> Iterable[tuple[int, int]]:
    """Paare mit genug gemeinsamen Werten der unteren Skizze (Bottom-k der Schindeln) — der Rest kann J ≥ 0,5 kaum
    erreichen. Sehr häufige Werte (Formular-Kopfzeilen in vielen Dateien) zählen nicht."""
    inv: dict[int, list[int]] = defaultdict(list)
    for i, d in enumerate(docs):
        for h in d.skizze:
            inv[h].append(i)
    zaehl: Counter = Counter()
    for n, liste in enumerate(inv.values()):
        if len(liste) > SKIZZE_MAX_LISTE:
            continue
        for x in range(len(liste)):
            for y in range(x + 1, len(liste)):
                zaehl[(liste[x], liste[y])] += 1
        if n % 5000 == 0:
            pause()
    return [p for p, k in zaehl.items() if k >= SKIZZE_MIN_GEMEINSAM]


class _Mengen:
    """Union-Find über Pfade."""

    def __init__(self) -> None:
        self.eltern: dict[str, str] = {}

    def finde(self, x: str) -> str:
        self.eltern.setdefault(x, x)
        while self.eltern[x] != x:
            self.eltern[x] = self.eltern[self.eltern[x]]
            x = self.eltern[x]
        return x

    def vereine(self, a: str, b: str) -> None:
        ra, rb = self.finde(a), self.finde(b)
        if ra != rb:
            self.eltern[max(ra, rb)] = min(ra, rb)


def _gruppen_schluessel(art: str, pfade: Iterable[str]) -> str:
    return art[0] + ":" + hashlib.sha256("\n".join(sorted(pfade)).encode("utf-8")).hexdigest()[:20]


def berechne(dateien: list[Datei], texte: dict[str, str], *, pause: Callable[[], None] = lambda: None) -> Ergebnis:
    """Ganze Rechnung: exakte Gruppen über alle Dateien, Inhalt/Fassung über die Dateien mit Text.

    Gruppen «gleich» = zusammenhängende exakt-/inhalt-Paare; je Mitglied `kopie` (gleiche Zahl = gleiche Bytes) und
    `aehnlichkeit` zur ähnlichsten anderen Datei der Gruppe. Gruppen «fassung» = je ein Paar (neu, alt) — die direkt
    vorhergehende Fassung je Datei (bei V01, V02, V03: V03→V02, V02→V01)."""
    start = time.monotonic()
    nach_pfad = {d.pfad: d for d in dateien if d.groesse > 0 and d.sha256}
    mengen = _Mengen()
    beste: dict[str, float] = {}
    zaehler: Counter = Counter(dateien=len(nach_pfad))

    # 1) exakt: gleicher sha256 (jede Datei, auch ohne Text)
    je_sha: dict[str, list[str]] = defaultdict(list)
    for d in nach_pfad.values():
        je_sha[d.sha256].append(d.pfad)
    for pfade in je_sha.values():
        if len(pfade) < 2:
            continue
        for p in pfade[1:]:
            mengen.vereine(pfade[0], p)
        for p in pfade:
            beste[p] = 1.0
        zaehler["exakt_paare"] += len(pfade) - 1

    # 2) Text-Merkmale
    docs: list[Dok] = []
    for pfad, text in texte.items():
        d = nach_pfad.get(pfad)
        if d is None:
            continue
        dok = baue_dok(d, text)
        if dok is not None:
            docs.append(dok)
        if len(docs) % 50 == 0:
            pause()
    zaehler["mit_text"] = len(docs)
    df: Counter = Counter()
    for d in docs:
        df.update(d.tok)
    for d in docs:
        d.selten = {t for t in d.tok if df[t] <= SELTEN_DF}
        d.skizze = set(heapq.nsmallest(SKIZZE_K, d.sch))

    # 3) Paare
    fassungen: dict[str, tuple[str, float, float, tuple]] = {}   # neu → (alt, j, c, sort-schlüssel des alten)
    for n, (i, k) in enumerate(_kandidaten(docs, pause)):
        if n % 500 == 0:
            pause()
        a, b = docs[i], docs[k]
        if a.datei.sha256 == b.datei.sha256:
            continue
        p = klassifiziere(a, b)
        if p is None:
            continue
        if p.art == "inhalt":
            mengen.vereine(p.a, p.b)
            beste[p.a] = max(beste.get(p.a, 0.0), p.j)
            beste[p.b] = max(beste.get(p.b, 0.0), p.j)
            zaehler["inhalt_paare"] += 1
        elif p.art == "fassung":
            zaehler["fassung_paare"] += 1
            # Je neuere Datei nur die nächstältere Fassung: grösster Sortier-Schlüssel unter den älteren.
            alt = b if a.datei.pfad == p.a else a
            schluessel = _sortier_schluessel(alt)
            bisher = fassungen.get(p.a)
            if bisher is None or schluessel > bisher[3]:
                fassungen[p.a] = (p.b, p.j, p.c, schluessel)

    # 4) Gruppen «gleich»
    komponenten: dict[str, list[str]] = defaultdict(list)
    for p in set(mengen.eltern):
        komponenten[mengen.finde(p)].append(p)
    gruppen: list[dict[str, Any]] = []
    for mitglieder in komponenten.values():
        if len(mitglieder) < 2:
            continue
        kopie_nr: dict[str, int] = {}
        eintraege = []
        for p in sorted(mitglieder):
            d = nach_pfad[p]
            kopie_nr.setdefault(d.sha256, len(kopie_nr) + 1)
            eintraege.append({"pfad": p, "groesse": d.groesse, "mtime": int(d.mtime), "kopie": kopie_nr[d.sha256],
                              "aehnlichkeit": round(beste.get(p, 0.0), 3)})
        art_innen = "exakt" if len(kopie_nr) == 1 else "inhalt"
        zaehler[f"gruppen_{art_innen}"] += 1
        gruppen.append({"gruppe": _gruppen_schluessel("gleich", mitglieder), "art": "gleich", "mitglieder": eintraege})

    # 5) Gruppen «fassung» (je ein Paar neu → alt)
    for neu, (alt, j, c, _s) in sorted(fassungen.items()):
        dn, da = nach_pfad[neu], nach_pfad[alt]
        zaehler["gruppen_fassung"] += 1
        gruppen.append({"gruppe": _gruppen_schluessel("fassung", (neu, alt)), "art": "fassung", "mitglieder": [
            {"pfad": neu, "groesse": dn.groesse, "mtime": int(dn.mtime), "rolle": "neu", "aehnlichkeit": j},
            {"pfad": alt, "groesse": da.groesse, "mtime": int(da.mtime), "rolle": "alt", "aehnlichkeit": j},
        ]})
    return Ergebnis(gruppen, dict(zaehler), int((time.monotonic() - start) * 1000))


def _sortier_schluessel(d: Dok) -> tuple:
    v = version(d.name)
    return (v or (0, 0), 0 if in_historie(d.datei.pfad) else 1, datum_im_namen(d.name) or "", d.datei.mtime)


# --- Upload-Prüfung (ablage_analyse: Datei kommt neu, liegt noch nicht auf dem NAS) ------------------------------


def pruefe_neue_datei(name: str, sha256: str, text: str, vergleich: "Vergleichsbasis | None") -> dict[str, Any] | None:
    """Liegt diese (hochgeladene) Datei schon auf dem NAS? exakt → inhalt → fassung, nur Pfade und Werte zurück."""
    if vergleich is None:
        return None
    treffer = vergleich.exakt(sha256)
    if treffer:
        return {"art": "exakt", "pfad": treffer, "aehnlichkeit": 1.0}
    neu = baue_dok(Datei(f"neu/{name}", sha256, 1, time.time()), text) if text else None
    if neu is None:
        return None
    neu.selten = {t for t in neu.tok if vergleich.df.get(t, 0) < SELTEN_DF}
    neu.skizze = set(heapq.nsmallest(SKIZZE_K, neu.sch))
    best: tuple[int, Paar] | None = None
    for d in vergleich.aehnliche(neu):
        p = klassifiziere(neu, d)
        if p is None:
            continue
        prio = {"exakt": 3, "inhalt": 2, "fassung": 1}[p.art]
        # Upload: «fassung» nur, wenn die NEUE Datei die neuere ist.
        if p.art == "fassung" and p.a != neu.datei.pfad:
            continue
        if best is None or (prio, p.j) > (best[0], best[1].j):
            best = (prio, p)
    if best is None:
        return None
    p = best[1]
    anderer = p.b if p.a == neu.datei.pfad else p.a
    return {"art": p.art, "pfad": anderer, "aehnlichkeit": p.j}


class Vergleichsbasis:
    """Merkmale des letzten Laufs im Speicher (für die Upload-Prüfung) — Skizzen, seltene Wörter, keine Texte."""

    def __init__(self, docs: list[Dok], df: dict[str, int], sha_zu_pfad: dict[str, str]) -> None:
        self.docs = docs
        self.df = df
        self.sha_zu_pfad = sha_zu_pfad
        self.inv: dict[int, list[int]] = defaultdict(list)
        for i, d in enumerate(docs):
            for h in d.skizze:
                self.inv[h].append(i)

    def exakt(self, sha256: str) -> str | None:
        return self.sha_zu_pfad.get(sha256)

    def aehnliche(self, neu: Dok) -> list[Dok]:
        zaehl: Counter = Counter()
        for h in neu.skizze:
            liste = self.inv.get(h)
            if liste and len(liste) <= SKIZZE_MAX_LISTE:
                zaehl.update(liste)
        return [self.docs[i] for i, k in zaehl.items() if k >= SKIZZE_MIN_GEMEINSAM]


# --- Datenbank (Tresor) -----------------------------------------------------------------------------------------

DDL = """
CREATE TABLE IF NOT EXISTS doppel_hash (
  pfad     text PRIMARY KEY,
  groesse  bigint NOT NULL,
  mtime    double precision NOT NULL,
  sha256   text NOT NULL,
  gesehen  timestamptz NOT NULL DEFAULT now()
);
"""


class DoppelSpeicher:
    def __init__(self, dsn: str | None) -> None:
        self._dsn = dsn
        self._conn = None
        self._lock = threading.Lock()

    @property
    def aktiv(self) -> bool:
        return self._dsn is not None

    def _verbindung(self):
        import psycopg

        if self._conn is None or self._conn.closed:
            self._conn = psycopg.connect(self._dsn, autocommit=True)
            with self._conn.cursor() as c:
                c.execute(DDL)
        return self._conn

    def _sql(self, sql: str, werte: tuple | list = (), *, holen: bool = False, viele: bool = False) -> list[tuple]:
        with self._lock:
            try:
                with self._verbindung().cursor() as c:
                    if viele:
                        c.executemany(sql, werte)
                        return []
                    c.execute(sql, werte)
                    return list(c.fetchall()) if holen else []
            except Exception:
                if self._conn is not None:
                    try:
                        self._conn.close()
                    except Exception:  # noqa: BLE001
                        pass
                self._conn = None
                raise

    def tiefen_stand(self) -> tuple[int, str]:
        z = self._sql("SELECT count(*), coalesce(max(extrahiert)::text, '') FROM archiv_text", holen=True)
        return (int(z[0][0]), str(z[0][1])) if z else (0, "")

    def tiefen_dateien(self) -> dict[str, tuple[int, float, str]]:
        return {str(p): (int(g), float(m), str(s)) for p, g, m, s in
                self._sql("SELECT pfad, groesse, mtime, sha256 FROM archiv_text", holen=True)}

    def texte(self, pfade: Iterable[str]) -> dict[str, str]:
        liste = list(pfade)
        aus: dict[str, str] = {}
        for i in range(0, len(liste), 200):
            for p, t in self._sql("SELECT pfad, text FROM archiv_text WHERE pfad = ANY(%s) AND zeichen > 0",
                                  (liste[i:i + 200],), holen=True):
                aus[str(p)] = str(t or "")
        return aus

    def hashes(self) -> dict[str, tuple[int, float, str]]:
        return {str(p): (int(g), float(m), str(s)) for p, g, m, s in
                self._sql("SELECT pfad, groesse, mtime, sha256 FROM doppel_hash", holen=True)}

    def merke_hashes(self, zeilen: list[tuple[str, int, float, str]]) -> None:
        if zeilen:
            self._sql(
                """INSERT INTO doppel_hash (pfad, groesse, mtime, sha256, gesehen) VALUES (%s, %s, %s, %s, now())
                   ON CONFLICT (pfad) DO UPDATE SET groesse = EXCLUDED.groesse, mtime = EXCLUDED.mtime,
                   sha256 = EXCLUDED.sha256, gesehen = now()""",
                zeilen, viele=True,
            )

    def vergiss_hashes(self, pfade: Iterable[str]) -> None:
        liste = list(pfade)
        if liste:
            self._sql("DELETE FROM doppel_hash WHERE pfad = ANY(%s)", (liste,))

    def schliessen(self) -> None:
        with self._lock:
            if self._conn is not None:
                try:
                    self._conn.close()
                except Exception:  # noqa: BLE001
                    pass
                self._conn = None


def nas_liste(wurzel: Path) -> tuple[list[tuple[str, Path, int, float]], bool]:
    """Alle Dateien aller lesbaren Freigaben (jede Endung, auch ZZ_*, nie 99_System/versteckt) — (pfad NFC, voll,
    groesse, mtime) und ob der Durchgang vollständig war (sonst wird nichts als «verschwunden» gewertet)."""
    lesbar, unvollstaendig = freigaben_zustand(wurzel)
    aus: list[tuple[str, Path, int, float]] = []
    fehler = False

    def gehe(ordner: Path, rel: tuple[str, ...]) -> None:
        nonlocal fehler
        try:
            eintraege = sorted(ordner.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            fehler = True
            return
        for e in eintraege:
            if ausgeschlossen(e.name):
                continue
            try:
                if e.is_dir():
                    gehe(e, rel + (e.name,))
                    continue
                if not e.is_file():
                    continue
                st = e.stat()
            except OSError:
                fehler = True
                continue
            aus.append((nfc("/".join(rel + (e.name,))), e, int(st.st_size), float(st.st_mtime)))

    for f in lesbar:
        gehe(wurzel / f, (f,))
    return aus, not fehler and not unvollstaendig


# --- Thread -----------------------------------------------------------------------------------------------------


class DoppelPruefung(threading.Thread):
    def __init__(self, cfg: Einstellungen, fsm: Any, *, ruhig: Callable[[], bool],
                 vorarbeit_laeuft: Callable[[], bool] = lambda: False, speicher: DoppelSpeicher | None = None,
                 takt_s: float = TAKT_S) -> None:
        super().__init__(name="ki-doppel", daemon=True)
        self.cfg = cfg
        self.fsm = fsm
        self.ruhig = ruhig
        self.vorarbeit_laeuft = vorarbeit_laeuft
        self.speicher = speicher or DoppelSpeicher(cfg.pg_dsn)
        self.takt_s = takt_s
        self._halt = threading.Event()
        self._signatur: str | None = None
        self._letzter_lauf = 0.0
        self._offen: tuple[str, list[dict[str, Any]]] | None = None   # (lauf_id, gruppen) — noch nicht gemeldet
        self._naechste_meldung = 0.0
        self._backoff = 30.0
        self.vergleich: Vergleichsbasis | None = None
        self.stand: dict[str, Any] = {"aktiv": True, "letzter_lauf": None, "dauer_ms": None, "zaehler": {},
                                      "gemeldet": None, "fehler": None, "laeuft": False}

    def stop(self) -> None:
        self._halt.set()

    def status(self) -> dict[str, Any]:
        return dict(self.stand)

    def run(self) -> None:
        log.info("Doppel-Prüfung gestartet (Rezept %s, Takt %.0f s)", REZEPT, self.takt_s)
        warte = ERSTER_LAUF_S
        while not self._halt.wait(warte):
            try:
                grund = self.runde()
            except Exception as e:  # noqa: BLE001 — der Thread darf nie sterben
                self.stand["fehler"] = type(e).__name__
                log.exception("Doppel-Prüfung: unerwarteter Fehler")
                grund = "fehler"
            self.stand["grund"] = grund
            warte = KURZ_S if grund in ("vorrang", "vorarbeit", "abgebrochen", "fehler", "warten", "kein_nas") else self.takt_s

    def runde(self) -> str:
        if self._offen is not None:
            return self._melden()
        if self.vorarbeit_laeuft():
            return "vorarbeit"
        if not self.ruhig():
            return "vorrang"
        dateien, vollstaendig = nas_liste(self.cfg.nas_wurzel)
        if not dateien:
            return "kein_nas"
        signatur = hashlib.sha256(
            (json.dumps(self.speicher.tiefen_stand()) + "".join(f"{p}|{g}|{int(m)}\n" for p, _v, g, m in dateien)).encode()
        ).hexdigest()
        faellig = signatur != self._signatur or time.monotonic() - self._letzter_lauf > SPAETESTENS_S
        if not faellig:
            return "aktuell"
        self.stand["laeuft"] = True
        try:
            ergebnis = self.rechne(dateien, vollstaendig)
        finally:
            self.stand["laeuft"] = False
        if ergebnis is None:
            return "abgebrochen"
        self._signatur = signatur
        self._letzter_lauf = time.monotonic()
        lauf_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        self._offen = (lauf_id, ergebnis.gruppen)
        self._naechste_meldung = 0.0
        return self._melden()

    def _pause(self) -> None:
        """Zwischendurch den Interpreter freigeben (Worker, Herzschlag) — und abbrechen, wenn jemand wartet."""
        time.sleep(0.005)
        if self._halt.is_set() or not self.ruhig():
            raise _Abbruch()

    def rechne(self, dateien: list[tuple[str, Path, int, float]], vollstaendig: bool) -> Ergebnis | None:
        start = time.monotonic()
        try:
            tief = self.speicher.tiefen_dateien()
            bekannt = self.speicher.hashes()
            neu_hash: list[tuple[str, int, float, str]] = []
            liste: list[Datei] = []
            for pfad, voll, groesse, mtime in dateien:
                t = tief.get(pfad)
                if t and t[0] == groesse and abs(t[1] - mtime) < 1.0:
                    liste.append(Datei(pfad, t[2], groesse, mtime))
                    continue
                h = bekannt.get(pfad)
                if h and h[0] == groesse and abs(h[1] - mtime) < 1.0:
                    liste.append(Datei(pfad, h[2], groesse, mtime))
                    continue
                if groesse <= 0 or groesse > MAX_DATEI_MB_HASH * 1024 * 1024:
                    continue
                self._pause()
                try:
                    sha = sha256_von(voll)
                except OSError:
                    continue
                neu_hash.append((pfad, groesse, mtime, sha))
                liste.append(Datei(pfad, sha, groesse, mtime))
            self.speicher.merke_hashes(neu_hash)
            if vollstaendig:
                da = {p for p, _v, _g, _m in dateien}
                self.speicher.vergiss_hashes([p for p in bekannt if p not in da])
            texte = self.speicher.texte(p.pfad for p in liste if p.pfad in tief)
            ergebnis = berechne(liste, texte, pause=self._pause)
            self.vergleich = _basis_aus(liste, texte)
        except _Abbruch:
            log.info("Doppel-Prüfung: unterbrochen (Vorrang) — nächster Versuch in %.0f s", self.takt_s)
            return None
        dauer = int((time.monotonic() - start) * 1000)
        self.stand.update(letzter_lauf=datetime.now(timezone.utc).isoformat(timespec="seconds"), dauer_ms=dauer,
                          zaehler={**ergebnis.zaehler, "neu_gehasht": len(neu_hash)}, fehler=None)
        log.info("Doppel-Prüfung: %s in %d ms", json.dumps(self.stand["zaehler"], ensure_ascii=False), dauer)
        return ergebnis

    def _melden(self) -> str:
        if self._offen is None:
            return "leer"
        if time.monotonic() < self._naechste_meldung:
            return "warten"
        lauf_id, gruppen = self._offen
        pakete = [gruppen[i:i + PAKET] for i in range(0, len(gruppen), PAKET)] or [[]]
        try:
            for n, paket in enumerate(pakete):
                self.fsm.melde_doppel({"lauf_id": lauf_id, "rezept": REZEPT, "teil": n + 1, "teile": len(pakete),
                                       "letzter": n == len(pakete) - 1, "gruppen": paket})
        except FsmAbgelehnt as e:
            self.stand["fehler"] = str(e)[:120]
            log.error("Doppel-Prüfung: %s — Liste verworfen, nächster Lauf meldet neu", self.stand["fehler"])
            self._offen = None
            self._signatur = None
            return "abgelehnt"
        except FsmFehler as e:
            self.stand["fehler"] = str(e)[:120]
            self._naechste_meldung = time.monotonic() + self._backoff
            log.warning("Doppel-Prüfung: %s — nächster Versuch in %.0f s", self.stand["fehler"], self._backoff)
            self._backoff = min(self._backoff * 2, 1800.0)
            return "fehler"
        self._offen = None
        self._backoff = 30.0
        self.stand.update(gemeldet=datetime.now(timezone.utc).isoformat(timespec="seconds"), fehler=None)
        return "gemeldet"


class _Abbruch(Exception):
    pass


def _basis_aus(liste: list[Datei], texte: dict[str, str]) -> Vergleichsbasis:
    docs: list[Dok] = []
    for d in liste:
        t = texte.get(d.pfad)
        dok = baue_dok(d, t) if t else None
        if dok is not None:
            docs.append(dok)
    df: Counter = Counter()
    for d in docs:
        df.update(d.tok)
    for d in docs:
        d.selten = {t for t in d.tok if df[t] <= SELTEN_DF}
        d.skizze = set(heapq.nsmallest(SKIZZE_K, d.sch))
        # Für die Upload-Prüfung reichen Skizze, seltene Wörter, Zahlen und Schindeln — die Wörter selbst nicht.
        d.tok = set()
    sha_zu_pfad: dict[str, str] = {}
    for d in sorted(liste, key=lambda x: (x.pfad.upper().startswith("ZZ_"), x.pfad)):
        sha_zu_pfad.setdefault(d.sha256, d.pfad)
    return Vergleichsbasis(docs, dict(df), sha_zu_pfad)
