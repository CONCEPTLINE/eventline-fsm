"""Lokales Protokoll (Tabelle ki_protokoll in der Rig-DB) — nur Metadaten.

Zeit, Art, Quelle (fsm|direkt|nacht|rig), Dauer, Modell, ok/Fehlertext. Nie Inhalte, nie
Dateinamen. Ein ausgefallenes Protokoll darf die Verarbeitung nie blockieren:
Fehler werden geloggt und geschluckt, die Verbindung beim nächsten Eintrag neu
aufgebaut (höchstens alle 30 s ein Versuch).

Seit 15.10.2026 (Leistung im Technik-Dashboard, VERTRAG §2.6) je Auftrag mit Dokument dazu nur Zahlen über das
gelesene Dokument: Seiten, Zeichen des gelesenen Texts, gescannt (Texterkennung bzw. Foto) und Anzahl Teile, in
denen die KI es gelesen hat (Rückstau ZZ: Teile zu 10 000 Zeichen; Ablage und Belege: 1). Fehlt etwas, bleibt es
leer — geschätzt wird nichts.

Seit 16.10.2026 (Belegstellen, zz/v4 und fristen/v3) je Nachtarbeit-Datei `belege`: {feld: {angegeben, belegt}} — wie
viele Angaben der lokalen KI einen wörtlichen Beleg im Dokument hatten. Nur Zahlen, nie Belege oder Werte.
"""

from __future__ import annotations

import json
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
-- Kennzahlen des gelesenen Dokuments (15.10.2026). Nur anlegen, wenn sie fehlen: ADD COLUMN IF NOT EXISTS nähme
-- bei jeder neuen Verbindung eine exklusive Sperre (wie archiv_text.versuche in tiefe.py).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                 AND table_name = 'ki_protokoll' AND column_name = 'seiten') THEN
    ALTER TABLE ki_protokoll ADD COLUMN seiten integer, ADD COLUMN zeichen integer,
                             ADD COLUMN gescannt boolean, ADD COLUMN teile integer;
  END IF;
  -- Belegquote (16.10.2026, zz/v4 + fristen/v3): je Datei {feld: {angegeben, belegt}} — nur Zahlen.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                 AND table_name = 'ki_protokoll' AND column_name = 'belege') THEN
    ALTER TABLE ki_protokoll ADD COLUMN belege jsonb;
  END IF;
END $$;
"""

# Obergrenzen der Kennzahlen (passen in integer; grösser = Unsinn, bleibt leer).
KENNZAHL_MAX = {"seiten": 100_000, "zeichen": 100_000_000, "teile": 100_000}
# Felder der Belegquote (= jobs/zz.ZAEHL_FELDER + «fristen»); andere Schlüssel fallen weg.
BELEG_FELDER = ("datum", "zeitraum", "status", "bezug", "absender", "empfaenger", "beteiligte", "rolle", "fristen")
BELEG_MAX = 10_000


def belege_pruefen(roh: object) -> dict[str, dict[str, int]] | None:
    """{feld: {angegeben, belegt}} nur mit bekannten Feldern und ganzen Zahlen 0 ≤ belegt ≤ angegeben ≤ BELEG_MAX."""
    if not isinstance(roh, dict):
        return None
    aus: dict[str, dict[str, int]] = {}
    for feld, w in roh.items():
        if feld not in BELEG_FELDER or not isinstance(w, dict):
            continue
        a, b = w.get("angegeben"), w.get("belegt")
        if any(isinstance(x, bool) or not isinstance(x, int) for x in (a, b)):
            continue
        if 0 <= b <= a <= BELEG_MAX and a > 0:
            aus[feld] = {"angegeben": a, "belegt": b}
    return aus or None

_QUERY = re.compile(r"\?[^\s'\"<>]*")


def kennzahl(wert: object, name: str) -> int | None:
    """Ganze Zahl 0 … KENNZAHL_MAX[name], sonst None (bool, Text, Negatives, zu Grosses)."""
    if isinstance(wert, bool) or not isinstance(wert, int) or wert < 0 or wert > KENNZAHL_MAX[name]:
        return None
    return wert


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
        *,
        seiten: int | None = None,
        zeichen: int | None = None,
        gescannt: bool | None = None,
        teile: int | None = None,
        belege: dict[str, dict[str, int]] | None = None,
    ) -> None:
        if not self._dsn:
            return
        text = None
        if fehler:
            text = _QUERY.sub("?…", str(fehler))[:300]
        geprueft = belege_pruefen(belege)
        werte = (
            art[:60], quelle[:20], dauer_ms, (modell or None), ok, text,
            kennzahl(seiten, "seiten"), kennzahl(zeichen, "zeichen"),
            gescannt if isinstance(gescannt, bool) else None, kennzahl(teile, "teile"),
            json.dumps(geprueft) if geprueft else None,
        )
        with self._lock:
            try:
                if self._conn is None or self._conn.closed:
                    if time.monotonic() - self._letzter_versuch < 30:
                        return
                    self._letzter_versuch = time.monotonic()
                    self._verbinden()
                with self._conn.cursor() as c:  # type: ignore[union-attr]
                    c.execute(
                        "INSERT INTO ki_protokoll (art, quelle, dauer_ms, modell, ok, fehler, seiten, zeichen, gescannt, teile,"
                        " belege) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)",
                        werte,
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
