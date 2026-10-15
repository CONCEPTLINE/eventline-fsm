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
    SOCKEL_REGEL,
    TEXT_INT,
    TYP_FAKTOR,
    evidenz,
    falte,
    generisch,
    int_nummern,
    mische,
    namensteile,
    nummern_form,
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
    "03_PROJEKTE_EVENTS/2026/INT-26-033-Kunde_X",
    "03_PROJEKTE_EVENTS/2026/INT-26-040-Kunde_Y",
    "03_PROJEKTE_EVENTS/2026/INT-26-040-Kunde_Y/01_Offerten",
    "03_PROJEKTE_EVENTS/2026/INT-26-040-Kunde_Y/02_Vertraege",
    "03_PROJEKTE_EVENTS/ZZ_Alt",
    "03_PROJEKTE_EVENTS/ZZ_Alt/INT-25-050-Kunde_Alt",
    "02_LOCATIONS/100001_Halle_Nord/ZZ_Archiv",
    "02_LOCATIONS/100001_Halle_Nord/ZZ_Archiv/01_Plaene_Grundrisse",
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
    "06_PERSONAL/01_Personalakten/1004_Li_Wang",
    "06_PERSONAL/01_Personalakten/1005_Mei_Wang",
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
    assert int_nummern("INT26014 Briefing.pdf") == {("26", "014")}, "mit INT auch ohne Trenner"
    assert int_nummern("int_26_014.pdf") == {("26", "014")}
    assert int_nummern("Offerte_INT-26-014_Lieferant.pdf") == {("26", "014")}, "Unterstrich vor INT (kein \\b: «_» ist Wortzeichen)"
    assert int_nummern("PRINT-26-014.pdf") == set(), "INT als Wortende zählt nicht"
    # Ohne «INT» ist «26-014» kein Entscheid mehr (Review [3]: Lieferanten-Offert-/Rechnungsnummern JJ-NNN),
    # sondern ein Hinweis wie «INT-…» im Text.
    assert int_nummern("AB_OF-26-014-Kunde.pdf") == set() and nummern_form("AB_OF-26-014-Kunde.pdf") == {("26", "014")}
    assert int_nummern("Briefing 26-115.pdf") == set() and nummern_form("Briefing 26-115.pdf") == {("26", "115")}, "Endung direkt nach der Nummer"
    assert nummern_form("Offerte INT-26-014.pdf") == set(), "mit INT ist es schon der Entscheid, kein zusätzlicher Hinweis"
    assert nummern_form("Bericht 2026-014.pdf") == set(), "Jahreszahl ist keine INT-Nummer"
    assert nummern_form("Rechnung 26014.pdf") == set(), "ohne INT braucht es den Bindestrich"
    assert nummern_form("Plan 26-0145.pdf") == set() and nummern_form("v1.26-014.pdf") == set()
    assert int_nummern("") == set() and nummern_form("") == set()


def test_ordner_modell() -> None:
    m = ordner_modell(tuple(HAUS))
    assert m.int_ordner[("26", "001")] == (PROJ + "INT-26-001-Firma_Alpha_Sommerfest Halle Nord",)
    assert len(m.int_ordner[("26", "115")]) == 2, "doppelte Nummer bleibt sichtbar"
    assert set(m.gleichnamig[("02_LOCATIONS", 3, "plaene_grundrisse")]) == {HALLE + "02_Plaene_Grundrisse", SAAL + "01_Plaene_Grundrisse"}
    assert "02_LOCATIONS/100002_Saal_Sued/02_Verwaltungsvertraege" in m.eltern
    assert personen_akte(m, "Tim Näf") == ["06_PERSONAL/01_Personalakten/1001_Tim_Naef"], "Umlaut gefaltet, Vorlage 0000 nie"
    assert personen_akte(m, "Unbekannt Person") == [] and personen_akte(m, "") == []
    assert not any("ZZ_" in o for o in m.alle) and ("25", "050") not in m.int_ordner, "ZZ_ auf jeder Tiefe: nie Kandidat, nie INT-Ziel"


def test_personalakte_kurze_vornamen() -> None:
    # Review [7]: woerter() warf «Li» weg — «Li Wang» traf jede Akte «*_Wang». Jetzt alle Namensteile, Wortmenge gleich.
    m = ordner_modell(tuple(HAUS))
    assert namensteile("Li Wang") == {"li", "wang"} and namensteile("1004_Li_Wang") == {"li", "wang"}
    assert personen_akte(m, "Li Wang") == ["06_PERSONAL/01_Personalakten/1004_Li_Wang"]
    assert personen_akte(m, "Mei Wang") == ["06_PERSONAL/01_Personalakten/1005_Mei_Wang"]
    assert personen_akte(m, "Wang") == [], "Nachname allein trifft keine Akte (Teilmenge reicht nicht mehr)"
    assert personen_akte(m, "Tim Näf Junior") == [], "zusätzlicher Namensteil = keine Gleichheit"
    r = _rang(person="Li Wang", typ="zertifikat")
    assert r.regel == "06_PERSONAL/01_Personalakten/1004_Li_Wang" and r.regel_art == "person"


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
    assert evidenz(r) == "niedrig", "Platz 1 nur über ein schwaches Vorbild (0,7): unsicher"
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
    r2 = _rang(dateiname="Briefing INT-26-115.pdf")
    assert r2.regel is None and set(r2.pfade(2)) == {PROJ + "INT-26-115-Kunde_Delta_Gala", PROJ + "INT-26-115-Kunde_Delta_Gala Kopie"}
    assert all(k.punkte >= REGEL for k in r2.kandidaten[:2])
    # Im Text nur ein Zuschlag (kann ein anderes Projekt erwähnen).
    r3 = _rang(text="Bezug: INT-26-001, Sommerfest", nachbarn=[_nb(HALLE + "02_Plaene_Grundrisse", 0.9)])
    assert r3.regel is None and r3.pfade(1) == [PROJ + "INT-26-001-Firma_Alpha_Sommerfest Halle Nord"]
    # Unbekannte Nummer: keine Regel.
    assert _rang(dateiname="Offerte INT-26-999.pdf", nachbarn=nb).regel is None
    assert _rang(dateiname="Offerte 26-999.pdf", nachbarn=nb).regel is None


def test_nummer_ohne_int_ist_kein_entscheid() -> None:
    # Review [3]: «26-033» ohne «INT» im Dateinamen (Lieferanten-Offert-/Rechnungsnummer) darf die Vorbilder nicht
    # überstimmen — Zuschlag wie «INT-…» im Text, das Modell wählt unter den Kandidaten.
    ziel_int = PROJ + "INT-26-033-Kunde_X"
    nb = [_nb(HALLE + "02_Plaene_Grundrisse", 0.95, "Grundriss.pdf")]
    for name in ("Offerte_Nr_26-033_Lieferant.pdf", "Rechnung 26-033 Herzog.pdf", "Tel_26-033 45 67.pdf"):
        r = _rang(dateiname=name, nachbarn=nb, text="Grundriss Halle Nord")
        assert r.regel is None and r.regel_art is None, name
        assert set(r.pfade(2)) == {HALLE + "02_Plaene_Grundrisse", ziel_int}, (name, r.pfade(3))
        k = next(k for k in r.kandidaten if k.pfad == ziel_int)
        assert "regel" in k.quellen and abs(k.punkte - TEXT_INT) < 1e-6, "nur der Hinweis-Zuschlag, kein REGEL"
    # Mit «INT» bleibt es der Entscheid.
    r = _rang(dateiname="Offerte_INT-26-033_Lieferant.pdf", nachbarn=nb)
    assert r.regel == ziel_int and r.regel_art == "int"


def test_regel_bereich_sockel() -> None:
    # Review [6]: ist der INT-Bereich erkannt, stehen ALLE Unterordner in der Rangliste — auch ohne eigene Punkte.
    y = PROJ + "INT-26-040-Kunde_Y/"
    r = _rang(dateiname="Offerte INT-26-040.pdf", typ="offerte", text="")
    assert r.regel is None and r.regel_art == "int"
    assert r.pfade() == [y + "01_Offerten", y + "02_Vertraege"], r.pfade()
    assert all(k.punkte >= SOCKEL_REGEL and "regel" in k.quellen for k in r.kandidaten)
    assert r.kandidaten[0].punkte > r.kandidaten[1].punkte, "Dokumenttyp-Zuschlag wirkt auf den Sockel"
    # Scan ohne Text: kein Wort, keine Nachbarn → trotzdem beide Kandidaten (vorher: leer → quelle «keine»).
    r2 = _rang(dateiname="Scan_INT-26-040.pdf", text="")
    assert set(r2.pfade()) == {y + "01_Offerten", y + "02_Vertraege"} and r2.regel_art == "int"
    # Nachbar ausserhalb des Bereichs ändert nichts an der Menge; innerhalb ordnet er.
    r3 = _rang(dateiname="Vertrag INT-26-040.pdf", nachbarn=[_nb(y + "02_Vertraege", 0.9), _nb(HALLE + "02_Plaene_Grundrisse", 0.95)])
    assert r3.pfade() == [y + "02_Vertraege", y + "01_Offerten"]
    # Personalakte mit Unterordnern, Dokument ohne Text: beide Unterordner da.
    akte = "06_PERSONAL/01_Personalakten/1001_Tim_Naef/"
    r4 = _rang(person="Tim Näf", dateiname="scan.pdf", text="")
    assert set(r4.pfade()) == {akte + "01_Vertraege_Anstellung", akte + "02_Schulungen_Zertifikate"} and r4.regel_art == "person"


def test_regel_bereich_markierung_v8() -> None:
    # V8: quelle «regel» für Kandidaten aus einem erkannten Regel-Bereich (INT im Dateinamen — auch mehrdeutig —,
    # Personalakte); Hinweise («INT-…» im Text, «26-033» ohne INT) und Vorbilder sind keine Regel.
    y = PROJ + "INT-26-040-Kunde_Y/"
    r = _rang(dateiname="Offerte INT-26-040.pdf", nachbarn=[_nb(HALLE + "02_Plaene_Grundrisse", 0.9)])
    assert {k.pfad for k in r.kandidaten if k.regel_bereich} == {y + "01_Offerten", y + "02_Vertraege"}
    r2 = _rang(dateiname="Briefing INT-26-115.pdf")
    assert all(k.regel_bereich for k in r2.kandidaten[:2]), "mehrdeutige INT-Nummer: beide Projektordner"
    r3 = _rang(dateiname="Rechnung 26-033 Herzog.pdf", text="Bezug INT-26-001", nachbarn=[_nb(HALLE + "02_Plaene_Grundrisse", 0.9)])
    assert not any(k.regel_bereich for k in r3.kandidaten), "Hinweise sind keine Regel"
    r4 = _rang(person="Tim Näf", dateiname="scan.pdf", text="")
    assert r4.kandidaten and all(k.regel_bereich for k in r4.kandidaten)
    assert not any(k.regel_bereich for k in _rang(nachbarn=[_nb(HALLE + "02_Plaene_Grundrisse", 0.9)]).kandidaten)


def test_zz_nie_kandidat() -> None:
    # Review [4]: ZZ_ auf jeder Tiefe — auch wenn die FSM-Liste den Ordner als aktiv führt.
    zz = HALLE + "ZZ_Archiv/01_Plaene_Grundrisse"
    nb = [_nb(zz, 0.99, "alt.pdf"), _nb(HALLE + "02_Plaene_Grundrisse", 0.7)]
    r = _rang(nachbarn=nb, mit_dateien={zz}, text="Plaene Grundrisse Archiv")
    assert not any("ZZ_" in p for p in r.pfade()), r.pfade()
    assert r.pfade(1) == [HALLE + "02_Plaene_Grundrisse"]
    assert _rang(dateiname="Offerte INT-25-050.pdf").regel is None, "INT-Ordner unter ZZ_ ist kein Regel-Ziel"


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


# --- Befund 14.10.: SCALA-Entwürfe als Sammelbecken des Rückstaus ZZ ----------------------------------------

ENTWUERFE = SAAL + "02_Verwaltungsvertraege/01_Entwuerfe"
VERSICHERUNGEN = "00_ADMIN_RECHT/02_Versicherungen"


def _nbv(ordner: str, s: float, name: str, vektor: tuple[float, ...] | None) -> Nachbar:
    return Nachbar(pfad=f"{ordner}/{name}", ordner=ordner, name=name, aehnlichkeit=s, vektor=vektor)


def test_sammelbecken_schwache_zwillinge() -> None:
    # Nachbau des Befunds: ein Vertragsentwurf liegt als docx+pdf plus zwei Versionen im Entwurfsordner — alle vier
    # sind dem neuen Dokument nur schwach ähnlich (0,66), ein ebenso schwaches Vorbild liegt im richtigen Ordner,
    # dessen Name im Dateinamen steht. Früher: 4 Stimmen + Kategorie-Zuschlag → Entwürfe auf Platz 1.
    v = (1.0, 0.0)
    nb = [
        _nbv(ENTWUERFE, 0.660, "Vereinbarung_V02.docx", v), _nbv(ENTWUERFE, 0.659, "Vereinbarung_V02.pdf", v),
        _nbv(ENTWUERFE, 0.658, "Vereinbarung.docx", (0.99, 0.141)), _nbv(ENTWUERFE, 0.657, "Vereinbarung.pdf", (0.99, 0.141)),
        _nbv(VERSICHERUNGEN, 0.655, "Police_2025.pdf", (0.0, 1.0)),
    ]
    r = _rang(nachbarn=nb, dateiname="Versicherung_Police_2026.pdf", mit_dateien={ENTWUERFE, VERSICHERUNGEN})
    assert r.pfade(1) == [VERSICHERUNGEN], r.pfade(3)
    entwurf = next(k for k in r.kandidaten if k.pfad == ENTWUERFE)
    assert entwurf.nachbarn == ["Vereinbarung_V02.docx"], "Zwillinge zählen einmal und stehen nicht mehrfach im Prompt"
    assert evidenz(r) == "niedrig" and evidenz(r, ENTWUERFE) == "niedrig", "schwache Vorbilder: höchstens «unsicher»"


def test_zwillinge_stimmen_einmal() -> None:
    # Drei Fassungen desselben Dokuments in A (Kosinus untereinander > 0,95) gegen ein etwas ähnlicheres Vorbild in B.
    a, b = HALLE + "01_Verwaltungsvertraege", HALLE + "02_Plaene_Grundrisse"
    gleich = (0.6, 0.8)
    nb = [_nbv(a, 0.88, "v1.pdf", gleich), _nbv(a, 0.88, "v2.pdf", gleich), _nbv(a, 0.88, "v3.pdf", gleich),
          _nbv(b, 0.90, "plan.pdf", (1.0, 0.0))]
    assert _rang(nachbarn=nb).pfade(1) == [b]
    # Verschiedene Dokumente (Kosinus 0,6) im selben Ordner stimmen weiter einzeln.
    nb2 = [_nbv(a, 0.88, "v1.pdf", (1.0, 0.0)), _nbv(a, 0.88, "v2.pdf", (0.6, 0.8)), _nbv(a, 0.88, "v3.pdf", (0.0, 1.0)),
           _nbv(b, 0.90, "plan.pdf", (1.0, 0.0))]
    assert _rang(nachbarn=nb2).pfade(1) == [a]
    # Ohne Vektoren: gleicher Namensstamm (docx+pdf) = Zwilling.
    nb3 = [_nb(a, 0.88, "Vertrag.docx"), _nb(a, 0.88, "Vertrag.pdf"), _nb(b, 0.90, "plan.pdf")]
    assert _rang(nachbarn=nb3).pfade(1) == [b]


def test_evidenz_stufen() -> None:
    a = HALLE + "01_Verwaltungsvertraege"
    assert evidenz(_rang(nachbarn=[_nb(a, 0.90)])) == "hoch"
    assert evidenz(_rang(nachbarn=[_nb(a, 0.82)])) == "mittel"
    assert evidenz(_rang(nachbarn=[_nb(a, 0.75)])) == "niedrig"
    assert evidenz(_rang(nachbarn=[_nb(a, 0.90)]), HALLE + "02_Plaene_Grundrisse") == "niedrig", "Ordner ohne Vorbild"
    assert evidenz(_rang(dateiname="Offerte INT-26-003.pdf")) == "hoch", "Regel-Entscheid"
    bereich = _rang(dateiname="Offerte INT-26-040.pdf")
    assert bereich.regel is None and evidenz(bereich) == "mittel", "im Regel-Bereich (Projekt erkannt), Unterordner offen"
    assert evidenz(_rang()) == "niedrig"


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
