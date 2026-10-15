"""Doppel-Prüfung ohne Netz und ohne Datenbank: exakt, andere Form, neuere Fassung (Versionsmarke, Historie), kein
Fehlalarm bei gleichem Muster (zwei Arbeitsverträge, Formular ohne Werte), Upload-Prüfung, Melden in Paketen.

  docker run --rm --network none -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_duplikate.py
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import duplikate as dp  # noqa: E402
from app.config import laden  # noqa: E402
from app.fsm import FsmFehler  # noqa: E402

WORTE = ("vertrag zwischen parteien leistung vergütung kündigung frist monate jahre schriftlich gerichtsstand basel "
         "bühne technik betrieb haftung versicherung zahlung rechnung termine veranstaltung raum miete nebenkosten "
         "reinigung schlüssel übergabe abnahme mängel gewährleistung datenschutz vertraulichkeit schlussbestimmungen").split()


def _text(seed: int, n: int = 600, extra: str = "") -> str:
    r = random.Random(seed)
    return " ".join(r.choice(WORTE) for _ in range(n)) + " " + extra


def _aendere(text: str, anteil: float, seed: int) -> str:
    """Ersetzt einen Teil der Gerüstwörter (neue Fassung / Extraktionsrauschen) — Namen und Zahlen bleiben."""
    r = random.Random(seed)
    w = text.split()
    stellen = [i for i, x in enumerate(w) if x in WORTE]
    for i in r.sample(stellen, int(len(w) * anteil)):
        w[i] = r.choice(WORTE) + "x"
    return " ".join(w)


def _datei(pfad: str, sha: str, mtime: float = 1000.0) -> dp.Datei:
    return dp.Datei(pfad, sha, 1000, mtime)


def _gruppen(e: dp.Ergebnis, art: str) -> list[list[str]]:
    return [sorted(x["pfad"] for x in g["mitglieder"]) for g in e.gruppen if g["art"] == art]


def _fuellung(n: int = 8) -> tuple[list[dp.Datei], dict[str, str]]:
    """Weitere Dokumente, damit Gerüstwörter häufig (nicht «selten») sind — wie auf dem echten NAS."""
    dateien = [_datei(f"00_X/fuell_{i}.pdf", f"f{i:063d}") for i in range(n)]
    return dateien, {d.pfad: _text(500 + i) for i, d in enumerate(dateien)}


def test_merkmale_namen() -> None:
    assert dp.version("Vereinbarung_SCALA-BASEL_V02.docx") == (2, 0)
    assert dp.version("Haftung_Vorlage_rev.01.docx") == (1, 0)
    assert dp.version("Organigramm_v13_2.pdf") == (13, 0), "_2 ist ein Download-Zähler, keine Unter-Version"
    assert dp.version("Tarifblatt_MTB_V01.2025.pdf") == (1, 0)
    assert dp.version("Plan V1.2.pdf") == (1, 2)
    assert dp.version("INTSW0007 Angebot.pdf") is None
    assert dp.datum_im_namen("2026-09-07_Vereinbarung.docx") == "2026-09-07"
    assert dp.datum_im_namen("Rapport 7.9.26.pdf") == "2026-09-07"
    assert dp.stamm("2026-09-07_Vereinbarung_SCALA-BASEL_V02.docx") == dp.stamm("Vereinbarung SCALA BASEL (1).pdf")
    assert "vorlage" in dp.stamm("Haftung_Vorlage_rev.01.docx"), "Vorlage ≠ ausgefülltes Dokument"
    assert dp.in_historie("A/B/Historie/x.pdf") and dp.in_historie("A/02_Historie/x.pdf") and not dp.in_historie("A/Historie.pdf")
    assert dp.familie("x.DOCX") == "word" and dp.familie("x.pdf") == "pdf" and dp.familie("x.csv") == "daten"


def test_exakt_gleiche_bytes_jeder_typ() -> None:
    dateien = [_datei("02_LOC/Plan.pdf", "a" * 64), _datei("ZZ_Dok/Plan.pdf", "a" * 64), _datei("ZZ_Dok/Logo.ai", "b" * 64),
               _datei("02_LOC/Logo.ai", "b" * 64), _datei("02_LOC/anders.pdf", "c" * 64)]
    e = dp.berechne(dateien, {})
    assert sorted(_gruppen(e, "gleich")) == [["02_LOC/Logo.ai", "ZZ_Dok/Logo.ai"], ["02_LOC/Plan.pdf", "ZZ_Dok/Plan.pdf"]]
    g = next(g for g in e.gruppen if g["mitglieder"][0]["pfad"].endswith("Plan.pdf"))
    assert {x["kopie"] for x in g["mitglieder"]} == {1}, "gleiche Bytes = gleiche Kopie-Nummer"
    assert e.zaehler["gruppen_exakt"] == 2 and "gruppen_inhalt" not in e.zaehler


def test_andere_form_docx_pdf() -> None:
    basis = _text(1, extra="scala basel 756123 2026 mieterin herzog eventline")
    fuell_d, fuell_t = _fuellung()
    docx = _datei("02_LOC/Vertrag_SCALA.docx", "d" * 64)
    pdf = _datei("02_LOC/Vertrag_SCALA.pdf", "e" * 64)
    texte = {docx.pfad: basis, pdf.pfad: _aendere(basis, 0.01, 7), **fuell_t}
    e = dp.berechne([docx, pdf, *fuell_d], texte)
    gleich = _gruppen(e, "gleich")
    assert [docx.pfad, pdf.pfad] in gleich, e.gruppen
    g = next(g for g in e.gruppen if docx.pfad in [x["pfad"] for x in g["mitglieder"]])
    assert {x["kopie"] for x in g["mitglieder"]} == {1, 2}, "andere Bytes = andere Kopie-Nummer (andere Form)"
    assert not _gruppen(e, "fassung")


def test_neuere_fassung_versionsmarke_und_historie() -> None:
    basis = _text(2, extra="scala basel vereinbarung 2026 buehnentechnik herzog")
    fuell_d, fuell_t = _fuellung()
    v02 = _datei("02_LOC/Entwuerfe/Vereinbarung_SCALA_V02.docx", "1" * 64, mtime=2000)
    v03 = _datei("02_LOC/Entwuerfe/Vereinbarung_SCALA_V03.docx", "2" * 64, mtime=1000)  # mtime älter: Version zählt
    hist = _datei("02_LOC/Entwuerfe/Historie/Vereinbarung_SCALA.docx", "3" * 64, mtime=3000)
    t02 = _aendere(basis, 0.03, 3)
    texte = {v02.pfad: t02, v03.pfad: _aendere(t02, 0.03, 4), hist.pfad: basis, **fuell_t}
    e = dp.berechne([v02, v03, hist, *fuell_d], texte)
    paare = [(g["mitglieder"][0]["pfad"], g["mitglieder"][1]["pfad"]) for g in e.gruppen if g["art"] == "fassung"]
    assert (v03.pfad, v02.pfad) in paare, paare
    assert (v02.pfad, hist.pfad) in paare, "unmarkiert in Historie = älter"
    assert all(g["mitglieder"][0]["rolle"] == "neu" and g["mitglieder"][1]["rolle"] == "alt"
               for g in e.gruppen if g["art"] == "fassung")
    assert (v03.pfad, hist.pfad) not in paare, "je neuere Datei nur die nächstältere Fassung"
    assert not _gruppen(e, "gleich"), "Fassungen sind keine Doppel"


def test_kein_fehlalarm_gleiches_muster() -> None:
    """Zwei Arbeitsverträge aus derselben Vorlage (andere Person, Lohn, AHV) — gleiche und andere Form."""
    vorlage = _text(3, n=800)
    a = vorlage + " arbeitnehmerin anna muster geboren 1990 ahv 7561234567 lohn 5200 eintritt 2026"
    b = vorlage + " arbeitnehmer beat beispiel geboren 1985 ahv 7569876543 lohn 6100 eintritt 2025"
    fuell_d, fuell_t = _fuellung()
    da = _datei("06_PERSONAL/1001_Anna_Muster/Arbeitsvertrag.docx", "4" * 64)
    db = _datei("06_PERSONAL/1002_Beat_Beispiel/Arbeitsvertrag.docx", "5" * 64)
    dc = _datei("06_PERSONAL/1002_Beat_Beispiel/Arbeitsvertrag.pdf", "6" * 64)
    e = dp.berechne([da, db, dc, *fuell_d], {da.pfad: a, db.pfad: b, dc.pfad: _aendere(b, 0.01, 9), **fuell_t})
    gleich = _gruppen(e, "gleich")
    assert [db.pfad, dc.pfad] in gleich, "dieselbe Person: docx ↔ pdf ist ein Doppel"
    assert not any(da.pfad in g for g in gleich), "andere Person = anderes Dokument (Zahlen verschieden)"
    assert not _gruppen(e, "fassung")
    # Gleiche Form, gleiche Vorlage, nur wenige Wörter anders (Lohnklasse): unter 0,97 → kein «gleicher Inhalt».
    x = _datei("06_PERSONAL/Vorlagen/LKA_Arbeitsvertrag_Vorlage_v01.docx", "7" * 64)
    y = _datei("06_PERSONAL/Vorlagen/LKB_Arbeitsvertrag_Vorlage_v01.docx", "8" * 64)
    e2 = dp.berechne([x, y, *fuell_d], {x.pfad: _aendere(vorlage, 0.02, 1), y.pfad: _aendere(vorlage, 0.02, 2), **fuell_t})
    assert not e2.gruppen, e2.gruppen


def test_kein_fehlalarm_formular_ohne_werte() -> None:
    """Zehn Rapporte, deren Werte nicht im Text stehen: gleicher Text, verschiedene Bytes, keine seltenen Wörter."""
    formular = _text(4, n=120)
    dateien = [_datei(f"ZZ_Rapporte/Rapport_2026-04-10-{i}.pdf", f"{i:064d}") for i in range(10)]
    e = dp.berechne(dateien, {d.pfad: formular for d in dateien})
    assert not e.gruppen, "ohne Belege nur exakte Kopien"


def test_daten_export_nie_fassung() -> None:
    basis = _text(5)
    fuell_d, fuell_t = _fuellung()
    a = _datei("ZZ/TimesheetsReport-2025-10-01.csv", "9" * 64)
    b = _datei("ZZ/TimesheetsReport-2025-11-01.csv", "a" * 64)
    e = dp.berechne([a, b, *fuell_d], {a.pfad: basis, b.pfad: _aendere(basis, 0.1, 1), **fuell_t})
    assert not _gruppen(e, "fassung")


def test_upload_pruefung() -> None:
    basis = _text(6, extra="barakuba mietkonditionen 2026 eventline 120044")
    fuell_d, fuell_t = _fuellung()
    alt = _datei("02_LOC/Barakuba/Mietkonditionen.pdf", "b" * 64)
    zz = _datei("ZZ_Dok/Mietkonditionen.pdf", "b" * 64)
    liste = [alt, zz, *fuell_d]
    texte = {alt.pfad: basis, zz.pfad: basis, **fuell_t}
    basis_v = dp._basis_aus(liste, texte)
    assert dp.pruefe_neue_datei("x.pdf", "b" * 64, "", basis_v) == {"art": "exakt", "pfad": alt.pfad, "aehnlichkeit": 1.0}, \
        "exakt: der einsortierte Pfad vor ZZ"
    form = dp.pruefe_neue_datei("Mietkonditionen.docx", "c" * 64, _aendere(basis, 0.01, 2), basis_v)
    assert form is not None and form["art"] == "inhalt" and form["pfad"] in (alt.pfad, zz.pfad)
    neu = dp.pruefe_neue_datei("Mietkonditionen_V02.pdf", "d" * 64, _aendere(basis, 0.04, 3), basis_v)
    assert neu is not None and neu["art"] == "fassung", "V02 neben dem unmarkierten Original = neuere Fassung"
    alt_v1 = dp.pruefe_neue_datei("Mietkonditionen_V01.pdf", "f" * 64, _aendere(basis, 0.04, 3), basis_v)
    assert alt_v1 is None or alt_v1["art"] != "fassung", "V01 neben dem Original: unklar, keine Fassung"
    assert dp.pruefe_neue_datei("ganz_anders.pdf", "e" * 64, _text(99), basis_v) is None
    assert dp.pruefe_neue_datei("x.pdf", "b" * 64, "", None) is None


class _Fsm:
    def __init__(self, fehler: Exception | None = None) -> None:
        self.bodies: list[dict] = []
        self.fehler = fehler

    def melde_doppel(self, body: dict) -> dict:
        if self.fehler:
            raise self.fehler
        self.bodies.append(body)
        return {"success": True}


def test_melden_in_paketen_und_wiederholen() -> None:
    cfg = laden()
    t = dp.DoppelPruefung(cfg, _Fsm(FsmFehler("weg")), ruhig=lambda: True, speicher=object())  # type: ignore[arg-type]
    gruppen = [{"gruppe": f"g:{i}", "art": "gleich", "mitglieder": []} for i in range(dp.PAKET + 10)]
    t._offen = ("20261015T170000", gruppen)
    assert t._melden() == "fehler" and t._offen is not None, "Liste bleibt bis zur Zustellung"
    assert t._melden() == "warten"
    t.fsm = _Fsm()
    t._naechste_meldung = 0.0
    assert t._melden() == "gemeldet" and t._offen is None
    b = t.fsm.bodies
    assert [x["teil"] for x in b] == [1, 2] and [x["letzter"] for x in b] == [False, True]
    assert len(b[0]["gruppen"]) == dp.PAKET and len(b[1]["gruppen"]) == 10 and b[0]["lauf_id"] == b[1]["lauf_id"]
    # Leere Liste: trotzdem einmal melden (ersetzt eine alte Liste im FSM).
    t._offen = ("20261015T180000", [])
    assert t._melden() == "gemeldet" and t.fsm.bodies[-1]["gruppen"] == [] and t.fsm.bodies[-1]["letzter"] is True


def test_nichts_wird_verschoben_oder_geloescht() -> None:
    """Das Modul hat keine Schreibwege auf das NAS: kein unlink/rename/remove/move im Code."""
    quelle = (Path(dp.__file__)).read_text(encoding="utf-8")
    for verboten in ("unlink(", "os.remove", "shutil.move", "rename(", "rmtree"):
        assert verboten not in quelle, verboten


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
