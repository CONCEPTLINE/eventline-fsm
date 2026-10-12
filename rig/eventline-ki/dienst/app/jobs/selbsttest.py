"""Selbsttest der Nacht (Masterplan E4.5). Schalter KI_JOB_SELBSTTEST, ab KI_SELBSTTEST_ZEIT (05:30).

1. Ordnerwahl mit den Produktionsmodellen (KI_MODELL_TEXT/KI_MODELL_EMBED, derselbe Weg wie ablage_analyse):
   KI_SELBSTTEST_N (40) bereits einsortierte Dateien aus dem Vorbilder-Index, Stichprobe mit rotierendem Seed
   (Datum der Nacht), deren Ordner in der aktiven FSM-Liste steht. Je Datei beide Namensvarianten — der einsortierte
   Dateiname und ein neutraler («dokument.pdf») —, die Datei selbst und ihre Fast-Zwillinge im Zielordner
   (Kosinus > 0,95 oder gleicher Namensstamm) sind kein Vorbild (wie probelauf.py, Review 2026-10-11).
2. Egress-Test: api.anthropic.com muss über den Proxy UND direkt scheitern; das FSM über den Proxy zeigt, dass der
   Test selbst funktioniert.
Ergebnis nur als Kennzahlen (Top-1, Top-3, Kategorie, leer, Fehler, Median-Zeit je Variante) in /health — nichts
geht ans FSM, keine Pfade, keine Namen.
"""

from __future__ import annotations

import logging
import random
import statistics
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

import httpx

from ..archiv import ArchivIndex, lesbarer_name, nfc
from ..config import Einstellungen
from ..handlers import VerarbeitungsFehler
from ..handlers.ablage import ZwillingsAusschluss, ablage_analyse
from ..llm import Ollama

log = logging.getLogger("ki.nacht.selbsttest")

VARIANTEN = ("einsortiert", "neutral")
ZWILLINGE_SCHWELLE = 0.95
EGRESS_ZIEL = "https://api.anthropic.com/"
EGRESS_TIMEOUT_S = 10.0


@dataclass(frozen=True)
class Probe:
    pfad: str      # NFC, relativ zur NAS-Wurzel
    ordner: str    # NFC
    name: str
    sha256: str


def seed_fuer(fenster: str) -> int:
    """Rotierender Seed: das Datum der Nacht («2026-10-12/nacht» → 20261012)."""
    ziffern = "".join(c for c in fenster.split("/")[0] if c.isdigit())
    return int(ziffern) if ziffern else 0


def stichprobe(zeilen: Iterable[tuple[str, str, str, str]], erlaubt: set[str], seed: int, n: int) -> list[Probe]:
    """n Dateien (pfad, ordner, name, sha256) aus Ordnern der aktiven Liste, deterministisch je Seed."""
    proben = sorted(
        {Probe(nfc(p), nfc(o), n_, s) for p, o, n_, s in zeilen if nfc(o) in erlaubt},
        key=lambda x: x.pfad,
    )
    if len(proben) <= n:
        return proben
    return random.Random(seed).sample(proben, n)


def auf_platte(wurzel: Path, pfad_nfc: str) -> Path | None:
    """Datei zum NFC-Pfad auf dem NAS (Namen dort oft NFD): erst direkt, sonst Segment für Segment vergleichen."""
    direkt = wurzel / pfad_nfc
    if direkt.is_file():
        return direkt
    aktuell = wurzel
    for segment in pfad_nfc.split("/"):
        try:
            treffer = next((e for e in aktuell.iterdir() if nfc(e.name) == segment), None)
        except OSError:
            return None
        if treffer is None:
            return None
        aktuell = treffer
    return aktuell if aktuell.is_file() else None


def neutraler_name(name: str) -> str:
    endung = Path(name).suffix.lower()
    return f"dokument{endung}"


def pruefe_eine(
    probe: Probe, variante: str, *, kontext_roh: dict[str, Any], llm: Ollama, cfg: Einstellungen,
    archiv: ArchivIndex | None,
) -> dict[str, Any]:
    """Eine Datei, eine Namensvariante → nur Zahlen/Wahrheitswerte."""
    start = time.monotonic()
    datei = auf_platte(cfg.nas_wurzel, probe.pfad)
    if datei is None:
        return {"variante": variante, "fehler": "fehlt", "ms": 0}
    try:
        erg = ablage_analyse(
            pfad=datei, dateiname=probe.name if variante == "einsortiert" else neutraler_name(probe.name), mime=None,
            sha256=probe.sha256, kontext_roh=kontext_roh, llm=llm, cfg=cfg, archiv=archiv,
            ohne_vorbilder=([probe.pfad], [probe.sha256]), messung={},
            zwillinge=ZwillingsAusschluss(
                ordner=probe.ordner, schwelle=ZWILLINGE_SCHWELLE, namensstamm=lesbarer_name(probe.name).lower(),
            ),
        )
    except VerarbeitungsFehler:
        return {"variante": variante, "fehler": "verarbeitung", "ms": int((time.monotonic() - start) * 1000)}
    vorschlag = nfc(erg["ordner"]) if erg.get("ordner") else None
    alternativen = [nfc(a) for a in erg.get("ordner_alternativen") or []]
    top1 = vorschlag == probe.ordner
    return {
        "variante": variante,
        "top1": top1,
        "top3": top1 or probe.ordner in alternativen,
        "kategorie": bool(vorschlag) and vorschlag.split("/")[:2] == probe.ordner.split("/")[:2],
        "leer": vorschlag is None,
        "ms": int((time.monotonic() - start) * 1000),
    }


def kennzahlen(ergebnisse: list[dict[str, Any]]) -> dict[str, Any]:
    aus: dict[str, Any] = {}
    for v in VARIANTEN:
        teil = [e for e in ergebnisse if e.get("variante") == v]
        ok = [e for e in teil if not e.get("fehler")]
        n = len(ok)

        def anteil(feld: str) -> float | None:
            return round(sum(1 for e in ok if e.get(feld)) / n, 3) if n else None

        aus[v] = {
            "dateien": len(teil), "gewertet": n, "fehler": len(teil) - n,
            "top1": anteil("top1"), "top3": anteil("top3"), "kategorie": anteil("kategorie"), "leer": anteil("leer"),
            "ms_median": int(statistics.median([e["ms"] for e in ok])) if ok else None,
        }
    return aus


def egress_test(cfg: Einstellungen, *, client_fabrik: Callable[..., httpx.Client] = httpx.Client) -> dict[str, Any]:
    """api.anthropic.com über den Proxy und direkt — beides muss scheitern. Ohne Zugangsdaten, nur ein GET."""

    def versuch(proxy: str | None, url: str) -> str:
        try:
            with client_fabrik(proxy=proxy, trust_env=False, timeout=EGRESS_TIMEOUT_S) as c:
                r = c.get(url)
            return f"http_{r.status_code}"
        except httpx.ProxyError:
            return "proxy_abgewiesen"
        except httpx.HTTPError as e:
            return type(e).__name__

    ueber_proxy = versuch(cfg.proxy, EGRESS_ZIEL) if cfg.proxy else "kein_proxy"
    direkt = versuch(None, EGRESS_ZIEL)
    fsm = versuch(cfg.proxy, f"{cfg.fsm_url}/api/version") if cfg.proxy else "kein_proxy"
    gesperrt = not ueber_proxy.startswith("http_") and not direkt.startswith("http_")
    if not gesperrt:
        log.error("Egress-Test: api.anthropic.com erreichbar (Proxy: %s, direkt: %s)", ueber_proxy, direkt)
    return {"ok": gesperrt, "anthropic_proxy": ueber_proxy, "anthropic_direkt": direkt, "fsm_proxy": fsm}
