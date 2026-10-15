"""Tests für den Technik-Sammler: geladene KI-Modelle beider Ollama-Instanzen (Prozess, /api/ps, Manifeste) und die
Belegung des Arbeitsspeichers (Nachtrag 15.10.2026). Nur Standardbibliothek, ohne Rig, ohne Docker, ohne Netz.

    python3 messung/test_sammler_ki_modelle.py
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import time
from pathlib import Path

SAMMLER_PFAD = Path(__file__).resolve().parent / "technik_sammler.py"
_spec = importlib.util.spec_from_file_location("technik_sammler_ki_test", SAMMLER_PFAD)
assert _spec and _spec.loader
sammler = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sammler)

BLOB_26B = "2" * 64
BLOB_4B = "a" * 64
BLOB_BGE = "b" * 64


def _manifeste(wurzel: Path) -> Path:
    ordner = wurzel / "models"
    for (raum, modell, tag), blob in {("library", "gemma4", "26b-a4b-it-qat"): BLOB_26B, ("library", "gemma3", "4b"): BLOB_4B,
                                      ("library", "gemma3", "latest"): BLOB_4B, ("library", "bge-m3", "latest"): BLOB_BGE,
                                      ("leo", "versuch", "1"): "c" * 64}.items():
        p = ordner / "manifests" / "registry.ollama.ai" / raum / modell / tag
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"layers": [
            {"mediaType": "application/vnd.ollama.image.model", "digest": f"sha256:{blob}"},
            {"mediaType": "application/vnd.ollama.image.template", "digest": "sha256:" + "f" * 64},
        ]}), encoding="utf-8")
    kaputt = ordner / "manifests" / "registry.ollama.ai" / "library" / "kaputt" / "x"
    kaputt.parent.mkdir(parents=True)
    kaputt.write_text("{nicht json", encoding="utf-8")
    return ordner


def _prozess(proc: Path, pid: int, *, blob: str, ctx: int, einbettung: bool = False, ticks: int = 0,
             rss_kb: int = 1000, anon_kb: int = 800, comm: str = "llama-server", start: int = 4242) -> None:
    p = proc / str(pid)
    p.mkdir(parents=True, exist_ok=True)
    (p / "comm").write_text(comm + "\n", encoding="utf-8")
    argv = ["/usr/lib/ollama/llama-server", "--model", f"/root/.ollama/models/blobs/sha256-{blob}", "--port", "1",
            "-c", str(ctx)] + (["--embedding"] if einbettung else [])
    (p / "cmdline").write_bytes("\0".join(argv).encode() + b"\0")
    felder = ["S", "1", "1", "1", "0", "-1", "0", "0", "0", "0", "0", str(ticks), "0", "0", "0", "20", "0", "1", "0",
              str(start)] + ["0"] * 30
    (p / "stat").write_text(f"{pid} (llama-server) " + " ".join(felder), encoding="utf-8")
    (p / "status").write_text(f"Name:\tllama-server\nVmRSS:\t{rss_kb} kB\nRssAnon:\t{anon_kb} kB\nRssFile:\t1 kB\n",
                              encoding="utf-8")


def test_manifeste_ordnen_blobs_den_modellnamen_zu():
    with tempfile.TemporaryDirectory() as d:
        karte = sammler.blob_namen(_manifeste(Path(d)))
    assert karte[BLOB_26B] == ["gemma4:26b-a4b-it-qat"]
    assert sorted(karte[BLOB_4B]) == ["gemma3:4b", "gemma3:latest"], "ein Blob kann mehrere Namen tragen"
    assert karte["c" * 64] == ["leo/versuch:1"]
    assert sammler.manifest_name(("andere.registry", "x", "y", "z")) == "andere.registry/x/y:z"
    assert sammler.manifest_name(("registry.ollama.ai", "library", "böse name", "1")) is None
    assert sammler.blob_namen(Path("/gibt/es/nicht")) == {}


def test_prozesse_nur_aus_dem_container_und_nur_llama_server():
    with tempfile.TemporaryDirectory() as d:
        proc, cg = Path(d) / "proc", Path(d) / "cg"
        cg.mkdir()
        _prozess(proc, 11, blob=BLOB_4B, ctx=8192, ticks=500, rss_kb=4_000_000, anon_kb=3_000_000)
        _prozess(proc, 12, blob=BLOB_BGE, ctx=4096, einbettung=True)
        _prozess(proc, 13, blob=BLOB_4B, ctx=8192, comm="ollama")          # kein llama-server
        _prozess(proc, 99, blob=BLOB_26B, ctx=16384)                         # anderer Container: nicht in cgroup.procs
        (cg / "cgroup.procs").write_text("11\n12\n13\n14\n", encoding="utf-8")  # 14 gibt es nicht mehr
        liste = sammler.llama_prozesse(cg, proc)
    assert [p["pid"] for p in liste] == [11, 12]
    a, b = liste
    assert (a["blob"], a["kontext"], a["einbettung"], a["ticks"], a["start"]) == (BLOB_4B, 8192, False, 500, "4242")
    assert (a["rss_b"], a["ram_b"]) == (4_000_000 * 1024, 3_000_000 * 1024)
    assert b["einbettung"] is True and b["kontext"] == 4096


def test_ps_auswerten_nur_namen_der_weissliste_und_zahlen():
    jetzt = time.time()
    bald = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(jetzt + 600)) + ".123456789Z"
    roh = [{"name": "gemma4:26b-a4b-it-qat", "size": 15651370432, "size_vram": 0, "expires_at": bald, "context_length": 16384,
            "digest": "x" * 64, "details": {"family": "gemma4"}},
           {"name": "gemma3:4b", "size": 4_000_000_000, "size_vram": 2_400_000_000, "expires_at": "2318-01-01T00:00:00Z"},
           {"name": "rm -rf /", "size": 1}, {"name": 5}, {"size": 1}]
    a = sammler.ps_auswerten(roh, jetzt)
    assert [m["name"] for m in a] == ["gemma4:26b-a4b-it-qat", "gemma3:4b"]
    assert a[0] == {"name": "gemma4:26b-a4b-it-qat", "groesse_b": 15651370432, "vram_b": 0, "kontext": 16384,
                    "entlaedt_am": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(jetzt + 600))}
    assert "entlaedt_am" not in a[1], "keep_alive -1 (Datum weit voraus) ist kein Zeitpunkt"
    assert "digest" not in json.dumps(a) and "family" not in json.dumps(a)
    assert sammler.ollama_ps("8.8.8.8") is None, "nie eine Adresse ausserhalb"
    assert sammler.interne_adresse("172.20.0.2") and not sammler.interne_adresse("example.org")


def test_zusammenfuehren_je_instanz():
    namen = {BLOB_26B: ["gemma4:26b-a4b-it-qat"], BLOB_4B: ["gemma3:4b", "gemma3:latest"], BLOB_BGE: ["bge-m3:latest"]}
    proz = {
        "gruendlich": [{"pid": 7, "start": "1", "ticks": 0, "blob": BLOB_26B, "kontext": 16384, "einbettung": False,
                        "rss_b": 17 * 2**30, "ram_b": 16 * 2**30}],
        "schnell": [{"pid": 8, "start": "1", "ticks": 0, "blob": BLOB_4B, "kontext": 8192, "einbettung": False,
                     "rss_b": 3 * 2**30, "ram_b": 2 * 2**30},
                    {"pid": 9, "start": "1", "ticks": 0, "blob": BLOB_BGE, "kontext": 4096, "einbettung": True,
                     "rss_b": 2**30, "ram_b": 2**29}],
    }
    ps = {"gruendlich": [{"name": "gemma4:26b-a4b-it-qat", "groesse_b": 15651370432, "vram_b": 0, "kontext": 16384}],
          "schnell": [{"name": "gemma3:latest", "groesse_b": 4_000_000_000, "vram_b": 4_000_000_000},
                      {"name": "qwen2.5vl:3b", "groesse_b": 3_200_000_000, "vram_b": 1_600_000_000}]}
    cpu = {(7, "1"): 980.4, (8, "1"): 3.0}
    m = sammler.ki_modelle_bauen(proz, ps, namen, cpu)
    je = {(x["instanz"], x.get("name")): x for x in m}
    g = je[("gruendlich", "gemma4:26b-a4b-it-qat")]
    assert (g["rolle"], g["zustand"], g["rechnet"], g["cpu_prozent"], g["vram_b"]) == ("sprache", "geladen", True, 980.4, 0)
    s = je[("schnell", "gemma3:latest")]
    assert s["rechnet"] is False and s["kontext"] == 8192, "Name aus /api/ps, wenn der Blob passt"
    e = je[("schnell", "bge-m3:latest")]
    assert e["rolle"] == "einbettung" and e["zustand"] == "laedt" and "rechnet" not in e, "Prozess ohne /api/ps = lädt"
    q = je[("schnell", "qwen2.5vl:3b")]
    assert q["zustand"] == "geladen" and "cpu_prozent" not in q, "laut Ollama geladen, Prozess nicht gefunden"
    # /api/ps nicht erreichbar: Prozesse trotzdem, Name aus dem Manifest, Zustand nicht «lädt»
    m2 = sammler.ki_modelle_bauen(proz, {"gruendlich": None, "schnell": None}, namen, {})
    assert {x["name"]: x["zustand"] for x in m2} == {"gemma4:26b-a4b-it-qat": "geladen", "gemma3:4b": "geladen",
                                                      "bge-m3:latest": "geladen"}
    assert all("rechnet" not in x for x in m2), "ohne zweite Messung keine Aussage"
    assert len(sammler.ki_modelle_bauen({"schnell": proz["schnell"] * 5}, {}, namen, {})) == sammler.KI_MODELLE_MAX


def test_cpu_im_mittel_seit_der_letzten_messung():
    s = sammler.Sammler.__new__(sammler.Sammler)
    s.llama_vorher, s.blob_karte, s.blob_zeit = {}, {BLOB_26B: ["gemma4:26b-a4b-it-qat"]}, time.time()
    ticks = {"n": 1000}
    alt = sammler.llama_prozesse
    sammler.llama_prozesse = lambda cg: [{"pid": 7, "start": "1", "ticks": ticks["n"], "blob": BLOB_26B, "kontext": 16384,
                                          "einbettung": False, "rss_b": 1, "ram_b": 1}]
    try:
        ziele = {"gruendlich": {"cid": "e" * 64, "ip": "172.20.0.2"}}
        erste = s.ki_modelle(100.0, ziele, {})
        ticks["n"] += 10 * sammler.TICKS_S * 10   # 10 s lang 10 Kerne
        zweite = s.ki_modelle(110.0, ziele, {})
    finally:
        sammler.llama_prozesse = alt
    assert "cpu_prozent" not in erste[0]
    assert zweite[0]["cpu_prozent"] == 1000.0 and zweite[0]["rechnet"] is True
    assert s.ki_modelle(120.0, {}, {}) is None, "ohne bekannte Container keine Aussage"


def test_ram_belegung_summen_passen():
    gib = 2**30
    mi = {"MemTotal": 46 * gib, "MemAvailable": 16 * gib}
    b = sammler.ram_belegung(mi, {"fest_b": 18 * gib}, 9 * gib, [{"ram_b": 16 * gib}, {"ram_b": None}])
    assert b == {"ki_modelle_b": 16 * gib, "ki_rest_b": 2 * gib, "trustone_b": 9 * gib, "system_b": 3 * gib,
                 "verfuegbar_b": 16 * gib}
    assert sum(b.values()) == mi["MemTotal"]
    # Modelle grösser als der ganze KI-Bereich (Messungen zu verschiedenen Zeiten): nie negativ, nie mehr als der Bereich
    b2 = sammler.ram_belegung(mi, {"fest_b": gib}, 0, [{"ram_b": 3 * gib}])
    assert b2["ki_modelle_b"] == gib and b2["ki_rest_b"] == 0 and b2["system_b"] == 29 * gib
    assert sammler.ram_belegung(mi, None, 0, []) is None and sammler.ram_belegung({}, {"fest_b": 1}, 0, []) is None


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
