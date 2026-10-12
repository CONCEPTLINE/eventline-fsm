"""Speicher-Messung, Speicher-Tor und Wächter-Regeln (Masterplan §2.4, §2.5) — ohne Rig, mit Dateien im Temp.

  docker run --rm --network none -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_speicher.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.speicher import GIB, Messung, Quellen, WaechterRegel, bild, messen, tor  # noqa: E402

KB = 1024


def _quellen(d: Path, *, current: int, inactive_file: int, anon: int, mem_available: int,
             memory_max: str = str(22 * GIB), psi_full: str = "0.00", pgmajfault: int = 1000) -> Quellen:
    s = d / "slice"
    s.mkdir(exist_ok=True)
    (s / "memory.current").write_text(f"{current}\n")
    (s / "memory.max").write_text(f"{memory_max}\n")
    (s / "memory.stat").write_text(
        f"anon {anon}\nfile {current - anon}\nactive_file {current - anon - inactive_file}\n"
        f"inactive_file {inactive_file}\nshmem 5427200\n"
    )
    (d / "meminfo").write_text(
        f"MemTotal:       49242636 kB\nMemFree:         1000000 kB\nMemAvailable:   {mem_available // KB} kB\n"
        f"SwapTotal:       8388604 kB\nSwapFree:        8117756 kB\n"
    )
    (d / "psi").write_text(
        "some avg10=0.00 avg60=0.00 avg300=0.00 total=1490768\n"
        f"full avg10={psi_full} avg60=0.00 avg300=0.00 total=1454397\n"
    )
    (d / "vmstat").write_text(f"nr_free_pages 12345\npgmajfault {pgmajfault}\npgfault 99\n")
    return Quellen(meminfo=d / "meminfo", vmstat=d / "vmstat", psi=d / "psi", slice_dir=s)


def test_messen_liest_alle_werte() -> None:
    with tempfile.TemporaryDirectory() as t:
        q = _quellen(Path(t), current=8 * GIB, inactive_file=6 * GIB, anon=1 * GIB, mem_available=30 * GIB,
                     psi_full="1.25", pgmajfault=67464)
        m = messen(q, zeit=5.0)
        assert m.zeit == 5.0
        assert m.mem_available == 30 * GIB and m.swap_free == 8117756 * KB
        assert m.slice_current == 8 * GIB and m.slice_max == 22 * GIB and m.slice_anon == 1 * GIB
        assert m.slice_inactive_file == 6 * GIB and m.slice_active_file == 1 * GIB
        assert m.psi_full_avg10 == 1.25 and m.pgmajfault == 67464
        assert m.nicht_rueckgewinnbar == 2 * GIB, "memory.current − inactive_file"


def test_tor_viel_seitencache_offen() -> None:
    # Fall aus dem Vertrag: nach dem Tiefen-Index 20 GB im Slice, grösstenteils inaktiver Seitencache.
    # memory.current allein (20 + 17 > 22) hielte das Tor zu — richtig ist offen.
    with tempfile.TemporaryDirectory() as t:
        m = messen(_quellen(Path(t), current=20 * GIB, inactive_file=16 * GIB, anon=2 * GIB, mem_available=25 * GIB))
        assert m.nicht_rueckgewinnbar == 4 * GIB
        befund = tor(m, 17)
        assert befund.offen and befund.grund == "offen", befund


def test_tor_viel_anon_zu() -> None:
    with tempfile.TemporaryDirectory() as t:
        m = messen(_quellen(Path(t), current=8 * GIB, inactive_file=GIB // 2, anon=7 * GIB, mem_available=30 * GIB))
        befund = tor(m, 17)
        assert not befund.offen and befund.grund == "budget", befund
        # Der 12B-Rückfall (10 GB) passt noch: 7,5 + 10 ≤ 22.
        assert tor(m, 10).offen


def test_tor_genau_an_der_grenze() -> None:
    with tempfile.TemporaryDirectory() as t:
        m = messen(_quellen(Path(t), current=5 * GIB, inactive_file=0, anon=5 * GIB, mem_available=30 * GIB))
        assert tor(m, 17).offen, "5 + 17 = 22 ≤ 22"
        m2 = messen(_quellen(Path(t), current=5 * GIB + 4096, inactive_file=0, anon=5 * GIB, mem_available=30 * GIB))
        assert not tor(m2, 17).offen


def test_tor_mem_available_untergrenze() -> None:
    # KI hat Vorrang: Trust one wird verdrängt — nur MemAvailable < Bedarf/2 schliesst das Tor (Rig würde stocken).
    with tempfile.TemporaryDirectory() as t:
        offen = messen(_quellen(Path(t), current=GIB, inactive_file=0, anon=GIB, mem_available=int(8.5 * GIB)))
        assert tor(offen, 17).offen, "8,5 GB verfügbar ≥ 17/2"
        zu = messen(_quellen(Path(t), current=GIB, inactive_file=0, anon=GIB, mem_available=8 * GIB))
        befund = tor(zu, 17)
        assert not befund.offen and befund.grund == "verfuegbar", befund


def test_tor_budget_aus_memory_max_sonst_22() -> None:
    with tempfile.TemporaryDirectory() as t:
        m = messen(_quellen(Path(t), current=4 * GIB, inactive_file=0, anon=4 * GIB, mem_available=30 * GIB,
                            memory_max=str(20 * GIB)))
        assert m.budget == 20 * GIB and not tor(m, 17).offen, "Slice-Grenze gilt"
        m = messen(_quellen(Path(t), current=3 * GIB, inactive_file=0, anon=3 * GIB, mem_available=30 * GIB,
                            memory_max="max"))
        assert m.slice_max is None and m.budget == 22 * GIB and tor(m, 17).offen


def test_tor_ohne_slice_zu() -> None:
    # Slice nicht eingebunden/lesbar → lieber nicht laden als blind.
    with tempfile.TemporaryDirectory() as t:
        q = _quellen(Path(t), current=GIB, inactive_file=0, anon=GIB, mem_available=30 * GIB)
        q = Quellen(meminfo=q.meminfo, vmstat=q.vmstat, psi=q.psi, slice_dir=Path(t) / "fehlt")
        m = messen(q)
        assert m.slice_current is None and m.nicht_rueckgewinnbar is None
        befund = tor(m, 17)
        assert not befund.offen and befund.grund == "unbekannt"
        assert bild(m)["ki_slice_gb"] is None and bild(m)["verfuegbar_gb"] == 30.0


def test_waechter_mem_available() -> None:
    r = WaechterRegel(not_gb=1.0)
    assert r.pruefe(Messung(zeit=0, mem_available=2 * GIB)) is None
    assert r.pruefe(Messung(zeit=2, mem_available=GIB - 1)) == "mem_available"


def test_waechter_psi() -> None:
    r = WaechterRegel()
    assert r.pruefe(Messung(zeit=0, mem_available=10 * GIB, psi_full_avg10=30.0)) is None, "Grenze: > 30"
    assert r.pruefe(Messung(zeit=2, mem_available=10 * GIB, psi_full_avg10=30.5)) == "psi"


def test_waechter_swap_allein_kein_ausloeser() -> None:
    r = WaechterRegel()
    assert r.pruefe(Messung(zeit=0, mem_available=10 * GIB, swap_free=0, psi_full_avg10=5.0)) is None


def test_waechter_pgmajfault_erst_nach_10_s() -> None:
    r = WaechterRegel()
    zaehler = 0
    ausgeloest_bei = None
    for i in range(0, 8):   # alle 2 s, je 8000 Fehler = 4000/s
        t = i * 2.0
        g = r.pruefe(Messung(zeit=t, mem_available=10 * GIB, pgmajfault=zaehler))
        if g and ausgeloest_bei is None:
            ausgeloest_bei = t
            assert g == "pgmajfault"
        zaehler += 8000
    assert ausgeloest_bei == 10.0, f"erst nach 10 s am Stück über 3000/s, war {ausgeloest_bei}"


def test_waechter_pgmajfault_kurze_spitze() -> None:
    r = WaechterRegel()
    werte = [0, 8000, 16000, 24000, 24100, 32100, 40100, 48100, 48200]  # Unterbruch bei 8 s
    for i, z in enumerate(werte):
        assert r.pruefe(Messung(zeit=i * 2.0, mem_available=10 * GIB, pgmajfault=z)) is None, i
    # Zähler springt zurück (z. B. Neustart der Messung) → kein Fehlalarm.
    assert r.pruefe(Messung(zeit=20, mem_available=10 * GIB, pgmajfault=0)) is None


def test_tor_mit_puffer() -> None:
    # KI_HG_PUFFER_GB (3): Platz für Ablage/Diktat neben dem Hauptmodell — belegt + Bedarf + Puffer ≤ Budget.
    with tempfile.TemporaryDirectory() as t:
        m = messen(_quellen(Path(t), current=2 * GIB, inactive_file=0, anon=2 * GIB, mem_available=30 * GIB))
        assert tor(m, 17, 3).offen, "2 + 17 + 3 = 22 ≤ 22"
        m2 = messen(_quellen(Path(t), current=int(2.4 * GIB), inactive_file=0, anon=2 * GIB, mem_available=30 * GIB))
        befund = tor(m2, 17, 3)
        assert not befund.offen and befund.grund == "budget", "2,4 + 17 + 3 > 22"
        assert tor(m2, 17).offen, "ohne Puffer wäre es offen"
        assert tor(m2, 10, 3).offen, "12B-Rückfall passt mit Puffer"


def test_messen_liest_swap_des_slices() -> None:
    with tempfile.TemporaryDirectory() as t:
        q = _quellen(Path(t), current=8 * GIB, inactive_file=6 * GIB, anon=GIB, mem_available=30 * GIB)
        (q.slice_dir / "memory.swap.current").write_text(f"{266 * 1024 ** 2}\n")
        m = messen(q)
        assert m.slice_swap == 266 * 1024 ** 2 and bild(m)["ki_swap_gb"] == 0.3


def _slice(belegt_gb: float, swap_mb: float | None = None, zeit: float = 0.0) -> Messung:
    # Rig als Ganzes ruhig (MemAvailable 20 GB, PSI 0) — nur der Slice ist knapp.
    return Messung(zeit=zeit, mem_available=20 * GIB, slice_current=int(belegt_gb * GIB), slice_inactive_file=0,
                   slice_max=22 * GIB, slice_swap=None if swap_mb is None else int(swap_mb * 1024 ** 2),
                   psi_full_avg10=0.0, pgmajfault=0)


def test_waechter_slice_knapp_obwohl_rig_ruhig() -> None:
    # Befund Review E2: der Slice läuft voll, MemAvailable/PSI des Rigs merken nichts.
    r = WaechterRegel(not_gb=1.0)
    assert r.pruefe(_slice(20.9)) is None, "1,1 GB frei im Slice"
    assert r.pruefe(_slice(21.1)) == "ki_knapp", "weniger als KI_HG_NOT_GB frei im Slice"
    # Slice nicht lesbar → kein Fehlalarm aus diesem Signal.
    assert r.pruefe(Messung(zeit=0, mem_available=20 * GIB)) is None


def test_waechter_slice_swap_waechst() -> None:
    # Hauptmodell darf nicht auslagern — wächst der Swap des Slices, lagert der Kernel Ablage/Diktat/DB aus.
    r = WaechterRegel()
    assert r.pruefe(_slice(18, swap_mb=760)) is None, "Ausgangswert (Altbestand im Swap) ist kein Auslöser"
    assert r.pruefe(_slice(18, swap_mb=900, zeit=2)) is None, "+140 MB"
    assert r.pruefe(_slice(18, swap_mb=1100, zeit=4)) == "ki_swap", "+340 MB > 256 MB"
    r.zuruecksetzen()
    assert r.pruefe(_slice(18, swap_mb=1100)) is None, "neue Überwachung, neuer Ausgangswert"
    # Swap sinkt (zurückgelesen): Ausgangswert folgt nach unten, der Anstieg zählt ab dort.
    assert r.pruefe(_slice(18, swap_mb=500, zeit=2)) is None
    assert r.pruefe(_slice(18, swap_mb=800, zeit=4)) == "ki_swap"


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
