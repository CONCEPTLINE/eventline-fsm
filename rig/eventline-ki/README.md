# EVENTLINE Lokale KI — Betrieb auf dem Rig

Vertrag und Architektur: `docs/lokale-ki/SPEC.md`. Dieser Ordner wird per
rsync nach `/srv/eventline-ki/repo/eventline-ki/` auf den Rig gespielt.

| Teil | Zweck |
|---|---|
| `docker-compose.yml` | Stack: ollama, whisper, db (pgvector), egress (Squid-Erlaubnisliste), dienst (Python), caddy (HTTPS) |
| `dienst/` | Der Dienst: Warteschlange vom FSM (auch Diktat), Text/OCR, Modelle, Direkt-API (`/health`, `/v1/archiv/frage` ab Phase 3) |
| `egress/squid.conf` | Nur CONNECT:443 zu `uxtotpniwbwyoznwkygd.supabase.co` und `eventline-fsm-usyk.vercel.app` — sonst 403 |
| `caddy/` | Caddy mit Cloudflare-DNS-Modul, `ki.in.eventline-basel.com` |
| `systemd/` | Unit, die den Stack nach Tresor + Docker startet |
| `install.sh` | Installation/Update (idempotent, mit sudo) |
| `probelauf/` | Phase-1-Werkzeug: Trefferquote gegen das NAS |

## Installation / Update

```bash
cd /srv/eventline-ki/repo/eventline-ki
sudo bash install.sh                 # Units, Build, Modelle, Start
sudo bash install.sh --ohne-modelle  # reines Code-Update
```

Voraussetzungen prüft das Skript selbst: Tresor gemountet (`/srv/eventline-ki/data`),
`/etc/eventline-ki/env` + `caddy.env`, Benutzer `eventline-ki` (1500), CDI-Spezifikation
für die GPU. Compose braucht immer `--env-file /etc/eventline-ki/env` (Passwort der DB,
Modellnamen) — Unit und Skript tun das; von Hand so:

```bash
C="docker compose --env-file /etc/eventline-ki/env -f /srv/eventline-ki/repo/eventline-ki/docker-compose.yml"
```

## Betrieb

```bash
systemctl status eventline-ki          # Unit (oneshot, bleibt «active»)
$C ps                                  # Container + Healthchecks
$C logs -f dienst                      # Verarbeitung, Herzschlag-Fehler, Diktat
$C logs -f egress                      # jede ausgehende Verbindung (Host + Status)
$C logs -f caddy                       # Zertifikat, Zugriffe
$C up -d dienst                        # nach Änderung von /etc/eventline-ki/env («restart» liest sie NICHT neu, geprüft 2026-10-03)
curl -s https://ki.in.eventline-basel.com/health   # aus Büro-Netz oder VPN
```

Der Dienst meldet sich alle 2 s beim FSM (`/api/ki/sync`) — die Kopfzeile der
NAS-Ablage zeigt daraus «Lokale KI · online/offline». Ist der Rig weg, fällt das
FSM auf den heutigen Weg zurück (Beschrieb tippen, Claude nur für Nicht-Vertrauliches).

## Modell wechseln

1. `KI_MODELL_TEXT` (oder `KI_MODELL_BILD`, `KI_MODELL_WHISPER`) in `/etc/eventline-ki/env` setzen.
2. Modell holen — die Arbeits-Container haben kein Internet, deshalb über das Profil:
   `$C --profile modelle run --rm ollama-modelle` bzw. `… whisper-modelle`.
3. `$C up -d dienst whisper` — der Dienst liest die Namen beim Start; Whisper braucht den Neustart.
4. `$C exec dienst python -m app.pruefe ollama` zeigt Version, installierte und geladene Modelle.

Nur ein Modell ist gleichzeitig im VRAM (`OLLAMA_MAX_LOADED_MODELS=1`), nach 5 min
Leerlauf wird es entladen; vor einem Diktat wird das Sprachmodell entladen, wenn
weniger als 2 GB frei sind (`KI_WHISPER_MIN_FREI_MB`).

## Egress-Test (SPEC §5.1)

```bash
$C exec dienst python -m app.pruefe egress
```

Erwartung: `api.anthropic.com`, `api.openai.com`, `example.com` «vom Proxy abgewiesen»,
Supabase und FSM «HTTP …». Im Log des Proxys (`$C logs egress`) steht jeder Versuch.

## Ticket-Test (SPEC §5.5)

```bash
T=$($C exec -T dienst python -m app.pruefe ticket --scope diktat)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer falsch" \
     -F audio=@probe.wav https://ki.in.eventline-basel.com/v1/diktat        # 401
curl -s -H "Authorization: Bearer $T" -F audio=@probe.wav \
     https://ki.in.eventline-basel.com/v1/diktat                            # {"text": …, "dauer_ms": …}
```

`probe.wav` = deutsche Sprachprobe (jedes Format, das ffmpeg kennt: webm, m4a, mp3, wav).
`/v1/archiv/frage` antwortet bis Phase 3 mit 503 (`Archiv-Index folgt in Phase 3`),
mit falschem Ticket ebenfalls 401.

## Weitere Prüfungen

```bash
$C exec dienst python -m app.pruefe gpu       # Name + freier VRAM (wie in /health)
$C exec dienst python -m app.pruefe whisper   # Spracherkennung erreichbar
$C exec db psql -U eventline -d eventline_ki -c "select zeit, art, quelle, dauer_ms, modell, ok, fehler from ki_protokoll order by zeit desc limit 20"
```

Das Protokoll enthält nur Metadaten (Zeit, Art, Dauer, Modell, ok/Fehlertext) — nie Inhalte.

## Wenn etwas klemmt

- **`ki.in.eventline-basel.com` ist im Büro nicht auflösbar** (Browser: «Server nicht gefunden», obwohl
  `dig @1.1.1.1` die 192.168.1.128 liefert): Der Router (192.168.1.1) filtert per DNS-Rebind-Schutz
  öffentliche Namen, die auf private Adressen zeigen. Im Router eine Ausnahme für
  `ki.in.eventline-basel.com` eintragen (FRITZ!Box: Heimnetz → Netzwerk → Netzwerkeinstellungen →
  DNS-Rebind-Schutz). Der Rig selbst hat dafür einen Eintrag in `/etc/hosts`.
- **Rig-Adresse:** 192.168.1.128 kommt per DHCP (MAC `b4:2e:99:fe:47:1a`). Caddy bindet fest an diese
  Adresse und der DNS-Eintrag zeigt darauf — im Router eine feste Zuweisung (DHCP-Reservierung) setzen,
  sonst bricht der Stack nach einem Adresswechsel.
- **Container starten nicht (GPU):** `ls /etc/cdi/nvidia.yaml`; fehlt sie: `sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml`.
- **whisper startet in Schleife «Could not connect, are you offline?»:** das Image startet mit `uv run`, das
  ohne Internet nicht syncen kann — die Compose-Datei setzt deshalb `uv run --no-sync`.
- **ollama meldet «llama-server process has terminated: signal: killed»:** Speicherdeckel des Containers
  zu klein für den Modellwechsel (Seitencache zählt mit). Prüfen: `cat /sys/fs/cgroup/system.slice/docker-$(docker inspect eventline-ki-ollama --format '{{.Id}}').scope/memory.events`
  (`oom_kill` > 0) und `mem_limit` von `ollama` in `docker-compose.yml` erhöhen.
- **Caddy startet nicht (Port):** 443 muss auf 192.168.1.128, 10.9.0.2 (WireGuard aktiv?) und 127.0.0.1 frei sein.
- **Kein Zertifikat:** `$C logs caddy` — DNS-Eintrag `ki.in.eventline-basel.com` → 192.168.1.128 und Cloudflare-Token (Zone-DNS-Edit) prüfen.
- **Unit startet nicht:** `AssertPathIsMountPoint` — der Tresor war nicht gemountet; `systemctl start eventline-ki-vault` und erneut.
- **Diktat hängt («Spracherkennung hat zu lange gebraucht»), obwohl whisper «healthy» ist:** `DELETE /api/ps/<modell>`
  (Entladen per API) verklemmt diese Server-Version dauerhaft (Deadlock im Modell-Manager, 2026-10-03 gemessen) — der
  Dienst ruft es deshalb nie auf. Wer es von Hand getan hat: `$C restart whisper`. Den VRAM gibt Whisper nach
  `WHISPER__TTL` (5 min) selbst frei.
- **Dienst meldet «FSM lehnt den Sync-Token ab»:** `KI_SYNC_TOKEN` in `/etc/eventline-ki/env` und auf Vercel müssen gleich sein.
- Trust-one-Dienste (Schwarm, Atlas/Hermes, Bots) werden von diesem Stack nie berührt; `systemctl is-active trust-one-swarm` vor und nach jeder Aktion prüfen.
