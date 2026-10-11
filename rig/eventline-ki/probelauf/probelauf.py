"""Probelauf — Trefferquote der Ablage-KI gegen das sortierte NAS (SPEC §6), live-nah.

Nimmt je Ordner bis zu N Dateien unter /mnt/eventline-nas/<Freigabe> (ohne 99_System, ZZ_* und
versteckte Ordner), lässt die echte ablage_analyse-Pipeline laufen (Text/OCR → Einbettung → Archiv-
Index → Stufe 1 → Rangliste → Stufe 2, Ollama direkt, ohne FSM) und vergleicht den vorgeschlagenen
Ordner mit dem Ordner, in dem die Datei tatsächlich liegt.

Live-nah heisst: Ordnerliste aller aktiven Freigaben als Kontext (--ordner-von /mnt/eventline-nas,
Standard; oder die echte FSM-Liste per --ordner-datei) und Leave-one-out — die Testdatei selbst, jede
Datei mit gleichem sha256 UND (seit Review 2026-10-11, Standard) ihre Fast-Zwillinge im Zielordner
(Kosinus > --zwillinge-schwelle 0,95 oder gleicher Namensstamm: docx+pdf derselben Datei, Versionen)
sind beim Messen kein Vorbild im Archiv-Index. --zwillinge-behalten misst wie vor dem Review.

Relativierung «live-nah»: gemessen wird mit den einsortierten Dateinamen (--dateiname-neutral ersetzt
sie durch «dokument.<endung>» wie bei einem Rohupload) und mit der Ordnerliste des NAS (424 Pfade), nicht
der FSM-Liste (aktive Ordner nach Vererbung) — ausser mit --ordner-datei (dann kommen auch die Testdateien nur aus
Ordnern dieser Liste). Der Kontext trägt wie im FSM das Flag `person` je Dokumenttyp; die Modell-Zähler stehen im
Report zusätzlich je Stufe (Review V8: V8 verlängert nur Stufe 1).

Der Report (report.json + report.md unter <KI_DATA_DIR>/probelauf/<Zeit>/) enthält Kennzahlen je
Freigabe und je Ordner — keine Dateinamen, keine Inhalte. Auf der Konsole erscheinen nur Kennzahlen
je Freigabe und gesamt.

V8 (2026-10-11): --export <datei> schreibt je Testdatei eine JSON-Zeile mit dem, was das FSM für den
Claude-Entscheid bekäme — { freigabe, soll (Ordner, in dem die Datei liegt), variante ("einsortiert" |
"neutral"), einordnung (minimiert), kandidaten, regel_ordner, lokal: { ordner, alternativen }, ms } —
NIE Beschrieb, Zusammenfassung, Text, Dateiname oder Pfad der Testdatei. --namen-alle-datei liefert dazu
die Profilnamen (kontext.namen_alle, nur für die Minimierung; die Mitarbeiterliste bleibt davon unberührt).

Aufruf im Dienst-Container (Ollama und DB sind nur von dort erreichbar):
  docker compose --env-file /etc/eventline-ki/env -f …/docker-compose.yml exec dienst \\
    python /probelauf/probelauf.py --freigabe 02_LOCATIONS 03_PROJEKTE_EVENTS --je-ordner 5 --max-dateien 80
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import logging
import random
import statistics
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

PERSON_TYPEN_FSM = frozenset({"lohnabrechnung", "behoerde", "zertifikat"})  # = KI_PERSON_TYPEN im FSM
ENDUNGEN = {".pdf", ".docx", ".xlsx", ".txt", ".csv", ".md", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}
QUELLEN = ("regel", "ki", "ki_keiner", "rangliste", "keine")


def ausgeschlossen(name: str) -> bool:
    """Wie app.archiv.ausgeschlossen: versteckte Einträge, 99_System und ZZ_* auf jeder Tiefe."""
    if name.startswith((".", "@", "#", "~$")):
        return True
    return name == "99_System" or name.upper().startswith("ZZ_")


def ordner_liste(basis: Path) -> list[str]:
    """Alle Ordnerpfade relativ zur Basis (NAS-Wurzel: Freigaben eingeschlossen) — ohne ZZ_*/99_System/versteckte.
    Anders als die FSM-Liste (aktive Ordner, Vererbung) — die kommt per --ordner-datei."""
    aus: list[str] = []

    def gehe(ordner: Path, rel: str) -> None:
        try:
            eintraege = sorted(ordner.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            return
        for e in eintraege:
            if not e.is_dir() or ausgeschlossen(e.name):
                continue
            pfad = f"{rel}/{e.name}" if rel else e.name
            aus.append(pfad)
            gehe(e, pfad)

    gehe(basis, "")
    return aus


def lese_ordner_datei(pfad: Path) -> list[str]:
    """FSM-Ordnerliste: JSON ({"ordner": [...]} oder Liste) oder Text, ein Pfad je Zeile."""
    roh = pfad.read_text(encoding="utf-8")
    try:
        daten = json.loads(roh)
    except ValueError:
        return [z.strip() for z in roh.splitlines() if z.strip() and not z.lstrip().startswith("#")]
    if isinstance(daten, dict):
        daten = daten.get("ordner")
    if not isinstance(daten, list):
        raise SystemExit(f"{pfad}: keine Ordnerliste (JSON-Liste, {{\"ordner\": [...]}} oder Text je Zeile erwartet)")
    return [str(o).strip() for o in daten if str(o).strip()]


def dateien_je_ordner(basis: Path, ordner: list[str], je_ordner: int, zufall: random.Random, nur: str | None) -> dict[str, list[Path]]:
    auswahl: dict[str, list[Path]] = {}
    for rel in ordner:
        if nur and not rel.startswith(nur):
            continue
        try:
            kandidaten = [p for p in (basis / rel).iterdir() if p.is_file() and p.suffix.lower() in ENDUNGEN and not p.name.startswith((".", "~$"))]
        except OSError:
            continue
        if not kandidaten:
            continue
        kandidaten.sort(key=lambda p: p.name.lower())
        zufall.shuffle(kandidaten)
        auswahl[rel] = kandidaten[:je_ordner]
    return auswahl


def sha256_von(pfad: Path) -> str:
    h = hashlib.sha256()
    with open(pfad, "rb") as f:
        for teil in iter(lambda: f.read(1 << 20), b""):
            h.update(teil)
    return h.hexdigest()


def lese_mitarbeiter(args: argparse.Namespace) -> list[str]:
    namen: list[str] = []
    if args.mitarbeiter:
        namen += [n.strip() for n in args.mitarbeiter.split(",") if n.strip()]
    if args.mitarbeiter_datei:
        namen += [z.strip() for z in Path(args.mitarbeiter_datei).read_text(encoding="utf-8").splitlines() if z.strip()]
    return sorted(set(namen))


def _median(werte: list[int]) -> int | None:
    return int(statistics.median(werte)) if werte else None


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Probelauf der Ablage-KI gegen das sortierte NAS (live-nah)")
    p.add_argument("--freigabe", nargs="+", help="eine oder mehrere NAS-Freigaben unter --ordner-von")
    p.add_argument("--je-ordner", type=int, default=3)
    p.add_argument("--max-dateien", type=int, default=200, help="höchstens so viele Dateien je Freigabe")
    p.add_argument("--nur", help="nur Ordner mit diesem Präfix (relativ zur Freigabe)")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--mitarbeiter", help="kommagetrennte volle Namen (wie im FSM)")
    p.add_argument("--mitarbeiter-datei", help="Textdatei, ein voller Name je Zeile")
    p.add_argument("--ausgabe", help="Zielordner für report.json/report.md (Standard: <KI_DATA_DIR>/probelauf/<Zeit>)")
    p.add_argument("--app-pfad", default="/srv/app", help="Ort des Pakets «app» (im Container /srv/app)")
    p.add_argument("--ausfuehrlich", action="store_true", help="relative Pfade je Datei auf der Konsole zeigen (nie im Report)")
    p.add_argument(
        "--ordner-von", default="/mnt/eventline-nas",
        help="Ordnerliste aus dieser Wurzel (Standard: alle Freigaben, wie das FSM sie schickt); Dateien aus --freigabe",
    )
    p.add_argument("--modell", help="Sprachmodell für Texte statt KI_MODELL_TEXT (z. B. qwen3:8b)")
    p.add_argument("--ohne-archiv", action="store_true", help="ohne Archiv-Index (nur Regeln + Ordnernamen)")
    p.add_argument("--index-aufbauen", action="store_true", help="vorher einen Indexlauf über das NAS (Dauer im Report)")
    p.add_argument(
        "--dateiname-neutral", action="store_true",
        help="statt des einsortierten Namens «dokument.<endung>» übergeben (wie ein frischer Upload mit Rohnamen)",
    )
    p.add_argument(
        "--zwillinge-schwelle", type=float, default=0.95,
        help="Vorbilder im Zielordner mit Kosinus über dieser Schwelle (oder gleichem Namensstamm) sind kein Vorbild (Standard 0,95)",
    )
    p.add_argument("--zwillinge-behalten", action="store_true", help="Zwillinge nicht ausschliessen (Messung wie vor dem Review 2026-10-11)")
    p.add_argument(
        "--ordner-datei",
        help="Ordnerliste aus dieser Datei statt aus --ordner-von (FSM-Liste: der Dienst merkt sie unter <KI_DATA_DIR>/fsm-ordnerliste.json)",
    )
    p.add_argument(
        "--export",
        help="V8: JSONL je Testdatei (Einordnung, Kandidaten, regel_ordner, lokale Wahl, Soll-Ordner) — nie Text/Dateiname",
    )
    p.add_argument("--namen-alle-datei", help="V8: Profilnamen für kontext.namen_alle (ein voller Name je Zeile, nur Minimierung)")
    args = p.parse_args(argv)
    if not args.freigabe:
        p.error("--freigabe angeben")

    sys.path.insert(0, args.app_pfad)
    # pypdf meldet kaputte PDF-Strukturen als Warnung — für den Bericht nur Rauschen.
    logging.getLogger("pypdf").setLevel(logging.ERROR)
    from app.archiv import ArchivIndex, Indexierer, lesbarer_name, nfc, rezept_fuer  # noqa: E402
    from app.config import EINSTELLUNGEN  # noqa: E402
    from app.handlers import VerarbeitungsFehler  # noqa: E402
    from app.handlers.ablage import (  # noqa: E402
        ANTWORT_TOKENS_STUFE2,
        DOK_TYPEN_STANDARD,
        ZwillingsAusschluss,
        ablage_analyse,
        heute_zuerich,
    )
    from app.llm import Ollama  # noqa: E402

    cfg = dataclasses.replace(EINSTELLUNGEN, modell_text=args.modell) if args.modell else EINSTELLUNGEN

    class MessOllama(Ollama):
        """Merkt sich die Zähler jedes Modellaufrufs (Tokens, Fenster, Ladezeit) — keine Inhalte. Die Stufe
        (1 = Beschrieb/Typ/Einordnung, 2 = Kandidaten-Entscheid) kommt aus num_predict (Stufe 2 hat ein eigenes)."""

        metas: list[dict] = []

        def chat_json(self, **kw):  # type: ignore[override]
            roh, meta = super().chat_json(**kw)
            self.metas.append({**meta, "stufe": 2 if kw.get("num_predict") == ANTWORT_TOKENS_STUFE2 else 1})
            return roh, meta

    wurzel = Path(args.ordner_von)
    if not wurzel.is_dir():
        print(f"{wurzel} ist kein Ordner (NAS gemountet?)", file=sys.stderr)
        return 1
    llm = MessOllama(cfg)
    ollama_version = llm.version()
    if ollama_version is None:
        print(f"Ollama unter {cfg.ollama_url} nicht erreichbar — im Dienst-Container ausführen", file=sys.stderr)
        return 1
    archiv = None if args.ohne_archiv else ArchivIndex(cfg.pg_dsn, rezept_fuer(cfg))
    index_lauf = None
    if archiv is not None and args.index_aufbauen:
        bilanz = Indexierer(cfg, archiv, llm, lambda: True, wurzel=wurzel).lauf()
        index_lauf = dataclasses.asdict(bilanz)
        print(f"Indexlauf: {bilanz.geprueft} geprüft, {bilanz.neu} eingebettet, {bilanz.uebernommen} übernommen, "
              f"{bilanz.unveraendert} unverändert, {bilanz.ohne_text} ohne Text, {bilanz.ocr} OCR, {bilanz.fehler} Fehler, "
              f"{bilanz.gesamt_s:.0f} s (Text {bilanz.extraktion_s:.0f} s, Einbettung {bilanz.einbettung_s:.0f} s)")
    index_eintraege = archiv.anzahl() if archiv is not None else 0

    # Dateiauswahl immer aus den NAS-Ordnern (dort liegen die Dateien); die Ordnerliste im Kontext wahlweise
    # aus dem NAS (wie bisher) oder aus der FSM-Liste (--ordner-datei: aktive Ordner, Vererbung angewandt).
    nas_ordner = ordner_liste(wurzel)
    if args.ordner_datei:
        ordner = lese_ordner_datei(Path(args.ordner_datei))
        ordner_quelle = f"FSM-Liste aus Datei ({Path(args.ordner_datei).name})"
    else:
        ordner = nas_ordner
        ordner_quelle = f"NAS-Ordner unter {wurzel}"
    ordner_nfc = {nfc(o) for o in ordner}
    zwillinge_aus = not args.zwillinge_behalten
    mitarbeiter = lese_mitarbeiter(args)
    namen_alle: list[str] = []
    if args.namen_alle_datei:
        namen_alle = sorted({z.strip() for z in Path(args.namen_alle_datei).read_text(encoding="utf-8").splitlines() if z.strip()})
    kontext = {
        "heute": heute_zuerich(),
        "ordner": ordner,
        # Wie das FSM (route.ts): Flag `person` je Typ = KI_PERSON_TYPEN — ohne Flag setzt das Rig bei jedem Typ eine
        # Person, also nicht produktionsgleich (Review V8: Arbeitsvertrag = Typ «vertrag» ohne Person).
        "dok_typen": [{"key": k, "label": l, "person": k in PERSON_TYPEN_FSM} for k, l in DOK_TYPEN_STANDARD],
        "mitarbeiter": mitarbeiter,
        "namen_alle": namen_alle,
    }
    ordner_original = {}
    for o in ordner:
        ordner_original.setdefault(nfc(o), o)
    variante = "neutral" if args.dateiname_neutral else "einsortiert"
    export = None
    if args.export:
        Path(args.export).parent.mkdir(parents=True, exist_ok=True)
        export = open(args.export, "w", encoding="utf-8")  # noqa: SIM115 — bleibt den ganzen Lauf offen

    def exportiere(zeile: dict) -> None:
        if export is not None:
            export.write(json.dumps(zeile, ensure_ascii=False) + "\n")
            export.flush()
    print(f"Ordnerliste: {len(ordner)} Pfade ({ordner_quelle}) · Archiv-Index: {index_eintraege} Vorbilder · "
          f"Modell {cfg.modell_text} (Bild {cfg.modell_bild}, Einbettung {cfg.modell_embed}) · "
          f"Zwillinge {'ausgeschlossen (Kosinus > ' + str(args.zwillinge_schwelle) + ' oder gleicher Namensstamm)' if zwillinge_aus else 'behalten'}"
          f"{' · Dateiname neutral' if args.dateiname_neutral else ''}")

    freigaben: dict[str, dict] = {}
    je_ordner: dict[str, dict[str, object]] = defaultdict(lambda: {"dateien": 0, "top1": 0, "top3": 0, "kategorie": 0, "leer": 0, "fehler": 0, "zwillinge": 0})
    typen: Counter[str] = Counter()
    fehlerarten: Counter[str] = Counter()
    alle_dauern: list[int] = []
    laufzeit_start = time.monotonic()
    nr_gesamt = 0

    for fg in args.freigabe:
        basis = wurzel / fg
        if not basis.is_dir():
            print(f"Freigabe {fg} fehlt — übersprungen", file=sys.stderr)
            continue
        praefix = fg + "/"
        eigene = [o[len(praefix):] for o in nas_ordner if o.startswith(praefix)]
        if args.ordner_datei:
            # FSM-Liste: Testdateien nur aus Ordnern, die das FSM anbietet (aktiv, Vererbung) — sonst gibt es kein Soll.
            eigene = [o for o in eigene if nfc(praefix + o) in ordner_nfc]
        # Gleiche Auswahl wie früher je Freigabe: eigener Zufallsgenerator mit dem Seed.
        auswahl = dateien_je_ordner(basis, eigene, args.je_ordner, random.Random(args.seed), args.nur)
        geplant = min(args.max_dateien, sum(len(v) for v in auswahl.values()))
        z: Counter[str] = Counter()
        dauern: list[int] = []
        nr = 0
        for rel, dateien in auswahl.items():
            for pfad in dateien:
                if nr >= args.max_dateien:
                    break
                nr += 1
                nr_gesamt += 1
                schluessel = f"{fg}/{rel}"
                eintrag = je_ordner[schluessel]
                eintrag["dateien"] = int(eintrag["dateien"]) + 1
                z["dateien"] += 1
                if args.ausfuehrlich:
                    print(f"[{fg} {nr}/{geplant}] {rel}/{pfad.name}")
                elif nr % 10 == 0 or nr == geplant:
                    print(f"[{fg} {nr}/{geplant}]", flush=True)
                ziel = nfc(schluessel)
                if ziel not in ordner_nfc:
                    # Zielordner steht nicht in der Ordnerliste (FSM: inaktiv/vererbt inaktiv) — kein Treffer möglich.
                    z["ziel_nicht_in_liste"] += 1
                    continue
                sha = sha256_von(pfad)
                endung = pfad.suffix.lower()
                dateiname = f"dokument{endung}" if args.dateiname_neutral else pfad.name
                zwillinge = (
                    ZwillingsAusschluss(ordner=ziel, schwelle=args.zwillinge_schwelle, namensstamm=lesbarer_name(pfad.name).lower())
                    if zwillinge_aus else None
                )
                messung: dict = {}
                t0 = time.monotonic()
                try:
                    erg = ablage_analyse(
                        pfad=pfad, dateiname=dateiname, mime=None, sha256=sha, kontext_roh=kontext, llm=llm, cfg=cfg,
                        archiv=archiv, ohne_vorbilder=([nfc(f"{fg}/{rel}/{pfad.name}")], [sha]), messung=messung,
                        zwillinge=zwillinge,
                    )
                except VerarbeitungsFehler as e:
                    z["fehler"] += 1
                    eintrag["fehler"] = int(eintrag["fehler"]) + 1
                    fehlerarten[str(e)[:60]] += 1
                    exportiere({"freigabe": fg, "soll": ordner_original.get(ziel, ziel), "variante": variante, "fehler": True,
                                "ms": int((time.monotonic() - t0) * 1000)})
                    continue
                except Exception as e:  # noqa: BLE001 — Lauf geht weiter, Art wird gezählt
                    z["fehler"] += 1
                    eintrag["fehler"] = int(eintrag["fehler"]) + 1
                    fehlerarten[f"Unerwartet: {type(e).__name__}"] += 1
                    exportiere({"freigabe": fg, "soll": ordner_original.get(ziel, ziel), "variante": variante, "fehler": True,
                                "ms": int((time.monotonic() - t0) * 1000)})
                    continue
                dauer = int((time.monotonic() - t0) * 1000)
                # V8-Export: nur Einordnung (minimiert), Kandidaten, Regel, lokale Wahl, Soll-Ordner — nie Text/Dateiname.
                exportiere({
                    "freigabe": fg,
                    "soll": ordner_original.get(ziel, ziel),
                    "variante": variante,
                    "einordnung": erg.get("einordnung"),
                    "kandidaten": erg.get("kandidaten") or [],
                    "regel_ordner": erg.get("regel_ordner"),
                    "lokal": {"ordner": erg.get("ordner"), "alternativen": erg.get("ordner_alternativen") or []},
                    "ms": dauer,
                })
                ein = erg.get("einordnung") or {}
                v8_kand = [nfc(c["pfad"]) for c in erg.get("kandidaten") or []]
                z["v8_mit_einordnung"] += bool(ein.get("was"))
                z["v8_personenbezogen"] += ein.get("personenbezogen") is True
                z["v8_profilname"] += any("[Mitarbeiter/in]" in str(ein.get(f) or "") for f in ("was", "betreff"))
                z["v8_partei"] += bool(ein.get("partei"))
                z["v8_bezug_art"] += bool((ein.get("bezug") or {}).get("art"))
                z["v8_jahr"] += bool(ein.get("jahr"))
                z["v8_sprache"] += bool(ein.get("sprache"))
                z["v8_kandidaten_summe"] += len(v8_kand)
                z["v8_ziel_in_kandidaten"] += ziel in v8_kand
                z["v8_ziel_kandidat1"] += bool(v8_kand) and v8_kand[0] == ziel
                z["v8_regel_ordner"] += bool(erg.get("regel_ordner"))
                z["v8_regel_ordner_richtig"] += bool(erg.get("regel_ordner")) and nfc(erg["regel_ordner"]) == ziel
                dauern.append(dauer)
                alle_dauern.append(dauer)
                typen[str(erg.get("typ"))] += 1
                z["verarbeitet"] += 1
                z["ocr"] += bool(erg.get("ocr"))
                z["quelle_" + str(messung.get("quelle", "keine"))] += 1
                vorschlag = nfc(erg["ordner"]) if erg.get("ordner") else None
                alternativen = [nfc(a) for a in erg.get("ordner_alternativen") or []]
                treffer1 = vorschlag == ziel
                treffer3 = treffer1 or ziel in alternativen
                kategorie = bool(vorschlag) and vorschlag.split("/")[:2] == ziel.split("/")[:2]
                z["top1"] += treffer1
                z["top3"] += treffer3
                z["kategorie"] += kategorie
                z["leer"] += not vorschlag
                eintrag["top1"] = int(eintrag["top1"]) + treffer1
                eintrag["top3"] = int(eintrag["top3"]) + treffer3
                eintrag["kategorie"] = int(eintrag["kategorie"]) + kategorie
                eintrag["leer"] = int(eintrag["leer"]) + (not vorschlag)
                # Zwillinge: wie viele Fast-Zwillinge im Zielordner ausgeschlossen wurden; Kreuzauswertung
                # Dateien mit/ohne Zwilling (ohne Ausschluss hätte der Zwilling die Stimmen dominiert).
                n_zw = int(messung.get("zwillinge") or 0)
                hat_zw = n_zw > 0
                z["zwilling_vorbilder"] += n_zw
                z["zwilling_dateien"] += hat_zw
                eintrag["zwillinge"] = int(eintrag["zwillinge"]) + n_zw
                z["top1_mit_zwilling" if hat_zw else "top1_ohne_zwilling"] += treffer1
                z["top3_mit_zwilling" if hat_zw else "top3_ohne_zwilling"] += treffer3
                # Rangliste vor dem Sprachmodell (Regeln + Vorbilder + Ordnernamen): wo stand das Ziel?
                rang = [nfc(o) for o in messung.get("rangliste") or []]
                pos = rang.index(ziel) if ziel in rang else None
                for k in (1, 3, 5):
                    z[f"rangliste_top{k}"] += pos is not None and pos < k
                if messung.get("quelle") == "ki":
                    # Was hat das Sprachmodell aus der Rangliste gemacht? (Rang 1 bestätigt / verbessert / verschlechtert)
                    z["ki_ziel_unter_kandidaten"] += pos is not None and pos < 5
                    gw = messung.get("gewaehlt_rang")
                    z[f"ki_wahl_rang{(gw + 1) if gw is not None else 0}"] += 1
                    z["ki_verbessert"] += treffer1 and pos is not None and pos > 0
                    z["ki_verschlechtert"] += (not treffer1) and pos == 0
                z["regel_" + str(messung.get("regel_art"))] += messung.get("regel_art") is not None
            if nr >= args.max_dateien:
                break
        freigaben[fg] = _kennzahlen(z, dauern)
        print(_zeile(fg, freigaben[fg]), flush=True)

    if export is not None:
        export.close()
    gesamt_z: Counter[str] = Counter()
    for fg in freigaben:
        gesamt_z.update(freigaben[fg]["zaehler"])
    gesamt = _kennzahlen(gesamt_z, alle_dauern)
    metas = llm.metas
    prompt_tokens = [int(m["prompt_tokens"]) for m in metas if m.get("prompt_tokens") is not None]
    report = {
        "zeit": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "wurzel": str(wurzel),
        "freigaben": args.freigabe,
        "je_ordner_max": args.je_ordner,
        "max_dateien": args.max_dateien,
        "seed": args.seed,
        "dateiname_neutral": args.dateiname_neutral,
        "namen_alle": len(namen_alle),
        "export": bool(args.export),
        "zwillinge": {
            "ausgeschlossen": zwillinge_aus,
            "schwelle": args.zwillinge_schwelle if zwillinge_aus else None,
            "dateien_mit_zwilling": gesamt_z["zwilling_dateien"],
            "vorbilder_ausgeschlossen": gesamt_z["zwilling_vorbilder"],
        },
        "modell": cfg.modell_text,
        "modell_bild": cfg.modell_bild,
        "modell_embed": cfg.modell_embed,
        "ollama_version": ollama_version,
        "ordner_gesamt": len(ordner),
        "ordner_quelle": ordner_quelle,
        "ordner_nas": len(nas_ordner),
        "ziel_nicht_in_liste": gesamt_z["ziel_nicht_in_liste"],
        "archiv_index": {"aktiv": archiv is not None, "eintraege": index_eintraege, "lauf": index_lauf},
        "modell_zaehler": {
            "aufrufe": len(metas),
            "prompt_tokens_median": _median(prompt_tokens),
            "prompt_tokens_max": max(prompt_tokens) if prompt_tokens else None,
            "num_ctx": dict(Counter(int(m["num_ctx"]) for m in metas).most_common()),
            "neu_geladen": sum(1 for m in metas if int(m.get("lade_ms") or 0) > 1000),
            "antwort_ms_median": _median([int(m["antwort_ms"]) for m in metas]),
            # Review V8: je Stufe getrennt — V8 verlängert nur die Ausgabe von Stufe 1.
            "je_stufe": {str(st): _stufe([m for m in metas if m.get("stufe") == st]) for st in (1, 2)},
        },
        "gesamt": gesamt,
        "je_freigabe": freigaben,
        "typen": dict(typen.most_common()),
        "fehlerarten": dict(fehlerarten.most_common()),
        "je_ordner": [{"ordner": o, **e} for o, e in sorted(je_ordner.items())],
        "laufzeit_s": int(time.monotonic() - laufzeit_start),
    }
    ausgabe = Path(args.ausgabe) if args.ausgabe else cfg.data_dir / "probelauf" / datetime.now().strftime("%Y%m%d-%H%M%S")
    ausgabe.mkdir(parents=True, exist_ok=True)
    (ausgabe / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (ausgabe / "report.md").write_text(als_markdown(report), encoding="utf-8")
    print()
    print(_zeile("GESAMT", gesamt))
    print(f"Modellaufrufe {len(metas)}, neu geladen {report['modell_zaehler']['neu_geladen']}×, num_ctx {report['modell_zaehler']['num_ctx']}, "
          f"Laufzeit {report['laufzeit_s']} s · Report: {ausgabe}")
    for st, w in report["modell_zaehler"]["je_stufe"].items():
        print(f"Stufe {st}: {w['aufrufe']} Aufrufe, Median Prompt {w['prompt_tokens_median']} Tokens / {w['prompt_ms_median']} ms, "
              f"Antwort {w['antwort_tokens_median']} Tokens / {w['antwort_ms_median']} ms, Aufruf {w['dauer_ms_median']} ms")
    return 0


def _stufe(metas: list[dict]) -> dict:
    """Median je Stufe: Tokens und Zeiten (Prompt auswerten, Antwort erzeugen, ganzer Aufruf) — nur Zähler."""
    def med(k: str) -> int | None:
        return _median([int(m[k]) for m in metas if m.get(k) is not None])
    return {"aufrufe": len(metas), "prompt_tokens_median": med("prompt_tokens"), "antwort_tokens_median": med("antwort_tokens"),
            "prompt_ms_median": med("prompt_ms"), "antwort_ms_median": med("antwort_ms"), "dauer_ms_median": med("dauer_ms"),
            "antwort_ms_summe": sum(int(m.get("antwort_ms") or 0) for m in metas)}


def _kennzahlen(z: Counter, dauern: list[int]) -> dict:
    n = z["verarbeitet"] or 0

    def q(k: str) -> float | None:
        return round(z[k] / n, 3) if n else None

    def anteil(k: str, nenner: int) -> float | None:
        return round(z[k] / nenner, 3) if nenner else None

    mit_zw = z["zwilling_dateien"]
    ohne_zw = n - mit_zw
    return {
        "dateien": z["dateien"],
        "verarbeitet": n,
        "fehler": z["fehler"],
        "ziel_nicht_in_liste": z["ziel_nicht_in_liste"],
        "top1": q("top1"),
        "top3": q("top3"),
        "kategorie": q("kategorie"),
        "leer": q("leer"),
        "zwillinge": {
            "dateien": mit_zw,
            "vorbilder": z["zwilling_vorbilder"],
            "top1_mit": anteil("top1_mit_zwilling", mit_zw),
            "top3_mit": anteil("top3_mit_zwilling", mit_zw),
            "top1_ohne": anteil("top1_ohne_zwilling", ohne_zw),
            "top3_ohne": anteil("top3_ohne_zwilling", ohne_zw),
        },
        "rangliste_top1": q("rangliste_top1"),
        "rangliste_top3": q("rangliste_top3"),
        "rangliste_top5": q("rangliste_top5"),
        "quellen": {k: z["quelle_" + k] for k in QUELLEN if z["quelle_" + k]},
        "ki": {
            "ziel_unter_kandidaten": z["ki_ziel_unter_kandidaten"],
            "wahl_rang": {k[12:]: v for k, v in sorted(z.items()) if k.startswith("ki_wahl_rang") and v},
            "verbessert": z["ki_verbessert"],
            "verschlechtert": z["ki_verschlechtert"],
        },
        "regel_arten": {k[6:]: v for k, v in z.items() if k.startswith("regel_") and v},
        # V8 (Rig-Seite): Abdeckung der Einordnung, Ziel unter den bis zu 8 Kandidaten, verbindliche Regel.
        "v8": {
            "mit_einordnung": z["v8_mit_einordnung"],
            "personenbezogen": z["v8_personenbezogen"],
            "profilname_in_was_betreff": z["v8_profilname"],
            "partei": z["v8_partei"],
            "bezug_art": z["v8_bezug_art"],
            "jahr": z["v8_jahr"],
            "sprache": z["v8_sprache"],
            "kandidaten_schnitt": round(z["v8_kandidaten_summe"] / n, 2) if n else None,
            "ziel_in_kandidaten": q("v8_ziel_in_kandidaten"),
            "ziel_kandidat1": q("v8_ziel_kandidat1"),
            "regel_ordner": z["v8_regel_ordner"],
            "regel_ordner_richtig": z["v8_regel_ordner_richtig"],
        },
        "dauer_ms": {"median": _median(dauern), "max": max(dauern) if dauern else None},
        "zaehler": dict(z),
    }


def _pz(w: float | None) -> str:
    return "–" if w is None else f"{w * 100:.0f} %"


def _zeile(name: str, k: dict) -> str:
    qu = k["quellen"]
    zw = k["zwillinge"]
    return (
        f"{name}: {k['verarbeitet']}/{k['dateien']} Dateien, Fehler {k['fehler']}, nicht in Liste {k['ziel_nicht_in_liste']} · "
        f"Top-1 {_pz(k['top1'])} · Top-3 {_pz(k['top3'])} · "
        f"Kategorie {_pz(k['kategorie'])} · leer {_pz(k['leer'])} · Zwillinge: {zw['dateien']} Dateien/{zw['vorbilder']} Vorbilder, "
        f"Top-1 mit/ohne {_pz(zw['top1_mit'])}/{_pz(zw['top1_ohne'])} · Rangliste ohne KI 1/3/5: {_pz(k['rangliste_top1'])}/"
        f"{_pz(k['rangliste_top3'])}/{_pz(k['rangliste_top5'])} · Entscheid: Regel {qu.get('regel', 0)}, KI {qu.get('ki', 0)}, "
        f"KI «keiner» {qu.get('ki_keiner', 0)}, Rangliste {qu.get('rangliste', 0)}, ohne {qu.get('keine', 0)} · "
        f"KI wählte Rang {k['ki']['wahl_rang']}, verbessert {k['ki']['verbessert']}, verschlechtert {k['ki']['verschlechtert']} · "
        f"Dauer Median {k['dauer_ms']['median']} ms, Max {k['dauer_ms']['max']} ms · "
        f"V8: Ziel unter Kandidaten {_pz(k['v8']['ziel_in_kandidaten'])} (Kandidat 1 {_pz(k['v8']['ziel_kandidat1'])}, "
        f"Ø {k['v8']['kandidaten_schnitt']}), regel_ordner {k['v8']['regel_ordner']} (richtig {k['v8']['regel_ordner_richtig']}), "
        f"personenbezogen {k['v8']['personenbezogen']}, Partei {k['v8']['partei']}, Bezug {k['v8']['bezug_art']}, "
        f"Jahr {k['v8']['jahr']}, Sprache {k['v8']['sprache']}"
    )


def als_markdown(r: dict) -> str:
    zw = r["zwillinge"]
    zw_text = (
        f"Zwillinge ausgeschlossen (Kosinus > {zw['schwelle']} oder gleicher Namensstamm im Zielordner): "
        f"{zw['dateien_mit_zwilling']} Dateien betroffen, {zw['vorbilder_ausgeschlossen']} Vorbilder ausgeschlossen"
        if zw["ausgeschlossen"] else "Zwillinge behalten (Messung wie vor dem Review 2026-10-11 — Freitreffer möglich)"
    )
    z = [
        f"# Probelauf Ablage-KI — {r['zeit']}",
        "",
        f"- Modell: `{r['modell']}` (Bild `{r['modell_bild']}`, Einbettung `{r['modell_embed']}`, Ollama {r['ollama_version']})",
        f"- Ordnerliste: {r['ordner_gesamt']} Pfade — {r['ordner_quelle']} (NAS-Ordner: {r['ordner_nas']}; Dateien mit Ziel "
        f"ausserhalb der Liste: {r['ziel_nicht_in_liste']}) · Archiv-Index: {r['archiv_index']['eintraege']} Vorbilder, "
        f"Leave-one-out (Testdatei und gleiche sha256 ausgeschlossen) · {zw_text} · Seed {r['seed']}, je Ordner {r['je_ordner_max']}, "
        f"max {r['max_dateien']} je Freigabe · Dateiname {'neutral («dokument.<endung>», wie Rohupload)' if r['dateiname_neutral'] else 'wie einsortiert (nicht der rohe Upload-Name)'}",
        f"- Modellaufrufe: {r['modell_zaehler']['aufrufe']} · neu geladen {r['modell_zaehler']['neu_geladen']}× · "
        f"num_ctx {r['modell_zaehler']['num_ctx']} · Laufzeit {r['laufzeit_s']} s",
        *(f"- Stufe {st}: {w['aufrufe']} Aufrufe · Median Prompt {w['prompt_tokens_median']} Tokens / {w['prompt_ms_median']} ms · "
          f"Antwort {w['antwort_tokens_median']} Tokens / {w['antwort_ms_median']} ms · Aufruf {w['dauer_ms_median']} ms"
          for st, w in r["modell_zaehler"].get("je_stufe", {}).items()),
        "",
        "## Je Freigabe",
        "",
        "| Freigabe | Dateien | Top-1 | Top-3 | Kategorie | leer | Fehler | Zwilling-Dateien | Top-1 mit/ohne Zwilling | Top-3 mit/ohne Zwilling | Rangliste 1/3/5 | Regel | KI | KI «keiner» | Rangliste | Median ms | Max ms |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    for name, k in list(r["je_freigabe"].items()) + [("**gesamt**", r["gesamt"])]:
        qu = k["quellen"]
        kz = k["zwillinge"]
        z.append(
            f"| {name} | {k['verarbeitet']} | {_pz(k['top1'])} | {_pz(k['top3'])} | {_pz(k['kategorie'])} | {_pz(k['leer'])} | {k['fehler']} | "
            f"{kz['dateien']} | {_pz(kz['top1_mit'])}/{_pz(kz['top1_ohne'])} | {_pz(kz['top3_mit'])}/{_pz(kz['top3_ohne'])} | "
            f"{_pz(k['rangliste_top1'])}/{_pz(k['rangliste_top3'])}/{_pz(k['rangliste_top5'])} | {qu.get('regel', 0)} | {qu.get('ki', 0)} | "
            f"{qu.get('ki_keiner', 0)} | {qu.get('rangliste', 0)} | {k['dauer_ms']['median']} | {k['dauer_ms']['max']} |"
        )
    z += ["", "## Je Ordner", "", "| Ordner | Dateien | Top-1 | Top-3 | Kategorie | leer | Fehler | Zwillinge |", "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for e in r["je_ordner"]:
        z.append(f"| {e['ordner']} | {e['dateien']} | {e['top1']} | {e['top3']} | {e['kategorie']} | {e['leer']} | {e['fehler']} | {e['zwillinge']} |")
    if r["archiv_index"].get("lauf"):
        b = r["archiv_index"]["lauf"]
        z += ["", "## Indexlauf", "", f"- {b['geprueft']} geprüft, {b['neu']} eingebettet, {b['uebernommen']} übernommen, "
              f"{b['unveraendert']} unverändert, {b['ohne_text']} ohne Text, {b['ocr']} mit OCR, {b['fehler']} Fehler — "
              f"{b['gesamt_s']} s (Text {b['extraktion_s']:.0f} s, Einbettung {b['einbettung_s']:.0f} s)"]
    z += ["", "## Erkannte Typen", ""] + ([f"- {k}: {v}" for k, v in r["typen"].items()] or ["- (keine)"])
    z += ["", "## Fehlerarten", ""] + ([f"- {k}: {v}" for k, v in r["fehlerarten"].items()] or ["- (keine)"])
    return "\n".join(z) + "\n"


if __name__ == "__main__":
    sys.exit(main())
