"""Rückstau ZZ, Rezept zz/v3 (15.10.2026): Fakten-Lieferant für den Claude-Entscheid im FSM — NICHT der Entscheider.

Architektur «Stärken verteilen» (Mischa 15.10.): die lokale KI beschreibt das Dokument (gefiltert, jobs/zz.py), diese
Regeln liefern nachprüfbare Fakten-Hinweise (erkannte Person + ob ihre Personalakte existiert, Location/Partner mit
eigenem Ordner, Entwurf ja/nein, Datum aus dem Namen, ein Regel-Ziel und ein Regel-Name als HINWEIS), Claude im FSM
entscheidet Zielordner, neuen Ordner und Dateinamen, ein Mensch gibt frei. Die Begriffe «Entscheid»/«Ziel» unten
meinen den Hinweis an Claude.

Befund (Mischa 15.10.): «Beilage zum Arbeitsvertrag – Techniker <Person>.pdf» aus ZZ/…/2025-Personal/<Person> ging nach
02_LOCATIONS/…SCALA…/01_Entwuerfe («wahrscheinlich»). Ursachen: (1) die Personen-Regel der Ordnerwahl griff nur, wenn das
Sprachmodell eine AKTIVE Person aus der Mitarbeiterliste setzte und der Typ laut FSM eine Person kennt («vertrag» nicht);
(2) der bisherige Ablageort in ZZ («…/2025-Personal/<Person>») und der Dateiname wurden für die Ordnerwahl nicht genutzt;
(3) ohne Regel entschieden Vorbild-Ähnlichkeiten — und «Entwürfe»-Ordner mit vielen Fassungen wurden Sammelbecken.

Hier, alles deterministisch und ohne Modellaufruf:
1. erkenne(): Dokumentart (Schlüsselwörter in Dateiname/Herkunft, sonst der Typ der Stufe 1), betroffene Person
   (Namen der Personalakten, aller Profile und der Personen-Ordner der Herkunft — nur wenn im Dateinamen/Herkunft
   belegt, im Text nur bei Personendokumenten und eindeutig), Location/Partner/Kunde mit eigenem Ordner (im Namen/
   in der Herkunft = stark; im Text nur eindeutig, nie bei Listen/Exporten), Entwurf ja/nein, Datum, Titel.
2. regel_ziel(): Personendokument + Personalakte → Unterordner nach Dokumentart; Personendokument ohne Akte → Personal-
   Bereich ohne fremde Akten; Location/Partner/Kunde → dort, Unterordner nach Dokumentart. «Entwürfe» nur bei Entwurf.
   «wahrscheinlich» (hoch) nur bei klarer Regel: Person/Partei aus Name/Herkunft eindeutig + passender Unterordner.
3. name_vorschlag(): neuer Dateiname nach den Namen im Zielordner (Trenner, Datumsform), sonst Standard
   `YYYY-MM-DD_Dokumentart_Partei-oder-Person_Titel.ext`. Nie Inhaltsdetails (Beträge, IBAN/Konto, AHV, Ausweis-,
   Policen-, Telefonnummern, Adressen, Gesundheits-/Kündigungsgründe) — inhalt_frei() verwirft solche Teile.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import date
from typing import Iterable, Sequence

from .archiv import nfc, unter_zz

_FALTUNG = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss", "é": "e", "è": "e", "ê": "e", "à": "a", "â": "a",
                          "ç": "c", "ô": "o", "î": "i", "ï": "i", "ë": "e", "ñ": "n", "ć": "c", "č": "c", "š": "s", "ž": "z"})
_NUMMER_PRAEFIX = re.compile(r"^\d+[_\- ]+")


def falte(s: str) -> str:
    return nfc(s or "").lower().translate(_FALTUNG)


def woerter(s: str) -> list[str]:
    return [t for t in re.split(r"[^a-z0-9]+", falte(s)) if t]


def _ohne_endung(name: str) -> tuple[str, str]:
    m = re.search(r"(\.[A-Za-z0-9]{1,8})$", name or "")
    return ((name[: m.start()], m.group(1)) if m else (name or "", ""))


# --- Dokumentarten ----------------------------------------------------------------------------------------------
# key, Bezeichnung (für Namen/Begründung), Schlüsselwort-Stämme (gefaltet, Wortanfang), Personendokument?,
# Stämme des Unterordners in einer Personalakte, Stämme des Unterordners bei Location/Partner/Kunde.


@dataclass(frozen=True)
class Dokart:
    key: str
    label: str
    stamm: tuple[str, ...]
    person: bool
    akte: tuple[str, ...] = ()
    entitaet: tuple[str, ...] = ()


DOKARTEN: tuple[Dokart, ...] = (
    Dokart("vertragsbeilage", "Vertragsbeilage", (), True, ("vertraege_anstellung", "vertr"), ("vertr",)),
    Dokart("arbeitsvertrag", "Arbeitsvertrag", ("arbeitsvertrag", "anstellungsvertrag", "arbeitsverhaeltnis",
                                                 "anstellungsbestaetigung", "stellenantritt"), True,
           ("vertraege_anstellung", "vertr")),
    Dokart("kuendigung", "Kündigung", ("kuendigung", "aufloesungsvereinbarung"), True, ("vertraege_anstellung", "vertr"),
           ("vertr",)),
    Dokart("lohnabrechnung", "Lohnabrechnung", ("lohnabrechnung", "stundenabrechnung", "lohnausweis", "lohnblatt", "lohnzettel",
                                                 "gehaltsabrechnung", "salaerabrechnung", "lohnbeleg"), True,
           ("korrespondenz_sonstig", "sonstig")),
    Dokart("bewerbung", "Bewerbung", ("bewerbung", "lebenslauf", "motivationsschreiben", "cv"), True,
           ("bewerbungsunterlagen", "bewerbung")),
    Dokart("ausweis", "Ausweis", ("ausweis", "reisepass", "identitaetskarte", "aufenthaltsbewilligung",
                                   "arbeitsbewilligung", "grenzgaenger", "niederlassungsbewilligung"), True,
           ("identitaetsnachweis",)),
    Dokart("arbeitszeugnis", "Arbeitszeugnis", ("arbeitszeugnis", "zwischenzeugnis", "arbeitsbestaetigung",
                                                 "referenzschreiben"), True, ("arbeitszeugnis", "zeugnis")),
    Dokart("ausbildung", "Ausbildungsnachweis", ("diplom", "faehigkeitszeugnis", "lehrabschluss", "ausbildungsnachweis",
                                                 "abschlusszeugnis"), True, ("ausbildungsnachweis",)),
    Dokart("zertifikat", "Zertifikat", ("zertifikat", "kursbestaetigung", "teilnahmebestaetigung", "schulungsnachweis",
                                         "certificate"), False, ("schulungen_zertifikat", "zertifikat"),
           ("zertifikat", "nachweis")),
    Dokart("mitarbeitergespraech", "Mitarbeitergespräch", ("mitarbeitergespraech", "jahresgespraech",
                                                           "mitarbeiterbeurteilung"), True, ("mitarbeitergespraech",)),
    Dokart("einwilligung", "Einwilligung", ("einwilligung", "einverstaendniserklaerung"), False,
           ("einwilligung_datenschutz", "einwilligung")),
    Dokart("vertrag", "Vertrag", ("vertrag", "vereinbarung", "agreement", "contract", "rahmenvertrag", "mietvertrag",
                                   "verwaltungsvertrag"), False, ("vertraege_anstellung", "vertr"), ("vertr",)),
    Dokart("offerte", "Offerte", ("offerte", "angebot", "kostenvoranschlag", "quote"), False, (),
           ("offert", "konditionen")),
    Dokart("rechnung", "Rechnung", ("rechnung", "invoice", "faktura", "quittung", "gutschrift"), False, (),
           ("rechn", "buchhalt")),
    Dokart("mahnung", "Mahnung", ("mahnung", "zahlungserinnerung"), False, (), ("rechn",)),
    Dokart("protokoll", "Protokoll", ("protokoll", "traktanden", "sitzungsnotiz"), False, (), ("protok",)),
    Dokart("statuten", "Statuten", ("statuten", "reglement"), False, (), ("statut",)),
    Dokart("versicherung", "Versicherung", ("police", "versicherung"), False, ("versicherungen_persoenlich", "versich"),
           ("versich",)),
    Dokart("plan", "Plan", ("grundriss", "situationsplan", "bestuhlungsplan", "lageplan", "plan"), False, (),
           ("plaene", "grundriss")),
    Dokart("bewilligung", "Bewilligung", ("bewilligung", "gesuch", "genehmigung"), False, (), ("bewillig",)),
    Dokart("hausregeln", "Hausordnung", ("hausordnung", "hausregeln", "sop", "ablauf"), False, (),
           ("hausregel", "sop", "ablaeufe")),
    Dokart("praesentation", "Präsentation", ("praesentation", "presentation", "pitch", "deck"), False, (),
           ("praesent", "marketing")),
    Dokart("liste", "Liste", ("liste", "export", "leads", "uebersicht", "inventar"), False, (), ("liste",)),
    Dokart("rapport", "Rapport", ("rapport", "timesheet", "stundenzettel", "arbeitsrapport"), False, (), ("rapport",)),
    Dokart("korrespondenz", "Korrespondenz", ("brief", "schreiben", "korrespondenz", "mitteilung"), False,
           ("korrespondenz_sonstig", "korresp"), ("korresp",)),
)
DOKART = {d.key: d for d in DOKARTEN}
# Typ der Stufe 1 (FSM-Dokumenttypen) → Dokumentart, wenn Name/Herkunft nichts sagen.
_TYP_ZU_DOKART = {
    "vertrag": "vertrag", "rechnung": "rechnung", "offerte": "offerte", "kuendigung": "kuendigung",
    "korrespondenz": "korrespondenz", "protokoll": "protokoll", "lohnabrechnung": "lohnabrechnung",
    "versicherungspolice": "versicherung", "zertifikat": "zertifikat", "mahnung": "mahnung", "behoerde": "bewilligung",
}
_LISTEN_ENDUNGEN = {".csv", ".xls", ".xlsx", ".numbers", ".ods", ".json", ".tsv"}
_BILD_ENDUNGEN = {".jpg", ".jpeg", ".png", ".heic", ".gif", ".webp", ".tif", ".tiff"}
_ENTWURF = re.compile(r"(?<![a-z])(entwurf|entwuerfe|draft|wip|zur_?pruefung|korrekturlesung)")
_BEILAGE = re.compile(r"(?<![a-z])(beilage|anhang|anlage|zusatz|nachtrag|addendum|annex)")


def _hat_stamm(ws: Sequence[str], stamm: str) -> bool:
    if len(stamm) <= 3:
        return stamm in ws
    return any(w.startswith(stamm) or (len(stamm) >= 7 and stamm in w) for w in ws)


def dokart_aus(name_ws: Sequence[str], herkunft_ws: Sequence[str], typ: str | None, endung: str) -> Dokart | None:
    """Erst der Dateiname, dann die Herkunft (Ordnernamen in ZZ), dann der Typ der Stufe 1."""
    for ws in (name_ws, herkunft_ws):
        if not ws:
            continue
        verbunden = "_".join(ws)
        beilage = bool(_BEILAGE.search(verbunden))
        for d in DOKARTEN:
            if d.stamm and any(_hat_stamm(ws, s) for s in d.stamm):
                if beilage and d.key in ("arbeitsvertrag", "vertrag"):
                    return DOKART["vertragsbeilage"] if d.key == "arbeitsvertrag" else d
                return d
    if endung.lower() in _LISTEN_ENDUNGEN:
        return DOKART["liste"]
    key = _TYP_ZU_DOKART.get(typ or "")
    return DOKART[key] if key else None


# --- Inhalts-Filter (Mischa 15.10.: Titel/Name nie mit Inhaltsdetails) --------------------------------------------

# Strassenwörter (Wortende oder ganzes Wort) — gleiche Liste wie src/lib/ki/dateiname.ts (Inhalts-Filter des FSM).
_STRASSE = (r"(?:strasse|straße|str\.?|weg|gasse|gässlein|gässli|gaessli|platz|allee|ring|rain|graben|vorstadt|quai|"
            r"promenade|ufer|steig|matte|halde)")

_INHALT = [
    re.compile(r"(?i)(chf|fr\.|sfr|eur|usd|€|\$)\s*\d"),
    re.compile(r"(?i)\d[\d'’.,]*\s*(chf|fr\.?|franken|eur|euro|€|\$|rp\b)"),
    re.compile(r"\d+[.,](–|-{1,2})(?!\d)"),                            # 28.– / 28.-
    re.compile(r"\d\s*%"),
    re.compile(r"\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}"),           # IBAN
    re.compile(r"756[.\s]?\d{4}[.\s]?\d{4}[.\s]?\d{2}"),              # AHV
    re.compile(r"(\+|00)\s?\d{2}[\s\d]{6,}"),                          # Telefon international
    re.compile(r"(?<!\d)0\d{2}[\s/.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}(?!\d)"),  # Telefon CH
    re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"),
    re.compile(r"(?i)\b(nr|no|nummer|police|polic|konto|iban|ahv|kunden?nr)\.?\s*[:#]?\s*[\w-]*\d{3,}"),
    re.compile(r"#\s*\d{3,}"),
    # Strasse + Hausnummer (Messnacht 16.10.: «…-Strasse 6» kam als Beteiligter durch — die Regel verlangte Buchstaben
    # direkt vor «strasse»): jedes Strassenwort (auch nach Bindestrich, allein, abgekürzt «Str.»/«Str») mit 1–3 Ziffern
    # (+ Buchstabe), Jahreszahlen nicht («Spring 2025»). Dazu französische Formen davor oder danach.
    re.compile(rf"(?i){_STRASSE}\s*(?:nr\.?\s*)?\d{{1,3}}(?!\d)"
               r"|\b(?:rue|avenue|chemin|route|boulevard)\s+(?:[^\W\d_]+[\s'’-]+){0,4}\d{1,3}(?!\d)"
               r"|(?<![\d.])\d{1,3}[a-z]?,?\s+(?:rue|avenue|chemin|route|boulevard|quai)\b"),
    re.compile(r"(?<!\d)(?!(?:19|20)\d\d\b)\d{4}\s+[A-ZÄÖÜ][a-zäöü]{2,}"),  # PLZ Ort (nicht «2025 Basel»)
    re.compile(r"(?i)(krank|arzt|aerzt|ärzt|diagnose|therapie|schwanger|burn-?out|spital|unfallhergang|"
               r"kuendigungsgrund|kündigungsgrund|fristlos\s+wegen|psychi)"),
]
_ZIFFERN = re.compile(r"\d{5,}")
_DATUM_ANFANG = re.compile(r"^(\d{4}-\d{2}-\d{2}|\d{8}|\d{6})(?!\d)")


_HINWEIS_PRUEFUNG = [_INHALT[i] for i in (0, 1, 2, 4, 5, 6, 8, 13)]


def inhalt_frei_hinweis(s: str) -> bool:
    """Für Fakten-Hinweise aus Ordner-/Dateinamen (Pfade tragen Nummern wie «002506_» oder «INT-26-100»): nur Beträge,
    IBAN, AHV, Telefon, E-Mail und Gesundheits-/Kündigungsgründe."""
    return not any(r.search(s or "") for r in _HINWEIS_PRUEFUNG)


def inhalt_frei(s: str) -> bool:
    """True, wenn der Text keine Inhaltsdetails trägt. Ziffernfolgen ≥ 5 nur als Datum am Anfang erlaubt."""
    if not s:
        return True
    if any(r.search(s) for r in _INHALT):
        return False
    rest = _DATUM_ANFANG.sub("", s.strip())
    return not _ZIFFERN.search(rest)


# --- Erkennung ---------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Akte:
    pfad: str            # NFC
    name: frozenset[str]  # gefaltete Namensteile
    anzeige: str         # «Vorname Nachname» aus dem Ordnernamen


@dataclass(frozen=True)
class Entitaet:
    pfad: str            # Wurzel der Entität (NFC)
    art: str             # location | partner | kunde
    teile: tuple[str, ...]
    anzeige: str


_PERSONEN_ORDNER = re.compile(r"^(\d{3,})_(.+)$")
_ENTITAET_STOPP = frozenset({
    "gmbh", "ag", "sa", "basel", "theater", "verein", "eventline", "und", "the", "club", "bar", "halle", "zuerich", "bern",
    "kunden", "lieferanten", "partner",
})


def personal_wurzel(pfad: str) -> bool:
    return "personal" in falte(pfad.split("/", 1)[0])


def _praefixe(ordner: Iterable[str]) -> list[str]:
    """Alle Ordner der Liste samt ihren Elternpfaden (NFC, sortiert) — die FSM-Liste führt Eltern meist selbst."""
    aus: set[str] = set()
    for o in ordner:
        t = nfc(o).split("/")
        for i in range(1, len(t) + 1):
            aus.add("/".join(t[:i]))
    return sorted(aus)


def akten(ordner: Iterable[str]) -> list[Akte]:
    """Personalakten «NNNN_Vorname_Nachname» unter einer PERSONAL-Freigabe; Vorlagen (0000_, 30XX_, «Name_Vorname») nie."""
    aus = []
    for o in _praefixe(ordner):
        if not personal_wurzel(o) or unter_zz(o):
            continue
        letzter = o.rsplit("/", 1)[-1]
        m = _PERSONEN_ORDNER.match(letzter)
        if not m or m.group(1).startswith("0000") or "xx" in m.group(1).lower():
            continue
        teile = frozenset(w for w in woerter(m.group(2)) if not w.isdigit())
        if len(teile) < 2 or teile == {"name", "vorname"}:
            continue
        aus.append(Akte(pfad=o, name=teile, anzeige=" ".join(p for p in re.split(r"[_\s]+", m.group(2)) if p)))
    return aus


def entitaeten(ordner: Iterable[str]) -> list[Entitaet]:
    """Locations (02_LOCATIONS/<id>_<Name>), Partner (04_PARTNER/<nn>_<Name>), Kunden (07_KUNDEN/<Liste>/<Name>)."""
    aus = []
    for o in _praefixe(ordner):
        if unter_zz(o):
            continue
        t = o.split("/")
        f = falte(t[0])
        if len(t) == 2 and ("location" in f or "partner" in f or "lieferant" in f):
            art = "location" if "location" in f else "partner"
        elif len(t) == 3 and "kunde" in f:
            art = "kunde"
        else:
            continue
        roh = _NUMMER_PRAEFIX.sub("", t[-1])
        teile = tuple(w for w in woerter(roh) if len(w) >= 3 and w not in _ENTITAET_STOPP and not w.isdigit())
        if not teile:
            continue
        aus.append(Entitaet(pfad=o, art=art, teile=teile[:2], anzeige=re.sub(r"[_]+", " ", roh).strip()))
    # Ein Teil, den mehrere Entitäten tragen, unterscheidet nicht.
    zaehler = Counter(w for e in aus for w in set(e.teile))
    return [Entitaet(e.pfad, e.art, tuple(w for w in e.teile if zaehler[w] == 1) or e.teile, e.anzeige) for e in aus]


def _nah(a: str, b: str) -> bool:
    """Gleiches Wort oder (ab 5 Zeichen) höchstens ein Tipp-/Schreibfehler (Knesevic ~ Knezevic, Ferderico ~ Federico)."""
    if a == b:
        return True
    if min(len(a), len(b)) < 5 or abs(len(a) - len(b)) > 1:
        return False
    if len(a) > len(b):
        a, b = b, a
    i = 0
    while i < len(a) and a[i] == b[i]:
        i += 1
    return a[i + 1 :] == b[i + 1 :] if len(a) == len(b) else a[i:] == b[i + 1 :]


def _namen_in(ws: set[str], namen: frozenset[str]) -> bool:
    return len(namen) >= 2 and all(any(_nah(n, w) for w in ws) for n in namen)


def gleiche_person(a: frozenset[str], b: frozenset[str]) -> bool:
    """Gleiche Person (Reihenfolge egal, Umlaute gefaltet, ein Tippfehler je Namensteil): alle Teile der kürzeren Form
    stecken in der längeren — «Anna Muster» = «Anna Maria Muster»."""
    if len(a) < 2 or len(b) < 2:
        return False
    klein, gross = (a, b) if len(a) <= len(b) else (b, a)
    return _namen_in(set(gross), klein)


@dataclass
class Was:
    """Strukturierte Felder (WAS) — aus Dateiname, Herkunft und Stufe 1, validiert."""
    dokart: Dokart | None
    person: str | None = None            # Anzeige-Name
    person_namen: frozenset[str] = frozenset()
    person_quelle: str | None = None     # name | herkunft | text | modell
    personendokument: bool = False
    akte: Akte | None = None
    entitaet: Entitaet | None = None
    entitaet_quelle: str | None = None   # name | herkunft | text
    entwurf: bool = False
    datum: str | None = None             # YYYY-MM-DD
    datum_quelle: str | None = None      # name | modell
    jahr: str | None = None
    titel: str | None = None
    partei: str | None = None
    liste: bool = False
    hinweise: list[str] = field(default_factory=list)


_DATUM_ISO = re.compile(r"(?<!\d)(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d{1,3}(?!\d))")
_DATUM_CH = re.compile(r"(?<!\d)(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])\.(20\d{2})(?!\d)")
_JAHR = re.compile(r"(?<!\d)(20[12]\d)(?!\d)")


def _datum_ok(j: int, m: int, t: int, heute: str) -> str | None:
    try:
        d = date(j, m, t)
    except ValueError:
        return None
    h = date.fromisoformat(heute)
    if d.year < 2000 or d > date(h.year + 1, h.month, min(h.day, 28)):
        return None
    return d.isoformat()


def datum_aus_name(stamm: str, heute: str) -> str | None:
    m = _DATUM_ISO.search(stamm)
    if m:
        return _datum_ok(int(m.group(1)), int(m.group(2)), int(m.group(3)), heute)
    m = _DATUM_CH.search(stamm)
    if m:
        return _datum_ok(int(m.group(3)), int(m.group(2)), int(m.group(1)), heute)
    return None


def kryptisch(name: str) -> bool:
    """Scanner-/Kamera-Namen ohne Aussage: nur Ziffern/Trenner, IMG_…, Scan…, DSC…, WhatsApp…, Dokument1."""
    stamm = falte(_ohne_endung(name)[0])
    if not re.search(r"[a-z]{3,}", re.sub(r"\d", "", stamm)):
        return True
    return bool(re.match(r"^(img|dsc|dcim|pxl|scan|scanned|whatsapp|image|bild|foto|photo|dokument|document|doc|"
                         r"unbenannt|untitled|neu|new|file|datei)[\s_\-]*\d*[\s_\-()\d]*$", stamm))


def herkunft_segmente(pfad: str) -> list[str]:
    """Ordner-Segmente der Datei unterhalb der ZZ-Freigabe (ohne Freigabe, ohne Dateiname)."""
    teile = nfc(pfad).split("/")[:-1]
    i = next((n for n, t in enumerate(teile) if t.upper().startswith("ZZ_")), None)
    return teile[i + 1 :] if i is not None else []


def _personen_aus_herkunft(segmente: list[str]) -> list[tuple[str, frozenset[str]]]:
    """Ordner direkt unter einem «…Personal…»-Ordner, die wie ein Personenname aussehen (2–4 Wörter aus Buchstaben)."""
    aus = []
    for i, s in enumerate(segmente):
        if i == 0 or "personal" not in falte(segmente[i - 1]):
            continue
        ws = [w for w in re.split(r"[\s_\-]+", nfc(s)) if w]
        if 2 <= len(ws) <= 4 and all(re.fullmatch(r"[A-Za-zÀ-ÿĀ-ž'.]+", w) for w in ws):
            aus.append((" ".join(ws), frozenset(woerter(s))))
    return aus


def erkenne(
    *, pfad: str, dateiname: str, text: str, ordner: Sequence[str], namen_alle: Sequence[str], heute: str,
    typ: str | None = None, person_modell: str | None = None, partei_modell: str | None = None,
    betreff_modell: str | None = None, datum_modell: str | None = None, personenbezogen_modell: bool = False,
) -> Was:
    stamm, endung = _ohne_endung(dateiname)
    herkunft = herkunft_segmente(pfad)
    name_ws = woerter(stamm)
    herkunft_ws = [w for s in herkunft for w in woerter(s)]
    name_set, herkunft_set = set(name_ws), set(herkunft_ws)
    kopf = (text or "")[:3000]
    text_set = set(woerter(kopf))
    dokart = dokart_aus(name_ws, herkunft_ws, typ, endung)
    liste = endung.lower() in _LISTEN_ENDUNGEN or (dokart is not None and dokart.key == "liste")
    was = Was(dokart=dokart, liste=liste)
    was.entwurf = bool(_ENTWURF.search("_".join(name_ws))) or bool(_ENTWURF.search("_".join(woerter(herkunft[-1])) if herkunft else ""))

    # Person: Personalakten, alle Profile, Personen-Ordner der Herkunft.
    alle_akten = akten(ordner)
    bekannte: list[tuple[str, frozenset[str]]] = [(a.anzeige, a.name) for a in alle_akten]
    bekannte += [(n, frozenset(woerter(n))) for n in namen_alle if len(woerter(n)) >= 2]
    aus_herkunft = _personen_aus_herkunft(herkunft)
    bekannte += aus_herkunft

    def eindeutig(treffer: list[tuple[str, frozenset[str]]]) -> tuple[str, frozenset[str]] | None:
        # Varianten derselben Person (Tippfehler, zweiter Vorname) zählen einmal; die erste (Akte vor Profil vor
        # Ablageort) gibt die Schreibweise vor. Zwei verschiedene Personen = nicht eindeutig.
        vertreter: list[tuple[str, frozenset[str]]] = []
        for t in treffer:
            if not any(gleiche_person(t[1], v[1]) for v in vertreter):
                vertreter.append(t)
        return vertreter[0] if len(vertreter) == 1 else None

    person = eindeutig([b for b in bekannte if _namen_in(name_set, b[1])])
    quelle = "name" if person else None
    if person is None:
        person = eindeutig([b for b in bekannte if _namen_in(herkunft_set, b[1])])
        quelle = "herkunft" if person else None
    personen_herkunft = any("personal" in falte(s) for s in herkunft)
    was.personendokument = bool(dokart and dokart.person) or personen_herkunft
    if person is None and was.personendokument and not liste:
        person = eindeutig([b for b in bekannte if _namen_in(text_set, b[1])])
        quelle = "text" if person else None
    if person is None and person_modell and was.personendokument:
        pm = frozenset(woerter(person_modell))
        if len(pm) >= 2 and (pm <= name_set | herkunft_set | text_set):
            person, quelle = (person_modell, pm), "modell"
    if person:
        was.person, was.person_namen, was.person_quelle = person[0], person[1], quelle
        # Anzeige aus der Akte (Schreibweise der Ablage), sonst wie gefunden.
        treffer = [a for a in alle_akten if gleiche_person(a.name, person[1])]
        if len(treffer) == 1:
            was.akte = treffer[0]
            was.person = treffer[0].anzeige
        if dokart is None and (personenbezogen_modell or personen_herkunft):
            was.personendokument = True
    if was.person and quelle in ("name", "herkunft") and personenbezogen_modell:
        was.personendokument = True

    # Location / Partner / Kunde mit eigenem Ordner.
    ents = entitaeten(ordner)

    def ent_treffer(ws: set[str]) -> list[Entitaet]:
        return [e for e in ents if e.teile and all(t in ws for t in e.teile)]

    for ws, q in ((name_set, "name"), (herkunft_set, "herkunft")):
        t = ent_treffer(ws)
        if len(t) == 1:
            was.entitaet, was.entitaet_quelle = t[0], q
            break
    if was.entitaet is None and not liste and not was.personendokument:
        t = ent_treffer(text_set)
        if len(t) == 1:
            ganz = woerter(kopf)
            if sum(1 for w in ganz if w in t[0].teile) >= 2:
                was.entitaet, was.entitaet_quelle = t[0], "text"

    # Datum, Jahr, Titel, Partei — validiert.
    was.datum = datum_aus_name(stamm, heute)
    was.datum_quelle = "name" if was.datum else None
    if not was.datum and datum_modell:
        m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", datum_modell or "")
        if m:
            was.datum = _datum_ok(int(m.group(1)), int(m.group(2)), int(m.group(3)), heute)
            was.datum_quelle = "modell" if was.datum else None
    if not was.datum:
        m = _JAHR.search(stamm) or _JAHR.search(" ".join(herkunft))
        was.jahr = m.group(1) if m else None
    belegt = name_set | herkunft_set | set(woerter(text or ""))
    if partei_modell and not re.fullmatch(r"\s*eventline(\s+gmbh)?\s*", partei_modell, re.I):
        pw = [w for w in woerter(partei_modell) if w not in ("gmbh", "ag", "sa")]
        if pw and all(w in belegt for w in pw) and inhalt_frei(partei_modell) and len(partei_modell) <= 40:
            was.partei = partei_modell.strip()
    if betreff_modell:
        b = re.sub(r"\s+", " ", betreff_modell).strip()
        if b and len(b) <= 40 and len(b.split()) <= 4 and inhalt_frei(b):
            bw = woerter(b)
            if bw and sum(w in belegt for w in bw) >= max(1, len(bw) // 2):
                was.titel = b
    return was


# --- WOHIN ---------------------------------------------------------------------------------------------------------


@dataclass
class RegelZiel:
    ziel: str | None                 # entschiedener Ordner (NFC) oder None (nur Bereich)
    bereich: list[str]               # Kandidaten des Bereichs (NFC), beste zuerst
    sicherheit: str                  # hoch | mittel | niedrig
    art: str                         # person | person_ohne_akte | entitaet
    begruendung: str


_SAMMEL_AUS = ("vorlage", "historie", "backup", "archiv", "alt")


def _blaetter(ordner: Sequence[str], wurzel: str) -> list[str]:
    alle = [nfc(o) for o in ordner if not unter_zz(nfc(o))]
    darunter = [o for o in alle if o == wurzel or o.startswith(wurzel + "/")]
    eltern = {o.rsplit("/", 1)[0] for o in darunter if "/" in o}
    return [o for o in darunter if o not in eltern]


def _entwurfsordner(pfad: str) -> bool:
    return any(_ENTWURF.search(falte(s)) for s in pfad.split("/"))


def _passend(blaetter: list[str], staemme: Sequence[str], wurzel: str) -> list[str]:
    """Blätter, deren Pfad unterhalb der Wurzel einen der Stämme trägt — in der Reihenfolge der Stämme."""
    aus: list[str] = []
    for s in staemme:
        for b in blaetter:
            rel = falte(b[len(wurzel):])
            if s in rel and b not in aus:
                aus.append(b)
        if aus:
            break
    return aus


def lesbar(segment: str) -> str:
    return _NUMMER_PRAEFIX.sub("", segment).replace("_", " ").strip()


def regel_ziel(was: Was, ordner: Sequence[str]) -> RegelZiel | None:
    erlaubt = [nfc(o) for o in ordner if not unter_zz(nfc(o))]
    d = was.dokart
    label = d.label if d else "Dokument"
    if was.personendokument and was.person:
        stark = was.person_quelle in ("name", "herkunft")
        if was.akte is not None:
            blaetter = _blaetter(erlaubt, was.akte.pfad)
            if blaetter == [was.akte.pfad]:
                return RegelZiel(was.akte.pfad, [was.akte.pfad], "hoch" if stark else "mittel", "person",
                                 f"Personendokument ({label}) → Personalakte")
            passend = _passend(blaetter, d.akte if d else (), was.akte.pfad)
            if passend:
                ziel = passend[0]
                return RegelZiel(ziel, passend + [b for b in blaetter if b not in passend],
                                 "hoch" if stark and len(passend) == 1 else "mittel", "person",
                                 f"Personendokument ({label}) → Personalakte, {lesbar(ziel.rsplit('/', 1)[-1])}"[:120])
            sonst = _passend(blaetter, ("korrespondenz_sonstig", "sonstig"), was.akte.pfad)
            ziel = (sonst or blaetter)[0]
            return RegelZiel(ziel, [ziel] + [b for b in blaetter if b != ziel], "mittel", "person",
                             f"Personendokument ({label}) → Personalakte, {lesbar(ziel.rsplit('/', 1)[-1])}"[:120])
        # Person erkannt, aber keine eigene Akte: Personal-Bereich ohne fremde Akten und ohne Vorlagen.
        akten_wurzeln = [a.pfad for a in akten(erlaubt)]
        bereich = [o for o in erlaubt if personal_wurzel(o) and "/" in o
                   and not any(o == w or o.startswith(w + "/") for w in akten_wurzeln)
                   and not re.search(r"/(0000|\d{2}xx)_", falte(o))
                   and not any(s in falte(o) for s in _SAMMEL_AUS)
                   and not re.search(r"uebersicht|liste", falte(o.rsplit("/", 1)[-1]))]
        eltern = {o.rsplit("/", 1)[0] for o in bereich}
        bereich = [o for o in bereich if o not in eltern]
        bereich.sort(key=lambda o: (0 if "personalakten" in falte(o.rsplit("/", 1)[-1]) else 1, o))
        if bereich:
            return RegelZiel(None, bereich, "mittel", "person_ohne_akte",
                             f"Personendokument ({label}) — keine eigene Personalakte gefunden; Akte anlegen?"[:120])
        return None
    if was.entitaet is not None:
        e = was.entitaet
        blaetter = [b for b in _blaetter(erlaubt, e.pfad) if was.entwurf or not _entwurfsordner(b)]
        blaetter = [b for b in blaetter if not any(s in falte(b.rsplit("/", 1)[-1]) for s in ("historie", "backup"))]
        if not blaetter:
            return None
        stark = was.entitaet_quelle in ("name", "herkunft")
        wo = {"location": "Location", "partner": "Partner", "kunde": "Kunde"}[e.art]
        passend = _passend(blaetter, d.entitaet if d else (), e.pfad)
        if was.entwurf:
            entw = [b for b in passend if _entwurfsordner(b)] or [b for b in blaetter if _entwurfsordner(b)]
            passend = entw + [b for b in passend if b not in entw]
        if passend:
            ziel = passend[0]
            sicher = "hoch" if stark and len(passend) == 1 else "mittel" if stark else "niedrig"
            return RegelZiel(ziel, passend + [b for b in blaetter if b not in passend], sicher, "entitaet",
                             f"{label} zu {wo} {e.anzeige} → {lesbar(ziel.rsplit('/', 1)[-1])}"[:120])
        if not stark:
            # Nur im Text erwähnt und kein Unterordner passt zur Dokumentart (Probelauf: Rapporte nannten die Location
            # und bekamen deren Vertragsordner als Bereich) — kein Hinweis ist besser als ein falscher.
            return None
        return RegelZiel(None, blaetter, "mittel", "entitaet",
                         f"{label} zu {wo} {e.anzeige}"[:120])
    return None


# --- Neuer Dateiname -------------------------------------------------------------------------------------------------


def _teil(s: str, stil: str) -> str:
    s = re.sub(r"[\\/:*?\"<>|\x00-\x1f]+", " ", nfc(s))
    s = re.sub(r"\s+", " ", s).strip(" ._-–")
    if stil == "_":
        s = re.sub(r"[\s_]+", "-", s)
    return s


def stil_aus(namen: Sequence[str]) -> tuple[str, str | None]:
    """(Trenner, Datumsform) der Mehrheit der Dateinamen im Zielordner. Trenner « – », « - » oder «_»;
    Datumsform «iso» (YYYY-MM-DD), «kompakt» (YYYYMMDD) oder None (Datum am Anfang unüblich)."""
    if not namen:
        return "_", "iso"
    stile = Counter()
    daten = Counter()
    for n in namen:
        st = _ohne_endung(n)[0]
        if " – " in st or " — " in st:
            stile[" – "] += 1
        elif " - " in st:
            stile[" - "] += 1
        elif "_" in st:
            stile["_"] += 1
        if re.match(r"^\d{4}-\d{2}-\d{2}", st):
            daten["iso"] += 1
        elif re.match(r"^\d{8}(?!\d)", st):
            daten["kompakt"] += 1
        else:
            daten["keins"] += 1
    stil = stile.most_common(1)[0][0] if stile else "_"
    form = daten.most_common(1)[0][0] if daten else "iso"
    return stil, (None if form == "keins" else form)


def name_vorschlag(was: Was, dateiname: str, *, namen_ziel: Sequence[str] = (), typ_label: str | None = None) -> str | None:
    """Neuer Dateiname — für jede Datei, Pflicht bei kryptischen Namen. None, wenn nichts Belastbares bleibt oder der
    Vorschlag gleich dem heutigen Namen ist."""
    stamm, endung = _ohne_endung(dateiname)
    stil, form = stil_aus(namen_ziel)
    datum = was.datum
    teile: list[str] = []
    if datum:
        teile.append(datum.replace("-", "") if form == "kompakt" else datum)
    elif was.jahr:
        teile.append(was.jahr)
    art = (was.dokart.label if was.dokart else None) or (typ_label if typ_label and not typ_label.startswith("Sonstig") else None)
    if was.dokart and was.dokart.key == "vertragsbeilage" and was.personendokument:
        art = "Arbeitsvertrag-Beilage"
    if was.entwurf and art:
        art = f"{art}-Entwurf" if stil == "_" else f"{art} (Entwurf)"
    wer = was.person or (was.entitaet.anzeige if was.entitaet else None) or was.partei
    titel = was.titel
    if titel and _ohne_endung(titel)[1].lower() == endung.lower() and endung:
        titel = _ohne_endung(titel)[0]
    if titel and art and falte(titel) in falte(art):
        titel = None
    if titel and wer and set(woerter(titel)) <= set(woerter(wer)):
        titel = None
    if not kryptisch(dateiname) and not titel and not art:
        # Lesbarer heutiger Name ohne neue Fakten: Stamm als Titel behalten (ohne Datum/Typ-Dopplung).
        titel = re.sub(r"[_]+", " ", stamm)
    for t in (art, wer, titel):
        if t and inhalt_frei(t):
            p = _teil(t, stil)
            if p and falte(p) not in {falte(x) for x in teile}:
                teile.append(p)
    inhalt = [t for t in teile if not re.fullmatch(r"\d{4}(-\d{2}-\d{2}|\d{4})?", t)]
    if not inhalt:
        return None
    sep = stil if stil != "_" else "_"
    neu = sep.join(teile)[:150].rstrip(" ._-–") + endung.lower()
    if not inhalt_frei(_ohne_endung(neu)[0]) or neu == dateiname or nfc(neu) == nfc(dateiname):
        return None
    return neu
