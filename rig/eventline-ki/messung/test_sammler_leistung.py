"""Tests für den Technik-Sammler: aktives Ein-/Auslagern (Neuregel RAM 15.10.2026) und Leistung der lokalen KI
(VERTRAG §2.6). Nur Standardbibliothek, ohne Rig, ohne Docker, ohne Netz.

    python3 messung/test_sammler_leistung.py          (oder mit pytest)
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

SAMMLER_PFAD = Path(__file__).resolve().parent / "technik_sammler.py"
_spec = importlib.util.spec_from_file_location("technik_sammler_test", SAMMLER_PFAD)
assert _spec and _spec.loader
sammler = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sammler)

STAND = "2026-10-15T15:20:00Z"

# Antwort der Rig-DB, wie psql sie zeilenweise liefert (echte Zahlen vom 15.10.2026)
DB_ZEILEN = {
    "auftraege": {
        "teil": "auftraege", "seit": "2026-10-02T20:50:12Z",
        "werte": {
            "7d": [
                {"art": "nacht_zz", "n": 282, "ok": 282, "median_ms": 3958, "max_ms": 13594},
                {"art": "nacht_fristen", "n": 73, "ok": 73, "median_ms": 1854, "max_ms": 6740},
                {"art": "nas_suche", "n": 41, "ok": 41, "median_ms": 59, "max_ms": 6235},
                {"art": "archiv_frage", "n": 2, "ok": 2, "median_ms": 10233, "max_ms": 14157},
            ],
            "30d": [{"art": "diktat", "n": 4, "ok": 4, "median_ms": 4066, "max_ms": 6258}],
            "alle": [{"art": "diktat", "n": 4, "ok": 4, "median_ms": 4066, "max_ms": 6258}],
        },
    },
    "gelesen": {
        "teil": "gelesen",
        "werte": {
            "7d": {"dateien": 449, "mit_text": 395, "gescannt": 88, "seiten": 668, "seiten_max": 80, "zeichen_max": 206385,
                   "mb_max": 17.5},
            "30d": {"dateien": 0, "mit_text": 0, "gescannt": 0, "seiten": 0, "seiten_max": None, "zeichen_max": None},
            "alle": {"dateien": 449},
        },
    },
    # seit 15.10.: exakte Lesezeit aus archiv_text.dauer_ms (eigener Teil)
    "lesezeit": {
        "teil": "lesezeit",
        "werte": {
            "7d": {"gemessen": 12, "s_seite_text": 0.21, "s_seite_gescannt": 3.4, "s_datei_median": 0.9, "s_datei_max": 61.5},
            "30d": {"gemessen": 0, "s_seite_text": None, "s_seite_gescannt": None, "s_datei_median": None, "s_datei_max": None},
            "alle": {"gemessen": 12, "s_seite_text": 0.21},
        },
    },
    # seit 15.10.: Dokumente der Aufträge aus ki_protokoll (Seiten, Zeichen, gescannt, Teile)
    "dokumente": {
        "teil": "dokumente",
        "werte": {
            "7d": [
                {"art": "nacht_zz", "mit_seiten": 270, "ms_seite_text": 1830, "ms_seite_gescannt": 4100, "seiten_max": 22,
                 "zeichen_max": 61234, "teile_max": 7},
                {"art": "ablage_analyse", "mit_seiten": 0, "ms_seite_text": None, "zeichen_max": 900},
            ],
            "30d": [], "alle": [],
        },
    },
    "fristen": {"teil": "fristen", "werte": {"7d": {"dateien": 395, "mit_frist": 73}, "30d": {"dateien": 1, "mit_frist": 5}, "alle": {"dateien": 395, "mit_frist": 73}}},
    "selbsttest": {
        "teil": "selbsttest",
        "werte": {"7d": {"laeufe": 3, "top1": 0.533, "top3": 0.683, "top1_ohne_name": 0.4, "top3_ohne_name": 0.6, "ms_median": 4603},
                  "30d": {"laeufe": 3}, "alle": {"laeufe": 3}},
        "laeufe": [
            {"am": "2026-10-13T03:42:22Z", "dateien": 40, "top1": 0.6, "top3": 0.75, "top1_ohne_name": 0.475, "top3_ohne_name": 0.725, "ms_median": 4879},
            {"am": "2026-10-15T03:37:46Z", "dateien": 40, "top1": 0.45, "top3": 0.65, "top1_ohne_name": 0.325, "top3_ohne_name": 0.575, "ms_median": 4355},
            {"am": "2026-10-14T03:38:27Z", "dateien": 40, "top1": 0.55, "top3": 0.65, "top1_ohne_name": 0.4, "top3_ohne_name": 0.5, "ms_median": 4574},
        ],
    },
    # seit 16.10.: Belegquote aus ki_protokoll.belege (zz/v4, fristen/v3)
    "belege": {
        "teil": "belege",
        "werte": {
            "7d": {"zz": 40, "fristen": 21, "felder": {"datum": {"angegeben": 30, "belegt": 27},
                                                       "status": {"angegeben": 12, "belegt": 11},
                                                       "beteiligte": {"angegeben": 90, "belegt": 84},
                                                       "fristen": {"angegeben": 6, "belegt": 5}}},
            "30d": {"zz": 0, "fristen": 0, "felder": {}},
            "alle": {"zz": 40, "fristen": 21, "felder": {"datum": {"angegeben": 30, "belegt": 27}}},
        },
    },
}


# --- Ein- und Auslagern -------------------------------------------------------------------------------------------


def test_vmstat_liest_nur_die_gesuchten_zaehler():
    text = "nr_free_pages 123\npswpin 2170034\npswpout 9552694\npgmajfault 843015\npswpin_kaputt x\nkaputt\n"
    assert sammler.vmstat_werte(sammler.VMSTAT_SWAP, text) == {"pswpin": 2170034, "pswpout": 9552694}
    assert sammler.vmstat_werte(sammler.VMSTAT_SWAP, "") == {}


def test_raten_in_bytes_je_sekunde_und_fuenf_minuten_mittel():
    s = sammler.Sammler.__new__(sammler.Sammler)  # ohne Threads; nur Rate und Messspeicher
    s.vorher = {}
    s.speicher = sammler.Speicher()
    assert s._rate("pswpout", 1000, 100.0) is None, "erste Messung: noch keine Rate"
    rate = s._rate("pswpout", 1000 + 2560, 110.0)  # 2560 Seiten in 10 s
    assert rate == 256.0 and rate * sammler.SEITE_B == 256 * sammler.SEITE_B
    assert s._rate("pswpout", 10, 120.0) is None, "Zaehler zurueckgesetzt (Neustart): keine Rate"
    for i in range(31):
        s.speicher.neu(1000.0 + i * 10, {"ram_swap_aus_bps": 10 * 1024 ** 2 if i >= 1 else None})
    assert s.speicher.mittel("ram_swap_aus_bps", 300, 1300.0) == 10 * 1024 ** 2


def test_minutenwerte_ohne_seitenfehler_mit_ein_auslagern():
    assert sammler.MINUTE_MITTEL["ram.swap_ein_bps"] == "ram_swap_ein_bps"
    assert sammler.MINUTE_MITTEL["ram.swap_aus_bps"] == "ram_swap_aus_bps"
    alle = list(sammler.MINUTE_MITTEL) + list(sammler.MINUTE_MAX)
    assert not [k for k in alle if "seitenfehler" in k]
    assert not hasattr(sammler, "vmstat_wert"), "alte Einzel-Abfrage ist weg"


# --- Leistung -----------------------------------------------------------------------------------------------------


def test_leistung_block_mit_echten_zahlen():
    b = sammler.leistung_block(json.loads(json.dumps(DB_ZEILEN)), STAND)
    assert b is not None
    assert b["stand"] == STAND and b["seit"] == "2026-10-02T20:50:12Z"
    assert list(b["zeitraeume"]) == ["7d", "30d", "alle"]
    z7 = b["zeitraeume"]["7d"]
    assert [a["art"] for a in z7["auftraege"]] == ["nacht_zz", "nacht_fristen", "nas_suche", "archiv_frage"]
    assert z7["auftraege"][0] == {"art": "nacht_zz", "n": 282, "ok": 282, "median_ms": 3958, "max_ms": 13594, "mit_seiten": 270,
                                  "ms_seite_text": 1830, "ms_seite_gescannt": 4100, "seiten_max": 22, "zeichen_max": 61234,
                                  "teile_max": 7}, "Dokument-Zahlen an der Art aus «auftraege»"
    assert "mit_seiten" not in z7["auftraege"][1], "Fristen haben keine Dokument-Zahlen"
    assert z7["gelesen"] == {**DB_ZEILEN["gelesen"]["werte"]["7d"], "gemessen": 12, "s_seite_text": 0.21,
                             "s_seite_gescannt": 3.4, "s_datei_median": 0.9, "s_datei_max": 61.5}
    assert z7["fristen_geprueft"] == {"dateien": 395, "mit_frist": 73}
    assert z7["selbsttest"] == {"laeufe": 3, "top1": 0.533, "top3": 0.683, "top1_ohne_name": 0.4, "top3_ohne_name": 0.6, "ms_median": 4603}
    assert b["zeitraeume"]["30d"]["gelesen"] == {"dateien": 0, "mit_text": 0, "gescannt": 0, "seiten": 0, "gemessen": 0}
    assert b["zeitraeume"]["alle"]["gelesen"] == {"dateien": 449, "gemessen": 12, "s_seite_text": 0.21}
    assert "fristen_geprueft" not in b["zeitraeume"]["30d"], "mehr Treffer als Dateien = Unsinn"
    assert [l["am"] for l in b["selbsttest"]] == ["2026-10-15T03:37:46Z", "2026-10-14T03:38:27Z", "2026-10-13T03:42:22Z"]
    assert z7["belege"] == DB_ZEILEN["belege"]["werte"]["7d"]
    assert "belege" not in b["zeitraeume"]["30d"], "keine Datei mit Belegen: kein Block (Panel: noch keine Messung)"


def test_leistung_belege_geprueft():
    roh = json.loads(json.dumps(DB_ZEILEN))
    roh["belege"]["werte"]["7d"] = {"zz": 5, "fristen": "3", "felder": {
        "datum": {"angegeben": 4, "belegt": 5},          # mehr belegt als angegeben: Unsinn
        "status": {"angegeben": "4", "belegt": 1},       # Text statt Zahl
        "pfad": {"angegeben": 1, "belegt": 1},           # unbekanntes Feld
        "bezug": {"angegeben": 0, "belegt": 0},          # nichts angegeben
        "rolle": {"angegeben": 7, "belegt": 2}, "absender": "viel"}}
    roh["belege"]["werte"]["alle"] = "kaputt"
    b = sammler.leistung_block(roh, STAND)
    assert b["zeitraeume"]["7d"]["belege"] == {"zz": 5, "fristen": 0, "felder": {"rolle": {"angegeben": 7, "belegt": 2}}}
    assert "belege" not in b["zeitraeume"]["alle"]
    del roh["belege"]
    assert "belege" not in sammler.leistung_block(roh, STAND)["zeitraeume"]["7d"], "Teil fehlt (Spalte noch nicht da)"


def test_leistung_weissliste_und_zahlenbereiche():
    roh = json.loads(json.dumps(DB_ZEILEN))
    roh["auftraege"]["werte"]["7d"] = [
        {"art": "trust_backtest", "n": 5, "ok": 5},
        {"art": "hg_laden", "n": 1, "ok": 1, "median_ms": 48867},
        {"art": "nas_suche", "n": 3, "ok": 4},
        {"art": "diktat", "n": 4, "ok": 4, "median_ms": 4066},
        {"art": "diktat", "n": 9, "ok": 9},
        {"art": "beleg_analyse", "n": "2", "ok": 2},
        {"art": "archiv_frage", "n": 2, "ok": 2, "median_ms": 90_000_000, "max_ms": True, "pfad": "/mnt/eventline-nas/x.pdf"},
    ]
    roh["gelesen"]["werte"]["7d"] = {"dateien": 10, "mit_text": 12, "seiten_max": "80", "s_seite_text": -1, "mb_max": 3.25,
                                     "name": "Vertrag.pdf"}
    roh["selbsttest"]["werte"]["7d"] = {"laeufe": 2, "top1": 1.2, "top3": 0.9, "ms_median": float("nan")}
    b = sammler.leistung_block(roh, STAND)
    z7 = b["zeitraeume"]["7d"]
    assert z7["auftraege"] == [{"art": "diktat", "n": 4, "ok": 4, "median_ms": 4066}, {"art": "archiv_frage", "n": 2, "ok": 2}]
    assert z7["gelesen"] == {"dateien": 10, "mb_max": 3.2}  # 3.25 -> 3.2 (Python rundet halbe gerade)
    assert z7["selbsttest"] == {"laeufe": 2, "top3": 0.9}
    assert "Vertrag" not in json.dumps(b) and "/mnt" not in json.dumps(b)


def test_leistung_dokumente_lesezeit_und_rapporte_geprueft():
    roh = json.loads(json.dumps(DB_ZEILEN))
    roh["auftraege"]["werte"]["7d"] = [
        {"art": "ablage_analyse", "n": 5, "ok": 4, "median_ms": 4400},
        {"art": "nas_suche", "n": 3, "ok": 3},
        {"art": "sicherheit_rapport", "n": 2, "ok": 2, "median_ms": 1900, "max_ms": 2300},
    ]
    roh["dokumente"]["werte"]["7d"] = [
        {"art": "ablage_analyse", "mit_seiten": 9, "ms_seite_text": 800, "seiten_max": 40, "zeichen_max": -3},  # 9 > 4 ok
        {"art": "nas_suche", "mit_seiten": 1, "seiten_max": 5},           # keine Dokument-Art
        {"art": "ablage_analyse", "mit_seiten": 1, "seiten_max": 99},      # doppelt: der erste zählt
        "kaputt",
    ]
    roh["lesezeit"]["werte"]["7d"] = {"gemessen": 500, "s_seite_text": 0.2}   # mehr gemessen als gelesen (449)
    b = sammler.leistung_block(roh, STAND)
    a = {x["art"]: x for x in b["zeitraeume"]["7d"]["auftraege"]}
    assert a["ablage_analyse"] == {"art": "ablage_analyse", "n": 5, "ok": 4, "median_ms": 4400, "ms_seite_text": 800,
                                   "seiten_max": 40}, a["ablage_analyse"]
    assert a["nas_suche"] == {"art": "nas_suche", "n": 3, "ok": 3}
    assert a["sicherheit_rapport"] == {"art": "sicherheit_rapport", "n": 2, "ok": 2, "median_ms": 1900, "max_ms": 2300}
    g = b["zeitraeume"]["7d"]["gelesen"]
    assert "gemessen" not in g and "s_seite_text" not in g, "Teilmenge grösser als das Ganze = Unsinn"
    # Fehlt der Teil «lesezeit» (Spalte noch nicht angelegt), bleiben die Zähler — ohne Zeiten, ohne «gemessen».
    del roh["lesezeit"], roh["dokumente"]
    b2 = sammler.leistung_block(roh, STAND)
    assert b2["zeitraeume"]["7d"]["gelesen"] == DB_ZEILEN["gelesen"]["werte"]["7d"]
    assert "ms_seite_text" not in json.dumps(b2)


def test_leistung_fehlende_teile():
    assert sammler.leistung_block({}, STAND) is None, "nichts lesbar: kein Block"
    nur = sammler.leistung_block({"gelesen": DB_ZEILEN["gelesen"]}, STAND)
    assert nur["zeitraeume"]["7d"]["auftraege"] == [] and nur["zeitraeume"]["7d"]["gelesen"]["dateien"] == 449
    assert "seit" not in nur and "selbsttest" not in nur
    kaputt = sammler.leistung_block({"auftraege": {"teil": "auftraege", "werte": "viel", "seit": "gestern"}}, STAND)
    assert kaputt["zeitraeume"]["alle"] == {"auftraege": []} and "seit" not in kaputt
    viele = {"selbsttest": {"teil": "selbsttest", "werte": {}, "laeufe": [
        {"am": f"2026-09-{i + 1:02d}T03:00:00Z", "dateien": 40, "top1": 0.5} for i in range(30)
    ] + [{"am": "2026-10-01T03:00:00Z", "dateien": 40}, {"dateien": 40}]}}
    assert len(sammler.leistung_block(viele, STAND)["selbsttest"]) == 30


def test_leistung_sql_nur_lesend_und_ohne_inhalte():
    verboten_schreiben = re.compile(r"\b(insert|update|delete|create|alter|drop|truncate|grant|revoke|copy|vacuum)\b", re.I)
    # Spalten mit Pfaden, Namen oder Inhalten: kommen in keiner Anweisung vor
    verboten_inhalt = re.compile(r"\b(pfad|name|text|ordner|partei|begruendung|beschrieb|sha256|typ|bedingungen|fakten)\b", re.I)
    assert len(sammler.LEISTUNG_SQL) == len(sammler.LEISTUNG_TEILE) == 7
    for teil, sql in zip(sammler.LEISTUNG_TEILE, sammler.LEISTUNG_SQL):
        assert f"'teil', '{teil}'" in sql, teil
    assert "lag(" not in " ".join(sammler.LEISTUNG_SQL), "kein Zeitstempel-Abstand mehr (exakte Lesezeit)"
    for sql in sammler.LEISTUNG_SQL:
        assert not verboten_schreiben.search(sql), sql[:80]
        treffer = verboten_inhalt.findall(sql)
        assert not treffer, f"{treffer} in {sql[:80]}"
    assert "default_transaction_read_only=on" in sammler.LEISTUNG_PGOPTIONS
    assert "statement_timeout" in sammler.LEISTUNG_PGOPTIONS


def test_leistung_messen_ruft_psql_lesend_im_container_auf():
    gesehen = {}

    def befehl(args, zeitlimit, env=None, sperre=None):
        gesehen["args"], gesehen["zeitlimit"] = args, zeitlimit
        zeilen = [json.dumps(v) for v in DB_ZEILEN.values()]
        return 1, "\n".join(["kaputt{", *zeilen, json.dumps({"teil": "fremd", "pfad": "/mnt/x"})]), "ERROR: irgendwas"

    alt = sammler.befehl
    sammler.befehl = befehl
    try:
        b = sammler.leistung_messen("a" * 64)
    finally:
        sammler.befehl = alt
    a = gesehen["args"]
    assert a[:5] == ["docker", "exec", "-e", sammler.LEISTUNG_PGOPTIONS, "a" * 64]
    assert a[5] == "psql" and ["-U", "eventline", "-d", "eventline_ki"] == a[a.index("-U"):a.index("-U") + 4]
    assert a.count("-c") == len(sammler.LEISTUNG_SQL) == 7 and gesehen["zeitlimit"] == sammler.LEISTUNG_ZEITLIMIT_S
    assert b is not None and b["zeitraeume"]["7d"]["gelesen"]["dateien"] == 449, "einzelne Fehler (rc 1) kosten nur ihren Teil"
    assert "/mnt" not in json.dumps(b)

    sammler.befehl = lambda *x, **y: (None, "", "zeitlimit")
    try:
        assert sammler.leistung_messen("a" * 64) is None
    finally:
        sammler.befehl = alt


def test_dienste_ids_nur_fuer_laufende_ki_container():
    ps = "\n".join(["b" * 64, "c" * 64, "d" * 64])
    inspect = [
        {"Id": "b" * 64, "Name": "/eventline-ki-db", "Config": {"Labels": {"com.docker.compose.project": "eventline-ki"}},
         "State": {"Status": "running", "Pid": 0}, "HostConfig": {}},
        {"Id": "c" * 64, "Name": "/eventline-ki-dienst", "Config": {"Labels": {"com.docker.compose.project": "eventline-ki"}},
         "State": {"Status": "exited", "Pid": 0}, "HostConfig": {}},
        {"Id": "d" * 64, "Name": "/eventline-ki-db", "Config": {"Labels": {"com.docker.compose.project": "trust-one"}},
         "State": {"Status": "running", "Pid": 0}, "HostConfig": {}},
    ]

    def befehl(args, zeitlimit, env=None, sperre=None):
        return 0, ps if args[1] == "ps" else json.dumps(inspect), ""

    alt = sammler.befehl
    sammler.befehl = befehl
    try:
        ids: dict[str, str] = {}
        d = sammler.dienste_messen(None, ids)
    finally:
        sammler.befehl = alt
    assert ids == {"datenbank": "b" * 64}, "nur laufend und nur mit dem Label eventline-ki"
    assert all("Id" not in x and "b" * 12 not in json.dumps(x) for x in d), "IDs nie im Paket"


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    fehler = 0
    for n, f in tests:
        try:
            f()
            print(f"ok   {n}")
        except Exception as e:  # noqa: BLE001
            fehler += 1
            print(f"FAIL {n}: {type(e).__name__}: {e}")
    print(f"{len(tests) - fehler}/{len(tests)} ok")
    sys.exit(1 if fehler else 0)
