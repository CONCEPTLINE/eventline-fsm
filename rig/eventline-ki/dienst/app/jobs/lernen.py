"""Live-Trefferquote der Ordnerwahl (Masterplan §2.7 «Lernschleife = Vorbilder-Index + Messung», E2.7).
Schalter KI_LERNEN_AKTIV.

1. Nach jeder ablage_analyse merkt der Worker den Vorschlag im Tresor: Tabelle ablage_vorschlaege(sha256,
   ordner_vorschlag, alternativen, quelle, modell, zeit) — nur Pfade, kein Name, kein Text. Geschrieben wird in
   einem eigenen Thread über eine Warteschlange: der Live-Pfad wartet nie auf die Datenbank.
2. Nach jedem Lauf des Vorbilder-Index (beim Start und nachts) wird ausgewertet: wo liegt die Datei tatsächlich?
   (gleicher sha256 in archiv_dateien → Ordner). top1 = Vorschlag ist dieser Ordner, top3 = Vorschlag oder eine der
   zwei Alternativen. Je Tag (Datum des Vorschlags, Europe/Zurich; je Datei der letzte Vorschlag des Tages) →
   qualitaet_tag(datum, n, top1, top3, ohne_vorschlag). Dateien unter ZZ_* stehen nicht im Vorbilder-Index und
   zählen nicht.
3. Keine Gewichtsänderung, nichts geht ans FSM — nur die Quote in /health. Aufbewahrung 90 Tage.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from typing import Any, Callable

log = logging.getLogger("ki.lernen")

AUFBEWAHRUNG_TAGE = 90
WARTESCHLANGE_MAX = 1000

DDL = """
CREATE TABLE IF NOT EXISTS ablage_vorschlaege (
  id                bigserial PRIMARY KEY,
  sha256            text        NOT NULL,
  ordner_vorschlag  text,
  alternativen      text[]      NOT NULL DEFAULT '{}',
  quelle            text,
  modell            text,
  zeit              timestamptz NOT NULL DEFAULT now(),
  ist_ordner        text[],
  bewertet          timestamptz
);
CREATE INDEX IF NOT EXISTS ablage_vorschlaege_sha_idx ON ablage_vorschlaege (sha256);
CREATE INDEX IF NOT EXISTS ablage_vorschlaege_offen_idx ON ablage_vorschlaege (zeit) WHERE bewertet IS NULL;
CREATE TABLE IF NOT EXISTS qualitaet_tag (
  datum           date PRIMARY KEY,
  n               integer     NOT NULL,
  top1            integer     NOT NULL,
  top3            integer     NOT NULL,
  ohne_vorschlag  integer     NOT NULL DEFAULT 0,
  aktualisiert    timestamptz NOT NULL DEFAULT now()
);
"""

# Tatsächlicher Ablageort: alle Ordner, in denen der Vorbilder-Index eine Datei mit diesem sha256 führt.
SQL_BEWERTEN = """
UPDATE ablage_vorschlaege v SET ist_ordner = s.ordner, bewertet = now()
FROM (SELECT sha256, array_agg(DISTINCT ordner) AS ordner FROM archiv_dateien GROUP BY sha256) s
WHERE v.bewertet IS NULL AND v.sha256 = s.sha256
"""

SQL_TAGE = """
INSERT INTO qualitaet_tag (datum, n, top1, top3, ohne_vorschlag, aktualisiert)
SELECT d, count(*), count(*) FILTER (WHERE t1), count(*) FILTER (WHERE t3),
       count(*) FILTER (WHERE ordner_vorschlag IS NULL), now()
FROM (
  SELECT DISTINCT ON (d, sha256) d, sha256, ordner_vorschlag,
         (ordner_vorschlag = ANY (ist_ordner)) AS t1,
         (ordner_vorschlag = ANY (ist_ordner) OR alternativen && ist_ordner) AS t3
  FROM (SELECT (zeit AT TIME ZONE 'Europe/Zurich')::date AS d, * FROM ablage_vorschlaege WHERE bewertet IS NOT NULL) b
  ORDER BY d, sha256, zeit DESC
) x
GROUP BY d
ON CONFLICT (datum) DO UPDATE SET n = EXCLUDED.n, top1 = EXCLUDED.top1, top3 = EXCLUDED.top3,
  ohne_vorschlag = EXCLUDED.ohne_vorschlag, aktualisiert = now()
"""


def vorschlag_aus(ergebnis: dict[str, Any], messung: dict[str, Any] | None) -> dict[str, Any] | None:
    """Was aus einem ablage_analyse-Ergebnis gemerkt wird — nur sha256, Ordnerpfade, Quelle, Modell."""
    sha = ergebnis.get("sha256")
    if not isinstance(sha, str) or len(sha) != 64:
        return None
    ordner = ergebnis.get("ordner") if isinstance(ergebnis.get("ordner"), str) and ergebnis.get("ordner") else None
    alt = [a for a in (ergebnis.get("ordner_alternativen") or []) if isinstance(a, str) and a][:2]
    quelle = (messung or {}).get("quelle")
    return {
        "sha256": sha,
        "ordner_vorschlag": ordner,
        "alternativen": alt,
        "quelle": str(quelle)[:20] if quelle else None,
        "modell": str(ergebnis.get("modell") or "")[:80] or None,
    }


def quote(zeilen: list[tuple[int, int, int]]) -> dict[str, Any]:
    """[(n, top1, top3)] → Summe und Anteile (für /health)."""
    n = sum(z[0] for z in zeilen)
    t1 = sum(z[1] for z in zeilen)
    t3 = sum(z[2] for z in zeilen)
    return {
        "n": n,
        "top1": round(t1 / n, 3) if n else None,
        "top3": round(t3 / n, 3) if n else None,
    }


class Lernen(threading.Thread):
    """Schreibt die gemerkten Vorschläge (Warteschlange) und wertet nach jedem Vorbilder-Lauf aus."""

    def __init__(self, dsn: str | None, *, vorbilder_lauf: Callable[[], str | None] = lambda: None) -> None:
        super().__init__(name="ki-lernen", daemon=True)
        self._dsn = dsn
        self.vorbilder_lauf = vorbilder_lauf
        self._q: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=WARTESCHLANGE_MAX)
        self._halt = threading.Event()
        self._conn = None
        self._letzter_versuch = 0.0
        self._ausgewertet_fuer: str | None = None
        self.letzte_auswertung: float | None = None
        self.verworfen = 0
        self._status_cache: tuple[float, dict[str, Any]] = (0.0, {})
        self._lock = threading.Lock()

    @property
    def aktiv(self) -> bool:
        return self._dsn is not None

    def stop(self) -> None:
        self._halt.set()

    # --- Live-Pfad: nie blockieren -----------------------------------------------------------

    def merke(self, ergebnis: dict[str, Any], messung: dict[str, Any] | None = None) -> bool:
        """Vom Worker nach jeder ablage_analyse. Wirft nie, wartet nie."""
        try:
            v = vorschlag_aus(ergebnis, messung)
            if v is None:
                return False
            self._q.put_nowait(v)
            return True
        except queue.Full:
            self.verworfen += 1
            return False
        except Exception:  # noqa: BLE001 — Messung darf den Live-Pfad nie stören
            return False

    # --- Datenbank ----------------------------------------------------------------------------

    def _verbindung(self):
        import psycopg

        if self._conn is not None and not self._conn.closed:
            return self._conn
        if time.monotonic() - self._letzter_versuch < 30:
            raise ConnectionError("Lern-DB kurz zuvor nicht erreichbar")
        self._letzter_versuch = time.monotonic()
        self._conn = psycopg.connect(self._dsn, autocommit=True)
        with self._conn.cursor() as c:
            c.execute(DDL)
        return self._conn

    def _sql(self, sql: str, werte: tuple = (), *, holen: bool = False) -> list[tuple]:
        if not self._dsn:
            return []
        with self._lock:
            try:
                with self._verbindung().cursor() as c:
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

    def _schreibe(self, v: dict[str, Any]) -> None:
        self._sql(
            """INSERT INTO ablage_vorschlaege (sha256, ordner_vorschlag, alternativen, quelle, modell)
               VALUES (%s, %s, %s, %s, %s)""",
            (v["sha256"], v["ordner_vorschlag"], v["alternativen"], v["quelle"], v["modell"]),
        )

    def auswerten(self) -> dict[str, int]:
        """Bewerten (sha256 im Vorbilder-Index), Tageswerte neu rechnen, Altes löschen. Nur Zahlen zurück."""
        vorhanden = self._sql("SELECT to_regclass('archiv_dateien') IS NOT NULL", holen=True)
        if not vorhanden or not vorhanden[0][0]:
            return {"bewertet": 0}
        bewertet = self._sql(SQL_BEWERTEN + " RETURNING v.id", holen=True)
        self._sql(SQL_TAGE)
        self._sql(f"DELETE FROM ablage_vorschlaege WHERE zeit < now() - interval '{AUFBEWAHRUNG_TAGE} days'")
        self._sql(f"DELETE FROM qualitaet_tag WHERE datum < current_date - {AUFBEWAHRUNG_TAGE}")
        self.letzte_auswertung = time.time()
        self._status_cache = (0.0, {})
        return {"bewertet": len(bewertet)}

    def status(self) -> dict[str, Any]:
        """Für /health: Quote der letzten 7 und 30 Tage, offene (noch nicht abgelegte) Vorschläge — nur Zahlen."""
        zeit, wert = self._status_cache
        if wert and time.monotonic() - zeit < 60:
            return wert
        aus: dict[str, Any] = {"aktiv": True, "verworfen": self.verworfen}
        try:
            for tage in (7, 30):
                zeilen = self._sql(
                    "SELECT n, top1, top3 FROM qualitaet_tag WHERE datum > current_date - %s", (tage,), holen=True,
                )
                aus[f"tage_{tage}"] = quote([(int(a), int(b), int(c)) for a, b, c in zeilen])
            z = self._sql(
                "SELECT count(*) FILTER (WHERE bewertet IS NULL), count(*) FROM ablage_vorschlaege", holen=True,
            )
            aus["offen"], aus["gemerkt"] = (int(z[0][0]), int(z[0][1])) if z else (None, None)
        except Exception as e:  # noqa: BLE001
            aus["fehler"] = type(e).__name__
        aus["letzte_auswertung"] = None if self.letzte_auswertung is None else int(self.letzte_auswertung)
        self._status_cache = (time.monotonic(), aus)
        return aus

    # --- Schleife -----------------------------------------------------------------------------

    def run(self) -> None:
        log.info("Live-Trefferquote: Vorschläge werden gemerkt, Auswertung nach jedem Vorbilder-Lauf")
        while not self._halt.is_set():
            try:
                v = self._q.get(timeout=30.0)
            except queue.Empty:
                v = None
            if v is not None:
                try:
                    self._schreibe(v)
                except Exception as e:  # noqa: BLE001 — eine Messzeile weniger, nie ein Absturz
                    self.verworfen += 1
                    log.warning("Live-Trefferquote: Vorschlag nicht gespeichert (%s)", type(e).__name__)
            lauf = self.vorbilder_lauf()
            if lauf and lauf != self._ausgewertet_fuer:
                try:
                    zahlen = self.auswerten()
                    self._ausgewertet_fuer = lauf
                    log.info("Live-Trefferquote ausgewertet: %d Vorschläge neu bewertet", zahlen.get("bewertet", 0))
                except Exception as e:  # noqa: BLE001 — nächster Versuch in der nächsten Runde (≤ 30 s)
                    log.warning("Live-Trefferquote: Auswertung fehlgeschlagen (%s)", type(e).__name__)
        # Rest der Warteschlange noch schreiben (kurz).
        while True:
            try:
                self._schreibe(self._q.get_nowait())
            except queue.Empty:
                break
            except Exception:  # noqa: BLE001
                break
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:  # noqa: BLE001
                pass
