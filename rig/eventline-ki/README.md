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
| `probelauf/` | Trefferquote der Ordnerwahl gegen das sortierte NAS (live-nah, nur Kennzahlen) |

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

Höchstens zwei Modelle sind gleichzeitig im VRAM (`OLLAMA_MAX_LOADED_MODELS=2`: das Sprachmodell
und das Einbettungsmodell `bge-m3` für die Ordnerwahl), nach 5 min Leerlauf werden sie entladen; vor
einem Diktat wird das Sprachmodell entladen, wenn weniger als 2 GB frei sind (`KI_WHISPER_MIN_FREI_MB`),
vor einer Einbettung ebenso (`KI_EMBED_MIN_FREI_MB`, s. «VRAM und Modellwechsel»).

## Ordnerwahl (Ablage-KI) — nach Vorbild

Wie `ablage_analyse` den Zielordner bestimmt (`dienst/app/handlers/ablage.py`, `ordnerwahl.py`,
`archiv.py`; produktiv seit 2026-10-11, Erstdeploy Build `20261011-1048`). Ersetzt die zweistufige Wahl aus der
ganzen Ordnerliste vom 2026-10-03 (die traf live-nah nur 15 % in 02_LOCATIONS und 43 % in 03_PROJEKTE):

1. **Einbettung** (`bge-m3`) aus «lesbarer Dateiname + erste 2000 Zeichen Text» — läuft **vor** dem
   Sprachmodell; beide bleiben geladen (`OLLAMA_MAX_LOADED_MODELS=2`), bei knappem VRAM s. unten.
2. **Vorbilder:** die 15 ähnlichsten bereits einsortierten Dateien aus dem Archiv-Index (pgvector im
   db-Container), nur aus Ordnern der FSM-Liste — inaktive Ordner zählen nie.
3. **Stufe 1** (Sprachmodell): alle Felder ausser dem Ordner. Prompt ohne Ordnerliste, statischer Anfang
   (Regeln, Dokumenttypen, Mitarbeitende) → KV-Cache-Treffer bei Ollama, Prompt-Rechenzeit 0,2–0,3 s.
4. **Rangliste** (deterministisch, `ordnerwahl.py`): **Regeln zuerst** — INT-Nummer im Dateinamen
   («INT-26-014», «26-014») → der Projektordner mit dieser Nummer (eindeutig = entschieden, kein zweiter
   Modellaufruf; doppelte Nummer = beide vorne); erkannte Person bei personenbezogenem Typ → nur die
   Personalakte dieser Person (`NNNN_Vorname_Nachname` in einer PERSONAL-Freigabe; Akte ohne Unterordner =
   entschieden). Danach Stimmen der Nachbarn je Ordner (exp((s − s_max)/0,05)), Übertrag auf gleichnamige
   Unterordner anderer Entitäten (Hauskonvention: `02_Plaene_Grundrisse` der Location A zählt für
   `01_Plaene_Grundrisse` der Location B), Summe je Kategorie, Ordnernamen (seltene Pfad-Wörter im Dokument,
   Einbettung Dokument ↔ Pfad) und ein Zuschlag für Unterordner, die zur Dokumentart passen (Vertr…,
   Offert…). Kandidat ist jeder Ordner unterhalb einer Freigabe ohne Unterordner oder mit eigenen Dateien.
5. **Stufe 2** (Sprachmodell): wählt unter den besten **5 Kandidaten** (volle Pfade + bis 3 Dateinamen der
   Vorbilder dort, Schema-Enum) oder «» (keiner passt → `ordner null`, ggf. `neuer_ordner`). Derselbe Prompt
   plus Anhang → Ollama rechnet nur den Anhang neu. Scheitert das Modell (Ollama 500 «token repeat limit»):
   zweiter Versuch mit wenig Zufall (temperature 0,3, fester Seed), danach der beste Kandidat der Rangliste.
6. **`ordner_alternativen`:** die zwei nächstbesten gültigen Pfade der Rangliste (ohne den Hauptordner) —
   das FSM zeigt sie als Chips.

Bild ohne lesbaren Text (Foto, OCR unter 8 Zeichen): `typ sonstiges` fest, Stufe 2 darf nur bei klarem
Dateinamen/Vorbild wählen. Alle Antworten werden strikt gegen die FSM-Liste geprüft (sonst `null`).
Ohne Datenbank oder ohne Einbettungsmodell arbeitet die Wahl mit Regeln + Ordnernamen weiter.

### Archiv-Index (Betrieb)

- Tabellen `archiv_dateien` (Pfad, Ordner, Name, Grösse, mtime, sha256, Rezept, Einbettung) und
  `archiv_ordner` (Einbettung je Ordnerpfad) im db-Container, also im LUKS-Tresor — **kein Text wird
  gespeichert**. Anlage idempotent beim ersten Zugriff (`CREATE … IF NOT EXISTS`, Erweiterung `vector`).
- Lauf **beim Start** (`KI_INDEX_START_S`, Standard 120 s, sobald 20 s kein Auftrag lief) und **jede Nacht**
  ab `KI_INDEX_NACHT` (Standard 02:30 Europe/Zurich, Fenster 4 h; ein Neustart am Tag holt nichts nach).
  Inkrementell: gleiche Grösse + mtime → nichts; gleicher sha256 an neuem Ort → Einbettung übernommen;
  sonst Text (OCR höchstens `KI_INDEX_OCR_SEITEN`=3 Seiten) + Einbettung. Verschwundene Dateien und
  Ordner fallen weg. Ist das NAS nicht eingehängt, wartet der Lauf und versucht es später wieder.
- **Nie Vorbild:** `ZZ_*` (Freigabe und erste Ebene), `99_System`, versteckte Einträge (`.`, `@`, `#`,
  `~$`), Dateien in der Freigabe-Wurzel; was im FSM nicht als aktiver Ordner steht, zählt bei der Wahl nicht.
- **Aufträge haben Vorrang:** der Lauf wartet vor jeder Datei und vor jeder Einbettung, bis der Worker ruht
  (kein Auftrag läuft oder wartet, letzter ≥ 20 s her), und rechnet mit niedriger CPU-Priorität (nice 15,
  auch die OCR-Prozesse). Diktat, Beleg und Ablage werden nicht blockiert.
- **Status:** `GET /health` → `archiv: { aktiv, anzahl, letzter_lauf, laeuft, letzte_bilanz }`; je Lauf eine
  Log-Zeile `Archiv-Index: N Dateien geprüft — neu … übernommen … unverändert … entfernt …` (nur Zähler).
  Zählen von Hand: `$C exec db psql -U eventline -d eventline_ki -c "select count(*), max(indexiert) from archiv_dateien"`.
- Probelauf (Trefferquote, nur Kennzahlen): `probelauf/README.md`.

### VRAM und Modellwechsel (gemessen 2026-10-11, Schwarm 914 MiB dauerhaft, Whisper-Leerlauf 164 MiB)

| Situation | Ergebnis |
|---|---|
| `gemma3:4b` ctx 8192 allein | 100 % GPU (2665 MiB), 2994 MiB frei |
| `gemma3:4b` + `bge-m3` | beide geladen, 2179 MiB frei; warm 0,05 s, kein Neuladen je Ablage |
| `gemma3:4b` ctx 8192 ↔ 16384 | Neuladen 3,3–5,0 s → deshalb `KI_BILD_NUM_CTX=8192` (Beleg und Ablage teilen ein Fenster; gleiches Fenster = 2 ms) |
| Whisper geladen (+1970 MiB) + `gemma3:4b` | 100 % GPU, 1024 MiB frei; `bge-m3` dazu nur 6 % in der GPU, Laden 24 s → der Dienst entlädt das Sprachmodell vor der Einbettung (`KI_EMBED_MIN_FREI_MB`, Standard 2000), es lädt für Stufe 1 neu (3–7 s) |
| `qwen3:8b` ctx 8192 allein | 100 % GPU (5360 MiB), 1182 MiB frei |
| `qwen3:8b` + `bge-m3` | passt nicht: Ollama wirft `qwen3:8b` hinaus → je Ablage zwei Neuladungen (`bge-m3` 2,7–6,4 s, `qwen3:8b` 3,0–4,5 s), KV-Cache weg |
| Wechsel `qwen3:8b` → `gemma3:4b` (Beleg) | 6,1–10,4 s (Vorgabe < 6 s) |
| Whisper geladen + `qwen3:8b` | nur 61 % in der GPU (3522/5735 MiB), Laden 12,7 s |

**Entscheid 2026-10-11:** `gemma3:4b` bleibt für Text, Bild und den Kandidaten-Entscheid. `qwen3:8b`
brächte laut Labor des Vorgängers nur +1 bis +3 Punkte Top-1 (60–62 % statt 59 %) und scheitert an
allen drei Bedingungen (VRAM mit `bge-m3`, Whisper, Modellwechsel).

### Messwerte Ordnerwahl

Live-nah = Ordnerliste aller 424 Pfade (wie das FSM sie schickt), Leave-one-out (die Testdatei und gleiche
sha256 sind kein Vorbild), 126 Dateien aus 02/03/04/05/08 (Seed 42, je Ordner 5, max 80), Index 167
Vorbilder, `gemma3:4b`. Labor 2026-10-04: Top-1 59 %, Top-3 80 %, Ziel unter den 5 Kandidaten 86 %,
Rangliste ohne KI 56 %. 8 Kandidaten: Ziel unter den Kandidaten 92 %, Top-1 aber 56 %. Prompt-Varianten
(Treffer-Wörter je Kandidat, Regeln «Entität zuerst», ohne Dateinamen) 55–59 %. Die Decke liegt bei den
Kandidaten (86 %) und bei ähnlichen Projekten innerhalb von 03_PROJEKTE_EVENTS (je Projektordner liegt
oft nur eine Datei) — mehr Vorbilder helfen am meisten.

**Finale Messung mit dem Produktionspfad (2026-10-11, Build `20261011-1048`, `probelauf.py` im laufenden
Dienst-Container, je 126 Dateien, Index 167 Vorbilder, Leave-one-out, Reports
`/srv/eventline-ki/data/dienst/probelauf/prod-20261011-seed42|seed7`):**

| Freigabe | Dateien | Top-1 S42 / S7 | Top-3 S42 / S7 | Kategorie | leer | Fehler | Rangliste ohne KI 1/3/5 | Entscheid Regel / KI |
|---|---:|---|---|---|---|---:|---|---|
| 02_LOCATIONS | 41 | 71 % / 71 % | 85 % / 88 % | 98 % | 0 % | 0 | 56 %/85 %/93 % | 0 / 41 |
| 03_PROJEKTE_EVENTS | 73 | 51 % / 49 % | 75 % / 75 % | 96 % | 0 % | 0 | 52 %/75 %/81 % | 10 / 63 |
| 05_VERKAUF_MARKETING | 6 | 100 % / 100 % | 100 % / 100 % | 100 % | 0 % | 0 | 100 %/100 %/100 % | 0 / 6 |
| 08_SICHERHEIT_ASA | 5 | 60 % / 60 % | 80 % / 80 % | 80 % | 0 % | 0 | 60 %/80 %/80 % | 0 / 5 |
| 04_PARTNER | 1 | 0 % / 0 % | 100 % / 100 % | 100 % | 0 % | 0 | 0 %/100 %/100 % | 0 / 1 |
| **gesamt** | 126 | **60 % / 59 %** | **80 % / 81 %** | 96 % | 0 % | 0 | 56 %/80 %/86 % | 10 / 116 |

Dauer je Datei: Median 5,1 s (S42) / 4,8 s (S7), Max 67–68 s (eine OCR-lastige Datei in 08). Modell:
242 Aufrufe je Lauf (2 je Datei, Regel-Treffer brauchen nur einen), `num_ctx` durchgehend 8192, Modell
**neu geladen 1× (Erstladen) / 0×**, Wiederholungsschleife («token repeat limit») 2× / 0× — jeweils vom
zweiten Versuch aufgelöst, 0 Fehler. Das Modell bestätigte den Rang 1 der Rangliste in 101/99 von 116
Fällen, verbesserte 7/8 und verschlechterte 2/3. Seed 7 trifft fast dieselbe Dateiauswahl wie Seed 42
(kaum ein Ordner hat mehr als 5 Dateien) — die Abweichung zeigt also vor allem die Streuung des Modells.

**Ziel 70 % / 85 % ist gesamt nicht erreicht** (60/80 bzw. 59/81); 02_LOCATIONS erreicht es (71 / 85–88),
05 liegt bei 100, 03_PROJEKTE_EVENTS zieht den Schnitt (49–51 / 75). Was fehlt — ehrlich:
- **Vorbilder in 03:** die meisten Projektordner enthalten genau eine Datei; im Leave-one-out hat der
  Zielordner dann kein einziges Vorbild, nur sein Name trägt (Rangliste ohne KI 52 %). Im Live-Betrieb ist
  das der Bestfall anders: eine zweite Datei zum selben Projekt findet die erste als Nachbarn — und jedes
  einsortierte Dokument wird mit dem Nachtlauf selbst zum Vorbild (Lernschleife ohne Zusatzaufwand).
- **INT-Nummer im Dateinamen:** 10 von 73 Projektdateien tragen sie und werden per Regel entschieden
  (keine Fehler). Steht die Nummer konsequent im Dateinamen (Hauskonvention), fällt 03 fast weg.
- **Decke der Kandidaten:** das Ziel steht in 86 % unter den 5 Kandidaten (92 % bei 8, dann wählt das
  kleine Modell aber schlechter). Ein stärkeres Modell (`qwen3:8b`, +1–3 Punkte im Labor) scheitert am VRAM.
- 04_PARTNER (1 Datei) und 08 (5 Dateien) sind zu klein für eine Aussage.

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
