"""Ordnerwahl nach Vorbild ohne Modell und ohne DB: Regeln, Stimmen der Nachbarn, Struktur, Ordnernamen.

Läuft im Dienst-Image (oder mit jedem Python ≥ 3.11), ohne Ollama, ohne Datenbank:
  docker run --rm --network none -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_ordnerwahl.py

Die Ordnerliste spiegelt die Hauskonvention des NAS in Kleinform (Namen erfunden): Locations mit
gleichen Unterordnern nach Dokumentart, Projektordner mit INT-Nummer (meist nur eine Datei),
Personalakten «NNNN_Vorname_Nachname» mit Unterordnern.
"""

from __future__ import annotations

import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.archiv import Nachbar  # noqa: E402
from app.ordnerwahl import (  # noqa: E402
    REGEL,
    TYP_FAKTOR,
    falte,
    generisch,
    int_nummern,
    mische,
    ordner_modell,
    personen_akte,
    rangliste,
    typ_passt,
    woerter,
)

HAUS = [
    "00_ADMIN_RECHT",
    "00_ADMIN_RECHT/02_Versicherungen",
    "02_LOCATIONS",
    "02_LOCATIONS/100001_Halle_Nord",
    "02_LOCATIONS/100001_Halle_Nord/01_Verwaltungsvertraege",
    "02_LOCATIONS/100001_Halle_Nord/02_Plaene_Grundrisse",
    "02_LOCATIONS/100001_Halle_Nord/03_Mietkonditionen_Vertragsvorlagen",
    "02_LOCATIONS/100002_Saal_Sued",
    "02_LOCATIONS/100002_Saal_Sued/01_Plaene_Grundrisse",
    "02_LOCATIONS/100002_Saal_Sued/02_Verwaltungsvertraege",
    "02_LOCATIONS/100002_Saal_Sued/02_Verwaltungsvertraege/01_Entwuerfe",
    "03_PROJEKTE_EVENTS",
    "03_PROJEKTE_EVENTS/2026",
    "03_PROJEKTE_EVENTS/2026/INT-26-001-Firma_Alpha_Sommerfest Halle Nord",
    "03_PROJEKTE_EVENTS/2026/INT-26-002-Bank_Beta_Jubilaeum Saal Sued",
    "03_PROJEKTE_EVENTS/2026/INT-26-003-Verein_Gamma_Weihnachtsfeier",
    "03_PROJEKTE_EVENTS/2026/INT-26-115-Kunde_Delta_Gala",
    "03_PROJEKTE_EVENTS/2026/INT-26-115-Kunde_Delta_Gala Kopie",
    "06_PERSONAL",
    "06_PERSONAL/01_Personalakten",
    "06_PERSONAL/01_Personalakten/0000_Vorlage_Mitarbeiter",
    "06_PERSONAL/01_Personalakten/0000_Vorlage_Mitarbeiter/01_Vertraege_Anstellung",
    "06_PERSONAL/01_Personalakten/1001_Tim_Naef",
    "06_PERSONAL/01_Personalakten/1001_Tim_Naef/01_Vertraege_Anstellung",
    "06_PERSONAL/01_Personalakten/1001_Tim_Naef/02_Schulungen_Zertifikate",
    "06_PERSONAL/01_Personalakten/1002_Anna_Keller",
    "06_PERSONAL/01_Personalakten/1002_Anna_Keller/01_Vertraege_Anstellung",
    "06_PERSONAL/01_Personalakten/1002_Anna_Keller/02_Schulungen_Zertifikate",
]
PROJ = "03_PROJEKTE_EVENTS/2026/"
HALLE = "02_LOCATIONS/100001_Halle_Nord/"
SAAL = "02_LOCATIONS/100002_Saal_Sued/"


def _nb(ordner: str, s: float, name: str = "x.pdf") -> Nachbar:
    return Nachbar(pfad=f"{ordner}/{name}", ordner=ordner, name=name, aehnlichkeit=s)


def _rang(**kw):
    basis = dict(ordner=HAUS, mit_dateien=set(), nachbarn=[], dateiname="dokument.pdf", text="", doc_vektor=None, ordner_vektoren={})
    basis.update(kw)
    return rangliste(**basis)


def test_woerter_und_faltung() -> None:
    assert falte("Verträge Größe") == "vertraege groesse"
    assert woerter("INT-26-001-Firma_Alpha_Sommerfest Halle Nord") == ["firma", "alpha", "sommerfest", "halle", "nord"], "INT, Zahlen fallen weg"
    assert generisch("02_Plaene_Grundrisse") == "plaene_grundrisse" == generisch("01_Plaene_Grundrisse")
    assert woerter("und der die GmbH 12 ab") == [], "Stoppwörter, Zahlen und kurze Wörter zählen nicht"


def test_int_nummern_im_dateinamen() -> None:
    assert int_nummern("Offerte INT-26-014.pdf") == {("26", "014")}
    assert int_nummern("AB_OF-26-014-Kunde.pdf") == {("26", "014")}, "Präfix egal, Bindestrich-Form"
    assert int_nummern("INT26014 Briefing.pdf") == {("26", "014")}, "mit INT auch ohne Trenner"
    assert int_nummern("Briefing 26-115.pdf") == {("26", "115")}, "Endung direkt nach der Nummer"
    assert int_nummern("Bericht 2026-014.pdf") == set(), "Jahreszahl ist keine INT-Nummer"
    assert int_nummern("Rechnung 26014.pdf") == set(), "ohne INT braucht es den Bindestrich"
    assert int_nummern("Plan 26-0145.pdf") == set() and int_nummern("v1.26-014.pdf") == set()
    assert int_nummern("") == set()


def test_ordner_modell() -> None:
    m = ordner_modell(tuple(HAUS))
    assert m.int_ordner[("26", "001")] == (PROJ + "INT-26-001-Firma_Alpha_Sommerfest Halle Nord",)
    assert len(m.int_ordner[("26", "115")]) == 2, "doppelte Nummer bleibt sichtbar"
    assert set(m.gleichnamig[("02_LOCATIONS", 3, "plaene_grundrisse")]) == {HALLE + "02_Plaene_Grundrisse", SAAL + "01_Plaene_Grundrisse"}
    assert "02_LOCATIONS/100002_Saal_Sued/02_Verwaltungsvertraege" in m.eltern
    assert personen_akte(m, "Tim Näf") == ["06_PERSONAL/01_Personalakten/1001_Tim_Naef"], "Umlaut gefaltet, Vorlage 0000 nie"
    assert personen_akte(m, "Unbekannt Person") == [] and personen_akte(m, "") == []


def test_kandidaten_menge() -> None:
    # Ohne jede Evidenz gibt es keine Kandidaten (Punkte 0) — nie die Freigabe selbst, nie ein Elternordner ohne Dateien.
    assert _rang().kandidaten == []
    nb = [_nb(SAAL + "02_Verwaltungsvertraege", 0.9), _nb(SAAL + "02_Verwaltungsvertraege/01_Entwuerfe", 0.8)]
    r = _rang(nachbarn=nb, mit_dateien={SAAL + "02_Verwaltungsvertraege", SAAL + "02_Verwaltungsvertraege/01_Entwuerfe"})
    assert r.pfade(1) == [SAAL + "02_Verwaltungsvertraege"], "Elternordner mit eigenen Dateien ist Kandidat"
    r2 = _rang(nachbarn=nb, mit_dateien={SAAL + "02_Verwaltungsvertraege/01_Entwuerfe"})
    assert SAAL + "02_Verwaltungsvertraege" not in r2.pfade(), "Elternordner ohne eigene Dateien nie"
    assert all("/" in p for p in r.pfade()) and "02_LOCATIONS" not in r.pfade()


def test_stimmen_der_nachbarn() -> None:
    nb = [_nb(HALLE + "02_Plaene_Grundrisse", 0.91, "Grundriss EG.pdf"), _nb(HALLE + "02_Plaene_Grundrisse", 0.88, "Bestuhlung.pdf"),
          _nb("00_ADMIN_RECHT/02_Versicherungen", 0.80)]
    r = _rang(nachbarn=nb)
    assert r.pfade(1) == [HALLE + "02_Plaene_Grundrisse"]
    k = r.kandidaten[0]
    assert "knn" in k.quellen and k.nachbarn == ["Grundriss EG.pdf", "Bestuhlung.pdf"], "Dateinamen der Vorbilder, ähnlichste zuerst"
    assert r.staerkste_aehnlichkeit == 0.91 and r.regel is None


def test_struktur_uebertrag_und_name() -> None:
    # Vorbild liegt bei Halle Nord/Pläne; das Dokument nennt aber den Saal Süd. Vorne steht der Ordner des
    # Vorbilds, gleich danach (Namensliste im Wechsel) Saal Süd/Pläne — das Modell entscheidet zwischen beiden.
    nb = [_nb(HALLE + "02_Plaene_Grundrisse", 0.90)]
    r = _rang(nachbarn=nb, text="Bestuhlungsplan Saal Sued, Erdgeschoss", dateiname="plan.pdf")
    assert r.pfade(2) == [HALLE + "02_Plaene_Grundrisse", SAAL + "01_Plaene_Grundrisse"], r.pfade(4)
    assert {"struktur", "name"} <= next(k for k in r.kandidaten if k.pfad == SAAL + "01_Plaene_Grundrisse").quellen


def test_mische() -> None:
    assert mische(["a", "b", "c"], ["x", "a", "y"]) == ["a", "x", "b", "c", "y"], "Spitze der ersten Liste, dann im Wechsel, ohne Doppelte"
    assert mische([], ["x", "y"]) == ["x", "y"] and mische(["a"], []) == ["a"] and mische([], []) == []


def test_projekt_ohne_vorbild_ueber_ordnernamen() -> None:
    # Projektordner mit einer einzigen Datei: im Leave-one-out kein Vorbild — der Name bringt ihn nach vorne.
    nb = [_nb(PROJ + "INT-26-002-Bank_Beta_Jubilaeum Saal Sued", 0.7)]
    r = _rang(nachbarn=nb, text="Offerte für das Sommerfest der Firma Alpha, Halle Nord, 12. Juni 2026")
    ziel = PROJ + "INT-26-001-Firma_Alpha_Sommerfest Halle Nord"
    assert r.pfade(2) == [PROJ + "INT-26-002-Bank_Beta_Jubilaeum Saal Sued", ziel], r.pfade(3)
    assert "name" in r.kandidaten[1].quellen and "knn" not in r.kandidaten[1].quellen
    # Mit mehreren Vorbildern in verschiedenen Projekten (wie im Archiv) gewinnt der Name.
    nb2 = [_nb(PROJ + "INT-26-002-Bank_Beta_Jubilaeum Saal Sued", 0.7), _nb(PROJ + "INT-26-003-Verein_Gamma_Weihnachtsfeier", 0.69),
           _nb(PROJ + "INT-26-115-Kunde_Delta_Gala", 0.69)]
    assert _rang(nachbarn=nb2, text="Offerte Sommerfest Firma Alpha, Halle Nord").pfade(1) == [ziel]
    # Einbettung des Pfads allein reicht auch (Dokument ↔ Ordnername ähnlich).
    ziel = PROJ + "INT-26-003-Verein_Gamma_Weihnachtsfeier"
    r2 = _rang(doc_vektor=[1.0, 0.0], ordner_vektoren={ziel: [0.9, 0.1], PROJ + "INT-26-001-Firma_Alpha_Sommerfest Halle Nord": [0.2, 0.9]})
    assert r2.pfade(1) == [ziel]


def test_int_regel() -> None:
    ziel = PROJ + "INT-26-003-Verein_Gamma_Weihnachtsfeier"
    nb = [_nb(HALLE + "02_Plaene_Grundrisse", 0.95)]
    r = _rang(nachbarn=nb, dateiname="Offerte INT-26-003.pdf", text="Halle Nord")
    assert r.regel == ziel and r.regel_art == "int" and r.pfade(1) == [ziel]
    assert r.kandidaten[0].punkte >= REGEL and "regel" in r.kandidaten[0].quellen
    # Doppelte Nummer: beide vorne, kein Entscheid — das Modell wählt.
    r2 = _rang(dateiname="Briefing 26-115.pdf")
    assert r2.regel is None and set(r2.pfade(2)) == {PROJ + "INT-26-115-Kunde_Delta_Gala", PROJ + "INT-26-115-Kunde_Delta_Gala Kopie"}
    # Im Text nur ein Zuschlag (kann ein anderes Projekt erwähnen).
    r3 = _rang(text="Bezug: INT-26-001, Sommerfest", nachbarn=[_nb(HALLE + "02_Plaene_Grundrisse", 0.9)])
    assert r3.regel is None and r3.pfade(1) == [PROJ + "INT-26-001-Firma_Alpha_Sommerfest Halle Nord"]
    # Unbekannte Nummer: keine Regel.
    assert _rang(dateiname="Offerte 26-999.pdf", nachbarn=nb).regel is None


def test_personalakte() -> None:
    akte = "06_PERSONAL/01_Personalakten/1001_Tim_Naef/"
    # Vorbild ist ein Arbeitsvertrag in der Akte von Anna Keller → für Tim zählt der gleichnamige Unterordner.
    nb = [_nb("06_PERSONAL/01_Personalakten/1002_Anna_Keller/01_Vertraege_Anstellung", 0.9)]
    r = _rang(nachbarn=nb, person="Tim Näf", text="Arbeitsvertrag", typ="vertrag")
    assert r.regel_art == "person" and r.regel is None
    assert r.pfade(1) == [akte + "01_Vertraege_Anstellung"], r.pfade(3)
    assert all(p.startswith(akte) for p in r.pfade()), "nur die Akte dieser Person"
    # Akte ohne Unterordner = entschieden.
    flach = HAUS + ["06_PERSONAL/01_Personalakten/1003_Lea_Moser"]
    r2 = _rang(ordner=flach, person="Lea Moser")
    assert r2.regel == "06_PERSONAL/01_Personalakten/1003_Lea_Moser" and r2.regel_art == "person"
    # Person ohne Akte: keine Einschränkung.
    assert _rang(person="Fremde Person", nachbarn=nb).regel_art is None


def test_dokumenttyp_zuschlag() -> None:
    assert typ_passt("vertrag", "01_Verwaltungsvertraege") and typ_passt("vertrag", "03_Mietkonditionen_Vertragsvorlagen")
    assert typ_passt("offerte", "02_Offerten") and not typ_passt("offerte", "02_Plaene_Grundrisse")
    assert not typ_passt("sonstiges", "01_Verwaltungsvertraege") and not typ_passt(None, "x")
    nb = [_nb(HALLE + "01_Verwaltungsvertraege", 0.9), _nb(HALLE + "02_Plaene_Grundrisse", 0.9)]
    ohne = {k.pfad: k.punkte for k in _rang(nachbarn=nb).kandidaten}
    mit = {k.pfad: k.punkte for k in _rang(nachbarn=nb, typ="vertrag").kandidaten}
    assert abs(mit[HALLE + "01_Verwaltungsvertraege"] - ohne[HALLE + "01_Verwaltungsvertraege"] * TYP_FAKTOR) < 1e-3
    assert mit[HALLE + "02_Plaene_Grundrisse"] == ohne[HALLE + "02_Plaene_Grundrisse"]


def test_exakte_schreibweise_der_liste() -> None:
    # Das FSM schickt NFD (zerlegte Umlaute) — Index und Vergleich arbeiten in NFC, zurück geht die Schreibweise der Liste.
    nfd = unicodedata.normalize("NFD", "00_ADMIN_RECHT/03_Sonstige_Dauerverträge")
    liste = HAUS + [nfd]
    nb = [_nb(unicodedata.normalize("NFC", nfd), 0.9)]
    r = _rang(ordner=liste, nachbarn=nb)
    assert r.pfade(1) == [nfd]


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    fehler = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok      {name}")
        except Exception as e:  # noqa: BLE001
            fehler += 1
            print(f"FEHLER  {name}: {type(e).__name__}: {e}")
    print(f"{len(tests) - fehler}/{len(tests)} bestanden")
    sys.exit(1 if fehler else 0)
