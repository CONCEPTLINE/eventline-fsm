"""ablage_analyse: Datei → Text/OCR → Sprachmodell → Vorschlag für Name, Ordner, Frist (SPEC §3.1).

Die Regeln stammen aus der bisherigen Claude-Route /api/ablage/name-vorschlag —
mit dem Unterschied, dass hier das Dokument selbst gelesen wird (lokal, im
Haus). Das Modell wird per JSON-Schema auf die erlaubten Werte eingeschränkt
(Typ, Ordner, Person), und das Ergebnis wird danach trotzdem geprüft: nichts
Erfundenes kommt durch, Datumsfelder müssen echte Daten sein.

Ordnerwahl «nach Vorbild» (Stand 2026-10-04, ersetzt die zweistufige Wahl aus der ganzen Ordnerliste):
1. Vorbilder: Einbettung (bge-m3) aus «Dateiname + Textanfang» → die ähnlichsten bereits einsortierten
   Dateien aus dem Archiv-Index (archiv.py, nur Ordner der FSM-Liste). Läuft vor dem Sprachmodell: bei
   nur einem Modell im VRAM gibt es so je Auftrag einen Modellwechsel statt zwei.
2. Stufe 1 (Sprachmodell): alle Felder ausser dem Ordner — Prompt ohne Ordnerliste, statischer Anfang
   (Regeln, Typen, Mitarbeitende) für den KV-Cache.
3. Rangliste (ordnerwahl.py): Regeln (INT-Nummer, Personalakte) vor allem anderen, dann Stimmen der
   Nachbarn, gleichnamige Ordner anderer Entitäten, Ordnernamen und Dokumenttyp.
4. Entscheid: Regel-Treffer direkt; sonst Stufe 2 — das Sprachmodell wählt unter den besten
   ANZAHL_KANDIDATEN (volle Pfade + Dateinamen der Vorbilder dort) oder «» (keiner passt → null).
   Derselbe Prompt plus Anhang: Ollama rechnet nur den Anhang neu.
5. ordner_alternativen: die nächstbesten zwei Ordner der Rangliste (gültige Pfade der FSM-Liste).
Bild ohne lesbaren Text (Foto, leere OCR): kein Ordner, Typ «sonstiges» — fest, nicht vom Modell.

V8 (2026-10-11, SPEC §3.1): zusätzlich `einordnung` (aus derselben Antwort der Stufe 1 — kein weiterer
Modellaufruf — minimiert in einordnung.py), `kandidaten` (bis 8 der Rangliste mit Gewicht/Quelle) und
`regel_ordner` (verbindliche Regel). Das FSM lässt damit Claude den Ordner bestimmen; die bisherigen Felder
bleiben als lokale Wahl und Rückfall unverändert.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Collection

from ..archiv import ArchivIndex, Nachbar, einbettungstext, lesbarer_name, nfc, platz_fuer_einbettung, unter_zz
from ..config import Einstellungen
from ..einordnung import BEZUG_ARTEN, PARTEI_ARTEN, baue_einordnung, kandidaten_v8, personal_hinweis, regel_ordner_v8, unter_personal
from ..extract import Extrakt, ExtraktFehler, bild_base64, extrahiere
from ..llm import LlmFehler, Ollama
from ..ordnerwahl import K_NACHBARN, Rangliste, rangliste
from . import VerarbeitungsFehler, datum_gueltig, text_kurz

log = logging.getLogger("ki.ablage")

# Spiegel von src/lib/ablage-doktypen.ts (Keys + Labels). Zur Laufzeit schickt
# das FSM seine Liste mit — je Typ mit Flag `person` (kennt der Typ eine betroffene
# Person?); dieser Satz dient dem Probelauf und als Rückfall.
DOK_TYPEN_STANDARD: list[tuple[str, str]] = [
    ("versicherungspolice", "Versicherungspolice"),
    ("vertrag", "Vertrag"),
    ("rechnung", "Rechnung"),
    ("offerte", "Offerte"),
    ("kuendigung", "Kündigung"),
    ("korrespondenz", "Korrespondenz"),
    ("protokoll", "Protokoll"),
    ("lohnabrechnung", "Lohnabrechnung"),
    ("bank", "Bank/Finanzen"),
    ("steuern", "Steuern"),
    ("behoerde", "Behörde/Amtliches"),
    ("zertifikat", "Zertifikat/Nachweis"),
    ("mahnung", "Mahnung"),
    ("sonstiges", "Sonstiges (freier Beschrieb)"),
]

MAX_ORDNER = 800
MAX_MITARBEITER = 300
MAX_NAMEN_ALLE = 2000
_NEUER_NAME = re.compile(r"^[A-Za-z0-9_]{2,80}$")
TYP_OHNE_ORDNER = "sonstiges"
# So viele Kandidaten sieht das Modell in Stufe 2 (gemessen 2026-10-04: die besten 5 enthalten das
# Ziel in ~80 %, mehr Auswahl macht das kleine Modell unsicherer).
ANZAHL_KANDIDATEN = 5
ANZAHL_ALTERNATIVEN = 2
MAX_ZEICHEN_DATEINAME_PROMPT = 80

# Bild gilt als «ohne Text», wenn die OCR weniger als so viele Buchstaben/Ziffern liefert
# (Fotos ergeben bei Tesseract oft ein paar Zufallszeichen wie «| ~ .», aber kein Wort).
MIN_BILD_TEXTZEICHEN = 8
_WORTZEICHEN = re.compile(r"[0-9A-Za-zÀ-ÿ]")

# Prompt-Budget ohne Tokenizer. Ist der Prompt länger als das Kontextfenster, kürzt Ollama
# ihn still auf die Hälfte des Fensters und behält nur das Ende — die Regeln wären weg
# (gemessen 2026-10-03: 9261 Tokens bei num_ctx 8192 → 4098). Gemessene Zeichen pro Token
# (gemma3): Regeln ~3,4, Dokumenttext ~3,1, Pfade und Dateinamen nur ~1,8. Die Werte unten
# liegen sicher darunter, das Fenster wird eher zu gross als zu klein gewählt.
ZEICHEN_PRO_TOKEN_TEXT = 2.5
ZEICHEN_PRO_TOKEN_ORDNER = 1.6
ANTWORT_TOKENS = 1000      # num_predict Stufe 1: das JSON braucht gemessen 350–550 Tokens
# Stufe 2: nur ordner + neuer_ordner — ein Pfad bis ~60 Tokens, neuer_ordner bis 160 Zeichen (~100 Tokens).
ANTWORT_TOKENS_STUFE2 = 400
RESERVE_TOKENS = 256       # Chat-Vorlage, Rollen-Marker, Rundung
# Ein Bild bis 1280 px: Gemma 3 fest 256 Tokens, Qwen2.5-VL/LLaVA bis ~1600. Der Wert entscheidet
# mit über die Fensterstufe — ein anderes num_ctx für Scans als für Texte lässt Ollama das Modell
# bei jedem Wechsel neu laden (3–5 s, gemessen 2026-10-03) und wirft den KV-Cache weg.
BILD_TOKENS = 1600
BILD_TOKENS_GEMMA = 320
# So viel Dokumenttext muss mindestens neben Regeln + Anhang passen, sonst wird das Fenster für
# diesen Auftrag vergrössert (in 4096er-Stufen).
MIN_DOKUMENT_TOKENS = 1500
KONTEXT_SCHRITT = 4096
MAX_NUM_CTX = 32768
# Zweiter Versuch nach Ollamas «token repeat limit» (Wiederholungsschleife bei temperature 0):
# wenig Zufall, fester Seed — reproduzierbar, aber eine andere Bahn als der erste Versuch.
ZWEITER_VERSUCH: dict[str, Any] = {"temperature": 0.3, "seed": 7, "repeat_penalty": 1.2}


def bild_tokens(modell: str) -> int:
    return BILD_TOKENS_GEMMA if modell.lower().startswith("gemma") else BILD_TOKENS


SYSTEM = """Du bist die lokale Ablage-KI der EVENTLINE GmbH (Eventtechnik-Firma, Basel). Du bekommst zuerst die erlaubten Dokumenttypen und die Namen der Mitarbeitenden — danach den Auftrag: Datum, Dateiname und den Textinhalt des Dokuments (ganz oder gekürzt). Du lieferst ausschliesslich die geforderten JSON-Felder.

Regeln:
- Übernimm ausschliesslich Informationen, die im Dokument oder Dateinamen stehen. NICHTS erfinden, NICHTS raten — im Zweifel das Feld leer lassen ("").
- Schweizer Kontext: "15.1.26" bedeutet 2026-01-15. Datumsfelder immer als YYYY-MM-DD.
- beschrieb: 1–2 Sätze auf Deutsch, was das Dokument ist (Art, Gegenpartei, Nummer, Gültigkeit/Frist) — so, wie ein Mensch es in der Ablage beschreiben würde. Keine Floskeln, keine Erfindungen.
- typ: der passendste Dokumenttyp aus der Liste; wenn keiner klar passt: "sonstiges".
- betreff: kürzester präziser Kern in 1–4 Wörtern (das WAS, z.B. "Haftpflicht", "Büro-Miete"). Ohne Typ-Wiederholung, ohne Datum, ohne Nummer, ohne Partei, ohne Person (die hat ein eigenes Feld).
- person: betroffene/r Mitarbeiter/in der EVENTLINE (Zertifikat, Kursbestätigung, Bewilligung, Lohnabrechnung, Arbeitsvertrag) — exakt EIN Name aus der Mitarbeiterliste, nie in den Betreff. Leer, wenn keine Person aus der Liste betroffen ist.
- partei: Gegenpartei/Aussteller aus Sicht der EVENTLINE GmbH (Versicherer, Vertragspartner, Bank, Behörde, Lieferant). Nie EVENTLINE selbst. Bei Arbeitsverträgen und ähnlichen personenbezogenen Verträgen ist die genannte Person die Partei.
- nummer: Referenz-/Policen-/Rechnungs-/Vertragsnummer exakt wie im Dokument, sonst leer.
- dok_datum: Datum DES DOKUMENTS (Ausstellungs-/Briefdatum), nur wenn ein konkreter Tag eindeutig bestimmbar ist. Bei blossem Monat/Jahr oder Unsicherheit: leer.
- frist: Kündigungs-, Ablauf-, Vertragsende- oder Zahlungstermin als YYYY-MM-DD, NUR wenn im Dokument ein konkreter Termin steht (z.B. "kündbar bis 30.6.2027", "läuft ab am …", "zahlbar bis …"). Nie selbst ausrechnen. Sonst leer.
- zusammenfassung: 3–6 Sätze zum Inhalt (Gegenstand, Parteien, Beträge, Laufzeit, Pflichten, Fristen) — nur Fakten aus dem Dokument.
- was: 1–2 Sätze: was das Dokument ist und wozu es dient (Art, Zweck, Anlass bzw. Veranstaltung, Location, Organisation). OHNE Personennamen, OHNE Beträge, OHNE Kontaktdaten (E-Mail, Telefon, Adresse), OHNE Konto-, AHV- oder Ausweisnummern.
- bezug_art: worauf sich das Dokument hauptsächlich bezieht: "location" (Veranstaltungsort, Halle, Saal), "projekt" (eine bestimmte Veranstaltung, ein Event), "kunde" (ein Kunde allgemein, nicht ein einzelnes Event), "partner" (Lieferant, Dienstleister, Partnerfirma), "firma" (die EVENTLINE selbst: Verwaltung, Versicherung, Finanzen, Recht, Marketing), "person" (eine einzelne Person); unklar: "".
- bezug_name: Name dieser Location, Veranstaltung, dieses Kunden oder Partners, wie im Dokument — leer bei "person", "firma" oder unklar. Nie ein Personenname.
- partei_art: "organisation", wenn partei eine Firma, Location, Behörde oder ein Verein ist; "person", wenn partei eine Privatperson ist; leer, wenn partei leer ist.
- jahr: das Jahr, auf das sich das Dokument bezieht (YYYY, z.B. Jahr des Dokuments oder der Veranstaltung), sonst leer.
- personenbezogen: true bei Dokumenten über eine einzelne Person (Lohn, Arbeitsvertrag, Anstellung, Zeugnis, Bewerbung, Gesundheit/Arzt, Ausweis, Bewilligung oder Kursbestätigung einer Person); sonst false.
- Normale deutsche Schreibweise mit Umlauten (Büro, Kündigung), Schweizer Schreibweise ohne ß (ss)."""

HINWEIS_BILD_OHNE_TEXT = (
    "Hinweis: Bild ohne lesbaren Text (OCR leer): typ \"sonstiges\". Beschreibe in beschrieb und "
    "zusammenfassung nur, was auf dem Bild zu sehen ist."
)
# Stufe 2 bei einem Bild ohne Text: nur der Dateiname und die Vorbilder tragen — im Zweifel kein Ordner.
HINWEIS_STUFE2_BILD_OHNE_TEXT = (
    "Das Dokument ist ein Bild ohne lesbaren Text: wähle nur, wenn der Dateiname oder die Dateien dort klar "
    "passen (z. B. Logos zu Logos, Fotos zu Fotos) — sonst ordner leer und kein neuer_ordner."
)


@dataclass
class Kontext:
    heute: str
    ordner: list[str]
    typen: list[tuple[str, str]]
    mitarbeiter: list[str]
    # Typ-Keys mit Flag `person` aus dem FSM-Kontext (Lohnabrechnung, Zertifikat, Behörde …):
    # nur bei ihnen bleibt eine erkannte Person im Ergebnis. None = der Kontext kennt das
    # Flag nicht (älteres FSM, Probelauf) → Person bei jedem Typ zulässig, wie bisher.
    personen_typen: frozenset[str] | None = None
    # V8: volle Namen ALLER Profile (auch inaktive) — nur für die Minimierung der Einordnung, nie die Auswahl.
    namen_alle: list[str] = field(default_factory=list)


# --- Kontext aus dem FSM ------------------------------------------------------


def _erstes(d: dict[str, Any], *schluessel: str) -> Any:
    for k in schluessel:
        if k in d and d[k] is not None:
            return d[k]
    return None


def _texte(wert: Any) -> list[str]:
    if not isinstance(wert, list):
        return []
    aus: list[str] = []
    for e in wert:
        if isinstance(e, str):
            t = e.strip()
        elif isinstance(e, dict):
            t = str(_erstes(e, "pfad", "path", "full_name", "name") or "").strip()
        else:
            t = ""
        if t and t not in aus:
            aus.append(t)
    return aus


def _typen(wert: Any) -> tuple[list[tuple[str, str]], frozenset[str] | None]:
    """(key, label)-Liste plus die Keys mit Flag `person`; None, wenn kein Eintrag das Flag trägt."""
    aus: list[tuple[str, str]] = []
    personen: set[str] = set()
    flag_gesehen = False
    if isinstance(wert, dict):
        for k, v in wert.items():
            if isinstance(k, str) and k.strip():
                aus.append((k.strip(), str(v or k).strip()))
    elif isinstance(wert, list):
        for e in wert:
            if isinstance(e, str) and e.strip():
                aus.append((e.strip(), e.strip()))
            elif isinstance(e, dict):
                k = str(_erstes(e, "key", "typ", "id") or "").strip()
                if k:
                    aus.append((k, str(_erstes(e, "label", "name") or k).strip()))
                    if "person" in e:
                        flag_gesehen = True
                        if e["person"]:
                            personen.add(k)
    return aus, (frozenset(personen) if flag_gesehen else None)


def lese_kontext(roh: dict[str, Any], heute_standard: str) -> Kontext:
    roh = roh if isinstance(roh, dict) else {}
    ordner = _texte(_erstes(roh, "ordner", "ordnerpfade", "ordner_pfade", "zielordner", "folders"))[:MAX_ORDNER]
    mitarbeiter = _texte(_erstes(roh, "mitarbeiter", "mitarbeitende", "personen", "namen", "employees"))[:MAX_MITARBEITER]
    typen, personen_typen = _typen(_erstes(roh, "dok_typen", "doktypen", "typen", "dokumenttypen", "types"))
    heute = datum_gueltig(_erstes(roh, "heute", "datum", "heute_iso", "today")) or heute_standard
    namen_alle = _texte(_erstes(roh, "namen_alle"))[:MAX_NAMEN_ALLE]
    return Kontext(
        heute=heute,
        ordner=ordner,
        typen=typen or list(DOK_TYPEN_STANDARD),
        mitarbeiter=mitarbeiter,
        personen_typen=personen_typen if typen else None,
        namen_alle=namen_alle,
    )


def heute_zuerich() -> str:
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo("Europe/Zurich")).date().isoformat()
    except Exception:  # noqa: BLE001 — ohne Zeitzonendaten lieber UTC als Absturz
        return datetime.now(timezone.utc).date().isoformat()


def bild_ohne_text(extrakt: Extrakt) -> bool:
    """Foto/Scan, aus dem die OCR kein Wort holt — der Ordner lässt sich nicht aus Text bestimmen."""
    return bool(extrakt.ist_bild) and len(_WORTZEICHEN.findall(extrakt.text)) < MIN_BILD_TEXTZEICHEN


# --- Schema + Prompt ----------------------------------------------------------


# Längengrenzen der freien Textfelder (Zeichen) — gleich wie die Nachprüfung unten und das FSM
# (bereinigeAblageErgebnis kürzt den Beschrieb auf 200). Ohne Grenze laufen die Modelle unter dem
# JSON-Schema in der Zusammenfassung gern weiter, bis num_predict erreicht ist, und das JSON
# bleibt unvollständig (gemessen 2026-10-03 bei qwen3:8b und gemma3:4b).
MAX_ZEICHEN = {
    "beschrieb": 200,
    "betreff": 120,
    "partei": 120,
    "nummer": 120,
    "dok_datum": 10,
    "frist": 10,
    "zusammenfassung": 800,
    # V8-Einordnung (geht minimiert über das FSM an Claude; das FSM kappt was bei 400).
    "was": 300,
    "bezug_name": 80,
    "jahr": 4,
}
# neuer_ordner (nur Stufe 2): Eltern-Pfad (≤ ~80) + «/» + Neuer_Name (≤ 80).
MAX_ZEICHEN_NEUER_ORDNER = 160


def _text(feld: str) -> dict[str, Any]:
    return {"type": "string", "maxLength": MAX_ZEICHEN[feld]}


def schema_fuer(k: Kontext, *, foto: bool = False) -> dict[str, Any]:
    """Stufe 1: alle Felder ausser dem Ordner. Enums zwingen das Modell auf die erlaubten Werte —
    leerer String = «keine Angabe». Bild ohne Text: Typ fest «sonstiges»."""
    typ_keys = [t[0] for t in k.typen]
    if foto and TYP_OHNE_ORDNER in typ_keys:
        typ_keys = [TYP_OHNE_ORDNER]
    felder: dict[str, Any] = {
        "beschrieb": _text("beschrieb"),
        "typ": {"type": "string", "enum": typ_keys},
        "betreff": _text("betreff"),
        "person": {"type": "string", "enum": [""] + k.mitarbeiter} if k.mitarbeiter else {"type": "string", "maxLength": 120},
        "partei": _text("partei"),
        "nummer": _text("nummer"),
        "dok_datum": _text("dok_datum"),
        "frist": _text("frist"),
        "zusammenfassung": _text("zusammenfassung"),
        # V8-Einordnung — hinten angehängt, damit die bisherigen Felder unverändert zuerst entstehen.
        "was": _text("was"),
        "bezug_art": {"type": "string", "enum": [""] + list(BEZUG_ARTEN)},
        "bezug_name": _text("bezug_name"),
        "partei_art": {"type": "string", "enum": [""] + list(PARTEI_ARTEN)},
        "jahr": _text("jahr"),
        "personenbezogen": {"type": "boolean"},
    }
    return {"type": "object", "properties": felder, "required": list(felder.keys())}


def schema_stufe2(kandidaten: list[str]) -> dict[str, Any]:
    """Stufe 2: einer der Kandidaten (voller Pfad) oder "" — plus Vorschlag für einen neuen Ordner."""
    felder: dict[str, Any] = {
        "ordner": {"type": "string", "enum": [""] + kandidaten},
        "neuer_ordner": {"type": "string", "maxLength": MAX_ZEICHEN_NEUER_ORDNER},
    }
    return {"type": "object", "properties": felder, "required": list(felder.keys())}


def _fuer_modell(text: str, max_zeichen: int) -> str:
    """Kopf (Titel, Parteien, Daten) und Schwanz (Fristen, Unterschriften) behalten."""
    if len(text) <= max_zeichen:
        return text
    kopf = int(max_zeichen * 5 / 6)
    schwanz = max_zeichen - kopf
    return text[:kopf] + "\n\n[… Mittelteil gekürzt …]\n\n" + text[-schwanz:]


def kontext_block(k: Kontext) -> str:
    """Der statische Anfang des Nutzer-Prompts — für jeden Auftrag mit demselben FSM-Kontext gleich."""
    teile = [
        "Erlaubte Dokumenttypen (key – Bezeichnung):\n" + "\n".join(f"{key} – {label}" for key, label in k.typen),
        "Mitarbeitende (voller Name):\n" + ("\n".join(k.mitarbeiter) if k.mitarbeiter else "(keine)"),
    ]
    return "\n\n".join(teile)


AUFTRAG_MARKER = "\n\n=== Auftrag ===\n"
STUFE2_MARKER = "\n\n=== Schritt 2: Zielordner ===\n"
STUFE2_REGELN = (
    "Wähle den Ordner, in den dieses Dokument gehört — AUSSCHLIESSLICH exakt einen Pfad aus der Liste oben "
    "(voller Pfad, gleiche Schreibweise). Entscheidend ist, worum es im Dokument geht: die Location, das Projekt "
    "bzw. die Veranstaltung, die Person, der Partner oder Kunde — und darin die Dokumentart (Verträge, Offerten, "
    "Pläne, Korrespondenz …). Unterlagen zu einer bestimmten Veranstaltung gehören zum Projekt, auch wenn eine "
    "Location oder ein Partner darin vorkommt. Die Dateinamen zeigen, was dort schon liegt. Passt keiner klar: "
    "ordner leer lassen und in neuer_ordner einen neuen Ordner vorschlagen (\"<bestehender Eltern-Pfad>/<Neuer_Name>\": "
    "Buchstaben ohne Umlaute, Zahlen, Unterstriche, Nummern-Präfix fortlaufend zu den Geschwistern); sonst neuer_ordner leer."
)
STUFE2_EINLEITUNG = (
    "Kandidaten für den Zielordner (vorausgewählt aus ähnlichen, bereits abgelegten Dokumenten, den "
    "Ordnernamen und festen Regeln; die wahrscheinlichsten zuerst):\n"
)
MAX_ZEICHEN_TYP_LABEL = 60
NAMEN_JE_KANDIDAT = 3


def stufe2_anhang_tokens(max_pfad: int) -> int:
    """Obergrenze für den Anhang der Stufe 2 (Tokens): Regeln + alle Kandidaten mit dem längsten Pfad und
    je NAMEN_JE_KANDIDAT gekürzten Dateinamen — Pfade und Dateinamen tokenisieren dicht (~1,6 Zeichen/Token)."""
    zeichen = (
        len(STUFE2_MARKER) + len("Dokumenttyp aus Schritt 1: . Beschrieb: \n") + MAX_ZEICHEN_TYP_LABEL + MAX_ZEICHEN["beschrieb"]
        + len(STUFE2_EINLEITUNG) + len(STUFE2_REGELN) + 1 + len(HINWEIS_STUFE2_BILD_OHNE_TEXT) + 1
        + ANZAHL_KANDIDATEN * (
            len("10. \n   dort abgelegt: \n") + max_pfad + NAMEN_JE_KANDIDAT * (MAX_ZEICHEN_DATEINAME_PROMPT + 2)
        )
    )
    return int(zeichen / ZEICHEN_PRO_TOKEN_ORDNER) + 1


# Für eine Liste mit Pfaden bis 200 Zeichen (das NAS hat höchstens ~150).
STUFE2_ANHANG_TOKENS = stufe2_anhang_tokens(200)


def prompt_fuer(
    k: Kontext,
    extrakt: Extrakt,
    dateiname: str,
    cfg: Einstellungen,
    *,
    mit_bild: bool = False,
    foto: bool = False,
    stufe2: bool = True,
    bild_reserve: int = BILD_TOKENS,
) -> tuple[str, int]:
    """Prompt der Stufe 1 + passendes Kontextfenster (Tokens) für beide Stufen dieses Auftrags.

    Reihenfolge: statischer Kontext (Typen, Mitarbeitende), dann der Auftrag. Ein Bild steht als
    Platzhalter «[img]» ganz am Ende — Ollama setzt das Bild dort ein (statt vor den Text), damit der
    statische Anfang auch bei Fotos/Scans gleich bleibt. bild_reserve = Tokens, die das Bild braucht.
    foto = Bild ohne lesbaren Text (Hinweis im Auftrag). stufe2: das Fenster trägt auch den Anhang der
    Stufe 2 (gleiches num_ctx = kein Neuladen, KV-Cache bleibt).
    """
    statisch = kontext_block(k)
    kopf = f"Dateityp: {extrakt.mime}"
    if extrakt.seiten:
        kopf += f", Seiten: {extrakt.seiten}"
    if extrakt.ocr:
        kopf += ", Text per OCR (Tippfehler möglich)"
    auftrag = [f"Heutiges Datum: {k.heute}", f"Dateiname: {dateiname or '(unbekannt)'}", kopf]
    if extrakt.hinweis:
        auftrag.append(f"Hinweis: {extrakt.hinweis}")
    if foto:
        auftrag.append(HINWEIS_BILD_OHNE_TEXT)
    ohne_inhalt = statisch + AUFTRAG_MARKER + "\n".join(auftrag)
    schluss = "\n>>>" + ("\n\nBild (Foto/Scan):\n[img]" if mit_bild else "")

    anhang = stufe2_anhang_tokens(max((len(o) for o in k.ordner), default=0)) if stufe2 else 0
    danach = max(ANTWORT_TOKENS, anhang + ANTWORT_TOKENS_STUFE2)
    fest = int(
        (len(SYSTEM) + len(ohne_inhalt) + len(schluss) + 40) / ZEICHEN_PRO_TOKEN_TEXT
        + danach + RESERVE_TOKENS + (bild_reserve if mit_bild else 0)
    )
    num_ctx = cfg.llm_num_ctx
    if fest + MIN_DOKUMENT_TOKENS > num_ctx:
        num_ctx = min(MAX_NUM_CTX, -(-(fest + MIN_DOKUMENT_TOKENS) // KONTEXT_SCHRITT) * KONTEXT_SCHRITT)
        log.info("Ablage-Prompt ohne Dokument ~%d Tokens — Kontextfenster %d statt KI_LLM_NUM_CTX=%d", fest, num_ctx, cfg.llm_num_ctx)
    budget = int((num_ctx - fest) * ZEICHEN_PRO_TOKEN_TEXT)
    if budget < MIN_DOKUMENT_TOKENS * ZEICHEN_PRO_TOKEN_TEXT:
        log.warning("Ablage-Prompt passt auch mit %d Tokens kaum — Dokumenttext stark gekürzt", num_ctx)
    budget = max(500, min(cfg.llm_max_zeichen, budget))
    inhalt = _fuer_modell(extrakt.text, budget) or "(kein Text lesbar)"
    return ohne_inhalt + "\nDokumentinhalt:\n<<<\n" + inhalt + schluss, num_ctx


def _kurz(s: str, n: int) -> str:
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def stufe2_anhang(kandidaten: list[tuple[str, list[str]]], typ_label: str, beschrieb: str, *, foto: bool = False) -> str:
    """An den Stufe-1-Prompt angehängt (gleicher Anfang → nur dieser Teil wird neu gerechnet).

    kandidaten: (voller Pfad, Dateinamen dort — die ähnlichsten Vorbilder zuerst), beste zuerst.
    """
    zeilen = []
    for i, (pfad, namen) in enumerate(kandidaten[:ANZAHL_KANDIDATEN], start=1):
        zeilen.append(f"{i}. {pfad}")
        if namen:
            zeilen.append("   dort abgelegt: " + "; ".join(_kurz(n, MAX_ZEICHEN_DATEINAME_PROMPT) for n in namen[:NAMEN_JE_KANDIDAT]))
        else:
            zeilen.append("   (noch keine Dateien)")
    typ_kurz = _kurz(typ_label, MAX_ZEICHEN_TYP_LABEL)
    beschrieb_kurz = _kurz(beschrieb, MAX_ZEICHEN["beschrieb"]) or "(keiner)"
    return (
        STUFE2_MARKER
        + f"Dokumenttyp aus Schritt 1: {typ_kurz}. Beschrieb: {beschrieb_kurz}\n"
        + STUFE2_EINLEITUNG
        + "\n".join(zeilen)
        + "\n"
        + STUFE2_REGELN
        + ("\n" + HINWEIS_STUFE2_BILD_OHNE_TEXT if foto else "")
    )


# --- Prüfung ------------------------------------------------------------------


_SATZENDE = re.compile(r"[.!?](?=\s|$)")


def ganze_saetze(roh: object, max_zeichen: int) -> str:
    """Zusammenfassung ohne abgeschnittenen Schlusssatz und ohne wörtlich wiederholte Sätze."""
    text = text_kurz(roh, max_zeichen)
    if not text:
        return ""
    saetze: list[str] = []
    start = 0
    for m in _SATZENDE.finditer(text):
        satz = text[start : m.end()].strip()
        start = m.end()
        if satz and satz not in saetze:
            saetze.append(satz)
    rest = text[start:].strip()
    if not saetze:
        return text
    # Rest ohne Satzende = von der Längengrenze abgeschnitten → weglassen.
    if rest and len(text) < max_zeichen - 1 and rest not in saetze:
        saetze.append(rest)
    return " ".join(saetze)


def finde_person(roh: str, mitarbeiter: list[str]) -> str | None:
    """Wortanfang-Match wie im FSM: «tim» trifft «Tim Näf», nicht «Fatima»; mehrdeutig = keiner."""
    tokens = [t for t in roh.lower().split() if t]
    if not tokens or not mitarbeiter:
        return None
    for name in mitarbeiter:
        if name.lower() == roh.lower():
            return name
    treffer = []
    for name in mitarbeiter:
        woerter = name.lower().split()
        if all(any(w.startswith(t) for w in woerter) for t in tokens):
            treffer.append(name)
    return treffer[0] if len(treffer) == 1 else None


def ordner_aus(roh: object, k: Kontext) -> str | None:
    """Strikt: exakt ein Pfad aus der Liste, sonst None (auch "" = «keiner passt»)."""
    s = text_kurz(roh, 300)
    return s if s and s in k.ordner else None


def neuer_ordner_aus(roh: object, k: Kontext) -> str | None:
    """«<Eltern-Pfad>/<Neuer_Name>» → voller Pfad; Eltern muss in der Liste stehen, der Name der
    Hauskonvention folgen und der neue Ordner darf nicht schon in der Liste stehen."""
    kandidat = text_kurz(roh, MAX_ZEICHEN_NEUER_ORDNER)
    i = kandidat.rfind("/")
    if i <= 0:
        return None
    eltern, name = kandidat[:i], kandidat[i + 1 :]
    if eltern not in k.ordner or not _NEUER_NAME.match(name) or kandidat in k.ordner:
        return None
    # Nie unter ZZ_* (Altes/Archiv) und nie selbst ein ZZ_-Ordner.
    if unter_zz(kandidat):
        return None
    return kandidat


def person_aus(roh: object, typ: str, k: Kontext) -> str | None:
    """Person nur bei Typen, die laut FSM eine betroffene Person kennen (Flag `person`) — bei Rechnung,
    Vertrag usw. hat der Name im Ablage-Namen kein Feld. Ohne Flag im Kontext wie bisher."""
    person_roh = text_kurz(roh, 120)
    if not person_roh or (k.personen_typen is not None and typ not in k.personen_typen):
        return None
    return person_roh if person_roh in k.mitarbeiter else finde_person(person_roh, k.mitarbeiter)


def typ_aus(roh: object, k: Kontext) -> str:
    typ_keys = [t[0] for t in k.typen]
    typ = str(roh or "")
    if typ not in typ_keys:
        typ = TYP_OHNE_ORDNER if TYP_OHNE_ORDNER in typ_keys else typ_keys[0]
    return typ


def pruefe_ergebnis(
    roh: dict[str, Any],
    k: Kontext,
    extrakt: Extrakt,
    *,
    sha256: str,
    modell: str,
    dauer_ms: int,
    dateiname: str,
    foto: bool = False,
    alternativen: list[str] | None = None,
    kandidaten: list[dict[str, Any]] | None = None,
    regel_ordner: str | None = None,
    regel_art: str | None = None,
    personal_ordner: bool = False,
) -> dict[str, Any]:
    """Alle Felder prüfen. V8: `einordnung` (minimiert), `kandidaten` (bis 8) und `regel_ordner` kommen dazu;
    die bisherigen Felder bleiben, wie sie waren (lokale Wahl/Rückfall im FSM)."""
    typ_keys = [t[0] for t in k.typen]
    typ = typ_aus(roh.get("typ"), k)
    labels = dict(k.typen)
    if foto and TYP_OHNE_ORDNER in typ_keys:
        # Bild ohne Text: Typ fest — egal, was das Modell schreibt.
        typ = TYP_OHNE_ORDNER

    ordner = ordner_aus(roh.get("ordner"), k)
    neuer_ordner = neuer_ordner_aus(roh.get("neuer_ordner"), k) if ordner is None else None
    alt: list[str] = []
    for a in alternativen or []:
        if a in k.ordner and a != ordner and a not in alt:
            alt.append(a)

    person = person_aus(roh.get("person"), typ, k)

    partei = text_kurz(roh.get("partei"), MAX_ZEICHEN["partei"]) or None
    if partei and re.fullmatch(r"\s*eventline(\s+gmbh)?\s*", partei, re.I):
        partei = None

    nummer = text_kurz(roh.get("nummer"), MAX_ZEICHEN["nummer"]) or None
    betreff = text_kurz(roh.get("betreff"), MAX_ZEICHEN["betreff"])
    beschrieb = text_kurz(roh.get("beschrieb"), MAX_ZEICHEN["beschrieb"])
    if not beschrieb:
        teile = [labels.get(typ, typ)]
        if partei:
            teile.append(partei)
        if nummer:
            teile.append(f"Nr. {nummer}")
        beschrieb = ", ".join(teile) if typ != TYP_OHNE_ORDNER else f"Dokument {dateiname or ''}".strip()
    dok_datum = datum_gueltig(roh.get("dok_datum"))

    einordnung = baue_einordnung(
        roh,
        namen=[*k.namen_alle, *k.mitarbeiter],
        typ=typ,
        typ_label=labels.get(typ, typ),
        person=person,
        betreff=betreff,
        partei=partei,
        dok_datum=dok_datum,
        heute=k.heute,
        seiten=extrakt.seiten,
        text=extrakt.text,
        foto=foto,
        personen_typen=k.personen_typen,
        regel_person=regel_art == "person",
        # Review V8: Personal-Ordner in der Rangliste oder lokal gewählt → personenbezogen (Arbeitsvertrag u. ä.).
        personal_ordner=personal_ordner or unter_personal(ordner),
    )
    v8_kandidaten = [c for c in (kandidaten or []) if isinstance(c, dict) and c.get("pfad") in k.ordner]
    v8_regel = regel_ordner if regel_ordner and regel_ordner in k.ordner else None

    return {
        "beschrieb": beschrieb,
        "typ": typ,
        "betreff": betreff,
        "person": person,
        "partei": partei,
        "nummer": nummer,
        "dok_datum": dok_datum,
        "frist": datum_gueltig(roh.get("frist")),
        "ordner": ordner,
        "neuer_ordner": neuer_ordner,
        "ordner_alternativen": alt[:ANZAHL_ALTERNATIVEN],
        "zusammenfassung": ganze_saetze(roh.get("zusammenfassung"), MAX_ZEICHEN["zusammenfassung"]),
        "sha256": sha256,
        "seiten": extrakt.seiten,
        "ocr": bool(extrakt.ocr),
        "modell": modell,
        "dauer_ms": dauer_ms,
        # V8 (SPEC §3.1): Claude entscheidet im FSM aus der minimierten Einordnung; regel_ordner ist verbindlich.
        "einordnung": einordnung,
        "kandidaten": v8_kandidaten,
        "regel_ordner": v8_regel,
    }


# --- Vorbilder aus dem Archiv-Index ----------------------------------------------


@dataclass
class Vorbilder:
    vektor: list[float] | None = None
    nachbarn: list[Nachbar] = field(default_factory=list)
    mit_dateien: set[str] = field(default_factory=set)
    ordner_vektoren: dict[str, list[float]] = field(default_factory=dict)
    archiv_ok: bool = False
    # Ausgeschlossene Vorbild-Pfade (Probelauf: Testdatei plus erkannte Zwillinge) — gilt auch für Stufe 2.
    ohne_pfade: list[str] = field(default_factory=list)
    zwillinge: int = 0


@dataclass(frozen=True)
class ZwillingsAusschluss:
    """Nur Probelauf (Review 2026-10-11): Vorbilder im Zielordner, die der Testdatei fast gleichen — Kosinus
    über der Schwelle (docx+pdf derselben Datei, Versionen) oder gleicher Namensstamm — sind kein Vorbild;
    der Leave-one-out über sha256 allein liess sie durch (26 von 167 Vorbildern hatten so einen Zwilling)."""

    ordner: str
    schwelle: float
    namensstamm: str


ZWILLINGE_MAX = 200


# Ohne Datenbank (oder ohne Index) bleiben wenigstens die Ordner-Einbettungen im Speicher.
_ORDNER_OHNE_DB: dict[str, ArchivIndex] = {}


def suche_vorbilder(
    archiv: ArchivIndex | None,
    llm: Ollama,
    cfg: Einstellungen,
    k: Kontext,
    dateiname: str,
    text: str,
    *,
    ohne_pfade: Collection[str] = (),
    ohne_sha: Collection[str] = (),
    zwillinge: ZwillingsAusschluss | None = None,
) -> Vorbilder:
    """Einbettung des Dokuments, ähnlichste Vorbilder, Ordner mit Dateien, Einbettungen der Ordnerpfade.

    Jeder Teil darf scheitern (Modell fehlt, DB aus): die Ordnerwahl arbeitet dann mit dem, was da ist.
    """
    v = Vorbilder(ohne_pfade=list(ohne_pfade))
    # Knapper VRAM: Sprachmodell vor der Einbettung entladen (archiv.platz_fuer_einbettung, gleicher Schritt
    # wie im Indexlauf). Für Stufe 1 lädt das Sprachmodell dann neu (3–7 s).
    platz_fuer_einbettung(llm, cfg, grund="Ablage")
    try:
        [v.vektor], _meta = llm.einbetten(modell=cfg.modell_embed, texte=[einbettungstext(dateiname, text)])
    except LlmFehler as e:
        log.warning("Ablage: keine Einbettung (%s) — Ordnerwahl ohne Vorbilder", str(e)[:80])
        return v
    index = archiv
    if index is None or not index.aktiv:
        index = _ORDNER_OHNE_DB.setdefault(cfg.modell_embed, ArchivIndex(None, f"{cfg.modell_embed}|ohne-db"))
    if index.aktiv:
        try:
            if zwillinge is not None:
                nah = index.nachbarn(
                    v.vektor, ordner=[zwillinge.ordner], k=ZWILLINGE_MAX, ohne_sha=ohne_sha, ohne_pfade=v.ohne_pfade,
                )
                zw = [
                    n.pfad for n in nah
                    if n.aehnlichkeit > zwillinge.schwelle or lesbarer_name(n.name).lower() == zwillinge.namensstamm
                ]
                v.zwillinge = len(zw)
                v.ohne_pfade += zw
            v.nachbarn = index.nachbarn(v.vektor, ordner=k.ordner, k=K_NACHBARN, ohne_sha=ohne_sha, ohne_pfade=v.ohne_pfade)
            v.mit_dateien = index.ordner_mit_dateien(ohne_sha=ohne_sha, ohne_pfade=v.ohne_pfade)
            v.archiv_ok = True
        except Exception as e:  # noqa: BLE001 — DB aus: ohne Vorbilder weiter
            log.warning("Ablage: Archiv-Index nicht verfügbar (%s)", type(e).__name__)
    try:
        v.ordner_vektoren = index.ordner_vektoren(
            k.ordner, lambda texte: llm.einbetten(modell=cfg.modell_embed, texte=texte)[0]
        )
    except Exception as e:  # noqa: BLE001
        log.warning("Ablage: Ordner-Einbettungen nicht verfügbar (%s)", type(e).__name__)
    return v


# --- Einstieg -----------------------------------------------------------------


def _log_aufruf(stufe: int, extrakt: Extrakt, meta: dict[str, Any], **extra: Any) -> None:
    log.info(
        "ablage_analyse Stufe %d: %s, %s Zeichen, ocr=%s, %s, %s ms (Modell %s, Laden %s ms, Prompt %s Tokens/%s ms, "
        "Antwort %s Tokens/%s ms, num_ctx %s)",
        stufe, extrakt.mime, len(extrakt.text), extrakt.ocr, " ".join(f"{a}={b}" for a, b in extra.items()),
        meta["dauer_ms"], meta["modell"], meta["lade_ms"], meta["prompt_tokens"], meta["prompt_ms"],
        meta["antwort_tokens"], meta["antwort_ms"], meta["num_ctx"],
    )


def _chat_mit_zweitem_versuch(llm: Ollama, stufe: int, **kw: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    try:
        return llm.chat_json(**kw)
    except LlmFehler as e:
        if "repeat limit" not in str(e):
            raise
        # Ollama bricht ab, wenn das Modell 30× denselben Token wiederholt (gesehen 2026-10-04 bei
        # 3 von 127 Dateien, temperature 0). Ein zweiter Versuch mit etwas Zufall löst die Schleife
        # meist; der Prompt ist derselbe, der KV-Cache bleibt warm.
        log.warning("ablage_analyse Stufe %d: Wiederholungsschleife (%s) — zweiter Versuch", stufe, str(e)[:80])
        return llm.chat_json(**kw, optionen=ZWEITER_VERSUCH)


def ablage_analyse(
    *,
    pfad: Path,
    dateiname: str,
    mime: str | None,
    sha256: str,
    kontext_roh: dict[str, Any],
    llm: Ollama,
    cfg: Einstellungen,
    heute: str | None = None,
    archiv: ArchivIndex | None = None,
    ohne_vorbilder: tuple[Collection[str], Collection[str]] = ((), ()),
    messung: dict[str, Any] | None = None,
    zwillinge: ZwillingsAusschluss | None = None,
) -> dict[str, Any]:
    """ohne_vorbilder = (Pfade, sha256) — nur der Probelauf: die Testdatei ist nie ihr eigenes Vorbild;
    zwillinge: zusätzlich Fast-Zwillinge im Zielordner ausschliessen (nur Probelauf).
    messung: optionales Dict für den Probelauf (Quelle des Entscheids, Rangliste) — geht nie ans FSM."""
    start = time.monotonic()
    k = lese_kontext(kontext_roh, heute or heute_zuerich())
    try:
        extrakt = extrahiere(pfad, mime, dateiname, cfg)
    except ExtraktFehler as e:
        raise VerarbeitungsFehler(str(e)) from e

    # Foto ohne Text: Typ «sonstiges» fest, nicht vom Modell; den Ordner tragen dann nur Dateiname und
    # Vorbilder (Logos zu Logos) — Stufe 2 darf «keiner» sagen. Ohne Ordnerliste keine Wahl.
    foto = bild_ohne_text(extrakt)
    ordnerwahl = bool(k.ordner)
    vorbilder = Vorbilder()
    if ordnerwahl:
        ohne_pfade, ohne_sha = ohne_vorbilder
        vorbilder = suche_vorbilder(
            archiv, llm, cfg, k, dateiname, extrakt.text, ohne_pfade=ohne_pfade, ohne_sha=ohne_sha, zwillinge=zwillinge,
        )

    schema = schema_fuer(k, foto=foto)
    # Fotos/Scans als Bild: OCR-Text UND das Bild selbst ans Bildmodell — ein Durchgang.
    modell = cfg.modell_bild if extrakt.ist_bild else cfg.modell_text
    nutzer, num_ctx = prompt_fuer(
        k, extrakt, dateiname, cfg,
        mit_bild=extrakt.ist_bild, foto=foto, stufe2=ordnerwahl, bild_reserve=bild_tokens(modell),
    )
    bilder: list[str] | None = None
    if extrakt.ist_bild:
        try:
            bilder = [bild_base64(pfad, cfg.bild_max_px)]
        except ExtraktFehler as e:
            raise VerarbeitungsFehler(str(e)) from e
    try:
        roh, meta = _chat_mit_zweitem_versuch(
            llm, 1, modell=modell, system=SYSTEM, nutzer=nutzer, schema=schema,
            num_ctx=num_ctx, bilder=bilder, num_predict=ANTWORT_TOKENS,
        )
    except LlmFehler as e:
        raise VerarbeitungsFehler(str(e)) from e
    _log_aufruf(1, extrakt, meta, ordnerwahl=ordnerwahl, vorbilder=len(vorbilder.nachbarn))

    quelle = "keine"
    alternativen: list[str] = []
    v8_kandidaten: list[dict[str, Any]] = []
    v8_regel: str | None = None
    v8_regel_art: str | None = None
    v8_personal = False
    roh["ordner"], roh["neuer_ordner"] = "", ""
    if ordnerwahl:
        typ = typ_aus(roh.get("typ"), k)
        rl: Rangliste = rangliste(
            ordner=k.ordner,
            mit_dateien=vorbilder.mit_dateien,
            nachbarn=vorbilder.nachbarn,
            dateiname=dateiname,
            text=extrakt.text,
            doc_vektor=vorbilder.vektor,
            ordner_vektoren=vorbilder.ordner_vektoren,
            typ=typ,
            person=person_aus(roh.get("person"), typ, k),
        )
        v8_kandidaten = kandidaten_v8(rl, k.ordner)
        v8_regel = regel_ordner_v8(rl, k.ordner)
        v8_regel_art = rl.regel_art
        gewaehlt: str | None = None
        if rl.regel:
            gewaehlt, quelle = rl.regel, "regel"
        elif rl.kandidaten:
            auswahl = rl.kandidaten[:ANZAHL_KANDIDATEN]
            namen = {c.pfad: list(c.nachbarn) for c in auswahl}
            ohne_namen = [c.pfad for c in auswahl if not c.nachbarn]
            if ohne_namen and archiv is not None and vorbilder.archiv_ok:
                try:
                    _, ohne_sha = ohne_vorbilder
                    je_ordner = archiv.namen_in(ohne_namen, je_ordner=3, ohne_sha=ohne_sha, ohne_pfade=vorbilder.ohne_pfade)
                    for pfad_kandidat in ohne_namen:
                        namen[pfad_kandidat] = je_ordner.get(nfc(pfad_kandidat), [])
                except Exception as e:  # noqa: BLE001
                    log.warning("Ablage: Dateinamen der Kandidaten nicht lesbar (%s)", type(e).__name__)
            labels = dict(k.typen)
            anhang = stufe2_anhang(
                [(c.pfad, namen.get(c.pfad, [])) for c in auswahl],
                labels.get(typ, typ) or "unbekannt",
                text_kurz(roh.get("beschrieb"), 200),
                foto=foto,
            )
            pfade = [c.pfad for c in auswahl]
            try:
                roh2, meta2 = _chat_mit_zweitem_versuch(
                    llm, 2, modell=modell, system=SYSTEM, nutzer=nutzer + anhang, schema=schema_stufe2(pfade),
                    num_ctx=num_ctx, bilder=bilder, num_predict=ANTWORT_TOKENS_STUFE2,
                )
                _log_aufruf(2, extrakt, meta2, kandidaten=len(pfade))
                antwort = text_kurz(roh2.get("ordner"), 300)
                if antwort in pfade:
                    gewaehlt, quelle = antwort, "ki"
                else:
                    quelle = "ki_keiner"
                    roh["neuer_ordner"] = roh2.get("neuer_ordner")
            except LlmFehler as e:
                # Stufe 1 (Beschrieb, Typ, Daten) ist brauchbar; der Ordner kommt dann aus der Rangliste.
                log.warning("ablage_analyse Stufe 2 fehlgeschlagen (%s) — bester Kandidat der Rangliste", str(e)[:120])
                gewaehlt, quelle = pfade[0], "rangliste"
        roh["ordner"] = gewaehlt or ""
        v8_personal = personal_hinweis(rl, gewaehlt)
        alternativen = [p for p in rl.pfade(ANZAHL_ALTERNATIVEN + 1) if p != gewaehlt][:ANZAHL_ALTERNATIVEN]
        if messung is not None:
            reihe = rl.pfade(10)
            messung.update(
                quelle=quelle,
                regel_art=rl.regel_art,
                rangliste=reihe,
                gewaehlt_rang=reihe.index(gewaehlt) if gewaehlt in reihe else None,
                nachbarn=len(vorbilder.nachbarn),
                staerkste_aehnlichkeit=rl.staerkste_aehnlichkeit,
                archiv_ok=vorbilder.archiv_ok,
                zwillinge=vorbilder.zwillinge,
            )
    elif messung is not None:
        messung.update(quelle="keine", rangliste=[], nachbarn=0, archiv_ok=False, zwillinge=0)
    return pruefe_ergebnis(
        roh, k, extrakt,
        sha256=sha256,
        modell=str(meta["modell"]),
        dauer_ms=int((time.monotonic() - start) * 1000),
        dateiname=dateiname,
        foto=foto,
        alternativen=alternativen,
        kandidaten=v8_kandidaten,
        regel_ordner=v8_regel,
        regel_art=v8_regel_art,
        personal_ordner=v8_personal,
    )
