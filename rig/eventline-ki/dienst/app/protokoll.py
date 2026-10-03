"""Lokales Protokoll (Tabelle ki_protokoll in der Rig-DB) — nur Metadaten.

Zeit, Art, Quelle (fsm|direkt), Dauer, Modell, ok/Fehlertext. Nie Inhalte, nie
Dateinamen. Ein ausgefallenes Protokoll darf die Verarbeitung nie blockieren:
Fehler werden geloggt und geschluckt, die Verbindung beim nächsten Eintrag neu
aufgebaut (höchstens alle 30 s ein Versuch).
"""

from __future__ import annotations

import logging
import re
import threading
import time

log = logging.getLogger("ki.protokoll")

DDL = """
CREATE TABLE IF NOT EXISTS ki_protokoll (
  id        bigserial PRIMARY KEY,
  zeit      timestamptz NOT NULL DEFAULT now(),
  art       text        NOT NULL,
  quelle    text        NOT NULL,
  dauer_ms  integer,
  modell    text,
  ok        boolean     NOT NULL,
  fehler    text
);
CREATE INDEX IF NOT EXISTS ki_protokoll_zeit_idx ON ki_protokoll (zeit DESC);
"""

_QUERY = re.compile(r"\?[^\s'\"<>]*")


class Protokoll:
    def __init__(self, dsn: str | None) -> None:
        self._dsn = dsn
        self._lock = threading.Lock()
        self._conn = None
        self._letzter_versuch = 0.0

    @property
    def aktiv(self) -> bool:
        return self._dsn is not None

    def start(self, versuche: int = 5) -> bool:
        if not self._dsn:
            log.warning("Protokoll aus: PG_PASSWORD fehlt")
            return False
        for i in range(versuche):
            try:
                with self._lock:
                    self._verbinden()
                log.info("Protokoll bereit (ki_protokoll)")
                return True
            except Exception as e:  # noqa: BLE001
                log.warning("Protokoll-DB noch nicht erreichbar (%s), Versuch %d/%d", type(e).__name__, i + 1, versuche)
                time.sleep(2)
        return False

    def _verbinden(self) -> None:
        import psycopg

        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:  # noqa: BLE001
                pass
        self._conn = psycopg.connect(self._dsn, autocommit=True)
        with self._conn.cursor() as c:
            c.execute(DDL)

    def schreibe(
        self,
        art: str,
        quelle: str,
        dauer_ms: int | None,
        modell: str | None,
        ok: bool,
        fehler: str | None = None,
    ) -> None:
        if not self._dsn:
            return
        text = None
        if fehler:
            text = _QUERY.sub("?…", str(fehler))[:300]
        with self._lock:
            try:
                if self._conn is None or self._conn.closed:
                    if time.monotonic() - self._letzter_versuch < 30:
                        return
                    self._letzter_versuch = time.monotonic()
                    self._verbinden()
                with self._conn.cursor() as c:  # type: ignore[union-attr]
                    c.execute(
                        "INSERT INTO ki_protokoll (art, quelle, dauer_ms, modell, ok, fehler) VALUES (%s, %s, %s, %s, %s, %s)",
                        (art[:60], quelle[:20], dauer_ms, (modell or None), ok, text),
                    )
            except Exception as e:  # noqa: BLE001
                log.warning("Protokoll-Eintrag fehlgeschlagen (%s)", type(e).__name__)
                try:
                    if self._conn is not None:
                        self._conn.close()
                except Exception:  # noqa: BLE001
                    pass
                self._conn = None

    def schliessen(self) -> None:
        with self._lock:
            if self._conn is not None:
                try:
                    self._conn.close()
                except Exception:  # noqa: BLE001
                    pass
                self._conn = None
