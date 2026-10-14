"""Archiv-Index: einsortierte Dateien auf dem NAS als Vorbilder für die Ordnerwahl (SPEC §2.2).

Je Datei unter /mnt/eventline-nas/<Freigabe>/… (read-only) eine Einbettung (bge-m3) aus
«Dateiname + Textanfang» in pgvector (Container db, also im LUKS-Tresor). Gespeichert werden nur
Pfad, Ordner, Name, Grösse, mtime, sha256, Rezept und die Einbettung — nie Text.

Kein Vorbild: ZZ_* auf jeder Tiefe (Hauskonvention für Altes/Archiv/zum Einsortieren), 99_System,
versteckte Einträge. Welche Ordner bei einem Auftrag zählen, entscheidet zusätzlich die Ordnerliste
des FSM (nachbarn(ordner=…)): was dort nicht als aktiver Ordner steht, ist nie ein Vorbild.

Indexlauf beim Start (sobald der Dienst ruht) und jede Nacht; inkrementell: unveränderte Grösse +
mtime = nichts tun, gleicher sha256 an neuem Ort (verschoben/kopiert) = Einbettung übernehmen ohne
neues Lesen, sonst Text holen (OCR höchstens KI_INDEX_OCR_SEITEN Seiten) und einbetten. Aufträge
haben immer Vorrang: der Lauf wartet vor jeder Datei, bis der Worker ruht, und rechnet mit
niedriger CPU-Priorität (Thread und seine OCR-Prozesse).

Verschwundenes wird nur entfernt, wenn der Durchgang vollständig war: jede Freigabe unter der Wurzel
ist auf dem Rig ein eigener CIFS-Mount — eine nicht eingehängte Freigabe ist ein leerer Ordner, kein
Fehler. Darum gilt je Freigabe «unvollständig» (nicht lesbar, ohne Einträge, oder kein Mount-Punkt,
obwohl die anderen einer sind): dort wird nichts entfernt, der Lauf zählt als unterbrochen und wird
wiederholt. Zusätzlich die Bremse: verschwinden auf einmal 50 % oder mehr des Bestands, wird nichts
entfernt (Review 2026-10-11: ein Lauf bei fehlenden Mounts hätte alle Vorbilder gelöscht).
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import logging
import os
import re
import threading
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable, Collection, Iterable, Iterator

from .config import Einstellungen
from .extract import ExtraktFehler, extrahiere
from .gpu import gpu_info
from .llm import LlmFehler, Ollama

log = logging.getLogger("ki.archiv")

# Dieselben Endungen wie im Probelauf — was extract.py lesen kann.
ENDUNGEN = frozenset({".pdf", ".docx", ".xlsx", ".txt", ".csv", ".md", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"})
# Einbettungstext: lesbarer Dateiname + so viele Zeichen vom Textanfang (Titel, Parteien, Daten).
TEXT_ANFANG = 2000
REZEPT_VERSION = "name+text2000/v1"
# Ein Indexlauf startet erst, wenn so lange kein Auftrag lief (mehrere Ablagen hintereinander).
RUHE_S = 20.0
NACHHOLEN_ALLE_S = 30.0
NACHT_ZEITZONE = "Europe/Zurich"
# Nachtlauf: fällig von KI_INDEX_NACHT bis so lange danach (auch über Mitternacht) — ein Neustart am Tag
# holt nichts nach.
NACHT_FENSTER = timedelta(hours=4)
# Bremse: verschwinden in einem Durchgang so viele Einträge (Anteil des Bestands) oder mehr, wird nichts
# entfernt — das ist eher ein fehlender Mount als ein echtes Aufräumen.
ENTFERNEN_MAX_ANTEIL = 0.5
# Nach einem unvollständigen (Freigabe nicht eingehängt) oder gebremsten Durchgang: so lange bis zum nächsten Versuch.
WIEDERHOLEN_UNVOLLSTAENDIG_S = 600.0
# Austauschbar für Tests (Attrappen-NAS ohne Mount-Punkte).
_ismount = os.path.ismount


def gleiches_modell(name: str, gesucht: str) -> bool:
    """Ollama meldet «bge-m3:latest», die Einstellung heisst «bge-m3» — beides ist dasselbe Modell."""
    return name == gesucht or name == f"{gesucht}:latest" or f"{name}:latest" == gesucht


def platz_fuer_einbettung(llm: Ollama, cfg: Einstellungen, *, grund: str, max_alter_s: float = 0.0) -> int:
    """Knapper VRAM (Whisper nach einem Diktat noch bis 5 min geladen, Sprachmodell drin): geladene Modelle
    ausser dem Einbettungsmodell entladen, sonst landet bge-m3 fast ganz im Hauptspeicher (gemessen
    2026-10-11: 74 von 1204 MiB in der GPU, Laden 24 s statt 2 s). Gleicher Schritt für Ablage und
    Archiv-Index. Liefert die Zahl der entladenen Modelle; ohne GPU-Auskunft passiert nichts."""
    g = gpu_info(max_alter_s=max_alter_s)
    frei = g.get("frei_mb")
    if not isinstance(frei, int) or frei >= cfg.embed_min_frei_mb:
        return 0
    # Nur geladene Modelle ausser dem Einbettungsmodell — ein nicht geladenes würde Ollama erst laden.
    geladen = [str(m.get("name") or "") for m in llm.geladene_modelle()]
    weg = [n for n in geladen if n and not gleiches_modell(n, cfg.modell_embed)]
    if weg:
        log.info("%s: %d MB VRAM frei (< %d) — %d Modell(e) vor der Einbettung entladen", grund, frei, cfg.embed_min_frei_mb, len(weg))
    for name in weg:
        llm.entlade(name)
    return len(weg)


def nfc(s: str) -> str:
    """NAS-Namen können zerlegte Umlaute tragen (NFD); verglichen wird immer in NFC."""
    return unicodedata.normalize("NFC", s)


def _jetzt_iso() -> str:
    """Aktuelle Zeit in Europe/Zurich (ISO 8601, Sekunden) — für /health und das Log."""
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo(NACHT_ZEITZONE)).isoformat(timespec="seconds")
    except Exception:  # noqa: BLE001 — ohne Zeitzonendaten Ortszeit des Containers
        return datetime.now().astimezone().isoformat(timespec="seconds")


def ausgeschlossen(name: str, tiefe: int) -> bool:
    """tiefe 0 = Freigabe, 1 = deren erste Ebene, … (für Aufrufer, die die Ebene kennen; die Regeln selbst
    gelten auf jeder Tiefe). ZZ_* ist Haus-Konvention für Altes/Archiv/zum Einsortieren und auf JEDER Ebene
    kein Vorbild (Entscheid 2026-10-11) — die FSM-Liste filtert nicht nach Namen, das tun Index und Rangliste."""
    del tiefe
    if name.startswith((".", "@", "#", "~$")):
        return True
    if name == "99_System":
        return True
    return name.upper().startswith("ZZ_")


def unter_zz(pfad: str) -> bool:
    """Liegt der Pfad in oder unter einem ZZ_-Ordner (jede Tiefe)?"""
    return any(seg.upper().startswith("ZZ_") for seg in pfad.split("/"))


def freigaben_zustand(wurzel: Path) -> tuple[list[str], list[str]]:
    """(lesbar, unvollständig) — die Freigaben (Ordner direkt unter der Wurzel, ohne ZZ_/99_System/versteckte).

    Unvollständig: nicht lesbar (Mount weg, Server down), ohne jeden Eintrag (leerer Mount-Punkt, Freigabe nicht
    eingehängt — auf dem Rig ist /mnt/eventline-nas ein normaler Ordner und jede Freigabe ein eigener
    CIFS-Mount) oder kein Mount-Punkt, obwohl andere Freigaben einer sind. Ohne jeden Mount-Punkt (Entwicklung,
    Tests) zählt nur Lesbarkeit und Inhalt.
    """
    try:
        eintraege = sorted(wurzel.iterdir(), key=lambda p: p.name.lower())
    except OSError:
        return [], []
    freigaben: list[Path] = []
    for e in eintraege:
        try:
            if e.is_dir() and not ausgeschlossen(e.name, 0):
                freigaben.append(e)
        except OSError:
            continue
    mounts = {e.name for e in freigaben if _ismount(e)}
    lesbar: list[str] = []
    unvollstaendig: list[str] = []
    for e in freigaben:
        try:
            hat_eintraege = any(True for _ in e.iterdir())
        except OSError:
            unvollstaendig.append(e.name)
            continue
        if not hat_eintraege or (mounts and e.name not in mounts):
            unvollstaendig.append(e.name)
        else:
            lesbar.append(e.name)
    return lesbar, unvollstaendig


def nas_bereit(wurzel: Path) -> bool:
    """Mindestens eine Freigabe ist lesbar und hat Einträge (Mount-Punkt, wo es Mounts gibt)."""
    return bool(freigaben_zustand(wurzel)[0])


@dataclass(frozen=True)
class NasDatei:
    pfad: str  # relativ zur Wurzel, NFC, z. B. «02_LOCATIONS/…/Plan.pdf»
    ordner: str  # Elternordner relativ zur Wurzel
    name: str
    voll: Path
    groesse: int
    mtime: float


def nas_dateien(wurzel: Path, *, freigaben: Collection[str] | None = None) -> Iterator[NasDatei]:
    """Alle lesbaren Dateien in einsortierten Ordnern (nie in der Wurzel selbst, nie in ZZ_*/99_System).
    freigaben: nur diese Freigaben durchgehen (None = alle)."""

    def gehe(ordner: Path, rel: tuple[str, ...]) -> Iterator[NasDatei]:
        try:
            eintraege = sorted(ordner.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            return
        for e in eintraege:
            if ausgeschlossen(e.name, len(rel)):
                continue
            if not rel and freigaben is not None and e.name not in freigaben:
                continue
            try:
                if e.is_dir():
                    yield from gehe(e, rel + (e.name,))
                    continue
                if not rel or e.suffix.lower() not in ENDUNGEN or not e.is_file():
                    continue
                st = e.stat()
            except OSError:
                continue
            ordner_rel = nfc("/".join(rel))
            yield NasDatei(
                pfad=f"{ordner_rel}/{nfc(e.name)}", ordner=ordner_rel, name=nfc(e.name), voll=e,
                groesse=int(st.st_size), mtime=float(st.st_mtime),
            )

    yield from gehe(wurzel, ())


def nas_ordner(wurzel: Path, *, freigaben: Collection[str] | None = None) -> list[str]:
    """Alle einsortierten Ordner (NFC, relativ zur Wurzel, Freigaben eingeschlossen; nie ZZ_*/99_System/versteckte —
    anders als die FSM-Liste, die nicht nach Namen filtert). freigaben: nur diese Freigaben (None = alle)."""
    aus: list[str] = []

    def gehe(ordner: Path, rel: tuple[str, ...]) -> None:
        try:
            eintraege = sorted(ordner.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            return
        for e in eintraege:
            try:
                ist_ordner = e.is_dir()
            except OSError:
                continue
            if not rel and freigaben is not None and e.name not in freigaben:
                continue
            if ist_ordner and not ausgeschlossen(e.name, len(rel)):
                aus.append(nfc("/".join(rel + (e.name,))))
                gehe(e, rel + (e.name,))

    gehe(wurzel, ())
    return aus


_NUMMERN_PRAEFIX = re.compile(r"^\d+_")


def ordner_text(pfad: str) -> str:
    """Text für die Einbettung eines Ordners: Segmente unter der Freigabe, ohne Nummern-Präfix."""
    teile = nfc(pfad).split("/")
    unter = teile[1:] or teile
    return " / ".join(re.sub(r"\s+", " ", re.sub(r"[_\-]+", " ", _NUMMERN_PRAEFIX.sub("", t))).strip() for t in unter)


def lesbarer_name(dateiname: str) -> str:
    stamm = dateiname.rsplit(".", 1)[0] if "." in dateiname else dateiname
    return re.sub(r"\s+", " ", re.sub(r"[_\-]+", " ", stamm)).strip()


def einbettungstext(dateiname: str, text: str) -> str:
    """Rezept für Index und Anfrage (muss gleich bleiben, sonst REZEPT_VERSION erhöhen)."""
    return (lesbarer_name(dateiname) + "\n" + (text or "")[:TEXT_ANFANG]).strip() or "(leer)"


def sha256_von(pfad: Path) -> str:
    h = hashlib.sha256()
    with open(pfad, "rb") as f:
        for teil in iter(lambda: f.read(1 << 20), b""):
            h.update(teil)
    return h.hexdigest()


def _vektor_text(v: Iterable[float]) -> str:
    return "[" + ",".join(f"{x:.7g}" for x in v) + "]"


def _vektor_aus(text: object) -> tuple[float, ...] | None:
    """pgvector als Text («[0.1,0.2,…]») → Tupel; unlesbar → None (die Zwillings-Erkennung nimmt dann den Namen)."""
    try:
        return tuple(float(x) for x in json.loads(str(text)))
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class Nachbar:
    pfad: str
    ordner: str
    name: str
    aehnlichkeit: float  # Kosinus, 1 = gleich
    # Einbettung des Vorbilds (normiert) — für die Zwillings-Erkennung der Ordnerwahl (docx+pdf, Versionen
    # zählen als EINE Stimme, Befund 14.10.); fehlt sie, gilt der gleiche Namensstamm.
    vektor: tuple[float, ...] | None = dataclasses.field(default=None, compare=False, repr=False)


# --- Datenbank ------------------------------------------------------------------

DDL = """
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS archiv_dateien (
  pfad       text PRIMARY KEY,
  ordner     text        NOT NULL,
  name       text        NOT NULL,
  groesse    bigint      NOT NULL,
  mtime      double precision NOT NULL,
  sha256     text        NOT NULL,
  rezept     text        NOT NULL,
  einbettung vector      NOT NULL,
  indexiert  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS archiv_dateien_ordner_idx ON archiv_dateien (ordner);
CREATE INDEX IF NOT EXISTS archiv_dateien_sha_idx ON archiv_dateien (sha256);
CREATE TABLE IF NOT EXISTS archiv_ordner (
  pfad       text        NOT NULL,
  rezept     text        NOT NULL,
  einbettung vector      NOT NULL,
  indexiert  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pfad, rezept)
);
"""
# Ordnerpfade werden eigens eingebettet (Text: Segmente unter der Freigabe, ohne Nummern-Präfix).
ORDNER_REZEPT_VERSION = "ordner/v1"
ORDNER_STAPEL = 64


class ArchivIndex:
    """Tabelle archiv_dateien (pgvector). Fällt die DB aus, liefert nachbarn() eine leere Liste —
    die Ablage arbeitet dann mit Regeln und Ordnernamen weiter."""

    def __init__(self, dsn: str | None, rezept: str) -> None:
        self._dsn = dsn
        self.rezept = rezept
        self._lock = threading.Lock()
        self._conn = None
        self._letzter_versuch = 0.0
        # Einbettungen der Ordnerpfade (NFC-Pfad → Vektor): im Speicher, mit DB in archiv_ordner.
        self._ordner_cache: dict[str, list[float]] = {}
        self._ordner_lock = threading.Lock()
        # Letzte gezählte Anzahl (Zeitpunkt, Wert) — /health fragt alle 30 s, nicht jedes Mal die DB.
        self._anzahl_cache: tuple[float, int] = (0.0, 0)

    @property
    def aktiv(self) -> bool:
        return self._dsn is not None

    def _verbindung(self):
        import psycopg

        if self._conn is not None and not self._conn.closed:
            return self._conn
        if time.monotonic() - self._letzter_versuch < 30:
            raise ConnectionError("Archiv-DB kurz zuvor nicht erreichbar")
        self._letzter_versuch = time.monotonic()
        self._conn = psycopg.connect(self._dsn, autocommit=True)
        with self._conn.cursor() as c:
            c.execute(DDL)
        return self._conn

    def _ausfuehren(self, sql: str, werte: tuple = (), *, holen: bool = False) -> list[tuple]:
        if not self._dsn:
            return []
        with self._lock:
            try:
                conn = self._verbindung()
                with conn.cursor() as c:
                    c.execute(sql, werte)
                    return list(c.fetchall()) if holen else []
            except Exception:
                if self._conn is not None:
                    try:
                        self._conn.close()
                    except Exception:  # noqa: BLE001
                        pass
                self._conn = None
                raise

    def bereit(self) -> bool:
        try:
            self._ausfuehren("SELECT 1", holen=True)
            return True
        except Exception as e:  # noqa: BLE001
            log.warning("Archiv-Index nicht bereit (%s)", type(e).__name__)
            return False

    def bestand(self) -> dict[str, tuple[int, float, str, str]]:
        zeilen = self._ausfuehren("SELECT pfad, groesse, mtime, sha256, rezept FROM archiv_dateien", holen=True)
        return {z[0]: (int(z[1]), float(z[2]), str(z[3]), str(z[4])) for z in zeilen}

    def uebernehme(self, d: NasDatei, sha: str) -> bool:
        """Einbettung einer gleichen Datei (sha256, gleiches Rezept) übernehmen — verschoben/kopiert."""
        zeilen = self._ausfuehren(
            """INSERT INTO archiv_dateien (pfad, ordner, name, groesse, mtime, sha256, rezept, einbettung)
               SELECT %s, %s, %s, %s, %s, %s, rezept, einbettung FROM archiv_dateien
                WHERE sha256 = %s AND rezept = %s AND pfad <> %s LIMIT 1
               ON CONFLICT (pfad) DO UPDATE SET ordner = EXCLUDED.ordner, name = EXCLUDED.name,
                 groesse = EXCLUDED.groesse, mtime = EXCLUDED.mtime, sha256 = EXCLUDED.sha256,
                 rezept = EXCLUDED.rezept, einbettung = EXCLUDED.einbettung, indexiert = now()
               RETURNING pfad""",
            (d.pfad, d.ordner, d.name, d.groesse, d.mtime, sha, sha, self.rezept, d.pfad),
            holen=True,
        )
        return bool(zeilen)

    def speichere(self, d: NasDatei, sha: str, vektor: list[float]) -> None:
        self._ausfuehren(
            """INSERT INTO archiv_dateien (pfad, ordner, name, groesse, mtime, sha256, rezept, einbettung)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s::vector)
               ON CONFLICT (pfad) DO UPDATE SET ordner = EXCLUDED.ordner, name = EXCLUDED.name,
                 groesse = EXCLUDED.groesse, mtime = EXCLUDED.mtime, sha256 = EXCLUDED.sha256,
                 rezept = EXCLUDED.rezept, einbettung = EXCLUDED.einbettung, indexiert = now()""",
            (d.pfad, d.ordner, d.name, d.groesse, d.mtime, sha, self.rezept, _vektor_text(vektor)),
        )

    def entferne(self, pfade: Collection[str]) -> None:
        if pfade:
            self._ausfuehren("DELETE FROM archiv_dateien WHERE pfad = ANY(%s)", (list(pfade),))

    def anzahl(self, max_alter_s: float = 0.0) -> int:
        """Vorbilder im Index (aktuelles Rezept). max_alter_s > 0: so alt darf der gemerkte Wert sein
        (für /health); ist die DB gerade nicht erreichbar, bleibt der letzte bekannte Wert."""
        zeit, wert = self._anzahl_cache
        if max_alter_s > 0 and time.monotonic() - zeit < max_alter_s:
            return wert
        try:
            z = self._ausfuehren("SELECT count(*) FROM archiv_dateien WHERE rezept = %s", (self.rezept,), holen=True)
            wert = int(z[0][0]) if z else 0
        except Exception:  # noqa: BLE001
            return wert
        self._anzahl_cache = (time.monotonic(), wert)
        return wert

    def nachbarn(
        self,
        vektor: list[float],
        *,
        ordner: Collection[str] | None,
        k: int,
        ohne_sha: Collection[str] = (),
        ohne_pfade: Collection[str] = (),
    ) -> list[Nachbar]:
        """Die k ähnlichsten Vorbilder (Kosinus) — nur in den erlaubten Ordnern (FSM-Liste), ohne die
        ausgeschlossenen Dateien (Probelauf: Testdatei und gleiche sha256)."""
        bedingungen = ["rezept = %s"]
        werte: list[object] = [self.rezept]
        if ordner is not None:
            bedingungen.append("ordner = ANY(%s)")
            werte.append([nfc(o) for o in ordner])
        if ohne_sha:
            bedingungen.append("NOT (sha256 = ANY(%s))")
            werte.append(list(ohne_sha))
        if ohne_pfade:
            bedingungen.append("NOT (pfad = ANY(%s))")
            werte.append([nfc(p) for p in ohne_pfade])
        q = _vektor_text(vektor)
        sql = (
            "SELECT pfad, ordner, name, 1 - (einbettung <=> %s::vector), einbettung::text FROM archiv_dateien WHERE "
            + " AND ".join(bedingungen)
            + " ORDER BY einbettung <=> %s::vector LIMIT %s"
        )
        zeilen = self._ausfuehren(sql, (q, *werte, q, int(k)), holen=True)
        return [
            Nachbar(pfad=z[0], ordner=z[1], name=z[2], aehnlichkeit=float(z[3]), vektor=_vektor_aus(z[4]))
            for z in zeilen
        ]

    def ordner_mit_dateien(self, *, ohne_sha: Collection[str] = (), ohne_pfade: Collection[str] = ()) -> set[str]:
        """Ordner, in denen mindestens ein Vorbild liegt (ohne die ausgeschlossenen Dateien)."""
        bedingungen = ["rezept = %s"]
        werte: list[object] = [self.rezept]
        if ohne_sha:
            bedingungen.append("NOT (sha256 = ANY(%s))")
            werte.append(list(ohne_sha))
        if ohne_pfade:
            bedingungen.append("NOT (pfad = ANY(%s))")
            werte.append([nfc(p) for p in ohne_pfade])
        zeilen = self._ausfuehren(
            "SELECT DISTINCT ordner FROM archiv_dateien WHERE " + " AND ".join(bedingungen), tuple(werte), holen=True
        )
        return {str(z[0]) for z in zeilen}

    def ordner_vektoren(
        self, pfade: Iterable[str], einbetten: Callable[[list[str]], list[list[float]]]
    ) -> dict[str, list[float]]:
        """Einbettungen der Ordnerpfade (NFC-Pfad → Vektor): Speicher, dann DB, fehlende werden berechnet
        (in Stapeln) und gemerkt. Ohne DB nur im Speicher."""
        gesucht = list(dict.fromkeys(nfc(p) for p in pfade))
        rezept = self.rezept.split("|", 1)[0] + "|" + ORDNER_REZEPT_VERSION
        with self._ordner_lock:
            fehlend = [p for p in gesucht if p not in self._ordner_cache]
            if fehlend and self._dsn:
                try:
                    for pfad, vektor in self._ausfuehren(
                        "SELECT pfad, einbettung::text FROM archiv_ordner WHERE rezept = %s AND pfad = ANY(%s)",
                        (rezept, fehlend),
                        holen=True,
                    ):
                        self._ordner_cache[str(pfad)] = [float(x) for x in json.loads(vektor)]
                except Exception as e:  # noqa: BLE001
                    log.warning("Ordner-Einbettungen nicht lesbar (%s)", type(e).__name__)
                fehlend = [p for p in gesucht if p not in self._ordner_cache]
            for i in range(0, len(fehlend), ORDNER_STAPEL):
                stapel = fehlend[i : i + ORDNER_STAPEL]
                vektoren = einbetten([ordner_text(p) for p in stapel])
                for p, v in zip(stapel, vektoren):
                    self._ordner_cache[p] = v
                if self._dsn:
                    try:
                        for p, v in zip(stapel, vektoren):
                            self._ausfuehren(
                                "INSERT INTO archiv_ordner (pfad, rezept, einbettung) VALUES (%s, %s, %s::vector) "
                                "ON CONFLICT (pfad, rezept) DO UPDATE SET einbettung = EXCLUDED.einbettung, indexiert = now()",
                                (p, rezept, _vektor_text(v)),
                            )
                    except Exception as e:  # noqa: BLE001
                        log.warning("Ordner-Einbettungen nicht gespeichert (%s)", type(e).__name__)
            return {p: self._ordner_cache[p] for p in gesucht if p in self._ordner_cache}

    def entferne_ordner_ausser(self, pfade: Collection[str]) -> None:
        """Einbettungen von Ordnern, die es nicht mehr gibt, löschen (DB und Speicher)."""
        behalten = {nfc(p) for p in pfade}
        if not behalten:
            return
        rezept = self.rezept.split("|", 1)[0] + "|" + ORDNER_REZEPT_VERSION
        with self._ordner_lock:
            for p in [p for p in self._ordner_cache if p not in behalten]:
                del self._ordner_cache[p]
            if self._dsn:
                self._ausfuehren("DELETE FROM archiv_ordner WHERE rezept = %s AND NOT (pfad = ANY(%s))", (rezept, sorted(behalten)))

    def namen_in(
        self, ordner: Collection[str], *, je_ordner: int, ohne_sha: Collection[str] = (), ohne_pfade: Collection[str] = ()
    ) -> dict[str, list[str]]:
        """Dateinamen je Ordner (für den Prompt der Ordnerwahl), höchstens je_ordner, neueste zuerst."""
        if not ordner:
            return {}
        bedingungen = ["rezept = %s", "ordner = ANY(%s)"]
        werte: list[object] = [self.rezept, [nfc(o) for o in ordner]]
        if ohne_sha:
            bedingungen.append("NOT (sha256 = ANY(%s))")
            werte.append(list(ohne_sha))
        if ohne_pfade:
            bedingungen.append("NOT (pfad = ANY(%s))")
            werte.append([nfc(p) for p in ohne_pfade])
        zeilen = self._ausfuehren(
            "SELECT ordner, name FROM archiv_dateien WHERE " + " AND ".join(bedingungen) + " ORDER BY ordner, mtime DESC",
            tuple(werte),
            holen=True,
        )
        aus: dict[str, list[str]] = {}
        for o, n in zeilen:
            liste = aus.setdefault(o, [])
            if len(liste) < je_ordner:
                liste.append(n)
        return aus

    def schliessen(self) -> None:
        with self._lock:
            if self._conn is not None:
                try:
                    self._conn.close()
                except Exception:  # noqa: BLE001
                    pass
                self._conn = None


def rezept_fuer(cfg: Einstellungen) -> str:
    return f"{cfg.modell_embed}|{REZEPT_VERSION}"


# --- Indexlauf ----------------------------------------------------------------------


@dataclass
class Bilanz:
    geprueft: int = 0
    unveraendert: int = 0
    neu: int = 0
    uebernommen: int = 0
    ohne_text: int = 0
    ocr: int = 0
    fehler: int = 0
    entfernt: int = 0
    extraktion_s: float = 0.0
    einbettung_s: float = 0.0
    gesamt_s: float = 0.0
    abgebrochen: bool = False
    # Freigaben, die in diesem Durchgang nicht vollständig lesbar waren (nicht eingehängt/leer) — dort wurde
    # nichts entfernt; der Lauf gilt als unterbrochen.
    unvollstaendig: int = 0
    # Entfernen wegen der Bremse (≥ 50 % des Bestands weg) ausgelassen.
    entfernen_gebremst: int = 0


def nachtzeit(wert: str) -> tuple[int, int] | None:
    """«HH:MM» → (Stunde, Minute); None bei ungültigem Wert."""
    stunde, _, minute = (wert or "").strip().partition(":")
    try:
        h, m = int(stunde), int(minute or 0)
    except ValueError:
        return None
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return None
    return h, m


class Indexierer(threading.Thread):
    """Hält archiv_dateien aktuell: Lauf beim Start und jede Nacht, nur wenn der Worker ruht."""

    def __init__(
        self,
        cfg: Einstellungen,
        index: ArchivIndex,
        llm: Ollama,
        ruhig: Callable[[], bool],
        *,
        wurzel: Path | None = None,
    ) -> None:
        super().__init__(name="ki-archiv", daemon=True)
        self.cfg = cfg
        self.index = index
        self.llm = llm
        self.ruhig = ruhig
        self.wurzel = wurzel or cfg.nas_wurzel
        self._halt = threading.Event()
        self._start_faellig = time.monotonic() + cfg.index_start_s
        # Schlüssel (Datum der Startzeit) des letzten erledigten Nachtlaufs — einmal je Nacht.
        self._letzte_nacht: str | None = None
        self._nacht = nachtzeit(cfg.index_nacht)
        if self._nacht is None:
            log.error("KI_INDEX_NACHT=%r ist keine Uhrzeit HH:MM — kein nächtlicher Indexlauf", cfg.index_nacht)
        self._unvollstaendig_gemeldet: tuple[str, ...] = ()
        # Nach einem unvollständigen/gebremsten Durchgang erst ab diesem Zeitpunkt (monotonic) erneut.
        self._pause_bis = 0.0
        self.letzte_bilanz: Bilanz | None = None
        # Für /health: Ende des letzten vollständigen Laufs (ISO, Europe/Zurich) und ob gerade einer läuft.
        self.letzter_lauf: str | None = None
        self.laeuft = False

    def stop(self) -> None:
        self._halt.set()

    def status(self) -> dict[str, object]:
        """Index-Status für /health — nur Zähler und Zeiten, nie Namen."""
        b = self.letzte_bilanz
        return {
            "aktiv": self.index.aktiv,
            "anzahl": self.index.anzahl(max_alter_s=30.0),
            "letzter_lauf": self.letzter_lauf,
            "laeuft": self.laeuft,
            "letzte_bilanz": None if b is None else {
                "geprueft": b.geprueft, "neu": b.neu, "uebernommen": b.uebernommen, "unveraendert": b.unveraendert,
                "entfernt": b.entfernt, "fehler": b.fehler, "dauer_s": b.gesamt_s, "unterbrochen": b.abgebrochen,
                "freigaben_unvollstaendig": b.unvollstaendig,
            },
        }

    # --- Zeitplan -------------------------------------------------------------

    @staticmethod
    def _jetzt() -> datetime:
        try:
            from zoneinfo import ZoneInfo

            return datetime.now(ZoneInfo(NACHT_ZEITZONE))
        except Exception:  # noqa: BLE001 — ohne Zeitzonendaten Ortszeit des Containers
            return datetime.now()

    def _nacht_schluessel(self, jetzt: datetime | None = None) -> str | None:
        """Datum der Nacht (Tag der Startzeit), wenn der Nachtlauf jetzt fällig ist, sonst None.

        Fenster als Zeitdifferenz: von KI_INDEX_NACHT bis NACHT_FENSTER danach, auch über Mitternacht
        (23:30 → bis 03:30). Ein Neustart ausserhalb des Fensters holt nichts nach; je Nacht nur einmal.
        """
        if self._nacht is None:
            return None
        if jetzt is None:
            jetzt = self._jetzt()
        h, m = self._nacht
        schwelle = jetzt.replace(hour=h, minute=m, second=0, microsecond=0)
        if schwelle > jetzt:
            schwelle -= timedelta(days=1)
        if jetzt - schwelle >= NACHT_FENSTER:
            return None
        schluessel = schwelle.date().isoformat()
        return None if self._letzte_nacht == schluessel else schluessel

    def _nacht_faellig(self, jetzt: datetime | None = None) -> bool:
        return self._nacht_schluessel(jetzt) is not None

    def run(self) -> None:
        try:
            # Niedrige Priorität für diesen Thread; OCR-Prozesse erben sie (Linux: je Thread).
            os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 15)
        except (AttributeError, OSError):
            pass
        nas_gemeldet = False
        while not self._halt.wait(NACHHOLEN_ALLE_S):
            start = self._start_faellig is not None and time.monotonic() >= self._start_faellig
            nacht = self._nacht_schluessel()
            if not (start or nacht) or not self.ruhig() or time.monotonic() < self._pause_bis:
                continue
            if not nas_bereit(self.wurzel):
                # NAS (noch) nicht eingehängt — die Freigaben sind dann leere Ordner: später erneut versuchen,
                # nicht aufgeben, nichts entfernen.
                if not nas_gemeldet:
                    log.warning("Archiv-Index wartet: keine lesbare Freigabe unter %s (NAS nicht gemountet?)", self.wurzel)
                    nas_gemeldet = True
                continue
            nas_gemeldet = False
            try:
                bilanz = self.lauf()
            except Exception:  # noqa: BLE001 — der Thread darf nie sterben
                log.exception("Archiv-Index: Lauf abgebrochen")
                continue
            if not bilanz.abgebrochen:
                self._start_faellig = None
                if nacht:
                    self._letzte_nacht = nacht
            elif bilanz.unvollstaendig or bilanz.entfernen_gebremst:
                # Freigabe fehlt/Bremse: nicht alle 30 s das ganze NAS ablaufen — in WIEDERHOLEN_UNVOLLSTAENDIG_S
                # erneut versuchen (Start-Lauf bleibt fällig; ein Nachtlauf im Fenster ebenso).
                self._pause_bis = time.monotonic() + WIEDERHOLEN_UNVOLLSTAENDIG_S

    def _warte_auf_ruhe(self) -> bool:
        """True, sobald der Worker ruht; False bei Halt."""
        while not self.ruhig():
            if self._halt.wait(2.0):
                return False
        return not self._halt.is_set()

    def lauf(self) -> Bilanz:
        """Ein inkrementeller Durchgang über das NAS. Gibt nur Zähler aus, nie Namen oder Inhalte."""
        self.laeuft = True
        try:
            return self._lauf()
        finally:
            self.laeuft = False

    def _lauf(self) -> Bilanz:
        b = Bilanz()
        t0 = time.monotonic()
        if not self.index.bereit():
            b.abgebrochen = True
            self.letzte_bilanz = b
            return b
        try:
            bestand = self.index.bestand()
        except Exception as e:  # noqa: BLE001
            log.warning("Archiv-Index: Bestand nicht lesbar (%s)", type(e).__name__)
            b.abgebrochen = True
            return b
        cfg_index = dataclasses.replace(
            self.cfg, ocr_max_seiten=self.cfg.index_ocr_seiten, pdf_max_seiten=min(self.cfg.pdf_max_seiten, 20),
        )
        # Je Freigabe: nur vollständig lesbare werden durchgegangen; für die anderen wird nichts entfernt.
        lesbar, unvollstaendig = freigaben_zustand(self.wurzel)
        b.unvollstaendig = len(unvollstaendig)
        if not lesbar:
            log.warning("Archiv-Index: keine lesbare Freigabe unter %s (NAS nicht gemountet?) — nichts geprüft, nichts entfernt", self.wurzel)
            b.abgebrochen = True
            self.letzte_bilanz = b
            return b
        if unvollstaendig:
            # Nur beim Wechsel der betroffenen Menge warnen — der Lauf wiederholt sich alle 30 s.
            if tuple(unvollstaendig) != self._unvollstaendig_gemeldet:
                log.warning(
                    "Archiv-Index: %d von %d Freigaben nicht vollständig lesbar (nicht eingehängt oder leer) — dort wird "
                    "nichts entfernt, der Lauf gilt als unterbrochen und wird wiederholt",
                    len(unvollstaendig), len(lesbar) + len(unvollstaendig),
                )
                self._unvollstaendig_gemeldet = tuple(unvollstaendig)
        else:
            self._unvollstaendig_gemeldet = ()
        unvoll_menge = set(unvollstaendig)
        gesehen: set[str] = set()
        for d in nas_dateien(self.wurzel, freigaben=lesbar):
            if self._halt.is_set():
                b.abgebrochen = True
                break
            gesehen.add(d.pfad)
            b.geprueft += 1
            alt = bestand.get(d.pfad)
            if alt and alt[0] == d.groesse and abs(alt[1] - d.mtime) < 1e-3 and alt[3] == self.index.rezept:
                b.unveraendert += 1
                continue
            if not self._warte_auf_ruhe():
                b.abgebrochen = True
                break
            try:
                self._eine(d, cfg_index, b)
            except Exception as e:  # noqa: BLE001 — nächste Datei; Art zählt, Name nie im Log
                b.fehler += 1
                log.warning("Archiv-Index: Datei übersprungen (%s)", type(e).__name__)
        if not b.abgebrochen:
            # Verschwundenes nur aus den vollständig gelesenen Freigaben — und nur, wenn das Mass plausibel ist.
            weg = [p for p in bestand if p not in gesehen and p.split("/", 1)[0] not in unvoll_menge]
            if weg and (b.geprueft == 0 or len(weg) >= ENTFERNEN_MAX_ANTEIL * len(bestand)):
                log.warning(
                    "Archiv-Index: %d von %d Einträgen auf einmal verschwunden (geprüft %d) — Bremse, nichts entfernt "
                    "(NAS unvollständig?)", len(weg), len(bestand), b.geprueft,
                )
                b.entfernen_gebremst = len(weg)
                b.abgebrochen = True
            else:
                try:
                    self.index.entferne(weg)
                    b.entfernt = len(weg)
                except Exception as e:  # noqa: BLE001
                    log.warning("Archiv-Index: Entfernen fehlgeschlagen (%s)", type(e).__name__)
            # Ordnerpfade vorab einbetten (fehlende in Stapeln) — sonst zahlt der erste Auftrag dafür;
            # Einbettungen verschwundener Ordner fallen nur bei vollständigem Durchgang weg.
            if self._warte_auf_ruhe():
                try:
                    ordner = nas_ordner(self.wurzel, freigaben=lesbar)
                    platz_fuer_einbettung(self.llm, self.cfg, grund="Archiv-Index", max_alter_s=5.0)
                    self.index.ordner_vektoren(
                        ordner, lambda texte: self.llm.einbetten(modell=self.cfg.modell_embed, texte=texte)[0],
                    )
                    if not unvollstaendig and not b.abgebrochen:
                        self.index.entferne_ordner_ausser(ordner)
                except Exception as e:  # noqa: BLE001
                    log.warning("Archiv-Index: Ordner-Einbettungen fehlgeschlagen (%s)", type(e).__name__)
        if unvollstaendig:
            b.abgebrochen = True
        b.gesamt_s = round(time.monotonic() - t0, 1)
        self.letzte_bilanz = b
        if not b.abgebrochen:
            self.letzter_lauf = _jetzt_iso()
        log.info(
            "Archiv-Index: %d Dateien geprüft — neu eingebettet %d, übernommen %d, unverändert %d, entfernt %d, "
            "ohne Text %d, OCR %d, Fehler %d; %.0f s (Text %.0f s, Einbettung %.0f s), Index %d Einträge%s%s",
            b.geprueft, b.neu, b.uebernommen, b.unveraendert, b.entfernt, b.ohne_text, b.ocr, b.fehler,
            b.gesamt_s, b.extraktion_s, b.einbettung_s, self.index.anzahl(),
            f" — {b.unvollstaendig} Freigabe(n) unvollständig" if b.unvollstaendig else "",
            " — unterbrochen" if b.abgebrochen else "",
        )
        return b

    def _eine(self, d: NasDatei, cfg_index: Einstellungen, b: Bilanz) -> None:
        sha = sha256_von(d.voll)
        if self.index.uebernehme(d, sha):
            b.uebernommen += 1
            return
        t = time.monotonic()
        text = ""
        try:
            extrakt = extrahiere(d.voll, None, d.name, cfg_index)
            text = extrakt.text
            b.ocr += 1 if extrakt.ocr else 0
        except ExtraktFehler:
            pass  # unlesbar (Passwort, zu gross, beschädigt): Vorbild nur über den Dateinamen
        b.extraktion_s += time.monotonic() - t
        if not text.strip():
            b.ohne_text += 1
        if not self._warte_auf_ruhe():
            raise InterruptedError("Halt")
        t = time.monotonic()
        # Derselbe VRAM-Schritt wie vor der Einbettung einer Ablage (handlers/ablage.py): knapper VRAM →
        # Sprachmodell entladen, sonst rechnet bge-m3 im Hauptspeicher. GPU-Auskunft höchstens 5 s alt.
        platz_fuer_einbettung(self.llm, self.cfg, grund="Archiv-Index", max_alter_s=5.0)
        try:
            [vektor], _meta = self.llm.einbetten(modell=self.cfg.modell_embed, texte=[einbettungstext(d.name, text)])
        except LlmFehler as e:
            raise RuntimeError(str(e)[:80]) from e
        b.einbettung_s += time.monotonic() - t
        self.index.speichere(d, sha, vektor)
        b.neu += 1
