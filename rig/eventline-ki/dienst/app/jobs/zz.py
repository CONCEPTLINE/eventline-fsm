"""Rückstau ZZ der Nachtarbeit (Masterplan E4.4, §3.6 «Vorschläge»). Schalter KI_JOB_ZZ.

Rezept zz/v3 (15.10.2026, Architektur «Stärken verteilen», Mischa): das Rig entscheidet den Ordner NICHT mehr.
1. Die lokale KI (gemma3:4b) liest das GANZE Dokument in Teilen zu TEIL_ZEICHEN und beschreibt es strukturiert:
   Dokumentart und Unterart, Titel, Zweck, Bezug, Status, Datum/Zeitraum, Sprache, Absender/Empfänger, Beteiligte mit
   Rolle, Schlagworte.
2. Der Sensibel-Filter entfernt deterministisch Beträge/Löhne/Sätze, IBAN/Konto, AHV, Ausweis-/Policen-/
   Telefonnummern, E-Mail/Adressen, Gesundheits-/Kündigungsgründe, wörtliche Zitate — ein Feld mit Treffer fällt ganz weg.
3. Fakten-Hinweise (ablageregeln.py + Vorbilder der Ordnerwahl): erkannte Person und ob ihre Personalakte existiert,
   Location/Partner mit eigenem Ordner, Entwurf, Datum im Namen, INT-Nummer, Regel-Hinweis, ähnlichste Ordner nach
   Vorbild-Dokumenten, Regel-Namensvorschlag. Nur Hinweise — Claude im FSM entscheidet, ein Mensch gibt frei.
4. Meldung ans FSM (POST /api/ki/nachtarbeit, Liste «vorschlaege», art zz): pfad, sha256, ordner_ist, rezept,
   beschrieb, fakten, kandidaten — nie Dokumenttext.

Rezept zz/v4 (16.10.2026, Messnacht 15./16.10.: 32,7 % unbelegte Angaben vor dem Filter, Beispiele der Anleitung in
Beschrieben): Belegstellen (belege.py). Jede Angabe zu Datum, Zeitraum, Status, Bezug, Absender/Empfänger und jede
beteiligte Person/Firma kommt mit einem wörtlichen Beleg aus dem Teil, den die KI gerade liest; das Rig prüft Beleg und
Wert ohne Modell (passt der Beleg nicht, sucht es den Wert selbst im Teil — belege.wert_im_teil), Unbelegtes fällt weg
und steht im Beschrieb unter `unbekannt`. Eine Rolle gilt nur, wenn sie im Teil steht. Die Anleitung enthält keine
Beispielwerte mehr (das Modell kopierte sie), der Prompt keine Liste der Mitarbeitenden (das Modell übernahm Namen
daraus als Beteiligte); kopierte frühere Beispiele ohne Beleg im Dokument fallen weg, ebenso Daten/Jahre in freien
Feldern, die nirgends im Dokument stehen. Teile werden
deterministisch zusammengeführt: der erste belegte Wert eines Felds gilt, spätere Teile ergänzen nur, was fehlt. Kein
heutiges Datum mehr im Prompt. Firmenwissen (Tab «Wissen», wissen.py) steht als eigener Abschnitt im Prompt — nur
Einträge, deren Begriff im Teil, im Dateinamen oder im Ablageort steht. Kennzahlen je Datei (nur Zahlen):
`ZzBefund.belege` {feld: {angegeben, belegt}} → Protokoll (Belegquote im Technik-Dashboard). Die Belege selbst bleiben im
Prozess — nie ans FSM, ins Protokoll oder ins Log.
Neu gerechnet wird eine Datei, wenn das FSM für sie nichts mit diesem Rezept kennt und kein Vorschlag angenommen ist
(offene Vorschläge älterer Rezepte ersetzt das FSM, sie werden «veraltet»).

Nachtrag zz/v4 (16.10.2026, vor der ersten Datei mit zz/v4): der Typ kommt deterministisch aus der Beschreibung
(typ_normal) — gemma3:4b setzte «vertrag» für fast alles, Gemma 4 «sonstiges» mit der Art in dokumentart/unterart;
beide Modelle ergeben so dieselbe Typ-Logik (zweiter Blick, jobs/zweiter_blick.py).
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Callable, Collection

from .. import ablageregeln as ar
from .. import belege as bl
from .. import wissen as wi
from ..archiv import ArchivIndex, nfc, unter_zz
from ..config import Einstellungen
from ..extract import ENDUNG_MIME, Extrakt
from ..handlers import datum_gueltig, text_kurz
from ..handlers.ablage import lese_kontext, heute_zuerich, prompt_fuer, suche_vorbilder, typ_aus
from ..llm import Ollama
from ..ordnerwahl import evidenz, rangliste
from ..suche import ist_systempfad
from .fristen import _chat, _datum_feld, datum_im_text

log = logging.getLogger("ki.nacht.zz")

REZEPT = "zz/v4"
_WORTZEICHEN = re.compile(r"[^\W_]", re.U)
MIN_TEXT_WORTZEICHEN = 20
MAX_FAKTEN = 12
MAX_FAKT = 300
MAX_KANDIDATEN = 8
# Teil-Grösse beim Lesen in Teilen: passt mit Anleitung, Mitarbeiterliste, Firmenwissen (≤ 800 Zeichen), bisherigem
# Beschrieb (~1,5k Zeichen) und Antwort (ANTWORT_TOKENS_ZZ) in KI_LLM_NUM_CTX 8192 — gerechnet mit 2,5 Zeichen/Token,
# gemessen ~3,1 für Dokumenttext (handlers/ablage.py). test_zz_teil_passt_ins_fenster prüft das.
TEIL_ZEICHEN = 10_000
TEIL_UEBERLAPP = 400
MAX_TEILE = 150  # Notbremse ~1,5 Mio Zeichen; greift sie, steht «bis zur Grenze» im Beschrieb
# Antwort mit Belegen: gemessen zz/v3 Median 329 Tokens ohne Belege; Belege kosten je Angabe ~15–25 Tokens.
ANTWORT_TOKENS_ZZ = 1200


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


# Keine Beispielwerte (Messnacht 15./16.10.: gemma3:4b kopierte «Verwaltungsvertrag Location», «zu Veranstaltung X»,
# EVENTLINE als «Arbeitgeber» … in fremde Dokumente). Nur abstrakte Beschreibungen der Felder.
SYSTEM_ZZ = """Du bist die lokale Ablage-KI der EVENTLINE GmbH (Eventtechnik-Firma, Basel). Du liest EINEN Teil eines Dokuments (dazu Dateiname und bisheriger Ablageort) und beschreibst ihn. Aus deinem Beschrieb wählt später jemand Ordner und Dateinamen — er muss stimmen, nicht vollständig sein.

Grundregeln:
- Nur was in diesem Teil, im Dateinamen oder im Ablageort steht. "unbekannt" ist eine gute Antwort; Raten ist ein Fehler.
- Übernimm keine Wörter aus dieser Anleitung als Inhalt — beschreibe in eigenen Worten, was im Dokument steht.
- Belege: Für datum, zeitraum, status, bezug, absender, empfaenger und jede beteiligte Person/Firma schreibst du ZUERST den Beleg: höchstens 8 Wörter, buchstabengetreu aus dem Teil abgeschrieben (gleiche Schreibweise, gleiche Zahlen), genau die Stelle, an der die Angabe steht. Danach den Wert. Steht die Angabe nicht im Teil: Beleg "" und Wert "unbekannt" (bei beteiligte: weglassen). Werte ohne passenden Beleg werden verworfen. Belege dienen nur der Prüfung und bleiben im Haus.

Felder:
- typ: der passendste Dokumenttyp aus der Liste.
- dokumentart: was für ein Dokument es ist, 1–3 Wörter. unterart: genauer, 1–4 Wörter, oder "unbekannt".
- titel: neutraler Titel, 2–6 Wörter, ohne Datum und ohne Nummern.
- zweck: 1–3 eigene Sätze: worum es geht und wozu das Dokument dient.
- bezug: worauf sich das Dokument bezieht (ein anderes Dokument, eine Veranstaltung, ein Ort, eine Organisation, eine Version), sonst "unbekannt".
- status: "entwurf", "unterschrieben", "final", "version" oder "vorlage" — nur wenn das Wort oder eine klare Entsprechung im Teil steht (eine leere Unterschriftszeile heisst nicht unterschrieben), sonst "unbekannt".
- datum: Datum des Dokuments als JJJJ-MM-TT, nur wenn der Tag im Teil steht, sonst "unbekannt".
- zeitraum: Zeitraum, auf den sich das Dokument bezieht, wie im Teil genannt, sonst "unbekannt".
- sprache: Sprachcode des Dokuments.
- absender, empfaenger: Firma oder Person, wie im Teil genannt, sonst "unbekannt".
- beteiligte: Personen und Firmen/Organisationen aus dem Teil, höchstens 8, je Beleg, Name und Rolle; die Rolle nur, wenn sie im Teil steht, sonst "unbekannt". Keine Adressen.
- schlagworte: bis 10 einzelne Stichworte aus dem Teil.
- personenbezogen: true nur bei Dokumenten über eine einzelne Person (Anstellung, Lohn, Zeugnis, Bewerbung, Ausweis, Kursbestätigung).
VERBOTEN in allen Werten: Beträge, Löhne, Stunden- und Prozentsätze, IBAN/Kontonummern, AHV-, Ausweis-, Policen-, Kunden-, Rechnungs- und Telefonnummern, E-Mail- und Postadressen, Gesundheitsangaben, Kündigungsgründe, wörtliche Zitate.
Schweizer Schreibweise (ss statt ß), normale Umlaute."""

MAX_ZEICHEN_ZZ = {
    "dokumentart": 60, "unterart": 80, "titel": 60, "zweck": 300, "bezug": 160, "datum": 10, "zeitraum": 40,
    "sprache": 10, "absender": 80, "empfaenger": 80,
}
MAX_ZEICHEN_BELEG = 140
STATUS_WERTE = ("entwurf", "unterschrieben", "final", "version", "vorlage")
# Angaben mit Beleg (Einzelwerte); dazu die Beteiligten (Namen) und ihre Rollen.
BELEG_FELDER = ("datum", "zeitraum", "status", "bezug", "absender", "empfaenger")
ZAEHL_FELDER = (*BELEG_FELDER, "beteiligte", "rolle")
FREIE_FELDER = ("dokumentart", "unterart", "titel", "zweck")


def gesperrt(ordner: str) -> bool:
    """Nie ein Ziel: ZZ_*-Segment (jede Tiefe) oder 99_System — wie zielGesperrt im FSM (lib/ki/pfade.ts)."""
    return unter_zz(ordner) or ist_systempfad(ordner)


def ordner_von(pfad: str) -> str:
    return nfc(pfad).rsplit("/", 1)[0] if "/" in pfad else ""


def schema_zz(typ_keys: list[str]) -> dict[str, Any]:
    """Beleg vor Wert: das Modell schreibt zuerst die Stelle ab, dann den Wert daraus (Schema-Reihenfolge)."""
    t = lambda n: {"type": "string", "maxLength": MAX_ZEICHEN_ZZ[n]}  # noqa: E731
    beleg = {"type": "string", "maxLength": MAX_ZEICHEN_BELEG}
    felder: dict[str, Any] = {
        "typ": {"type": "string", "enum": typ_keys},
        "dokumentart": t("dokumentart"), "unterart": t("unterart"), "titel": t("titel"), "zweck": t("zweck"),
        "bezug_beleg": beleg, "bezug": t("bezug"),
        "status_beleg": beleg, "status": {"type": "string", "enum": [bl.UNBEKANNT, *STATUS_WERTE]},
        "datum_beleg": beleg, "datum": t("datum"),
        "zeitraum_beleg": beleg, "zeitraum": t("zeitraum"),
        "sprache": t("sprache"),
        "absender_beleg": beleg, "absender": t("absender"),
        "empfaenger_beleg": beleg, "empfaenger": t("empfaenger"),
        "beteiligte": {"type": "array", "maxItems": 8, "items": {
            "type": "object", "properties": {"beleg": beleg, "name": {"type": "string", "maxLength": 80},
                                             "rolle": {"type": "string", "maxLength": 60}},
            "required": ["beleg", "name", "rolle"]}},
        "schlagworte": {"type": "array", "maxItems": 10, "items": {"type": "string", "maxLength": 30}},
        "personenbezogen": {"type": "boolean"},
    }
    return {"type": "object", "properties": felder, "required": list(felder)}


# --- Filter (deterministisch, Mischa 15.10.) ---------------------------------------------------------------------

_ZITAT = re.compile(r"[«\"„“”‚‘’'][^«»\"„“”]{12,}[»\"“”‘’']")


def sauber(roh: object, max_zeichen: int) -> str:
    """Freitext ohne wörtliche Zitate; mit Inhaltsdetail (ablageregeln.inhalt_frei) → leer; «unbekannt» → leer."""
    s = text_kurz(roh, max_zeichen)
    s = _ZITAT.sub("", s).strip(" ,;:-")
    s = re.sub(r"\s{2,}", " ", s)
    return s if s and ar.inhalt_frei(s) and not bl.ist_unbekannt(s) else ""


_DATUM_FREI = re.compile(r"(?<![\d.])\d{1,2}\.\s?\d{1,2}\.\s?(?:\d{4}|\d{2})(?![\d.])|(?<!\d)(?:19|20)\d\d-\d\d-\d\d(?!\d)")
_JAHR_FREI = re.compile(r"(?<!\d)(?:19|20)\d\d(?!\d)")


def frei_unbelegt(wert: str, dokument: str, roh_texte: str) -> bool:
    """Ein freies Feld nennt ein Datum oder Jahr, das nirgends im Dokument (Text, Dateiname, Ablageort) steht."""
    for m in _DATUM_FREI.finditer(wert):
        t = re.split(r"[.\s-]+", m.group(0).strip())
        iso = m.group(0) if "-" in m.group(0) else None
        if iso is None and len(t) >= 3:
            j = int(t[2]) + (2000 if len(t[2]) == 2 else 0)
            iso = f"{j:04d}-{int(t[1]):02d}-{int(t[0]):02d}"
        if iso and datum_gueltig(iso) and not datum_im_text(iso, roh_texte):
            return True
    return any(f" {j} " not in dokument and f" {j[2:]} " not in dokument for j in _JAHR_FREI.findall(wert))


@dataclass
class _Stand:
    """Zusammengeführter Beschrieb über die Teile (nur im Prozess; Belegstellen ohne Text)."""
    werte: dict[str, str] = field(default_factory=dict)
    stellen: dict[str, bl.Fund] = field(default_factory=dict)
    beteiligte: list[dict[str, str]] = field(default_factory=list)
    frei: dict[str, Any] = field(default_factory=dict)
    z: Counter = field(default_factory=Counter)

    def bisher(self) -> dict[str, Any]:
        """Für den Prompt der nächsten Teile: belegte Werte und freie Felder (ohne Belege)."""
        aus: dict[str, Any] = {k: v for k, v in self.frei.items() if k in (*FREIE_FELDER, "schlagworte") and v}
        aus.update(self.werte)
        if self.beteiligte:
            aus["beteiligte"] = [{"name": b["name"], "rolle": b["rolle"] or bl.UNBEKANNT} for b in self.beteiligte]
        return aus


def _gleicher_name(a: str, b: str) -> bool:
    wa, wb = set(bl.woerter(a)), set(bl.woerter(b))
    return bool(wa and wb) and (wa <= wb or wb <= wa)


class _Pruefung:
    """Prüft die Antwort EINES Teils gegen seinen Text (Belege) und führt sie in den Stand ein."""

    def __init__(self, *, teil: bl.Teil, stand: _Stand, dokument: str, roh_texte: str,
                 wissen: list[wi.WissenEintrag]) -> None:
        self.teil = teil
        self.stand = stand
        self.dokument = dokument          # « w1 w2 … » ganzes Dokument + Dateiname + Ablageort
        self.roh_texte = roh_texte        # ganzes Dokument + Dateiname (Datumsprüfung in freien Feldern)
        self.wissen = wissen

    def _zaehle(self, feld: str, belegt: bool) -> None:
        self.stand.z[f"{feld}_angegeben"] += 1
        if belegt:
            self.stand.z[f"{feld}_belegt"] += 1

    def _kopie(self, wert: str) -> bool:
        if bl.prompt_kopie(wert, self.dokument):
            self.stand.z["prompt_kopie"] += 1
            return True
        return False

    def _extra(self, fund: bl.Fund | None) -> set[str]:
        return wi.erweiterung(self.wissen, list(fund.woerter)) if fund else set()

    def wert(self, feld: str, roh: dict[str, Any]) -> None:
        if feld in self.stand.werte:
            return  # erster belegter Wert gilt; spätere Teile zählen hier nicht
        if feld == "status":
            wert = str(roh.get("status") or "")
            wert = wert if wert in STATUS_WERTE else ""
        elif feld == "datum":
            # Auch «31.12.2026» trotz Vorgabe JJJJ-MM-TT wird gelesen; Unlesbares zählt als Angabe ohne Beleg («!»).
            wert = "" if bl.ist_unbekannt(roh.get("datum")) else (_datum_feld(roh.get("datum"))[0] or "!")
        else:
            wert = sauber(roh.get(feld), MAX_ZEICHEN_ZZ[feld])
            if not wert and not bl.ist_unbekannt(roh.get(feld)) and text_kurz(roh.get(feld), 200):
                self.stand.z["filter_sensibel"] += 1
        if not wert:
            return
        if wert == "!" or self._kopie(wert):
            self._zaehle(feld, False)
            return
        fund = bl.anker_finden(roh.get(f"{feld}_beleg"), self.teil)
        ok = False
        if fund is not None:
            anker = str(roh.get(f"{feld}_beleg") or "")
            extra = self._extra(fund)
            if feld == "datum":
                ok = bl.datum_belegt(wert, anker)
            elif feld == "zeitraum":
                ok = bl.zeitraum_belegt(wert, anker, extra)
            elif feld == "status":
                ok = bl.status_belegt(wert, anker)
            elif feld == "bezug":
                ok = bl.bezug_belegt(wert, fund.woerter, extra)
            else:  # absender, empfaenger
                ok = bl.name_belegt(wert, fund.woerter, extra)
        if not ok:
            # Beleg der KI passt nicht: steht der Wert selbst im Teil, ist seine Stelle die Belegstelle.
            fund = bl.wert_im_teil(feld, wert, self.teil)
            ok = fund is not None
            if ok:
                self.stand.z["beleg_vom_rig"] += 1
        self._zaehle(feld, ok)
        if ok:
            self.stand.werte[feld] = wert
            self.stand.stellen[feld] = fund  # type: ignore[assignment]

    def beteiligte(self, roh: dict[str, Any]) -> None:
        for e in (roh.get("beteiligte") or [])[:8]:
            if not isinstance(e, dict):
                continue
            name = sauber(e.get("name"), 80)
            if not name:
                continue
            rolle_roh = sauber(e.get("rolle"), 60)
            vorhanden = next((b for b in self.stand.beteiligte if _gleicher_name(b["name"], name)), None)
            if vorhanden is not None and vorhanden["rolle"]:
                continue  # schon belegt, mit Rolle
            fund = bl.anker_finden(e.get("beleg"), self.teil)
            if fund is not None and not bl.name_belegt(name, fund.woerter, self._extra(fund)):
                fund = None
            vom_rig = False
            if fund is None:
                # Beleg der KI passt nicht: steht der Name selbst im Teil, ist seine Stelle die Belegstelle.
                fund = bl.name_fund(name, self.teil)
                vom_rig = fund is not None
            if vorhanden is None:
                if self._kopie(name):
                    self._zaehle("beteiligte", False)
                    continue
                ok = fund is not None
                self._zaehle("beteiligte", ok)
                if ok and vom_rig:
                    self.stand.z["beleg_vom_rig"] += 1
                if not ok or len(self.stand.beteiligte) >= 8:
                    continue
                vorhanden = {"name": name, "rolle": ""}
                self.stand.beteiligte.append(vorhanden)
            elif fund is None:
                continue  # bekannter Name ohne Rolle: eine Rolle zählt nur mit Beleg aus diesem Teil
            if rolle_roh:
                extra = self._extra(fund) | wi.erweiterung(self.wissen, bl.woerter(name))
                ok_r = not self._kopie(rolle_roh) and bl.rolle_belegt(rolle_roh, self.teil, extra)
                self._zaehle("rolle", ok_r)
                if ok_r:
                    vorhanden["rolle"] = rolle_roh

    def frei(self, roh: dict[str, Any]) -> None:
        """Freie Felder: dieser Teil kennt das Bisherige und ersetzt es; Kopien und erfundene Daten fallen weg."""
        for f in FREIE_FELDER:
            wert = sauber(roh.get(f), MAX_ZEICHEN_ZZ[f])
            if not wert:
                continue
            if self._kopie(wert):
                continue
            if frei_unbelegt(wert, self.dokument, self.roh_texte):
                self.stand.z["frei_datum_unbelegt"] += 1
                continue
            self.stand.frei[f] = wert
        worte: list[str] = []
        for w in roh.get("schlagworte") or []:
            w = sauber(w, 30)
            if not w or re.fullmatch(r"(?i)(chf|eur|usd|fr\.?|franken|betrag|lohn|stundensatz|iban|ahv)", w):
                continue
            if self._kopie(w) or w.lower() in (x.lower() for x in worte):
                continue
            worte.append(w)
        if worte:
            alt = [w for w in self.stand.frei.get("schlagworte", []) if w.lower() not in {x.lower() for x in worte}]
            self.stand.frei["schlagworte"] = (worte + alt)[:10]
        sprache = text_kurz(roh.get("sprache"), 10).lower()
        if re.fullmatch(r"[a-z]{2,3}(-[a-z]{2})?", sprache):
            self.stand.frei["sprache"] = sprache
        self.stand.frei["personenbezogen"] = bool(roh.get("personenbezogen"))


# --- Typ-Feld angleichen (16.10.2026, zweiter Blick) ------------------------------------------------------------------
# Messnacht 15./16.10.: gemma3:4b setzt «vertrag» auch für Tarifblatt, Konzept oder Handelsregisteranmeldung, Gemma 4
# setzt oft «sonstiges» und schreibt die Art in dokumentart/unterart — Übereinstimmung beim Typ nur 25 %, bei der
# Dokumentart 50 %. Darum bestimmt das Rig den Typ deterministisch aus der Beschreibung (für beide Modelle gleich): die
# Dokumentart ist massgeblich, Unterart und Titel nur, wenn die Dokumentart keine Art erkennen lässt.
# 1. Das erste Feld (dokumentart, unterart, titel), in dem eine Art erkannt wird (Stämme aus ablageregeln.DOKARTEN, dazu
#    Bank, Steuern und E-Mail), entscheidet: deren FSM-Typ — oder «sonstiges», wenn die Art keinen hat (Präsentation,
#    Plan, Liste, Statuten …).
# 2. Nennt die Dokumentart etwas Unbekanntes (Tarifblatt, Konzept …): «sonstiges».
# 3. Ohne Dokumentart bleibt der Typ des Modells.

DOKART_ZU_TYP = {
    "vertragsbeilage": "vertrag", "arbeitsvertrag": "vertrag", "vertrag": "vertrag", "kuendigung": "kuendigung",
    "lohnabrechnung": "lohnabrechnung", "ausweis": "behoerde", "bewilligung": "behoerde", "ausbildung": "zertifikat",
    "zertifikat": "zertifikat", "offerte": "offerte", "rechnung": "rechnung", "mahnung": "mahnung",
    "protokoll": "protokoll", "versicherung": "versicherungspolice", "korrespondenz": "korrespondenz",
}
# FSM-Typen ohne eigene Dokumentart in ablageregeln. VOR den Dokumentarten (nur eindeutige Zusammensetzungen —
# «Kreditkartenabrechnung» ist Bank, nicht Rechnung; «steuer» allein träfe «Lichtsteuerung») bzw. DANACH (breite Wörter:
# «Mietvertrag per E-Mail» bleibt ein Vertrag).
TYP_VOR: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("bank", ("kontoauszug", "bankauszug", "kontoeroeffnung", "bankbeleg", "zahlungsauftrag", "kreditkartenabrechnung",
              "kontobestaetigung", "bankgarantie")),
    ("steuern", ("steuererklaerung", "steuerveranlagung", "steuerbescheid", "steuerverfuegung", "steuerrechnung",
                 "mehrwertsteuer", "mwst", "quellensteuer", "steueramt")),
    ("behoerde", ("verfuegung", "amtsschreiben", "behoerde")),
)
TYP_NACH: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("korrespondenz", ("email", "mail", "nachricht")),
)
TYP_SONSTIGES = "sonstiges"


def typ_aus_text(text: str, erlaubt: Collection[str]) -> tuple[bool, str | None]:
    """(eine Art erkannt?, FSM-Typ oder None) für EIN Feld — gleiche Wortregel wie ablageregeln.dokart_aus."""
    ws = ar.woerter(text or "")
    if not ws or bl.ist_unbekannt(text):
        return False, None
    for key, staemme in TYP_VOR:
        if any(ar._hat_stamm(ws, s) for s in staemme):  # noqa: SLF001
            return True, key if key in erlaubt else None
    for d in ar.DOKARTEN:
        if d.stamm and any(ar._hat_stamm(ws, s) for s in d.stamm):  # noqa: SLF001
            typ = DOKART_ZU_TYP.get(d.key)
            return True, typ if typ in erlaubt else None
    for key, staemme in TYP_NACH:
        if any(ar._hat_stamm(ws, s) for s in staemme):  # noqa: SLF001
            return True, key if key in erlaubt else None
    return False, None


def typ_normal(typ_modell: str, frei: dict[str, Any], erlaubt: Collection[str]) -> str:
    """Typ aus der Beschreibung (siehe oben) — deterministisch, gleich für gemma3:4b und Gemma 4."""
    rest = TYP_SONSTIGES if TYP_SONSTIGES in erlaubt else typ_modell
    for feld in ("dokumentart", "unterart", "titel"):
        erkannt, typ = typ_aus_text(str(frei.get(feld) or ""), erlaubt)
        if erkannt:
            return typ or rest
    if not bl.ist_unbekannt(frei.get("dokumentart")):
        return rest
    return typ_modell if typ_modell in erlaubt else rest


def belege_kennzahlen(z: Counter) -> dict[str, dict[str, int]]:
    """Nur Zahlen je Feld: {feld: {angegeben, belegt}} — Felder ohne Angabe fehlen."""
    aus: dict[str, dict[str, int]] = {}
    for f in ZAEHL_FELDER:
        a = int(z.get(f"{f}_angegeben", 0))
        if a:
            aus[f] = {"angegeben": a, "belegt": min(a, int(z.get(f"{f}_belegt", 0)))}
    return aus


def beschrieb_aus(stand: _Stand, *, typ: str, typ_label: str, seiten: int | None, ocr: bool, endung: str) -> dict[str, Any]:
    """Der Beschrieb, wie er ans FSM geht: belegte Werte, freie Felder, `unbekannt` (Felder ohne Beleg)."""
    b: dict[str, Any] = {"typ": typ, "typ_label": typ_label}
    for f in FREIE_FELDER:
        if stand.frei.get(f):
            b[f] = stand.frei[f]
    for f in BELEG_FELDER:
        if f in stand.werte:
            b[f] = stand.werte[f]
    if stand.frei.get("sprache"):
        b["sprache"] = stand.frei["sprache"]
    if stand.beteiligte:
        b["beteiligte"] = [{"name": x["name"], "rolle": x["rolle"]} for x in stand.beteiligte[:8]]
    if stand.frei.get("schlagworte"):
        b["schlagworte"] = stand.frei["schlagworte"][:10]
    if seiten:
        b["seiten"] = int(seiten)
    b["ocr"] = bool(ocr)
    b["dateityp"] = endung.lower().lstrip(".") or None
    b["personenbezogen"] = bool(stand.frei.get("personenbezogen"))
    b["unbekannt"] = [f for f in BELEG_FELDER if f not in stand.werte] + ([] if stand.beteiligte else ["beteiligte"])
    return b


def filtere_beschrieb(roh: dict[str, Any], *, typ: str, typ_label: str, dateiname: str, pfad: str, text: str,
                      heute: str, seiten: int | None, ocr: bool, endung: str,
                      wissen: list[wi.WissenEintrag] | None = None) -> dict[str, Any]:
    """Eine Antwort (ein Teil = das ganze Dokument) prüfen — für Tests und den Probelauf; zz_beschreiben macht dasselbe
    Teil für Teil. `heute` bleibt für die Aufrufer (früher: Datum nicht in der Zukunft), geprüft wird gegen den Beleg."""
    del heute
    stand = _Stand()
    herkunft = " ".join(ar.herkunft_segmente(pfad))
    p = _Pruefung(teil=bl.Teil(1, text), stand=stand, dokument=bl.dokument_woerter(text, dateiname, herkunft),
                  roh_texte=f"{text}\n{dateiname}", wissen=wissen or [])
    for f in BELEG_FELDER:
        p.wert(f, roh)
    p.beteiligte(roh)
    p.frei(roh)
    return beschrieb_aus(stand, typ=typ, typ_label=typ_label, seiten=seiten, ocr=ocr, endung=endung)


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
    # Belegquote (nur Zahlen, Protokoll): {feld: {angegeben, belegt}}; dazu Zähler (prompt_kopie, filter_sensibel …).
    belege: dict[str, dict[str, int]] = field(default_factory=dict)
    zaehler: Counter = field(default_factory=Counter)


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


MAX_BISHER = 1800  # Zeichen für den bisherigen Beschrieb im Prompt — der Teil passt dann immer ganz ins Fenster


def bisher_json(stand: _Stand) -> str:
    """Bisheriger Beschrieb als JSON, höchstens MAX_BISHER Zeichen (sonst Zweck, Schlagworte, Beteiligte gekürzt)."""
    b = stand.bisher()
    for schritt in range(4):
        text = json.dumps(b, ensure_ascii=False)
        if len(text) <= MAX_BISHER:
            return text
        if schritt == 0 and "zweck" in b:
            b["zweck"] = b["zweck"][:160]
        elif schritt == 1 and "schlagworte" in b:
            b["schlagworte"] = b["schlagworte"][:4]
        elif schritt == 2 and "beteiligte" in b:
            b["beteiligte"] = b["beteiligte"][:4]
    return json.dumps({k: v for k, v in b.items() if k in BELEG_FELDER or k in ("dokumentart", "titel")},
                      ensure_ascii=False)[:MAX_BISHER]


def teil_hinweis(i: int, n: int, stand: _Stand) -> str | None:
    """Hinweis im Auftrag eines Teils: welcher Teil, was schon belegt ist (nicht wiederholen), was noch fehlt."""
    if n <= 1:
        return None
    text = f"Teil {i} von {n} des Dokuments (die Teile überlappen leicht)."
    if i > 1:
        offen = [f for f in BELEG_FELDER if f not in stand.werte]
        text += (" Aus den Teilen davor schon belegt (JSON, nicht wiederholen): "
                 + bisher_json(stand)
                 + (f". Noch unbekannt: {', '.join(offen)}." if offen else ".")
                 + " Für dokumentart, unterart, titel, zweck und schlagworte gib die vollständige, aktualisierte Fassung über"
                   " alles bisher Gelesene; für die Felder mit Beleg nur, was in DIESEM Teil steht.")
    return text


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
    # Das GANZE Dokument (Mischa 15.10.): in Teilen lesen; jeder Teil wird gegen SEINEN Text belegt (zz/v4).
    teile = text_teile(extrakt.text)
    stand = _Stand()
    dokument = bl.dokument_woerter(extrakt.text, dateiname, herkunft.replace("/", " "))
    roh_texte = f"{extrakt.text}\n{dateiname}"
    typ = typ_aus(None, k)
    modell = cfg.modell_text
    for i, teil_text in enumerate(teile, start=1):
        if i > 1 and vorrang is not None:
            vorrang()  # zwischen den Teilen: Wartende (Suche, Archiv-Frage, Beleg) haben Vorrang
        hinweis = teil_hinweis(i, len(teile), stand) or extrakt.hinweis
        ex = Extrakt(text=teil_text, mime=extrakt.mime, seiten=extrakt.seiten, ocr=extrakt.ocr, hinweis=hinweis)
        wissen = wi.relevante(k.wissen, teil_text, dateiname, herkunft)
        nutzer, num_ctx = prompt_fuer(k, ex, anzeige, cfg, mit_bild=False, foto=False, stufe2=False,
                                      system_zeichen=len(SYSTEM_ZZ), antwort_tokens=ANTWORT_TOKENS_ZZ,
                                      zusatz=wi.block(wissen), mit_heute=False, mit_mitarbeitern=False)
        roh_teil, meta = _chat(llm, modell=cfg.modell_text, system=SYSTEM_ZZ, nutzer=nutzer,
                               schema=schema_zz(typ_keys), num_ctx=num_ctx, num_predict=ANTWORT_TOKENS_ZZ)
        modell = str(meta.get("modell") or cfg.modell_text)
        typ_teil = typ_aus(roh_teil.get("typ"), k)
        if i == 1 or typ == "sonstiges":
            typ = typ_teil
        p = _Pruefung(teil=bl.Teil(i, teil_text), stand=stand, dokument=dokument, roh_texte=roh_texte, wissen=k.wissen)
        for f in BELEG_FELDER:
            p.wert(f, roh_teil)
        p.beteiligte(roh_teil)
        p.frei(roh_teil)
        stand.z["firmenwissen"] += len(wissen)
    # Typ aus der Beschreibung, gleich für beide Modelle (typ_normal) — vor Fakten und Rangliste, die ihn nutzen.
    typ_roh = typ
    typ = typ_normal(typ, stand.frei, typ_keys)
    if typ != typ_roh:
        stand.z["typ_angeglichen"] += 1
    beschrieb = beschrieb_aus(stand, typ=typ, typ_label=labels.get(typ, typ), seiten=seiten, ocr=ocr, endung=endung)
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
    for p_ in ([rz.ziel] if rz and rz.ziel else []) + (rz.bereich[:3] if rz else []) + rl.pfade(6):
        o = nfc(p_) if p_ else ""
        if o and o in erlaubt and not gesperrt(o) and o != ist and o not in kandidaten:
            kandidaten.append(o)
    dauer = int((time.monotonic() - start) * 1000)
    belege = belege_kennzahlen(stand.z)
    angegeben = sum(v["angegeben"] for v in belege.values())
    log.info("ZZ: Beschrieb %d Felder, %d Fakten, %d Kandidaten, belegt %d/%d Angaben (Stelle %d× vom Rig gefunden), "
             "%d Prompt-Kopien in %d ms", len(beschrieb), len(fakten), len(kandidaten),
             sum(v["belegt"] for v in belege.values()), angegeben, stand.z["beleg_vom_rig"], stand.z["prompt_kopie"], dauer)
    return ZzBefund(
        status="vorschlag", ordner_ist=ist, beschrieb=beschrieb, fakten=fakten, kandidaten=kandidaten[:MAX_KANDIDATEN],
        personenbezogen=bool(beschrieb.get("personenbezogen")) or was.personendokument, modell=modell, dauer_ms=dauer,
        regel_ziel=(rz.ziel if rz else None), belege=belege, zaehler=stand.z,
    )


def meldung(pfad: str, sha256: str, z: dict[str, Any]) -> dict[str, Any]:
    """Eintrag für POST /api/ki/nachtarbeit (§3.6, Liste «vorschlaege», art zz) aus einer gespeicherten Zeile."""
    return {
        "art": "zz", "pfad": nfc(pfad), "sha256": sha256, "ordner_ist": z["ordner_ist"], "rezept": REZEPT,
        "beschrieb": dict(z.get("beschrieb") or {}), "fakten": list(z.get("fakten") or [])[:MAX_FAKTEN],
        "kandidaten": list(z.get("kandidaten") or [])[:MAX_KANDIDATEN],
    }
