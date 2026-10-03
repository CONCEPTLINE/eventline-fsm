"""GPU-Auskunft für /health und den Herzschlag.

nvidia-smi kommt per CDI in den Container; läuft es nicht (kein Treiber, keine
Karte), liefern wir None statt zu scheitern — der Dienst bleibt nutzbar.
Die Schleuse sorgt dafür, dass Sprachmodell und Whisper nie gleichzeitig
rechnen: auf 8 GB VRAM passen sonst nicht beide.
"""

from __future__ import annotations

import subprocess
import threading
import time

SCHLEUSE = threading.Lock()

_cache: dict[str, object] = {"zeit": 0.0, "wert": {"name": None, "frei_mb": None}}
_cache_lock = threading.Lock()


def _abfragen() -> dict[str, object]:
    try:
        p = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.free", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return {"name": None, "frei_mb": None}
    if p.returncode != 0:
        return {"name": None, "frei_mb": None}
    zeile = (p.stdout or "").strip().splitlines()
    if not zeile:
        return {"name": None, "frei_mb": None}
    teile = [t.strip() for t in zeile[0].split(",")]
    name = teile[0] or None
    frei = None
    if len(teile) > 1:
        try:
            frei = int(float(teile[1]))
        except ValueError:
            frei = None
    return {"name": name, "frei_mb": frei}


def gpu_info(max_alter_s: float = 10.0) -> dict[str, object]:
    """Name + freier VRAM in MB, höchstens alle 10 s neu abgefragt."""
    with _cache_lock:
        if time.monotonic() - float(_cache["zeit"]) < max_alter_s:
            return dict(_cache["wert"])  # type: ignore[arg-type]
    wert = _abfragen()
    with _cache_lock:
        _cache["zeit"] = time.monotonic()
        _cache["wert"] = wert
    return dict(wert)


def gpu_kurz() -> str:
    """Form für den Herzschlag: `<name>|<frei_mb>` (SPEC §3.4); leer, wenn keine GPU sichtbar ist."""
    g = gpu_info()
    name = str(g.get("name") or "")
    if not name:
        return ""
    frei = g.get("frei_mb")
    return f"{name}|{'' if frei is None else frei}"
