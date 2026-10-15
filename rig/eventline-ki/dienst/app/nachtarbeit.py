"""Nachtarbeit (Masterplan Etappe 4): E4.1 Kontext + Melde-Puffer, E4.3 Fristen, E4.4 Rückstau ZZ, E4.5 Selbsttest.

Entscheid nach der Messnacht (README «Messung E2.4»): alle Jobs laufen mit dem SCHNELLEN Modell (KI_MODELL_TEXT,
gemma3:4b) auf der GPU-Instanz «ollama» — das Hauptmodell («gruendlich», KI_HG_AKTIV=0) bleibt aus. E4.2 (zweiter
Blick mit dem Hauptmodell) entfällt, E4.6 (Belege) und E4.7 (Duplikate) sind nicht Teil dieser Etappe.

Ablauf (Thread «ki-nacht», alle 30 s eine Runde):
- «Arbeiten, wenn frei» (Mischa 15.10., KI_FREI_AKTIV, Standard an): Rückstau ZZ und Fristen rechnen mit dem schnellen
  Modell in JEDEM Fenster (Tag 07:00–19:00 wie Nacht), sobald der Rig frei ist: kein FSM-Auftrag läuft oder wartet
  (20 s Pause — wartende Aufträge wie Suche, Archiv-Frage, Beleg, Ablage, Diktat haben Vorrang), Vorbilder- und
  Tiefen-Index laufen nicht, das Hauptmodell ist nicht geladen und der Speicher ist nicht knapp (speicher.leicht_frei).
  Vor jedem Schritt wird das neu geprüft, zwischen den Teilen eines langen Dokuments ebenso (_warte_vorrang); ein Schritt
  ist eine Datei, das Ergebnis steht danach im Tresor — ein Abbruch (Neustart, Vorrang) verliert höchstens den laufenden
  Schritt, nichts wird doppelt gerechnet oder gemeldet. Schwere Arbeit bleibt im Nachtfenster: Hauptmodell
  (hintergrund.py, Planer) und Tiefen-Index (jobs/tiefe.py) haben eigene Abläufe; der Selbsttest läuft nur nachts.
  KI_FREI_AKTIV=0: wie bis 15.10. nur im Planer-Fenster (KI_NACHT_START–KI_TAG_START, ab 06:45 «vor_tag» nicht mehr).
- Reihenfolge: Rückstau ZZ → Fristen (höchstens KI_JOB_ZZ_MAX ZZ-Dateien je Fenster; seit 15.10. ZZ zuerst — die
  Einsortier-Liste wartet auf Menschen, Fristen v2 ist eine Neuberechnung vorhandener Ergebnisse); ab
  KI_SELBSTTEST_ZEIT (05:30) hat nachts der Selbsttest Vorrang (einmal je Nacht), danach geht es mit dem Rest weiter.
  Zähler und «fertig» gelten je Fenster (Planer: «<Datum>/tag» bzw. «<Datum des Abends>/nacht»).
- Kontext (MP-5): GET /api/ki/kontext vor jeder Job-Phase und nach je 50 Schritten; älter als KI_KONTEXT_MAX_ALTER_S
  (60 min) oder nicht abrufbar → kein Schritt, nichts wird geraten. Abgelegt im Tresor (nacht-kontext.json, dazu
  fsm-ordnerliste.json für den Probelauf).
- Melden (MP-6): POST /api/ki/nachtarbeit mit höchstens 200 Einträgen — zu Beginn jeder Runde und während eines langen
  Durchgangs alle MELDEN_ALLE_SCHRITTE (25) Schritte. Puffer = Zeilen ohne gemeldet_at in den
  Tresor-Tabellen zz_vorschlaege / archiv_fristen (überlebt jeden Neustart), höchstens 2000 — ist er voll, ruhen die
  Jobs. FSM nicht erreichbar → Wiederholung mit Backoff 30 s bis 15 min. gemeldet_at wird für angenommene, doppelte
  und abgewiesene Einträge gesetzt (abgewiesen nur gezählt, nie neu gesendet). Gemeldet wird nur eine Liste, deren
  Schalter an ist.
- Alles hinter KI_JOB_FRISTEN, KI_JOB_ZZ, KI_JOB_SELBSTTEST (Standard 0). /health → «nachtarbeit»: nur Zahlen.

Trockenlauf (nichts geht ans FSM, nichts wird im Tresor geschrieben, Schalter nur für den Prozess):

    docker exec -e KI_JOB_FRISTEN=1 -e KI_JOB_ZZ=1 eventline-ki-dienst python -m app.nachtarbeit trocken

Er holt nur den Kontext (GET, ohne Nebenwirkung), rechnet sofort (ohne Nachtfenster), gibt den Vorrang an den
laufenden Dienst ab (dessen /health: Warteschlange 0, kein Auftrag in Arbeit) und druckt nur Kennzahlen.
"""

from __future__ import annotations

import argparse
import json
import logging
import statistics
import sys
import threading
import time
import urllib.request
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

from .archiv import nfc, unter_zz
from .config import Einstellungen
from .fsm import FsmAbgelehnt, FsmFehler
from .jobs import fristen as fj
from .jobs import selbsttest as sj
from .jobs import zz as zj
from .jobs.tiefe import jetzt_zuerich
from .llm import LlmFehler
from .planer import NACHT, Planer, uhrzeit

log = logging.getLogger("ki.nacht")

KONTEXT_DATEI = "nacht-kontext.json"
ORDNERLISTE_DATEI = "fsm-ordnerliste.json"  # = worker.ORDNERLISTE_DATEI (Probelauf)
STAND_DATEI = "nacht-stand.json"
PUFFER_MAX = 2000
MELDEN_MAX = 200  # = KI_NACHTARBEIT_MAX_EINTRAEGE im FSM
BACKOFF_MIN_S = 30.0
BACKOFF_MAX_S = 900.0
KONTEXT_NEU_NACH = 50
# Zwischenmeldung während eines langen Durchgangs (sonst sähe das FSM die ersten Ergebnisse erst am Ende).
MELDEN_ALLE_SCHRITTE = 25
KONTEXT_PHASE_FRISCH_S = 300.0
RUHE_S = 20.0
MAX_VERSUCHE = 3
AKTIV_BEKANNT = ("offen", "angenommen", "korrigiert")

DDL = """
CREATE TABLE IF NOT EXISTS archiv_karte (
  pfad             text PRIMARY KEY,
  sha256           text        NOT NULL,
  rezept_llm       text        NOT NULL,
  status           text        NOT NULL CHECK (status IN ('fertig', 'ohne_treffer', 'fehler')),
  versuche         integer     NOT NULL DEFAULT 1,
  typ              text,
  dok_datum        date,
  partei           text,
  personenbezogen  boolean     NOT NULL DEFAULT false,
  modell           text,
  erstellt         timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS archiv_fristen (
  id           bigserial PRIMARY KEY,
  pfad         text        NOT NULL,
  sha256       text        NOT NULL,
  art          text        NOT NULL,
  bedingungen  jsonb       NOT NULL,
  seite        integer,
  sicherheit   text,
  partei       text,
  modell       text,
  lauf_id      text,
  erstellt     timestamptz NOT NULL DEFAULT now(),
  gemeldet_at  timestamptz,
  ergebnis     text,
  UNIQUE (pfad, art, bedingungen)
);
CREATE INDEX IF NOT EXISTS archiv_fristen_offen_idx ON archiv_fristen (id) WHERE gemeldet_at IS NULL;
CREATE TABLE IF NOT EXISTS zz_vorschlaege (
  id            bigserial PRIMARY KEY,
  pfad          text        NOT NULL,
  sha256        text        NOT NULL,
  rezept        text        NOT NULL,
  status        text        NOT NULL CHECK (status IN ('vorschlag', 'kein_ziel', 'fehler')),
  versuche      integer     NOT NULL DEFAULT 1,
  grund         text,
  ordner_ist    text,
  ziel_ordner   text,
  alternativen  text[]      NOT NULL DEFAULT '{}',
  sicherheit    text,
  quelle        text,
  begruendung   text,
  modell        text,
  lauf_id       text,
  erstellt      timestamptz NOT NULL DEFAULT now(),
  gemeldet_at   timestamptz,
  ergebnis      text,
  UNIQUE (pfad, sha256, rezept)
);
CREATE INDEX IF NOT EXISTS zz_vorschlaege_offen_idx ON zz_vorschlaege (id) WHERE gemeldet_at IS NULL AND status = 'vorschlag';
-- zz/v3 (15.10.): Beschrieb (gefiltert) + Fakten-Hinweise + Kandidaten statt eines Ziels — Claude entscheidet im FSM.
ALTER TABLE zz_vorschlaege ADD COLUMN IF NOT EXISTS beschrieb jsonb;
ALTER TABLE zz_vorschlaege ADD COLUMN IF NOT EXISTS fakten text[] NOT NULL DEFAULT '{}';
ALTER TABLE zz_vorschlaege ADD COLUMN IF NOT EXISTS kandidaten text[] NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS selbsttest_laeufe (
  id          bigserial PRIMARY KEY,
  zeit        timestamptz NOT NULL DEFAULT now(),
  fenster     text        NOT NULL,
  seed        bigint      NOT NULL,
  kennzahlen  jsonb       NOT NULL
);
"""


def _jetzt_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def lauf_id_fuer(fenster: str, *, trocken: bool = False) -> str:
    """«2026-10-12/nacht» → «2026-10-12-nacht» (Vertrag MP-6)."""
    return fenster.replace("/", "-") + ("-trocken" if trocken else "")


# --- Kontext (MP-5) ---------------------------------------------------------------------------------------------


@dataclass
class Kontext:
    daten: dict[str, Any]
    geholt: float  # Unix-Zeit des Abrufs

    def alter_s(self, jetzt: float | None = None) -> float:
        return max(0.0, (time.time() if jetzt is None else jetzt) - self.geholt)

    @property
    def ordner(self) -> list[str]:
        o = self.daten.get("ordner")
        return [x for x in o if isinstance(x, str) and x] if isinstance(o, list) else []

    @property
    def gueltig(self) -> bool:
        return bool(self.ordner)

    def bekannt_zz(self, rezept: str | None = None) -> set[str]:
        """Pfade (NFC), die nicht nochmals gerechnet werden: angenommen/korrigiert (Verschiebung steht aus) oder schon
        etwas mit diesem Rezept im FSM (Vorschlag, Beschrieb in der Warteschlange). Ein OFFENER Vorschlag eines älteren
        Rezepts (oder ohne Rezept) wird neu gerechnet — das FSM ersetzt ihn (alt → «veraltet»). Ohne `rezept` wie bis
        zz/v2: jeder offene/angenommene/korrigierte zählt."""
        aus: set[str] = set()
        for v in self.daten.get("vorschlaege_bekannt") or []:
            if not (isinstance(v, dict) and v.get("art") == "zz" and isinstance(v.get("pfad"), str)):
                continue
            status = str(v.get("status") or "")
            if rezept is None:
                treffer = status in AKTIV_BEKANNT
            else:
                treffer = status in ("angenommen", "korrigiert") or (
                    v.get("rezept") == rezept and (status in AKTIV_BEKANNT or status.startswith("beschrieb_")))
            if treffer:
                aus.add(nfc(v["pfad"]))
        return aus


class KontextQuelle:
    """Holt den Kontext beim FSM und legt ihn im Tresor ab (ohne `ablage` nur im Speicher — Trockenlauf)."""

    def __init__(self, fsm: Any, ablage: Path | None, max_alter_s: float) -> None:
        self.fsm = fsm
        self.ablage = ablage
        self.max_alter_s = float(max_alter_s)
        self.letzter_fehler: str | None = None
        self._k: Kontext | None = self._laden()

    def _laden(self) -> Kontext | None:
        if self.ablage is None:
            return None
        try:
            roh = json.loads((self.ablage / KONTEXT_DATEI).read_text(encoding="utf-8"))
            k = Kontext(roh["daten"], float(roh["geholt"]))
            return k if isinstance(k.daten, dict) and k.gueltig else None
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def _speichern(self, k: Kontext) -> None:
        if self.ablage is None:
            return
        try:
            self.ablage.mkdir(parents=True, exist_ok=True)
            for name, inhalt in (
                (KONTEXT_DATEI, {"geholt": k.geholt, "daten": k.daten}),
                (ORDNERLISTE_DATEI, {"zeit": _jetzt_iso(), "anzahl": len(k.ordner), "ordner": k.ordner}),
            ):
                ziel = self.ablage / name
                tmp = ziel.with_suffix(".json.neu")
                tmp.write_text(json.dumps(inhalt, ensure_ascii=False), encoding="utf-8")
                tmp.replace(ziel)
        except OSError as e:
            log.warning("Nachtarbeit: Kontext nicht im Tresor abgelegt (%s)", type(e).__name__)

    @property
    def zuletzt(self) -> Kontext | None:
        return self._k

    def aktuell(self, *, neu: bool = False) -> Kontext | None:
        """Gültiger Kontext höchstens max_alter_s alt — sonst None (kein Job)."""
        if not neu and self._k is not None and self._k.alter_s() <= self.max_alter_s:
            return self._k
        try:
            daten = self.fsm.hole_kontext()
        except FsmFehler as e:
            self.letzter_fehler = str(e)[:200]
            log.warning("Nachtarbeit: %s", self.letzter_fehler)
            return self._k if self._k is not None and self._k.alter_s() <= self.max_alter_s else None
        k = Kontext(daten, time.time())
        if not k.gueltig:
            self.letzter_fehler = "Kontext ohne Ordnerliste"
            log.warning("Nachtarbeit: Kontext ohne Ordnerliste — kein Lauf")
            return None
        self.letzter_fehler = None
        self._k = k
        self._speichern(k)
        log.info("Nachtarbeit: Kontext geholt (%d Ordner, %d bekannte Vorschläge, %d bekannte Fristen)",
                 len(k.ordner), len(daten.get("vorschlaege_bekannt") or []), len(daten.get("fristen_bekannt") or []))
        return k


# --- Tresor ---------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class TextZeile:
    pfad: str
    sha256: str
    name: str
    ocr: bool
    seiten: int | None
    zeichen: int


class NachtSpeicher:
    """Tabellen der Nachtarbeit im Tresor (Rig-DB). trocken=True: liest den Tiefen-Index, schreibt aber nichts —
    Ergebnisse bleiben im Speicher des Prozesses (und die Tabellen werden nicht angelegt)."""

    def __init__(self, dsn: str | None, *, trocken: bool = False) -> None:
        self._dsn = dsn
        self.trocken = trocken
        self._lock = threading.Lock()
        self._conn = None
        self._letzter_versuch = 0.0
        self._status_cache: tuple[float, dict[str, Any]] = (0.0, {})
        # Trockenlauf
        self._karten: dict[str, tuple[str, str, str, int]] = {}
        self._zz: dict[tuple[str, str, str], tuple[str, int]] = {}
        self._fristen: list[dict[str, Any]] = []
        self._selbsttest: dict[str, Any] | None = None

    @property
    def aktiv(self) -> bool:
        return self._dsn is not None

    def _verbindung(self):
        import psycopg

        if self._conn is not None and not self._conn.closed:
            return self._conn
        if time.monotonic() - self._letzter_versuch < 30:
            raise ConnectionError("Nacht-DB kurz zuvor nicht erreichbar")
        self._letzter_versuch = time.monotonic()
        self._conn = psycopg.connect(self._dsn, autocommit=True)
        if not self.trocken:
            with self._conn.cursor() as c:
                c.execute(DDL)
        return self._conn

    def _sql(self, sql: str, werte: tuple | list = (), *, holen: bool = False, viele: bool = False) -> list[tuple]:
        if not self._dsn:
            return []
        with self._lock:
            try:
                with self._verbindung().cursor() as c:
                    if viele:
                        c.executemany(sql, werte)
                        return []
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

    def _da(self, tabelle: str) -> bool:
        z = self._sql("SELECT to_regclass(%s) IS NOT NULL", (tabelle,), holen=True)
        return bool(z and z[0][0])

    def schliessen(self) -> None:
        with self._lock:
            if self._conn is not None:
                try:
                    self._conn.close()
                except Exception:  # noqa: BLE001
                    pass
                self._conn = None

    # --- Lesen (Tiefen-Index, Vorbilder-Index) ---

    def texte(self) -> list[TextZeile]:
        if not self._da("archiv_text"):
            return []
        zeilen = self._sql(
            "SELECT pfad, sha256, name, ocr, seiten, zeichen FROM archiv_text ORDER BY pfad", holen=True,
        )
        return [TextZeile(str(p), str(s), str(n), bool(o), int(se) if se is not None else None, int(z or 0))
                for p, s, n, o, se, z in zeilen]

    def text(self, pfad: str, sha256: str) -> str | None:
        z = self._sql("SELECT text FROM archiv_text WHERE pfad = %s AND sha256 = %s", (pfad, sha256), holen=True)
        return str(z[0][0] or "") if z else None

    def archiv_dateien(self) -> list[tuple[str, str, str, str]]:
        if not self._da("archiv_dateien"):
            return []
        return [(str(a), str(b), str(c), str(d)) for a, b, c, d in
                self._sql("SELECT pfad, ordner, name, sha256 FROM archiv_dateien", holen=True)]

    # --- Fristen ---

    def karten(self, rezept: str) -> dict[str, tuple[str, str, int]]:
        """pfad → (sha256, status, versuche) für dieses Rezept."""
        aus: dict[str, tuple[str, str, int]] = {}
        if self._da("archiv_karte"):
            for p, s, st, v in self._sql(
                "SELECT pfad, sha256, status, versuche FROM archiv_karte WHERE rezept_llm = %s", (rezept,), holen=True,
            ):
                aus[str(p)] = (str(s), str(st), int(v))
        for p, (s, r, st, v) in self._karten.items():
            if r == rezept:
                aus[p] = (s, st, v)
        return aus

    def speichere_karte(self, pfad: str, sha256: str, rezept: str, status: str, befund: fj.FristBefund | None,
                        modell: str | None) -> None:
        b = befund or fj.FristBefund(status=status)
        if self.trocken:
            alt = self._karten.get(pfad)
            v = alt[3] + 1 if alt and status == "fehler" and alt[2] == "fehler" and alt[0] == sha256 else 1
            self._karten[pfad] = (sha256, rezept, status, v)
            return
        self._sql(
            """INSERT INTO archiv_karte (pfad, sha256, rezept_llm, status, versuche, typ, dok_datum, partei,
                                        personenbezogen, modell, erstellt)
               VALUES (%s, %s, %s, %s, 1, %s, %s, %s, %s, %s, now())
               ON CONFLICT (pfad) DO UPDATE SET
                 versuche = CASE WHEN EXCLUDED.status = 'fehler' AND archiv_karte.status = 'fehler'
                                  AND archiv_karte.sha256 = EXCLUDED.sha256 AND archiv_karte.rezept_llm = EXCLUDED.rezept_llm
                                 THEN archiv_karte.versuche + 1 ELSE 1 END,
                 sha256 = EXCLUDED.sha256, rezept_llm = EXCLUDED.rezept_llm, status = EXCLUDED.status,
                 typ = EXCLUDED.typ, dok_datum = EXCLUDED.dok_datum, partei = EXCLUDED.partei,
                 personenbezogen = EXCLUDED.personenbezogen, modell = EXCLUDED.modell, erstellt = now()""",
            (pfad, sha256, rezept, status, b.typ, date.fromisoformat(b.dok_datum) if b.dok_datum else None, b.partei,
             b.personenbezogen, modell),
        )

    def speichere_fristen(self, pfad: str, sha256: str, befund: fj.FristBefund, lauf_id: str) -> int:
        """Idempotent (UNIQUE pfad, art, bedingungen). Liefert die Zahl der neuen Zeilen."""
        if self.trocken:
            neu = 0
            for f in befund.fristen:
                schluessel = {"pfad": pfad, "art": f.art, "bedingungen": f.bedingungen}
                if schluessel not in self._fristen:
                    self._fristen.append(schluessel)
                    neu += 1
            return neu
        from psycopg.types.json import Jsonb

        neu = 0
        for f in befund.fristen:
            z = self._sql(
                """INSERT INTO archiv_fristen (pfad, sha256, art, bedingungen, seite, sicherheit, partei, modell, lauf_id)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (pfad, art, bedingungen) DO NOTHING RETURNING id""",
                (pfad, sha256, f.art, Jsonb(f.bedingungen), f.seite, f.sicherheit, befund.partei, befund.modell, lauf_id),
                holen=True,
            )
            neu += len(z)
        return neu

    # --- Rückstau ZZ ---

    def zz_stand(self, rezept: str) -> dict[tuple[str, str], tuple[str, int]]:
        aus: dict[tuple[str, str], tuple[str, int]] = {}
        if self._da("zz_vorschlaege"):
            for p, s, st, v in self._sql(
                "SELECT pfad, sha256, status, versuche FROM zz_vorschlaege WHERE rezept = %s", (rezept,), holen=True,
            ):
                aus[(str(p), str(s))] = (str(st), int(v))
        for (p, s, r), wert in self._zz.items():
            if r == rezept:
                aus[(p, s)] = wert
        return aus

    def speichere_zz(self, pfad: str, sha256: str, rezept: str, status: str, befund: zj.ZzBefund | None,
                     lauf_id: str, grund: str | None = None) -> None:
        b = befund or zj.ZzBefund(status=status, grund=grund)
        if self.trocken:
            alt = self._zz.get((pfad, sha256, rezept))
            self._zz[(pfad, sha256, rezept)] = (status, (alt[1] + 1) if alt and status == "fehler" else 1)
            return
        from psycopg.types.json import Jsonb

        self._sql(
            """INSERT INTO zz_vorschlaege (pfad, sha256, rezept, status, versuche, grund, ordner_ist, beschrieb, fakten,
                                          kandidaten, modell, lauf_id)
               VALUES (%s, %s, %s, %s, 1, %s, %s, %s, %s::text[], %s::text[], %s, %s)
               ON CONFLICT (pfad, sha256, rezept) DO UPDATE SET
                 status = EXCLUDED.status,
                 versuche = CASE WHEN EXCLUDED.status = 'fehler' THEN zz_vorschlaege.versuche + 1 ELSE zz_vorschlaege.versuche END,
                 grund = EXCLUDED.grund, ordner_ist = EXCLUDED.ordner_ist, beschrieb = EXCLUDED.beschrieb,
                 fakten = EXCLUDED.fakten, kandidaten = EXCLUDED.kandidaten, modell = EXCLUDED.modell,
                 lauf_id = EXCLUDED.lauf_id, erstellt = now()
               WHERE zz_vorschlaege.status = 'fehler'""",
            (pfad, sha256, rezept, status, b.grund or grund, b.ordner_ist or None,
             Jsonb(b.beschrieb) if b.beschrieb is not None else None, list(b.fakten), list(b.kandidaten), b.modell, lauf_id),
        )

    # --- Melde-Puffer ---

    def offene_meldungen(self, n: int, *, zz: bool, fristen: bool) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        if self.trocken or n <= 0:
            return [], []
        vorschlaege: list[dict[str, Any]] = []
        if zz and self._da("zz_vorschlaege"):
            # Nur Zeilen des aktuellen Rezepts mit Beschrieb (zz/v3) — ältere, nie gemeldete Zielvorschläge bleiben liegen.
            for i, p, s, ist, beschrieb, fakten, kandidaten, lauf in self._sql(
                """SELECT id, pfad, sha256, ordner_ist, beschrieb, fakten, kandidaten, lauf_id
                   FROM zz_vorschlaege WHERE gemeldet_at IS NULL AND status = 'vorschlag' AND rezept = %s
                     AND beschrieb IS NOT NULL ORDER BY id LIMIT %s""",
                (zj.REZEPT, n), holen=True,
            ):
                vorschlaege.append({"id": int(i), "lauf_id": lauf, "eintrag": zj.meldung(str(p), str(s), {
                    "ordner_ist": ist, "beschrieb": dict(beschrieb or {}), "fakten": list(fakten or []),
                    "kandidaten": list(kandidaten or [])})})
        liste: list[dict[str, Any]] = []
        rest = n - len(vorschlaege)
        if fristen and rest > 0 and self._da("archiv_fristen"):
            for i, p, s, art, bed, seite, sich, partei, lauf in self._sql(
                """SELECT id, pfad, sha256, art, bedingungen, seite, sicherheit, partei, lauf_id
                   FROM archiv_fristen WHERE gemeldet_at IS NULL ORDER BY id LIMIT %s""",
                (rest,), holen=True,
            ):
                f = fj.Frist(art=str(art), bedingungen=dict(bed), seite=seite, sicherheit=str(sich))
                liste.append({"id": int(i), "lauf_id": lauf, "eintrag": fj.meldung(str(p), str(s), f, partei)})
        return vorschlaege, liste

    def markiere(self, tabelle: str, ergebnisse: list[tuple[int, str]]) -> None:
        if self.trocken or not ergebnisse:
            return
        if tabelle not in ("zz_vorschlaege", "archiv_fristen"):
            raise ValueError(tabelle)
        self._sql(f"UPDATE {tabelle} SET gemeldet_at = now(), ergebnis = %s WHERE id = %s",
                  [(e[:60], i) for i, e in ergebnisse], viele=True)

    def puffer(self) -> int:
        if self.trocken:
            return 0
        n = 0
        if self._da("zz_vorschlaege"):
            n += int(self._sql("SELECT count(*) FROM zz_vorschlaege WHERE gemeldet_at IS NULL AND status = 'vorschlag' "
                               "AND rezept = %s AND beschrieb IS NOT NULL", (zj.REZEPT,), holen=True)[0][0])
        if self._da("archiv_fristen"):
            n += int(self._sql("SELECT count(*) FROM archiv_fristen WHERE gemeldet_at IS NULL", holen=True)[0][0])
        return n

    # --- Selbsttest ---

    def speichere_selbsttest(self, fenster: str, seed: int, kennzahlen: dict[str, Any]) -> None:
        eintrag = {"zeit": _jetzt_iso(), "fenster": fenster, "seed": seed, **kennzahlen}
        if self.trocken:
            self._selbsttest = eintrag
            return
        from psycopg.types.json import Jsonb

        self._sql("INSERT INTO selbsttest_laeufe (fenster, seed, kennzahlen) VALUES (%s, %s, %s)",
                  (fenster, seed, Jsonb(kennzahlen)))
        self._sql("DELETE FROM selbsttest_laeufe WHERE zeit < now() - interval '90 days'")
        self._status_cache = (0.0, {})

    def letzter_selbsttest(self) -> dict[str, Any] | None:
        if self.trocken:
            return self._selbsttest
        if not self._da("selbsttest_laeufe"):
            return None
        z = self._sql("SELECT zeit, fenster, seed, kennzahlen FROM selbsttest_laeufe ORDER BY id DESC LIMIT 1", holen=True)
        if not z:
            return None
        zeit, fenster, seed, k = z[0]
        return {"zeit": zeit.isoformat(timespec="seconds") if hasattr(zeit, "isoformat") else str(zeit),
                "fenster": fenster, "seed": seed, **(k or {})}

    # --- /health ---

    def zaehler(self) -> dict[str, Any]:
        """Nur Zahlen, höchstens 60 s alt."""
        zeit, wert = self._status_cache
        if wert and time.monotonic() - zeit < 60:
            return wert
        aus: dict[str, Any] = {}
        try:
            if self._da("archiv_karte"):
                aus["karten"] = {str(s): int(n) for s, n in
                                 self._sql("SELECT status, count(*) FROM archiv_karte GROUP BY 1", holen=True)}
            if self._da("archiv_fristen"):
                f: Counter = Counter()
                for gemeldet, ergebnis, sich, n in self._sql(
                    """SELECT gemeldet_at IS NOT NULL, coalesce(ergebnis, ''), coalesce(sicherheit, ''), count(*)
                       FROM archiv_fristen GROUP BY 1, 2, 3""", holen=True,
                ):
                    f["gemeldet" if gemeldet else "offen"] += int(n)
                    if gemeldet and ergebnis != "ok":
                        f["abgewiesen"] += int(n)
                    f[f"sicherheit_{sich or 'ohne'}"] += int(n)
                aus["fristen"] = dict(f)
            if self._da("zz_vorschlaege"):
                z: Counter = Counter()
                for status, gemeldet, ergebnis, sich, n in self._sql(
                    """SELECT status, gemeldet_at IS NOT NULL, coalesce(ergebnis, ''), coalesce(sicherheit, ''), count(*)
                       FROM zz_vorschlaege GROUP BY 1, 2, 3, 4""", holen=True,
                ):
                    z[str(status)] += int(n)
                    if status == "vorschlag":
                        z["gemeldet" if gemeldet else "offen"] += int(n)
                        z[f"sicherheit_{sich}"] += int(n)
                        if gemeldet and ergebnis != "ok":
                            z["abgewiesen"] += int(n)
                aus["zz"] = dict(z)
        except Exception as e:  # noqa: BLE001
            aus["fehler"] = type(e).__name__
        self._status_cache = (time.monotonic(), aus)
        return aus


# --- Melden (MP-6) ---------------------------------------------------------------------------------------------


class Melder:
    """Sendet den Puffer in Paketen ≤ 200; Backoff 30 s → 15 min bei FSM-Fehlern."""

    def __init__(self, speicher: NachtSpeicher, fsm: Any, *, modell: str, uhr: Callable[[], float] = time.monotonic) -> None:
        self.speicher = speicher
        self.fsm = fsm
        self.modell = modell
        self.uhr = uhr
        self._naechster = 0.0
        self._backoff = BACKOFF_MIN_S
        self.letzter_fehler: str | None = None
        self.letzte_meldung: str | None = None
        self.zaehler: Counter = Counter()

    def backoff_rest_s(self) -> int:
        return max(0, int(self._naechster - self.uhr()))

    def runde(self, *, zz: bool, fristen: bool) -> str:
        """Ein Paket. Liefert «leer», «warten», «gemeldet», «abgelehnt» oder «fehler»."""
        if not (zz or fristen):
            return "leer"
        if self.uhr() < self._naechster:
            return "warten"
        vorschlaege, liste = self.speicher.offene_meldungen(MELDEN_MAX, zz=zz, fristen=fristen)
        if not vorschlaege and not liste:
            return "leer"
        lauf_id = next((x["lauf_id"] for x in [*vorschlaege, *liste] if x.get("lauf_id")), None)
        body = {"lauf_id": lauf_id, "modell": self.modell,
                "vorschlaege": [x["eintrag"] for x in vorschlaege], "fristen": [x["eintrag"] for x in liste]}
        try:
            antwort = self.fsm.melde_nachtarbeit(body)
        except FsmAbgelehnt as e:
            # Form/zu viele: dieselben Einträge erneut zu senden hilft nicht — als gemeldet markieren und zählen.
            self.letzter_fehler = str(e)[:200]
            log.error("Nachtarbeit: %s — %d Einträge verworfen", self.letzter_fehler, len(vorschlaege) + len(liste))
            self.speicher.markiere("zz_vorschlaege", [(x["id"], "http_4xx") for x in vorschlaege])
            self.speicher.markiere("archiv_fristen", [(x["id"], "http_4xx") for x in liste])
            self.zaehler["http_4xx"] += len(vorschlaege) + len(liste)
            return "abgelehnt"
        except FsmFehler as e:
            self.letzter_fehler = str(e)[:200]
            self._naechster = self.uhr() + self._backoff
            log.warning("Nachtarbeit: %s — nächster Versuch in %.0f s (Puffer bleibt)", self.letzter_fehler, self._backoff)
            self._backoff = min(self._backoff * 2, BACKOFF_MAX_S)
            return "fehler"
        self._backoff = BACKOFF_MIN_S
        self._naechster = 0.0
        self.letzter_fehler = None
        self.letzte_meldung = _jetzt_iso()
        gruende: dict[tuple[str, int], str] = {}
        for a in antwort.get("abgewiesen") or []:
            if isinstance(a, dict) and a.get("liste") in ("vorschlaege", "fristen") and isinstance(a.get("index"), int):
                gruende[(a["liste"], a["index"])] = str(a.get("grund") or "abgewiesen")[:40]
        self.speicher.markiere("zz_vorschlaege", [(x["id"], gruende.get(("vorschlaege", i), "ok")) for i, x in enumerate(vorschlaege)])
        self.speicher.markiere("archiv_fristen", [(x["id"], gruende.get(("fristen", i), "ok")) for i, x in enumerate(liste)])
        self.zaehler["gesendet"] += len(vorschlaege) + len(liste)
        self.zaehler["angenommen"] += int(antwort.get("angenommen") or 0)
        self.zaehler["doppelt"] += int(antwort.get("doppelt") or 0)
        for g in gruende.values():
            self.zaehler[f"abgewiesen_{g}"] += 1
        log.info("Nachtarbeit gemeldet: %d Vorschläge, %d Fristen — angenommen %s, doppelt %s, abgewiesen %d",
                 len(vorschlaege), len(liste), antwort.get("angenommen"), antwort.get("doppelt"), len(gruende))
        return "gemeldet"


# --- Ablauf ---------------------------------------------------------------------------------------------------


class NurKontext:
    """Trockenlauf: vom FSM-Client ist nur das Lesen des Kontexts erreichbar — Melden ist unmöglich."""

    def __init__(self, fsm: Any) -> None:
        self._fsm = fsm

    def hole_kontext(self) -> dict:
        return self._fsm.hole_kontext()


class Nachtarbeit(threading.Thread):
    def __init__(
        self,
        cfg: Einstellungen,
        llm: Any,
        archiv: Any,
        speicher: NachtSpeicher,
        kontext: KontextQuelle,
        *,
        melder: Melder | None,
        ruhig: Callable[[], bool],
        vorarbeit_laeuft: Callable[[], bool] = lambda: False,
        speicher_ok: Callable[[], bool] = lambda: True,
        protokoll: Any = None,
        uhr: Callable[[], datetime] = jetzt_zuerich,
        takt_s: float = 30.0,
        stand_datei: Path | None = None,
        trocken: bool = False,
    ) -> None:
        super().__init__(name="ki-nacht", daemon=True)
        self.cfg = cfg
        self.llm = llm
        self.archiv = archiv
        self.speicher = speicher
        self.kontext = kontext
        self.melder = melder
        self.ruhig = ruhig
        self.vorarbeit_laeuft = vorarbeit_laeuft
        # «Arbeiten, wenn frei»: kein neuer Schritt bei Speichernot (main.py: speicher.leicht_frei).
        self.speicher_ok = speicher_ok
        self.protokoll = protokoll
        self.uhr = uhr
        self.takt_s = takt_s
        self.trocken = trocken
        self.planer = Planer.aus_cfg(cfg)
        self.selbsttest_ab = uhrzeit(cfg.selbsttest_zeit, (5, 30))
        self.stand_datei = stand_datei
        self.stand: dict[str, Any] = self._stand_laden()
        self.laeuft: str | None = None
        self.grund: str | None = None
        self.zaehler: dict[str, Counter] = {"fristen": Counter(), "zz": Counter(), "selbsttest": Counter()}
        self.dauern: dict[str, list[int]] = {"fristen": [], "zz": [], "selbsttest": []}
        self._selbst_teil: tuple[str, dict[tuple[str, str], dict[str, Any]]] = ("", {})
        self._puffer_cache: tuple[float, int | None] = (-1e9, None)
        self._halt = threading.Event()

    # --- Stand je Nacht (nur Zahlen, überlebt einen Neustart) ---

    def _stand_laden(self) -> dict[str, Any]:
        if self.stand_datei is None:
            return {}
        try:
            d = json.loads(self.stand_datei.read_text(encoding="utf-8"))
            return d if isinstance(d, dict) else {}
        except (OSError, ValueError):
            return {}

    def _stand_speichern(self) -> None:
        if self.stand_datei is None:
            return
        try:
            self.stand_datei.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.stand_datei.with_suffix(".json.neu")
            tmp.write_text(json.dumps(self.stand), encoding="utf-8")
            tmp.replace(self.stand_datei)
        except OSError as e:
            log.warning("Nachtarbeit: Stand nicht gespeichert (%s)", type(e).__name__)

    def _fenster(self, fenster: str) -> None:
        if self.stand.get("fenster") != fenster:
            self.stand = {"fenster": fenster, "fristen": 0, "zz": 0, "selbsttest": False}
            self.zaehler = {"fristen": Counter(), "zz": Counter(), "selbsttest": Counter()}
            self.dauern = {"fristen": [], "zz": [], "selbsttest": []}
            self._stand_speichern()

    # --- Steuerung ---

    def stop(self) -> None:
        self._halt.set()

    def run(self) -> None:
        log.info("Nachtarbeit gestartet — ZZ %s (max %d/Fenster), Fristen %s, Selbsttest %s ab %02d:%02d; %s; Modell %s",
                 self.cfg.job_zz, self.cfg.job_zz_max, self.cfg.job_fristen, self.cfg.job_selbsttest,
                 *self.selbsttest_ab, "arbeitet, wenn frei (auch tagsüber)" if self.cfg.frei_aktiv else "nur nachts",
                 self.cfg.modell_text)
        while not self._halt.wait(self.takt_s):
            try:
                self.grund = self.runde()
            except Exception:  # noqa: BLE001 — der Thread darf nie sterben
                log.exception("Nachtarbeit: unerwarteter Fehler")
                self.grund = "fehler"
            finally:
                self.laeuft = None

    def _selbsttest_faellig(self, jetzt: datetime) -> bool:
        if not self.cfg.job_selbsttest or self.stand.get("selbsttest"):
            return False
        minute = jetzt.hour * 60 + jetzt.minute
        ab = self.selbsttest_ab[0] * 60 + self.selbsttest_ab[1]
        tag = self.planer.tag_start[0] * 60 + self.planer.tag_start[1]
        return ab <= minute < tag

    def _naechster_job(self, jetzt: datetime, *, nachts: bool = True) -> str | None:
        """Selbsttest (nur nachts, ab KI_SELBSTTEST_ZEIT) vor allem; danach Rückstau ZZ vor Fristen (seit 15.10.)."""
        if nachts and self._selbsttest_faellig(jetzt):
            return "selbsttest"
        if self.cfg.job_zz and not self.stand.get("zz_fertig") and int(self.stand.get("zz") or 0) < self.cfg.job_zz_max:
            return "zz"
        if self.cfg.job_fristen and not self.stand.get("fristen_fertig"):
            return "fristen"
        return None

    def _melden(self, wann: str) -> None:
        """Puffer leeren (wirft nie — der Puffer bleibt im Tresor, die nächste Meldung holt ihn nach)."""
        if self.melder is None or self.trocken:
            return
        try:
            self.melder.runde(zz=self.cfg.job_zz, fristen=self.cfg.job_fristen)
        except Exception as e:  # noqa: BLE001
            log.warning("Nachtarbeit: Melden (%s) fehlgeschlagen (%s)", wann, type(e).__name__)

    def runde(self) -> str:
        """Eine Runde: melden, dann (bei Ruhe; ohne KI_FREI_AKTIV nur nachts) den nächsten Job so weit wie möglich.
        Liefert den Grund."""
        self._melden("runde")
        jetzt = self.uhr()
        lage = self.planer.lage(jetzt)
        # «nachts» = Planer-Fenster der Nacht, ohne die 15 min vor Tagesbeginn. Nur dort darf der Selbsttest laufen;
        # Fristen/ZZ mit KI_FREI_AKTIV in jedem Fenster, sonst ebenfalls nur dort.
        nachts = lage.modus == NACHT and lage.erlaubt
        if not self.cfg.frei_aktiv and not nachts:
            return "tag" if lage.modus != NACHT else lage.grund
        self._fenster(lage.fenster)
        job = self._naechster_job(jetzt, nachts=nachts)
        if job is None:
            return "erledigt"
        if self.vorarbeit_laeuft():
            return "vorarbeit"
        if not self.ruhig():
            return "vorrang"
        if not self.speicher_ok():
            return "speicher"
        if job != "selbsttest" and self.speicher.puffer() >= PUFFER_MAX:
            return "puffer_voll"
        # Vor jeder Job-Phase frisch (MP-5) — ausser er ist erst wenige Minuten alt (Phase nach kurzer Unterbrechung).
        zuletzt = self.kontext.zuletzt
        k = self.kontext.aktuell(neu=zuletzt is None or zuletzt.alter_s() > KONTEXT_PHASE_FRISCH_S)
        if k is None:
            return "kein_kontext"

        def weiter(art: str) -> str | None:
            if self._halt.is_set():
                return "halt"
            jetzt2 = self.uhr()
            l2 = self.planer.lage(jetzt2)
            nachts2 = l2.modus == NACHT and l2.erlaubt
            # Fensterwechsel beendet jeden Durchgang (Zähler je Fenster); der Selbsttest und — ohne KI_FREI_AKTIV —
            # alle Jobs enden ausserdem mit dem Nachtfenster.
            if l2.fenster != lage.fenster or ((art == "selbsttest" or not self.cfg.frei_aktiv) and not nachts2):
                return "fenster"
            if self.vorarbeit_laeuft():
                return "vorarbeit"
            if not self.ruhig():
                return "vorrang"
            if not self.speicher_ok():
                return "speicher"
            if art != "selbsttest" and nachts2 and self._selbsttest_faellig(jetzt2):
                return "selbsttest"
            if art == "zz" and int(self.stand.get("zz") or 0) >= self.cfg.job_zz_max:
                return "zz_grenze"
            if art != "selbsttest" and self.speicher.puffer() >= PUFFER_MAX:
                return "puffer_voll"
            return None

        ergebnis = self.fahre(job, k, lage.fenster, weiter)
        if ergebnis == "fertig":
            if job == "selbsttest":
                self._selbsttest_abschluss(lage.fenster)
            else:
                self.stand[f"{job}_fertig"] = True
            self._stand_speichern()
        return f"{job}:{ergebnis}"

    def fahre(self, art: str, k: Kontext, fenster: str, weiter: Callable[[str], str | None],
              grenze: int | None = None) -> str:
        """Schritte eines Jobs bis zum Ende oder bis `weiter` einen Grund nennt. Kontext alle 50 Schritte neu."""
        self.laeuft = art
        lauf_id = lauf_id_fuer(fenster, trocken=self.trocken)
        n = 0
        try:
            for schritt in self._schritte(art, k, fenster):
                grund = weiter(art)
                if grund:
                    return grund
                if grenze is not None and n >= grenze:
                    return "grenze"
                if (n and n % KONTEXT_NEU_NACH == 0) or k.alter_s() > self.kontext.max_alter_s:
                    neu = self.kontext.aktuell(neu=True)
                    if neu is None:
                        return "kein_kontext"
                    k = neu
                schritt(k, lauf_id)
                n += 1
                if art in ("fristen", "zz"):
                    self.stand[art] = int(self.stand.get(art) or 0) + 1
                    if n % 10 == 0:
                        self._stand_speichern()
                    if n % MELDEN_ALLE_SCHRITTE == 0:
                        # Ergebnisse stehen je Datei im Tresor; das FSM (Claude-Cron) soll nicht bis zum Ende warten.
                        self._melden("zwischen")
            return "fertig"
        finally:
            self._stand_speichern()
            self.laeuft = None

    def _warte_vorrang(self, max_s: float = 900.0, takt_s: float = 2.0) -> None:
        """Zwischen den Teilen eines langen Dokuments: solange ein FSM-Auftrag läuft oder wartet (Suche, Archiv-Frage,
        Beleg …), warten — höchstens max_s, dann weiter (der Schritt soll nicht ewig hängen)."""
        gewartet = 0.0
        while not self._halt.is_set() and gewartet < max_s and not self.ruhig():
            time.sleep(takt_s)
            gewartet += takt_s

    def _protokoll(self, art: str, ms: int, ok: bool, fehler: str | None = None) -> None:
        if self.protokoll is not None and not self.trocken:
            self.protokoll.schreibe(f"nacht_{art}", "nacht", ms, self.cfg.modell_text, ok, fehler)

    # --- Schritte ---

    def _schritte(self, art: str, k: Kontext, fenster: str) -> Iterator[Callable[[Kontext, str], None]]:
        if art == "fristen":
            yield from self._fristen_schritte()
        elif art == "zz":
            yield from self._zz_schritte(k)
        elif art == "selbsttest":
            yield from self._selbsttest_schritte(k, fenster)

    def _fristen_schritte(self) -> Iterator[Callable[[Kontext, str], None]]:
        karten = self.speicher.karten(fj.REZEPT)
        for zeile in self.speicher.texte():
            if zeile.zeichen <= 0:
                continue
            alt = karten.get(zeile.pfad)
            if alt and alt[0] == zeile.sha256 and (alt[1] != "fehler" or alt[2] >= MAX_VERSUCHE):
                continue

            def schritt(k: Kontext, lauf_id: str, zeile: TextZeile = zeile) -> None:
                self._fristen_eine(zeile, k, lauf_id)

            yield schritt

    def _fristen_eine(self, zeile: TextZeile, k: Kontext, lauf_id: str) -> None:
        z = self.zaehler["fristen"]
        z["dateien"] += 1
        text = self.speicher.text(zeile.pfad, zeile.sha256)
        if text is None:
            z["verschwunden"] += 1
            return
        start = time.monotonic()
        try:
            befund = fj.fristen_pruefen(pfad=zeile.pfad, dateiname=zeile.name, text=text, ocr=zeile.ocr,
                                        kontext_roh=k.daten, llm=self.llm, cfg=self.cfg, vorrang=self._warte_vorrang)
        except LlmFehler as e:
            ms = int((time.monotonic() - start) * 1000)
            z["modell_fehler"] += 1
            self.speicher.speichere_karte(zeile.pfad, zeile.sha256, fj.REZEPT, "fehler", None, self.cfg.modell_text)
            self._protokoll("fristen", ms, False, str(e)[:120])
            return
        if befund.status != "fertig":
            z[befund.status] += 1
            self.speicher.speichere_karte(zeile.pfad, zeile.sha256, fj.REZEPT, "ohne_treffer", befund, None)
            return
        z["kandidaten"] += 1
        z.update({f"fristen_{k_}": v for k_, v in befund.zaehler.items()})
        z["partei"] += bool(befund.partei)
        z["personenbezogen"] += befund.personenbezogen
        z["mit_frist"] += bool(befund.fristen)
        neu = self.speicher.speichere_fristen(zeile.pfad, zeile.sha256, befund, lauf_id) if befund.fristen else 0
        z["neu_im_puffer"] += neu
        self.speicher.speichere_karte(zeile.pfad, zeile.sha256, fj.REZEPT, "fertig", befund, befund.modell)
        self.dauern["fristen"].append(befund.dauer_ms)
        self._protokoll("fristen", befund.dauer_ms, True)

    def _zz_schritte(self, k: Kontext) -> Iterator[Callable[[Kontext, str], None]]:
        stand = self.speicher.zz_stand(zj.REZEPT)
        bekannt = k.bekannt_zz(zj.REZEPT)
        for zeile in self.speicher.texte():
            # Der ORDNER muss unter ZZ_* liegen (wie hatZzSegment(ordner_ist) im FSM) — eine Datei «ZZ_….pdf» in
            # einem normalen Ordner ist kein Rückstau (Trockenlauf 12.10.: 2 von 3 «Ziel = Ist»).
            if not unter_zz(zj.ordner_von(zeile.pfad)):
                continue
            alt = stand.get((zeile.pfad, zeile.sha256))
            if alt and (alt[0] != "fehler" or alt[1] >= MAX_VERSUCHE):
                continue
            if nfc(zeile.pfad) in bekannt:
                self.zaehler["zz"]["bekannt"] += 1
                continue

            def schritt(k: Kontext, lauf_id: str, zeile: TextZeile = zeile) -> None:
                self._zz_eine(zeile, k, lauf_id)

            yield schritt

    def _zz_eine(self, zeile: TextZeile, k: Kontext, lauf_id: str) -> None:
        z = self.zaehler["zz"]
        z["bearbeitet"] += 1
        text = self.speicher.text(zeile.pfad, zeile.sha256)
        if text is None:
            z["verschwunden"] += 1
            return
        start = time.monotonic()
        try:
            befund = zj.zz_beschreiben(pfad=zeile.pfad, dateiname=zeile.name, sha256=zeile.sha256, text=text,
                                       seiten=zeile.seiten, ocr=zeile.ocr, kontext_roh=k.daten, llm=self.llm,
                                       cfg=self.cfg, archiv=self.archiv, vorrang=self._warte_vorrang)
        except LlmFehler as e:
            ms = int((time.monotonic() - start) * 1000)
            z["modell_fehler"] += 1
            self.speicher.speichere_zz(zeile.pfad, zeile.sha256, zj.REZEPT, "fehler", None, lauf_id, grund="modell")
            self._protokoll("zz", ms, False, str(e)[:120])
            return
        self.speicher.speichere_zz(zeile.pfad, zeile.sha256, zj.REZEPT, befund.status, befund, lauf_id)
        self.dauern["zz"].append(befund.dauer_ms)
        z["ohne_text"] += zeile.zeichen <= 0
        z["personenbezogen"] += befund.personenbezogen
        if befund.status == "vorschlag":
            z["beschrieb"] += 1
            z["mit_fakten"] += bool(befund.fakten)
            z["mit_kandidaten"] += bool(befund.kandidaten)
            z["regel_hinweis"] += bool(befund.regel_ziel)
        else:
            z[f"kein_ziel_{befund.grund}"] += 1
        self._protokoll("zz", befund.dauer_ms, True)

    def _selbsttest_schritte(self, k: Kontext, fenster: str) -> Iterator[Callable[[Kontext, str], None]]:
        if self._selbst_teil[0] != fenster:
            self._selbst_teil = (fenster, {})
        erledigt = self._selbst_teil[1]
        erlaubt = {nfc(o) for o in k.ordner if not zj.gesperrt(nfc(o))}
        proben = sj.stichprobe(self.speicher.archiv_dateien(), erlaubt, sj.seed_fuer(fenster), self.cfg.selbsttest_n)
        for probe in proben:
            for variante in sj.VARIANTEN:
                if (probe.pfad, variante) in erledigt:
                    continue

                def schritt(k: Kontext, _lauf: str, probe: sj.Probe = probe, variante: str = variante) -> None:
                    try:
                        e = sj.pruefe_eine(probe, variante, kontext_roh=k.daten, llm=self.llm, cfg=self.cfg,
                                           archiv=self.archiv)
                    except LlmFehler:
                        e = {"variante": variante, "fehler": "modell", "ms": 0}
                    erledigt[(probe.pfad, variante)] = e
                    self.zaehler["selbsttest"]["schritte"] += 1
                    if not e.get("fehler"):
                        self.dauern["selbsttest"].append(int(e.get("ms") or 0))

                yield schritt

    def _selbsttest_abschluss(self, fenster: str) -> dict[str, Any]:
        ergebnisse = list(self._selbst_teil[1].values()) if self._selbst_teil[0] == fenster else []
        kennzahlen = {"ordnerwahl": sj.kennzahlen(ergebnisse), "egress": sj.egress_test(self.cfg),
                      "modelle": {"text": self.cfg.modell_text, "einbettung": self.cfg.modell_embed}}
        self.speicher.speichere_selbsttest(fenster, sj.seed_fuer(fenster), kennzahlen)
        self.stand["selbsttest"] = True
        self._selbst_teil = ("", {})
        log.info("Selbsttest %s: %s", fenster, json.dumps(kennzahlen, ensure_ascii=False))
        return kennzahlen

    # --- /health ---

    def status(self) -> dict[str, Any]:
        k = self.kontext.zuletzt
        melden: dict[str, Any] | None = None
        if self.melder is not None:
            melden = {"letzte": self.melder.letzte_meldung, "backoff_rest_s": self.melder.backoff_rest_s(),
                      "letzter_fehler": self.melder.letzter_fehler, **dict(self.melder.zaehler)}
        zeit, puffer = self._puffer_cache
        if time.monotonic() - zeit > 30:
            try:
                puffer = self.speicher.puffer()
            except Exception:  # noqa: BLE001
                puffer = None
            self._puffer_cache = (time.monotonic(), puffer)
        return {
            "aktiv": True,
            "modell": self.cfg.modell_text,
            "schalter": {"fristen": self.cfg.job_fristen, "zz": self.cfg.job_zz, "selbsttest": self.cfg.job_selbsttest},
            # «Arbeiten, wenn frei»: Fristen/ZZ auch tagsüber (KI_FREI_AKTIV).
            "frei": self.cfg.frei_aktiv,
            "laeuft": self.laeuft,
            "grund": self.grund,
            "kontext": {"alter_s": int(k.alter_s()) if k else None, "ordner": len(k.ordner) if k else None,
                        "fehler": self.kontext.letzter_fehler},
            "nacht": {**self.stand, "zz_max": self.cfg.job_zz_max,
                      "zaehler": {a: dict(c) for a, c in self.zaehler.items() if c}},
            "puffer": puffer,
            "melden": melden,
            "tresor": self.speicher.zaehler(),
            "selbsttest": self.speicher.letzter_selbsttest(),
        }

    # --- Trockenlauf ---

    def trockenlauf(self, *, fristen_max: int | None, zz_max: int, selbsttest: bool, warte_s: float = 5.0) -> dict[str, Any]:
        """Sofort (ohne Nachtfenster), nur bei Ruhe des Dienstes; nichts wird gemeldet oder gespeichert."""
        start = time.monotonic()
        fenster = f"{self.uhr().date().isoformat()}/{NACHT}"
        k = self.kontext.aktuell(neu=True)
        if k is None:
            return {"ok": False, "grund": "kein_kontext", "fehler": self.kontext.letzter_fehler}

        def weiter(_art: str) -> str | None:
            gewartet = 0.0
            while not self.ruhig():
                if self._halt.is_set():
                    return "halt"
                time.sleep(warte_s)
                gewartet += warte_s
            if gewartet:
                self.zaehler[_art]["gewartet_s"] += int(gewartet)
            return None

        laeufe: dict[str, Any] = {}
        for art, an, grenze in (("fristen", self.cfg.job_fristen, fristen_max), ("zz", self.cfg.job_zz, zz_max),
                                ("selbsttest", self.cfg.job_selbsttest and selbsttest, None)):
            if not an:
                continue
            t0 = time.monotonic()
            ende = self.fahre(art, k, fenster, weiter, grenze=grenze)
            laeufe[art] = {"ende": ende, "dauer_s": int(time.monotonic() - t0)}
            if art == "selbsttest" and ende == "fertig":
                laeufe[art]["kennzahlen"] = self._selbsttest_abschluss(fenster)
        aus: dict[str, Any] = {"ok": True, "dauer_s": int(time.monotonic() - start), "modell": self.cfg.modell_text,
                               "kontext": {"ordner": len(k.ordner),
                                           "vorschlaege_bekannt": len(k.daten.get("vorschlaege_bekannt") or []),
                                           "fristen_bekannt": len(k.daten.get("fristen_bekannt") or [])}}
        for art, lauf in laeufe.items():
            d = self.dauern.get(art) or []
            aus[art] = {**lauf, "zaehler": dict(sorted(self.zaehler[art].items())),
                        "ms_median": int(statistics.median(d)) if d else None, "ms_max": max(d) if d else None}
        return aus


class LiveRuhe:
    """Trockenlauf im Container: Ruhe = /health des laufenden Dienstes zeigt keine Warteschlange und keinen laufenden
    Auftrag, seit mindestens ruhe_s. Nicht erreichbar = keine Ruhe."""

    def __init__(self, url: str, ruhe_s: float = RUHE_S) -> None:
        self.url = url
        self.ruhe_s = ruhe_s
        self._ruhig_seit: float | None = None

    def __call__(self) -> bool:
        try:
            with urllib.request.urlopen(self.url, timeout=5) as r:  # noqa: S310 — feste lokale Adresse
                d = json.loads(r.read().decode("utf-8"))
            belegt = bool(d.get("warteschlange")) or bool(d.get("laeuft"))
        except Exception:  # noqa: BLE001
            belegt = True
        jetzt = time.monotonic()
        if belegt:
            self._ruhig_seit = None
            return False
        if self._ruhig_seit is None:
            self._ruhig_seit = jetzt
        return jetzt - self._ruhig_seit >= self.ruhe_s


def fuer_dienst(cfg: Einstellungen, fsm: Any, llm: Any, archiv: Any, protokoll: Any, *,
                ruhig: Callable[[], bool], vorarbeit_laeuft: Callable[[], bool],
                speicher_ok: Callable[[], bool] = lambda: True) -> Nachtarbeit:
    """Der Thread im laufenden Dienst (main.py): Tresor-Tabellen, Kontext im Tresor, Melder an."""
    speicher = NachtSpeicher(cfg.pg_dsn)
    return Nachtarbeit(
        cfg, llm, archiv, speicher, KontextQuelle(fsm, cfg.data_dir, cfg.kontext_max_alter_s),
        melder=Melder(speicher, fsm, modell=cfg.modell_text), ruhig=ruhig, vorarbeit_laeuft=vorarbeit_laeuft,
        speicher_ok=speicher_ok, protokoll=protokoll, stand_datei=cfg.data_dir / STAND_DATEI,
    )


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="app.nachtarbeit", description="Nachtarbeit: Trockenlauf ohne Meldung ans FSM")
    sub = p.add_subparsers(dest="befehl", required=True)
    t = sub.add_parser("trocken", help="Jobs mit KI_JOB_*=1 (nur für diesen Prozess) sofort rechnen, nur Kennzahlen")
    t.add_argument("--fristen-max", type=int, default=0, help="höchstens so viele Dateien prüfen (0 = alle)")
    t.add_argument("--zz-max", type=int, default=None, help="höchstens so viele ZZ-Dateien (Standard KI_JOB_ZZ_MAX)")
    t.add_argument("--ohne-selbsttest", action="store_true")
    t.add_argument("--health-url", default="http://127.0.0.1:8700/health")
    a = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    for bib in ("httpx", "httpcore"):
        logging.getLogger(bib).setLevel(logging.WARNING)
    logging.getLogger("pypdf").setLevel(logging.ERROR)

    from .archiv import ArchivIndex, rezept_fuer
    from .config import EINSTELLUNGEN as cfg
    from .fsm import FsmClient
    from .llm import Ollama

    if not cfg.nachtarbeit_aktiv:
        print("Kein Schalter KI_JOB_FRISTEN/KI_JOB_ZZ/KI_JOB_SELBSTTEST für diesen Prozess gesetzt (docker exec -e …)",
              file=sys.stderr)
        return 2
    if not cfg.pg_dsn or not cfg.sync_token:
        print("PG_PASSWORD oder KI_SYNC_TOKEN fehlt", file=sys.stderr)
        return 2
    fsm = FsmClient(cfg)
    speicher = NachtSpeicher(cfg.pg_dsn, trocken=True)
    archiv = ArchivIndex(cfg.pg_dsn, rezept_fuer(cfg))
    na = Nachtarbeit(cfg, Ollama(cfg), archiv, speicher, KontextQuelle(NurKontext(fsm), None, cfg.kontext_max_alter_s),
                     melder=None, ruhig=LiveRuhe(a.health_url), trocken=True)
    try:
        ergebnis = na.trockenlauf(fristen_max=a.fristen_max or None,
                                  zz_max=cfg.job_zz_max if a.zz_max is None else a.zz_max,
                                  selbsttest=not a.ohne_selbsttest)
    finally:
        fsm.schliessen()
        speicher.schliessen()
        archiv.schliessen()
    print(json.dumps(ergebnis, ensure_ascii=False, indent=1))
    return 0 if ergebnis.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
