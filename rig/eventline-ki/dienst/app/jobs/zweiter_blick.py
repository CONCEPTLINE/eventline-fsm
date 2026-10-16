"""Zweiter Blick (16.10.2026, Mischa «ja messen» → ist das grosse Modell klar besser, übernimmt es nachts).

Messnacht 15./16.10. (probelauf/README.md): Gemma 4 26B (Instanz «gruendlich», nur Prozessor) schreibt klar bessere
Beschriebe als gemma3:4b — blind 36:2, Erfindungen vor dem Filter 16 % statt 32,7 %, erfundene Namen 1,7 % statt 21 %,
Fristen ohne Erfindungen —, ist aber ~20× langsamer (Median 112 s je Dokument, lange Dokumente bis 53 min). Darum:

- Nur als Job des Hauptmodells (hintergrund.py: Planer, Speicher-Tor, Wächter, Sperre 05:25–05:50 für den Selbsttest,
  Entladen um 06:45 und wenn nichts mehr ansteht) — nie ein Auftrag aus dem FSM, nie ein Wartender: der Sofort-Vorschlag
  bleibt beim schnellen Modell. Seit 16.10.2026 nachts UND tagsüber (Mischa: «falls nichts zu tun ist, soll sie arbeiten,
  wenn sie etwas hat»): tagsüber mit weniger Threads, niedrigem CPU-Gewicht und erst nach längerer Ruhe geladen
  (KI_HG_TAG, KI_HG_THREADS_TAG, KI_HG_RUHE_TAG_S; Messung README «Tagsüber arbeiten»).
- Für Dateien im Rückstau ZZ mit OFFENEM, UNENTSCHIEDENEM Vorschlag (Kontext des FSM: «offen» oder Beschrieb in der
  Warteschlange, nichts angenommen/korrigiert), deren Beschrieb des schnellen Modells mit dem aktuellen Rezept (zz/v4)
  schon im Tresor steht. Ablagen aus Upload und Mail-Eingang entscheidet ein Mensch beim Ablegen — dort gibt es keinen
  offenen Vorschlag.
- Höchstens KI_ZB_MAX_TEILE (5) Teile zu 10 000 Zeichen (0,5 % des Bestands sind länger: 9 Teile 33 min, 22 Teile 53 min)
  — längere bleiben beim schnellen Modell.
- Gleicher Live-Code-Pfad wie das schnelle Modell: jobs/zz.zz_beschreiben (Teile, Belegstellen, Sensibel-Filter, Fakten,
  Kandidaten, Typ aus der Beschreibung) und jobs/fristen.fristen_pruefen (Prüfung gegen Erfindung) — nur das Modell ist
  gewechselt (HauptmodellLlm: gestreamt und abbrechbar an «gruendlich», Optionen des Planers; Einbettungen wie live auf
  «schnell»). Zwischen den Teilen hat EVENTLINE Vorrang: läuft oder wartet ein Auftrag, läuft ein Index oder ist jemand
  in der Inhaltssuche, wird gewartet; ab dem Ende des Fensters bzw. in der Sperre wird abgebrochen (Schritt «pausiert»).
- Vergleich deterministisch mit dem Beschrieb des schnellen Modells (vergleiche): mehr belegte Felder, andere
  Dokumentart (Typ oder Wörter), andere Beteiligte oder ein anderer belegter Wert (Datum, Status, Bezug, Absender,
  Empfänger). Nur dann «anders» → Meldung ans FSM mit Rezept «zz/v4+zb» (Melder der Nachtarbeit); das FSM fragt Claude
  erneut und ersetzt den Vorschlag NUR, wenn er noch offen und nie entschieden ist (lib/ki/zz-warteschlange). Sonst
  «gleich» — nichts geht ans FSM.
- Fristen des 26B landen in archiv_fristen (UNIQUE pfad, art, bedingungen — Bekanntes zählt nicht doppelt); das FSM
  verwirft bekannte Daten ohnehin (frist_bekannt). Die Dokumentkarte (archiv_karte) bleibt die des schnellen Modells.
- Nur freigegebene Modelle (FREIGEGEBEN, seit 16.10.2026): gerechnet wird nur mit einem gemessenen Modell (heute das
  26B), nie mit dem 12B-Rückfall — Job.modelle sagt es dem Hintergrund (er lädt nur ein freigegebenes und entlädt ein
  anderes), ausfuehren() prüft es nochmals. Ein zweiter Blick zählt nur als ERLEDIGT, wenn ihn ein freigegebenes Modell
  gemacht hat (Spalte zweiter_blick.modell): Ergebnisse anderer Modelle gelten als nicht erledigt — die Nachtarbeit plant
  die Datei neu ein (ein fertiger Schritt wird wieder offen), solange ihr Vorschlag unentschieden ist. Hatte das FSM ein
  solches vorläufiges Ergebnis schon übernommen («anders», gemeldet, ok), wird das neue immer gemeldet (Grund
  «vorlaeufig»): der offene Vorschlag soll nie auf einem ungeprüften Beschrieb beruhen. Das FSM ersetzt ihn, weil der
  Beschrieb von einem anderen lokalen Modell stammt — nur, solange er offen und nie entschieden ist.

Nie Inhalte in Log, Protokoll oder Tabelle ausser dem gefilterten Beschrieb (geht ohnehin an Claude) — die Gründe sind
nur Schlüsselwörter.
"""

from __future__ import annotations

import dataclasses
import logging
import time
from dataclasses import dataclass
from typing import Any, Callable

from .. import belege as bl
from ..archiv import nfc, unter_zz
from ..config import Einstellungen
from ..llm import LlmAbgebrochen, Ollama
from ..planer import modell_in
from . import Job, JobFehler, Schritt, SchrittKontext
from . import fristen as fj
from . import zz as zj

log = logging.getLogger("ki.zweiter_blick")

ART = "zweiter_blick"
REZEPT_ZUSATZ = "+zb"
# Status der Tresor-Zeile: anders = gemeldet (bzw. im Puffer), gleich = nichts ans FSM, entschieden = Vorschlag inzwischen
# entschieden (nicht gerechnet), zu_lang = mehr als KI_ZB_MAX_TEILE Teile, ohne_vergleich = kein Beschrieb des schnellen
# Modells, veraltet = Datei/Text inzwischen anders.
STATUS = ("anders", "gleich", "entschieden", "zu_lang", "ohne_vergleich", "veraltet")
# vorlaeufig = ersetzt ein schon übernommenes Ergebnis eines nicht freigegebenen Modells (wird immer gemeldet).
GRUENDE = ("mehr_felder", "dokumentart", "beteiligte", "werte", "vorlaeufig")
# Für den zweiten Blick freigegeben (gemessen): Messnacht 15./16.10.2026, Gemma 4 26B gegen gemma3:4b blind 36:2,
# Erfindungen vor dem Filter 16 % statt 32,7 %. Das 12B (gemma4:12b-it-qat) ist nie gemessen und rechnet den zweiten
# Blick nie — auch nicht, wenn es in KI_HG_MODELLE oben stünde. Ein neues Modell kommt erst nach einer Messung hierher;
# Ergebnisse eines Modells, das hier fehlt, gelten als nicht erledigt.
FREIGEGEBEN: tuple[str, ...] = ("gemma4:26b-a4b-it-qat",)
# Zwischen den Teilen höchstens so lange auf Ruhe warten, dann weiter (der Schritt soll nicht ewig hängen).
WARTEN_MAX_S = 900.0
WARTEN_TAKT_S = 2.0
# Gestreamte Antwort: nie länger als das (je Aufruf; der ganze Schritt hat KI_ZB_SCHRITT_MAX_S).
AUFRUF_MAX_S = 900.0
UNENTSCHIEDEN = ("offen", "beschrieb_wartet", "beschrieb_in_arbeit")
ENTSCHIEDEN = ("angenommen", "korrigiert")


def rezept() -> str:
    """Rezept der Meldung: das Rezept des Beschriebs plus «+zb» (≤ 20 Zeichen wie im FSM)."""
    return zj.REZEPT + REZEPT_ZUSATZ


def freigegeben(modell: str | None) -> bool:
    """Darf dieses Modell den zweiten Blick rechnen — und zählt sein Ergebnis als erledigt?"""
    return modell_in(modell, FREIGEGEBEN)


def schluessel(pfad: str, sha256: str) -> str:
    """Schlüssel in hg_auftraege: «<sha256>:<pfad>» (sha256 hat feste 64 Zeichen, der Pfad darf «:» enthalten)."""
    return f"{sha256}:{nfc(pfad)}"


def aus_schluessel(s: str) -> tuple[str, str]:
    if len(s) < 66 or s[64] != ":":
        raise JobFehler("Schlüssel ungültig")
    return s[65:], s[:64]


# --- Kontext des FSM: ist der Vorschlag noch offen und unentschieden? ----------------------------------------------


def unentschiedene(daten: dict[str, Any]) -> set[str]:
    """Pfade (NFC) im Rückstau ZZ mit offenem Vorschlag oder Beschrieb in der Warteschlange und ohne Entscheid, nach
    dem die Verschiebung aussteht (angenommen/korrigiert). Ein früher abgelehnter Vorschlag zählt nicht, wenn wieder
    einer offen ist."""
    offen: set[str] = set()
    weg: set[str] = set()
    for v in daten.get("vorschlaege_bekannt") or []:
        if not (isinstance(v, dict) and v.get("art") == "zz" and isinstance(v.get("pfad"), str)):
            continue
        p = nfc(v["pfad"])
        status = str(v.get("status") or "")
        if status in UNENTSCHIEDEN:
            offen.add(p)
        elif status in ENTSCHIEDEN:
            weg.add(p)
    return offen - weg


# --- Vergleich (deterministisch) -------------------------------------------------------------------------------------


def belegte_felder(b: dict[str, Any]) -> int:
    """Felder mit belegtem Wert (Datum, Zeitraum, Status, Bezug, Absender, Empfänger) plus Beteiligte als ein Feld."""
    return sum(1 for f in zj.BELEG_FELDER if b.get(f)) + (1 if b.get("beteiligte") else 0)


def _woerter(s: object) -> set[str]:
    return {w for w in bl.woerter(str(s or "")) if len(w) >= 3}


def _ueberlapp(a: set[str], b: set[str]) -> bool:
    """Ein gemeinsames Wort — auch als Teil eines zusammengesetzten («Mietvertrag» ~ «Vertrag», ab 4 Zeichen)."""
    return any(x == y or (len(x) >= 4 and x in y) or (len(y) >= 4 and y in x) for x in a for y in b)


def _namen_gleich(a: list[dict[str, Any]], b: list[dict[str, Any]]) -> bool:
    na = [str(x.get("name") or "") for x in a if isinstance(x, dict) and x.get("name")]
    nb = [str(x.get("name") or "") for x in b if isinstance(x, dict) and x.get("name")]
    return (all(any(zj._gleicher_name(x, y) for y in nb) for x in na)  # noqa: SLF001
            and all(any(zj._gleicher_name(y, x) for x in na) for y in nb))  # noqa: SLF001


def vergleiche(alt: dict[str, Any], neu: dict[str, Any]) -> list[str]:
    """Gründe, warum der Beschrieb des Hauptmodells (neu) inhaltlich anders oder vollständiger ist als der des schnellen
    Modells (alt) — leer = gleich. Nur Schlüsselwörter (GRUENDE)."""
    gruende: list[str] = []
    if belegte_felder(neu) > belegte_felder(alt):
        gruende.append("mehr_felder")
    art_alt, art_neu = _woerter(alt.get("dokumentart")), _woerter(neu.get("dokumentart"))
    if alt.get("typ") != neu.get("typ") or (art_alt and art_neu and not _ueberlapp(art_alt, art_neu)):
        gruende.append("dokumentart")
    if not _namen_gleich(alt.get("beteiligte") or [], neu.get("beteiligte") or []):
        gruende.append("beteiligte")
    for f in ("datum", "status"):
        if alt.get(f) and neu.get(f) and alt[f] != neu[f]:
            gruende.append("werte")
            break
    else:
        for f in ("bezug", "absender", "empfaenger"):
            if alt.get(f) and neu.get(f) and not _ueberlapp(_woerter(alt[f]), _woerter(neu[f])):
                gruende.append("werte")
                break
    return gruende


# --- Sprachmodell: das Hauptmodell im Live-Code ----------------------------------------------------------------------


class HauptmodellLlm:
    """Stellt zz_beschreiben/fristen_pruefen (rufen llm.chat_json) das Hauptmodell hin: derselbe Prompt, dasselbe Schema,
    gestreamt an «gruendlich» mit den Optionen des Planers (num_ctx, num_thread, use_mmap, num_gpu — gleich bei jedem
    Aufruf, sonst lädt Ollama neu), abbrechbar über das Abbruch-Event des Wächters. Einbettungen (Vorbilder für die
    Fakten-Hinweise) und die VRAM-Verwaltung bleiben wie live auf der schnellen Instanz."""

    def __init__(self, ctx: SchrittKontext, schnell: Ollama) -> None:
        self.ctx = ctx
        self.schnell = schnell
        self.aufrufe = 0
        self.antwort_tokens = 0

    def chat_json(self, *, modell: str, system: str, nutzer: str, schema: dict[str, Any], num_ctx: int,
                  bilder: list[str] | None = None, num_predict: int = 1024, timeout_s: float | None = None,
                  optionen: dict[str, Any] | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
        del modell, num_ctx, bilder, timeout_s  # Modell und Fenster des Planers; Bilder gibt es hier nicht
        frist = max(1.0, min(AUFRUF_MAX_S, self.ctx.frist - time.monotonic()))
        ctx = dataclasses.replace(self.ctx, frist=time.monotonic() + frist)
        daten, meta = ctx.chat_json(system=system, nutzer=nutzer, schema=schema, think=False,
                                    optionen={"num_predict": num_predict, **(optionen or {})})
        self.aufrufe += 1
        self.antwort_tokens += int(meta.get("antwort_tokens") or 0)
        return daten, {**meta, "modell": self.ctx.modell, "num_ctx": self.ctx.optionen.get("num_ctx")}

    def einbetten(self, **kw: Any) -> Any:
        return self.schnell.einbetten(**kw)

    def geladene_modelle(self) -> list[dict[str, Any]]:
        return self.schnell.geladene_modelle()

    def entlade(self, modell: str | None = None) -> bool:
        return self.schnell.entlade(modell)


# --- Der Job --------------------------------------------------------------------------------------------------------


@dataclass
class ZbAbhaengigkeiten:
    cfg: Einstellungen
    speicher: Any            # nachtarbeit.NachtSpeicher (Tresor)
    kontext: Any             # nachtarbeit.KontextQuelle (zuletzt geholter Kontext des FSM)
    archiv: Any              # archiv.ArchivIndex (Vorbilder)
    schnell: Ollama          # schnelle Instanz für Einbettungen
    frei: Callable[[], bool]  # kein Auftrag läuft/wartet, kein Index, niemand in der Suche
    darf: Callable[[], str | None]  # None = weiter; sonst Grund (fenster, sperre) → Schritt abbrechen
    uhr_fenster: Callable[[], str] = lambda: ""


def _warte(d: ZbAbhaengigkeiten, ctx: SchrittKontext) -> None:
    """Vor jedem Teil: Fensterende/Sperre → abbrechen; solange EVENTLINE arbeitet, warten (höchstens WARTEN_MAX_S)."""
    start = time.monotonic()
    while True:
        if ctx.abbruch.is_set():
            raise LlmAbgebrochen("abbruch")
        grund = d.darf()
        if grund:
            raise LlmAbgebrochen(grund)
        if d.frei() or time.monotonic() - start >= WARTEN_MAX_S:
            return
        time.sleep(WARTEN_TAKT_S)


def ausfuehren(d: ZbAbhaengigkeiten, schritt: Schritt, ctx: SchrittKontext) -> dict[str, Any]:
    """Ein Dokument. Liefert Metadaten fürs Protokoll (nur Zahlen); LlmAbgebrochen/LlmFehler gehen an den Hintergrund."""
    # Nur ein freigegebenes Modell (Job.modelle; der Hintergrund lädt dafür kein anderes) — hier nochmals geprüft: mit
    # einem anderen wird nichts gerechnet, der Schritt bleibt offen.
    if not freigegeben(ctx.modell):
        raise LlmAbgebrochen("nicht_freigegeben")
    pfad, sha = aus_schluessel(schritt.schluessel)
    rez = schritt.rezept
    vorher = d.speicher.zb_stand(pfad, sha, rez)
    if vorher is not None and freigegeben(vorher.modell):
        # Schon von einem freigegebenen Modell erledigt (z. B. ein doppelt eingeplanter Schritt): nichts rechnen.
        return {"status": "erledigt"}
    # Hat das FSM ein Ergebnis eines nicht freigegebenen Modells übernommen, beruht sein offener Vorschlag darauf — das
    # neue Ergebnis geht dann immer ans FSM (Grund «vorlaeufig»), auch wenn es dem schnellen Modell gleicht.
    vorlaeufig = vorher is not None and vorher.status == "anders" and vorher.gemeldet and vorher.ergebnis == "ok"
    lauf_id = (d.uhr_fenster() or "").replace("/", "-") + "-zb"
    zeile = d.speicher.text_zeile(pfad, sha)
    if zeile is None:
        d.speicher.speichere_zb(pfad, sha, rez, ctx.modell, "veraltet", lauf_id=lauf_id)
        return {"status": "veraltet"}
    # Kontext höchstens KI_KONTEXT_MAX_ALTER_S alt (sonst neu vom FSM); ist das FSM gerade weg, gilt der letzte — ob der
    # Vorschlag noch offen ist, prüft das FSM beim Ersetzen ohnehin nochmals.
    k = d.kontext.aktuell() or d.kontext.zuletzt
    if k is None:
        raise JobFehler("kein Kontext vom FSM")
    if nfc(pfad) not in unentschiedene(k.daten):
        d.speicher.speichere_zb(pfad, sha, rez, ctx.modell, "entschieden", lauf_id=lauf_id)
        return {"status": "entschieden"}
    alt = d.speicher.zz_beschrieb(pfad, sha, zj.REZEPT)
    if not alt and not vorlaeufig:
        d.speicher.speichere_zb(pfad, sha, rez, ctx.modell, "ohne_vergleich", lauf_id=lauf_id)
        return {"status": "ohne_vergleich"}
    text = d.speicher.text(pfad, sha)
    if text is None:
        d.speicher.speichere_zb(pfad, sha, rez, ctx.modell, "veraltet", lauf_id=lauf_id)
        return {"status": "veraltet"}
    teile = len(zj.text_teile(text))
    kennzahlen: dict[str, Any] = {"seiten": zeile.seiten, "zeichen": zeile.zeichen, "gescannt": bool(zeile.ocr),
                                  "teile": teile}
    if teile > d.cfg.zb_max_teile:
        d.speicher.speichere_zb(pfad, sha, rez, ctx.modell, "zu_lang", teile=teile, lauf_id=lauf_id)
        return {"status": "zu_lang"}
    llm = HauptmodellLlm(ctx, d.schnell)
    cfg = dataclasses.replace(d.cfg, modell_text=ctx.modell)
    start = time.monotonic()
    _warte(d, ctx)
    befund = zj.zz_beschreiben(pfad=pfad, dateiname=zeile.name, sha256=sha, text=text, seiten=zeile.seiten,
                               ocr=zeile.ocr, kontext_roh=k.daten, llm=llm,  # type: ignore[arg-type]
                               cfg=cfg, archiv=d.archiv, vorrang=lambda: _warte(d, ctx))
    if befund.status != "vorschlag" or not befund.beschrieb:
        raise JobFehler(f"Beschrieb ohne Ergebnis ({befund.grund or befund.status})")
    fristen_roh = fristen_neu = 0
    if fj.vorfilter(text):
        _warte(d, ctx)
        fb = fj.fristen_pruefen(pfad=pfad, dateiname=zeile.name, text=text, ocr=zeile.ocr,
                                kontext_roh=k.daten, llm=llm, cfg=cfg,  # type: ignore[arg-type]
                                vorrang=lambda: _warte(d, ctx))
        fristen_roh = int(fb.zaehler.get("roh", 0))
        if fb.fristen:
            fristen_neu = d.speicher.speichere_fristen(pfad, sha, fb, lauf_id)
        belege_f = fj.belege_kennzahlen(fb.zaehler)
    else:
        belege_f = {}
    gruende = (vergleiche(alt, befund.beschrieb) if alt else []) + (["vorlaeufig"] if vorlaeufig else [])
    status = "anders" if gruende else "gleich"
    dauer = int((time.monotonic() - start) * 1000)
    d.speicher.speichere_zb(pfad, sha, rez, ctx.modell, status, gruende=gruende, befund=befund, teile=teile,
                            dauer_ms=dauer, fristen_roh=fristen_roh, fristen_neu=fristen_neu, lauf_id=lauf_id)
    log.info("Zweiter Blick: %s (%s), %d Teile, %d Aufrufe, %d Antwort-Tokens, Fristen roh %d / neu %d, %d ms",
             status, ",".join(gruende) or "-", teile, llm.aufrufe, llm.antwort_tokens, fristen_roh, fristen_neu, dauer)
    belege = {**befund.belege, **belege_f}
    return {"status": status, "antwort_tokens": llm.antwort_tokens,
            "kennzahlen": {**kennzahlen, **({"belege": belege} if belege else {})}}


def job(d: ZbAbhaengigkeiten) -> Job:
    """Job-Art «zweiter_blick» für den Hintergrund (nachts und tagsüber, eigener Schalter, eigene Schrittdauer). Ob
    tagsüber gerechnet wird, entscheidet der Planer (KI_HG_TAG)."""
    return Job(ART, lambda s, ctx: ausfuehren(d, s, ctx), lambda cfg: cfg.job_zweiter_blick and cfg.hg_aktiv,
               modi=("nacht", "tag"), max_s=d.cfg.zb_schritt_max_s, modelle=FREIGEGEBEN)


# --- Planen (Nachtarbeit, wenn das schnelle Modell fertig ist) ---------------------------------------------------------


def kandidaten(zeilen: list[tuple[str, str, int, int]], daten: dict[str, Any], max_teile: int) -> tuple[list[tuple[str, str]], int]:
    """Aus (pfad, sha256, teile, zeichen) der Dateien mit Beschrieb des schnellen Modells und ohne erledigten zweiten Blick
    (keiner eines freigegebenen Modells): die mit unentschiedenem Vorschlag, kurze zuerst (mehr Dokumente je Nacht).
    Liefert (Liste, Anzahl zu lang)."""
    offen = unentschiedene(daten)
    aus: list[tuple[int, int, str, str]] = []
    zu_lang = 0
    for pfad, sha, teile, zeichen in zeilen:
        if not unter_zz(zj.ordner_von(pfad)) or nfc(pfad) not in offen:
            continue
        if teile > max_teile:
            zu_lang += 1
            continue
        aus.append((teile, zeichen, pfad, sha))
    aus.sort()
    return [(p, s) for _, _, p, s in aus], zu_lang
