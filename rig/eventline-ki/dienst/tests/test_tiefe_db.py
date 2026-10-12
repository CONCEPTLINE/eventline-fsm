"""SQL des Tiefen-Index, der Suche und der Live-Trefferquote gegen eine WEGWERF-Datenbank (nie die des Tresors).

Ohne TEST_PG_DSN wird übersprungen (Standard-Testlauf ohne Netz). Mit Wegwerf-DB auf dem Rig:
  docker network create --internal ki-test-db
  docker run -d --rm --name ki-test-pg --network ki-test-db -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16
  docker run --rm --network ki-test-db -e TEST_PG_DSN="host=ki-test-pg user=postgres password=test dbname=postgres" \
    -v <stand>/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_tiefe_db.py
  docker rm -f ki-test-pg; docker network rm ki-test-db
"""

from __future__ import annotations

import dataclasses
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import laden  # noqa: E402
from app.jobs.lernen import Lernen  # noqa: E402
from app.suche import Suche, nas_suche  # noqa: E402
from app.tiefe import Abschnitt, NasDatei, Text, TiefenIndex, abschnitt_rezept, text_rezept, zerlege  # noqa: E402

DSN = os.environ.get("TEST_PG_DSN")
CFG = laden()
RT, RA = text_rezept(CFG), abschnitt_rezept(CFG)
DIM = 8


def _v(i: int) -> list[float]:
    v = [0.0] * DIM
    v[i % DIM] = 1.0
    return v


def _datei(pfad: str) -> NasDatei:
    ordner, _, name = pfad.rpartition("/")
    return NasDatei(pfad=pfad, ordner=ordner, name=name, voll=Path("/nicht/da"), groesse=10, mtime=1.0)


def _leeren(ix: TiefenIndex) -> None:
    ix._ausfuehren("DROP TABLE IF EXISTS archiv_abschnitte, archiv_text, ablage_vorschlaege, qualitaet_tag, archiv_dateien CASCADE")
    ix.schliessen()


def _drei(z: dict) -> dict:
    return {k: z[k] for k in ("dateien", "mit_text", "abschnitte")}


class _Llm:
    def einbetten(self, *, modell, texte, timeout_s=120.0, keep_alive=None):  # noqa: ANN001, ANN201
        return [_v(3) for _ in texte], {}

    def geladene_modelle(self) -> list:
        return []

    def entlade(self, modell=None) -> None:  # noqa: ANN001
        pass


def test_tiefen_index_sql() -> None:
    ix = TiefenIndex(DSN)
    _leeren(ix)
    ix = TiefenIndex(DSN)
    assert ix.bereit() and _drei(ix.zaehler()) == {"dateien": 0, "mit_text": 0, "abschnitte": 0}
    text = "[Seite 1]\nMietvertrag Volkshaus Basel\n\n[Seite 3]\nDie Kündigungsfrist beträgt sechs Monate auf Monatsende."
    abschnitte = zerlege(text)
    assert [a.seite for a in abschnitte] == [1, 3]
    d = _datei("02_LOCATIONS/Volkshaus/Mietvertrag.pdf")
    ix.speichere(d, "s" * 64, Text(text, seiten=3), "de", abschnitte, [_v(1), _v(3)], RT, RA)
    assert _drei(ix.zaehler()) == {"dateien": 1, "mit_text": 1, "abschnitte": 2}
    b = ix.bestand()[d.pfad]
    assert (b.groesse, b.sha256, b.rezept_text, b.rezept_abschnitte) == (10, "s" * 64, RT, RA)
    # Suche: Vektor (nächster zu _v(3) ist Seite 3) und Volltext (german: «Kündigungsfristen» findet «Kündigungsfrist»).
    v = ix.vektor_treffer(_v(3), RA, 50)
    assert v[0].pfad == d.pfad and v[0].seite == 3 and v[0].wert > 0.99
    t = ix.text_treffer("Kündigungsfristen Monatsende", RA, 50)
    assert len(t) == 1 and t[0].seite == 3
    assert ix.text_treffer("Leasing -Volkshaus", RA, 50) == []
    assert ix.vektor_treffer(_v(3), "anderes|rezept", 50) == [], "nur das aktuelle Rezept"
    # Übernehmen (verschoben) → gleicher Text und Abschnitte am neuen Pfad, ohne Lesen.
    neu = _datei("ZZ_Dokumente_zum_Einsortieren/Scan_0042.pdf")
    assert ix.uebernehme(neu, "s" * 64, RT, RA) and not ix.uebernehme(neu, "x" * 64, RT, RA)
    assert _drei(ix.zaehler()) == {"dateien": 2, "mit_text": 2, "abschnitte": 4}
    # Neu zerlegen: nur Abschnitte + Rezept.
    ix.speichere_abschnitte(neu.pfad, [Abschnitt(0, None, "Ein einziger neuer Abschnitt mit Text")], [_v(5)], "neu|v2")
    assert ix.bestand()[neu.pfad].rezept_abschnitte == "neu|v2" and ix.text_von(neu.pfad) == text
    # Entfernen: Abschnitte fallen per CASCADE mit weg.
    ix.entferne([d.pfad])
    assert _drei(ix.zaehler()) == {"dateien": 1, "mit_text": 1, "abschnitte": 1}
    texte = ix.abschnitt_texte([f.id for f in ix.vektor_treffer(_v(5), "neu|v2", 5)])
    assert list(texte.values()) == ["Ein einziger neuer Abschnitt mit Text"]
    ix.schliessen()


def test_voruebergehender_fehler_sql() -> None:
    # Befund Review E2: vorübergehender Lesefehler → Versuchszähler, zählt nicht als gelesen, wird nie übernommen.
    ix = TiefenIndex(DSN)
    _leeren(ix)
    ix = TiefenIndex(DSN)
    d = _datei("00_ADMIN/Police.pdf")
    ix.speichere(d, "p" * 64, Text("alter Stand der Police"), "de", [Abschnitt(0, 1, "alter Stand der Police")], [_v(1)], RT, RA)
    ix.vormerken(d, "p" * 64, "kind_-9", 1, RT)
    b = ix.bestand()[d.pfad]
    assert (b.fehler, b.versuche, b.rezept_abschnitte) == ("kind_-9", 1, None) and b.wartet_auf_versuch, b
    assert b.alter_s is not None and 0 <= b.alter_s < 60
    z = ix.zaehler()
    assert z == {"dateien": 0, "mit_text": 0, "abschnitte": 0, "lesen_wiederholen": 1, "lesen_aufgegeben": 0}, z
    kopie = _datei("02_LOCATIONS/Police-Kopie.pdf")
    assert not ix.uebernehme(kopie, "p" * 64, RT, RA), "vorgemerkte Zeile wird nie übernommen"
    ix.vormerken(d, "p" * 64, "zeit", 3, RT)
    assert ix.zaehler()["lesen_aufgegeben"] == 1
    # Erfolgreich gelesen → Zähler 0, gilt als gelesen und ist übernehmbar.
    ix.speichere(d, "p" * 64, Text("neuer Stand"), "de", [Abschnitt(0, 1, "neuer Stand")], [_v(2)], RT, RA)
    assert ix.bestand()[d.pfad].versuche == 0 and ix.uebernehme(kopie, "p" * 64, RT, RA)
    assert _drei(ix.zaehler()) == {"dateien": 2, "mit_text": 2, "abschnitte": 2}
    # DDL ist wiederholbar (Spalte schon da) — neue Verbindung legt nichts doppelt an.
    ix.schliessen()
    assert TiefenIndex(DSN).bereit()
    ix.schliessen()


def test_suche_gegen_db() -> None:
    ix = TiefenIndex(DSN, statement_timeout_ms=5000)
    _leeren(ix)
    ix = TiefenIndex(DSN, statement_timeout_ms=5000)
    for i, (pfad, satz) in enumerate([
        ("02_LOCATIONS/Volkshaus/Mietvertrag.pdf", "Die Miete für den Saal beträgt pro Abend pauschal und ist im Voraus zahlbar."),
        ("00_ADMIN_RECHT/Leasing/Kopierer.pdf", "Leasingvertrag Kopierer, Laufzeit 36 Monate, verlängert sich um 12 Monate."),
        ("06_PERSONAL/0001_Anna_Muster/Arbeitsvertrag.pdf", "Arbeitsvertrag, Probezeit drei Monate, Kündigungsfrist zwei Monate."),
    ]):
        ix.speichere(_datei(pfad), f"{i}" * 64, Text(satz), "de", [Abschnitt(0, 1, satz)], [_v(i)], RT, RA)
    s = Suche(CFG, ix, _Llm(), stand=lambda: {"nas_dateien": 6})  # type: ignore[arg-type]
    e = nas_suche({"q": "Kopierer Laufzeit"}, s)
    assert e["treffer"][0]["pfad"] == "00_ADMIN_RECHT/Leasing/Kopierer.pdf", e
    assert e["index"] == {"dateien": 3, "gelesen_anteil": 0.5}
    assert all(set(t) == {"pfad", "seite", "score"} for t in e["treffer"])
    e2 = nas_suche({"q": "\"Probezeit drei\" OR Kündigungsfrist"}, s)  # websearch-Syntax
    assert any(t["pfad"].startswith("06_PERSONAL/") for t in e2["treffer"]), "Personalakten sind durchsuchbar (E4/E5)"
    ix.schliessen()


def test_lernen_auswertung() -> None:
    _leeren(TiefenIndex(DSN))
    ix = TiefenIndex(DSN)
    ix._ausfuehren(
        """CREATE TABLE archiv_dateien (pfad text PRIMARY KEY, ordner text NOT NULL, name text NOT NULL, groesse bigint,
             mtime double precision, sha256 text NOT NULL, rezept text, einbettung vector, indexiert timestamptz)"""
    )
    lern = Lernen(DSN)
    lern._sql("SELECT 1")  # legt die Tabellen an
    rows = [  # sha, Vorschlag, Alternativen
        ("1" * 64, "A/x", ["A/y", "A/z"]),     # tatsächlich A/x → top1
        ("2" * 64, "B/x", ["B/y", "C/z"]),     # tatsächlich C/z → top3
        ("3" * 64, None, []),                   # kein Vorschlag, tatsächlich D → Fehlschlag
        ("4" * 64, "E/x", []),                  # noch nicht abgelegt → offen
    ]
    for sha, o, alt in rows:
        lern._schreibe({"sha256": sha, "ordner_vorschlag": o, "alternativen": alt, "quelle": "ki", "modell": "m"})
    lern._schreibe({"sha256": "1" * 64, "ordner_vorschlag": "Q/falsch", "alternativen": [], "quelle": "ki", "modell": "m"})
    lern._sql("UPDATE ablage_vorschlaege SET zeit = zeit - interval '1 minute' WHERE ordner_vorschlag = 'Q/falsch'")
    for i, (sha, ordner) in enumerate([("1" * 64, "A/x"), ("2" * 64, "C/z"), ("3" * 64, "D")]):
        ix._ausfuehren("INSERT INTO archiv_dateien (pfad, ordner, name, sha256) VALUES (%s, %s, %s, %s)",
                       (f"{ordner}/f{i}.pdf", ordner, f"f{i}.pdf", sha))
    assert lern.auswerten() == {"bewertet": 4}
    tage = lern._sql("SELECT n, top1, top3, ohne_vorschlag FROM qualitaet_tag", holen=True)
    assert tage == [(3, 1, 2, 1)], tage  # je Datei und Tag nur der letzte Vorschlag (Q/falsch zählt nicht)
    st = lern.status()
    assert st["tage_7"] == {"n": 3, "top1": 0.333, "top3": 0.667} and st["offen"] == 1 and st["gemerkt"] == 5, st
    assert lern.auswerten() == {"bewertet": 0}, "idempotent"
    lern._sql("UPDATE ablage_vorschlaege SET zeit = now() - interval '91 days' WHERE sha256 = %s", ("4" * 64,))
    lern.auswerten()
    assert lern._sql("SELECT count(*) FROM ablage_vorschlaege", holen=True)[0][0] == 4, "nach 90 Tagen gelöscht"
    lern._conn.close()
    _leeren(ix)


if __name__ == "__main__":
    if not DSN:
        print("übersprungen — TEST_PG_DSN fehlt (nur gegen eine Wegwerf-Datenbank, siehe Kopf der Datei)")
        sys.exit(0)
    assert "eventline_ki" not in DSN, "nie gegen die Datenbank des Tresors"
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
