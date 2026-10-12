"""Tiefen-Index: Volltext und Abschnitte aller NAS-Dateien im Tresor (Masterplan §2.7, E2.5).

Grundlage für die Inhaltssuche (nas_suche) und «Frag das Archiv» (archiv_frage). Anders als der Vorbilder-Index
(archiv.py, ohne Text, ohne ZZ_*) liest er ALLE lesbaren Freigaben — auch ZZ_* (jede Tiefe) und 06_PERSONAL
(Entscheid E4/E5: der NAS-Bereich ist nur Admin) —, nie 99_System und nie versteckte Einträge. Gespeichert wird im
db-Container (LUKS-Tresor):

  archiv_text        je Datei: Pfad, Grösse, mtime, sha256, Text-Rezept, Seiten, OCR, Sprache, Zeichen, Volltext
                     (mit den Seitenmarken «[Seite N]» aus extract.py) — einmal lesen, mehrfach nutzen.
  archiv_abschnitte  Abschnitte von ~800 Zeichen mit 120 Zeichen Überlappung, an Absatz- und Seitengrenzen, je mit
                     Seite, tsvector (german) und Einbettung (bge-m3, ohne Präfix).

Regeln wie beim Vorbilder-Index (SPEC §2.2): inkrementell (gleiche Grösse + mtime + Rezept = nichts tun, gleicher
sha256 an neuem Ort = Text und Abschnitte übernehmen), Entfernen nur aus vollständig gelesenen Freigaben und nie,
wenn auf einmal 50 % oder mehr des Bestands verschwinden (Bremse). Aufträge haben Vorrang: vor jeder Datei und
jedem Einbettungs-Stapel (≤ 32 Texte) wartet der Lauf 20 s Ruhe ab. Die Textextraktion (OCR) läuft in einem
eigenen Kindprozess mit nice 15, OMP_THREAD_LIMIT=2 und oom_score_adj 1000: bei Speichernot im Dienst-Container
stirbt zuerst dieser Prozess, nie der Dienst; die Umgebung des Live-Pfads (Ablage-OCR) bleibt unverändert.

Nie Inhalte oder Namen in Logs, Status oder Protokoll — nur Zähler.

Betrieb (im Dienst-Container):
    python -m app.tiefe status        Zähler des Tiefen-Index (keine Namen)
"""

from __future__ import annotations

import dataclasses
import json
import logging
import os
import re
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Collection, Iterable

from .archiv import ENDUNGEN, NasDatei, _jetzt_iso, _vektor_text, nfc, platz_fuer_einbettung, sha256_von
from .config import Einstellungen
from .llm import LlmFehler, Ollama

log = logging.getLogger("ki.tiefe")

TEXT_REZEPT_VERSION = "text/v1"
ABSCHNITT_REZEPT_VERSION = "abschnitt800-120/v1"
ABSCHNITT_ZEICHEN = 800
UEBERLAPPUNG = 120
# Abschnitte mit weniger Buchstaben/Ziffern sind Rauschen (Seitenzahl, Linien aus der OCR).
MIN_ZEICHEN_ABSCHNITT = 8
EINBETTUNG_STAPEL = 32
RUHE_S = 20.0
ENTFERNEN_MAX_ANTEIL = 0.5
# Kindprozess der Textextraktion: höchstens so lange (ocrmypdf und der Notnagel haben je 600 s).
KIND_TIMEOUT_S = 1500.0
# Vorübergehende Lesefehler (Zeitgrenze, Kindprozess vom Kernel beendet, unbrauchbare Ausgabe) gelten nicht als
# gelesen: die Zeile bekommt einen Versuchszähler, und die Datei wird frühestens nach VERSUCH_ABSTAND_S (also in
# der nächsten Nacht, nicht in der 10-min-Wiederholung derselben Nacht) erneut gelesen, höchstens
# MAX_LESEVERSUCHE Mal. «unlesbar» (Passwort, beschädigt, zu gross) bleibt endgültig bis zur nächsten Änderung.
MAX_LESEVERSUCHE = 3
VERSUCH_ABSTAND_S = 6 * 3600.0
# Wort-Anker der Suche (kennt_woerter): Teilstücke/Präfixe ab so vielen Buchstaben. Kalibriert 12.10.: mit 5 hat keine
# von 290 zufälligen Unsinn-Zeichenfolgen einen Teilwort- oder Präfix-Anker (README «Mindest-Ähnlichkeit»).
ANKER_TEILWORT = 5
APP_WURZEL = Path(__file__).resolve().parents[1]
# Austauschbar für Tests (Attrappen-NAS ohne Mount-Punkte).
_ismount = os.path.ismount

_SEITENMARKE = re.compile(r"^\[Seite (\d{1,6})\]$", re.M)
_GEKUERZT = re.compile(r"\n*\[Text gekürzt: [^\]\n]*\]\s*$")
_ABSATZ = re.compile(r"\n\s*\n")
_WORTZEICHEN = re.compile(r"[^\W_]", re.U)


# --- Regeln: was gelesen wird ---------------------------------------------------------------------


def voruebergehend(fehler: str | None) -> bool:
    """«zeit», «kind_-9» (OOM-Kill), «kind_1», «kind_ausgabe» … — ein erneuter Versuch kann gelingen."""
    return fehler is not None and (fehler == "zeit" or fehler.startswith("kind_"))


def ausgeschlossen(name: str) -> bool:
    """Nie im Tiefen-Index: versteckte Einträge und 99_System (jede Tiefe). ZZ_* gehört dazu (anders als beim
    Vorbilder-Index), ebenso 06_PERSONAL (Masterplan E4/E5)."""
    return name.startswith((".", "@", "#", "~$")) or name == "99_System"


def freigaben_zustand(wurzel: Path) -> tuple[list[str], list[str]]:
    """(lesbar, unvollständig) — wie archiv.freigaben_zustand, aber inklusive ZZ_*-Freigaben.

    Unvollständig: nicht lesbar, ohne jeden Eintrag (nicht eingehängt — auf dem Rig ist jede Freigabe ein eigener
    CIFS-Mount auf einem leeren Ordner) oder kein Mount-Punkt, obwohl andere Freigaben einer sind."""
    try:
        eintraege = sorted(wurzel.iterdir(), key=lambda p: p.name.lower())
    except OSError:
        return [], []
    freigaben: list[Path] = []
    for e in eintraege:
        try:
            if e.is_dir() and not ausgeschlossen(e.name):
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
    return bool(freigaben_zustand(wurzel)[0])


def dateien(wurzel: Path, freigaben: Collection[str]) -> tuple[list[NasDatei], set[str]]:
    """Alle lesbaren Dateien der genannten Freigaben (auch in der Freigabe-Wurzel, auch unter ZZ_*), NFC.
    Liefert zusätzlich die Freigaben, in denen ein Unterordner nicht lesbar war — dort ist der Durchgang nicht
    vollständig, es wird nichts entfernt (anders als nas_dateien() im Vorbilder-Index, der solche Fehler still
    überspringt)."""
    aus: list[NasDatei] = []
    fehlerhaft: set[str] = set()

    def gehe(ordner: Path, rel: tuple[str, ...]) -> None:
        try:
            eintraege = sorted(ordner.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            fehlerhaft.add(rel[0])
            return
        for e in eintraege:
            if ausgeschlossen(e.name):
                continue
            try:
                if e.is_dir():
                    gehe(e, rel + (e.name,))
                    continue
                if e.suffix.lower() not in ENDUNGEN or not e.is_file():
                    continue
                st = e.stat()
            except OSError:
                fehlerhaft.add(rel[0])
                continue
            ordner_rel = nfc("/".join(rel))
            aus.append(NasDatei(
                pfad=f"{ordner_rel}/{nfc(e.name)}", ordner=ordner_rel, name=nfc(e.name), voll=e,
                groesse=int(st.st_size), mtime=float(st.st_mtime),
            ))

    for f in sorted(freigaben, key=str.lower):
        if ausgeschlossen(f):
            continue
        gehe(wurzel / f, (f,))
    return aus, fehlerhaft


# --- Abschnitte -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class Abschnitt:
    nr: int
    seite: int | None
    text: str


def seiten(text: str) -> list[tuple[int | None, str]]:
    """Text mit Seitenmarken «[Seite N]» (extract.py, PDF/Bild) → [(Seite, Text)]; ohne Marken eine Seite None."""
    text = _GEKUERZT.sub("", text or "")
    teile = _SEITENMARKE.split(text)
    aus: list[tuple[int | None, str]] = []
    if teile[0].strip():
        aus.append((None, teile[0]))
    for i in range(1, len(teile) - 1, 2):
        if teile[i + 1].strip():
            aus.append((int(teile[i]), teile[i + 1]))
    return aus


def _stuecke(text: str, groesse: int) -> list[str]:
    """Absätze; überlange Absätze an Wortgrenzen in Stücke von höchstens `groesse` Zeichen."""
    aus: list[str] = []
    for absatz in _ABSATZ.split(text):
        absatz = absatz.strip()
        if not absatz:
            continue
        while len(absatz) > groesse:
            schnitt = absatz.rfind(" ", 0, groesse + 1)
            if schnitt < groesse // 2:
                schnitt = absatz.rfind("\n", 0, groesse + 1)
            if schnitt < groesse // 2:
                schnitt = groesse
            aus.append(absatz[:schnitt].strip())
            absatz = absatz[schnitt:].strip()
        if absatz:
            aus.append(absatz)
    return aus


def _schwanz(text: str, n: int) -> str:
    """Die letzten ~n Zeichen, an einer Wortgrenze beginnend (Überlappung zum nächsten Abschnitt)."""
    if n <= 0 or len(text) <= n:
        return ""
    stueck = text[-n:]
    i = stueck.find(" ")
    return stueck[i + 1:] if 0 <= i < len(stueck) - 1 else stueck


def _zaehlt(text: str) -> bool:
    return len(_WORTZEICHEN.findall(text)) >= MIN_ZEICHEN_ABSCHNITT


def zerlege(text: str, *, zeichen: int = ABSCHNITT_ZEICHEN, ueberlappung: int = UEBERLAPPUNG) -> list[Abschnitt]:
    """Abschnitte von ~`zeichen` Zeichen; jeder (ausser dem ersten einer Seite) beginnt mit den letzten
    ~`ueberlappung` Zeichen des vorigen. Nie über eine Seitengrenze — so stimmt die Seite jedes Abschnitts."""
    aus: list[Abschnitt] = []
    for seite, inhalt in seiten(text):
        aktuell = ""
        for stueck in _stuecke(inhalt, max(100, zeichen - ueberlappung)):
            if aktuell and len(aktuell) + 2 + len(stueck) > zeichen:
                if _zaehlt(aktuell):
                    aus.append(Abschnitt(len(aus), seite, aktuell))
                schwanz = _schwanz(aktuell, ueberlappung)
                aktuell = f"{schwanz} {stueck}" if schwanz else stueck
            else:
                aktuell = f"{aktuell}\n\n{stueck}" if aktuell else stueck
        if aktuell and _zaehlt(aktuell):
            aus.append(Abschnitt(len(aus), seite, aktuell))
    return aus


def text_rezept(cfg: Einstellungen) -> str:
    return f"{TEXT_REZEPT_VERSION}|ocr{cfg.tiefe_ocr_seiten}|z{cfg.tiefe_max_zeichen}"


def abschnitt_rezept(cfg: Einstellungen) -> str:
    return f"{cfg.modell_embed}|{ABSCHNITT_REZEPT_VERSION}"


# --- Datenbank ------------------------------------------------------------------------------------

DDL = """
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS archiv_text (
  pfad               text PRIMARY KEY,
  ordner             text        NOT NULL,
  name               text        NOT NULL,
  groesse            bigint      NOT NULL,
  mtime              double precision NOT NULL,
  sha256             text        NOT NULL,
  rezept_text        text        NOT NULL,
  rezept_abschnitte  text,
  seiten             integer,
  ocr                boolean     NOT NULL DEFAULT false,
  sprache            text,
  zeichen            integer     NOT NULL DEFAULT 0,
  text               text        NOT NULL DEFAULT '',
  fehler             text,
  extrahiert         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS archiv_text_sha_idx ON archiv_text (sha256);
-- Versuche nach vorübergehendem Lesefehler (0 = gelesen oder endgültig unlesbar). Nur anlegen, wenn sie fehlt:
-- ADD COLUMN IF NOT EXISTS nähme bei jeder neuen Verbindung (auch der Suche) eine exklusive Sperre.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                 AND table_name = 'archiv_text' AND column_name = 'versuche') THEN
    ALTER TABLE archiv_text ADD COLUMN versuche integer NOT NULL DEFAULT 0;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS archiv_abschnitte (
  id          bigserial PRIMARY KEY,
  pfad        text    NOT NULL REFERENCES archiv_text (pfad) ON DELETE CASCADE ON UPDATE CASCADE,
  nr          integer NOT NULL,
  seite       integer,
  text        text    NOT NULL,
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('german', text)) STORED,
  rezept      text    NOT NULL,
  einbettung  vector  NOT NULL,
  UNIQUE (pfad, nr)
);
CREATE INDEX IF NOT EXISTS archiv_abschnitte_tsv_idx ON archiv_abschnitte USING GIN (tsv);
CREATE INDEX IF NOT EXISTS archiv_abschnitte_pfad_idx ON archiv_abschnitte (pfad);
"""


@dataclass(frozen=True)
class Bestand:
    groesse: int
    mtime: float
    sha256: str
    rezept_text: str
    rezept_abschnitte: str | None
    fehler: str | None = None
    versuche: int = 0
    alter_s: float | None = None    # Sekunden seit der letzten Extraktion

    @property
    def wartet_auf_versuch(self) -> bool:
        """Vorübergehend gescheitert und noch Versuche übrig."""
        return 0 < self.versuche < MAX_LESEVERSUCHE


@dataclass(frozen=True)
class Text:
    """Ergebnis der Extraktion (Kindprozess) — der Text bleibt im Tresor."""

    text: str
    seiten: int | None = None
    ocr: bool = False
    fehler: str | None = None   # Code, nie ein Name: «unlesbar», «zeit», «kind_-9» …


@dataclass(frozen=True)
class Fund:
    """Ein Abschnitt aus einer Suchliste (ohne Text)."""

    id: int
    pfad: str
    seite: int | None
    wert: float     # Vektor: Kosinus-Ähnlichkeit; Volltext: ts_rank


class TiefenIndex:
    """Tabellen archiv_text / archiv_abschnitte. Eigene Verbindung je Instanz (Indexlauf und Suche getrennt,
    damit eine Suche nie hinter einem Schreibvorgang wartet). statement_timeout_ms: nur für die Suche."""

    def __init__(self, dsn: str | None, *, statement_timeout_ms: int | None = None) -> None:
        self._dsn = dsn
        self._timeout = statement_timeout_ms
        self._lock = threading.Lock()
        self._conn = None
        self._letzter_versuch = 0.0
        self._zaehler_cache: tuple[float, dict[str, int]] = (0.0, {})

    @property
    def aktiv(self) -> bool:
        return self._dsn is not None

    def _verbindung(self):
        import psycopg

        if self._conn is not None and not self._conn.closed:
            return self._conn
        if time.monotonic() - self._letzter_versuch < 30:
            raise ConnectionError("Tiefen-Index-DB kurz zuvor nicht erreichbar")
        self._letzter_versuch = time.monotonic()
        extra = {"options": f"-c statement_timeout={int(self._timeout)}"} if self._timeout else {}
        self._conn = psycopg.connect(self._dsn, autocommit=True, **extra)
        with self._conn.cursor() as c:
            c.execute(DDL)
        return self._conn

    def _mit(self, arbeit: Callable[[object], object]) -> object:
        """arbeit(conn) unter dem Lock; bei Fehler Verbindung verwerfen und weiterwerfen."""
        if not self._dsn:
            return None
        with self._lock:
            try:
                return arbeit(self._verbindung())
            except Exception:
                if self._conn is not None:
                    try:
                        self._conn.close()
                    except Exception:  # noqa: BLE001
                        pass
                self._conn = None
                raise

    def _ausfuehren(self, sql: str, werte: tuple = (), *, holen: bool = False) -> list[tuple]:
        def arbeit(conn) -> list[tuple]:  # noqa: ANN001
            with conn.cursor() as c:
                c.execute(sql, werte)
                return list(c.fetchall()) if holen else []

        return self._mit(arbeit) or []  # type: ignore[return-value]

    def bereit(self) -> bool:
        try:
            self._ausfuehren("SELECT 1", holen=True)
            return True
        except Exception as e:  # noqa: BLE001
            log.warning("Tiefen-Index nicht bereit (%s)", type(e).__name__)
            return False

    # --- Indexlauf ---------------------------------------------------------------------------

    def bestand(self) -> dict[str, Bestand]:
        zeilen = self._ausfuehren(
            """SELECT pfad, groesse, mtime, sha256, rezept_text, rezept_abschnitte, fehler, versuche,
                      extract(epoch FROM now() - extrahiert) FROM archiv_text""",
            holen=True,
        )
        return {
            z[0]: Bestand(int(z[1]), float(z[2]), str(z[3]), str(z[4]), z[5], z[6], int(z[7] or 0),
                          None if z[8] is None else float(z[8]))
            for z in zeilen
        }

    def uebernehme(self, d: NasDatei, sha: str, rezept_text: str, rezept_abschnitte: str) -> bool:
        """Text und Abschnitte einer gleichen Datei (sha256, gleiche Rezepte) übernehmen — verschoben/kopiert."""

        def arbeit(conn) -> bool:  # noqa: ANN001
            with conn.transaction(), conn.cursor() as c:
                c.execute(
                    """SELECT pfad FROM archiv_text WHERE sha256 = %s AND rezept_text = %s AND rezept_abschnitte = %s
                       AND versuche = 0 AND pfad <> %s LIMIT 1""",
                    (sha, rezept_text, rezept_abschnitte, d.pfad),
                )
                z = c.fetchone()
                if not z:
                    return False
                quelle = z[0]
                c.execute(
                    """INSERT INTO archiv_text (pfad, ordner, name, groesse, mtime, sha256, rezept_text, rezept_abschnitte,
                         seiten, ocr, sprache, zeichen, text, fehler, extrahiert)
                       SELECT %s, %s, %s, %s, %s, sha256, rezept_text, rezept_abschnitte, seiten, ocr, sprache, zeichen,
                         text, fehler, now() FROM archiv_text WHERE pfad = %s
                       ON CONFLICT (pfad) DO UPDATE SET ordner = EXCLUDED.ordner, name = EXCLUDED.name,
                         groesse = EXCLUDED.groesse, mtime = EXCLUDED.mtime, sha256 = EXCLUDED.sha256,
                         rezept_text = EXCLUDED.rezept_text, rezept_abschnitte = EXCLUDED.rezept_abschnitte,
                         seiten = EXCLUDED.seiten, ocr = EXCLUDED.ocr, sprache = EXCLUDED.sprache,
                         zeichen = EXCLUDED.zeichen, text = EXCLUDED.text, fehler = EXCLUDED.fehler,
                         versuche = 0, extrahiert = now()""",
                    (d.pfad, d.ordner, d.name, d.groesse, d.mtime, quelle),
                )
                c.execute("DELETE FROM archiv_abschnitte WHERE pfad = %s", (d.pfad,))
                c.execute(
                    """INSERT INTO archiv_abschnitte (pfad, nr, seite, text, rezept, einbettung)
                       SELECT %s, nr, seite, text, rezept, einbettung FROM archiv_abschnitte WHERE pfad = %s""",
                    (d.pfad, quelle),
                )
                return True

        return bool(self._mit(arbeit))

    def speichere(
        self, d: NasDatei, sha: str, t: Text, sprache: str | None, abschnitte: list[Abschnitt],
        vektoren: list[list[float]], rezept_text: str, rezept_abschnitte: str,
    ) -> None:
        """Volltext + Abschnitte einer Datei in einem Zug (alte Abschnitte weg)."""
        if len(abschnitte) != len(vektoren):
            raise ValueError("Abschnitte und Einbettungen passen nicht zusammen")

        def arbeit(conn) -> None:  # noqa: ANN001
            with conn.transaction(), conn.cursor() as c:
                c.execute(
                    """INSERT INTO archiv_text (pfad, ordner, name, groesse, mtime, sha256, rezept_text, rezept_abschnitte,
                         seiten, ocr, sprache, zeichen, text, fehler)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT (pfad) DO UPDATE SET ordner = EXCLUDED.ordner, name = EXCLUDED.name,
                         groesse = EXCLUDED.groesse, mtime = EXCLUDED.mtime, sha256 = EXCLUDED.sha256,
                         rezept_text = EXCLUDED.rezept_text, rezept_abschnitte = EXCLUDED.rezept_abschnitte,
                         seiten = EXCLUDED.seiten, ocr = EXCLUDED.ocr, sprache = EXCLUDED.sprache,
                         zeichen = EXCLUDED.zeichen, text = EXCLUDED.text, fehler = EXCLUDED.fehler,
                         versuche = 0, extrahiert = now()""",
                    (d.pfad, d.ordner, d.name, d.groesse, d.mtime, sha, rezept_text, rezept_abschnitte, t.seiten,
                     bool(t.ocr), sprache, len(t.text), t.text, t.fehler),
                )
                self._abschnitte_schreiben(c, d.pfad, abschnitte, vektoren, rezept_abschnitte)

        self._mit(arbeit)

    def vormerken(self, d: NasDatei, sha: str, fehler: str, versuche: int, rezept_text: str) -> None:
        """Vorübergehender Lesefehler: Zeile ohne Text mit Fehlercode und Versuchszähler (gilt nicht als gelesen,
        wird nie übernommen); alte Abschnitte weg — sie gehörten zu einem anderen Stand der Datei."""

        def arbeit(conn) -> None:  # noqa: ANN001
            with conn.transaction(), conn.cursor() as c:
                c.execute(
                    """INSERT INTO archiv_text (pfad, ordner, name, groesse, mtime, sha256, rezept_text, rezept_abschnitte,
                         seiten, ocr, sprache, zeichen, text, fehler, versuche)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, NULL, NULL, false, NULL, 0, '', %s, %s)
                       ON CONFLICT (pfad) DO UPDATE SET ordner = EXCLUDED.ordner, name = EXCLUDED.name,
                         groesse = EXCLUDED.groesse, mtime = EXCLUDED.mtime, sha256 = EXCLUDED.sha256,
                         rezept_text = EXCLUDED.rezept_text, rezept_abschnitte = NULL, seiten = NULL, ocr = false,
                         sprache = NULL, zeichen = 0, text = '', fehler = EXCLUDED.fehler,
                         versuche = EXCLUDED.versuche, extrahiert = now()""",
                    (d.pfad, d.ordner, d.name, d.groesse, d.mtime, sha, rezept_text, fehler, int(versuche)),
                )
                c.execute("DELETE FROM archiv_abschnitte WHERE pfad = %s", (d.pfad,))

        self._mit(arbeit)

    def text_von(self, pfad: str) -> str | None:
        z = self._ausfuehren("SELECT text FROM archiv_text WHERE pfad = %s", (pfad,), holen=True)
        return str(z[0][0]) if z else None

    def speichere_abschnitte(
        self, pfad: str, abschnitte: list[Abschnitt], vektoren: list[list[float]], rezept_abschnitte: str,
    ) -> None:
        """Nur neu zerlegt/eingebettet (Rezept der Abschnitte geändert, Text gleich)."""
        if len(abschnitte) != len(vektoren):
            raise ValueError("Abschnitte und Einbettungen passen nicht zusammen")

        def arbeit(conn) -> None:  # noqa: ANN001
            with conn.transaction(), conn.cursor() as c:
                self._abschnitte_schreiben(c, pfad, abschnitte, vektoren, rezept_abschnitte)
                c.execute("UPDATE archiv_text SET rezept_abschnitte = %s WHERE pfad = %s", (rezept_abschnitte, pfad))

        self._mit(arbeit)

    @staticmethod
    def _abschnitte_schreiben(c, pfad: str, abschnitte: list[Abschnitt], vektoren: list[list[float]], rezept: str) -> None:  # noqa: ANN001
        c.execute("DELETE FROM archiv_abschnitte WHERE pfad = %s", (pfad,))
        if abschnitte:
            c.executemany(
                "INSERT INTO archiv_abschnitte (pfad, nr, seite, text, rezept, einbettung) VALUES (%s, %s, %s, %s, %s, %s::vector)",
                [(pfad, a.nr, a.seite, a.text, rezept, _vektor_text(v)) for a, v in zip(abschnitte, vektoren)],
            )

    def entferne(self, pfade: Collection[str]) -> None:
        if pfade:
            # Abschnitte fallen per ON DELETE CASCADE mit weg.
            self._ausfuehren("DELETE FROM archiv_text WHERE pfad = ANY(%s)", (list(pfade),))

    def zaehler(self, max_alter_s: float = 0.0) -> dict[str, int]:
        """Gelesene Dateien (ohne vorübergehend gescheiterte), davon mit Text, Abschnitte, dazu wartende und
        aufgegebene Leseversuche — für /health und gelesen_anteil (höchstens max_alter_s alt)."""
        zeit, wert = self._zaehler_cache
        if max_alter_s > 0 and wert and (time.monotonic() - zeit < max_alter_s or self._lock.locked()):
            # /health wartet nie auf einen Schreibvorgang des Indexlaufs — dann gilt der letzte Wert.
            return dict(wert)
        try:
            z = self._ausfuehren(
                """SELECT count(*) FILTER (WHERE versuche = 0), count(*) FILTER (WHERE versuche = 0 AND zeichen > 0),
                          (SELECT count(*) FROM archiv_abschnitte),
                          count(*) FILTER (WHERE versuche > 0 AND versuche < %s), count(*) FILTER (WHERE versuche >= %s)
                   FROM archiv_text""",
                (MAX_LESEVERSUCHE, MAX_LESEVERSUCHE),
                holen=True,
            )
        except Exception:  # noqa: BLE001 — letzter bekannter Wert
            return dict(wert)
        if z:
            wert = {"dateien": int(z[0][0]), "mit_text": int(z[0][1]), "abschnitte": int(z[0][2]),
                    "lesen_wiederholen": int(z[0][3]), "lesen_aufgegeben": int(z[0][4])}
            self._zaehler_cache = (time.monotonic(), wert)
        return dict(wert)

    # --- Suche (nur Pfad, Seite, Wert — der Text bleibt hier) -------------------------------------

    def vektor_treffer(self, vektor: list[float], rezept: str, k: int) -> list[Fund]:
        q = _vektor_text(vektor)
        zeilen = self._ausfuehren(
            """SELECT id, pfad, seite, 1 - (einbettung <=> %s::vector) FROM archiv_abschnitte WHERE rezept = %s
               ORDER BY einbettung <=> %s::vector, id LIMIT %s""",
            (q, rezept, q, int(k)), holen=True,
        )
        return [Fund(int(z[0]), str(z[1]), z[2], float(z[3])) for z in zeilen]

    def text_treffer(self, anfrage: str, rezept: str, k: int) -> list[Fund]:
        zeilen = self._ausfuehren(
            """SELECT a.id, a.pfad, a.seite, ts_rank(a.tsv, q) FROM archiv_abschnitte a,
                      websearch_to_tsquery('german', %s) q
               WHERE a.rezept = %s AND a.tsv @@ q ORDER BY 4 DESC, a.id LIMIT %s""",
            (anfrage, rezept, int(k)), holen=True,
        )
        return [Fund(int(z[0]), str(z[1]), z[2], float(z[3])) for z in zeilen]

    def kennt_woerter(self, anfrage: str, rezept: str) -> bool:
        """Wort-Anker der Inhaltssuche gegen Unsinn (suche.filtere): hat die Anfrage (Lexeme nach 'german',
        Stoppwörter fallen weg) einen Anker im Index? Anker ist
          - ein ganzes Lexem der Anfrage (wie bisher; auch kurze Wörter und Zahlen),
          - ein Index-Lexem mit ≥ ANKER_TEILWORT Buchstaben als Teilstück eines Anfrage-Lexems (Komposita:
            «Spesenabrechnung» → «abrechn»; fängt auch viele Tippfehler: «Mitvertrag» → «vertrag»),
          - ein Anfrage-Lexem mit ≥ ANKER_TEILWORT Buchstaben als Anfang eines Index-Lexems (halb getippt:
            «Mietvert», «Stornierung» → «storni…»).
        Eine einzige tsquery über den GIN-Index (gemessen 12.10.: echte Anfragen Median 3,5 ms, höchstens 20 ms;
        künstlicher Extremfall 200 bzw. 500 Zeichen aus zufälligen 40-Buchstaben-Wörtern 0,5 bzw. 0,9 s). Teilstücke und Präfixe nur aus reinen Buchstaben-Lexemen bis 40 Zeichen (nie Zahlen, keine
        Riesenmenge Teilstücke); ganze Lexeme über plainto_tsquery('simple') — nie Operatoren aus der Anfrage,
        nie ein Syntaxfehler. Ohne Lexem false."""
        zeilen = self._ausfuehren(
            """WITH l AS (SELECT w FROM unnest(tsvector_to_array(to_tsvector('german', %(q)s))) w),
                    b AS (SELECT w FROM l WHERE length(w) BETWEEN %(n)s AND 40 AND w ~ '^[[:alpha:]]+$'),
                    teile AS (
                      SELECT plainto_tsquery('simple', w)::text AS t FROM l
                      UNION SELECT quote_literal(w) || ':*' FROM b
                      UNION SELECT quote_literal(substr(w, i, k)) FROM b, generate_series(1, length(w)) i,
                               generate_series(%(n)s, length(w)) k WHERE i + k - 1 <= length(w))
               SELECT EXISTS (SELECT 1 FROM archiv_abschnitte a WHERE a.rezept = %(r)s
                              AND a.tsv @@ (SELECT string_agg('(' || t || ')', ' | ')::tsquery FROM teile WHERE t <> ''))""",
            {"q": anfrage, "r": rezept, "n": ANKER_TEILWORT}, holen=True,
        )
        return bool(zeilen and zeilen[0][0])

    def abschnitt_texte(self, ids: Iterable[int]) -> dict[int, str]:
        """Texte der Abschnitte — nur für «Frag das Archiv» (Antwort lokal), nie an das FSM."""
        liste = [int(i) for i in ids]
        if not liste:
            return {}
        zeilen = self._ausfuehren("SELECT id, text FROM archiv_abschnitte WHERE id = ANY(%s)", (liste,), holen=True)
        return {int(z[0]): str(z[1]) for z in zeilen}

    def schliessen(self) -> None:
        with self._lock:
            if self._conn is not None:
                try:
                    self._conn.close()
                except Exception:  # noqa: BLE001
                    pass
                self._conn = None


# --- Textextraktion im Kindprozess ----------------------------------------------------------------


def extrahiere_isoliert(d: NasDatei, cfg: Einstellungen, halt: threading.Event) -> Text:
    """Text einer NAS-Datei in einem eigenen Prozess (python -m app.tiefe extrakt …): nice 15,
    OMP_THREAD_LIMIT=2 (Tesseract), oom_score_adj 1000. Der Text kommt über die Pipe (nie auf die Platte).
    Bei Halt oder nach KIND_TIMEOUT_S wird die ganze Prozessgruppe (auch ocrmypdf/tesseract) beendet."""
    befehl = [
        sys.executable, "-m", "app.tiefe", "extrakt", str(d.voll), d.name,
        str(cfg.tiefe_ocr_seiten), str(cfg.tiefe_max_zeichen),
    ]
    umgebung = dict(os.environ, OMP_THREAD_LIMIT="2")
    p = subprocess.Popen(
        befehl, cwd=str(APP_WURZEL), env=umgebung, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, start_new_session=True,
    )
    frist = time.monotonic() + KIND_TIMEOUT_S
    while True:
        try:
            ausgabe, _ = p.communicate(timeout=1.0)
            break
        except subprocess.TimeoutExpired:
            if halt.is_set() or time.monotonic() >= frist:
                try:
                    os.killpg(p.pid, signal.SIGKILL)
                except OSError:
                    p.kill()
                p.communicate()
                if halt.is_set():
                    raise InterruptedError("Halt")
                return Text("", fehler="zeit")
    if p.returncode != 0:
        return Text("", fehler=f"kind_{p.returncode}")
    try:
        daten = json.loads(ausgabe.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return Text("", fehler="kind_ausgabe")
    seiten_wert = daten.get("seiten")
    return Text(
        text=str(daten.get("text") or ""),
        seiten=int(seiten_wert) if isinstance(seiten_wert, int) else None,
        ocr=bool(daten.get("ocr")),
        fehler=(str(daten["fehler"])[:40] if daten.get("fehler") else None),
    )


def _kind_extrakt(argv: list[str]) -> int:
    """Kindprozess: eine Datei lesen, JSON auf stdout. Senkt zuerst die eigene Priorität und macht sich zum
    ersten Opfer bei Speichernot (beides vererbt sich an ocrmypdf/tesseract)."""
    try:
        os.setpriority(os.PRIO_PROCESS, 0, 15)
    except (AttributeError, OSError):
        pass
    try:
        with open("/proc/self/oom_score_adj", "w", encoding="ascii") as f:
            f.write("1000")
    except OSError:
        pass
    os.environ["OMP_THREAD_LIMIT"] = "2"
    logging.basicConfig(level=logging.ERROR)
    from .config import EINSTELLUNGEN
    from .extract import ExtraktFehler, extrahiere

    pfad, name, ocr_seiten, max_zeichen = argv[0], argv[1], int(argv[2]), int(argv[3])
    cfg = dataclasses.replace(EINSTELLUNGEN, ocr_max_seiten=ocr_seiten, max_text_zeichen=max_zeichen)
    try:
        e = extrahiere(Path(pfad), None, name, cfg)
        aus = {"text": e.text, "seiten": e.seiten, "ocr": bool(e.ocr), "fehler": None}
    except ExtraktFehler:
        aus = {"text": "", "seiten": None, "ocr": False, "fehler": "unlesbar"}
    sys.stdout.write(json.dumps(aus, ensure_ascii=False))
    sys.stdout.flush()
    return 0


# --- Indexlauf ------------------------------------------------------------------------------------


@dataclass
class Bilanz:
    nas_dateien: int = 0
    unveraendert: int = 0
    neu: int = 0
    uebernommen: int = 0
    neu_zerlegt: int = 0
    ohne_text: int = 0
    ocr: int = 0
    fehler: int = 0
    entfernt: int = 0
    abschnitte: int = 0
    offen: int = 0              # nicht mehr geschafft (Zeitbudget/Nachtende) — nächste Nacht
    wiederholen: int = 0        # vorübergehend gescheitert, nächster Versuch noch nicht fällig
    gesamt_s: float = 0.0
    abgebrochen: bool = False   # Halt oder DB weg: nichts entfernt
    frist_erreicht: bool = False
    unvollstaendig: int = 0
    entfernen_gebremst: int = 0
    fehler_arten: dict[str, int] = field(default_factory=dict)

    @property
    def vollstaendig(self) -> bool:
        """Alles gelesen, nichts offen, alle Freigaben vollständig — für diese Nacht fertig."""
        return not (self.abgebrochen or self.frist_erreicht or self.unvollstaendig or self.entfernen_gebremst or self.offen)

    def kurz(self) -> dict[str, object]:
        return {
            "nas_dateien": self.nas_dateien, "neu": self.neu, "uebernommen": self.uebernommen,
            "neu_zerlegt": self.neu_zerlegt, "unveraendert": self.unveraendert, "ohne_text": self.ohne_text,
            "ocr": self.ocr, "fehler": self.fehler, "entfernt": self.entfernt, "abschnitte": self.abschnitte,
            "offen": self.offen, "wiederholen": self.wiederholen, "dauer_s": self.gesamt_s, "unterbrochen": self.abgebrochen,
            "frist_erreicht": self.frist_erreicht, "freigaben_unvollstaendig": self.unvollstaendig,
            "entfernen_gebremst": self.entfernen_gebremst,
        }


Extraktor = Callable[[NasDatei, Einstellungen, threading.Event], Text]


class TiefenIndexierer:
    """Ein Durchgang über alle Freigaben (vom Planer-Thread jobs/tiefe.py nachts aufgerufen)."""

    def __init__(
        self,
        cfg: Einstellungen,
        index: TiefenIndex,
        llm: Ollama,
        ruhig: Callable[[], bool],
        *,
        wurzel: Path | None = None,
        extraktor: Extraktor = extrahiere_isoliert,
        vorrang: Callable[[], bool] = lambda: False,
    ) -> None:
        self.cfg = cfg
        self.index = index
        self.llm = llm
        self.ruhig = ruhig
        # vorrang(): z. B. der Vorbilder-Index läuft gerade — dann wartet der Tiefen-Index wie bei einem Auftrag.
        self.vorrang = vorrang
        self.wurzel = wurzel or cfg.nas_wurzel
        self.extraktor = extraktor
        self.halt = threading.Event()
        self.rezept_text = text_rezept(cfg)
        self.rezept_abschnitte = abschnitt_rezept(cfg)
        self.laeuft = False
        self.letzte_bilanz: Bilanz | None = None
        self.letzter_lauf: str | None = None

    def stop(self) -> None:
        self.halt.set()

    def _warte_auf_ruhe(self) -> bool:
        """True, sobald kein Auftrag läuft/wartet (20 s) und nichts Vorrang hat; False bei Halt."""
        while not self.ruhig() or self.vorrang():
            if self.halt.wait(2.0):
                return False
        return not self.halt.is_set()

    def lauf(self, *, frist: float | None = None, weiter: Callable[[], bool] = lambda: True) -> Bilanz:
        """frist: time.monotonic(), bis wann gelesen werden darf (Zeitbudget der Nacht); weiter(): False beendet
        das Lesen nach der laufenden Datei (z. B. 06:45). Entfernt wird trotzdem (der Durchgang war vollständig)."""
        self.laeuft = True
        try:
            return self._lauf(frist, weiter)
        finally:
            self.laeuft = False

    def _lauf(self, frist: float | None, weiter: Callable[[], bool]) -> Bilanz:
        b = Bilanz()
        t0 = time.monotonic()
        if not self.index.bereit():
            b.abgebrochen = True
            self.letzte_bilanz = b
            return b
        try:
            bestand = self.index.bestand()
        except Exception as e:  # noqa: BLE001
            log.warning("Tiefen-Index: Bestand nicht lesbar (%s)", type(e).__name__)
            b.abgebrochen = True
            self.letzte_bilanz = b
            return b
        lesbar, unvollstaendig = freigaben_zustand(self.wurzel)
        if not lesbar:
            log.warning("Tiefen-Index: keine lesbare Freigabe (NAS nicht gemountet?) — nichts gelesen, nichts entfernt")
            b.abgebrochen = True
            b.unvollstaendig = len(unvollstaendig)
            self.letzte_bilanz = b
            return b
        liste, fehlerhaft = dateien(self.wurzel, lesbar)
        unvoll = set(unvollstaendig) | fehlerhaft
        b.unvollstaendig = len(unvoll)
        b.nas_dateien = len(liste)
        gesehen = {d.pfad for d in liste}
        arbeit: list[tuple[NasDatei, str]] = []
        for d in liste:
            alt = bestand.get(d.pfad)
            if alt and alt.groesse == d.groesse and abs(alt.mtime - d.mtime) < 1e-3 and alt.rezept_text == self.rezept_text:
                if alt.wartet_auf_versuch:
                    if alt.alter_s is None or alt.alter_s >= VERSUCH_ABSTAND_S:
                        arbeit.append((d, "lesen"))
                    else:
                        b.wiederholen += 1
                elif alt.rezept_abschnitte == self.rezept_abschnitte or alt.versuche:
                    # (versuche ≥ MAX: aufgegeben, bis sich die Datei oder das Text-Rezept ändert)
                    b.unveraendert += 1
                else:
                    arbeit.append((d, "zerlegen"))
            else:
                arbeit.append((d, "lesen"))
        for i, (d, was) in enumerate(arbeit):
            if self.halt.is_set():
                b.abgebrochen = True
                b.offen = len(arbeit) - i
                break
            if (frist is not None and time.monotonic() >= frist) or not weiter():
                b.frist_erreicht = True
                b.offen = len(arbeit) - i
                break
            if not self._warte_auf_ruhe():
                b.abgebrochen = True
                b.offen = len(arbeit) - i
                break
            try:
                self._eine(d, was, b, bestand.get(d.pfad))
            except InterruptedError:
                b.abgebrochen = True
                b.offen = len(arbeit) - i
                break
            except Exception as e:  # noqa: BLE001 — nächste Datei; Art zählt, Name nie im Log
                b.fehler += 1
                art = type(e).__name__
                b.fehler_arten[art] = b.fehler_arten.get(art, 0) + 1
        if not b.abgebrochen:
            # Der Durchgang (Auflistung) war vollständig — Entfernen hängt nicht davon ab, ob alles gelesen wurde.
            # Verschobene Dateien sind zu diesem Zeitpunkt schon übernommen (alter Pfad noch da).
            weg = [p for p in bestand if p not in gesehen and p.split("/", 1)[0] not in unvoll]
            if weg and (not liste or len(weg) >= ENTFERNEN_MAX_ANTEIL * len(bestand)):
                log.warning(
                    "Tiefen-Index: %d von %d Einträgen auf einmal verschwunden (gesehen %d) — Bremse, nichts entfernt",
                    len(weg), len(bestand), len(liste),
                )
                b.entfernen_gebremst = len(weg)
            elif weg:
                try:
                    self.index.entferne(weg)
                    b.entfernt = len(weg)
                except Exception as e:  # noqa: BLE001
                    log.warning("Tiefen-Index: Entfernen fehlgeschlagen (%s)", type(e).__name__)
        b.gesamt_s = round(time.monotonic() - t0, 1)
        self.letzte_bilanz = b
        if b.vollstaendig:
            self.letzter_lauf = _jetzt_iso()
        z = self.index.zaehler()
        log.info(
            "Tiefen-Index: %d Dateien auf dem NAS — neu gelesen %d (OCR %d, ohne Text %d), übernommen %d, neu zerlegt %d, "
            "unverändert %d, entfernt %d, Fehler %d%s, offen %d; %d Abschnitte neu; %.0f s; Index %s Dateien / %s Abschnitte%s%s%s",
            b.nas_dateien, b.neu, b.ocr, b.ohne_text, b.uebernommen, b.neu_zerlegt, b.unveraendert, b.entfernt,
            b.fehler, f" {b.fehler_arten}" if b.fehler_arten else "", b.offen, b.abschnitte, b.gesamt_s,
            z.get("dateien", "?"), z.get("abschnitte", "?"),
            f" — {b.unvollstaendig} Freigabe(n) unvollständig" if b.unvollstaendig else "",
            " — Zeitbudget/Nachtende erreicht" if b.frist_erreicht else "",
            " — unterbrochen" if b.abgebrochen else "",
        )
        return b

    def _eine(self, d: NasDatei, was: str, b: Bilanz, alt: Bestand | None = None) -> None:
        if was == "zerlegen":
            text = self.index.text_von(d.pfad)
            if text is None:
                was = "lesen"
            else:
                abschnitte = zerlege(text)
                vektoren = self._einbetten([a.text for a in abschnitte])
                self.index.speichere_abschnitte(d.pfad, abschnitte, vektoren, self.rezept_abschnitte)
                b.neu_zerlegt += 1
                b.abschnitte += len(abschnitte)
                return
        sha = sha256_von(d.voll)
        if self.index.uebernehme(d, sha, self.rezept_text, self.rezept_abschnitte):
            b.uebernommen += 1
            return
        t = self.extraktor(d, self.cfg, self.halt)
        if voruebergehend(t.fehler):
            # Nicht als gelesen speichern (sonst gälte die Datei als unverändert und würde nie wieder gelesen).
            vorher = alt.versuche if alt is not None and alt.sha256 == sha and alt.rezept_text == self.rezept_text else 0
            self.index.vormerken(d, sha, str(t.fehler), vorher + 1, self.rezept_text)
            b.fehler += 1
            b.fehler_arten[str(t.fehler)] = b.fehler_arten.get(str(t.fehler), 0) + 1
            return
        if t.ocr:
            b.ocr += 1
        if not t.text.strip():
            b.ohne_text += 1
        if t.fehler:
            b.fehler_arten[t.fehler] = b.fehler_arten.get(t.fehler, 0) + 1
        abschnitte = zerlege(t.text)
        vektoren = self._einbetten([a.text for a in abschnitte])
        from .einordnung import erkenne_sprache

        sprache = erkenne_sprache(t.text) if t.text else None
        self.index.speichere(d, sha, t, sprache, abschnitte, vektoren, self.rezept_text, self.rezept_abschnitte)
        b.neu += 1
        b.abschnitte += len(abschnitte)

    def _einbetten(self, texte: list[str]) -> list[list[float]]:
        """In Stapeln (≤ 32) an «schnell» — jeder Stapel nimmt die GPU-Schleuse kurz, davor 20 s Ruhe."""
        vektoren: list[list[float]] = []
        for i in range(0, len(texte), EINBETTUNG_STAPEL):
            if not self._warte_auf_ruhe():
                raise InterruptedError("Halt")
            stapel = texte[i: i + EINBETTUNG_STAPEL]
            platz_fuer_einbettung(self.llm, self.cfg, grund="Tiefen-Index", max_alter_s=5.0)
            try:
                teil, _meta = self.llm.einbetten(modell=self.cfg.modell_embed, texte=stapel)
            except LlmFehler as e:
                raise RuntimeError(str(e)[:80]) from e
            vektoren.extend(teil)
        return vektoren


# --- Betrieb von Hand -----------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["extrakt"]:
        return _kind_extrakt(argv[1:])
    if argv[:1] == ["status"]:
        from .config import EINSTELLUNGEN as cfg

        index = TiefenIndex(cfg.pg_dsn)
        if not index.aktiv:
            print("PG_PASSWORD fehlt — kein Tiefen-Index", file=sys.stderr)
            return 1
        try:
            print(json.dumps(index.zaehler(), ensure_ascii=False))
        finally:
            index.schliessen()
        return 0
    print("Aufruf: python -m app.tiefe status", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
