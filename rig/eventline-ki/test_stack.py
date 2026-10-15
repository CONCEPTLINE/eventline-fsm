"""Statische Prüfung des Compose-Stacks (nur Standardbibliothek, ohne Docker):

- Prompt-Cache-Schutz der GPU-Instanz «ollama» (15.10.2026, README «Speicher der GPU-Instanz: Prompt-Cache aus») und
  seit 16.10.2026 auch der Hauptmodell-Instanz «ollama-gruendlich»:
  LLAMA_ARG_CACHE_RAM muss "0" sein — sonst hält llama-server bis 8 GiB zwischengespeicherte Prompts im RAM des
  Containers (Grenze 12g), bis das Modell entladen wird.

    python3 test_stack.py            (im Ordner rig/eventline-ki oder mit beliebigem Arbeitsordner)
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

COMPOSE = Path(__file__).resolve().parent / "docker-compose.yml"


def dienst_block(text: str, name: str) -> str:
    """Zeilen eines Dienstes unter «services:» (zwei Leerzeichen Einzug) bis zum nächsten Dienst."""
    zeilen = text.splitlines()
    start = next(i for i, z in enumerate(zeilen) if z == f"  {name}:")
    ende = next((i for i in range(start + 1, len(zeilen)) if re.match(r"^  [A-Za-z0-9_-]+:\s*$", zeilen[i])
                 or re.match(r"^[A-Za-z]", zeilen[i])), len(zeilen))
    return "\n".join(zeilen[start:ende])


def umgebung(block: str) -> dict[str, str]:
    """Einträge unter «environment:» (Form «NAME: wert», sechs Leerzeichen Einzug), Kommentare ignoriert."""
    werte: dict[str, str] = {}
    drin = False
    for z in block.splitlines():
        if re.match(r"^    environment:\s*$", z):
            drin = True
            continue
        if drin:
            if z.strip().startswith("#") or not z.strip():
                continue
            m = re.match(r"^      ([A-Z0-9_]+):\s*(.*?)\s*$", z)
            if not m:
                break
            werte[m.group(1)] = m.group(2).strip('"').strip("'")
    return werte


def test_gpu_instanz_ohne_prompt_cache() -> None:
    env = umgebung(dienst_block(COMPOSE.read_text(encoding="utf-8"), "ollama"))
    assert env.get("LLAMA_ARG_CACHE_RAM") == "0", env
    # Die übrigen Werte bleiben, wie sie gemessen wurden (Atmen, zwei Modelle, ein Platz).
    assert (env["OLLAMA_KEEP_ALIVE"], env["OLLAMA_MAX_LOADED_MODELS"], env["OLLAMA_NUM_PARALLEL"]) == ("5m", "2", "1")


def test_hauptmodell_ohne_prompt_cache() -> None:
    # 16.10.2026: auch «gruendlich» (Gemma 4 26B auf dem Prozessor) ohne Prompt-Cache.
    env = umgebung(dienst_block(COMPOSE.read_text(encoding="utf-8"), "ollama-gruendlich"))
    assert env.get("LLAMA_ARG_CACHE_RAM") == "0", env
    assert (env["OLLAMA_KEEP_ALIVE"], env["OLLAMA_MAX_LOADED_MODELS"], env["OLLAMA_NUM_PARALLEL"]) == ("15m", "1", "1")


def test_block_parser() -> None:
    text = "services:\n  a:\n    environment:\n      # Kommentar\n      X: \"1\"\n      Y: zwei\n    mem_limit: 1g\n  b:\n    image: c\n"
    assert umgebung(dienst_block(text, "a")) == {"X": "1", "Y": "zwei"}
    assert umgebung(dienst_block(text, "b")) == {}


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
