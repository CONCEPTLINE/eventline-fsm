"""Ablage-Logik ohne Modell und ohne DB: Prompt-Reihenfolge, Kontextfenster, Schema, Nachprüfung und der ganze
Ablauf «Ordnerwahl nach Vorbild» (Einbettung → Vorbilder → Stufe 1 → Rangliste → Stufe 2) mit Attrappen.

Läuft im Dienst-Image (braucht httpx, Pillow), ohne Ollama, ohne Datenbank:
  docker run --rm --network none -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_ablage.py

Hintergrund (gemessen 2026-10-04, live-nah mit allen 424 Ordnern): Die zweistufige Wahl aus der ganzen
Ordnerliste traf 15 % (Locations) bzw. 43 % (Projekte). Jetzt wählt das Modell nur noch unter wenigen
Kandidaten aus dem Archiv-Index (ähnliche, bereits einsortierte Dateien), den Ordnernamen und festen Regeln.
"""

from __future__ import annotations

import dataclasses
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.archiv import Nachbar  # noqa: E402
from app.config import laden  # noqa: E402
from app.extract import Extrakt  # noqa: E402
from app.handlers.ablage import (  # noqa: E402
    ANTWORT_TOKENS,
    ANTWORT_TOKENS_STUFE2,
    ANZAHL_ALTERNATIVEN,
    ANZAHL_KANDIDATEN,
    AUFTRAG_MARKER,
    DOK_TYPEN_STANDARD,
    HINWEIS_BILD_OHNE_TEXT,
    HINWEIS_STUFE2_BILD_OHNE_TEXT,
    KONTEXT_SCHRITT,
    MAX_NUM_CTX,
    MAX_ZEICHEN,
    MAX_ZEICHEN_NEUER_ORDNER,
    STUFE2_ANHANG_TOKENS,
    STUFE2_MARKER,
    SYSTEM,
    ZEICHEN_PRO_TOKEN_ORDNER,
    ZEICHEN_PRO_TOKEN_TEXT,
    ZWEITER_VERSUCH,
    Kontext,
    ablage_analyse,
    bild_ohne_text,
    bild_tokens,
    finde_person,
    ganze_saetze,
    kontext_block,
    lese_kontext,
    neuer_ordner_aus,
    ordner_aus,
    prompt_fuer,
    pruefe_ergebnis,
    schema_fuer,
    schema_stufe2,
    stufe2_anhang,
    stufe2_anhang_tokens,
)
from app.llm import LlmFehler  # noqa: E402

CFG = dataclasses.replace(laden(), llm_num_ctx=8192, llm_max_zeichen=24_000)
MITARBEITER = ["Tim Näf", "Leo Muster", "Fatima Keller", "Anna Keller"]
MARKER = "[… Mittelteil gekürzt …]"
# Hauskonvention in Kleinform: Freigabe / Location bzw. Projekt / Unterordner nach Dokumentart.
HAUS = [
    "00_ADMIN_RECHT",
    "00_ADMIN_RECHT/01_Firma",
    "00_ADMIN_RECHT/02_Versicherungen",
    "02_LOCATIONS",
    "02_LOCATIONS/01_Halle_Nord",
    "02_LOCATIONS/01_Halle_Nord/01_Vertraege",
    "02_LOCATIONS/01_Halle_Nord/02_Korrespondenz",
    "02_LOCATIONS/01_Halle_Nord/02_Korrespondenz/2026",
    "02_LOCATIONS/02_Saal_Sued",
    "03_PROJEKTE_EVENTS",
    "03_PROJEKTE_EVENTS/2026",
    "03_PROJEKTE_EVENTS/2026/INT-26-001-Firma_Alpha_Sommerfest",
    "03_PROJEKTE_EVENTS/2026/INT-26-002-Bank_Beta_Jubilaeum",
    "04_PARTNER",
    "04_PARTNER/01_Blumen_Mueller",
]
VERTRAEGE = "02_LOCATIONS/01_Halle_Nord/01_Vertraege"
KORR_2026 = "02_LOCATIONS/01_Halle_Nord/02_Korrespondenz/2026"
ALPHA = "03_PROJEKTE_EVENTS/2026/INT-26-001-Firma_Alpha_Sommerfest"


def _kontext(ordner: list[str] | None = None, mitarbeiter: list[str] | None = None) -> Kontext:
    roh = {
        "ordner": HAUS if ordner is None else ordner,
        "dok_typen": [{"key": k, "label": label} for k, label in DOK_TYPEN_STANDARD],
        "mitarbeiter": MITARBEITER if mitarbeiter is None else mitarbeiter,
        "heute": "2026-10-03",
    }
    return lese_kontext(roh, "2000-01-01")


def _extrakt(text: str) -> Extrakt:
    return Extrakt(text=text, mime="application/pdf", seiten=2)


def _inhalt(prompt: str) -> str:
    return prompt.split("Dokumentinhalt:\n<<<\n", 1)[1].rsplit("\n>>>", 1)[0]


def _geschaetzte_tokens(prompt: str) -> float:
    return (len(SYSTEM) + len(prompt) + 40) / ZEICHEN_PRO_TOKEN_TEXT


# --- Strikte Ordner ------------------------------------------------------------------


def test_ordner_aus_strikt() -> None:
    k = _kontext()
    assert ordner_aus(VERTRAEGE, k) == VERTRAEGE
    assert ordner_aus(" 04_PARTNER ", k) == "04_PARTNER", "Whitespace stört nicht"
    assert ordner_aus("", k) is None and ordner_aus(None, k) is None and ordner_aus(7, k) is None
    assert ordner_aus("02_LOCATIONS/03_Erfunden", k) is None, "erfundener Pfad → null"
    assert ordner_aus("01_Halle_Nord", k) is None, "Ordnername allein ist kein Pfad"


def test_neuer_ordner_aus() -> None:
    k = _kontext()
    assert neuer_ordner_aus("04_PARTNER/02_Blumen_Meier", k) == "04_PARTNER/02_Blumen_Meier"
    assert neuer_ordner_aus("02_LOCATIONS/01_Halle_Nord/03_Protokolle", k) == "02_LOCATIONS/01_Halle_Nord/03_Protokolle"
    assert neuer_ordner_aus("NICHT_DA/Neu", k) is None, "Eltern muss existieren"
    assert neuer_ordner_aus("04_PARTNER/Müller", k) is None, "Umlaute verletzen die Hauskonvention"
    assert neuer_ordner_aus("04_PARTNER/01_Blumen_Mueller", k) is None, "bestehender Ordner ist nicht neu"
    assert neuer_ordner_aus("04_PARTNER", k) is None and neuer_ordner_aus("", k) is None
    assert neuer_ordner_aus("04_PARTNER/a/b", k) is None, "nur eine neue Ebene unter einem bestehenden Ordner"
    assert neuer_ordner_aus("04_PARTNER/" + "X" * 200, k) is None, "Längengrenze"


# --- Prompt-Reihenfolge (KV-Cache) ----------------------------------------------------


def test_prompt_statisches_zuerst_auftrag_zuletzt() -> None:
    k = _kontext()
    statisch = kontext_block(k)
    p1, _ = prompt_fuer(k, _extrakt("Mietvertrag Halle Nord, gültig ab 1.1.2026."), "vertrag.pdf", CFG)
    p2, _ = prompt_fuer(k, Extrakt(text="Rechnung Nr. 7", mime="text/plain", ocr=True, hinweis="x"), "re.txt", CFG)
    assert p1.startswith(statisch) and p2.startswith(statisch), "gleicher Anfang für jeden Auftrag = KV-Cache-Treffer"
    assert statisch.index("Erlaubte Dokumenttypen") < statisch.index("Mitarbeitende") and all(n in statisch for n in MITARBEITER)
    assert not any(o in p1 for o in HAUS[1:]), "Stufe 1 sieht keine Ordnerliste mehr"
    assert "ordner" not in SYSTEM.lower().replace("zielordner", ""), "Ordnerregeln stehen im Anhang der Stufe 2"
    for p, name in ((p1, "vertrag.pdf"), (p2, "re.txt")):
        auftrag = p[p.index(AUFTRAG_MARKER) :]
        assert "Heutiges Datum: 2026-10-03" in auftrag and f"Dateiname: {name}" in auftrag
        assert "Dateityp:" in auftrag and "Dokumentinhalt:" in auftrag
    assert "Heutiges Datum" not in statisch and "Dateiname" not in statisch
    assert "Text per OCR" in p2 and "Hinweis: x" in p2 and "Text per OCR" not in p1
    assert "[img]" not in p1 and HINWEIS_BILD_OHNE_TEXT not in p1
    assert p1.rstrip().endswith(">>>"), "Dokumentinhalt ist das Letzte"


def test_prompt_bild_platzhalter_am_ende() -> None:
    k = _kontext()
    foto = Extrakt(text="", mime="image/jpeg", seiten=1, ocr=True, ist_bild=True, hinweis="Kein lesbarer Text gefunden")
    p, _ = prompt_fuer(k, foto, "foto.jpg", CFG, mit_bild=True, foto=True)
    assert p.startswith(kontext_block(k)), "auch ein Foto behält den statischen Anfang"
    assert p.rstrip().endswith("[img]"), "Bild-Platzhalter ganz am Ende (Ollama setzt das Bild dort ein)"
    assert p.count("[img]") == 1 and HINWEIS_BILD_OHNE_TEXT in p
    assert "(kein Text lesbar)" in _inhalt(p)
    p_scan, _ = prompt_fuer(k, Extrakt(text="Rechnung 12", mime="image/png", ocr=True, ist_bild=True), "scan.png", CFG, mit_bild=True)
    assert HINWEIS_BILD_OHNE_TEXT not in p_scan and p_scan.rstrip().endswith("[img]")


def test_stufe2_anhang() -> None:
    kandidaten = [(VERTRAEGE, ["Mietvertrag 2025.pdf", "Nachtrag 1.pdf"]), (ALPHA, [])]
    a = stufe2_anhang(kandidaten, "Vertrag", "Mietvertrag Halle Nord")
    assert a.startswith(STUFE2_MARKER), "wird hinten an den Stufe-1-Prompt gehängt — der Anfang bleibt gleich"
    assert f"1. {VERTRAEGE}\n   dort abgelegt: Mietvertrag 2025.pdf; Nachtrag 1.pdf" in a
    assert f"2. {ALPHA}\n   (noch keine Dateien)" in a
    assert "Dokumenttyp aus Schritt 1: Vertrag. Beschrieb: Mietvertrag Halle Nord" in a
    assert "AUSSCHLIESSLICH exakt einen Pfad" in a and "neuer_ordner" in a
    assert "Unterlagen zu einer bestimmten Veranstaltung gehören zum Projekt" in a, "Hauskonvention Projekt vor Location"
    assert HINWEIS_STUFE2_BILD_OHNE_TEXT not in a and HINWEIS_STUFE2_BILD_OHNE_TEXT in stufe2_anhang(kandidaten, "Sonstiges", "", foto=True)
    lang = stufe2_anhang([(VERTRAEGE, ["N" * 300])], "Vertrag", "")
    assert "N" * 80 not in lang and "…" in lang, "lange Dateinamen gekürzt"
    s = schema_stufe2([VERTRAEGE, ALPHA])
    assert s["properties"]["ordner"]["enum"] == ["", VERTRAEGE, ALPHA], "Kandidaten oder «keiner»"
    assert s["properties"]["neuer_ordner"] == {"type": "string", "maxLength": MAX_ZEICHEN_NEUER_ORDNER}
    assert s["required"] == ["ordner", "neuer_ordner"]
    # Antwortbudget Stufe 2: längster Pfad + neuer_ordner + JSON-Gerüst (Pfade ~1,6 Zeichen/Token).
    assert ANTWORT_TOKENS_STUFE2 >= (200 + MAX_ZEICHEN_NEUER_ORDNER) / 1.6 + 40


# --- Kontextfenster -------------------------------------------------------------


def test_fenster_standard_und_reserve_fuer_stufe2() -> None:
    k = _kontext()
    prompt, num_ctx = prompt_fuer(k, _extrakt("Police Nr. 1, gültig ab 1.1.2026."), "police.pdf", CFG)
    assert num_ctx == CFG.llm_num_ctx == 8192, "ohne Ordnerliste im Prompt reicht das Standardfenster"
    assert MARKER not in prompt
    # Ein voller Anhang (alle Kandidaten mit dem längsten Pfad und drei langen Dateinamen) passt in die Reserve.
    voll = stufe2_anhang([("X" * 200, ["N" * 300] * 5)] * (ANZAHL_KANDIDATEN + 3), "T" * 100, "B" * 400, foto=True)
    assert len(voll) / ZEICHEN_PRO_TOKEN_ORDNER <= STUFE2_ANHANG_TOKENS == stufe2_anhang_tokens(200), (len(voll), STUFE2_ANHANG_TOKENS)
    langer_pfad = "02_LOCATIONS/" + "L" * 250
    k_lang = _kontext(ordner=HAUS + [langer_pfad])
    _, n_lang = prompt_fuer(k_lang, _extrakt("kurz"), "x.pdf", CFG)
    p_lang, _ = prompt_fuer(k_lang, _extrakt("kurz"), "x.pdf", CFG)
    anhang_lang = stufe2_anhang([(langer_pfad, ["N" * 80] * 3)] * ANZAHL_KANDIDATEN, "Vertrag", "B" * 200, foto=True)
    assert _geschaetzte_tokens(p_lang) + len(anhang_lang) / ZEICHEN_PRO_TOKEN_ORDNER + ANTWORT_TOKENS_STUFE2 <= n_lang, "Reserve wächst mit dem längsten Pfad"
    lang = "".join(f"Zeile {i}: Vertragsinhalt mit Fristen und Beträgen.\n" for i in range(3000))
    p, n = prompt_fuer(k, _extrakt(lang), "vertrag.pdf", CFG)
    reserve = stufe2_anhang_tokens(max(len(o) for o in HAUS))
    assert _geschaetzte_tokens(p) + reserve + ANTWORT_TOKENS_STUFE2 <= n, "Stufe 2 passt ins gleiche Fenster"
    assert _geschaetzte_tokens(p) + ANTWORT_TOKENS <= n


def test_langes_dokument_wird_auf_das_fenster_gekuerzt() -> None:
    k = _kontext()
    lang = "".join(f"Zeile {i}: Vertragsinhalt mit Fristen und Beträgen.\n" for i in range(3000))
    prompt, num_ctx = prompt_fuer(k, _extrakt(lang), "vertrag.pdf", CFG)
    inhalt = _inhalt(prompt)
    assert MARKER in inhalt and num_ctx == 8192
    assert inhalt.startswith(lang[:200]), "Kopf (Titel, Parteien) bleibt"
    assert inhalt.endswith(lang.rstrip("\n")[-100:]) or inhalt.endswith(lang[-100:]), "Schwanz (Fristen, Unterschriften) bleibt"
    assert len(inhalt) <= CFG.llm_max_zeichen + len(MARKER) + 4


def test_fenster_waechst_nur_bei_riesigen_listen() -> None:
    # 300 Mitarbeitende mit langen Namen: der statische Teil wächst, das Fenster in 4096er-Stufen.
    viele = [f"Vorname{i} Sehrlangernachname{i}-Doppelname" for i in range(300)]
    k = _kontext(mitarbeiter=viele)
    prompt, num_ctx = prompt_fuer(k, _extrakt("kurz"), "x.pdf", CFG)
    assert CFG.llm_num_ctx < num_ctx <= MAX_NUM_CTX and num_ctx % KONTEXT_SCHRITT == 0, num_ctx
    _, num_ctx_4k = prompt_fuer(k, _extrakt("kurz"), "x.pdf", dataclasses.replace(CFG, llm_num_ctx=4096))
    assert num_ctx_4k == num_ctx, "die Stufe hängt nur vom Prompt ab"
    # Gemma 3 braucht 256 Tokens je Bild — Scan und Text teilen das Fenster (kein Neuladen).
    _, n_text = prompt_fuer(_kontext(), _extrakt("Rechnung"), "x.pdf", CFG)
    _, n_bild = prompt_fuer(_kontext(), _extrakt("Rechnung"), "x.jpg", CFG, mit_bild=True, bild_reserve=bild_tokens("gemma3:4b"))
    assert n_text == n_bild == 8192
    assert bild_tokens("gemma3:4b") == 320 and bild_tokens("qwen2.5vl:3b") == 1600


# --- Schema -------------------------------------------------------------------------


def test_schema_stufe1() -> None:
    k = _kontext()
    s = schema_fuer(k)
    assert s["type"] == "object" and s["required"] == list(s["properties"])
    assert "ordner" not in s["properties"] and "neuer_ordner" not in s["properties"], "Ordner erst in Stufe 2"
    for feld, n in MAX_ZEICHEN.items():
        assert s["properties"][feld] == {"type": "string", "maxLength": n}, feld
    assert s["properties"]["typ"]["enum"] == [t for t, _ in k.typen]
    assert s["properties"]["person"]["enum"] == [""] + MITARBEITER
    assert MAX_ZEICHEN["beschrieb"] == 200, "wie bereinigeAblageErgebnis im FSM"
    leer = Kontext(heute="2026-10-03", ordner=[], typen=list(DOK_TYPEN_STANDARD), mitarbeiter=[])
    assert schema_fuer(leer)["properties"]["person"] == {"type": "string", "maxLength": 120}
    foto = schema_fuer(k, foto=True)
    assert foto["properties"]["typ"] == {"type": "string", "enum": ["sonstiges"]}, "Foto ohne Text: Typ fest"
    assert foto["properties"]["beschrieb"] == {"type": "string", "maxLength": 200}


def test_bild_ohne_text() -> None:
    foto = Extrakt(text="", mime="image/jpeg", seiten=1, ocr=True, ist_bild=True)
    assert bild_ohne_text(foto)
    assert bild_ohne_text(dataclasses.replace(foto, text="| ~ .  -- '")), "OCR-Zufallszeichen zählen nicht"
    assert bild_ohne_text(dataclasses.replace(foto, text="ab 12"))
    assert not bild_ohne_text(dataclasses.replace(foto, text="Rechnung Nr. 12"))
    assert not bild_ohne_text(Extrakt(text="", mime="application/pdf", seiten=1)), "leeres PDF ist kein Foto"


def test_ganze_saetze() -> None:
    assert ganze_saetze(None, 800) == "" and ganze_saetze("", 800) == "" and ganze_saetze(42, 800) == ""
    text = "Erster Satz. Zweiter Satz! Dritter Satz? Vierter Satz ohne Ende und dann " + "x" * 800
    assert ganze_saetze(text, 800) == "Erster Satz. Zweiter Satz! Dritter Satz?"
    assert ganze_saetze("Die Police gilt ab 2026. Die Police gilt ab 2026. Sie endet 2028.", 800) == "Die Police gilt ab 2026. Sie endet 2028."
    kurz = "Rechnung über CHF 1'541.51 von Blumen Müller"
    assert ganze_saetze(kurz, 800) == kurz
    s = "Police Nr. 12.345.678/0001 über CHF 2'480.00 jährlich. Kündbar bis 30.9.2028."
    assert ganze_saetze(s, 800) == s
    assert ganze_saetze("Grüße  aus\nBasel. ", 800) == "Grüsse aus Basel."
    assert len(ganze_saetze("Wort " * 500, 800)) <= 800


# --- Nachprüfung ----------------------------------------------------------------------


def _pruefe(roh: dict, k: Kontext, **kw) -> dict:
    return pruefe_ergebnis(roh, k, _extrakt("x"), sha256="0" * 64, modell="m", dauer_ms=1, dateiname="x.pdf", **kw)


ERGEBNIS_FELDER = {"beschrieb", "typ", "betreff", "person", "partei", "nummer", "dok_datum", "frist", "ordner", "neuer_ordner",
                   "ordner_alternativen", "zusammenfassung", "sha256", "seiten", "ocr", "modell", "dauer_ms"}


def test_pruefe_ergebnis_grenzen() -> None:
    k = _kontext()
    e = _pruefe(
        {
            "beschrieb": "B" * 500, "typ": "unbekannt", "betreff": "Haftpflicht", "person": "tim", "partei": "EVENTLINE GmbH",
            "nummer": " 12 345 ", "dok_datum": "15.1.2026", "frist": "2026-02-30", "ordner": "99_GIBT_ES_NICHT",
            "neuer_ordner": "00_ADMIN_RECHT/Neuer_Ordner_1", "zusammenfassung": "Satz eins. Satz eins. Satz zwei",
        },
        k,
    )
    assert set(e) == ERGEBNIS_FELDER, "Protokoll zum FSM: wie bisher plus ordner_alternativen"
    assert len(e["beschrieb"]) == MAX_ZEICHEN["beschrieb"] and e["typ"] == "sonstiges" and e["person"] == "Tim Näf"
    assert e["partei"] is None, "EVENTLINE selbst ist nie die Gegenpartei"
    assert e["nummer"] == "12 345" and e["dok_datum"] is None and e["frist"] is None
    assert e["ordner"] is None and e["neuer_ordner"] == "00_ADMIN_RECHT/Neuer_Ordner_1" and e["ordner_alternativen"] == []
    assert e["zusammenfassung"] == "Satz eins. Satz zwei" and e["modell"] == "m" and e["seiten"] == 2 and e["ocr"] is False


def test_pruefe_ergebnis_ordner_alternativen() -> None:
    k = _kontext()
    e = _pruefe({"ordner": VERTRAEGE, "neuer_ordner": "04_PARTNER/Egal"}, k, alternativen=[VERTRAEGE, "ERFUNDEN", ALPHA, ALPHA, KORR_2026, "04_PARTNER"])
    assert e["ordner"] == VERTRAEGE and e["neuer_ordner"] is None, "neuer Ordner nur ohne Treffer"
    assert e["ordner_alternativen"] == [ALPHA, KORR_2026], "nur gültige Pfade, ohne Hauptwahl, ohne Doppelte, höchstens zwei"
    assert ANZAHL_ALTERNATIVEN == 2
    assert _pruefe({"ordner": ""}, k, alternativen=[ALPHA])["ordner_alternativen"] == [ALPHA], "auch ohne Hauptwahl"
    e2 = _pruefe({"typ": "rechnung", "partei": "Blumen Müller AG", "nummer": "R-1"}, k)
    assert e2["beschrieb"] == "Rechnung, Blumen Müller AG, Nr. R-1"
    assert _pruefe({"typ": "sonstiges"}, k)["beschrieb"] == "Dokument x.pdf"
    # Foto ohne Text: Typ fest «sonstiges», der Ordner darf aus Dateiname + Vorbildern kommen.
    f = _pruefe({"typ": "vertrag", "ordner": ALPHA, "beschrieb": "Foto einer Bühne"}, k, foto=True)
    assert f["typ"] == "sonstiges" and f["ordner"] == ALPHA and f["beschrieb"] == "Foto einer Bühne"


def test_person_nur_bei_personen_typen() -> None:
    personen_typen = {"lohnabrechnung", "behoerde", "zertifikat"}
    k = lese_kontext(
        {"ordner": HAUS, "dok_typen": [{"key": key, "label": label, "person": key in personen_typen} for key, label in DOK_TYPEN_STANDARD],
         "mitarbeiter": MITARBEITER},
        "2026-10-03",
    )
    assert k.personen_typen == frozenset(personen_typen)
    assert _pruefe({"typ": "rechnung", "person": "Tim Näf"}, k)["person"] is None, "eine Rechnung kennt keine Person"
    assert _pruefe({"typ": "unbekannt", "person": "Tim Näf"}, k)["person"] is None, "Rückfall auf sonstiges = keine Person"
    assert _pruefe({"typ": "zertifikat", "person": "tim"}, k)["person"] == "Tim Näf"
    assert _pruefe({"typ": "zertifikat", "person": "fremd"}, k)["person"] is None, "nur Namen aus der Mitarbeiterliste"
    ohne = _kontext()
    assert ohne.personen_typen is None and _pruefe({"typ": "rechnung", "person": "Tim Näf"}, ohne)["person"] == "Tim Näf"


def test_finde_person() -> None:
    assert finde_person("tim", MITARBEITER) == "Tim Näf"
    assert finde_person("näf tim", MITARBEITER) == "Tim Näf"
    assert finde_person("keller", MITARBEITER) is None, "mehrdeutig = keiner"
    assert finde_person("anna keller", MITARBEITER) == "Anna Keller"
    assert finde_person("fremd", MITARBEITER) is None and finde_person("", MITARBEITER) is None


def test_lese_kontext_tolerant() -> None:
    k = lese_kontext(
        {"folders": ["A", "A", {"pfad": "B"}, 7], "typen": {"vertrag": "Vertrag"}, "employees": ["X Y"], "heute": "kaputt"},
        "2026-10-03",
    )
    assert k.ordner == ["A", "B"] and k.typen == [("vertrag", "Vertrag")] and k.mitarbeiter == ["X Y"]
    assert k.heute == "2026-10-03" and k.personen_typen is None
    leer = lese_kontext({}, "2026-10-03")
    assert leer.typen == list(DOK_TYPEN_STANDARD) and leer.ordner == [] and leer.mitarbeiter == []
    teil = lese_kontext({"dok_typen": [{"key": "zertifikat", "person": True}, {"key": "rechnung"}]}, "2026-10-03")
    assert teil.personen_typen == frozenset({"zertifikat"})


# --- Ganzer Durchlauf mit Attrappen -----------------------------------------------------


class _Attrappe:
    """Spielt Ollama: merkt sich jeden Aufruf (Chat und Einbettung) in Reihenfolge, Chat antwortet der Reihe nach."""

    def __init__(self, *antworten: dict | Exception, einbettung: Exception | None = None) -> None:
        self.antworten = list(antworten)
        self.aufrufe: list[dict] = []
        self.reihenfolge: list[str] = []
        self.einbettung = einbettung

    def chat_json(self, **kw):  # noqa: ANN003, ANN201
        self.aufrufe.append(kw)
        self.reihenfolge.append("chat")
        antwort = self.antworten[len(self.aufrufe) - 1]
        if isinstance(antwort, Exception):
            raise antwort
        meta = {"modell": kw["modell"], "num_ctx": kw["num_ctx"], "dauer_ms": 1, "prompt_tokens": 1,
                "antwort_tokens": 1, "lade_ms": 0, "prompt_ms": 0, "antwort_ms": 0}
        return dict(antwort), meta

    geladen: list[str] = []  # was «ollama ps» melden würde (Namen wie Ollama sie schreibt)

    def geladene_modelle(self) -> list[dict]:
        return [{"name": n} for n in self.geladen]

    def entlade(self, modell: str | None = None) -> None:
        self.reihenfolge.append(f"entlade:{modell}")

    def einbetten(self, *, modell: str, texte: list[str], timeout_s: float = 120.0):  # noqa: ANN201
        self.reihenfolge.append("einbetten")
        if self.einbettung is not None:
            raise self.einbettung
        # Ordnertexte bekommen einen eigenen Vektor; das Dokument zeigt in Richtung «Vertrag».
        return [[1.0, 0.0] if "Vertr" in t else [0.0, 1.0] for t in texte], {"modell": modell, "dauer_ms": 1, "lade_ms": 0, "prompt_tokens": 1}


class _Archiv:
    """Spielt den Archiv-Index: feste Vorbilder; merkt sich die Ausschlüsse (Leave-one-out im Probelauf)."""

    aktiv = True

    def __init__(self, nachbarn: list[Nachbar], namen: dict[str, list[str]] | None = None) -> None:
        self._nachbarn = nachbarn
        self._namen = namen or {}
        self.ausschluss: list[tuple] = []

    def nachbarn(self, vektor, *, ordner, k, ohne_sha=(), ohne_pfade=()):  # noqa: ANN001, ANN201
        self.ausschluss.append((tuple(ohne_pfade), tuple(ohne_sha)))
        return [n for n in self._nachbarn if n.ordner in ordner and n.pfad not in ohne_pfade][:k]

    def ordner_mit_dateien(self, *, ohne_sha=(), ohne_pfade=()):  # noqa: ANN001, ANN201
        return {n.ordner for n in self._nachbarn}

    def ordner_vektoren(self, pfade, einbetten):  # noqa: ANN001, ANN201
        pfade = list(pfade)
        return dict(zip(pfade, einbetten(pfade)))

    def namen_in(self, ordner, *, je_ordner, ohne_sha=(), ohne_pfade=()):  # noqa: ANN001, ANN201
        return {o: self._namen[o][:je_ordner] for o in ordner if o in self._namen}


STUFE1 = {"beschrieb": "Mietvertrag Halle Nord", "typ": "vertrag", "betreff": "Miete", "person": "", "partei": "Halle Nord AG",
          "nummer": "", "dok_datum": "2026-01-15", "frist": "", "zusammenfassung": "Vertrag."}
VORBILDER = [
    Nachbar(pfad=VERTRAEGE + "/Mietvertrag 2025.pdf", ordner=VERTRAEGE, name="Mietvertrag 2025.pdf", aehnlichkeit=0.92),
    Nachbar(pfad=KORR_2026 + "/Brief.pdf", ordner=KORR_2026, name="Brief.pdf", aehnlichkeit=0.80),
]


def _kontext_roh(ordner: list[str] | None = None) -> dict:
    return {"ordner": HAUS if ordner is None else ordner, "dok_typen": [{"key": k, "label": l} for k, l in DOK_TYPEN_STANDARD],
            "mitarbeiter": MITARBEITER, "heute": "2026-10-03"}


def _analyse(llm: _Attrappe, *, archiv=None, text: str = "Mietvertrag Halle Nord, Basel, 15.1.2026.", dateiname: str = "vertrag.txt",
             ordner: list[str] | None = None, messung: dict | None = None, ohne=((), ())) -> dict:
    with tempfile.TemporaryDirectory() as d:
        datei = Path(d) / dateiname
        datei.write_text(text, encoding="utf-8")
        return ablage_analyse(pfad=datei, dateiname=dateiname, mime="text/plain", sha256="0" * 64, kontext_roh=_kontext_roh(ordner),
                              llm=llm, cfg=CFG, archiv=archiv, ohne_vorbilder=ohne, messung=messung)


def test_ablage_nach_vorbild() -> None:
    archiv = _Archiv(VORBILDER, {ALPHA: ["Offerte.pdf"]})
    llm = _Attrappe(STUFE1, {"ordner": VERTRAEGE, "neuer_ordner": ""})
    messung: dict = {}
    e = _analyse(llm, archiv=archiv, messung=messung, ohne=(["02_LOCATIONS/x.pdf"], ["f" * 64]))
    assert e["ordner"] == VERTRAEGE and e["neuer_ordner"] is None and e["typ"] == "vertrag" and e["dok_datum"] == "2026-01-15"
    assert set(e) == ERGEBNIS_FELDER and len(e["ordner_alternativen"]) == 2 and VERTRAEGE not in e["ordner_alternativen"]
    assert all(a in HAUS for a in e["ordner_alternativen"])
    assert llm.reihenfolge[0] == "einbetten" and llm.reihenfolge[-2:] == ["chat", "chat"], "Einbettung vor dem Sprachmodell (ein Modellwechsel)"
    assert archiv.ausschluss == [(("02_LOCATIONS/x.pdf",), ("f" * 64,))], "Leave-one-out kommt beim Index an"
    s1, s2 = llm.aufrufe
    assert "ordner" not in s1["schema"]["properties"] and s1["system"] == SYSTEM and s1["num_predict"] == ANTWORT_TOKENS
    assert s1["nutzer"].startswith(kontext_block(lese_kontext(_kontext_roh(), "x")))
    # Stufe 2: derselbe Prompt plus Anhang (KV-Cache), gleiches Modell und Fenster, Kandidaten als Enum.
    assert s2["nutzer"].startswith(s1["nutzer"]) and s2["nutzer"][len(s1["nutzer"]):].startswith(STUFE2_MARKER)
    assert s2["modell"] == s1["modell"] and s2["num_ctx"] == s1["num_ctx"] and s2["num_predict"] == ANTWORT_TOKENS_STUFE2
    enum = s2["schema"]["properties"]["ordner"]["enum"]
    assert enum[0] == "" and enum[1] == VERTRAEGE and 2 <= len(enum) - 1 <= ANZAHL_KANDIDATEN, enum
    assert "dort abgelegt: Mietvertrag 2025.pdf" in s2["nutzer"], "Dateinamen der Vorbilder als Kontext"
    assert messung["quelle"] == "ki" and messung["rangliste"][0] == VERTRAEGE and messung["nachbarn"] == 2 and messung["archiv_ok"]


def test_ablage_knapper_vram_entlaedt_sprachmodell_vor_einbettung() -> None:
    # Whisper noch geladen (bis 5 min nach einem Diktat) + Sprachmodell drin → unter KI_EMBED_MIN_FREI_MB wird das
    # Sprachmodell vor der Einbettung entladen (sonst läuft bge-m3 fast ganz im Hauptspeicher, gemessen 24 s statt 2 s).
    import app.handlers.ablage as modul

    echt = modul.gpu_info
    try:
        modul.gpu_info = lambda max_alter_s=10.0: {"name": "RTX", "frei_mb": 1024}
        llm = _Attrappe(STUFE1, {"ordner": VERTRAEGE, "neuer_ordner": ""})
        llm.geladen = [CFG.modell_text, CFG.modell_embed + ":latest"]  # Sprachmodell und bge-m3 drin
        e = _analyse(llm, archiv=_Archiv(VORBILDER))
        assert e["ordner"] == VERTRAEGE
        assert llm.reihenfolge[:2] == [f"entlade:{CFG.modell_text}", "einbetten"], llm.reihenfolge
        assert llm.reihenfolge.count(f"entlade:{CFG.modell_text}") == 1 and not any(
            r.startswith("entlade:" + CFG.modell_embed) for r in llm.reihenfolge
        ), "nur das geladene Sprachmodell weg — das Einbettungsmodell bleibt"
        # Knapp, aber kein Sprachmodell geladen → nichts entladen (Ollama würde es sonst erst laden).
        llm1 = _Attrappe(STUFE1, {"ordner": VERTRAEGE, "neuer_ordner": ""})
        _analyse(llm1, archiv=_Archiv(VORBILDER))
        # Genug frei → nichts entladen; ohne GPU-Auskunft (None) ebenfalls nicht.
        modul.gpu_info = lambda max_alter_s=10.0: {"name": "RTX", "frei_mb": 2994}
        llm2 = _Attrappe(STUFE1, {"ordner": VERTRAEGE, "neuer_ordner": ""})
        llm2.geladen = [CFG.modell_text]
        _analyse(llm2, archiv=_Archiv(VORBILDER))
        modul.gpu_info = lambda max_alter_s=10.0: {"name": None, "frei_mb": None}
        llm3 = _Attrappe(STUFE1, {"ordner": VERTRAEGE, "neuer_ordner": ""})
        llm3.geladen = [CFG.modell_text]
        _analyse(llm3, archiv=_Archiv(VORBILDER))
        assert not any(r.startswith("entlade") for r in llm1.reihenfolge + llm2.reihenfolge + llm3.reihenfolge)
    finally:
        modul.gpu_info = echt


def test_ablage_int_regel_ohne_stufe2() -> None:
    llm = _Attrappe({**STUFE1, "typ": "offerte"})
    messung: dict = {}
    e = _analyse(llm, archiv=_Archiv(VORBILDER), dateiname="Offerte INT-26-001.txt", text="Offerte Sommerfest", messung=messung)
    assert e["ordner"] == ALPHA and len(llm.aufrufe) == 1, "Regel entscheidet — kein zweiter Modellaufruf"
    assert messung["quelle"] == "regel" and messung["regel_art"] == "int"


def test_ablage_stufe2_keiner_passt() -> None:
    llm = _Attrappe(STUFE1, {"ordner": "", "neuer_ordner": "02_LOCATIONS/01_Halle_Nord/03_Protokolle"})
    messung: dict = {}
    e = _analyse(llm, archiv=_Archiv(VORBILDER), messung=messung)
    assert e["ordner"] is None and e["neuer_ordner"] == "02_LOCATIONS/01_Halle_Nord/03_Protokolle"
    assert e["ordner_alternativen"][0] == VERTRAEGE, "ohne Hauptwahl: die besten zwei als Alternativen"
    assert messung["quelle"] == "ki_keiner"
    llm = _Attrappe(STUFE1, {"ordner": "", "neuer_ordner": "02_LOCATIONS/01_Halle_Nord/Protokolle Müller"})
    assert _analyse(llm, archiv=_Archiv(VORBILDER))["neuer_ordner"] is None, "Hauskonvention für neue Namen"
    llm = _Attrappe(STUFE1, {"ordner": "04_PARTNER/01_Blumen_Mueller", "neuer_ordner": ""})
    assert _analyse(llm, archiv=_Archiv(VORBILDER))["ordner"] is None, "nur Kandidaten zählen (Schema verhindert anderes ohnehin)"


def test_ablage_stufe2_modellfehler_nimmt_rangliste() -> None:
    from app.handlers import VerarbeitungsFehler

    llm = _Attrappe(STUFE1, LlmFehler("Modell gemma3:4b hat nicht rechtzeitig geantwortet"))
    messung: dict = {}
    e = _analyse(llm, archiv=_Archiv(VORBILDER), messung=messung)
    assert e["ordner"] == VERTRAEGE and messung["quelle"] == "rangliste", "Stufe 1 bleibt, der Ordner kommt aus der Rangliste"
    assert e["typ"] == "vertrag" and len(llm.aufrufe) == 2
    llm = _Attrappe(LlmFehler("Modell gemma3:4b hat nicht rechtzeitig geantwortet"))
    try:
        _analyse(llm, archiv=_Archiv(VORBILDER))
    except VerarbeitungsFehler as fehler:
        assert "nicht rechtzeitig" in str(fehler)
    else:
        raise AssertionError("Stufe-1-Fehler muss als VerarbeitungsFehler nach aussen")


def test_ablage_ohne_archiv_und_ohne_einbettung() -> None:
    # DB aus (kein Archiv): Rangliste aus Ordnernamen — das Projekt steht im Text.
    llm = _Attrappe({**STUFE1, "typ": "offerte"}, {"ordner": ALPHA, "neuer_ordner": ""})
    e = _analyse(llm, archiv=None, text="Offerte Sommerfest Firma Alpha", dateiname="offerte.txt")
    assert e["ordner"] == ALPHA
    # Einbettungsmodell fehlt: trotzdem ein Ergebnis (Stufe 1); ohne Vorbilder und Vektoren entscheiden nur Namen.
    llm = _Attrappe(STUFE1, {"ordner": "", "neuer_ordner": ""}, einbettung=LlmFehler("Modell bge-m3 ist nicht installiert"))
    messung: dict = {}
    e2 = _analyse(llm, archiv=_Archiv(VORBILDER), messung=messung)
    assert e2["typ"] == "vertrag" and messung["nachbarn"] == 0 and not messung["archiv_ok"]


def test_ablage_stufe1_wiederholungsschleife_zweiter_versuch() -> None:
    from app.handlers import VerarbeitungsFehler

    schleife = LlmFehler("Ollama-Fehler 500: prediction aborted, token repeat limit reached")
    llm = _Attrappe(schleife, STUFE1, {"ordner": VERTRAEGE, "neuer_ordner": ""})
    e = _analyse(llm, archiv=_Archiv(VORBILDER))
    assert e["ordner"] == VERTRAEGE and e["typ"] == "vertrag"
    v1, v2, _ = llm.aufrufe
    assert v1["nutzer"] == v2["nutzer"] and v1["schema"] == v2["schema"] and "optionen" not in v1 and v2["optionen"] == ZWEITER_VERSUCH
    llm = _Attrappe(schleife, schleife)
    try:
        _analyse(llm, archiv=_Archiv(VORBILDER))
    except VerarbeitungsFehler as fehler:
        assert "repeat limit" in str(fehler) and len(llm.aufrufe) == 2
    else:
        raise AssertionError("zwei Schleifen = Fehler")


def test_ablage_ohne_ordnerliste() -> None:
    llm = _Attrappe(STUFE1)
    messung: dict = {}
    e = _analyse(llm, archiv=_Archiv(VORBILDER), ordner=[], messung=messung)
    assert e["ordner"] is None and e["ordner_alternativen"] == [] and len(llm.aufrufe) == 1 and llm.reihenfolge == ["chat"]
    assert messung["quelle"] == "keine"


def test_ablage_foto_ohne_text() -> None:
    from PIL import Image

    logos = "04_PARTNER/01_Blumen_Mueller"
    archiv = _Archiv([Nachbar(pfad=logos + "/Logo_rot.png", ordner=logos, name="Logo_rot.png", aehnlichkeit=0.9)])
    llm = _Attrappe({"beschrieb": "Logo in Rot", "typ": "vertrag", "betreff": "Logo", "person": "", "partei": "", "nummer": "",
                     "dok_datum": "", "frist": "", "zusammenfassung": "Logo."}, {"ordner": logos, "neuer_ordner": ""})
    with tempfile.TemporaryDirectory() as d:
        datei = Path(d) / "Logo_gruen.png"
        Image.new("RGB", (64, 48), (40, 40, 40)).save(datei)
        cfg = dataclasses.replace(CFG, tmp_dir=Path(d), ocr_timeout_s=20)
        e = ablage_analyse(pfad=datei, dateiname="Logo_gruen.png", mime="image/png", sha256="0" * 64, kontext_roh=_kontext_roh(),
                           llm=llm, cfg=cfg, archiv=archiv)
    assert e["typ"] == "sonstiges" and e["ocr"] is True and e["beschrieb"] == "Logo in Rot", "Typ fest, Beschrieb vom Bildmodell"
    assert e["ordner"] == logos, "Logo zu Logos: Dateiname + Vorbilder tragen den Ordner"
    s1, s2 = llm.aufrufe
    assert s1["schema"]["properties"]["typ"] == {"type": "string", "enum": ["sonstiges"]}
    assert s1["bilder"] and s1["modell"] == cfg.modell_bild and s1["nutzer"].rstrip().endswith("[img]")
    assert HINWEIS_BILD_OHNE_TEXT in s1["nutzer"] and HINWEIS_STUFE2_BILD_OHNE_TEXT in s2["nutzer"]
    assert s2["bilder"] == s1["bilder"] and s2["nutzer"].startswith(s1["nutzer"]), "gleicher Anfang inkl. Bild (KV-Cache)"


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
