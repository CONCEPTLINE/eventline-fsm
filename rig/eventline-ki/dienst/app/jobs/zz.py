"""Rückstau ZZ der Nachtarbeit (Masterplan E4.4, §3.6 «Vorschläge»). Schalter KI_JOB_ZZ.

Rezept zz/v3 (15.10.2026, Architektur «Stärken verteilen», Mischa): das Rig entscheidet den Ordner NICHT mehr.
1. Die lokale KI (gemma3:4b, ein Aufruf) liest das Dokument (Text aus dem Tiefen-Index, Kopf 5/6 + Schluss 1/6 des
   Budgets — siehe handlers/ablage.prompt_fuer) und schreibt einen ausführlichen, strukturierten Beschrieb: Dokumentart
   und Unterart, Titel, Zweck, Bezug (Beilage zu …, Projekt/Event/Location), Status (Entwurf/unterschrieben/…), Datum/
   Zeitraum, Sprache, Absender/Empfänger, Beteiligte mit Rolle, Schlagworte.
2. filtere_beschrieb() entfernt deterministisch alles Sensible (Beträge/Löhne/Sätze, IBAN/Konto, AHV, Ausweis-/Policen-/
   Telefonnummern, E-Mail/Adressen, Gesundheits-/Kündigungsgründe, wörtliche Zitate) — ein Feld mit Treffer fällt
   ganz weg, ein Name/eine Partei nur, wenn sie im Dokument, im Dateinamen oder im bisherigen Ablageort steht.
3. Fakten-Hinweise (ablageregeln.py + Vorbilder der Ordnerwahl): erkannte Person und ob ihre Personalakte existiert,
   Location/Partner mit eigenem Ordner, Entwurf, Datum im Namen, INT-Nummer, Regel-Hinweis, ähnlichste Ordner nach
   Vorbild-Dokumenten, Regel-Namensvorschlag. Nur Hinweise — Claude im FSM entscheidet, ein Mensch gibt frei.
4. Meldung ans FSM (POST /api/ki/nachtarbeit, Liste «vorschlaege», art zz): pfad, sha256, ordner_ist, rezept,
   beschrieb, fakten, kandidaten — nie Dokumenttext.
Neu gerechnet wird eine Datei, wenn das FSM für sie nichts mit diesem Rezept kennt und kein Vorschlag angenommen ist
(offene Vorschläge älterer Rezepte ersetzt das FSM, sie werden «veraltet»).
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Collection

from .. import ablageregeln as ar
from ..archiv import ArchivIndex, nfc, unter_zz
from ..config import Einstellungen
from ..extract import ENDUNG_MIME, Extrakt
from ..handlers import datum_gueltig, text_kurz
from ..handlers.ablage import ANTWORT_TOKENS, heute_zuerich, lese_kontext, prompt_fuer, suche_vorbilder, typ_aus
from ..llm import Ollama
from ..ordnerwahl import evidenz, rangliste
from ..suche import ist_systempfad
from .fristen import _chat, datum_im_text

log = logging.getLogger("ki.nacht.zz")

REZEPT = "zz/v3"
_WORTZEICHEN = re.compile(r"[^\W_]", re.U)
MIN_TEXT_WORTZEICHEN = 20
MAX_FAKTEN = 12
MAX_FAKT = 300
MAX_KANDIDATEN = 8
# Teil-Grösse beim Lesen in Teilen: passt mit Regeln, Mitarbeiterliste, bisherigem Beschrieb (~1,5k Zeichen) und
# Antwort sicher in KI_LLM_NUM_CTX 8192 (gemessen ~2,5 Zeichen/Token für Dokumenttext, handlers/ablage.py).
TEIL_ZEICHEN = 10_000
TEIL_UEBERLAPP = 400
MAX_TEILE = 150  # Notbremse ~1,5 Mio Zeichen; greift sie, steht «bis zur Grenze» im Beschrieb


def text_teile(text: str) -> list[str]:
    """Ganzes Dokument in Teile zu TEIL_ZEICHEN mit kleinem Überlapp, möglichst an Absatz-/Satzgrenzen."""
    text = text or ""
    if len(text) <= TEIL_ZEICHEN:
        return [text]
    aus: list[str] = []
    start = 0
    while start < len(text) and len(aus) < MAX_TEILE:
        ende = min(len(text), start + TEIL_ZEICHEN)
        if ende < len(text):
            schnitt = max(text.rfind("\n\n", start + TEIL_ZEICHEN // 2, ende), text.rfind(". ", start + TEIL_ZEICHEN // 2, ende))
            if schnitt > start:
                ende = schnitt + 1
        aus.append(text[start:ende])
        if ende >= len(text):
            break
        start = max(ende - TEIL_UEBERLAPP, start + 1)
    return aus


def verbinde(alt: dict[str, Any], neu: dict[str, Any]) -> dict[str, Any]:
    """Beschrieb nach einem weiteren Teil: Felder des neuen Teils gelten (er kennt das Bisherige), leere Felder behalten
    den alten Wert; Beteiligte und Schlagworte werden vereinigt (Belegtes fällt nicht still weg)."""
    if not alt:
        return dict(neu)
    aus = {**alt, **{k: v for k, v in neu.items() if v not in (None, "", [], {})}}
    namen = {x["name"].lower() for x in neu.get("beteiligte", [])}
    aus["beteiligte"] = (neu.get("beteiligte", []) + [x for x in alt.get("beteiligte", []) if x["name"].lower() not in namen])[:8]
    worte = list(neu.get("schlagworte", []))
    worte += [w for w in alt.get("schlagworte", []) if w.lower() not in {x.lower() for x in worte}]
    aus["schlagworte"] = worte[:10]
    for f in ("beteiligte", "schlagworte"):
        if not aus[f]:
            del aus[f]
    return aus

SYSTEM_ZZ = """Du bist die lokale Ablage-KI der EVENTLINE GmbH (Eventtechnik-Firma, Basel). Du bekommst die erlaubten Dokumenttypen, die Namen der Mitarbeitenden und dann ein Dokument (Dateiname, bisheriger Ablageort, Textinhalt ganz oder gekürzt). Deine Beschreibung entscheidet später, in welchen Ordner das Dokument kommt und wie es heisst — beschreibe es darum so ausführlich und genau wie möglich, aber OHNE sensible Werte.

Regeln:
- Nur was im Dokument, im Dateinamen oder im Ablageort steht. NICHTS erfinden — im Zweifel das Feld leer lassen ("").
- dokumentart: die Art in 1–3 Wörtern (z. B. "Arbeitsvertrag", "Beilage zum Arbeitsvertrag", "Offerte", "Rechnung", "Mietvertrag", "Protokoll", "Statuten", "Versicherungspolice", "Lohnabrechnung", "Plan", "Präsentation", "Liste/Export", "Rapport", "Foto"). unterart: genauer (z. B. "Stellenbeschrieb Techniker", "Verwaltungsvertrag Location", "Leadliste Locations").
- titel: kurzer neutraler Titel (2–6 Wörter), wie man die Datei benennen würde — ohne Datum, ohne Nummern.
- zweck: 1–3 Sätze: worum es geht und wozu das Dokument dient (Thema, Anlass, Veranstaltung, Location, Organisation).
- bezug: worauf es sich bezieht (z. B. "Beilage zum Arbeitsvertrag", "zu Veranstaltung X", "Location Y", "Verein EVENTLINE 2025"), sonst leer.
- status: "entwurf", "unterschrieben", "final", "version" oder "vorlage" — nur wenn erkennbar, sonst "".
- datum: Datum des Dokuments als YYYY-MM-DD, nur wenn ein Tag eindeutig ist. zeitraum: z. B. "2025" oder "Mai–Juni 2026", sonst leer.
- sprache: z. B. "de", "en", "fr". absender / empfaenger: Firma oder Person, nur wenn genannt.
- beteiligte: Personen und Firmen/Locations mit ihrer Rolle (z. B. name "EVENTLINE", rolle "Arbeitgeber"; name "Max Muster", rolle "Arbeitnehmer, Techniker"), höchstens 8.
- schlagworte: bis 10 einzelne Stichworte.
- personenbezogen: true bei Dokumenten über eine einzelne Person (Anstellung, Lohn, Zeugnis, Bewerbung, Ausweis, Kursbestätigung).
VERBOTEN in allen Feldern: Beträge, Löhne, Stunden- und Prozentsätze, IBAN/Kontonummern, AHV-, Ausweis-, Policen-, Kunden-, Rechnungs- und Telefonnummern, E-Mail- und Postadressen, Gesundheitsangaben, Kündigungsgründe, wörtliche Zitate.
Normale deutsche Schreibweise mit Umlauten, Schweizer Schreibweise ohne ß (ss)."""

MAX_ZEICHEN_ZZ = {
    "dokumentart": 60, "unterart": 80, "titel": 60, "zweck": 300, "bezug": 160, "datum": 10, "zeitraum": 40,
    "sprache": 10, "absender": 80, "empfaenger": 80,
}
STATUS_WERTE = ("entwurf", "unterschrieben", "final", "version", "vorlage")
_STATUS_BELEG = {
    "entwurf": r"entwurf|draft", "unterschrieben": r"unterschri|unterzeichn|signed|signiert|visum",
    "final": r"final|definitiv", "version": r"version|(?<![a-z])v\d", "vorlage": r"vorlage|template|muster",
}


def gesperrt(ordner: str) -> bool:
    """Nie ein Ziel: ZZ_*-Segment (jede Tiefe) oder 99_System — wie zielGesperrt im FSM (lib/ki/pfade.ts)."""
    return unter_zz(ordner) or ist_systempfad(ordner)


def ordner_von(pfad: str) -> str:
    return nfc(pfad).rsplit("/", 1)[0] if "/" in pfad else ""


def schema_zz(typ_keys: list[str]) -> dict[str, Any]:
    t = lambda n: {"type": "string", "maxLength": MAX_ZEICHEN_ZZ[n]}  # noqa: E731
    felder: dict[str, Any] = {
        "typ": {"type": "string", "enum": typ_keys},
        "dokumentart": t("dokumentart"), "unterart": t("unterart"), "titel": t("titel"), "zweck": t("zweck"),
        "bezug": t("bezug"), "status": {"type": "string", "enum": ["", *STATUS_WERTE]}, "datum": t("datum"),
        "zeitraum": t("zeitraum"), "sprache": t("sprache"), "absender": t("absender"), "empfaenger": t("empfaenger"),
        "beteiligte": {"type": "array", "maxItems": 8, "items": {
            "type": "object", "properties": {"name": {"type": "string", "maxLength": 80},
                                             "rolle": {"type": "string", "maxLength": 60}},
            "required": ["name", "rolle"]}},
        "schlagworte": {"type": "array", "maxItems": 10, "items": {"type": "string", "maxLength": 30}},
        "personenbezogen": {"type": "boolean"},
    }
    return {"type": "object", "properties": felder, "required": list(felder)}


# --- Filter (deterministisch, Mischa 15.10.) ---------------------------------------------------------------------

_ZITAT = re.compile(r"[«\"„“”‚‘’'][^«»\"„“”]{12,}[»\"“”‘’']")


def sauber(roh: object, max_zeichen: int) -> str:
    """Freitext ohne wörtliche Zitate; mit Inhaltsdetail (ablageregeln.inhalt_frei) → leer."""
    s = text_kurz(roh, max_zeichen)
    s = _ZITAT.sub("", s).strip(" ,;:-")
    s = re.sub(r"\s{2,}", " ", s)
    return s if s and ar.inhalt_frei(s) else ""


def _belegt(name: str, quelle: set[str]) -> bool:
    ws = [w for w in ar.woerter(name) if len(w) >= 3 and w not in ("gmbh", "ag", "sa", "und")]
    return bool(ws) and sum(w in quelle for w in ws) * 2 >= len(ws)


def filtere_beschrieb(roh: dict[str, Any], *, typ: str, typ_label: str, dateiname: str, pfad: str, text: str,
                      heute: str, seiten: int | None, ocr: bool, endung: str) -> dict[str, Any]:
    quelle = set(ar.woerter(text or "")) | set(ar.woerter(dateiname)) | {w for s in ar.herkunft_segmente(pfad) for w in ar.woerter(s)}
    b: dict[str, Any] = {"typ": typ, "typ_label": typ_label}
    for f, n in MAX_ZEICHEN_ZZ.items():
        if f in ("datum", "sprache"):
            continue
        wert = sauber(roh.get(f), n)
        if f in ("absender", "empfaenger") and wert and not _belegt(wert, quelle):
            wert = ""
        if wert:
            b[f] = wert
    # Status und Datum nur, wenn belegt (Probelauf 15.10.: gemma3:4b setzte «unterschrieben» bei CSV-Listen und das
    # heutige Datum bei Dokumenten ohne Datum).
    status = str(roh.get("status") or "")
    belege = ar.falte(f"{dateiname} {' '.join(ar.herkunft_segmente(pfad))} {text or ''}")
    if status in STATUS_WERTE and re.search(_STATUS_BELEG[status], belege):
        b["status"] = status
    d = datum_gueltig(roh.get("datum"))
    if d and "2000-01-01" <= d <= f"{int(heute[:4]) + 1}-12-31" and (
            datum_im_text(d, text or "") or datum_im_text(d, dateiname) or d.replace("-", "") in re.sub(r"\D", "", dateiname)):
        b["datum"] = d
    sprache = text_kurz(roh.get("sprache"), 10).lower()
    if re.fullmatch(r"[a-z]{2,3}(-[a-z]{2})?", sprache):
        b["sprache"] = sprache
    beteiligte = []
    for e in roh.get("beteiligte") or []:
        if not isinstance(e, dict):
            continue
        name, rolle = sauber(e.get("name"), 80), sauber(e.get("rolle"), 60)
        if name and _belegt(name, quelle) and not any(x["name"] == name for x in beteiligte):
            beteiligte.append({"name": name, "rolle": rolle})
    if beteiligte:
        b["beteiligte"] = beteiligte[:8]
    worte = []
    for w in roh.get("schlagworte") or []:
        w = sauber(w, 30)
        if w and re.fullmatch(r"(?i)(chf|eur|usd|fr\.?|franken|betrag|lohn|stundensatz|iban|ahv)", w):
            continue
        if w and w.lower() not in (x.lower() for x in worte):
            worte.append(w)
    if worte:
        b["schlagworte"] = worte[:10]
    if seiten:
        b["seiten"] = int(seiten)
    b["ocr"] = bool(ocr)
    b["dateityp"] = endung.lower().lstrip(".") or None
    b["personenbezogen"] = bool(roh.get("personenbezogen"))
    return b


# --- Fakten-Hinweise ---------------------------------------------------------------------------------------------

_QUELLE_TEXT = {"name": "im Dateinamen", "herkunft": "im bisherigen Ablageort", "text": "im Text", "modell": "von der lokalen KI"}


def fakten_fuer(*, was: ar.Was, rz: ar.RegelZiel | None, rl: Any, ordner: list[str], dateiname: str,
                regel_name: str | None) -> list[str]:
    f: list[str] = []
    if was.dokart:
        f.append(f"Dokumentart laut Dateiname/Ablageort/lokaler KI: {was.dokart.label}"
                 + (" (Personendokument)" if was.personendokument else ""))
    elif was.personendokument:
        f.append("Personendokument (bisheriger Ablageort ist ein Personal-Ordner)")
    if was.person:
        f.append(f"Person erkannt {_QUELLE_TEXT.get(was.person_quelle or '', '')}: {was.person}".replace("  ", " "))
        if was.akte:
            f.append(f"Personalakte dieser Person existiert: {was.akte.pfad}")
        elif was.personendokument:
            eltern = sorted({a.pfad.rsplit("/", 1)[0] for a in ar.akten(ordner)} | {
                nfc(o) for o in ordner if ar.personal_wurzel(nfc(o)) and nfc(o).count("/") <= 2
                and re.search(r"personalakten_[a-z]+$|einzelakten$", ar.falte(nfc(o)))})
            f.append(f"Keine Personalakte für {was.person} gefunden. Personalakten heissen «NNNN_Vorname_Nachname» und liegen "
                     f"unter: {', '.join(eltern) or '06_PERSONAL'}")
    if was.entitaet:
        art = {"location": "Location", "partner": "Partner", "kunde": "Kunde"}[was.entitaet.art]
        f.append(f"{art} mit eigenem Ordner erkannt {_QUELLE_TEXT.get(was.entitaet_quelle or '', '')}: {was.entitaet.pfad}")
    if was.entwurf:
        f.append("Entwurf laut Dateiname/Ablageort: ja")
    if was.datum:
        f.append(f"Datum im Dateinamen: {was.datum}" if was.datum_quelle == "name" else f"Datum laut Dokument: {was.datum}")
    if ar.kryptisch(dateiname):
        f.append("Dateiname ohne Aussage (Scanner/Kamera/Nummer) — ein neuer Name ist nötig")
    if was.liste:
        f.append("Liste/Export (Tabelle): eine einzelne Location oder Firma im Inhalt macht sie nicht zum Thema der Datei")
    if rl is not None and rl.regel_art == "int" and rl.regel:
        f.append(f"INT-Projektnummer im Dateinamen → Projektordner {rl.regel}")
    if rz is not None:
        if rz.ziel:
            f.append(f"Regel-Hinweis Zielordner: {rz.ziel} ({rz.begruendung})")
        elif rz.bereich:
            f.append(f"Regel-Hinweis Bereich: {', '.join(rz.bereich[:3])} ({rz.begruendung})")
    if rl is not None and rl.kandidaten:
        teile = []
        for c in rl.kandidaten[:4]:
            if gesperrt(nfc(c.pfad)):
                continue
            teile.append(f"{c.pfad} (Vorbild-Ähnlichkeit {c.aehnlichkeit:.2f})" if c.aehnlichkeit else c.pfad)
        if teile:
            f.append(f"Ähnlichste Ordner nach bereits abgelegten Dokumenten (Stärke {evidenz(rl)}): " + "; ".join(teile))
    if regel_name:
        f.append(f"Regel-Namensvorschlag (nur Hinweis): {regel_name}")
    return [s[:MAX_FAKT] for s in f if ar.inhalt_frei_hinweis(s)][:MAX_FAKTEN]


@dataclass
class ZzBefund:
    status: str                      # «vorschlag» (Beschrieb fertig) | «kein_ziel»
    grund: str | None = None
    ordner_ist: str = ""
    beschrieb: dict[str, Any] | None = None
    fakten: list[str] = field(default_factory=list)
    kandidaten: list[str] = field(default_factory=list)
    personenbezogen: bool = False
    modell: str | None = None
    dauer_ms: int = 0
    # Nur für Messung/Probelauf (geht nie ans FSM): Hinweis-Ziel der Regeln.
    regel_ziel: str | None = None


def gefilterter_kontext(kontext_roh: dict[str, Any]) -> dict[str, Any]:
    """Ordnerliste ohne gesperrte Ziele (ZZ_* filtert die Rangliste ohnehin, 99_System nicht)."""
    ordner = kontext_roh.get("ordner") if isinstance(kontext_roh, dict) else None
    if not isinstance(ordner, list):
        return dict(kontext_roh or {})
    return {**kontext_roh, "ordner": [o for o in ordner if isinstance(o, str) and o and not gesperrt(nfc(o))]}


def extrakt_aus(dateiname: str, text: str, *, seiten: int | None, ocr: bool) -> Extrakt:
    m = re.search(r"\.[A-Za-z0-9]{1,8}$", dateiname or "")
    mime = ENDUNG_MIME.get(m.group(0).lower(), "application/octet-stream") if m else "application/octet-stream"
    hinweis = None if (text or "").strip() else "Kein lesbarer Text gefunden (leeres Dokument oder OCR ohne Ergebnis)"
    return Extrakt(text=text or "", mime=mime, seiten=seiten, ocr=ocr, hinweis=hinweis)


def zz_beschreiben(
    *, pfad: str, dateiname: str, sha256: str, text: str, seiten: int | None, ocr: bool,
    kontext_roh: dict[str, Any], llm: Ollama, cfg: Einstellungen, archiv: ArchivIndex | None,
    ohne_sha: Collection[str] = (), vorrang: Callable[[], None] | None = None,
) -> ZzBefund:
    """Eine Datei unter ZZ_*: Beschrieb + Fakten. Wirft LlmFehler, wenn das Modell scheitert (Schritt «fehler»)."""
    start = time.monotonic()
    ist = ordner_von(pfad)
    kontext = gefilterter_kontext(kontext_roh)
    k = lese_kontext(kontext, heute_zuerich())
    if not k.ordner:
        return ZzBefund(status="kein_ziel", grund="keine_kandidaten", ordner_ist=ist)
    extrakt = extrakt_aus(dateiname, text, seiten=seiten, ocr=ocr)
    vorbilder = suche_vorbilder(archiv, llm, cfg, k, dateiname, extrakt.text, ohne_sha=ohne_sha)
    # Herkunft (bisheriger Ablageort in ZZ) gehört zur Beschreibung — die lokale KI sieht sie im Dateinamen-Feld.
    herkunft = "/".join(ar.herkunft_segmente(pfad))
    anzeige = f"{dateiname} (bisheriger Ablageort: {herkunft or '—'})"
    typ_keys = [t[0] for t in k.typen]
    labels = dict(k.typen)
    endung = (re.search(r"\.[A-Za-z0-9]{1,8}$", dateiname or "") or [""])[0]
    # Das GANZE Dokument (Mischa 15.10.): in Teilen lesen, jeder weitere Teil ergänzt/korrigiert den Beschrieb.
    teile = text_teile(extrakt.text)
    roh: dict[str, Any] = {}
    beschrieb: dict[str, Any] = {}
    typ = typ_aus(None, k)
    modell = cfg.modell_text
    for i, teil in enumerate(teile, start=1):
        if i > 1 and vorrang is not None:
            vorrang()  # zwischen den Teilen: Wartende (Suche, Archiv-Frage, Beleg) haben Vorrang
        hinweis = extrakt.hinweis
        if len(teile) > 1:
            hinweis = f"Teil {i} von {len(teile)} des Dokuments (Teile überlappen leicht)."
            if i > 1:
                bisher = {f: v for f, v in beschrieb.items() if f not in ("ocr", "dateityp", "seiten", "typ_label")}
                hinweis += (" Bisheriger Beschrieb aus den Teilen davor (JSON): " + json.dumps(bisher, ensure_ascii=False)
                            + " — Ergänze und korrigiere ihn mit diesem Teil (neue Personen, Parteien, Bezüge; Status z. B. "
                            "Entwurf → unterschrieben) und gib den VOLLSTÄNDIGEN Beschrieb über alles bisher Gelesene "
                            "zurück. Belegtes aus früheren Teilen nicht ohne Grund verwerfen.")
        ex = Extrakt(text=teil, mime=extrakt.mime, seiten=extrakt.seiten, ocr=extrakt.ocr, hinweis=hinweis)
        nutzer, num_ctx = prompt_fuer(k, ex, anzeige, cfg, mit_bild=False, foto=False, stufe2=False)
        roh_teil, meta = _chat(llm, modell=cfg.modell_text, system=SYSTEM_ZZ, nutzer=nutzer,
                               schema=schema_zz(typ_keys), num_ctx=num_ctx, num_predict=ANTWORT_TOKENS)
        modell = str(meta.get("modell") or cfg.modell_text)
        typ_teil = typ_aus(roh_teil.get("typ"), k)
        if i == 1 or typ == "sonstiges":
            typ = typ_teil
        neu = filtere_beschrieb(roh_teil, typ=typ, typ_label=labels.get(typ, typ), dateiname=dateiname, pfad=pfad,
                                text=extrakt.text, heute=k.heute, seiten=seiten, ocr=ocr, endung=endung)
        beschrieb = verbinde(beschrieb, neu)
        roh = roh_teil
    gekuerzt = "[Text gekürzt" in (extrakt.text or "")
    if extrakt.text.strip():
        beschrieb["gelesen"] = ("bis zur Grenze der Text-Extraktion" if gekuerzt else "ganz gelesen") + (
            f" ({len(teile)} Teile)" if len(teile) > 1 else "")
    beschrieb["teile"] = len(teile)

    personen_modell = next((e["name"] for e in beschrieb.get("beteiligte", []) if "arbeitnehm" in ar.falte(e.get("rolle", ""))), None)
    was = ar.erkenne(
        pfad=pfad, dateiname=dateiname, text=extrakt.text, ordner=k.ordner, namen_alle=[*k.namen_alle, *k.mitarbeiter],
        heute=k.heute, typ=typ, person_modell=personen_modell, partei_modell=beschrieb.get("absender"),
        betreff_modell=beschrieb.get("titel"), datum_modell=beschrieb.get("datum"),
        personenbezogen_modell=bool(beschrieb.get("personenbezogen")),
    )
    rl = rangliste(
        ordner=k.ordner, mit_dateien=vorbilder.mit_dateien, nachbarn=vorbilder.nachbarn, dateiname=dateiname,
        text=extrakt.text, doc_vektor=vorbilder.vektor, ordner_vektoren=vorbilder.ordner_vektoren, typ=typ,
        person=was.person if was.akte else None,
    )
    rz = ar.regel_ziel(was, k.ordner)
    regel_name = None
    if rz is not None and (rz.ziel or rz.bereich):
        namen_ziel: list[str] = []
        ziel_hinweis = rz.ziel or rz.bereich[0]
        if archiv is not None and vorbilder.archiv_ok:
            try:
                namen_ziel = list(archiv.namen_in([ziel_hinweis], je_ordner=8, ohne_sha=ohne_sha).get(nfc(ziel_hinweis), []))
            except Exception as e:  # noqa: BLE001
                log.warning("ZZ: Dateinamen im Zielordner nicht lesbar (%s)", type(e).__name__)
        regel_name = ar.name_vorschlag(was, dateiname, namen_ziel=namen_ziel, typ_label=labels.get(typ))
    else:
        regel_name = ar.name_vorschlag(was, dateiname, typ_label=labels.get(typ))
    fakten = fakten_fuer(was=was, rz=rz, rl=rl, ordner=k.ordner, dateiname=dateiname, regel_name=regel_name)
    erlaubt = {nfc(o) for o in k.ordner}
    kandidaten: list[str] = []
    for p in ([rz.ziel] if rz and rz.ziel else []) + (rz.bereich[:3] if rz else []) + rl.pfade(6):
        o = nfc(p) if p else ""
        if o and o in erlaubt and not gesperrt(o) and o != ist and o not in kandidaten:
            kandidaten.append(o)
    dauer = int((time.monotonic() - start) * 1000)
    log.info("ZZ: Beschrieb %d Felder, %d Fakten, %d Kandidaten in %d ms", len(beschrieb), len(fakten), len(kandidaten), dauer)
    return ZzBefund(
        status="vorschlag", ordner_ist=ist, beschrieb=beschrieb, fakten=fakten, kandidaten=kandidaten[:MAX_KANDIDATEN],
        personenbezogen=bool(beschrieb.get("personenbezogen")) or was.personendokument, modell=modell, dauer_ms=dauer,
        regel_ziel=(rz.ziel if rz else None),
    )


def meldung(pfad: str, sha256: str, z: dict[str, Any]) -> dict[str, Any]:
    """Eintrag für POST /api/ki/nachtarbeit (§3.6, Liste «vorschlaege», art zz) aus einer gespeicherten Zeile."""
    return {
        "art": "zz", "pfad": nfc(pfad), "sha256": sha256, "ordner_ist": z["ordner_ist"], "rezept": REZEPT,
        "beschrieb": dict(z.get("beschrieb") or {}), "fakten": list(z.get("fakten") or [])[:MAX_FAKTEN],
        "kandidaten": list(z.get("kandidaten") or [])[:MAX_KANDIDATEN],
    }
