"""Rückstau ZZ der Nachtarbeit (Masterplan E4.4, §3.6 «Vorschläge»). Schalter KI_JOB_ZZ.

Alle Dateien unter einem ZZ_*-Segment (jede Tiefe) werden einmal durchgegangen (je sha256 und Rezept), höchstens
KI_JOB_ZZ_MAX (200) je Nacht. Der Kern ist derselbe wie bei ablage_analyse (handlers/ablage.py), nur ohne Download:
der Text kommt aus dem Tiefen-Index (archiv_text, im Tresor).
1. Vorbilder (bge-m3, Archiv-Index) → Stufe 1 (gemma3:4b: Typ, Person, Einordnung) → Rangliste (ordnerwahl.py:
   Regeln, Nachbarn, Ordnernamen).
2. Regel entscheidet → Ziel, Sicherheit «hoch», Quelle «regel». Sonst Stufe 2: gemma3:4b wählt unter den besten
   ANZAHL_KANDIDATEN der Rangliste — nur aktive Ziele aus dem Kontext, nie ZZ_* (jede Tiefe), nie 99_System.
3. Sicherheit (Vertrag): Regel = hoch; Modell und Rangliste einig (Platz 1) = hoch, Quelle «vorbild»; Platz 2–3 =
   mittel, Platz 4–5 = niedrig, Quelle «modell». Datei ohne lesbaren Text: höchstens «niedrig» (ausser Regel).
   Seit zz/v2 (14.10.) gedeckelt durch ordnerwahl.evidenz(): ohne Vorbild ≥ 0,80 im Zielordner höchstens «niedrig»,
   0,80–0,85 höchstens «mittel»; «vorbild» nur bei Platz 1 und Sicherheit über «niedrig».
4. Kein Ziel (Modell wählt keinen, Stufe 2 scheitert, Ziel ungültig oder gleich dem Ist-Ordner) → keine Meldung.
5. Begründung = die minimierte Einordnung `was` (≤ 120 Zeichen) — bei personenbezogenen Dokumenten und in/nach
   einer Personal-Freigabe keine.
Das Modell der Stufe 1 bleibt gemma3:4b auf der GPU (Entscheid nach E2.4); Zeilen ohne Ziel werden im Tresor
gemerkt («kein_ziel»), damit die Datei nicht jede Nacht neu gerechnet wird.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Collection

from ..archiv import ArchivIndex, nfc, unter_zz
from ..config import Einstellungen
from ..einordnung import kuerze_auf_wort, personal_hinweis, unter_personal
from ..extract import ENDUNG_MIME, Extrakt
from ..handlers import text_kurz
from ..handlers.ablage import (
    ANTWORT_TOKENS, ANTWORT_TOKENS_STUFE2, ANZAHL_ALTERNATIVEN, ANZAHL_KANDIDATEN, SYSTEM, heute_zuerich, lese_kontext,
    person_aus, prompt_fuer, pruefe_ergebnis, schema_fuer, schema_stufe2, stufe2_anhang, suche_vorbilder, typ_aus,
)
from ..llm import LlmFehler, Ollama
from ..ordnerwahl import evidenz, rangliste
from ..suche import ist_systempfad
from .fristen import _chat

log = logging.getLogger("ki.nacht.zz")

# v2 (14.10.): Zwillinge stimmen einmal, Sicherheit nach evidenz(). Dateien mit
# offenem Vorschlag bleiben trotzdem übersprungen (bekannt_zz) — neu gerechnet wird erst nach einem Entscheid im FSM.
REZEPT = "zz/v2"
BEGRUENDUNG_MAX = 120
_WORTZEICHEN = re.compile(r"[^\W_]", re.U)
MIN_TEXT_WORTZEICHEN = 20


def gesperrt(ordner: str) -> bool:
    """Nie ein Ziel: ZZ_*-Segment (jede Tiefe) oder 99_System — wie zielGesperrt im FSM (lib/ki/pfade.ts)."""
    return unter_zz(ordner) or ist_systempfad(ordner)


def ordner_von(pfad: str) -> str:
    return nfc(pfad).rsplit("/", 1)[0] if "/" in pfad else ""


_STUFEN = ("niedrig", "mittel", "hoch")


def sicherheit_fuer(*, regel: bool, rang: int | None, mit_text: bool, evidenz: str = "hoch") -> tuple[str, str] | None:
    """(sicherheit, quelle) nach Vertrag — None, wenn es kein Ziel gibt.

    Rang: Platz 1 = hoch, 2–3 = mittel, 4–5 = niedrig; ohne lesbaren Text höchstens niedrig. Dazu die Deckelung durch
    ordnerwahl.evidenz() (Befund 14.10.: «Modell wählt Platz 1» allein gab 77 «wahrscheinlich» für SCALA-Entwürfe ohne
    SCALA-Bezug, gestützt nur von Vorbildern mit Ähnlichkeit 0,6–0,75). «vorbild» nur, wenn ein Vorbild den Ordner
    wirklich trägt (Sicherheit nicht niedrig), sonst «modell».
    """
    if regel:
        return "hoch", "regel"
    if rang is None or rang < 0:
        return None
    if rang == 0:
        s = "hoch"
    elif rang <= 2:
        s = "mittel"
    else:
        s = "niedrig"
    if not mit_text:
        s = "niedrig"
    if evidenz in _STUFEN and _STUFEN.index(evidenz) < _STUFEN.index(s):
        s = evidenz
    q = "vorbild" if rang == 0 and s != "niedrig" else "modell"
    return s, q


@dataclass
class ZzBefund:
    status: str                      # «vorschlag» | «kein_ziel»
    grund: str | None = None         # bei kein_ziel: keiner | stufe2_fehler | ziel_ungueltig | ziel_gleich | keine_kandidaten
    ordner_ist: str = ""
    ziel: str | None = None
    alternativen: list[str] = field(default_factory=list)
    sicherheit: str | None = None
    quelle: str | None = None
    begruendung: str | None = None
    personenbezogen: bool = False
    modell: str | None = None
    dauer_ms: int = 0


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


def zz_einordnen(
    *, pfad: str, dateiname: str, sha256: str, text: str, seiten: int | None, ocr: bool,
    kontext_roh: dict[str, Any], llm: Ollama, cfg: Einstellungen, archiv: ArchivIndex | None,
    ohne_sha: Collection[str] = (),
) -> ZzBefund:
    """Eine Datei unter ZZ_*. Wirft LlmFehler, wenn schon Stufe 1 scheitert (Schritt «fehler», späterer Versuch)."""
    start = time.monotonic()
    ist = ordner_von(pfad)
    kontext = gefilterter_kontext(kontext_roh)
    k = lese_kontext(kontext, heute_zuerich())
    if not k.ordner:
        return ZzBefund(status="kein_ziel", grund="keine_kandidaten", ordner_ist=ist)
    extrakt = extrakt_aus(dateiname, text, seiten=seiten, ocr=ocr)
    mit_text = len(_WORTZEICHEN.findall(extrakt.text)) >= MIN_TEXT_WORTZEICHEN
    vorbilder = suche_vorbilder(archiv, llm, cfg, k, dateiname, extrakt.text, ohne_sha=ohne_sha)
    nutzer, num_ctx = prompt_fuer(k, extrakt, dateiname, cfg, mit_bild=False, foto=False, stufe2=True)
    roh, meta = _chat(
        llm, modell=cfg.modell_text, system=SYSTEM, nutzer=nutzer, schema=schema_fuer(k),
        num_ctx=num_ctx, num_predict=ANTWORT_TOKENS,
    )
    typ = typ_aus(roh.get("typ"), k)
    rl = rangliste(
        ordner=k.ordner, mit_dateien=vorbilder.mit_dateien, nachbarn=vorbilder.nachbarn, dateiname=dateiname,
        text=extrakt.text, doc_vektor=vorbilder.vektor, ordner_vektoren=vorbilder.ordner_vektoren, typ=typ,
        person=person_aus(roh.get("person"), typ, k),
    )
    ziel: str | None = None
    rang: int | None = None
    grund: str | None = None
    modell = str(meta.get("modell") or cfg.modell_text)
    if rl.regel:
        ziel = rl.regel
    elif rl.kandidaten:
        auswahl = rl.kandidaten[:ANZAHL_KANDIDATEN]
        namen = {c.pfad: list(c.nachbarn) for c in auswahl}
        ohne_namen = [c.pfad for c in auswahl if not c.nachbarn]
        if ohne_namen and archiv is not None and vorbilder.archiv_ok:
            try:
                je_ordner = archiv.namen_in(ohne_namen, je_ordner=3, ohne_sha=ohne_sha)
                for p in ohne_namen:
                    namen[p] = je_ordner.get(nfc(p), [])
            except Exception as e:  # noqa: BLE001
                log.warning("ZZ: Dateinamen der Kandidaten nicht lesbar (%s)", type(e).__name__)
        labels = dict(k.typen)
        pfade = [c.pfad for c in auswahl]
        anhang = stufe2_anhang(
            [(c.pfad, namen.get(c.pfad, [])) for c in auswahl], labels.get(typ, typ) or "unbekannt",
            text_kurz(roh.get("beschrieb"), 200), foto=not mit_text,
        )
        try:
            roh2, _meta2 = _chat(
                llm, modell=cfg.modell_text, system=SYSTEM, nutzer=nutzer + anhang, schema=schema_stufe2(pfade),
                num_ctx=num_ctx, num_predict=ANTWORT_TOKENS_STUFE2,
            )
            antwort = text_kurz(roh2.get("ordner"), 300)
            if antwort in pfade:
                ziel, rang = antwort, pfade.index(antwort)
            else:
                grund = "keiner"
        except LlmFehler as e:
            # Ohne Modellentscheid wird nicht geraten (anders als im Live-Pfad: dort Rückfall auf Platz 1).
            log.warning("ZZ Stufe 2 fehlgeschlagen (%s) — keine Meldung", str(e)[:120])
            grund = "stufe2_fehler"
    else:
        grund = "keine_kandidaten"

    erlaubt = {nfc(o) for o in k.ordner}
    if ziel is not None and (nfc(ziel) not in erlaubt or gesperrt(nfc(ziel))):
        ziel, grund = None, "ziel_ungueltig"
    if ziel is not None and nfc(ziel) == ist:
        ziel, grund = None, "ziel_gleich"
    # Einordnung (minimiert) aus derselben Stufe-1-Antwort — für personenbezogen und die Begründung.
    erg = pruefe_ergebnis(
        dict(roh, ordner=ziel or "", neuer_ordner=""), k, extrakt, sha256=sha256, modell=modell,
        dauer_ms=0, dateiname=dateiname, foto=False, regel_art=rl.regel_art,
        personal_ordner=personal_hinweis(rl, ziel),
    )
    einordnung = erg.get("einordnung") or {}
    personenbezogen = bool(einordnung.get("personenbezogen")) or unter_personal(pfad) or unter_personal(ziel)
    dauer = int((time.monotonic() - start) * 1000)
    if ziel is None:
        return ZzBefund(status="kein_ziel", grund=grund or "keiner", ordner_ist=ist, personenbezogen=personenbezogen,
                        modell=modell, dauer_ms=dauer)
    bewertung = sicherheit_fuer(regel=bool(rl.regel), rang=rang, mit_text=mit_text, evidenz=evidenz(rl, ziel))
    if bewertung is None:  # pragma: no cover — ziel ohne Rang und ohne Regel gibt es nicht
        return ZzBefund(status="kein_ziel", grund="keiner", ordner_ist=ist, modell=modell, dauer_ms=dauer)
    sicherheit, quelle = bewertung
    alternativen: list[str] = []
    for p in rl.pfade(ANZAHL_ALTERNATIVEN + 2):
        o = nfc(p)
        if o != nfc(ziel) and o != ist and o in erlaubt and not gesperrt(o) and o not in alternativen:
            alternativen.append(o)
        if len(alternativen) >= ANZAHL_ALTERNATIVEN:
            break
    begruendung = None
    if not personenbezogen:
        was = text_kurz(einordnung.get("was"), 400)
        begruendung = kuerze_auf_wort(was, BEGRUENDUNG_MAX) or None
    log.info("ZZ: Vorschlag %s/%s (Rang %s, Text %s) in %d ms", sicherheit, quelle, rang, mit_text, dauer)
    return ZzBefund(
        status="vorschlag", ordner_ist=ist, ziel=nfc(ziel), alternativen=alternativen, sicherheit=sicherheit,
        quelle=quelle, begruendung=begruendung, personenbezogen=personenbezogen, modell=modell, dauer_ms=dauer,
    )


def meldung(pfad: str, sha256: str, z: dict[str, Any]) -> dict[str, Any]:
    """Eintrag für POST /api/ki/nachtarbeit (§3.6, Liste «vorschlaege», art zz) aus einer gespeicherten Zeile."""
    eintrag: dict[str, Any] = {
        "art": "zz", "pfad": nfc(pfad), "sha256": sha256, "ordner_ist": z["ordner_ist"],
        "ziel_ordner": z["ziel_ordner"], "alternativen": list(z.get("alternativen") or [])[:ANZAHL_ALTERNATIVEN],
        "sicherheit": z["sicherheit"], "quelle": z["quelle"],
    }
    if z.get("begruendung"):
        eintrag["begruendung"] = str(z["begruendung"])[:BEGRUENDUNG_MAX]
    return eintrag
