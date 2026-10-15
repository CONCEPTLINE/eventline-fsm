"""Fakten-Lieferant für den Claude-Entscheid (ablageregeln.py, Rezept zz/v3) — ohne Netz, ohne Datenbank.
Fester Prüfsatz realistischer Fälle (Befund Mischa 15.10.): Personendokument → Personalakte bzw. «keine Akte»,
Lead-Liste → nicht SCALA, Scanner-Datei → Namensvorschlag, Inhalts-Filter.

  docker run --rm --network none -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_ablageregeln.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import ablageregeln as ar  # noqa: E402

ORDNER = [
    "02_LOCATIONS/002503_Theater_BAU3/01_Verwaltungsvertraege/01_Entwürfe",
    "02_LOCATIONS/002503_Theater_BAU3/02_Plaene_Grundrisse",
    "02_LOCATIONS/002506_SCALA_BASEL/01_Plaene_Grundrisse",
    "02_LOCATIONS/002506_SCALA_BASEL/02_Verwaltungsvertraege/01_Entwuerfe",
    "02_LOCATIONS/002506_SCALA_BASEL/02_Verwaltungsvertraege/02_Signed",
    "02_LOCATIONS/002506_SCALA_BASEL/02_Verwaltungsvertraege/03_Nachtraege",
    "02_LOCATIONS/002506_SCALA_BASEL/06_Bewilligungen_Location",
    "02_LOCATIONS/002504_Barakuba/02_Plaene_Grundrisse",
    "04_PARTNER/01_Herzog&Tech_GmbH/02_Rahmenverträge",
    "05_VERKAUF_MARKETING/04_Referenzen_Portfolio",
    "06_PERSONAL/01_Personalakten_Festangestellt/0000_Vorname_Nachname/01_Vertraege_Anstellung",
    "06_PERSONAL/01_Personalakten_Festangestellt/2002_Tim_Böhm/01_Vertraege_Anstellung",
    "06_PERSONAL/01_Personalakten_Festangestellt/2002_Tim_Böhm/02_Bewerbung_Zeugnisse/01_Bewerbungsunterlagen",
    "06_PERSONAL/01_Personalakten_Festangestellt/2002_Tim_Böhm/04_Schulungen_Zertifikate",
    "06_PERSONAL/01_Personalakten_Festangestellt/2002_Tim_Böhm/06_Korrespondenz_Sonstiges",
    "06_PERSONAL/02_Personalakten_Ehmalige",
    "06_PERSONAL/03_Personalakten_Freelancer/02_Einzelakten/30XX_Name_Vorname/01_Rahmenvereinbarungen",
    "06_PERSONAL/05_Vorlagen_Dokumente/01_Arbeitsvertraege_Festangestellt",
    "ZZ_Dokumente_zum_Einsortieren/_EVENTLINE/Leads",
]
HEUTE = "2026-10-15"
ZZ = "ZZ_Dokumente_zum_Einsortieren/_EVENTLINE"


def _was(pfad: str, text: str = "", **kw):  # noqa: ANN003, ANN202
    return ar.erkenne(pfad=pfad, dateiname=pfad.rsplit("/", 1)[-1], text=text, ordner=ORDNER, namen_alle=["Tim Böhm"],
                      heute=HEUTE, **kw)


def test_volker_personalordner_statt_scala() -> None:
    p = f"{ZZ}/Vertraege_und_Recht/Verein EVENTLINE/2025-Personal/Volker Hassemer/Beilage zum Arbeitsvertrag – Techniker Volker Hassemer .pdf"
    was = _was(p, "Beilage zum Arbeitsvertrag zwischen Verein EVENTLINE und Volker Hassemer, Funktion Techniker.", typ="vertrag")
    assert was.person == "Volker Hassemer" and was.person_quelle == "name" and was.personendokument
    assert was.dokart is not None and was.dokart.key == "vertragsbeilage" and was.akte is None and not was.entwurf
    rz = ar.regel_ziel(was, ORDNER)
    assert rz is not None and rz.art == "person_ohne_akte" and rz.ziel is None
    assert rz.bereich[0] == "06_PERSONAL/02_Personalakten_Ehmalige", rz.bereich
    assert not any("SCALA" in b or "/2002_" in b or "Vorlagen" in b or "30XX" in b for b in rz.bereich), "nie fremde Akte/Vorlage"
    name = ar.name_vorschlag(was, p.rsplit("/", 1)[-1])
    assert name and name.endswith(".pdf") and "Volker-Hassemer" in name and "Arbeitsvertrag-Beilage" in name, name


def test_person_mit_akte_umlaut_und_reihenfolge() -> None:
    was = _was(f"{ZZ}/Dokumente/Arbeitsvertrag Boehm Tim 2026.pdf", typ="vertrag")
    assert was.akte is not None and was.person == "Tim Böhm", "Umlaut gefaltet, Reihenfolge egal"
    rz = ar.regel_ziel(was, ORDNER)
    assert rz and rz.ziel == "06_PERSONAL/01_Personalakten_Festangestellt/2002_Tim_Böhm/01_Vertraege_Anstellung"
    assert rz.sicherheit == "hoch" and "Personalakte" in rz.begruendung and "Böhm" not in rz.begruendung
    was2 = _was(f"{ZZ}/Dokumente/Kursbestaetigung_Hebebuehne_Tim_Boehm.pdf", typ="zertifikat")
    rz2 = ar.regel_ziel(was2, ORDNER)
    assert rz2 is None or rz2.ziel != "06_PERSONAL/01_Personalakten_Festangestellt/2002_Tim_Böhm/01_Vertraege_Anstellung"


def test_person_tippfehler_im_ablageort() -> None:
    # Ablageort «…/2025-Personal/Tim Bohem» (Tippfehler) und Akte «2002_Tim_Böhm»: dieselbe Person, Akte gefunden.
    was = _was(f"{ZZ}/Vertraege_und_Recht/Verein EVENTLINE/2025-Personal/Tim Boehn/2025.09.25 Stundenabrechnung.pdf",
               typ="rechnung")
    assert was.person == "Tim Böhm" and was.akte is not None and was.person_quelle == "herkunft", was
    assert was.dokart is not None and was.dokart.key == "lohnabrechnung"
    assert ar.gleiche_person(frozenset({"dario", "knesevic"}), frozenset({"dario", "knezevic"}))
    assert not ar.gleiche_person(frozenset({"dario", "knesevic"}), frozenset({"mario", "keller"}))


def test_lead_csv_nicht_scala() -> None:
    text = "Name;Ort\nSCALA BASEL;Basel\nBarakuba;Basel\nVolkshaus;Basel\nSCALA BASEL Saal;Basel\n"
    was = _was(f"{ZZ}/Leads/leads_locations_basel.csv", text, typ="sonstiges")
    assert was.liste and was.entitaet is None, "Liste: eine Location im Inhalt ist nicht das Thema"
    assert ar.regel_ziel(was, ORDNER) is None
    # Ein Dokument MIT SCALA im Namen dagegen zeigt auf SCALA — aber nie in «Entwürfe», wenn es kein Entwurf ist.
    was2 = _was(f"{ZZ}/Dokumente/Verwaltungsvertrag SCALA Basel unterzeichnet.pdf", typ="vertrag")
    rz = ar.regel_ziel(was2, ORDNER)
    assert rz and rz.ziel and "SCALA" in rz.ziel and "Entw" not in rz.ziel
    was3 = _was(f"{ZZ}/Dokumente/Verwaltungsvertrag SCALA Basel Entwurf v3.docx", typ="vertrag")
    rz3 = ar.regel_ziel(was3, ORDNER)
    assert was3.entwurf and rz3 and rz3.ziel and rz3.ziel.endswith("01_Entwuerfe")


def test_scanner_datei_bekommt_namen() -> None:
    assert ar.kryptisch("20260828191911_001.pdf") and ar.kryptisch("IMG_4711.JPG") and ar.kryptisch("Scan 12.pdf")
    assert not ar.kryptisch("Offerte Herzog Tech Bühne.pdf")
    was = _was(f"{ZZ}/Sonstiges/20260828191911_001.pdf", "Rechnung Herzog & Tech GmbH für Bühnentechnik", typ="rechnung",
               betreff_modell="Bühnentechnik")
    assert was.datum == "2026-08-28", "Datum aus dem Scanner-Namen"
    name = ar.name_vorschlag(was, "20260828191911_001.pdf")
    assert name and name.startswith("2026-08-28_Rechnung") and name.endswith(".pdf"), name
    # Stil des Zielordners: « – »-Trenner und kein Datum vorne → so auch der Vorschlag.
    name2 = ar.name_vorschlag(was, "20260828191911_001.pdf", namen_ziel=["Rechnung – Lieferant A.pdf", "Rechnung – B.pdf"])
    assert name2 and " – " in name2, name2


def test_inhalts_filter() -> None:
    for schlecht in ("Lohn 28 CHF", "CHF 1'200.–", "Stundensatz 45.–", "IBAN CH93 0076 2011 6238 5295 7",
                     "AHV 756.1234.5678.97", "Tel +41 61 123 45 67", "061 123 45 67", "info@firma.ch",
                     "Police Nr. 12345678", "Hauptstrasse 12", "4051 Basel", "Kündigung wegen Krankheit",
                     "Arztzeugnis", "Kunde 1234567"):
        assert not ar.inhalt_frei(schlecht), schlecht
    for gut in ("Arbeitsvertrag · Volker Hassemer · 2025", "2026-08-28_Rechnung_Herzog-Tech", "Saison 2025 Basel",
                "Offerte Bühnentechnik", "Kündigung Mietvertrag"):
        assert ar.inhalt_frei(gut), gut
    assert ar.inhalt_frei_hinweis("Location erkannt: 02_LOCATIONS/002506_SCALA_BASEL; INT-26-100-BA")


def test_inhalts_filter_strassen_varianten() -> None:
    # Messnacht 16.10.: «…-Strasse 6» kam als Beteiligter durch (die Regel verlangte Buchstaben direkt vor «strasse»).
    for adresse in ("Muster-Strasse 6", "Muster AG, Muster-Strasse 6", "Hinterer-Weg 12", "Am Weg 12", "Muster-Gasse 4",
                    "Spalen-Gässli 2", "Barfüsser-Platz 1", "Marktplatz 9", "Bahnhofstrasse 6", "Bahnhofstr. 12",
                    "Bahnhofstr 12", "Strasse 6", "Freie Strasse 3a", "Muster Str. 7", "Musterstrasse Nr. 7",
                    "St. Alban-Vorstadt 6", "Petersgraben 50", "Spalenring 4", "Unteres Rheinufer 3", "Rue du Rhône 6",
                    "6, rue du Rhône", "12 avenue de France", "Straße 2"):
        assert not ar.inhalt_frei(adresse), adresse
    for gut in ("Spring 2025", "Ring 2025", "Strategie 2026", "Muster-Strasse", "Anlage 1 zum Vertrag", "Version 3",
                "Halle 3", "Bühne 2", "Instrumente 3 Stück", "Weggli", "Platzhalter", "Versand via Post 2 Pakete"):
        assert ar.inhalt_frei(gut), gut


def test_entwurf_nur_bei_entwurf_und_akten() -> None:
    akten = ar.akten(ORDNER)
    assert [a.anzeige for a in akten] == ["Tim Böhm"], "Vorlagen 0000_/30XX_ sind keine Akte"
    ents = {e.pfad: e.teile for e in ar.entitaeten(ORDNER)}
    assert ents["02_LOCATIONS/002506_SCALA_BASEL"] == ("scala",) and ents["02_LOCATIONS/002503_Theater_BAU3"] == ("bau3",)


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
