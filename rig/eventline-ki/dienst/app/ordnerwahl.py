"""Ordnerwahl nach Vorbild (SPEC §2.2): Kandidaten aus festen Regeln, Archiv-Nachbarn und Ordnernamen.

Reihenfolge je Auftrag (alles deterministisch; das Sprachmodell wählt danach nur noch unter den
besten Kandidaten, handlers/ablage.py):

1. Regeln vor allem anderen
   - INT-Nummer im Dateinamen («INT-26-014», «INT26014») → der Projektordner mit dieser Nummer
     (eindeutig = entschieden; zwei Ordner mit derselben Nummer = beide vorne, das Modell wählt).
     Die blosse Form «26-014» ohne «INT» (Lieferanten-Offert-/Rechnungsnummern haben dieselbe Form
     JJ-NNN) und «INT-…» im Text zählen nur als starker Hinweis (TEXT_INT-Zuschlag), nie als Entscheid
     (Review 2026-10-11; gemessen im Text: 5 von 7 Treffern richtig).
   - Personalakte: Stufe 1 erkennt eine Person aus der Mitarbeiterliste bei einem personenbezogenen
     Typ → nur noch Ordner in der Akte dieser Person (Ordner «NNNN_Vorname_Nachname» in einer
     PERSONAL-Freigabe, alle Namensteile gleich — auch kurze wie «Li»); hat die Akte keine Unterordner,
     ist sie entschieden.
   - Ist ein Regel-Bereich erkannt (INT-Projekt, Personalakte), bekommt jeder Kandidat darin einen
     Sockel (REGEL/2): auch Unterordner ohne eigene Punkte stehen in der Rangliste, in Listenreihenfolge.
   - Ordner in oder unter «ZZ_*» (jede Tiefe) sind nie Kandidat und nie Ziel eines neuen Ordners.
2. Stimmen der k nächsten Nachbarn (Kosinus der Einbettungen) je Ordner, gewichtet mit
   exp((s − s_max)/τ); ein Teil jeder Stimme geht auf gleichnamige Ordner anderer Entitäten über
   (Hauskonvention: «02_Plaene_Grundrisse» der Location A zählt auch für «01_Plaene_Grundrisse»
   der Location B), die Summe je Kategorie (Freigabe + erste Ebene) sagt, welcher Bereich passt.
3. Ordnernamen: seltene Wörter des Pfads (IDF über alle Ordnernamen) im Dokument und die
   Ähnlichkeit Dokument ↔ Pfad (Einbettung) — damit findet auch ein Ordner ohne Vorbild
   (Projektordner mit einer einzigen Datei) seinen Platz in der Liste.
4. Dokumenttyp aus Stufe 1: Unterordner, deren Name zur Dokumentart passt (Vertr…, Offert…),
   bekommen einen kleinen Zuschlag — nur bei Kandidaten, die schon Punkte haben.

Kandidat ist jeder Ordner der FSM-Liste unterhalb einer Freigabe, der keine Unterordner hat oder
selbst schon Dateien enthält (Hauskonvention: Dateien liegen in Blattordnern).
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Collection, Mapping, Sequence

from .archiv import Nachbar, lesbarer_name, nfc, unter_zz

# --- Parameter — gemessen 2026-10-04 (Leave-one-out, 167 einsortierte Dateien, README «Ordnerwahl») --------
K_NACHBARN = 15
TAU = 0.05            # exp((s − s_max)/τ): 0,1 Kosinus weniger ähnlich = Stimme ÷ 7
STRUKTUR = 0.3        # Anteil einer Stimme für gleichnamige Ordner anderer Entitäten
KATEGORIE = 0.5       # Gewicht der Stimmen-Summe der Kategorie (Freigabe + erste Ebene)
LEXIK = 0.03          # je IDF-Punkt eines Pfad-Worts, das im Dokument vorkommt
EINBETTUNG = 2.0      # × (Kosinus Dokument ↔ Pfad − Schwelle), nur der positive Teil
EINBETTUNG_SCHWELLE = 0.4
TYP_FAKTOR = 1.25     # Unterordner passt zur Dokumentart (nur auf vorhandene Punkte)
TEXT_INT = 2.0        # «INT-…» im Text oder blosse Form «26-014» im Dateinamen: Zuschlag statt Entscheid
REGEL = 100.0         # Regel-Treffer stehen immer vorne
SOCKEL_REGEL = REGEL / 2  # jeder Kandidat eines erkannten Regel-Bereichs — auch ohne eigene Punkte
# Zweite Liste nur aus Ordnernamen, beschränkt auf die Kategorien mit mindestens diesem Anteil der
# Stimmen; die Kandidaten wechseln sich ab (gemessen: das Ziel unter den besten 5 in 85 % statt 80 %).
KATEGORIE_SCHWELLE = 0.15
NAMEN_BEREICH_TIEFE = 1   # 1 = Freigabe (bei Locations ist die erste Ebene schon die Entität), 2 = Kategorie
MAX_NACHBAR_NAMEN = 3

_FALTUNG = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss", "é": "e", "è": "e", "ê": "e", "à": "a", "â": "a", "ç": "c", "ô": "o", "î": "i"})
_STOPP = frozenset({
    "und", "der", "die", "das", "den", "dem", "des", "fuer", "mit", "von", "vom", "zum", "zur", "the", "and",
    "gmbh", "int", "nr", "allgemein", "sonstiges", "sonstige",
})
_NUMMERN_PRAEFIX = re.compile(r"^\d+_")
# «INT» darf nicht Teil eines Worts sein (kein Buchstabe/Ziffer davor) — ein Unterstrich davor («Offerte_INT-26-033»)
# ist aber üblich, darum nicht \b (für re ist «_» ein Wortzeichen).
INT_IM_ORDNER = re.compile(r"(?i)(?<![A-Za-z0-9])INT[-_ ]?(\d{2})[-_ ]?(\d{3})(?!\d)")
# Im Dateinamen (ohne Endung) als Entscheid nur mit «INT»: «INT-26-014», «INT26014», «Offerte_INT-26-014».
INT_IM_DATEINAMEN = re.compile(r"(?i)(?<![A-Za-z0-9])INT[\s_-]*(\d{2})[\s_-]*(\d{3})(?!\d)")
# Die blosse Form «…_26-014_…» (Bindestrich, nicht Teil einer längeren Zahl wie «2026-014» oder «1.26-014»):
# nur ein Hinweis — Lieferanten-Offert-/Rechnungsnummern «26-033» sehen gleich aus.
NUMMER_IM_DATEINAMEN = re.compile(r"(?<![\d.])(\d{2})-(\d{3})(?!\d)")
INT_IM_TEXT = re.compile(r"(?i)(?<![A-Za-z0-9])INT[\s_-]*(\d{2})[\s_-]*(\d{3})(?!\d)")
_PERSONEN_ORDNER = re.compile(r"^\d{3,}_")


def falte(s: str) -> str:
    return nfc(s).lower().translate(_FALTUNG)


def woerter(s: str) -> list[str]:
    return [t for t in re.split(r"[^a-z0-9]+", falte(s)) if len(t) >= 3 and not t.isdigit() and t not in _STOPP]


def namensteile(s: str) -> frozenset[str]:
    """Alle Namensteile einer Person bzw. eines Akten-Ordners (ohne Nummern-Präfix): auch 1–2 Zeichen («Li»),
    keine Stoppwort-Filterung, Ziffern fallen weg."""
    return frozenset(t for t in re.split(r"[^a-z0-9]+", falte(_NUMMERN_PRAEFIX.sub("", s))) if t and not t.isdigit())


def segment_woerter(segment: str) -> list[str]:
    return woerter(_NUMMERN_PRAEFIX.sub("", segment))


def generisch(segment: str) -> str:
    return falte(_NUMMERN_PRAEFIX.sub("", segment))


def _praefix(pfad: str, tiefe: int) -> str:
    return "/".join(pfad.split("/")[:tiefe])


def kategorie(pfad: str) -> str:
    return _praefix(pfad, 2)


@dataclass
class Kandidat:
    pfad: str  # exakt wie in der FSM-Liste
    punkte: float
    quellen: set[str] = field(default_factory=set)  # regel, knn, struktur, name
    nachbarn: list[str] = field(default_factory=list)  # Dateinamen der ähnlichsten Vorbilder dort
    # V8: liegt in einem erkannten Regel-Bereich (INT-Projekt aus dem Dateinamen, auch mehrdeutig; Personalakte) —
    # «INT-…» im Text bzw. «26-014» ohne INT sind nur Hinweise und zählen hier nicht.
    regel_bereich: bool = False


@dataclass
class Rangliste:
    kandidaten: list[Kandidat]
    regel: str | None = None  # von einer Regel entschiedener Ordner (exakt wie in der FSM-Liste)
    regel_art: str | None = None  # «int» | «person»
    staerkste_aehnlichkeit: float = 0.0

    def pfade(self, n: int | None = None) -> list[str]:
        return [k.pfad for k in (self.kandidaten if n is None else self.kandidaten[:n])]


# --- Vorberechnung je Ordnerliste (das FSM schickt bei jedem Auftrag dieselbe Liste) ---------------------


@dataclass(frozen=True)
class OrdnerModell:
    original: dict[str, str]  # NFC → exakte Schreibweise der FSM-Liste
    alle: tuple[str, ...]  # NFC, Listenreihenfolge
    eltern: frozenset[str]
    pfad_woerter: dict[str, tuple[tuple[str, float], ...]]  # Wörter unter der Freigabe + IDF
    gleichnamig: dict[tuple[str, int, str], tuple[str, ...]]
    int_ordner: dict[tuple[str, str], tuple[str, ...]]


@lru_cache(maxsize=4)
def ordner_modell(ordner: tuple[str, ...]) -> OrdnerModell:
    original: dict[str, str] = {}
    for o in ordner:
        original.setdefault(nfc(o), o)
    # ZZ_* (jede Tiefe) ist nie Kandidat, nie Vorbild-Ordner, nie INT-Ziel — die FSM-Liste führt solche
    # Ordner (Altes, Archiv) durchaus als aktiv.
    alle = tuple(o for o in original if not unter_zz(o))
    eltern = frozenset(o.rsplit("/", 1)[0] for o in alle if "/" in o)
    df: dict[str, int] = defaultdict(int)
    for o in alle:
        for t in set(segment_woerter(o.split("/")[-1])):
            df[t] += 1
    n = len(alle) or 1

    def idf(t: str) -> float:
        return math.log((n + 1) / (df.get(t, 0) + 1)) + 0.1

    pfad_woerter = {}
    for o in alle:
        ws = {t for seg in o.split("/")[1:] for t in segment_woerter(seg)}
        pfad_woerter[o] = tuple((t, idf(t)) for t in sorted(ws))
    gleich: dict[tuple[str, int, str], list[str]] = defaultdict(list)
    for o in alle:
        teile = o.split("/")
        if len(teile) >= 3:
            gleich[(teile[0], len(teile), generisch(teile[-1]))].append(o)
    int_ordner: dict[tuple[str, str], list[str]] = defaultdict(list)
    for o in alle:
        m = INT_IM_ORDNER.search(o.split("/")[-1])
        if m:
            int_ordner[(m.group(1), m.group(2))].append(o)
    return OrdnerModell(
        original=original,
        alle=alle,
        eltern=eltern,
        pfad_woerter=pfad_woerter,
        gleichnamig={k: tuple(v) for k, v in gleich.items()},
        int_ordner={k: tuple(v) for k, v in int_ordner.items()},
    )


# --- Bausteine ---------------------------------------------------------------------------------------------


def _praefixe(dok: set[str]) -> set[str]:
    p: set[str] = set()
    for d in dok:
        for laenge in range(5, min(len(d), 24) + 1):
            p.add(d[:laenge])
    return p


def _passt(t: str, dok: set[str], praefixe: set[str]) -> bool:
    """Wort im Dokument — gleich, oder (ab 6 Zeichen) gleicher Wortanfang: Grundrisse ~ Grundriss, Verträge ~ Vertrag."""
    if t in dok:
        return True
    return len(t) >= 6 and t[: max(5, len(t) - 3)] in praefixe


def _stamm(dateiname: str) -> str:
    return re.sub(r"\.[A-Za-z0-9]{1,8}$", "", dateiname or "")


def int_nummern(dateiname: str) -> set[tuple[str, str]]:
    """INT-Nummern im Dateinamen, die als Regel entscheiden — nur mit «INT»-Präfix."""
    return {m.groups() for m in INT_IM_DATEINAMEN.finditer(_stamm(dateiname))}


def nummern_form(dateiname: str) -> set[tuple[str, str]]:
    """Blosse «NN-NNN» im Dateinamen ohne «INT» — Hinweis wie «INT-…» im Text (Offert-/Rechnungsnummern von
    Lieferanten haben dieselbe Form), nie ein Entscheid."""
    stamm = _stamm(dateiname)
    return {m.groups() for m in NUMMER_IM_DATEINAMEN.finditer(stamm)} - int_nummern(dateiname)


def personen_akte(m: OrdnerModell, person: str) -> list[str]:
    """Akte(n) der Person: Ordner «NNNN_Vorname_Nachname» in einer PERSONAL-Freigabe (ohne Vorlagen 0000_*).
    Alle Namensteile müssen gleich sein (Wortmenge, auch kurze wie «Li») — «Li Wang» trifft nicht «Mei Wang»."""
    namen = namensteile(person)
    if not namen:
        return []
    treffer = []
    for o in m.alle:
        teile = o.split("/")
        letzter = teile[-1]
        if "personal" not in falte(teile[0]) or not _PERSONEN_ORDNER.match(letzter) or letzter.startswith("0000"):
            continue
        if namen == namensteile(letzter):
            treffer.append(o)
    return treffer


_TYP_STAEMME = {
    "versicherungspolice": ("versich", "police"),
    "vertrag": ("vertr",),
    "rechnung": ("rechn",),
    "offerte": ("offert",),
    "kuendigung": ("kuendig",),
    "korrespondenz": ("korresp",),
    "protokoll": ("protok",),
    "lohnabrechnung": ("lohn",),
    "bank": ("bank", "finanz"),
    "steuern": ("steuer",),
    "behoerde": ("behoerd", "bewillig", "amtlich"),
    "zertifikat": ("zertifik", "nachweis"),
    "mahnung": ("mahnung",),
}


def typ_passt(typ: str | None, segment: str) -> bool:
    staemme = _TYP_STAEMME.get(typ or "")
    if not staemme:
        return False
    g = generisch(segment)
    return any(s in g for s in staemme)


# --- Rangliste ---------------------------------------------------------------------------------------------


def mische(erste: list[str], zweite: list[str]) -> list[str]:
    """Die Spitze der ersten Liste, dann abwechselnd zweite/erste — ohne Doppelte."""
    aus: list[str] = []
    gesehen: set[str] = set()

    def nimm(o: str) -> None:
        if o not in gesehen:
            gesehen.add(o)
            aus.append(o)

    if erste:
        nimm(erste[0])
    i, j = 1, 0
    while i < len(erste) or j < len(zweite):
        if j < len(zweite):
            nimm(zweite[j])
            j += 1
        if i < len(erste):
            nimm(erste[i])
            i += 1
    return aus


def rangliste(
    *,
    ordner: Sequence[str],
    mit_dateien: Collection[str],
    nachbarn: Sequence[Nachbar],
    dateiname: str,
    text: str,
    doc_vektor: Sequence[float] | None,
    ordner_vektoren: Mapping[str, Sequence[float]],
    typ: str | None = None,
    person: str | None = None,
) -> Rangliste:
    m = ordner_modell(tuple(ordner))
    mit = {nfc(o) for o in mit_dateien}
    alle_kandidaten = [o for o in m.alle if "/" in o and (o not in m.eltern or o in mit)]
    kandidaten_menge = alle_kandidaten

    def teilbaum(wurzel: str) -> list[str]:
        return [o for o in alle_kandidaten if o == wurzel or o.startswith(wurzel + "/")]

    # Regeln, die den Bereich festlegen: Personalakte der erkannten Person, sonst eine eindeutige
    # INT-Nummer im Dateinamen. Hat der Bereich nur einen Kandidaten, ist der Ordner entschieden.
    regel: str | None = None
    regel_art: str | None = None
    name_int = int_nummern(dateiname)
    int_ziele = sorted({o for nr in name_int for o in m.int_ordner.get(nr, ())})
    bereich: list[str] = []
    if person:
        akten = personen_akte(m, person)
        if len(akten) == 1:
            bereich, regel_art = teilbaum(akten[0]), "person"
    if not bereich and len(int_ziele) == 1:
        bereich, regel_art = teilbaum(int_ziele[0]), "int"
    if bereich:
        kandidaten_menge = bereich
        if len(bereich) == 1:
            regel = bereich[0]
    else:
        regel_art = None

    menge = set(kandidaten_menge)
    alle_menge = set(alle_kandidaten)
    # Stimmen der Nachbarn in allen Kandidaten-Ordnern (auch ausserhalb eines Regel-Bereichs: die
    # Akte einer anderen Person gibt über den gleichnamigen Unterordner die Dokumentart vor).
    stimmen: dict[str, float] = defaultdict(float)
    namen_je_ordner: dict[str, list[str]] = defaultdict(list)
    smax = max((n.aehnlichkeit for n in nachbarn), default=0.0)
    for n in nachbarn:
        o = nfc(n.ordner)
        if o not in alle_menge:
            continue
        stimmen[o] += math.exp((n.aehnlichkeit - smax) / TAU)
        if len(namen_je_ordner[o]) < MAX_NACHBAR_NAMEN:
            namen_je_ordner[o].append(n.name)
    summe = sum(stimmen.values()) or 1.0
    stimmen = {o: s / summe for o, s in stimmen.items()}
    struktur: dict[str, float] = defaultdict(float)
    for o, s in stimmen.items():
        teile = o.split("/")
        if len(teile) >= 3:
            for o2 in m.gleichnamig.get((teile[0], len(teile), generisch(teile[-1])), ()):
                if o2 != o and o2 in menge:
                    struktur[o2] += s * STRUKTUR
    kat_masse: dict[str, float] = defaultdict(float)
    for o, s in stimmen.items():
        kat_masse[kategorie(o)] += s

    dok = set(woerter(lesbarer_name(dateiname) + " " + (text or "")))
    praefixe = _praefixe(dok)
    # Hinweise (Zuschlag, kein Entscheid): «INT-…» im Text und die blosse Form «26-014» im Dateinamen.
    text_int = {mm.groups() for mm in INT_IM_TEXT.finditer(text or "")} | nummern_form(dateiname)

    punkte: dict[str, float] = {}
    namen_punkte: dict[str, float] = {}
    quellen: dict[str, set[str]] = defaultdict(set)
    # Regel-Bereich erkannt: jeder Kandidat darin bekommt einen Sockel, damit auch Unterordner ohne eigene
    # Punkte (Scan ohne Text, Offerte neben 02_Vertraege) in der Rangliste stehen — das Modell wählt.
    sockel = SOCKEL_REGEL if bereich else 0.0
    for o in kandidaten_menge:
        p = sockel + stimmen.get(o, 0.0) + struktur.get(o, 0.0) + KATEGORIE * kat_masse.get(kategorie(o), 0.0)
        if stimmen.get(o):
            quellen[o].add("knn")
        if struktur.get(o):
            quellen[o].add("struktur")
        lex = sum(w for t, w in m.pfad_woerter.get(o, ()) if _passt(t, dok, praefixe))
        emb = 0.0
        if doc_vektor is not None and o in ordner_vektoren:
            emb = max(0.0, sum(a * b for a, b in zip(doc_vektor, ordner_vektoren[o])) - EINBETTUNG_SCHWELLE)
        if lex or emb:
            quellen[o].add("name")
        n = LEXIK * lex + EINBETTUNG * emb
        p += n
        if typ_passt(typ, o.split("/")[-1]):
            p *= TYP_FAKTOR
            n *= TYP_FAKTOR
        punkte[o] = p
        namen_punkte[o] = n

    # Mehrdeutige INT-Nummer im Dateinamen (zwei Ordner tragen sie): alle vorne, das Modell wählt.
    # «INT-…» im Text und «26-014» ohne INT im Dateinamen: Zuschlag statt Entscheid (kann ein anderes
    # Projekt meinen — oder eine Lieferantennummer sein).
    if len(int_ziele) > 1:
        for wurzel in int_ziele:
            for o in teilbaum(wurzel):
                punkte[o] = punkte.get(o, 0.0) + REGEL
                quellen[o].add("regel")
    for nr in text_int:
        for wurzel in m.int_ordner.get(nr, ()):
            for o in teilbaum(wurzel):
                if o in menge:
                    punkte[o] = punkte.get(o, 0.0) + TEXT_INT
                    quellen[o].add("regel")
    if regel is not None:
        punkte[regel] = punkte.get(regel, 0.0) + REGEL
        quellen[regel].add("regel")
    elif regel_art:
        for o in kandidaten_menge:
            quellen[o].add("regel")

    # Zwei Listen im Wechsel: Gesamtpunkte (Vorbilder + Namen + Regeln) und Ordnernamen allein in den
    # Kategorien, die die Vorbilder tragen. So steht neben dem Ordner des ähnlichsten Vorbilds auch der
    # Ordner, dessen Name im Dokument steht (Projekt ohne eigenes Vorbild) — das Modell wählt.
    gesamt = sorted((o for o, p in punkte.items() if p > 0), key=lambda o: (-punkte[o], o))
    bereich_masse: dict[str, float] = defaultdict(float)
    for o, s in stimmen.items():
        bereich_masse[_praefix(o, NAMEN_BEREICH_TIEFE)] += s
    bereiche: set[str] | None = None
    if not regel_art and bereich_masse:
        bereiche = {b for b, v in bereich_masse.items() if v >= KATEGORIE_SCHWELLE} or {max(bereich_masse, key=bereich_masse.get)}
    nur_namen = sorted(
        (o for o, n in namen_punkte.items() if n > 0 and (bereiche is None or _praefix(o, NAMEN_BEREICH_TIEFE) in bereiche)),
        key=lambda o: (-namen_punkte[o], o),
    )
    rang = mische(gesamt, nur_namen)
    regel_menge = set(bereich) | ({o for wurzel in int_ziele for o in teilbaum(wurzel)} if len(int_ziele) > 1 else set())
    kandidaten = [
        Kandidat(
            pfad=m.original[o], punkte=round(punkte[o], 4), quellen=set(quellen[o]), nachbarn=list(namen_je_ordner.get(o, [])),
            regel_bereich=o in regel_menge,
        )
        for o in rang
    ]
    return Rangliste(
        kandidaten=kandidaten,
        regel=m.original[regel] if regel else None,
        regel_art=regel_art,
        staerkste_aehnlichkeit=round(smax, 4),
    )
