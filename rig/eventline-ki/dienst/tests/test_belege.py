"""Belegstellen (belege.py) und Firmenwissen (wissen.py) — ohne Netz, ohne Datenbank, nur synthetische Texte.

  docker run --rm --network none -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_belege.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import belege as bl  # noqa: E402
from app import wissen as wi  # noqa: E402

TEXT = """[Seite 1]
MIETVERTRAG Halle Nord — ENTWURF
zwischen der Muster Immobilien AG (Vermieterin) und der EVENTLINE GmbH (Mieterin).
Basel, 3. März 2025

[Seite 2]
Die Kündi-
gung ist mit einer Frist von drei Monaten möglich. Version 2.1, Stand 12.03.2025.
Herr Peter Hassemer, Hauswart, ist Ansprechpartner. Unterschrift: ____________
"""


def _teil() -> bl.Teil:
    return bl.Teil(1, TEXT)


def test_anker_wortgetreu_und_normalisiert() -> None:
    t = _teil()
    f = bl.anker_finden("Basel, 3. März 2025", t)
    assert f is not None and f.teil == 1 and f.seite == 1
    for anker in ("MIETVERTRAG Halle Nord", "mietvertrag halle nord", "Basel, 3. Maerz 2025", "Basel 3 Marz 2025",
                  "«Muster Immobilien AG (Vermieterin)»"):
        assert bl.anker_finden(anker, t) is not None, anker
    # Silbentrennung am Zeilenende: «Kündi-\ngung» trifft «Kündigung» (und die getrennte Form).
    g = bl.anker_finden("Die Kündigung ist mit einer Frist", t)
    assert g is not None and g.seite == 2
    assert bl.anker_finden("Die Kündi- gung ist", t) is not None
    # Fast wörtlich: ein ausgelassenes Wort des Dokuments geht, drei nicht; ein fremdes Wort im Beleg nie.
    assert bl.anker_finden("Kündigung ist mit Frist von drei Monaten", t) is not None
    assert bl.anker_finden("Kündigung Frist", t) is None, "drei Wörter dazwischen"
    assert bl.anker_finden("Kündigung ist mit einer langen Frist", t) is None, "Wort im Beleg, das nicht dasteht"
    for leer in ("", "  ", "unbekannt", None, 17, "a", "eins zwei drei vier fünf sechs sieben acht neun zehn elf zwölf dreizehn"):
        assert bl.anker_finden(leer, t) is None, leer


def test_datum_und_zeitraum() -> None:
    assert bl.datum_belegt("2025-03-03", "Basel, 3. März 2025")
    assert bl.datum_belegt("2025-03-12", "Stand 12.03.2025") and bl.datum_belegt("2025-03-12", "am 12.3.25")
    assert not bl.datum_belegt("2025-03-04", "Basel, 3. März 2025"), "anderer Tag"
    assert not bl.datum_belegt("2026-10-16", "Unterschrift: ____"), "heutiges Datum ohne Beleg"
    assert bl.zeitraum_belegt("2025", "Saison 2025 im Volkshaus")
    assert bl.zeitraum_belegt("Mai–Juni 2026", "vom 1. Mai bis 30. Juni 2026")
    assert bl.zeitraum_belegt("Mai–Juni 2026", "vom 01.05.2026 bis 30.06.2026"), "Monate auch als Zahl im Datum"
    assert not bl.zeitraum_belegt("Mai–Juni 2026", "bis 30. Juni 2026"), "Mai fehlt"
    assert bl.zeitraum_belegt("Saison 2025/26", "Saison 25/26"), "zweistelliges Jahr"
    assert not bl.zeitraum_belegt("2024", "Saison 2025"), "falsches Jahr"
    assert bl.zeitraum_belegt("Sommersaison", "für die Sommersaison")
    assert not bl.zeitraum_belegt("Wintersaison", "für die Sommersaison")


def test_status() -> None:
    assert bl.status_belegt("entwurf", "MIETVERTRAG Halle Nord — ENTWURF")
    assert not bl.status_belegt("unterschrieben", "Unterschrift: ____________"), "Unterschriftszeile ist kein Beleg"
    assert bl.status_belegt("unterschrieben", "digital signiert am 4. März 2025")
    assert bl.status_belegt("unterschrieben", "von beiden Parteien unterzeichnet")
    assert bl.status_belegt("version", "Version 2.1, Stand 12.03.2025") and bl.status_belegt("version", "Offerte V2")
    assert bl.status_belegt("version", "Stand 12.03.2025") and not bl.status_belegt("version", "Stand der Technik")
    assert bl.status_belegt("vorlage", "Mustervertrag für Locations") and not bl.status_belegt("vorlage", "Max Muster")
    assert bl.status_belegt("final", "Finale Fassung") and not bl.status_belegt("final", "Entwurf")
    assert not bl.status_belegt("erfunden", "Entwurf")


def test_namen_bezug_rolle() -> None:
    t = _teil()
    assert bl.name_belegt("Muster Immobilien AG", ["der", "muster", "immobilien", "ag"])
    assert bl.name_belegt("EVENTLINE GmbH", bl.woerter("der EVENTLINE"))
    assert not bl.name_belegt("Muster Bau AG", bl.woerter("der Muster Immobilien AG")), "zwei Wörter: beide nötig"
    assert bl.name_belegt("Peter Hassemer", bl.woerter("Herrn Peter Hassemers")), "Genitiv"
    assert not bl.name_belegt("AG", bl.woerter("Muster AG")), "nur Rechtsform"
    assert bl.bezug_belegt("Beilage zum Arbeitsvertrag", bl.woerter("Beilage zum Arbeitsvertrag vom 1. März"))
    assert not bl.bezug_belegt("Beilage zum Mietvertrag", bl.woerter("Beilage zum Arbeitsvertrag"))
    assert bl.bezug_belegt("Version 2.1", bl.woerter("Version 2.1, Stand 12.03.2025"))
    assert not bl.bezug_belegt("Version 3", bl.woerter("Version 2.1, Stand 12.03.2025")), "Zahl muss stimmen"
    assert not bl.bezug_belegt("Halle Süd", bl.woerter("Mietvertrag Halle Nord")), "kurze Wörter zählen mit"
    assert not bl.bezug_belegt("Offerte HTK", bl.woerter("Offerte Lichtpaket")), "Kürzel muss dastehen"
    assert bl.bezug_belegt("Offerte HTK", bl.woerter("Offerte HTK Lichtpaket"))
    assert bl.bezug_belegt("Mietvertrag bis 2026", bl.woerter("Mietvertrag Halle Nord, gültig 2026")), "«bis» ist Füllwort"
    assert bl.rolle_belegt("Vermieterin", t) and bl.rolle_belegt("Hauswart", t)
    assert bl.rolle_belegt("Mieter", t), "Mieter ~ Mieterin"
    assert not bl.rolle_belegt("Arbeitgeber", t), "steht nicht im Teil"
    assert bl.rolle_belegt("Arbeitgeber", t, extra={"arbeitgeber"}), "Firmenwissen zum Namen"
    assert not bl.rolle_belegt("Arbeitnehmer", bl.Teil(1, "Arbeitgeber EVENTLINE")), "anderer Wortstamm"


def test_wert_im_teil_rueckfall() -> None:
    # Passt der Beleg der KI nicht, sucht das Rig den Wert selbst im Teil — gleiche Massstäbe, Erfundenes bleibt draussen.
    t = _teil()
    f = bl.wert_im_teil("datum", "2025-03-12", t)
    assert f is not None and f.teil == 1, "Datum steht im Teil (12.03.2025)"
    assert bl.wert_im_teil("datum", "2025-03-13", t) is None, "erfundenes Datum"
    assert bl.wert_im_teil("datum", "2026-10-16", t) is None, "heutiges Datum steht nirgends"
    assert bl.wert_im_teil("zeitraum", "März 2025", t) is not None and bl.wert_im_teil("zeitraum", "April 2025", t) is None
    assert bl.wert_im_teil("status", "entwurf", t) is not None
    assert bl.wert_im_teil("status", "unterschrieben", t) is None, "Unterschriftszeile ist kein Beleg"
    assert bl.wert_im_teil("bezug", "Halle Nord", t) is not None and bl.wert_im_teil("bezug", "Halle Süd", t) is None
    n = bl.wert_im_teil("absender", "Muster Immobilien AG", t)
    assert n is not None and n.seite == 1
    h = bl.name_fund("Hassemer Peter", t)
    assert h is not None and h.seite == 2, "zwei Wörter auch umgekehrt; Seite der Stelle"
    assert bl.name_fund("Max Muster", t) is None, "Wörter einzeln da, aber nicht als Name"
    assert bl.name_fund("Peter Muster", t) is None
    assert bl.name_fund("GmbH", t) is None, "nur Rechtsform"


def test_prompt_kopie() -> None:
    dok = bl.dokument_woerter("Tarifblatt Lichttechnik 2026, EVENTLINE GmbH", "tarife.pdf", "Preise")
    assert bl.prompt_kopie("Verwaltungsvertrag Location SCALA", dok) == "Verwaltungsvertrag Location"
    assert bl.prompt_kopie("zu Veranstaltung X", dok) == "Veranstaltung X"
    assert bl.prompt_kopie("Dieser Vertrag regelt die Tarife.", dok) == "Dieser Vertrag …"
    assert bl.prompt_kopie("Tarifblatt Lichttechnik", dok) is None
    voll = bl.dokument_woerter("Verwaltungsvertrag für die Location SCALA. Der Mietvertrag regelt …", "v.pdf", "")
    assert bl.prompt_kopie("Verwaltungsvertrag Location", voll) is None, "im Dokument belegt"
    assert bl.prompt_kopie("Dieser Vertrag regelt die Miete.", voll) is None
    assert bl.ist_unbekannt("unbekannt") and bl.ist_unbekannt(" Unbekannt. ") and bl.ist_unbekannt("") and bl.ist_unbekannt(None)
    assert not bl.ist_unbekannt("Halle Nord")


def test_wissen_lesen_auswahl_und_block() -> None:
    roh = [
        {"kategorie": "abkuerzung", "begriff": "BSU", "erklaerung": "Basler Stadtunterhaltung, Kunde"},
        {"kategorie": "abkuerzung", "begriff": "bsu", "erklaerung": "doppelt"},
        {"kategorie": "zuordnung", "begriff": "Muster Immobilien", "erklaerung": "Vermieterin der Halle Nord", "bezug": "Halle Nord"},
        {"kategorie": "benennung", "begriff": "Mietverträge", "erklaerung": "JJJJ-MM-TT_Mietvertrag_Location"},
        {"kategorie": "ansprechpartner", "begriff": "Peter Hassemer", "erklaerung": "Hauswart"},
        {"kategorie": "erfunden", "begriff": "x", "erklaerung": "y"},
        {"kategorie": "sonstiges", "begriff": "", "erklaerung": "leer"},
        "kaputt",
    ]
    e = wi.lese_wissen(roh)
    assert [x.begriff for x in e] == ["BSU", "Muster Immobilien", "Mietverträge", "Peter Hassemer"]
    rel = wi.relevante(e, TEXT, "mietvertrag.pdf", "ZZ_Alt")
    assert [x.begriff for x in rel] == ["Muster Immobilien", "Peter Hassemer"], "nur Begriffe im Teil, ohne Benennungsregeln"
    assert wi.relevante(e, "Sommerfest der B.S.U.?", "", "") == [], "Punkte zerlegen die Abkürzung in Einzelbuchstaben"
    assert [x.begriff for x in wi.relevante(e, "Sommerfest der BSU", "", "")] == ["BSU"]
    assert [x.begriff for x in wi.relevante(e, "Vertrag für die Halle Nord", "", "")] == ["Muster Immobilien"], "über den Bezug"
    assert wi.relevante(e, TEXT, budget=40) == [], "Budget zu klein: lieber nichts als abgeschnitten"
    block = wi.block(rel)
    assert block.startswith("Firmenwissen") and "[Zuordnung] Muster Immobilien: Vermieterin der Halle Nord (Bezug: Halle Nord)" in block
    assert wi.block([]) == ""
    assert wi.erweiterung(e, bl.woerter("Sommerfest der BSU")) >= {"basler", "stadtunterhaltung", "kunde"}
    assert wi.erweiterung(e, bl.woerter("alle Mietverträge")) == set(), "Benennungsregeln belegen nichts"
    assert len(wi.lese_wissen([{"kategorie": "sonstiges", "begriff": "b", "erklaerung": "x" * 5000}])[0].erklaerung) == wi.MAX_ERKLAERUNG


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
