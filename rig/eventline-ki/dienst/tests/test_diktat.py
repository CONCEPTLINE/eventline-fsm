"""Diktat über die Warteschlange (Vertrag V3): Segment-Filter, Textgrenze, Audio-Umwandlung.

Läuft im Dienst-Image (braucht httpx und ffmpeg), ohne Whisper/GPU:
  docker run --rm -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_diktat.py
"""

from __future__ import annotations

import sys
import tempfile
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.handlers import VerarbeitungsFehler  # noqa: E402
from app.handlers.diktat import MAX_TEXT_ZEICHEN, _nach_wav, text_aus_segmenten  # noqa: E402


def _seg(text: str, no_speech: float) -> dict:
    return {"text": text, "no_speech_prob": no_speech, "avg_logprob": -0.2}


def test_stille_segmente_fallen_weg() -> None:
    text, verworfen = text_aus_segmenten(
        [_seg(" Bitte zwei Mikrofone", 0.02), _seg(" Untertitel im Auftrag des ZDF", 0.91), _seg("  bis Freitag. ", 0.10)],
        0.6,
    )
    assert text == "Bitte zwei Mikrofone bis Freitag.", text
    assert verworfen == 1


def test_nur_stille_ergibt_leeren_text() -> None:
    assert text_aus_segmenten([], 0.6) == ("", 0)
    assert text_aus_segmenten([_seg("Vielen Dank.", 0.95)], 0.6) == ("", 1)
    assert text_aus_segmenten([_seg("   ", 0.0)], 0.6) == ("", 0)


def test_schwelle_ist_obergrenze() -> None:
    assert text_aus_segmenten([_seg("genau an der Grenze", 0.6)], 0.6)[0] == "genau an der Grenze"
    assert text_aus_segmenten([_seg("knapp darüber", 0.6001)], 0.6)[0] == ""


def test_unlesbare_werte() -> None:
    text, _ = text_aus_segmenten([{"text": "ohne Wert"}, {"text": "kaputt", "no_speech_prob": "x"}, {"no_speech_prob": 0.1}], 0.6)
    assert text == "ohne Wert kaputt", text


def test_textgrenze() -> None:
    lang = [_seg("wort " * 1000, 0.0) for _ in range(10)]
    text, _ = text_aus_segmenten(lang, 0.6)
    assert len(text) <= MAX_TEXT_ZEICHEN == 20_000


def test_wav_quelle_wird_nicht_ueberschrieben() -> None:
    with tempfile.TemporaryDirectory() as d:
        quelle = Path(d) / "aufnahme.wav"
        with wave.open(str(quelle), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(b"\x00\x00" * 16000)  # 1 s Stille
        ziel = _nach_wav(quelle)
        assert ziel != quelle and ziel.exists() and quelle.exists()
        assert ziel.stat().st_size > 30_000


def test_kein_audio() -> None:
    with tempfile.TemporaryDirectory() as d:
        quelle = Path(d) / "kein-audio.webm"
        quelle.write_bytes(b"das ist keine Aufnahme" * 100)
        try:
            _nach_wav(quelle)
        except VerarbeitungsFehler as e:
            assert "Audio" in str(e)
            assert not any(Path(d).glob("*-16k.wav")), "Rest der Umwandlung liegt noch herum"
            return
        raise AssertionError("VerarbeitungsFehler erwartet")


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    fehler = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok      {name}")
        except Exception as e:  # noqa: BLE001
            fehler += 1
            print(f"FEHLER  {name}: {e}")
    print(f"{len(tests) - fehler}/{len(tests)} bestanden")
    sys.exit(1 if fehler else 0)
