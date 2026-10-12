#!/usr/bin/env python3
"""Auswertung des Speicherprofils (Masterplan E2.0, §2.4). Nur Kennzahlen, keine Inhalte.

    sudo python3 messung/auswerten.py                 # letzte 24 h aus /srv/eventline-ki/data/messung
    sudo python3 messung/auswerten.py --stunden 72
    sudo python3 messung/auswerten.py --bedarf 17 --budget 22 datei.csv …

Beantwortet: hält Trust one seine 20 GB? Wie tief fällt MemAvailable? Wie oft wäre das Speicher-Tor
für das Hauptmodell offen gewesen (KI-Slice + Bedarf ≤ Budget und MemAvailable ≥ Bedarf/2,
2 min am Stück)? Die Tor-Rechnung nimmt den KI-Slice ohne geladenes Hauptmodell an.
"""
from __future__ import annotations

import argparse
import csv
import glob
import os
import statistics
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    ZH = ZoneInfo("Europe/Zurich")
except Exception:  # pragma: no cover
    ZH = timezone.utc

GB = 1024 ** 3
VERZ = "/srv/eventline-ki/data/messung"


def zahl(v: str | None) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except ValueError:
        return None


def lade(dateien: list[str], seit: datetime | None) -> list[dict]:
    zeilen = []
    for pfad in sorted(dateien):
        with open(pfad, newline="") as f:
            for z in csv.DictReader(f):
                try:
                    t = datetime.strptime(z["zeit"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
                except (KeyError, ValueError):
                    continue
                if seit and t < seit:
                    continue
                z["_t"] = t
                zeilen.append(z)
    zeilen.sort(key=lambda z: z["_t"])
    return zeilen


def reihe(zeilen: list[dict], feld: str, faktor: float = 1.0) -> list[float]:
    return [v * faktor for v in (zahl(z.get(feld)) for z in zeilen) if v is not None]


def kurz(werte: list[float], einheit: str = "GB") -> str:
    if not werte:
        return "—"
    s = sorted(werte)
    p = lambda q: s[min(len(s) - 1, int(q * (len(s) - 1)))]
    return (f"min {s[0]:.1f} · p5 {p(0.05):.1f} · median {statistics.median(s):.1f} · "
            f"p95 {p(0.95):.1f} · max {s[-1]:.1f} {einheit}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dateien", nargs="*")
    ap.add_argument("--stunden", type=float, default=24)
    ap.add_argument("--bedarf", type=float, default=None,
                    help="Bedarf des Hauptmodells in GB (Standard: erster Eintrag aus KI_HG_MODELLE, sonst 17)")
    ap.add_argument("--budget", type=float, default=22, help="KI-Budget in GB (Slice MemoryMax)")
    ap.add_argument("--trustone", type=float, default=20, help="Trust-one-Budget in GB")
    a = ap.parse_args()

    bedarf = a.bedarf
    if bedarf is None:
        leiter = os.environ.get("KI_HG_MODELLE", "")
        try:
            bedarf = float(leiter.split(",")[0].split("@")[1])
        except (IndexError, ValueError):
            bedarf = 17.0

    dateien = a.dateien or glob.glob(os.path.join(VERZ, "speicherprofil-*.csv"))
    seit = None if a.dateien else datetime.now(timezone.utc) - timedelta(hours=a.stunden)
    zeilen = lade(dateien, seit)
    if not zeilen:
        print("Keine Messzeilen gefunden.")
        return 1

    k = 1024 / GB  # kB → GB
    b = 1 / GB
    print(f"Messpunkte {len(zeilen)} · {zeilen[0]['_t'].astimezone(ZH):%d.%m. %H:%M} bis "
          f"{zeilen[-1]['_t'].astimezone(ZH):%d.%m. %H:%M} (Europe/Zurich)")
    print(f"MemAvailable        {kurz(reihe(zeilen, 'mem_available_kb', k))}")
    swap_belegt = [((zahl(z.get('swap_total_kb')) or 0) - (zahl(z.get('swap_free_kb')) or 0)) * k for z in zeilen]
    print(f"Swap belegt         {kurz(swap_belegt)}")
    print(f"PSI memory full10   {kurz(reihe(zeilen, 'psi_full_avg10'), '%')}")
    print(f"KI-Slice            {kurz(reihe(zeilen, 'ki_slice', b))}")
    print(f"  davon anon        {kurz(reihe(zeilen, 'ki_slice_anon', b))}")
    for d in ("ollama", "ollama_gruendlich", "whisper", "dienst", "db"):
        print(f"  {d:<17} {kurz(reihe(zeilen, d, b))}")
    to = reihe(zeilen, "trustone_slice", b)
    print(f"Trust one (Slice)   {kurz(to)}")
    print(f"  trust-one-swarm   {kurz(reihe(zeilen, 'trustone_swarm', b))}")
    print(f"  Trust one Swap    {kurz(reihe(zeilen, 'trustone_slice_swap', b))}")
    if to:
        ueber = sum(1 for v in to if v > a.trustone)
        print(f"Trust one über {a.trustone:.0f} GB: {ueber} von {len(to)} Minuten")

    # Major Faults pro Sekunde (Zähler-Differenzen)
    mf = []
    for z0, z1 in zip(zeilen, zeilen[1:]):
        v0, v1 = zahl(z0.get("pgmajfault")), zahl(z1.get("pgmajfault"))
        dt = (z1["_t"] - z0["_t"]).total_seconds()
        if v0 is not None and v1 is not None and dt > 0 and v1 >= v0:
            mf.append((v1 - v0) / dt)
    print(f"pgmajfault/s        {kurz(mf, '/s')}")

    # Speicher-Tor (§2.4): KI-Slice + Bedarf ≤ Budget und MemAvailable ≥ Bedarf/2, 2 min am Stück.
    # Slice als anon (ohne Seitencache): memory.current bleibt nach jedem Modell-Lesen bis an die Grenze voll
    # mit Cache, den der Kernel bei Bedarf zurückgibt. Ältere Zeilen ohne anon: memory.current.
    offen, lauf, je_stunde = 0, 0, {}
    for z in zeilen:
        ki = (zahl(z.get("ki_slice_anon")) or zahl(z.get("ki_slice")) or 0) * b
        av = (zahl(z.get("mem_available_kb")) or 0) * k
        ok = ki + bedarf <= a.budget and av >= bedarf / 2
        lauf = lauf + 1 if ok else 0
        tor = lauf >= 2
        offen += tor
        h = z["_t"].astimezone(ZH).hour
        o, n = je_stunde.get(h, (0, 0))
        je_stunde[h] = (o + tor, n + 1)
    print(f"Tor offen (Bedarf {bedarf:g} GB, Budget {a.budget:g} GB): {offen} von {len(zeilen)} Minuten "
          f"({100 * offen / len(zeilen):.0f} %)")
    print("  je Stunde: " + " ".join(f"{h:02d}h {100 * o / n:.0f}%" for h, (o, n) in sorted(je_stunde.items())))
    nacht = [(o, n) for h, (o, n) in je_stunde.items() if h >= 19 or h < 7]
    if nacht:
        o, n = map(sum, zip(*nacht))
        print(f"  Nacht 19–07 Uhr: {100 * o / n:.0f} % offen")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
