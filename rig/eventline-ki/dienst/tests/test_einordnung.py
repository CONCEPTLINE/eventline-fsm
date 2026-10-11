"""V8-Einordnung ohne Modell und ohne DB: Minimierung (inkl. namen_alle), Personenbezug, Typ, Kandidaten, regel_ordner.

Läuft im Dienst-Image (oder mit jedem Python ≥ 3.11), ohne Ollama, ohne Datenbank:
  docker run --rm --network none -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_einordnung.py

Die Minimierung spiegelt minimiereText im FSM (src/lib/ki/ablage-entscheid.ts) — das FSM minimiert nochmals;
hier wird geprüft, dass schon das Rig nichts Erkennbares hinausgibt (Verteidigung in der Tiefe).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.einordnung import (  # noqa: E402
    MAX_BETREFF,
    MAX_KANDIDATEN,
    MAX_WAS,
    MITARBEITER_PLATZHALTER,
    PLATZHALTER,
    baue_einordnung,
    erkenne_sprache,
    kandidaten_v8,
    kuerze_auf_wort,
    minimiere_text,
    personal_hinweis,
    regel_ordner_v8,
    unter_personal,
)
from app.ordnerwahl import Kandidat, Rangliste  # noqa: E402

NAMEN = ["Tim Näf", "Anna Maria Keller", "Li Wang", "Jo"]

FELDER = {"was", "typ", "betreff", "partei", "bezug", "jahr", "personenbezogen", "sprache", "seiten"}
DEUTSCH = ("Der Vertrag wird mit der Verwaltung der Halle abgeschlossen und ist für die Dauer des Anlasses gültig. "
           "Die Miete ist im Voraus zu bezahlen, und eine Kündigung ist nicht möglich, wenn die Halle bereits reserviert ist.")


def _ein(roh: dict, **kw):
    basis = dict(namen=NAMEN, typ="vertrag", typ_label="Vertrag", person=None, betreff="Miete", partei="Halle Nord AG",
                 dok_datum="2026-01-15", heute="2026-10-11", seiten=3, text=DEUTSCH, foto=False, personen_typen=None)
    basis.update(kw)
    return baue_einordnung(roh, **basis)


# --- Minimierung -----------------------------------------------------------------------------------------------


def test_minimierung_kennungen_und_betraege() -> None:
    faelle = {
        "Miete CHF 4'500.– pro Tag": "Miete [...] pro Tag",
        "Betrag 1'250.00 ohne Währung": "Betrag [...] ohne Währung",
        "Total Fr. 50.- inkl.": "Total [...] inkl.",
        "zahlbar 200.50 EUR bis Ende": "zahlbar [...] bis Ende",
        "Kosten 3 Franken": "Kosten [...]",
        "sFr 1 200.50 netto": "[...] netto",
        "IBAN CH93 0076 2011 6238 5295 7 Bank": "IBAN [...] Bank",
        "AHV 756.1234.5678.97 erfasst": "AHV [...] erfasst",
        "AHV 7561234567897": "AHV [...]",
        "Mail an info@halle-nord.ch senden": "Mail an [...] senden",
        "Tel. +41 61 123 45 67 Büro": "Tel. [...] Büro",
        "Tel. 0041 61 123 45 67": "Tel. [...]",
        "Natel 079 123 45 67": "Natel [...]",
        "Kundennummer 123456 und Police 98765432": "Kundennummer [...] und Police [...]",
    }
    for roh, erwartet in faelle.items():
        assert minimiere_text(roh) == erwartet.replace("[...]", PLATZHALTER), (roh, minimiere_text(roh))
    # Was bleiben soll: Jahreszahlen, kurze Nummern, INT-Nummern, Daten.
    for bleibt in ("Sommerfest 2026", "Offerte INT-26-014", "Version 3", "gültig ab 1.1.2026", "Halle 12"):
        assert minimiere_text(bleibt) == bleibt, (bleibt, minimiere_text(bleibt))
    assert minimiere_text("CHF 100, CHF 200 und CHF 300") == f"{PLATZHALTER} und {PLATZHALTER}", "Platzhalter-Ketten zusammengefasst"
    assert minimiere_text("") == "" and minimiere_text(None) == ""  # type: ignore[arg-type]


def test_minimierung_review_v8() -> None:
    """Review V8: Beträge ohne Währung, Betragswort + Zahl, Postkonto, Adresse, PLZ + Ort, Anrede + Name."""
    faelle = {
        "Pauschale 4500.– für Bühnenbau": "Pauschale [...] für Bühnenbau",
        "Pauschale 4500 für Bühnenbau": "Pauschale [...] für Bühnenbau",
        "Total 1250.00 netto": "Total [...] netto",
        "Offerte über 980.50 für Licht": "Offerte über [...] für Licht",
        "Rechnung 1250,00 offen": "Rechnung [...] offen",
        "Kosten: 800 pauschal": "Kosten: [...] pauschal",
        "Brief an Herrn Näf wegen Lieferung": "Brief an Herrn [...] wegen Lieferung",
        "Offerte von Frau Keller.": "Offerte von Frau [...].",
        "Anfrage von Frau Dr. Petra Muster zur Halle": "Anfrage von Frau [...] zur Halle",
        "Lieferung an Hauptstrasse 12, 4051 Basel": "Lieferung an [...]",
        "Adresse St. Alban-Vorstadt 5 Basel": "Adresse St. [...] Basel",
        "Rue du Rhône 10, CH-1204 Genève": "[...]",
        "Postkonto 12-3456-7 Bank": "Postkonto [...] Bank",
        "Zahlung auf Konto 40-12345-6": "Zahlung auf Konto [...]",
        "Lager in 79539 Lörrach": "Lager in [...]",
        "Gemeinde 4126 Bettingen": "Gemeinde [...]",
        "Lieferung nach 9630 Wattwil": "Lieferung nach [...]",
    }
    for roh, erwartet in faelle.items():
        assert minimiere_text(roh) == erwartet.replace("[...]", PLATZHALTER), (roh, minimiere_text(roh))
    # Was bleiben soll: Datum (auch «11.10.»), Uhrzeit, Jahr vor einem Ort, INT-Nummern, Mengen, kurze Nummern.
    for bleibt in ("Anlass am 11.10. in der Halle", "Aufbau 14.30 Uhr", "Art Basel 2026 Basel", "Offerte INT-26-014",
                   "Halle 12", "für 500 Gäste", "für 1500 Gäste", "Bestellung 1200 Stühle", "Halle für 2000 Personen",
                   "gültig ab 1.1.2026", "Sommerfest 2026", "Version 3", "Herr der Ringe"):
        assert minimiere_text(bleibt) == bleibt, (bleibt, minimiere_text(bleibt))
    # Anrede + Teil eines Profilnamens → Mitarbeiter-Platzhalter (zählt dann als personenbezogen).
    assert minimiere_text("Brief an Herrn Näf", NAMEN) == f"Brief an Herrn {MITARBEITER_PLATZHALTER}"
    assert minimiere_text("Brief an Frau Naef", NAMEN) == f"Brief an Frau {MITARBEITER_PLATZHALTER}", "gefaltete Umlaute"
    assert minimiere_text("Brief an Frau Anna Maria Keller", NAMEN) == f"Brief an Frau {MITARBEITER_PLATZHALTER}"


def test_minimierung_name_nfd() -> None:
    """Profilname zerlegt gespeichert (NFD, z. B. macOS) wird wie im FSM erkannt."""
    import unicodedata
    nfd = unicodedata.normalize("NFD", "Tim Näf")
    assert nfd != "Tim Näf"
    assert minimiere_text("Lohn Tim Näf", [nfd]) == f"Lohn {MITARBEITER_PLATZHALTER}"
    assert minimiere_text(unicodedata.normalize("NFD", "Lohn Tim Näf"), [nfd]) == f"Lohn {MITARBEITER_PLATZHALTER}"


def test_minimierung_namen_jede_reihenfolge() -> None:
    m = MITARBEITER_PLATZHALTER
    assert minimiere_text("Vertrag mit Tim Näf.", NAMEN) == f"Vertrag mit {m}."
    assert minimiere_text("Vertrag mit Näf Tim.", NAMEN) == f"Vertrag mit {m}."
    assert minimiere_text("Vertrag mit Näf, Tim.", NAMEN) == f"Vertrag mit {m}."
    assert minimiere_text("Vertrag mit TIM NAEF.", NAMEN) == f"Vertrag mit {m}.", "gefaltete Umlaute, Gross/Klein"
    assert minimiere_text("Akte Tim_Naef", NAMEN) == f"Akte {m}", "Unterstrich wie im Dateinamen"
    for form in ("Anna Maria Keller", "Keller Anna Maria", "Maria Keller Anna", "Keller, Anna Maria", "Anna Keller Maria"):
        assert minimiere_text(f"Bewerbung von {form}", NAMEN) == f"Bewerbung von {m}", form
    assert minimiere_text("Li Wang und Wang Li", NAMEN) == f"{m} und {m}"
    # Wortgrenzen: kein Teilwort, Einzelteil allein bleibt (wie im FSM), Namen unter 3 Zeichen zählen nicht.
    assert minimiere_text("Timotheus Näfels", NAMEN) == "Timotheus Näfels"
    assert minimiere_text("Tim allein", NAMEN) == "Tim allein"
    assert minimiere_text("Jo Jo", NAMEN) == "Jo Jo"
    assert minimiere_text("Tim Näf, CHF 50.–, tim@x.ch", NAMEN) == f"{m}, {PLATZHALTER}", "aufeinanderfolgende Platzhalter = einer"


def test_kuerze_auf_wort() -> None:
    assert kuerze_auf_wort("kurz", 80) == "kurz"
    s = "Mietvertrag Halle Nord Sommerfest Firma Alpha Bestuhlung Technik Catering Abbau Reinigung Zusatz"
    k = kuerze_auf_wort(s, 40)
    assert len(k) <= 40 and s.startswith(k) and s[len(k)] == " ", k


def test_sprache() -> None:
    assert erkenne_sprache(DEUTSCH) == "de"
    assert erkenne_sprache("Le contrat est conclu avec la direction de la salle et il est valable pour la durée de la "
                           "manifestation. Le loyer est payable dans les délais et nous vous remercions pour votre confiance.") == "fr"
    assert erkenne_sprache("The contract is signed with the management of the hall and is valid for the duration of the "
                           "event. The rent is to be paid in advance and you will not be able to cancel it.") == "en"
    assert erkenne_sprache("") is None and erkenne_sprache("Grundriss EG 1:100") is None, "zu wenig Text = null"


# --- Einordnung --------------------------------------------------------------------------------------------------


def test_einordnung_form_und_grenzen() -> None:
    e = _ein({"was": "Mietvertrag über CHF 4'500.– für die Halle Nord.", "bezug_art": "location",
              "bezug_name": "Halle Nord", "partei_art": "organisation", "jahr": "2025", "personenbezogen": False})
    assert set(e) == FELDER and set(e["bezug"]) == {"art", "name"}
    assert e["was"] == f"Mietvertrag über {PLATZHALTER} für die Halle Nord."
    assert e["typ"] == "vertrag" and e["betreff"] == "Miete" and e["partei"] == "Halle Nord AG"
    assert e["bezug"] == {"art": "location", "name": "Halle Nord"} and e["jahr"] == "2026", "dok_datum vor der Angabe des Modells"
    assert e["personenbezogen"] is False and e["sprache"] == "de" and e["seiten"] == 3
    lang = _ein({"was": "Wort " * 200}, betreff="B " * 100)
    assert len(lang["was"]) <= MAX_WAS and len(lang["betreff"]) <= MAX_BETREFF
    # Ohne was: Ersatz aus Typ und Betreff (das FSM verwirft eine Einordnung ohne was).
    assert _ein({})["was"] == "Vertrag – Miete" and _ein({"was": "CHF 50.–"})["was"] == "Vertrag – Miete"


def test_einordnung_partei_nur_organisationen() -> None:
    assert _ein({"partei_art": "organisation"})["partei"] == "Halle Nord AG"
    assert _ein({"partei_art": "person"}, partei="Hans Privat")["partei"] is None, "Privatperson nie"
    assert _ein({"partei_art": ""})["partei"] is None, "unklar = nicht hinaus"
    assert _ein({"partei_art": "organisation"}, partei="Tim Näf")["partei"] is None, "Profilname ist keine Organisation"
    assert _ein({"partei_art": "organisation"}, partei=None)["partei"] is None
    assert _ein({"partei_art": "organisation"}, partei="Firma, info@firma.ch")["partei"] == f"Firma, {PLATZHALTER}"


def test_einordnung_bezug() -> None:
    assert _ein({"bezug_art": "projekt", "bezug_name": "Sommerfest Alpha"})["bezug"] == {"art": "projekt", "name": "Sommerfest Alpha"}
    assert _ein({"bezug_art": "person", "bezug_name": "Tim Näf"})["bezug"] == {"art": "person", "name": None}, "Person → kein Name"
    assert _ein({"bezug_art": "firma", "bezug_name": "EVENTLINE"})["bezug"] == {"art": "firma", "name": None}
    assert _ein({"bezug_art": "kunde", "bezug_name": "Anna Maria Keller"})["bezug"] == {"art": "kunde", "name": None}, "Profilname fällt weg"
    assert _ein({"bezug_art": "erfunden", "bezug_name": "X"})["bezug"] == {"art": None, "name": None}, "nur bekannte Arten"
    assert _ein({"bezug_art": "location", "bezug_name": ""})["bezug"] == {"art": "location", "name": None}


def test_einordnung_personenbezogen() -> None:
    assert _ein({"personenbezogen": True})["personenbezogen"] is True
    assert _ein({"personenbezogen": False}, person="Tim Näf")["personenbezogen"] is True, "erkannte Person"
    assert _ein({"personenbezogen": False, "bezug_art": "person"})["personenbezogen"] is True
    for typ in ("lohnabrechnung", "behoerde", "zertifikat"):
        assert _ein({"personenbezogen": False}, typ=typ)["personenbezogen"] is True, typ
    assert _ein({"personenbezogen": False}, typ="rechnung", personen_typen=frozenset({"rechnung"}))["personenbezogen"] is True, "Typ-Flag des FSM"
    assert _ein({"personenbezogen": False}, typ="zertifikat", personen_typen=frozenset())["personenbezogen"] is False, "FSM-Flags gelten"
    assert _ein({"personenbezogen": False}, regel_person=True)["personenbezogen"] is True, "Personalakten-Regel"
    assert _ein({"personenbezogen": "ja"})["personenbezogen"] is False, "nur echtes true vom Modell — die anderen Signale bleiben"
    # Personenbezogen: Partei geht nie hinaus, auch als Organisation.
    assert _ein({"personenbezogen": True, "partei_art": "organisation"})["partei"] is None


def test_einordnung_personenbezogen_review_v8() -> None:
    """Review V8: Arbeitsvertrag (Typ vertrag, FSM setzt keine Person) mit Modell-Flag false."""
    fsm = frozenset({"lohnabrechnung", "behoerde", "zertifikat"})
    roh = {"was": "Arbeitsvertrag mit Tim Näf als Technikerin.", "personenbezogen": False, "partei_art": "organisation"}
    e = _ein(roh, personen_typen=fsm)
    assert e["personenbezogen"] is True and e["was"] == f"Arbeitsvertrag mit {MITARBEITER_PLATZHALTER} als Technikerin."
    assert e["partei"] is None, "personenbezogen → keine Partei"
    assert _ein({"personenbezogen": False}, betreff="Lohn Näf Tim", personen_typen=fsm)["personenbezogen"] is True, "Profilname im Betreff"
    assert _ein({"personenbezogen": False, "partei_art": "organisation"}, partei="Tim Näf", personen_typen=fsm)["personenbezogen"] is True
    assert _ein({"personenbezogen": False, "bezug_art": "kunde", "bezug_name": "Anna Maria Keller"}, personen_typen=fsm)["personenbezogen"] is True
    # Rohes `person` des Modells zählt NICHT (gemma3:4b füllt es mit Mitarbeiterliste fast immer) — nur die geprüfte Person.
    assert _ein({"personenbezogen": False, "person": "Li Wang"}, personen_typen=fsm)["personenbezogen"] is False, "rohe Person des Modells"
    assert _ein({"personenbezogen": False, "was": "Brief an Herrn Näf."}, personen_typen=fsm)["personenbezogen"] is True, "Anrede + Profil-Nachname"
    assert _ein({"personenbezogen": False}, personal_ordner=True, personen_typen=fsm)["personenbezogen"] is True, "Personal-Ordner"
    # Ohne jedes Signal bleibt es false (Offerte einer Firma).
    assert _ein({"personenbezogen": False, "was": "Offerte für Bühnenbau Halle 3."}, personen_typen=fsm)["personenbezogen"] is False


def test_personal_hinweis() -> None:
    assert unter_personal("06_PERSONAL/01_Akten/0101_Tim_Naef") and unter_personal("06_Personal")
    assert not unter_personal("03_PROJEKTE_EVENTS/Personalplanung") and not unter_personal(None) and not unter_personal("")
    def rl(*k: Kandidat) -> Rangliste:
        return Rangliste(kandidaten=list(k))
    assert personal_hinweis(rl(Kandidat("06_PERSONAL/02_Vertraege", 2.0), Kandidat("02_LOCATIONS/A", 1.0))) is True, "bester Kandidat"
    assert personal_hinweis(rl(Kandidat("02_LOCATIONS/A", 2.0), Kandidat("06_PERSONAL/X/Y", 1.0, regel_bereich=True))) is True, "Regel-Bereich"
    assert personal_hinweis(rl(Kandidat("02_LOCATIONS/A", 2.0), Kandidat("06_PERSONAL/X", 1.0))) is False, "nur weiter unten, ohne Regel"
    assert personal_hinweis(rl(Kandidat("02_LOCATIONS/A", 2.0)), gewaehlt="06_PERSONAL/X") is True, "lokal gewählt"
    assert personal_hinweis(None) is False and personal_hinweis(rl()) is False


def test_einordnung_jahr_sprache_seiten() -> None:
    assert _ein({"jahr": "2027"}, dok_datum=None)["jahr"] == "2027"
    assert _ein({"jahr": 2027}, dok_datum=None)["jahr"] == "2027"
    assert _ein({"jahr": "2099"}, dok_datum=None)["jahr"] is None, "unplausibel (heute + 5)"
    assert _ein({"jahr": "26"}, dok_datum=None)["jahr"] is None and _ein({"jahr": True}, dok_datum=None)["jahr"] is None
    assert _ein({}, dok_datum="kaputt")["jahr"] is None
    assert _ein({}, foto=True)["sprache"] is None and _ein({}, text="")["sprache"] is None
    assert _ein({}, seiten=None)["seiten"] is None and _ein({}, seiten=0)["seiten"] is None


# --- Kandidaten + regel_ordner ------------------------------------------------------------------------------------


def _rl(*punkte: float, regel: str | None = None, bereich: set[int] | None = None) -> Rangliste:
    ks = [Kandidat(pfad=f"A/{i}", punkte=p, regel_bereich=i in (bereich or set())) for i, p in enumerate(punkte)]
    return Rangliste(kandidaten=ks, regel=regel)


def test_kandidaten_form() -> None:
    erlaubt = [f"A/{i}" for i in range(20)]
    ks = kandidaten_v8(_rl(4.0, 1.0, 2.0, 0.5, 0.0001, 3, 2, 1, 1, 1), erlaubt)
    assert len(ks) == MAX_KANDIDATEN == 8
    assert [k["pfad"] for k in ks] == [f"A/{i}" for i in range(8)], "Reihenfolge der Rangliste"
    g = [k["gewicht"] for k in ks]
    assert g[0] == 1.0 and g == sorted(g, reverse=True) and all(0 < x <= 1 for x in g), g
    assert g[:4] == [1.0, 0.25, 0.25, 0.12], "relativ zum besten, nie steigend, 2 Nachkommastellen"
    assert g[4] == 0.01, "Mindestgewicht"
    assert all(k["quelle"] == "vorbild" and set(k) == {"pfad", "quelle", "gewicht"} for k in ks)
    # Nur Pfade der Liste, ohne Doppel; quelle «regel» aus dem Regel-Bereich.
    rl = Rangliste(kandidaten=[Kandidat("A/1", 100.0, regel_bereich=True), Kandidat("X/erfunden", 50.0), Kandidat("A/1", 1.0),
                               Kandidat("A/2", 50.0, regel_bereich=True)])
    assert kandidaten_v8(rl, erlaubt) == [{"pfad": "A/1", "quelle": "regel", "gewicht": 1.0}, {"pfad": "A/2", "quelle": "regel", "gewicht": 0.5}]
    assert kandidaten_v8(None, erlaubt) == [] and kandidaten_v8(Rangliste(kandidaten=[]), erlaubt) == []


def test_regel_ordner() -> None:
    erlaubt = ["A/0", "A/1"]
    assert regel_ordner_v8(_rl(100.0, regel="A/0"), erlaubt) == "A/0"
    assert regel_ordner_v8(_rl(1.0), erlaubt) is None and regel_ordner_v8(None, erlaubt) is None
    assert regel_ordner_v8(_rl(100.0, regel="B/9"), erlaubt) is None, "nie ausserhalb der Liste"


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
