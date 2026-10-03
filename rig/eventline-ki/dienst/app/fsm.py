"""Verbindung zum FSM: Warteschlange (/api/ki/sync), Herzschlag und Datei-Downloads.

Alles läuft über den Egress-Proxy (HTTPS_PROXY) — der Dienst hat sonst keinen
Weg nach draussen. Signierte URLs tragen ihr Geheimnis in der Query und werden
deshalb nie geloggt; Fehlermeldungen werden vorher bereinigt.

Form der Antwort auf GET /api/ki/sync (src/lib/ki/typen.ts, KiSyncAuftrag):
  { success, auftraege: [ { id, art, versuche,
                            payload: { storage_path, file_name, mime, size, url },
                            kontext?: { ordner: [...], dok_typen: [{key,label,person}], mitarbeiter: [...], heute } } ] }
Arten mit Datei: ablage_analyse, beleg_analyse, warenkorb_analyse, diktat.
GET /api/ki/sync?nur_herzschlag=1 (Vertrag V1) aktualisiert nur ki_status und
beansprucht nichts — der Herzschlag-Thread nutzt ihn während langer Aufträge.
Das Lesen ist zusätzlich tolerant gegenüber Schlüssel-Varianten (jobs/items,
signed_url, context …), damit eine kleine Umbenennung im FSM nie alles blockiert.
"""

from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from . import VERSION
from .config import Einstellungen

log = logging.getLogger("ki.fsm")

_QUERY = re.compile(r"\?[^\s'\"<>]*")


def sauber(e: BaseException) -> str:
    """Fehlertext ohne Query-Strings (Signaturen) — für Logs und Rückmeldungen."""
    return _QUERY.sub("?…", f"{type(e).__name__}: {e}")[:300]


class FsmFehler(Exception):
    """Klartext-Fehler im Verkehr mit dem FSM."""


class FsmAbgelehnt(FsmFehler):
    """Das FSM weist eine Meldung dauerhaft ab (4xx) — erneutes Senden hilft nicht."""


# Vertrag V1/V4: Vercel-Funktionen brauchen beim Kaltstart plus Housekeeping mehr als 30 s.
SYNC_TIMEOUT_S = 90.0
# Der Herzschlag ist billig (nur ki_status); er darf den nächsten nicht überholen.
HERZSCHLAG_TIMEOUT_S = 15.0


@dataclass
class Auftrag:
    id: str
    art: str
    payload: dict = field(default_factory=dict)
    kontext: dict = field(default_factory=dict)
    url: str | None = None

    @staticmethod
    def aus(d: dict) -> "Auftrag":
        payload = d.get("payload")
        if not isinstance(payload, dict):
            payload = {}
        kontext = None
        for k in ("kontext", "context", "ctx"):
            if isinstance(d.get(k), dict):
                kontext = d[k]
                break
            if isinstance(payload.get(k), dict):
                kontext = payload[k]
                break
        url = None
        for quelle in (payload, d):
            for k in ("url", "signed_url", "download_url", "datei_url", "signedUrl"):
                wert = quelle.get(k)
                if isinstance(wert, str) and wert.startswith("http"):
                    url = wert
                    break
            if url:
                break
        return Auftrag(
            id=str(d.get("id")),
            art=str(d.get("art") or d.get("type") or "").strip(),
            payload=payload,
            kontext=kontext or {},
            url=url,
        )

    @property
    def dateiname(self) -> str:
        for k in ("file_name", "dateiname", "name", "filename"):
            wert = self.payload.get(k)
            if isinstance(wert, str) and wert.strip():
                return wert.strip()
        return ""

    @property
    def mime(self) -> str | None:
        for k in ("mime", "mime_type", "content_type"):
            wert = self.payload.get(k)
            if isinstance(wert, str) and wert.strip():
                return wert.strip().lower()
        return None


class FsmClient:
    def __init__(self, cfg: Einstellungen) -> None:
        kennung = f"eventline-ki/{VERSION}"
        kopf = {
            "Authorization": f"Bearer {cfg.sync_token}",
            "User-Agent": kennung,
            "Accept": "application/json",
        }
        self._sync = httpx.Client(
            base_url=cfg.fsm_url,
            proxy=cfg.proxy,
            trust_env=False,
            timeout=httpx.Timeout(SYNC_TIMEOUT_S, connect=10.0),
            headers=kopf,
        )
        # Eigener Client für den Herzschlag-Thread: läuft parallel zur Verarbeitung,
        # teilt sich so keine Verbindung mit Abholen/Melden.
        self._puls = httpx.Client(
            base_url=cfg.fsm_url,
            proxy=cfg.proxy,
            trust_env=False,
            timeout=httpx.Timeout(HERZSCHLAG_TIMEOUT_S, connect=10.0),
            headers=kopf,
        )
        # Downloads ohne den Sync-Token: die signierte URL ist die Berechtigung,
        # ein fremder Bearer würde Supabase nur verwirren.
        self._download = httpx.Client(
            proxy=cfg.proxy,
            trust_env=False,
            timeout=httpx.Timeout(120.0, connect=15.0),
            headers={"User-Agent": kennung},
            follow_redirects=True,
        )

    # --- Warteschlange ------------------------------------------------------

    def hole_auftraege(self, herzschlag: dict[str, str]) -> list[Auftrag]:
        try:
            r = self._sync.get("/api/ki/sync", params=herzschlag)
        except httpx.HTTPError as e:
            raise FsmFehler(f"FSM nicht erreichbar ({sauber(e)})") from e
        if r.status_code == 401:
            raise FsmFehler("FSM lehnt den Sync-Token ab (401)")
        if r.status_code == 503:
            raise FsmFehler("Sync im FSM nicht konfiguriert (503)")
        if r.status_code >= 400:
            raise FsmFehler(f"FSM antwortet mit HTTP {r.status_code}")
        try:
            daten = r.json()
        except ValueError as e:
            raise FsmFehler("FSM-Antwort ist kein JSON") from e
        if not isinstance(daten, dict):
            raise FsmFehler("FSM-Antwort hat eine unerwartete Form")
        if daten.get("success") is False:
            raise FsmFehler(f"FSM meldet Fehler: {str(daten.get('error') or '')[:120]}")
        liste = None
        for k in ("auftraege", "jobs", "items", "auftrage"):
            if isinstance(daten.get(k), list):
                liste = daten[k]
                break
        if liste is None:
            return []
        auftraege = []
        for eintrag in liste:
            if isinstance(eintrag, dict) and eintrag.get("id"):
                auftraege.append(Auftrag.aus(eintrag))
        return auftraege

    def herzschlag(self, werte: dict[str, str]) -> None:
        """Nur «lebt noch» melden (V1): aktualisiert ki_status, holt keine Aufträge ab."""
        try:
            r = self._puls.get("/api/ki/sync", params={**werte, "nur_herzschlag": "1"})
        except httpx.HTTPError as e:
            raise FsmFehler(f"Herzschlag nicht zugestellt ({sauber(e)})") from e
        if r.status_code >= 400:
            raise FsmFehler(f"Herzschlag: FSM antwortet mit HTTP {r.status_code}")

    def melde_ergebnisse(self, ergebnisse: list[dict]) -> None:
        try:
            r = self._sync.post("/api/ki/sync", json={"ergebnisse": ergebnisse})
        except httpx.HTTPError as e:
            raise FsmFehler(f"Ergebnis konnte nicht gemeldet werden ({sauber(e)})") from e
        if r.status_code in (401, 408, 429) or r.status_code >= 500:
            raise FsmFehler(f"FSM verweigert das Ergebnis vorerst (HTTP {r.status_code})")
        if r.status_code >= 400:
            raise FsmAbgelehnt(f"FSM weist das Ergebnis ab (HTTP {r.status_code})")

    # --- Dateien --------------------------------------------------------------

    def lade_datei(self, url: str, ziel: Path, max_bytes: int) -> tuple[int, str]:
        """Lädt die signierte URL nach `ziel`; liefert (Grösse, sha256)."""
        sha = hashlib.sha256()
        groesse = 0
        try:
            with self._download.stream("GET", url) as r:
                if r.status_code != 200:
                    raise FsmFehler(f"Download fehlgeschlagen (HTTP {r.status_code})")
                laenge = r.headers.get("content-length")
                if laenge and laenge.isdigit() and int(laenge) > max_bytes:
                    raise FsmFehler(f"Datei zu gross (über {max_bytes // (1024 * 1024)} MB)")
                with open(ziel, "wb") as f:
                    for teil in r.iter_bytes(1 << 16):
                        groesse += len(teil)
                        if groesse > max_bytes:
                            raise FsmFehler(f"Datei zu gross (über {max_bytes // (1024 * 1024)} MB)")
                        sha.update(teil)
                        f.write(teil)
        except httpx.HTTPError as e:
            raise FsmFehler(f"Download fehlgeschlagen ({sauber(e)})") from e
        if groesse == 0:
            raise FsmFehler("Download ist leer")
        return groesse, sha.hexdigest()

    def schliessen(self) -> None:
        self._sync.close()
        self._puls.close()
        self._download.close()
