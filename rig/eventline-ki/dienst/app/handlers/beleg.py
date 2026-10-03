"""beleg_analyse: Foto einer Quittung → Betrag, Kaufdatum, Lieferant (SPEC §3.2).

Prompt 1:1 aus der FSM-Route /api/tickets/analyze-receipt; die Antwortform
bleibt dieselbe, damit das Ticket-Formular nichts merkt.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..config import Einstellungen
from ..llm import Ollama
from . import datum_gueltig, liste_von_texten, text_kurz, zahl_oder_none
from .bild import bildmodell_json

SYSTEM = """Du bist ein Beleg-Analyse-Assistent fuer Eventline FSM.
Analysiere das Bild einer Quittung oder eines Belegs auf Lesbarkeit und Vollstaendigkeit.

Pruefe ob folgende drei Informationen klar erkennbar sind:
1. Betrag (Total) — bevorzugt in CHF
2. Kaufdatum
3. Lieferant / Geschaeftsname

Antworte AUSSCHLIESSLICH mit einem validen JSON-Objekt in genau diesem Format,
keine Erklaerung drumherum, kein Markdown-Codeblock:

{
  "ok": boolean,
  "issues": ["..."],
  "extracted": {
    "betrag_chf": number | null,
    "kaufdatum": "YYYY-MM-DD" | null,
    "lieferant": string | null
  }
}

Regeln:
- "ok": true nur wenn alle drei Infos klar lesbar sind UND das Bild wirklich
  eine Quittung/Beleg ist.
- "issues" Array (auf Deutsch): kurze, konkrete Punkte was unklar/unscharf ist.
  Leeres Array wenn alles ok. Beispiele: "Bild ist unscharf", "Datum nicht
  erkennbar", "Kein Beleg im Bild".
- "betrag_chf": Total-Betrag als Zahl. Nur wenn die Quittung CHF ist; bei
  anderer Waehrung null und ein issue dazu.
- "kaufdatum": ISO-Format YYYY-MM-DD. null wenn nicht klar.
- "lieferant": Geschaeftsname (Migros, Conrad, Coop, etc.) oder null."""

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "ok": {"type": "boolean"},
        "issues": {"type": "array", "items": {"type": "string"}},
        "extracted": {
            "type": "object",
            "properties": {
                "betrag_chf": {"type": ["number", "null"]},
                "kaufdatum": {"type": ["string", "null"]},
                "lieferant": {"type": ["string", "null"]},
            },
            "required": ["betrag_chf", "kaufdatum", "lieferant"],
        },
    },
    "required": ["ok", "issues", "extracted"],
}


def beleg_analyse(*, pfad: Path, llm: Ollama, cfg: Einstellungen) -> tuple[dict[str, Any], str]:
    roh, meta = bildmodell_json(
        llm, cfg, system=SYSTEM, nutzer="Analysiere diesen Beleg.", schema=SCHEMA, pfad=pfad,
    )
    ex = roh.get("extracted") if isinstance(roh.get("extracted"), dict) else {}
    betrag = zahl_oder_none(ex.get("betrag_chf"))
    if betrag is not None and (betrag < 0 or betrag > 1_000_000):
        betrag = None
    kaufdatum = datum_gueltig(ex.get("kaufdatum"))
    lieferant = text_kurz(ex.get("lieferant"), 120) or None
    issues = liste_von_texten(roh.get("issues"), 8)
    vollstaendig = betrag is not None and kaufdatum is not None and lieferant is not None
    ok = bool(roh.get("ok")) and vollstaendig
    if bool(roh.get("ok")) and not vollstaendig and not issues:
        issues.append("Nicht alle Angaben eindeutig erkannt")
    ergebnis = {
        "ok": ok,
        "issues": issues,
        "extracted": {"betrag_chf": betrag, "kaufdatum": kaufdatum, "lieferant": lieferant},
    }
    return ergebnis, str(meta["modell"])
