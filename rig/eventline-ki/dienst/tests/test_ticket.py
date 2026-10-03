"""HMAC-Rundlauf der Direkt-API-Tickets (SPEC §2.2) — einziger Scope: archiv.

Läuft ohne Zusatzpakete:  python rig/eventline-ki/dienst/tests/test_ticket.py
(oder mit pytest). Prüft: Rundlauf, Signatur exakt wie src/lib/ki/ticket.ts,
Manipulation, fremdes Geheimnis, Ablauf, Scope (diktat gibt es nicht mehr),
Format, Millisekunden, Header.
"""

from __future__ import annotations

import base64
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.ticket import (  # noqa: E402
    GUELTIGE_SCOPES,
    TicketFehler,
    _signatur,
    erzeuge_ticket,
    pruefe_ticket,
    ticket_aus_header,
)

SECRET = "nur-fuer-den-test-0123456789abcdef"


def _erwartet_fehler(fn, teil: str) -> None:
    try:
        fn()
    except TicketFehler as e:
        assert teil in str(e), f"Fehlertext «{e}» enthält nicht «{teil}»"
        return
    raise AssertionError(f"TicketFehler mit «{teil}» erwartet")


def test_rundlauf() -> None:
    t = erzeuge_ticket(SECRET, "user-1", "archiv")
    assert t.startswith("v1.") and t.count(".") == 2
    info = pruefe_ticket(t, SECRET, "archiv")
    assert info.sub == "user-1" and info.scope == "archiv"
    assert info.exp > time.time()


def test_signatur_wie_im_fsm() -> None:
    # Nachbau von src/lib/ki/ticket.ts: HMAC über «v1.<base64url>», JSON mit Leerzeichen-freiem Stringify.
    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": "u", "scope": "archiv", "exp": int(time.time()) + 60}, separators=(",", ":")).encode()
    ).decode().rstrip("=")
    t = f"v1.{payload}.{_signatur(SECRET, 'v1.' + payload)}"
    assert pruefe_ticket(t, SECRET, "archiv").sub == "u"
    # Signatur nur über das Payload-Segment (ohne «v1.») gilt nicht.
    falsch = f"v1.{payload}.{_signatur(SECRET, payload)}"
    _erwartet_fehler(lambda: pruefe_ticket(falsch, SECRET, "archiv"), "Signatur")


def test_fremdes_geheimnis() -> None:
    t = erzeuge_ticket(SECRET, "u", "archiv")
    _erwartet_fehler(lambda: pruefe_ticket(t, SECRET + "x", "archiv"), "Signatur")


def test_manipuliert() -> None:
    t = erzeuge_ticket(SECRET, "u", "archiv")
    kopf, payload, sig = t.split(".")
    anderes = ("A" if payload[0] != "A" else "B") + payload[1:]
    _erwartet_fehler(lambda: pruefe_ticket(f"{kopf}.{anderes}.{sig}", SECRET, "archiv"), "Signatur")
    andere_sig = ("0" if sig[0] != "0" else "1") + sig[1:]
    _erwartet_fehler(lambda: pruefe_ticket(f"{kopf}.{payload}.{andere_sig}", SECRET, "archiv"), "Signatur")


def test_abgelaufen() -> None:
    t = erzeuge_ticket(SECRET, "u", "archiv", exp=int(time.time()) - 1)
    _erwartet_fehler(lambda: pruefe_ticket(t, SECRET, "archiv"), "abgelaufen")


def test_nur_scope_archiv() -> None:
    assert GUELTIGE_SCOPES == ("archiv",)
    # Vertrag V6: das Diktat läuft über die Warteschlange — ein (korrekt signiertes)
    # Diktat-Ticket öffnet nichts mehr, weder für «diktat» noch für «archiv».
    t = erzeuge_ticket(SECRET, "u", "diktat")
    _erwartet_fehler(lambda: pruefe_ticket(t, SECRET, "diktat"), "gilt nicht")
    _erwartet_fehler(lambda: pruefe_ticket(t, SECRET, "archiv"), "gilt nicht")
    t2 = erzeuge_ticket(SECRET, "u", "admin")
    _erwartet_fehler(lambda: pruefe_ticket(t2, SECRET, "admin"), "gilt nicht")


def test_format() -> None:
    for kaputt in ("", "v2.a.b", "v1.a", "v1..", "v1.a.b", "v1.a.b.c", "x" * 5000):
        _erwartet_fehler(lambda k=kaputt: pruefe_ticket(k, SECRET, "archiv"), "Ticket")


def test_millisekunden() -> None:
    t = erzeuge_ticket(SECRET, "u", "archiv", exp=int(time.time() * 1000) + 60_000)
    assert pruefe_ticket(t, SECRET, "archiv").sub == "u"


def test_ohne_geheimnis() -> None:
    t = erzeuge_ticket(SECRET, "u", "archiv")
    _erwartet_fehler(lambda: pruefe_ticket(t, "", "archiv"), "konfiguriert")


def test_header() -> None:
    assert ticket_aus_header("Bearer abc") == "abc"
    assert ticket_aus_header("bearer   abc ") == "abc"
    assert ticket_aus_header("Basic abc") == ""
    assert ticket_aus_header(None) == ""


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    fehler = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok      {name}")
        except Exception as e:  # noqa: BLE001
            fehler += 1
            print(f"FEHLER  {name}: {e}")
    print(f"{len(tests) - fehler}/{len(tests)} bestanden")
    sys.exit(1 if fehler else 0)
