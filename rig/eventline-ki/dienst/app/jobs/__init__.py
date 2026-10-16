"""Jobs des Hauptmodells (Masterplan §2.3): lokale Job-Liste im Tresor und die Job-Arten.

Ein Job besteht aus Schritten; ein Schritt = eine Zeile in hg_auftraege (meist eine Datei), idempotent über
UNIQUE(art, schluessel, rezept). Der Hintergrund-Thread (hintergrund.py) nimmt den nächsten Schritt einer
erlaubten Art und ruft die Funktion der Art mit einem SchrittKontext auf; der Kontext kennt Modell, Optionen,
Abbruch-Event und Frist (KI_HG_SCHRITT_MAX_S). Nie Inhalte in Status, Fehlertext oder Protokoll — der
Schlüssel (z. B. ein Pfad) bleibt in der Tabelle und wird nie geloggt.

Arten: «probe» (harmlose Rechenaufgabe ohne Dokument, für die Abnahme; anlegen mit `python -m app.hintergrund probe`)
und seit 16.10.2026 «zweiter_blick» (jobs/zweiter_blick.py, Schalter KI_JOB_ZWEITER_BLICK, nur nachts; die Schritte legt
die Nachtarbeit an, sobald das schnelle Modell fertig ist; main.py hängt den Job an JOBS an — er braucht Tresor, Kontext
und die schnelle Instanz). Die Reihenfolge der Liste ist die Reihenfolge der Abarbeitung.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

from ..config import Einstellungen
from ..llm import LlmFehler, json_aus_text

log = logging.getLogger("ki.jobs")

STATUS = ("offen", "laeuft", "pausiert", "fertig", "fehler")
MAX_VERSUCHE = 3

DDL = """
CREATE TABLE IF NOT EXISTS hg_auftraege (
  id         bigserial PRIMARY KEY,
  art        text        NOT NULL,
  schluessel text        NOT NULL,
  rezept     text        NOT NULL,
  status     text        NOT NULL DEFAULT 'offen'
             CHECK (status IN ('offen', 'laeuft', 'pausiert', 'fertig', 'fehler')),
  versuche   integer     NOT NULL DEFAULT 0,
  erstellt   timestamptz NOT NULL DEFAULT now(),
  begonnen   timestamptz,
  beendet    timestamptz,
  fehler     text,
  UNIQUE (art, schluessel, rezept)
);
CREATE INDEX IF NOT EXISTS hg_auftraege_status_idx ON hg_auftraege (status, art, erstellt);
"""


class JobFehler(Exception):
    """Fachlicher Fehler eines Schritts (Klartext ohne Inhalte) → Schritt «fehler», weiter mit dem nächsten."""


@dataclass(frozen=True)
class Schritt:
    id: int
    art: str
    schluessel: str
    rezept: str
    status: str
    versuche: int


@dataclass
class SchrittKontext:
    modell: str
    optionen: dict[str, Any]
    abbruch: threading.Event
    frist: float                     # time.monotonic(), bis wann der Schritt fertig sein muss
    chat_stream: Callable[..., tuple[str, dict[str, Any]]]
    keep_alive: str
    pruefe: Callable[[], str | None] | None = None

    def chat_json(
        self, *, system: str, nutzer: str, schema: dict[str, Any], think: bool = True,
        bilder: list[str] | None = None, optionen: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """Schemagebundene Antwort des Hauptmodells (think + format gehen zusammen, gemessen E2.2)."""
        nachricht: dict[str, Any] = {"role": "user", "content": nutzer}
        if bilder:
            nachricht["images"] = bilder
        text, meta = self.chat_stream(
            modell=self.modell,
            nachrichten=[{"role": "system", "content": system}, nachricht],
            optionen={**self.optionen, "temperature": 0, **(optionen or {})},
            keep_alive=self.keep_alive,
            format=schema,
            think=think,
            abbruch=self.abbruch,
            frist_s=max(1.0, self.frist - time.monotonic()),
            pruefe=self.pruefe,
        )
        daten = json_aus_text(text)
        if daten is None:
            raise LlmFehler(f"Modell {self.modell} lieferte kein gültiges JSON")
        return daten, meta


@dataclass(frozen=True)
class Job:
    art: str
    ausfuehren: Callable[[Schritt, SchrittKontext], dict[str, Any] | None]
    # Ist die Art eingeschaltet? (E4: KI_JOB_*); «probe» ist immer an, weil sie nur von Hand angelegt wird.
    aktiv: Callable[[Einstellungen], bool]
    modi: tuple[str, ...] = ("nacht", "tag")
    # Höchstdauer eines Schritts dieser Art (s); None = KI_HG_SCHRITT_MAX_S. Zweiter Blick: ein ganzes Dokument in Teilen.
    max_s: int | None = None


# --- Art «probe» ---------------------------------------------------------------------------

PROBE_REZEPT = "probe/v1"
_PROBE_SCHEMA = {
    "type": "object",
    "properties": {"ok": {"type": "boolean"}, "summe": {"type": "integer"}},
    "required": ["ok", "summe"],
}


def _probe(_schritt: Schritt, ctx: SchrittKontext) -> dict[str, Any]:
    daten, meta = ctx.chat_json(
        system="Du bist ein Prüfprogramm. Antworte nur im verlangten JSON.",
        nutzer="Rechne 17 + 25. Setze «summe» auf das Ergebnis und «ok» auf true.",
        schema=_PROBE_SCHEMA,
    )
    if daten.get("ok") is not True or daten.get("summe") != 42:
        raise JobFehler("Probe: unerwartete Antwort")
    return meta


JOBS: tuple[Job, ...] = (
    Job("probe", _probe, lambda _cfg: True),
)


def job(art: str, jobs: tuple[Job, ...] = JOBS) -> Job | None:
    return next((j for j in jobs if j.art == art), None)


# --- Job-Liste im Tresor (Rig-DB) ----------------------------------------------------------


class JobListe:
    """Tabelle hg_auftraege. Fällt die DB aus, liefert naechster() None — der Hintergrund wartet dann."""

    def __init__(self, dsn: str | None) -> None:
        self._dsn = dsn
        self._lock = threading.Lock()
        self._conn = None
        self._letzter_versuch = 0.0

    @property
    def aktiv(self) -> bool:
        return self._dsn is not None

    def _verbindung(self):
        import psycopg

        if self._conn is not None and not self._conn.closed:
            return self._conn
        if time.monotonic() - self._letzter_versuch < 30:
            raise ConnectionError("Job-DB kurz zuvor nicht erreichbar")
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

    def start(self) -> int:
        """Nach einem Neustart: «laeuft» war unterbrochen → wieder «offen» (der Versuch zählt)."""
        zeilen = self._ausfuehren(
            "UPDATE hg_auftraege SET status = 'offen' WHERE status = 'laeuft' RETURNING id", holen=True,
        )
        return len(zeilen)

    def anlegen(self, art: str, schluessel: str, rezept: str) -> bool:
        zeilen = self._ausfuehren(
            """INSERT INTO hg_auftraege (art, schluessel, rezept) VALUES (%s, %s, %s)
               ON CONFLICT (art, schluessel, rezept) DO NOTHING RETURNING id""",
            (art, schluessel, rezept), holen=True,
        )
        return bool(zeilen)

    def naechster(self, arten: list[str]) -> Schritt | None:
        """Nächster Schritt: Arten in der übergebenen Reihenfolge, je Art zuerst pausierte, dann älteste."""
        if not arten:
            return None
        zeilen = self._ausfuehren(
            """SELECT id, art, schluessel, rezept, status, versuche FROM hg_auftraege
               WHERE status IN ('offen', 'pausiert') AND art = ANY(%s)
               ORDER BY array_position(%s::text[], art), (status = 'pausiert') DESC, erstellt, id
               LIMIT 1""",
            (arten, arten), holen=True,
        )
        if not zeilen:
            return None
        z = zeilen[0]
        return Schritt(int(z[0]), str(z[1]), str(z[2]), str(z[3]), str(z[4]), int(z[5]))

    def beginne(self, schritt_id: int) -> None:
        self._ausfuehren(
            """UPDATE hg_auftraege SET status = 'laeuft', versuche = versuche + 1, begonnen = now(),
               beendet = NULL, fehler = NULL WHERE id = %s""",
            (schritt_id,),
        )

    def beende(self, schritt_id: int, status: str, fehler: str | None = None, *, versuch_zaehlt: bool = True) -> None:
        if status not in STATUS or status == "laeuft":
            raise ValueError(f"ungültiger Status {status!r}")
        self._ausfuehren(
            """UPDATE hg_auftraege SET status = %s, fehler = %s,
               beendet = CASE WHEN %s IN ('fertig', 'fehler') THEN now() ELSE NULL END,
               versuche = CASE WHEN %s THEN versuche ELSE GREATEST(versuche - 1, 0) END
               WHERE id = %s""",
            (status, (fehler or None) and str(fehler)[:200], status, versuch_zaehlt, schritt_id),
        )

    def zaehler(self) -> dict[str, int]:
        zeilen = self._ausfuehren("SELECT status, count(*) FROM hg_auftraege GROUP BY status", holen=True)
        werte = {s: 0 for s in STATUS}
        werte.update({str(z[0]): int(z[1]) for z in zeilen})
        return werte

    def schliessen(self) -> None:
        with self._lock:
            if self._conn is not None:
                try:
                    self._conn.close()
                except Exception:  # noqa: BLE001
                    pass
                self._conn = None
