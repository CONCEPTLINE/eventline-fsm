"""Ablage-Logik ohne Modell: Kontextfenster, Schema-Grenzen, Satzkürzung, Nachprüfung.

Läuft im Dienst-Image (braucht httpx), ohne Ollama — alles vor und nach dem Modellaufruf:
  docker run --rm -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_ablage.py

Hintergrund (gemessen 2026-10-03): 365 Ordnerpfade sind allein ~7 500 Tokens; bei
num_ctx 8192 kürzte Ollama den Prompt still auf die Hälfte und die Regeln waren weg.
Ohne maxLength im JSON-Schema schrieben die Modelle die Zusammenfassung bis num_predict
voll (done_reason=length) und das JSON blieb unvollständig.
"""

from __future__ import annotations

import dataclasses
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import laden  # noqa: E402
from app.extract import Extrakt  # noqa: E402
from app.handlers.ablage import (  # noqa: E402
    ANTWORT_TOKENS,
    DOK_TYPEN_STANDARD,
    KONTEXT_SCHRITT,
    MAX_NUM_CTX,
    MAX_ZEICHEN,
    SYSTEM,
    ZEICHEN_PRO_TOKEN_ORDNER,
    ZEICHEN_PRO_TOKEN_TEXT,
    Kontext,
    finde_person,
    ganze_saetze,
    lese_kontext,
    prompt_fuer,
    pruefe_ergebnis,
    schema_fuer,
)

CFG = dataclasses.replace(laden(), llm_num_ctx=8192, llm_max_zeichen=24_000)
MITARBEITER = ["Tim Näf", "Leo Muster", "Fatima Keller", "Anna Keller"]
MARKER = "[… Mittelteil gekürzt …]"


def _ordner(n: int) -> list[str]:
    """Synthetische Pfade in Hauskonvention (Nummern, Unterstriche, Grossbuchstaben) — wie das echte NAS."""
    aus: list[str] = []
    i = 0
    while len(aus) < n:
        oben = f"{i % 10:02d}_BEREICH_{i:03d}"
        aus.append(oben)
        aus += [f"{oben}/{j:02d}_Unterordner_{i}_{j}" for j in range(1, 5)]
        i += 1
    return aus[:n]


def _kontext(anzahl_ordner: int) -> Kontext:
    roh = {
        "ordner": _ordner(anzahl_ordner),
        "dok_typen": [{"key": k, "label": label} for k, label in DOK_TYPEN_STANDARD],
        "mitarbeiter": MITARBEITER,
        "heute": "2026-10-03",
    }
    return lese_kontext(roh, "2000-01-01")


def _extrakt(text: str) -> Extrakt:
    return Extrakt(text=text, mime="application/pdf", seiten=2)


def _geschaetzte_tokens(prompt: str, k: Kontext) -> float:
    """Dieselbe Schätzung wie prompt_fuer: Ordnerpfade dichter tokenisiert als Fliesstext."""
    ordner_zeichen = sum(len(o) + 1 for o in k.ordner)
    return (len(SYSTEM) + len(prompt) - ordner_zeichen) / ZEICHEN_PRO_TOKEN_TEXT + ordner_zeichen / ZEICHEN_PRO_TOKEN_ORDNER


def _inhalt(prompt: str) -> str:
    return prompt.split("Dokumentinhalt:\n<<<\n", 1)[1].rsplit("\n>>>", 1)[0]


# --- Kontextfenster -------------------------------------------------------------


def test_kleine_ordnerliste_behaelt_standardfenster() -> None:
    k = _kontext(20)
    prompt, num_ctx = prompt_fuer(k, _extrakt("Police Nr. 1, gültig ab 1.1.2026."), "police.pdf", CFG)
    assert num_ctx == CFG.llm_num_ctx == 8192
    assert MARKER not in prompt and all(o in prompt for o in k.ordner)


def test_grosse_ordnerliste_vergroessert_fenster() -> None:
    k = _kontext(365)
    text = "Police Nr. 12.345.678/0001, gültig ab 1. Januar 2026. " * 40
    prompt, num_ctx = prompt_fuer(k, _extrakt(text), "police.pdf", CFG)
    assert num_ctx > CFG.llm_num_ctx, "365 Ordner passen nicht in 8192 — das Fenster muss wachsen"
    assert num_ctx % KONTEXT_SCHRITT == 0 and num_ctx <= MAX_NUM_CTX, num_ctx
    assert all(o in prompt for o in k.ordner), "jeder Ordner muss im Prompt stehen (exakte Schreibweise)"
    assert MARKER not in prompt, "ein kurzes Dokument darf nicht gekürzt werden"
    assert _geschaetzte_tokens(prompt, k) + ANTWORT_TOKENS <= num_ctx
    # Dasselbe Fenster, egal wie klein der Standard ist — die Stufe hängt nur vom Prompt ab.
    _, num_ctx_4k = prompt_fuer(k, _extrakt(text), "police.pdf", dataclasses.replace(CFG, llm_num_ctx=4096))
    assert num_ctx_4k == num_ctx
    # Mit Bild (Foto/Scan ans Bildmodell) wird das Fenster nie kleiner.
    _, num_ctx_bild = prompt_fuer(k, _extrakt(text), "scan.jpg", CFG, mit_bild=True)
    assert num_ctx_bild >= num_ctx


def test_langes_dokument_wird_auf_das_fenster_gekuerzt() -> None:
    k = _kontext(365)
    lang = "".join(f"Zeile {i}: Vertragsinhalt mit Fristen und Beträgen.\n" for i in range(3000))
    prompt, num_ctx = prompt_fuer(k, _extrakt(lang), "vertrag.pdf", CFG)
    inhalt = _inhalt(prompt)
    assert MARKER in inhalt
    assert inhalt.startswith(lang[:200]), "Kopf (Titel, Parteien) bleibt"
    assert inhalt.endswith(lang.rstrip("\n")[-100:]) or inhalt.endswith(lang[-100:]), "Schwanz (Fristen, Unterschriften) bleibt"
    assert len(inhalt) <= CFG.llm_max_zeichen + len(MARKER) + 4
    assert _geschaetzte_tokens(prompt, k) + ANTWORT_TOKENS <= num_ctx, "gekürzter Prompt muss ins Fenster passen"


def test_fenster_bleibt_unter_der_obergrenze() -> None:
    # 800 lange Pfade (~80 Zeichen) wären ~40 000 Tokens: das Fenster bleibt bei der
    # Obergrenze, das Dokument kommt trotzdem (mindestens 500 Zeichen) mit.
    k = Kontext(
        heute="2026-10-03",
        ordner=[f"{i:03d}_" + "LANGER_ORDNERNAME_" * 4 + str(i) for i in range(800)],
        typen=list(DOK_TYPEN_STANDARD),
        mitarbeiter=MITARBEITER,
    )
    prompt, num_ctx = prompt_fuer(k, _extrakt("kurz"), "x.pdf", CFG)
    assert num_ctx == MAX_NUM_CTX
    assert _inhalt(prompt).strip() == "kurz"
    _, num_ctx_mittel = prompt_fuer(_kontext(800), _extrakt("kurz"), "x.pdf", CFG)
    assert CFG.llm_num_ctx < num_ctx_mittel < MAX_NUM_CTX and num_ctx_mittel % KONTEXT_SCHRITT == 0


# --- Schema -------------------------------------------------------------------------


def test_schema_grenzen_und_enums() -> None:
    k = _kontext(365)
    s = schema_fuer(k)
    assert s["type"] == "object" and s["required"] == list(s["properties"])
    for feld, n in MAX_ZEICHEN.items():
        assert s["properties"][feld] == {"type": "string", "maxLength": n}, feld
    assert s["properties"]["typ"]["enum"] == [t for t, _ in k.typen]
    assert s["properties"]["ordner"]["enum"] == [""] + k.ordner
    assert s["properties"]["person"]["enum"] == [""] + MITARBEITER
    assert MAX_ZEICHEN["beschrieb"] == 200, "wie bereinigeAblageErgebnis im FSM"
    assert MAX_ZEICHEN["dok_datum"] == MAX_ZEICHEN["frist"] == len("2026-10-03")


def test_schema_ohne_listen_begrenzt_freie_felder() -> None:
    s = schema_fuer(Kontext(heute="2026-10-03", ordner=[], typen=list(DOK_TYPEN_STANDARD), mitarbeiter=[]))
    assert s["properties"]["ordner"] == {"type": "string", "maxLength": 300}
    assert s["properties"]["person"] == {"type": "string", "maxLength": 120}


# --- Satzkürzung ---------------------------------------------------------------------


def test_ganze_saetze() -> None:
    assert ganze_saetze(None, 800) == "" and ganze_saetze("", 800) == "" and ganze_saetze(42, 800) == ""
    # Von der Längengrenze abgeschnittener Schlusssatz fällt weg.
    text = "Erster Satz. Zweiter Satz! Dritter Satz? Vierter Satz ohne Ende und dann " + "x" * 800
    assert ganze_saetze(text, 800) == "Erster Satz. Zweiter Satz! Dritter Satz?"
    # Wörtlich wiederholte Sätze nur einmal.
    assert ganze_saetze("Die Police gilt ab 2026. Die Police gilt ab 2026. Sie endet 2028.", 800) == "Die Police gilt ab 2026. Sie endet 2028."
    # Kurzer Text ohne Schlusspunkt bleibt ganz.
    kurz = "Rechnung über CHF 1'541.51 von Blumen Müller"
    assert ganze_saetze(kurz, 800) == kurz
    assert ganze_saetze("Satz eins. Satz eins. Satz zwei", 800) == "Satz eins. Satz zwei"
    # Dezimalpunkte, Nummern und Abkürzungen zerreissen nichts.
    s = "Police Nr. 12.345.678/0001 über CHF 2'480.00 jährlich. Kündbar bis 30.9.2028."
    assert ganze_saetze(s, 800) == s
    # Schweizer Schreibweise, glatter Whitespace, nie länger als die Grenze.
    assert ganze_saetze("Grüße  aus\nBasel. ", 800) == "Grüsse aus Basel."
    assert len(ganze_saetze("Wort " * 500, 800)) <= 800


# --- Nachprüfung ----------------------------------------------------------------------


def _pruefe(roh: dict, k: Kontext) -> dict:
    return pruefe_ergebnis(roh, k, _extrakt("x"), sha256="0" * 64, modell="m", dauer_ms=1, dateiname="x.pdf")


def test_pruefe_ergebnis_grenzen() -> None:
    k = _kontext(40)
    e = _pruefe(
        {
            "beschrieb": "B" * 500,
            "typ": "unbekannt",
            "betreff": "Haftpflicht",
            "person": "tim",
            "partei": "EVENTLINE GmbH",
            "nummer": " 12 345 ",
            "dok_datum": "15.1.2026",
            "frist": "2026-02-30",
            "ordner": "99_GIBT_ES_NICHT",
            "neuer_ordner": f"{k.ordner[0]}/Neuer_Ordner_1",
            "zusammenfassung": "Satz eins. Satz eins. Satz zwei",
        },
        k,
    )
    assert len(e["beschrieb"]) == MAX_ZEICHEN["beschrieb"]
    assert e["typ"] == "sonstiges"
    assert e["person"] == "Tim Näf"
    assert e["partei"] is None, "EVENTLINE selbst ist nie die Gegenpartei"
    assert e["nummer"] == "12 345"
    assert e["dok_datum"] is None and e["frist"] is None, "nur echte YYYY-MM-DD-Daten"
    assert e["ordner"] is None
    assert e["neuer_ordner"] == f"{k.ordner[0]}/Neuer_Ordner_1"
    assert e["zusammenfassung"] == "Satz eins. Satz zwei"
    assert e["modell"] == "m" and e["seiten"] == 2 and e["ocr"] is False


def test_pruefe_ergebnis_ordner_und_beschrieb() -> None:
    k = _kontext(40)
    e = _pruefe({"ordner": k.ordner[3], "neuer_ordner": f"{k.ordner[0]}/Egal"}, k)
    assert e["ordner"] == k.ordner[3] and e["neuer_ordner"] is None, "neuer Ordner nur ohne Treffer"
    assert _pruefe({"neuer_ordner": "NICHT_DA/Neu"}, k)["neuer_ordner"] is None
    assert _pruefe({"neuer_ordner": f"{k.ordner[0]}/Müller"}, k)["neuer_ordner"] is None, "Umlaute verletzen die Hauskonvention"
    assert _pruefe({"neuer_ordner": k.ordner[1]}, k)["neuer_ordner"] is None, "bestehender Ordner ist nicht neu"
    e2 = _pruefe({"typ": "rechnung", "partei": "Blumen Müller AG", "nummer": "R-1"}, k)
    assert e2["beschrieb"] == "Rechnung, Blumen Müller AG, Nr. R-1"
    assert _pruefe({"typ": "sonstiges"}, k)["beschrieb"] == "Dokument x.pdf"
    lang = "Z" * 2000
    assert len(_pruefe({"zusammenfassung": lang}, k)["zusammenfassung"]) <= MAX_ZEICHEN["zusammenfassung"]


def test_person_nur_bei_personen_typen() -> None:
    # Wie das FSM (GET /api/ki/sync): jeder Typ trägt das Flag `person`.
    personen_typen = {"lohnabrechnung", "behoerde", "zertifikat"}
    k = lese_kontext(
        {
            "ordner": _ordner(10),
            "dok_typen": [{"key": key, "label": label, "person": key in personen_typen} for key, label in DOK_TYPEN_STANDARD],
            "mitarbeiter": MITARBEITER,
        },
        "2026-10-03",
    )
    assert k.personen_typen == frozenset(personen_typen)
    assert _pruefe({"typ": "rechnung", "person": "Tim Näf"}, k)["person"] is None, "eine Rechnung kennt keine Person"
    assert _pruefe({"typ": "vertrag", "person": "tim"}, k)["person"] is None
    assert _pruefe({"typ": "unbekannt", "person": "Tim Näf"}, k)["person"] is None, "Rückfall auf sonstiges = keine Person"
    assert _pruefe({"typ": "zertifikat", "person": "tim"}, k)["person"] == "Tim Näf"
    assert _pruefe({"typ": "lohnabrechnung", "person": "Tim Näf"}, k)["person"] == "Tim Näf"
    assert _pruefe({"typ": "zertifikat", "person": "fremd"}, k)["person"] is None, "nur Namen aus der Mitarbeiterliste"
    # Ohne Flag im Kontext (älteres FSM, Probelauf) wie bisher: Person bei jedem Typ.
    ohne = _kontext(10)
    assert ohne.personen_typen is None
    assert _pruefe({"typ": "rechnung", "person": "Tim Näf"}, ohne)["person"] == "Tim Näf"


def test_finde_person() -> None:
    assert finde_person("tim", MITARBEITER) == "Tim Näf"
    assert finde_person("Tim Näf", MITARBEITER) == "Tim Näf"
    assert finde_person("näf tim", MITARBEITER) == "Tim Näf"
    assert finde_person("keller", MITARBEITER) is None, "mehrdeutig = keiner"
    assert finde_person("anna keller", MITARBEITER) == "Anna Keller"
    assert finde_person("fremd", MITARBEITER) is None
    assert finde_person("", MITARBEITER) is None


def test_lese_kontext_tolerant() -> None:
    k = lese_kontext(
        {"folders": ["A", "A", {"pfad": "B"}, 7], "typen": {"vertrag": "Vertrag"}, "employees": ["X Y"], "heute": "kaputt"},
        "2026-10-03",
    )
    assert k.ordner == ["A", "B"] and k.typen == [("vertrag", "Vertrag")] and k.mitarbeiter == ["X Y"]
    assert k.heute == "2026-10-03", "ungültiges Datum → Standard"
    assert k.personen_typen is None, "Typen ohne Flag → keine Einschränkung"
    leer = lese_kontext({}, "2026-10-03")
    assert leer.typen == list(DOK_TYPEN_STANDARD) and leer.ordner == [] and leer.mitarbeiter == []
    assert leer.personen_typen is None
    # Flag nur bei einem Teil der Einträge: gilt trotzdem (fehlendes Flag = kein Personen-Typ).
    teil = lese_kontext({"dok_typen": [{"key": "zertifikat", "person": True}, {"key": "rechnung"}]}, "2026-10-03")
    assert teil.typen == [("zertifikat", "zertifikat"), ("rechnung", "rechnung")]
    assert teil.personen_typen == frozenset({"zertifikat"})


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
