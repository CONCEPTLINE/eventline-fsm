"""SQL der Nachtarbeit (NachtSpeicher) gegen eine WEGWERF-Datenbank (nie die des Tresors).

Ohne TEST_PG_DSN wird übersprungen. Mit Wegwerf-DB auf dem Rig (wie tests/test_tiefe_db.py):
  docker network create --internal ki-test-db
  docker run -d --rm --name ki-test-pg --network ki-test-db -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16
  docker run --rm --network ki-test-db -e TEST_PG_DSN="host=ki-test-pg user=postgres password=test dbname=postgres" \
    -v <stand>/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_nachtarbeit_db.py
  docker rm -f ki-test-pg; docker network rm ki-test-db
"""

from __future__ import annotations

import os
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import nachtarbeit as na  # noqa: E402
from app.jobs import fristen as fj  # noqa: E402
from app.jobs import zz as zj  # noqa: E402
from app.tiefe import DDL as TIEFE_DDL  # noqa: E402

DSN = os.environ.get("TEST_PG_DSN")
SHA = "a" * 64


def _frist(ende: str) -> fj.Frist:
    return fj.Frist("ablauf", {"beginn": None, "ende": ende, "faellig": None, "laufzeit_monate": None,
                               "verlaengerung_monate": None, "kuendigungsfrist": None}, 2, "hoch")


def _vorbereiten() -> na.NachtSpeicher:
    import psycopg

    with psycopg.connect(DSN, autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS archiv_karte, archiv_fristen, zz_vorschlaege, selbsttest_laeufe, "
                  "archiv_abschnitte, archiv_text, archiv_dateien CASCADE")
        c.execute(TIEFE_DDL)
        for pfad, zeichen in (("a/vertrag.pdf", 50), ("ZZ_Alt/scan.pdf", 0)):
            c.execute("""INSERT INTO archiv_text (pfad, ordner, name, groesse, mtime, sha256, rezept_text, zeichen, text)
                         VALUES (%s, %s, %s, 1, 1, %s, 'r', %s, %s)""",
                      (pfad, pfad.rsplit("/", 1)[0], pfad.rsplit("/", 1)[1], SHA, zeichen, "Kündigung" if zeichen else ""))
    return na.NachtSpeicher(DSN)


def test_alles() -> None:
    s = _vorbereiten()
    assert s.archiv_dateien() == [], "fehlt der Vorbilder-Index, ist die Liste leer"
    texte = {t.pfad: t for t in s.texte()}
    assert set(texte) == {"ZZ_Alt/scan.pdf", "a/vertrag.pdf"} and texte["a/vertrag.pdf"].zeichen == 50
    assert s.text("a/vertrag.pdf", SHA) == "Kündigung" and s.text("a/vertrag.pdf", "b" * 64) is None

    # Karte: Fehler zählt hoch, ein Erfolg setzt zurück.
    s.speichere_karte("a/vertrag.pdf", SHA, fj.REZEPT, "fehler", None, None)
    s.speichere_karte("a/vertrag.pdf", SHA, fj.REZEPT, "fehler", None, None)
    assert s.karten(fj.REZEPT) == {"a/vertrag.pdf": (SHA, "fehler", 2)}
    befund = fj.FristBefund(status="fertig", typ="vertrag", dok_datum="2024-01-12", partei="Canon AG",
                            fristen=[_frist("2027-01-31"), _frist("2028-01-31")], zaehler=Counter(), modell="gemma3:4b")
    assert s.speichere_fristen("a/vertrag.pdf", SHA, befund, "2026-10-12-nacht") == 2
    assert s.speichere_fristen("a/vertrag.pdf", SHA, befund, "2026-10-12-nacht") == 0, "UNIQUE(pfad, art, bedingungen)"
    s.speichere_karte("a/vertrag.pdf", SHA, fj.REZEPT, "fertig", befund, "gemma3:4b")
    assert s.karten(fj.REZEPT) == {"a/vertrag.pdf": (SHA, "fertig", 1)} and s.karten("anderes/v9") == {}

    # ZZ: Fehler → Vorschlag überschreibt; ein Vorschlag wird nie überschrieben.
    s.speichere_zz("ZZ_Alt/scan.pdf", SHA, zj.REZEPT, "fehler", None, "l1", grund="modell")
    s.speichere_zz("ZZ_Alt/scan.pdf", SHA, zj.REZEPT, "fehler", None, "l1", grund="modell")
    assert s.zz_stand(zj.REZEPT) == {("ZZ_Alt/scan.pdf", SHA): ("fehler", 2)}
    b = zj.ZzBefund(status="vorschlag", ordner_ist="ZZ_Alt", ziel="00_ADMIN/02_Versicherungen", alternativen=[],
                    sicherheit="mittel", quelle="modell", begruendung="Police", modell="gemma3:4b")
    s.speichere_zz("ZZ_Alt/scan.pdf", SHA, zj.REZEPT, "vorschlag", b, "l2")
    s.speichere_zz("ZZ_Alt/scan.pdf", SHA, zj.REZEPT, "kein_ziel", None, "l3", grund="keiner")
    assert s.zz_stand(zj.REZEPT)[("ZZ_Alt/scan.pdf", SHA)][0] == "vorschlag"

    # Puffer und Meldung.
    assert s.puffer() == 3
    v, f = s.offene_meldungen(200, zz=True, fristen=True)
    assert len(v) == 1 and len(f) == 2
    assert v[0]["eintrag"] == {"art": "zz", "pfad": "ZZ_Alt/scan.pdf", "sha256": SHA, "ordner_ist": "ZZ_Alt",
                               "ziel_ordner": "00_ADMIN/02_Versicherungen", "alternativen": [], "sicherheit": "mittel",
                               "quelle": "modell", "begruendung": "Police"}
    assert f[0]["eintrag"]["bedingungen"]["ende"] == "2027-01-31" and f[0]["eintrag"]["partei"] == "Canon AG"
    assert f[0]["lauf_id"] == "2026-10-12-nacht"
    assert s.offene_meldungen(2, zz=True, fristen=True)[1][0]["id"] == f[0]["id"], "höchstens n zusammen"
    assert s.offene_meldungen(200, zz=False, fristen=True)[0] == []
    s.markiere("zz_vorschlaege", [(v[0]["id"], "ok")])
    s.markiere("archiv_fristen", [(f[0]["id"], "frist_vergangen")])
    assert s.puffer() == 1
    z = s.zaehler()
    assert z["zz"]["vorschlag"] == 1 and z["zz"]["gemeldet"] == 1 and z["fristen"]["abgewiesen"] == 1
    assert z["karten"] == {"fertig": 1}

    s.speichere_selbsttest("2026-10-12/nacht", 20261012, {"ordnerwahl": {"einsortiert": {"top1": 0.5}}, "egress": {"ok": True}})
    letzter = s.letzter_selbsttest()
    assert letzter is not None and letzter["seed"] == 20261012 and letzter["egress"] == {"ok": True}
    s.schliessen()


if __name__ == "__main__":
    if not DSN:
        print("übersprungen — TEST_PG_DSN fehlt (nur gegen eine Wegwerf-Datenbank, siehe Kopf der Datei)")
        sys.exit(0)
    try:
        test_alles()
        print("ok      test_alles")
        print("1/1 bestanden")
    except Exception as e:  # noqa: BLE001
        print(f"FEHLER  test_alles: {type(e).__name__}: {e}")
        sys.exit(1)
