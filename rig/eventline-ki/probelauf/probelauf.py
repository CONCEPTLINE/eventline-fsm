"""Probelauf Phase 1 — Trefferquote der Ablage-KI gegen das sortierte NAS (SPEC §6).

Nimmt je Ordner bis zu N Dateien unter /mnt/eventline-nas/<Freigabe> (ohne
99_System, ZZ_* und versteckte Ordner), lässt die echte ablage_analyse-Pipeline
laufen (Text/OCR → Ollama direkt, ohne FSM) und vergleicht den vorgeschlagenen
Ordner mit dem Ordner, in dem die Datei tatsächlich liegt.

Der Report (report.json + report.md) enthält NUR Kennzahlen: Trefferquote je
Ordner, Dauer, Modell, OCR-Anteil, Fehlerarten — keine Dateinamen, keine Inhalte.

Aufruf im Dienst-Container (Ollama ist nur von dort erreichbar):
  docker compose --env-file /etc/eventline-ki/env -f …/docker-compose.yml \\
    exec dienst python /probelauf/probelauf.py --freigabe <Freigabe> --je-ordner 3
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import statistics
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ENDUNGEN = {".pdf", ".docx", ".xlsx", ".txt", ".csv", ".md", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}


def ausgeschlossen(name: str, oberste_ebene: bool) -> bool:
    if name.startswith((".", "@", "#", "~$")):
        return True
    if oberste_ebene and (name == "99_System" or name.upper().startswith("ZZ_")):
        return True
    return False


def ordner_liste(basis: Path) -> list[str]:
    """Alle Ordnerpfade relativ zur Freigabe — dieselbe Liste, die das FSM mitschickt."""
    aus: list[str] = []

    def gehe(ordner: Path, rel: str, tiefe: int) -> None:
        try:
            eintraege = sorted(ordner.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            return
        for e in eintraege:
            if not e.is_dir() or ausgeschlossen(e.name, tiefe == 0):
                continue
            pfad = f"{rel}/{e.name}" if rel else e.name
            aus.append(pfad)
            gehe(e, pfad, tiefe + 1)

    gehe(basis, "", 0)
    return aus


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


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Probelauf der Ablage-KI gegen das sortierte NAS")
    p.add_argument("--freigabe", help="Name der NAS-Freigabe unter /mnt/eventline-nas")
    p.add_argument("--basis", help="voller Pfad statt --freigabe (z. B. lokaler Testordner)")
    p.add_argument("--je-ordner", type=int, default=3)
    p.add_argument("--max-dateien", type=int, default=200)
    p.add_argument("--nur", help="nur Ordner mit diesem Präfix, z. B. 00_ADMIN_RECHT")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--mitarbeiter", help="kommagetrennte volle Namen (wie im FSM)")
    p.add_argument("--mitarbeiter-datei", help="Textdatei, ein voller Name je Zeile")
    p.add_argument("--ausgabe", help="Zielordner für report.json/report.md (Standard: <KI_DATA_DIR>/probelauf/<Zeit>)")
    p.add_argument("--app-pfad", default="/srv/app", help="Ort des Pakets «app» (im Container /srv/app)")
    p.add_argument("--ausfuehrlich", action="store_true", help="relative Pfade je Datei auf der Konsole zeigen (nie im Report)")
    args = p.parse_args(argv)

    if not args.freigabe and not args.basis:
        p.error("--freigabe oder --basis angeben")
    sys.path.insert(0, args.app_pfad)
    from app.config import EINSTELLUNGEN as cfg  # noqa: E402
    from app.handlers import VerarbeitungsFehler  # noqa: E402
    from app.handlers.ablage import DOK_TYPEN_STANDARD, ablage_analyse, heute_zuerich  # noqa: E402
    from app.llm import Ollama  # noqa: E402

    basis = Path(args.basis) if args.basis else Path("/mnt/eventline-nas") / args.freigabe
    if not basis.is_dir():
        print(f"Basis {basis} ist kein Ordner (NAS gemountet?)", file=sys.stderr)
        return 1
    llm = Ollama(cfg)
    ollama_version = llm.version()
    if ollama_version is None:
        print(f"Ollama unter {cfg.ollama_url} nicht erreichbar — im Dienst-Container ausführen", file=sys.stderr)
        return 1

    ordner = ordner_liste(basis)
    auswahl = dateien_je_ordner(basis, ordner, args.je_ordner, random.Random(args.seed), args.nur)
    gesamt_geplant = min(args.max_dateien, sum(len(v) for v in auswahl.values()))
    mitarbeiter = lese_mitarbeiter(args)
    kontext = {
        "heute": heute_zuerich(),
        "ordner": ordner,
        "dok_typen": [{"key": k, "label": l} for k, l in DOK_TYPEN_STANDARD],
        "mitarbeiter": mitarbeiter,
    }
    print(f"Basis: {basis} — {len(ordner)} Ordner, {gesamt_geplant} Dateien geplant, Modell {cfg.modell_text}")

    je_ordner: dict[str, dict[str, object]] = defaultdict(lambda: {"dateien": 0, "exakt": 0, "oberste_ebene": 0, "neuer_ordner": 0, "kein_vorschlag": 0, "fehler": 0, "dauer_ms": []})
    typen: Counter[str] = Counter()
    fehlerarten: Counter[str] = Counter()
    dauern: list[int] = []
    ocr_anzahl = 0
    frist_anzahl = 0
    person_anzahl = 0
    laufzeit_start = time.monotonic()
    nr = 0

    for rel, dateien in auswahl.items():
        for pfad in dateien:
            if nr >= args.max_dateien:
                break
            nr += 1
            eintrag = je_ordner[rel]
            eintrag["dateien"] = int(eintrag["dateien"]) + 1
            if args.ausfuehrlich:
                print(f"[{nr}/{gesamt_geplant}] {rel}/{pfad.name}")
            else:
                print(f"[{nr}/{gesamt_geplant}] {rel}")
            t0 = time.monotonic()
            try:
                erg = ablage_analyse(
                    pfad=pfad, dateiname=pfad.name, mime=None, sha256=sha256_von(pfad),
                    kontext_roh=kontext, llm=llm, cfg=cfg,
                )
            except VerarbeitungsFehler as e:
                eintrag["fehler"] = int(eintrag["fehler"]) + 1
                fehlerarten[str(e)[:60]] += 1
                continue
            except Exception as e:  # noqa: BLE001 — Lauf geht weiter, Art wird gezählt
                eintrag["fehler"] = int(eintrag["fehler"]) + 1
                fehlerarten[f"Unerwartet: {type(e).__name__}"] += 1
                continue
            dauer = int((time.monotonic() - t0) * 1000)
            dauern.append(dauer)
            eintrag["dauer_ms"].append(dauer)  # type: ignore[union-attr]
            typen[str(erg.get("typ"))] += 1
            if erg.get("ocr"):
                ocr_anzahl += 1
            if erg.get("frist"):
                frist_anzahl += 1
            if erg.get("person"):
                person_anzahl += 1
            vorschlag = erg.get("ordner")
            if vorschlag == rel:
                eintrag["exakt"] = int(eintrag["exakt"]) + 1
            if vorschlag and vorschlag.split("/")[0] == rel.split("/")[0]:
                eintrag["oberste_ebene"] = int(eintrag["oberste_ebene"]) + 1
            if not vorschlag:
                if erg.get("neuer_ordner"):
                    eintrag["neuer_ordner"] = int(eintrag["neuer_ordner"]) + 1
                else:
                    eintrag["kein_vorschlag"] = int(eintrag["kein_vorschlag"]) + 1
        if nr >= args.max_dateien:
            break

    # --- Kennzahlen ---------------------------------------------------------
    verarbeitet = len(dauern)
    exakt = sum(int(e["exakt"]) for e in je_ordner.values())
    oberste = sum(int(e["oberste_ebene"]) for e in je_ordner.values())
    fehler = sum(int(e["fehler"]) for e in je_ordner.values())
    zeilen = []
    for rel, e in sorted(je_ordner.items()):
        d = e["dauer_ms"]
        zeilen.append({
            "ordner": rel,
            "dateien": e["dateien"],
            "exakt": e["exakt"],
            "oberste_ebene": e["oberste_ebene"],
            "neuer_ordner": e["neuer_ordner"],
            "kein_vorschlag": e["kein_vorschlag"],
            "fehler": e["fehler"],
            "dauer_median_ms": int(statistics.median(d)) if d else None,  # type: ignore[arg-type]
        })
    report = {
        "zeit": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "basis": str(basis),
        "modell": cfg.modell_text,
        "modell_bild": cfg.modell_bild,
        "ollama_version": ollama_version,
        "ordner_gesamt": len(ordner),
        "dateien_geplant": gesamt_geplant,
        "dateien_verarbeitet": verarbeitet,
        "fehler": fehler,
        "treffer_exakt": exakt,
        "treffer_oberste_ebene": oberste,
        "quote_exakt": round(exakt / verarbeitet, 3) if verarbeitet else None,
        "quote_oberste_ebene": round(oberste / verarbeitet, 3) if verarbeitet else None,
        "ocr_anteil": round(ocr_anzahl / verarbeitet, 3) if verarbeitet else None,
        "frist_erkannt": frist_anzahl,
        "person_erkannt": person_anzahl,
        "dauer_ms": {
            "median": int(statistics.median(dauern)) if dauern else None,
            "mittel": int(statistics.mean(dauern)) if dauern else None,
            "max": max(dauern) if dauern else None,
            "gesamt_s": int(time.monotonic() - laufzeit_start),
        },
        "typen": dict(typen.most_common()),
        "fehlerarten": dict(fehlerarten.most_common()),
        "je_ordner": zeilen,
    }

    ausgabe = Path(args.ausgabe) if args.ausgabe else cfg.data_dir / "probelauf" / datetime.now().strftime("%Y%m%d-%H%M%S")
    ausgabe.mkdir(parents=True, exist_ok=True)
    (ausgabe / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (ausgabe / "report.md").write_text(als_markdown(report), encoding="utf-8")
    print()
    print(als_markdown(report))
    print(f"Report: {ausgabe}")
    return 0


def als_markdown(r: dict) -> str:
    def pz(wert: float | None) -> str:
        return "–" if wert is None else f"{wert * 100:.0f} %"

    d = r["dauer_ms"]
    z = [
        f"# Probelauf Ablage-KI — {r['zeit']}",
        "",
        f"- Modell: `{r['modell']}` (Bild: `{r['modell_bild']}`, Ollama {r['ollama_version']})",
        f"- Ordner gesamt: {r['ordner_gesamt']} · Dateien verarbeitet: {r['dateien_verarbeitet']} von {r['dateien_geplant']} · Fehler: {r['fehler']}",
        f"- **Trefferquote Zielordner exakt: {pz(r['quote_exakt'])}** · oberste Ebene richtig: {pz(r['quote_oberste_ebene'])}",
        f"- OCR-Anteil: {pz(r['ocr_anteil'])} · Frist erkannt: {r['frist_erkannt']} · Person erkannt: {r['person_erkannt']}",
        f"- Dauer je Datei: Median {d['median']} ms · Mittel {d['mittel']} ms · Max {d['max']} ms · gesamt {d['gesamt_s']} s",
        "",
        "## Je Ordner",
        "",
        "| Ordner | Dateien | exakt | oberste Ebene | neuer Ordner | kein Vorschlag | Fehler | Median ms |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for e in r["je_ordner"]:
        z.append(f"| {e['ordner']} | {e['dateien']} | {e['exakt']} | {e['oberste_ebene']} | {e['neuer_ordner']} | {e['kein_vorschlag']} | {e['fehler']} | {e['dauer_median_ms'] if e['dauer_median_ms'] is not None else '–'} |")
    z += ["", "## Erkannte Typen", ""]
    z += [f"- {k}: {v}" for k, v in r["typen"].items()] or ["- (keine)"]
    z += ["", "## Fehlerarten", ""]
    z += [f"- {k}: {v}" for k, v in r["fehlerarten"].items()] or ["- (keine)"]
    return "\n".join(z) + "\n"


if __name__ == "__main__":
    sys.exit(main())
