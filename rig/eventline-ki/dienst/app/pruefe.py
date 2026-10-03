"""Prüfwerkzeug für den Betrieb (SPEC §5) — läuft im Dienst-Container:

    docker compose … exec dienst python -m app.pruefe egress    Erlaubnisliste des Proxys
    docker compose … exec dienst python -m app.pruefe ollama    Version, Modelle, geladen
    docker compose … exec dienst python -m app.pruefe whisper   Spracherkennung erreichbar?
    docker compose … exec dienst python -m app.pruefe gpu       Name + freier VRAM
    docker compose … exec dienst python -m app.pruefe ticket    Test-Ticket (Scope archiv) ausgeben

Gibt nie Geheimnisse aus — ein Ticket ist ein ableitbares, 10 Minuten gültiges Token.
"""

from __future__ import annotations

import argparse
import json
import sys

import httpx

from .config import EINSTELLUNGEN as cfg
from .gpu import gpu_info
from .llm import Ollama
from .ticket import GUELTIGE_SCOPES, erzeuge_ticket, pruefe_ticket
from .whisper import Whisper

SUPABASE_HOST = "uxtotpniwbwyoznwkygd.supabase.co"
# Ein anderes Supabase-Projekt: muss gesperrt sein (kein *.supabase.co in der Erlaubnisliste),
# sonst könnte ein Dokument in einen fremden Bucket wandern.
FREMDER_SUPABASE_HOST = "aaaaaaaaaaaaaaaaaaaa.supabase.co"


def egress() -> int:
    client = httpx.Client(proxy=cfg.proxy, trust_env=False, timeout=15.0)
    faelle = [
        ("https://api.anthropic.com/", False),
        ("https://api.openai.com/", False),
        ("https://example.com/", False),
        (f"https://{FREMDER_SUPABASE_HOST}/", False),
        (f"https://{SUPABASE_HOST}/", True),
        (f"{cfg.fsm_url}/api/version", True),
    ]
    schlecht = 0
    for url, soll_durch in faelle:
        try:
            r = client.get(url)
            ist_durch, befund = True, f"HTTP {r.status_code}"
        except httpx.ProxyError as e:
            # httpcore meldet die Statuszeile des Proxys, z. B. «403 Forbidden».
            ist_durch, befund = False, f"vom Proxy abgewiesen ({str(e)[:40] or 'ohne Angabe'})"
        except httpx.HTTPError as e:
            ist_durch, befund = False, type(e).__name__
        ok = ist_durch == soll_durch
        schlecht += 0 if ok else 1
        print(f"{'OK     ' if ok else 'FEHLER '} {url:55s} {befund}  (erwartet: {'durch' if soll_durch else 'gesperrt'})")
    print("Egress-Test:", "bestanden" if schlecht == 0 else f"{schlecht} Abweichung(en)")
    return 0 if schlecht == 0 else 1


def ollama() -> int:
    o = Ollama(cfg)
    version = o.version()
    print("Ollama-Version:", version or "nicht erreichbar")
    if version is None:
        return 1
    installiert = o.installierte_modelle()
    print("Installiert:", ", ".join(installiert) or "(keine)")
    # Ollama listet Modelle ohne Tag als «name:latest» — «bge-m3» und «bge-m3:latest» sind dasselbe.
    vorhanden = {n[:-7] if n.endswith(":latest") else n for n in installiert}
    for name in (cfg.modell_text, cfg.modell_bild, cfg.modell_embed):
        kurz = name[:-7] if name.endswith(":latest") else name
        print(f"  {name:28s} {'vorhanden' if kurz in vorhanden else 'FEHLT (ollama pull)'}")
    geladen = o.geladene_modelle()
    print("Geladen:", ", ".join(f"{m.get('name')} ({int(m.get('size_vram', 0)) // (1024 * 1024)} MB VRAM)" for m in geladen) or "(nichts)")
    return 0


def whisper() -> int:
    client = httpx.Client(base_url=cfg.whisper_url, trust_env=False, timeout=10.0)
    try:
        r = client.get("/health")
        print("Whisper:", f"HTTP {r.status_code}", "— Modell:", cfg.modell_whisper)
    except httpx.HTTPError as e:
        print("Whisper nicht erreichbar:", type(e).__name__)
        return 1
    print("Geladen:", ", ".join(Whisper(cfg).geladene_modelle()) or "(nichts)")
    return 0 if r.status_code == 200 else 1


def gpu() -> int:
    print(json.dumps(gpu_info(max_alter_s=0), ensure_ascii=False))
    return 0


def ticket(scope: str, sub: str, minuten: int) -> int:
    if not cfg.ticket_secret:
        print("KI_TICKET_SECRET fehlt", file=sys.stderr)
        return 1
    t = erzeuge_ticket(cfg.ticket_secret, sub, scope, minuten=minuten)
    info = pruefe_ticket(t, cfg.ticket_secret, scope)
    print(t)
    print(f"# scope={info.scope} sub={info.sub} gültig {minuten} min", file=sys.stderr)
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="app.pruefe", description="Betriebsprüfungen der lokalen KI")
    sub = p.add_subparsers(dest="befehl", required=True)
    sub.add_parser("egress")
    sub.add_parser("ollama")
    sub.add_parser("whisper")
    sub.add_parser("gpu")
    t = sub.add_parser("ticket")
    t.add_argument("--scope", choices=GUELTIGE_SCOPES, default="archiv")
    t.add_argument("--sub", default="pruefwerkzeug")
    t.add_argument("--minuten", type=int, default=10)
    a = p.parse_args(argv)
    if a.befehl == "egress":
        return egress()
    if a.befehl == "ollama":
        return ollama()
    if a.befehl == "whisper":
        return whisper()
    if a.befehl == "gpu":
        return gpu()
    return ticket(a.scope, a.sub, a.minuten)


if __name__ == "__main__":
    sys.exit(main())
