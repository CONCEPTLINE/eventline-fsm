"""Tickets für die Direkt-API (SPEC §2.2): `v1.<base64url(json)>.<hex hmac-sha256>`.

Das FSM stellt sie aus (src/lib/ki/ticket.ts, 10 Minuten), der Rig prüft
Signatur, Ablauf und Scope in konstanter Zeit. Signiert wird — wie im FSM —
der Text vor dem letzten Punkt («v1.<base64url>»), damit die Versionskennung
mit unter der Signatur liegt.

Einziger Scope ist «archiv» (Frag das Archiv, Phase 3). Das Diktat läuft über
die Warteschlange des FSM und braucht kein Ticket mehr (Vertrag V6).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time
from dataclasses import dataclass

GUELTIGE_SCOPES = ("archiv",)
MAX_LAENGE = 4096

_B64URL = re.compile(r"[A-Za-z0-9_-]+")
_HEX64 = re.compile(r"[0-9a-fA-F]{64}")


class TicketFehler(Exception):
    """Klartext für die 401-Antwort — ohne Hinweis, welcher Teil genau falsch war."""


@dataclass(frozen=True)
class Ticket:
    sub: str
    scope: str
    exp: int


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _b64url_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def _signatur(secret: str, nachricht: str) -> str:
    return hmac.new(secret.encode("utf-8"), nachricht.encode("utf-8"), hashlib.sha256).hexdigest()


def ticket_aus_header(authorization: str | None) -> str:
    if not authorization:
        return ""
    teile = authorization.strip().split(None, 1)
    if len(teile) == 2 and teile[0].lower() == "bearer":
        return teile[1].strip()
    return ""


def pruefe_ticket(token: str, secret: str, scope: str, jetzt: float | None = None) -> Ticket:
    if not secret:
        raise TicketFehler("Ticket-Prüfung ist nicht konfiguriert")
    if not token or len(token) > MAX_LAENGE:
        raise TicketFehler("Ticket fehlt oder ist ungültig")
    teile = token.split(".")
    if len(teile) != 3 or teile[0] != "v1":
        raise TicketFehler("Ticket hat ein unbekanntes Format")
    _, payload, sig = teile
    if not _B64URL.fullmatch(payload) or not _HEX64.fullmatch(sig):
        raise TicketFehler("Ticket ist beschädigt")
    if not hmac.compare_digest(sig.lower(), _signatur(secret, "v1." + payload)):
        raise TicketFehler("Ticket-Signatur ungültig")
    try:
        daten = json.loads(_b64url_decode(payload))
    except (ValueError, UnicodeDecodeError) as e:
        raise TicketFehler("Ticket-Inhalt unlesbar") from e
    if not isinstance(daten, dict):
        raise TicketFehler("Ticket-Inhalt unlesbar")
    exp = daten.get("exp")
    if not isinstance(exp, (int, float)) or isinstance(exp, bool):
        raise TicketFehler("Ticket ohne Ablauf")
    if exp > 1e12:  # Millisekunden (JavaScript Date.now()) tolerieren
        exp = exp / 1000.0
    if (jetzt if jetzt is not None else time.time()) >= exp:
        raise TicketFehler("Ticket abgelaufen")
    ticket_scope = str(daten.get("scope") or "")
    if ticket_scope not in GUELTIGE_SCOPES or ticket_scope != scope:
        raise TicketFehler(f"Ticket gilt nicht für «{scope}»")
    sub = str(daten.get("sub") or "").strip()
    if not sub:
        raise TicketFehler("Ticket ohne Benutzer")
    return Ticket(sub=sub, scope=ticket_scope, exp=int(exp))


def erzeuge_ticket(secret: str, sub: str, scope: str, exp: int | None = None, minuten: int = 10) -> str:
    """Gegenstück zur Prüfung — für Tests und das Prüfwerkzeug (app.pruefe ticket)."""
    daten = {"sub": sub, "scope": scope, "exp": exp if exp is not None else int(time.time()) + minuten * 60}
    kopf = "v1." + _b64url_encode(json.dumps(daten, separators=(",", ":")).encode("utf-8"))
    return f"{kopf}.{_signatur(secret, kopf)}"
