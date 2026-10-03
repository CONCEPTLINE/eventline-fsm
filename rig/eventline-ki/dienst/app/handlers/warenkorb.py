"""warenkorb_analyse: Screenshot eines Warenkorbs → Artikel, Menge, Stückpreis (SPEC §3.3).

Prompt 1:1 aus der FSM-Route /api/tickets/analyze-material; Antwortform unverändert.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..config import Einstellungen
from ..llm import Ollama
from . import liste_von_texten, text_kurz, zahl_oder_none
from .bild import bildmodell_json

SYSTEM = """Du bist ein Material-Anfrage-Assistent fuer Eventline FSM.
Analysiere das Bild eines Warenkorbs oder einer Produkt-Auflistung
(typisch von digitec.ch, galaxus.ch, conrad.ch oder aehnlichen Shops).

Extrahiere die einzelnen Positionen und antworte AUSSCHLIESSLICH mit
einem validen JSON-Objekt in genau diesem Format, kein Markdown-Codeblock:

{
  "ok": boolean,
  "issues": ["..."],
  "extracted": {
    "items": [
      { "artikel": "...", "menge": 1, "betrag_chf": 24.50 }
    ]
  }
}

Regeln:
- "ok": true nur wenn fuer jedes Item Artikel + Menge erkennbar sind.
- "issues" Array (auf Deutsch): kurze konkrete Punkte was unklar/unscharf
  ist. Leeres Array wenn alles ok. Beispiele: "Bild ist unscharf",
  "Preis bei Item 2 nicht erkennbar", "Kein Warenkorb-Bildschirm".
- "items": EIN Eintrag pro Position. Wenn der Warenkorb 3 verschiedene
  Artikel zeigt → 3 Items im Array. Wenn 1 Artikel zu 5 Stueck → 1 Item
  mit menge=5. Felder pro Item:
    * "artikel": voller Produktname inkl. Hersteller wenn ersichtlich
    * "menge": Stueckzahl als Integer
    * "betrag_chf": Stueck-Preis (nicht Total) in CHF wenn erkennbar,
      sonst null. NUR CHF — bei anderer Waehrung null + ein issue dazu.
- Mindestens ein Item muss im Array sein (auch bei null-Werten),
  ausser "ok" ist false und das Bild ist gar kein Warenkorb."""

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "ok": {"type": "boolean"},
        "issues": {"type": "array", "items": {"type": "string"}},
        "extracted": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "artikel": {"type": "string"},
                            "menge": {"type": "integer"},
                            "betrag_chf": {"type": ["number", "null"]},
                        },
                        "required": ["artikel", "menge", "betrag_chf"],
                    },
                }
            },
            "required": ["items"],
        },
    },
    "required": ["ok", "issues", "extracted"],
}

MAX_POSITIONEN = 50


def warenkorb_analyse(*, pfad: Path, llm: Ollama, cfg: Einstellungen) -> tuple[dict[str, Any], str]:
    roh, meta = bildmodell_json(
        llm, cfg, system=SYSTEM, nutzer="Analysiere diesen Warenkorb.", schema=SCHEMA, pfad=pfad,
    )
    ex = roh.get("extracted") if isinstance(roh.get("extracted"), dict) else {}
    items: list[dict[str, Any]] = []
    for e in ex.get("items") if isinstance(ex.get("items"), list) else []:
        if not isinstance(e, dict):
            continue
        artikel = text_kurz(e.get("artikel"), 200)
        if not artikel:
            continue
        menge_roh = zahl_oder_none(e.get("menge"))
        menge = int(round(menge_roh)) if menge_roh is not None and menge_roh >= 1 else 1
        betrag = zahl_oder_none(e.get("betrag_chf"))
        if betrag is not None and (betrag < 0 or betrag > 1_000_000):
            betrag = None
        items.append({"artikel": artikel, "menge": menge, "betrag_chf": betrag})
        if len(items) >= MAX_POSITIONEN:
            break
    issues = liste_von_texten(roh.get("issues"), 8)
    ok = bool(roh.get("ok")) and len(items) > 0
    if bool(roh.get("ok")) and not items and not issues:
        issues.append("Keine Positionen erkennbar")
    return {"ok": ok, "issues": issues, "extracted": {"items": items}}, str(meta["modell"])
