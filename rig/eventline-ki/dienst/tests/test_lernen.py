"""Live-Trefferquote (E2.7) ohne Datenbank: was gemerkt wird (nur sha256 + Ordnerpfade), Quote, der Live-Pfad wartet
nie. Die SQL-Auswertung prüft tests/test_tiefe_db.py gegen eine Wegwerf-Datenbank.

  docker run --rm --network none -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_lernen.py
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.jobs.lernen import WARTESCHLANGE_MAX, Lernen, quote, vorschlag_aus  # noqa: E402

SHA = "a" * 64
ERGEBNIS = {
    "beschrieb": "Mietvertrag Volkshaus", "zusammenfassung": "geheim", "typ": "vertrag", "partei": "Volkshaus AG",
    "ordner": "02_LOCATIONS/Volkshaus/01_Vertraege", "ordner_alternativen": ["02_LOCATIONS/Volkshaus", "00_ADMIN_RECHT"],
    "sha256": SHA, "modell": "gemma3:4b", "einordnung": {"was": "geheim"},
}


def test_vorschlag_nur_pfade() -> None:
    v = vorschlag_aus(ERGEBNIS, {"quelle": "ki", "rangliste": ["x"]})
    assert v == {"sha256": SHA, "ordner_vorschlag": "02_LOCATIONS/Volkshaus/01_Vertraege",
                 "alternativen": ["02_LOCATIONS/Volkshaus", "00_ADMIN_RECHT"], "quelle": "ki", "modell": "gemma3:4b"}
    assert "geheim" not in str(v) and "Volkshaus AG" not in str(v), "nie Beschrieb, Partei, Zusammenfassung"
    assert vorschlag_aus({**ERGEBNIS, "sha256": "kurz"}, None) is None
    ohne = vorschlag_aus({**ERGEBNIS, "ordner": None, "ordner_alternativen": None}, None)
    assert ohne["ordner_vorschlag"] is None and ohne["alternativen"] == [] and ohne["quelle"] is None


def test_quote() -> None:
    assert quote([]) == {"n": 0, "top1": None, "top3": None}
    assert quote([(10, 6, 8), (10, 5, 9)]) == {"n": 20, "top1": 0.55, "top3": 0.85}


def test_merke_wartet_nie() -> None:
    lern = Lernen(None)  # ohne DB, Thread nicht gestartet — die Warteschlange läuft voll
    t0 = time.monotonic()
    for _ in range(WARTESCHLANGE_MAX + 5):
        lern.merke(ERGEBNIS, {"quelle": "regel"})
    assert time.monotonic() - t0 < 1.0 and lern.verworfen == 5
    assert lern.merke({"kaputt": object()}, None) is False, "wirft nie"
    assert lern.merke(None, None) is False  # type: ignore[arg-type]


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
