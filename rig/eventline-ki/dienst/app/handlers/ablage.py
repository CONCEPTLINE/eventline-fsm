"""ablage_analyse: Datei → Text/OCR → Sprachmodell → Vorschlag für Name, Ordner, Frist (SPEC §3.1).

Die Regeln stammen aus der bisherigen Claude-Route /api/ablage/name-vorschlag —
mit dem Unterschied, dass hier das Dokument selbst gelesen wird (lokal, im
Haus). Das Modell wird per JSON-Schema auf die erlaubten Werte eingeschränkt
(Typ, Ordner, Person), und das Ergebnis wird danach trotzdem geprüft: nichts
Erfundenes kommt durch, Datumsfelder müssen echte Daten sein.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import Einstellungen
from ..extract import Extrakt, ExtraktFehler, bild_base64, extrahiere
from ..llm import LlmFehler, Ollama
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
_NEUER_NAME = re.compile(r"^[A-Za-z0-9_]{2,80}$")

# Prompt-Budget ohne Tokenizer. Ist der Prompt länger als das Kontextfenster, kürzt Ollama
# ihn still auf die Hälfte des Fensters und behält nur das Ende — die Regeln und der Anfang
# der Ordnerliste wären weg (gemessen 2026-10-03: 9261 Tokens bei num_ctx 8192 → 4098).
# Gemessene Zeichen pro Token (qwen2.5vl/qwen3 | gemma3): Regeln 3,1 | 3,4, Dokumenttext
# 2,7 | 3,1, Ordnerpfade nur 1,8 | 1,7 (Unterstriche, Nummern, Grossbuchstaben) — 365
# Ordner sind allein ~7 500 Tokens. Die Werte unten liegen sicher darunter.
ZEICHEN_PRO_TOKEN_TEXT = 2.5
ZEICHEN_PRO_TOKEN_ORDNER = 1.6
ANTWORT_TOKENS = 1000      # num_predict: das JSON braucht gemessen 350–550 Tokens
RESERVE_TOKENS = 256       # Chat-Vorlage, Rollen-Marker, Rundung
BILD_TOKENS = 1600         # ein Bild bis 1280 px: Qwen2.5-VL bis ~1600 Tokens, Gemma 3 fest 256
# So viel Dokumenttext muss mindestens neben Regeln + Ordnerliste passen, sonst wird das
# Fenster für diesen Auftrag vergrössert (in 4096er-Stufen, damit Ollama bei gleichbleibender
# Ordnerliste nicht bei jedem Auftrag neu lädt).
MIN_DOKUMENT_TOKENS = 1500
KONTEXT_SCHRITT = 4096
MAX_NUM_CTX = 32768

SYSTEM = """Du bist die lokale Ablage-KI der EVENTLINE GmbH (Eventtechnik-Firma, Basel). Du bekommst den Textinhalt eines Dokuments (ganz oder gekürzt), den Dateinamen, die Liste der erlaubten Zielordner, die erlaubten Dokumenttypen und die Namen der Mitarbeitenden. Du lieferst ausschliesslich die geforderten JSON-Felder.

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
- ordner: der fachlich passendste Zielordner AUSSCHLIESSLICH exakt aus der mitgeschickten Liste (gleiche Schreibweise). Personalunterlagen in den Personalakten-Ordner der genannten Person, falls vorhanden. Wenn keiner klar passt: leer.
- neuer_ordner: NUR wenn ordner leer ist: Vorschlag für einen NEUEN Ordner im Format "<bestehender Eltern-Pfad aus der Liste>/<Neuer_Name>". Neuer_Name nach Hauskonvention: Buchstaben ohne Umlaute, Zahlen, Unterstriche; Nummern-Präfix fortlaufend zu den Geschwistern (z.B. "04_PARTNER/05_Blumen_Mueller"). Sonst leer.
- zusammenfassung: 3–6 Sätze zum Inhalt (Gegenstand, Parteien, Beträge, Laufzeit, Pflichten, Fristen) — nur Fakten aus dem Dokument.
- Normale deutsche Schreibweise mit Umlauten (Büro, Kündigung), Schweizer Schreibweise ohne ß (ss)."""


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
    return Kontext(
        heute=heute,
        ordner=ordner,
        typen=typen or list(DOK_TYPEN_STANDARD),
        mitarbeiter=mitarbeiter,
        personen_typen=personen_typen if typen else None,
    )


def heute_zuerich() -> str:
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo("Europe/Zurich")).date().isoformat()
    except Exception:  # noqa: BLE001 — ohne Zeitzonendaten lieber UTC als Absturz
        return datetime.now(timezone.utc).date().isoformat()


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
    "neuer_ordner": 300,
    "zusammenfassung": 800,
}


def schema_fuer(k: Kontext) -> dict[str, Any]:
    """Enums zwingen das Modell auf die erlaubten Werte — leerer String = «keine Angabe»."""

    def text(feld: str) -> dict[str, Any]:
        return {"type": "string", "maxLength": MAX_ZEICHEN[feld]}

    felder: dict[str, Any] = {
        "beschrieb": text("beschrieb"),
        "typ": {"type": "string", "enum": [t[0] for t in k.typen]},
        "betreff": text("betreff"),
        "person": {"type": "string", "enum": [""] + k.mitarbeiter} if k.mitarbeiter else {"type": "string", "maxLength": 120},
        "partei": text("partei"),
        "nummer": text("nummer"),
        "dok_datum": text("dok_datum"),
        "frist": text("frist"),
        "ordner": {"type": "string", "enum": [""] + k.ordner} if k.ordner else {"type": "string", "maxLength": 300},
        "neuer_ordner": text("neuer_ordner"),
        "zusammenfassung": text("zusammenfassung"),
    }
    return {"type": "object", "properties": felder, "required": list(felder.keys())}


def _fuer_modell(text: str, max_zeichen: int) -> str:
    """Kopf (Titel, Parteien, Daten) und Schwanz (Fristen, Unterschriften) behalten."""
    if len(text) <= max_zeichen:
        return text
    kopf = int(max_zeichen * 5 / 6)
    schwanz = max_zeichen - kopf
    return text[:kopf] + "\n\n[… Mittelteil gekürzt …]\n\n" + text[-schwanz:]


def prompt_fuer(
    k: Kontext, extrakt: Extrakt, dateiname: str, cfg: Einstellungen, *, mit_bild: bool = False
) -> tuple[str, int]:
    """Prompt + passendes Kontextfenster (Tokens) für diesen Auftrag."""
    kopf = f"Dateityp: {extrakt.mime}"
    if extrakt.seiten:
        kopf += f", Seiten: {extrakt.seiten}"
    if extrakt.ocr:
        kopf += ", Text per OCR (Tippfehler möglich)"
    teile = [f"Heutiges Datum: {k.heute}", f"Dateiname: {dateiname or '(unbekannt)'}", kopf]
    if extrakt.hinweis:
        teile.append(f"Hinweis: {extrakt.hinweis}")
    teile.append("\nErlaubte Dokumenttypen (key – Bezeichnung):\n" + "\n".join(f"{key} – {label}" for key, label in k.typen))
    teile.append("\nVerfügbare Zielordner (exakte Schreibweise):\n" + ("\n".join(k.ordner) if k.ordner else "(keine)"))
    teile.append("\nMitarbeitende (voller Name):\n" + ("\n".join(k.mitarbeiter) if k.mitarbeiter else "(keine)"))
    ohne_inhalt = "\n".join(teile)

    ordner_zeichen = sum(len(o) + 1 for o in k.ordner)
    text_zeichen = len(SYSTEM) + len(ohne_inhalt) - ordner_zeichen + 40
    fest = int(
        text_zeichen / ZEICHEN_PRO_TOKEN_TEXT
        + ordner_zeichen / ZEICHEN_PRO_TOKEN_ORDNER
        + ANTWORT_TOKENS + RESERVE_TOKENS + (BILD_TOKENS if mit_bild else 0)
    )
    num_ctx = cfg.llm_num_ctx
    if fest + MIN_DOKUMENT_TOKENS > num_ctx:
        num_ctx = min(MAX_NUM_CTX, -(-(fest + MIN_DOKUMENT_TOKENS) // KONTEXT_SCHRITT) * KONTEXT_SCHRITT)
        log.info(
            "Ablage-Prompt ohne Dokument ~%d Tokens (%d Ordner) — Kontextfenster %d statt KI_LLM_NUM_CTX=%d",
            fest, len(k.ordner), num_ctx, cfg.llm_num_ctx,
        )
    budget = int((num_ctx - fest) * ZEICHEN_PRO_TOKEN_TEXT)
    if budget < MIN_DOKUMENT_TOKENS * ZEICHEN_PRO_TOKEN_TEXT:
        log.warning("Ablage-Prompt passt auch mit %d Tokens kaum — Dokumenttext stark gekürzt", num_ctx)
    budget = max(500, min(cfg.llm_max_zeichen, budget))
    inhalt = _fuer_modell(extrakt.text, budget) or "(kein Text lesbar)"
    return ohne_inhalt + "\n\nDokumentinhalt:\n<<<\n" + inhalt + "\n>>>", num_ctx


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


def pruefe_ergebnis(
    roh: dict[str, Any],
    k: Kontext,
    extrakt: Extrakt,
    *,
    sha256: str,
    modell: str,
    dauer_ms: int,
    dateiname: str,
) -> dict[str, Any]:
    typ_keys = [t[0] for t in k.typen]
    typ = str(roh.get("typ") or "")
    if typ not in typ_keys:
        typ = "sonstiges" if "sonstiges" in typ_keys else typ_keys[0]
    labels = dict(k.typen)

    ordner_roh = text_kurz(roh.get("ordner"), 300)
    ordner = ordner_roh if ordner_roh and ordner_roh in k.ordner else None

    neuer_ordner = None
    if ordner is None:
        kandidat = text_kurz(roh.get("neuer_ordner"), MAX_ZEICHEN["neuer_ordner"])
        i = kandidat.rfind("/")
        if i > 0:
            eltern, name = kandidat[:i], kandidat[i + 1 :]
            if eltern in k.ordner and _NEUER_NAME.match(name) and kandidat not in k.ordner:
                neuer_ordner = kandidat

    # Person nur bei Typen, die laut FSM eine betroffene Person kennen (Flag `person`) — bei
    # Rechnung, Vertrag usw. hat der Name im Ablage-Namen kein Feld. Ohne Flag im Kontext wie bisher.
    person_roh = text_kurz(roh.get("person"), 120)
    person = None
    if person_roh and (k.personen_typen is None or typ in k.personen_typen):
        person = person_roh if person_roh in k.mitarbeiter else finde_person(person_roh, k.mitarbeiter)

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
        beschrieb = ", ".join(teile) if typ != "sonstiges" else f"Dokument {dateiname or ''}".strip()

    return {
        "beschrieb": beschrieb,
        "typ": typ,
        "betreff": betreff,
        "person": person,
        "partei": partei,
        "nummer": nummer,
        "dok_datum": datum_gueltig(roh.get("dok_datum")),
        "frist": datum_gueltig(roh.get("frist")),
        "ordner": ordner,
        "neuer_ordner": neuer_ordner,
        "zusammenfassung": ganze_saetze(roh.get("zusammenfassung"), MAX_ZEICHEN["zusammenfassung"]),
        "sha256": sha256,
        "seiten": extrakt.seiten,
        "ocr": bool(extrakt.ocr),
        "modell": modell,
        "dauer_ms": dauer_ms,
    }


# --- Einstieg -----------------------------------------------------------------


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
) -> dict[str, Any]:
    start = time.monotonic()
    k = lese_kontext(kontext_roh, heute or heute_zuerich())
    try:
        extrakt = extrahiere(pfad, mime, dateiname, cfg)
    except ExtraktFehler as e:
        raise VerarbeitungsFehler(str(e)) from e

    schema = schema_fuer(k)
    nutzer, num_ctx = prompt_fuer(k, extrakt, dateiname, cfg, mit_bild=extrakt.ist_bild)
    modell = cfg.modell_text
    bilder: list[str] | None = None
    if extrakt.ist_bild:
        # Fotos/Scans als Bild: OCR-Text UND das Bild selbst ans Bildmodell — ein Durchgang,
        # kein Modellwechsel (nur ein Modell passt in den Speicher).
        modell = cfg.modell_bild
        try:
            bilder = [bild_base64(pfad, cfg.bild_max_px)]
        except ExtraktFehler as e:
            raise VerarbeitungsFehler(str(e)) from e
    try:
        roh, meta = llm.chat_json(
            modell=modell, system=SYSTEM, nutzer=nutzer, schema=schema,
            num_ctx=num_ctx, bilder=bilder, num_predict=ANTWORT_TOKENS,
        )
    except LlmFehler as e:
        raise VerarbeitungsFehler(str(e)) from e
    log.info(
        "ablage_analyse: %s, %s Zeichen, ocr=%s, %s ms (Modell %s, Laden %s ms, Prompt %s Tokens/%s ms, "
        "Antwort %s Tokens/%s ms, num_ctx %s)",
        extrakt.mime, len(extrakt.text), extrakt.ocr, meta["dauer_ms"], meta["modell"], meta["lade_ms"],
        meta["prompt_tokens"], meta["prompt_ms"], meta["antwort_tokens"], meta["antwort_ms"], meta["num_ctx"],
    )
    return pruefe_ergebnis(
        roh, k, extrakt,
        sha256=sha256,
        modell=str(meta["modell"]),
        dauer_ms=int((time.monotonic() - start) * 1000),
        dateiname=dateiname,
    )
