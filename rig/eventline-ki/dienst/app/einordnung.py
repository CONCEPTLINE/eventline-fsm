"""V8 «Ablage-Entscheid durch Claude» — Rig-Seite (SPEC §3.1, Absatz V8).

Das Rig liefert zusätzlich zu den bisherigen Feldern (die als lokale Wahl/Rückfall unverändert bleiben):
- `einordnung`: präzise, MINIMIERTE Beschreibung des Dokuments (was, typ, betreff, partei, bezug, jahr,
  personenbezogen, sprache, seiten) — sie geht über das FSM an Claude, darum ohne Personennamen, Beträge,
  Kontaktdaten, Konto-/AHV-Nummern. Die Felder kommen aus demselben Modellaufruf wie Stufe 1 (kein zweiter
  Aufruf) und werden hier deterministisch geprüft und minimiert; das FSM minimiert nochmals
  (src/lib/ki/ablage-entscheid.ts, minimiereText) — Verteidigung in der Tiefe.
- `kandidaten`: bis 8 Ordner aus der Rangliste der Ordnerwahl, beste zuerst, Gewicht 0..1 (bester 1.0).
- `regel_ordner`: Pfad, wenn eine verbindliche Regel entscheidet (INT-Nummer mit «INT» im Dateinamen →
  Projektordner, eindeutige Personalakte), sonst null.

Hier ist alles rein (ohne Modell, ohne DB) und damit testbar (tests/test_einordnung.py).
"""

from __future__ import annotations

import re
import unicodedata
from datetime import date
from functools import lru_cache
from itertools import permutations
from typing import Any, Iterable

from .handlers import datum_gueltig, text_kurz
from .ordnerwahl import Rangliste, falte

PLATZHALTER = "[…]"
MITARBEITER_PLATZHALTER = "[Mitarbeiter/in]"

MAX_KANDIDATEN = 8  # = KI_ENTSCHEID_MAX_KANDIDATEN im FSM
MAX_WAS = 300  # FSM kappt bei 400 (KI_EINORDNUNG_WAS_MAX)
MAX_BETREFF = 80
MAX_PARTEI = 120
MAX_BEZUG_NAME = 80
BEZUG_ARTEN = ("location", "projekt", "kunde", "partner", "firma", "person")
PARTEI_ARTEN = ("organisation", "person")
# Wie KI_PERSON_TYPEN im FSM — gilt, wenn der Kontext kein `person`-Flag je Typ mitschickt (Probelauf, älteres FSM).
PERSONEN_TYPEN_STANDARD = frozenset({"lohnabrechnung", "behoerde", "zertifikat"})

# --- Minimierung (Spiegel von minimiereText im FSM) -------------------------------------------------------
# Reihenfolge: Kontakte und Kennungen vor Beträgen vor nackten langen Zahlen (sonst zerlegt die Zahlen-Regel
# eine IBAN in Reste, die nicht mehr erkannt werden).

_BUCHSTABE = r"[^\W\d_]"  # \p{L}
_WORTZEICHEN = r"[^\W_]"  # \p{L}\p{N}
RE_EMAIL = re.compile(r"[\w.%+-]+@[\w.-]+\." + _BUCHSTABE + "{2,}")
RE_IBAN = re.compile(r"\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b")
RE_AHV = re.compile(r"\b756[.\s]?\d{4}[.\s]?\d{4}[.\s]?\d{2}\b")
RE_TEL_INT = re.compile(r"(?:\+|\b00)\d{2,3}[\s\-/.]?(?:\(0\)[\s\-/.]?)?\d(?:[\s\-/.]?\d){6,11}\b")
RE_TEL_CH = re.compile(r"\b0\d{2}[\s\-/.]?\d{3}[\s\-/.]?\d{2}[\s\-/.]?\d{2}\b")
_ZAHL = r"\d(?:[\d'’]|[.,](?=\d)|\s(?=\d{3}(?!\d)))*(?:\.?\s?[-–])?"
_WAEHRUNG_VOR = r"(?:CHF|EUR|s?Fr\.?|Rp\.?|€)"
_WAEHRUNG_NACH = r"(?:CHF|EUR|s?Fr\.?|Rp\.?|Franken|Euro|Rappen|€)"
RE_BETRAG_VOR = re.compile(rf"(?<!{_BUCHSTABE}){_WAEHRUNG_VOR}\s?-?{_ZAHL}", re.I)
RE_BETRAG_NACH = re.compile(rf"{_ZAHL}\s?{_WAEHRUNG_NACH}(?!{_BUCHSTABE})", re.I)
RE_LANGE_ZAHL = re.compile(r"\b\d{1,3}(?:['’]\d{3})+(?!\d)(?:[.,]\d+)?(?:\.?\s?[-–])?|\d{6,}")
# Review V8 (2026-10-11), nur auf dem Rig — das FSM spiegelt diese Muster (noch) nicht:
# Postkonto 12-3456-7.
RE_POSTKONTO = re.compile(r"\b\d{2}-\d{3,6}-\d\b")
# Betrag ohne Währung: 980.50, 1250,00, 4500.– — nicht Datum «11.10.», Uhrzeit «14.30 Uhr», Mass «12.00 m», «2.50 %».
RE_BETRAG_NACKT = re.compile(
    r"(?<![\d.,'’])(?!(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])\.)\d+(?:[.,]\d{2}|\.\s?[-–])(?!\d|[.,]\d)(?!\s?(?:Uhr|h|m|cm|mm|m2|m²|m³|kg|t|x|×|%)(?![^\W\d_]))"
)
# Zahl nach einem Betragswort: «Pauschale 4500», «Total: 1250», «Kosten von 800» — nicht ein Jahr («Budget 2027»).
RE_BETRAG_WORT = re.compile(
    r"(\b(?:Total|Pauschale|Pauschal|Betrag|Gesamtbetrag|Restbetrag|Summe|Preis|Kosten|Honorar|Gage|Budget|Miete|"
    r"Anzahlung|Rabatt)\s*(?:von|über|ueber|:|=)?\s*)(?!(?:19|20)\d\d\b(?![.,'’]\d))\d[\d'’]*(?:[.,]\d+)?(?:\.?\s?[-–])?",
    re.I,
)
# Postadresse: Strasse/Weg/Gasse/Platz … + Hausnummer; «Rue/Route/Via … 12».
RE_STRASSE = re.compile(
    r"\b[A-ZÄÖÜ][\w'’.-]*?(?i:strasse|straße|str\.|gasse|weg|platz|allee|ring|graben|rain|halde|vorstadt|matte)"
    r"\s+\d{1,4}[a-zA-Z]?\b"
    r"|\b(?:Rue|Route|Avenue|Chemin|Via|Place|Quai)\s+[^\W\d_][\w'’ -]{1,30}?\s+\d{1,4}[a-zA-Z]?\b"
)
# PLZ + Ort: «4051 Basel», «CH-4051 Basel», «D-79539 Lörrach» — nicht Jahreszahlen («2026 Basel») und nicht Mengen
# («1500 Gäste», «1200 Stühle»: Zahl + Mengenwort bleibt, die Beschreibung braucht sie).
_MENGENWORT = (
    r"(?:Gäst|Gaest|Person|Besucher|Teilnehm|Plätz|Plaetz|Sitzpl|Stehpl|Stühl|Stuehl|Tisch|Stück|Stueck|Exemplar|"
    r"Mitarbeit|Leute|Gedeck|Portion|Pax|Seite|Stunde|Tage?\b|Minute|Quadratmeter|Meter|Liter|Flasche|"
    r"Kiste|Palett|Artikel|Position|Einheit|Ticket|Karte|Badge|Armb|Kilo|Gramm|"
    # Ortsnamen mit gleichem Anfang (Bettingen, Zimmerwald, Wattwil) bleiben PLZ + Ort — darum nur ganze Wörter:
    r"Betten?\b|Zimmer\b|Watt\b|Kilowatt\b)"
)
RE_PLZ_ORT = re.compile(
    r"(?:\b(?:CH|D|DE|F|FR)-\d{4,5}|(?<![\d.,'’-])(?!(?:19|20)\d\d\b)[1-9]\d{3,4})\s+(?!(?i:" + _MENGENWORT + r"))"
    r"[A-ZÄÖÜ][^\W\d_]+(?:-[A-ZÄÖÜ][^\W\d_]+)?"
)
# Anrede + Name (1–2 grossgeschriebene Wörter, optional Dr./Prof.): «Herrn Näf», «Frau Anna Keller».
RE_ANREDE = re.compile(
    r"\b((?i:Herrn?|Frau|Hr\.|Fr\.))\s+((?:(?:Dr|Prof)\.\s+)?[A-ZÄÖÜ][\w'’-]*(?:\s+[A-ZÄÖÜ][\w'’-]*)?)"
)
RE_PLATZHALTER_DOPPELT = re.compile(r"\[…\](?:\s*[,;:/–-]?\s*\[…\])+")
# Trenner zwischen Namensteilen: Leerzeichen, Unterstrich (Dateinamen-Stil) oder Komma («Näf, Tim»).
_NAMENS_TRENNER = r"(?:\s*,\s*|[\s_]+)"
MAX_TEILE_PERMUTATION = 4  # bis 4 Teile jede Reihenfolge (24), darüber nur Rotationen


def _reihenfolgen(teile: list[str]) -> Iterable[tuple[str, ...]]:
    if len(teile) <= MAX_TEILE_PERMUTATION:
        return permutations(teile)
    return (tuple(teile[k:] + teile[:k]) for k in range(len(teile)))


@lru_cache(maxsize=8)
def _namens_regex(namen: tuple[str, ...]) -> re.Pattern[str] | None:
    """Ein Ausdruck für alle Namen: jede Reihenfolge der Namensteile, Gross/Klein egal, auch mit gefalteten
    Umlauten (Näf = Naef); Namen unter 3 Zeichen zählen nicht (wie im FSM)."""
    varianten: set[str] = set()
    for name in namen:
        # NFC wie nameRegex im FSM: ein zerlegt gespeicherter Name (NFD, z. B. von macOS) trifft sonst nie.
        n = re.sub(r"\s+", " ", unicodedata.normalize("NFC", text_kurz(name, 200))).strip()
        if len(n) < 3:
            continue
        teile = n.split(" ")
        for form in {tuple(teile), tuple(falte(t) for t in teile)}:
            for folge in _reihenfolgen(list(form)):
                varianten.add(_NAMENS_TRENNER.join(re.escape(t) for t in folge))
    if not varianten:
        return None
    alternativen = "|".join(sorted(varianten, key=lambda v: (-len(v), v)))
    return re.compile(rf"(?<!{_WORTZEICHEN})(?:{alternativen})(?!{_WORTZEICHEN})", re.I)


@lru_cache(maxsize=8)
def _namensteile(namen: tuple[str, ...]) -> frozenset[str]:
    """Einzelne Namensteile (≥ 3 Zeichen, gefaltet) aller Profile — für «Anrede + Name»."""
    teile: set[str] = set()
    for name in namen:
        for t in re.split(r"[\s,_]+", unicodedata.normalize("NFC", text_kurz(name, 200))):
            if len(t) >= 3:
                teile.add(falte(t))
    return frozenset(teile)


def minimiere_text(text: str, namen: Iterable[str] = ()) -> str:
    """Beträge (mit Währung, nach einem Betragswort oder mit zwei Dezimalen/«.–»), Zahlen mit Apostroph-
    Tausendertrenner, IBAN, Postkonto, AHV 756.…, E-Mail, Telefon, Strasse + Hausnummer, PLZ + Ort und
    6+-stellige Zahlen → «[…]»; Namen (alle Profile) in jeder Reihenfolge → «[Mitarbeiter/in]»; ein Name nach
    einer Anrede (Herr/Herrn/Frau/Hr./Fr.) → «Anrede […]», bzw. «Anrede [Mitarbeiter/in]», wenn ein Teil zu
    einem Profilnamen gehört."""
    t = text_kurz(text, 10_000) if isinstance(text, str) else ""
    if not t:
        return ""
    t = unicodedata.normalize("NFC", t)
    for muster in (RE_EMAIL, RE_IBAN, RE_POSTKONTO, RE_AHV, RE_TEL_INT, RE_TEL_CH, RE_STRASSE, RE_BETRAG_VOR,
                   RE_BETRAG_NACH, RE_LANGE_ZAHL, RE_BETRAG_NACKT):
        t = muster.sub(PLATZHALTER, t)
    t = RE_BETRAG_WORT.sub(lambda m: m.group(1) + PLATZHALTER, t)
    t = RE_PLZ_ORT.sub(PLATZHALTER, t)
    namen_t = tuple(sorted({n for n in namen if isinstance(n, str) and n.strip()}))
    namen_re = _namens_regex(namen_t)
    if namen_re is not None:
        t = namen_re.sub(MITARBEITER_PLATZHALTER, t)
    teile = _namensteile(namen_t)

    def anrede(m: re.Match[str]) -> str:
        profil = any(falte(w) in teile for w in re.split(r"\s+", m.group(2)) if len(w) >= 3)
        return f"{m.group(1)} {MITARBEITER_PLATZHALTER if profil else PLATZHALTER}"

    t = RE_ANREDE.sub(anrede, t)
    t = RE_PLATZHALTER_DOPPELT.sub(PLATZHALTER, t)
    return re.sub(r"\s+", " ", t).strip()


def kuerze_auf_wort(s: str, n: int) -> str:
    """Auf höchstens n Zeichen, an einer Wortgrenze (kein halbes Wort)."""
    if len(s) <= n:
        return s
    schnitt = s[:n]
    i = schnitt.rfind(" ")
    return (schnitt[:i] if i >= n // 2 else schnitt).rstrip(" ,;:-–")


# --- Sprache (deterministisch, ohne Modell) ----------------------------------------------------------------

_SPRACH_WOERTER = {
    "de": frozenset("der die das und ist nicht mit für auf den dem des ein eine einer zu von im sich auch bei wir sie werden wird oder".split()),
    "fr": frozenset("le les et est des une pour dans que pas sur avec du au nous vous sont par ce cette aux".split()),
    "it": frozenset("il lo gli e è di che per una non con del della sono nel alla dei delle questo".split()),
    "en": frozenset("the and is of to in for with that this are be on not you your will from by as".split()),
}
MIN_SPRACH_TREFFER = 8


def erkenne_sprache(text: str) -> str | None:
    """Sprache aus häufigen Funktionswörtern (de/fr/it/en); zu wenig Text oder knapp = null."""
    woerter = re.findall(r"[^\W\d_]+", (text or "")[:6000].lower())
    if not woerter:
        return None
    zaehler = {s: sum(1 for w in woerter if w in menge) for s, menge in _SPRACH_WOERTER.items()}
    reihe = sorted(zaehler.items(), key=lambda kv: -kv[1])
    (beste, n1), (_, n2) = reihe[0], reihe[1]
    if n1 < MIN_SPRACH_TREFFER or n1 < 1.5 * n2:
        return None
    return beste


# --- Einordnung ----------------------------------------------------------------------------------------------


def _jahr(dok_datum: str | None, roh: object, heute: str) -> str | None:
    """Jahr des Dokuments (dok_datum) zuerst, sonst die Angabe des Modells — nur YYYY in plausiblem Rahmen."""
    if dok_datum:
        return dok_datum[:4]
    s = text_kurz(roh, 10) if isinstance(roh, str) else (str(roh) if isinstance(roh, int) and not isinstance(roh, bool) else "")
    if not re.fullmatch(r"\d{4}", s):
        return None
    try:
        obergrenze = date.fromisoformat(heute).year + 5
    except ValueError:
        obergrenze = 2100
    return s if 1990 <= int(s) <= obergrenze else None


def baue_einordnung(
    roh: dict[str, Any],
    *,
    namen: Iterable[str],
    typ: str,
    typ_label: str,
    person: str | None,
    betreff: str,
    partei: str | None,
    dok_datum: str | None,
    heute: str,
    seiten: int | None,
    text: str,
    foto: bool,
    personen_typen: frozenset[str] | None,
    regel_person: bool = False,
    personal_ordner: bool = False,
) -> dict[str, Any]:
    """`einordnung` aus der Antwort der Stufe 1 (Felder was, bezug_art, bezug_name, partei_art, jahr,
    personenbezogen) plus den bereits geprüften Feldern (typ, person, betreff, partei, dok_datum).

    - was: minimiert; fehlt es, «Typ – Betreff» (das FSM verwirft eine Einordnung ohne was).
    - partei: nur Organisationen (partei_art «organisation»), nie bei personenbezogenen Dokumenten.
    - bezug.art = person → bezug.name null; ein Name, der zu einem Profil gehört, fällt weg.
    - personenbezogen: Angabe des Modells ODER erkannte Person ODER Bezug «person» ODER personenbezogener Typ
      ODER Personalakten-Regel ODER (Review V8) ein Profilname in was/betreff/partei/bezug_name des
      Modells (nach der Minimierung «[Mitarbeiter/in]») ODER ein Personal-Ordner in der Rangliste
      (`personal_ordner`, s. personal_hinweis) — im Zweifel geht nichts hinaus. Grund: bei Typ «vertrag»
      (Arbeitsvertrag) setzt das FSM keine Person, die Personalakten-Regel greift dann nicht, und Claude
      sähe den Baum ohne Personalakten.
    """
    namen = tuple(namen)

    def mini(s: object, n: int) -> str:
        return kuerze_auf_wort(minimiere_text(s if isinstance(s, str) else "", namen), n)

    def profilname(s: object) -> bool:
        return isinstance(s, str) and MITARBEITER_PLATZHALTER in minimiere_text(s, namen)

    art_roh = text_kurz(roh.get("bezug_art"), 20).lower()
    art = art_roh if art_roh in BEZUG_ARTEN else None
    typen = personen_typen if personen_typen is not None else PERSONEN_TYPEN_STANDARD
    betreff_aus = mini(betreff, MAX_BETREFF)
    was = mini(roh.get("was"), MAX_WAS)
    personenbezogen = (
        roh.get("personenbezogen") is True
        or person is not None
        or art == "person"
        or typ in typen
        or regel_person
        or personal_ordner
        or MITARBEITER_PLATZHALTER in was
        or MITARBEITER_PLATZHALTER in betreff_aus
        # Nicht das rohe Feld `person` des Modells: mit Mitarbeiterliste im Prompt trägt gemma3:4b dort fast immer
        # einen Namen ein (gemessen 2026-10-11: 12 von 12 Location-Dokumenten) — das machte 56 von 63 Dokumenten
        # «personenbezogen». Die geprüfte Person (`person`, nur bei Personen-Typen) zählt oben.
        or any(profilname(s) for s in (partei, roh.get("bezug_name")))
    )

    bezug_name: str | None = None
    if art is not None and art not in ("person", "firma"):
        bezug_name = mini(roh.get("bezug_name"), MAX_BEZUG_NAME) or None
        if bezug_name and (MITARBEITER_PLATZHALTER in bezug_name or bezug_name == PLATZHALTER):
            bezug_name = None

    partei_aus: str | None = None
    if partei and not personenbezogen and text_kurz(roh.get("partei_art"), 20).lower() == "organisation":
        partei_aus = mini(partei, MAX_PARTEI) or None
        if partei_aus and (MITARBEITER_PLATZHALTER in partei_aus or partei_aus == PLATZHALTER):
            partei_aus = None

    if not was or was == PLATZHALTER:
        was = " – ".join(t for t in (typ_label, betreff_aus) if t) or typ_label or typ

    return {
        "was": was,
        "typ": typ,
        "betreff": betreff_aus,
        "partei": partei_aus,
        "bezug": {"art": art, "name": bezug_name},
        "jahr": _jahr(datum_gueltig(dok_datum), roh.get("jahr"), heute),
        "personenbezogen": bool(personenbezogen),
        "sprache": None if foto else erkenne_sprache(text),
        "seiten": seiten if isinstance(seiten, int) and not isinstance(seiten, bool) and seiten > 0 else None,
    }


# --- Kandidaten + Regel ----------------------------------------------------------------------------------------


def kandidaten_v8(rl: Rangliste | None, erlaubt: Iterable[str]) -> list[dict[str, Any]]:
    """Bis MAX_KANDIDATEN Ordner der Rangliste (Reihenfolge der Rangliste = beste zuerst), nur Pfade der Liste,
    ohne Doppel. Gewicht = Punkte relativ zum ersten (1.0), nie steigend (die Rangliste mischt Gesamtpunkte und
    Ordnernamen im Wechsel), zwei Nachkommastellen, mindestens 0.01. Quelle «regel» = Kandidat aus einem
    erkannten Regel-Bereich (INT-Projekt aus dem Dateinamen, Personalakte), sonst «vorbild»."""
    if rl is None or not rl.kandidaten:
        return []
    liste = set(erlaubt)
    aus: list[dict[str, Any]] = []
    gesehen: set[str] = set()
    oben = max(rl.kandidaten[0].punkte, 1e-9)
    vorher = 1.0
    for k in rl.kandidaten:
        if len(aus) >= MAX_KANDIDATEN:
            break
        if k.pfad in gesehen or k.pfad not in liste:
            continue
        gesehen.add(k.pfad)
        g = 1.0 if not aus else min(vorher, max(0.01, round(min(1.0, k.punkte / oben), 2)))
        vorher = g
        aus.append({"pfad": k.pfad, "quelle": "regel" if k.regel_bereich else "vorbild", "gewicht": g})
    return aus


def unter_personal(pfad: str | None) -> bool:
    """Liegt der Pfad unter einer Personal-Freigabe (erste Ebene mit «personal», z. B. 06_PERSONAL)? Gleiche
    Wurzel-Erkennung wie die Personalakten in ordnerwahl.personen_akte."""
    return bool(pfad) and "personal" in falte(str(pfad).split("/", 1)[0])


def personal_hinweis(rl: Rangliste | None, gewaehlt: str | None = None) -> bool:
    """Personal-Ordner im Spiel: bester Kandidat der Rangliste, ein Kandidat aus einem Regel-Bereich oder der
    lokal gewählte Ordner liegt unter einer Personal-Freigabe → die Einordnung gilt als personenbezogen."""
    if unter_personal(gewaehlt):
        return True
    if rl is None or not rl.kandidaten:
        return False
    return unter_personal(rl.kandidaten[0].pfad) or any(k.regel_bereich and unter_personal(k.pfad) for k in rl.kandidaten)


def regel_ordner_v8(rl: Rangliste | None, erlaubt: Iterable[str]) -> str | None:
    """Pfad, wenn eine verbindliche Regel entschieden hat (INT mit «INT» im Dateinamen → Projektordner;
    eindeutige Personalakte ohne Unterordner) — sonst null. Nie ausserhalb der Liste."""
    if rl is None or not rl.regel:
        return None
    return rl.regel if rl.regel in set(erlaubt) else None
