"""Leistung der lokalen KI gegen eine WEGWERF-Datenbank (nie die des Tresors): Schema-Nachträge vom 15.10.2026
(ki_protokoll: seiten/zeichen/gescannt/teile, archiv_text.dauer_ms — idempotent, alte Zeilen bleiben) und das
SQL des Technik-Sammlers (LEISTUNG_SQL, nur lesend) mit echten Zeilen, die der Dienst selbst schreibt.

Ohne TEST_PG_DSN wird übersprungen. Mit Wegwerf-DB auf dem Rig (wie tests/test_tiefe_db.py):
  docker network create --internal ki-test-db
  docker run -d --rm --name ki-test-pg --network ki-test-db -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16
  docker run --rm --network ki-test-db -e TEST_PG_DSN="host=ki-test-pg user=postgres password=test dbname=postgres" \
    -v <stand>:/k:ro -w /k/messung eventline-ki/dienst:local python test_sammler_leistung_db.py
  docker rm -f ki-test-pg; docker network rm ki-test-db
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

HIER = Path(__file__).resolve().parent
sys.path.insert(0, str(HIER.parent / "dienst"))

import psycopg  # noqa: E402

from app import nachtarbeit as na  # noqa: E402
from app.config import laden  # noqa: E402
from app.protokoll import Protokoll  # noqa: E402
from app.tiefe import Abschnitt, NasDatei, Text, TiefenIndex, abschnitt_rezept, text_rezept  # noqa: E402

_spec = importlib.util.spec_from_file_location("technik_sammler_db_test", HIER / "technik_sammler.py")
assert _spec and _spec.loader
sammler = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sammler)

DSN = os.environ.get("TEST_PG_DSN")
CFG = laden()
RT, RA = text_rezept(CFG), abschnitt_rezept(CFG)

# Schema wie vor dem 15.10. (ohne die neuen Spalten) — so steht es heute im Tresor.
ALT_PROTOKOLL = """CREATE TABLE ki_protokoll (id bigserial PRIMARY KEY, zeit timestamptz NOT NULL DEFAULT now(),
  art text NOT NULL, quelle text NOT NULL, dauer_ms integer, modell text, ok boolean NOT NULL, fehler text)"""
ALT_ARCHIV_TEXT = """CREATE TABLE archiv_text (pfad text PRIMARY KEY, ordner text NOT NULL, name text NOT NULL,
  groesse bigint NOT NULL, mtime double precision NOT NULL, sha256 text NOT NULL, rezept_text text NOT NULL,
  rezept_abschnitte text, seiten integer, ocr boolean NOT NULL DEFAULT false, sprache text,
  zeichen integer NOT NULL DEFAULT 0, text text NOT NULL DEFAULT '', fehler text,
  extrahiert timestamptz NOT NULL DEFAULT now(), versuche integer NOT NULL DEFAULT 0)"""


def _sql(sql: str, werte: tuple = (), *, holen: bool = False, nur_lesen: bool = False) -> list[tuple]:
    with psycopg.connect(DSN, autocommit=True) as c, c.cursor() as cur:
        if nur_lesen:
            cur.execute("SET default_transaction_read_only = on")
        cur.execute(sql, werte)
        return list(cur.fetchall()) if holen else []


def _spalten(tabelle: str) -> set[str]:
    return {z[0] for z in _sql("SELECT column_name FROM information_schema.columns WHERE table_name = %s", (tabelle,), holen=True)}


def _datei(pfad: str) -> NasDatei:
    ordner, _, name = pfad.rpartition("/")
    return NasDatei(pfad=pfad, ordner=ordner, name=name, voll=Path("/nicht/da"), groesse=1000, mtime=1.0)


def test_schema_nachtrag_idempotent_alte_zeilen_bleiben() -> None:
    _sql("DROP TABLE IF EXISTS ki_protokoll, archiv_abschnitte, archiv_text CASCADE")
    _sql(ALT_PROTOKOLL)
    _sql("INSERT INTO ki_protokoll (art, quelle, dauer_ms, modell, ok) VALUES ('nas_suche', 'fsm', 59, 'bge-m3', true)")
    _sql(ALT_ARCHIV_TEXT)
    _sql("INSERT INTO archiv_text (pfad, ordner, name, groesse, mtime, sha256, rezept_text, zeichen, text) "
         "VALUES ('A/alt.pdf', 'A', 'alt.pdf', 1, 1.0, %s, %s, 5, 'alter')", ("a" * 64, RT))
    for _ in range(2):  # zwei Starts des Dienstes: beim zweiten ist alles schon da
        p = Protokoll(DSN)
        assert p.start(versuche=1)
        p.schliessen()
        ix = TiefenIndex(DSN)
        assert ix.bereit()
        ix.schliessen()
    assert {"seiten", "zeichen", "gescannt", "teile"} <= _spalten("ki_protokoll")
    assert "dauer_ms" in _spalten("archiv_text")
    assert _sql("SELECT art, dauer_ms, seiten FROM ki_protokoll", holen=True) == [("nas_suche", 59, None)]
    assert _sql("SELECT pfad, dauer_ms FROM archiv_text", holen=True) == [("A/alt.pdf", None)], "alt: nie nachträglich geschätzt"


def test_protokoll_und_lesezeit_schreiben() -> None:
    test_schema_nachtrag_idempotent_alte_zeilen_bleiben()
    p = Protokoll(DSN)
    assert p.start(versuche=1)
    p.schreibe("ablage_analyse", "fsm", 6000, "gemma3:4b", True, seiten=3, zeichen=4200, gescannt=False, teile=1)
    p.schreibe("ablage_analyse", "fsm", 9000, "gemma3:4b", True, seiten=2, zeichen=900, gescannt=True, teile=1)
    p.schreibe("ablage_analyse", "fsm", 800, "gemma3:4b", False, "Modell weg", seiten=40, zeichen=1, gescannt=False, teile=1)
    p.schreibe("beleg_analyse", "fsm", 3000, "gemma3:4b", True, seiten=1, gescannt=True, teile=1)
    p.schreibe("nacht_zz", "nacht", 20000, "gemma3:4b", True, seiten=10, zeichen=31000, gescannt=False, teile=4)
    p.schreibe("sicherheit_rapport", "rig", 1500, "gemma3:4b", True)
    p.schreibe("nacht_zz", "nacht", 50, "gemma3:4b", True, seiten=-1, zeichen=True, gescannt="ja", teile=10**9)  # Unsinn
    p.schliessen()
    z = _sql("SELECT art, seiten, zeichen, gescannt, teile FROM ki_protokoll WHERE art = 'nacht_zz' ORDER BY id", holen=True)
    assert z == [("nacht_zz", 10, 31000, False, 4), ("nacht_zz", None, None, None, None)], z
    ix = TiefenIndex(DSN)
    text = "[Seite 1]\nVertrag\n\n[Seite 2]\nKündigung"
    ix.speichere(_datei("B/text.pdf"), "b" * 64, Text(text, seiten=2), "de", [Abschnitt(0, 1, "Vertrag Kündigung")],
                 [[1.0, 0.0]], RT, RA, dauer_ms=400)
    # Gescannt mit 80 Seiten: der Index erkennt höchstens die ersten N (Rezept «ocrN») — je Seite durch min(80, N).
    ix.speichere(_datei("B/scan.pdf"), "c" * 64, Text("[Seite 1]\nScan", seiten=80, ocr=True), "de",
                 [Abschnitt(0, 1, "Scan Text")], [[0.0, 1.0]], RT, RA, dauer_ms=90_000)
    ix.speichere(_datei("B/tabelle.xlsx"), "d" * 64, Text("Tabelle"), None, [Abschnitt(0, None, "Tabelle Zahlen")],
                 [[1.0, 1.0]], RT, RA, dauer_ms=1200)
    assert ix.uebernehme(_datei("C/kopie.pdf"), "b" * 64, RT, RA)
    ix.speichere(_datei("B/kaputt.pdf"), "e" * 64, Text("", fehler="unlesbar"), None, [], [], RT, RA, dauer_ms=None)
    werte = dict(_sql("SELECT pfad, dauer_ms FROM archiv_text", holen=True))
    assert werte == {"A/alt.pdf": None, "B/text.pdf": 400, "B/scan.pdf": 90_000, "B/tabelle.xlsx": 1200,
                     "C/kopie.pdf": None, "B/kaputt.pdf": None}, werte
    ix.schliessen()


def test_sammler_sql_gegen_echte_zeilen() -> None:
    test_protokoll_und_lesezeit_schreiben()
    _sql("DROP TABLE IF EXISTS archiv_karte, archiv_fristen, zz_vorschlaege, selbsttest_laeufe CASCADE")
    _sql(na.DDL)
    _sql("INSERT INTO selbsttest_laeufe (fenster, seed, kennzahlen) VALUES ('2026-10-15/nacht', 1, %s)",
         (json.dumps({"ordnerwahl": {"einsortiert": {"dateien": 40, "top1": 0.55, "top3": 0.75, "ms_median": 4400},
                                     "neutral": {"top1": 0.4, "top3": 0.5}}}),))
    teile: dict = {}
    for sql in sammler.LEISTUNG_SQL:  # wie der Sammler: jede Anweisung allein, nur lesend
        (zeile,) = _sql(sql, holen=True, nur_lesen=True)
        teile[zeile[0]["teil"]] = zeile[0]
    assert set(teile) == set(sammler.LEISTUNG_TEILE)
    b = sammler.leistung_block(teile, "2026-10-15T20:00:00Z")
    z = b["zeitraeume"]["7d"]
    a = {x["art"]: x for x in z["auftraege"]}
    # Ablage: Median je Seite nur über die erfolgreichen — Text 6000/3 = 2000 ms, gescannt 9000/2 = 4500 ms
    assert a["ablage_analyse"] == {"art": "ablage_analyse", "n": 3, "ok": 2, "median_ms": 7500, "max_ms": 9000,
                                   "mit_seiten": 2, "ms_seite_text": 2000, "ms_seite_gescannt": 4500, "seiten_max": 3,
                                   "zeichen_max": 4200, "teile_max": 1}, a["ablage_analyse"]
    assert a["beleg_analyse"]["ms_seite_gescannt"] == 3000 and "zeichen_max" not in a["beleg_analyse"]
    assert a["nacht_zz"]["teile_max"] == 4 and a["nacht_zz"]["ms_seite_text"] == 2000
    assert a["sicherheit_rapport"] == {"art": "sicherheit_rapport", "n": 1, "ok": 1, "median_ms": 1500, "max_ms": 1500}
    g = z["gelesen"]
    # 5 gelesen ohne Fehler (alt, text, scan, tabelle, kopie); gemessen nur die 3 mit Lesezeit
    assert (g["dateien"], g["gemessen"], g["seiten_max"]) == (5, 3, 80), g
    ocr_n = int(RT.split("|ocr")[1].split("|")[0])
    assert g["s_seite_text"] == 0.2, "400 ms / 2 Seiten"
    assert g["s_seite_gescannt"] == round(90.0 / min(80, ocr_n), 2), (g, ocr_n)
    assert g["s_datei_median"] == 1.2 and g["s_datei_max"] == 90.0
    assert z["selbsttest"]["laeufe"] == 1 and b["selbsttest"][0]["top1"] == 0.55
    assert "B/" not in json.dumps(b) and "pdf" not in json.dumps(b), "nie Pfade"
    _sql("DROP TABLE IF EXISTS ki_protokoll, archiv_abschnitte, archiv_text, archiv_karte, archiv_fristen, zz_vorschlaege, "
         "selbsttest_laeufe CASCADE")


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
