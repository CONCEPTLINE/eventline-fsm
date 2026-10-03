"""EVENTLINE Lokale KI — Dienst auf dem Rig (Vertrag: docs/lokale-ki/SPEC.md §2.2).

Verarbeitet vertrauliche Dokumente ausschliesslich im Haus: holt Aufträge beim
FSM ab, liest Dateien lokal (Text/OCR), fragt die lokalen Modelle (Ollama,
Whisper) und meldet nur Ergebnisse (Name, Ordner, Frist, Kennzahlen) zurück.
"""

VERSION = "0.1.0"
