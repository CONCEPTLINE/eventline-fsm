# EVENTLINE Lokale KI — Betrieb auf dem Rig

Vertrag und Architektur: `docs/lokale-ki/SPEC.md`. Dieser Ordner wird per
rsync nach `/srv/eventline-ki/repo/eventline-ki/` auf den Rig gespielt.

| Teil | Zweck |
|---|---|
| `docker-compose.yml` | Stack: ollama (schnell, GPU), ollama-gruendlich (Hauptmodell, nur CPU), whisper, db (pgvector), egress (Squid-Erlaubnisliste), dienst (Python), caddy (HTTPS) — alle im Slice `system-eventlineki.slice` |
| `dienst/` | Der Dienst: Warteschlange vom FSM (auch Diktat, Inhaltssuche, Frag das Archiv), Text/OCR, Modelle, Vorbilder- und Tiefen-Index, Direkt-API (`/health`; `/v1/archiv/frage` antwortet 503, der Direktweg ist «später») |
| `egress/squid.conf` | Nur CONNECT:443 zu `uxtotpniwbwyoznwkygd.supabase.co` und `eventline-fsm-usyk.vercel.app` — sonst 403 |
| `caddy/` | Caddy mit Cloudflare-DNS-Modul, `ki.in.eventline-basel.com` |
| `systemd/` | Unit, die den Stack nach Tresor + Docker startet; Slice (22 GB); Timer für das Speicherprofil |
| `messung/` | Speicherprofil jede Minute (`speicherprofil.sh`) und Auswertung (`auswerten.py`), nur Zahlen |
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

1. `KI_MODELL_TEXT` (oder `KI_MODELL_BILD`, `KI_MODELL_WHISPER`) in `/etc/eventline-ki/env` setzen; für das
   Hauptmodell die Leiter `KI_HG_MODELLE` (s. «Zwei Instanzen»).
2. Modell holen — die Arbeits-Container haben kein Internet, deshalb über das Profil:
   `$C --profile modelle run --rm -T ollama-modelle` bzw. `… whisper-modelle`. Das Profil lädt die
   Namen aus `KI_MODELL_TEXT/BILD/EMBED` **und** `KI_HG_MODELLE` (ohne `@Bedarf`), aber **nur fehlende**:
   ein vorhandenes Modell wird nie still aktualisiert. Grund: am 2026-10-11 war `gemma3:4b` im Katalog
   neu gepackt (2,5 GB + 0,85 GB statt 3,3 GB) — ein gewöhnlicher Pull hätte das Live-Modell getauscht.
   Bewusst aktualisieren (danach Probelauf, SPEC §5): `$C --profile modelle run --rm -T -e KI_MODELLE_NEU_LADEN=1 ollama-modelle`.
3. `$C up -d dienst whisper` — der Dienst liest die Namen beim Start; Whisper braucht den Neustart.
4. `$C exec dienst python -m app.pruefe ollama` zeigt Version, installierte und geladene Modelle.
   Fähigkeiten (z. B. «vision») eines Modells: `docker exec eventline-ki-ollama-gruendlich ollama show <modell>`.

Höchstens zwei Modelle sind gleichzeitig im VRAM (`OLLAMA_MAX_LOADED_MODELS=2`: das Sprachmodell
und das Einbettungsmodell `bge-m3` für die Ordnerwahl), nach 5 min Leerlauf werden sie entladen; vor
einem Diktat wird das Sprachmodell entladen, wenn weniger als 2 GB frei sind (`KI_WHISPER_MIN_FREI_MB`),
vor einer Einbettung ebenso (`KI_EMBED_MIN_FREI_MB`, s. «VRAM und Modellwechsel»).

## Zwei Instanzen (schnell / gründlich)

Masterplan `docs/lokale-ki/MASTERPLAN.md` §2.2. Seit 2026-10-11 (E2.1/E2.2) laufen zwei Ollama-Container:

| | `ollama` (schnell) | `ollama-gruendlich` (Hauptmodell) |
|---|---|---|
| Aufgabe | alle FSM-Aufträge (Ablage, Beleg, Diktat, Inhaltssuche, Frag das Archiv) | nur Jobs, die das Rig selbst plant (Planer ab E2.3), nie ein FSM-Auftrag |
| Gerät | GPU (CDI) | nur Prozessor (Stufe A), kein GPU-Gerät |
| Modelle | `gemma3:4b`, `bge-m3` | `gemma4:26b-a4b-it-qat`, Rückfall `gemma4:12b-it-qat` |
| Modellspeicher | `data/ollama` (schreibbar) | dasselbe `models/` **nur lesbar**, eigener Schlüssel in `data/ollama-gruendlich` |
| `cpu_shares` → `cpu.weight` | 2048 → 174 | 1536 → 138 |
| `mem_limit` / Swap | 12g / 12g | 19g / keiner (s. Kommentar in `docker-compose.yml`) |
| `oom_score_adj` | −500 | −300 |
| Adresse im Netz `ki-intern` | `http://ollama:11434` | `http://ollama-gruendlich:11434` (in `NO_PROXY` des Dienstes) |

Beide auf `ollama/ollama:0.35.1` (Gemma 4 braucht laut `ollama show` mindestens 0.30.5). `OLLAMA_NOPRUNE=1` auf
beiden und im Profil: unbenutzte Blobs werden nie gelöscht. Aufrufe an `gruendlich` immer mit
`options: { use_mmap: false, num_gpu: 0, num_ctx: 16384, num_thread: … }` (gleiches `num_ctx`, sonst lädt es neu).

**Schalter** (in `/etc/eventline-ki/env`, wirken erst mit `$C up -d dienst`): `KI_HG_AKTIV=0` (Planer,
Wächter, Hintergrund-Thread, s. «Hauptmodell: Planer, Speicher-Tor, Wächter»; aus = niemand ruft `gruendlich`
auf, der Container läuft leer mit ~0,1 GB), `KI_HG_MODELLE=gemma4:26b-a4b-it-qat@17,gemma4:12b-it-qat@10`
(Leiter, Name@Bedarf in GB).

**Messung 2026-10-11** (Stufe A, `num_thread` 10, `num_ctx` 16384, KV q8_0, `temperature` 0, Trust one
lief normal, Last ~8; je ein Lauf, nur Zahlen):

| | `gemma4:26b-a4b-it-qat` | `gemma4:12b-it-qat` |
|---|---|---|
| Fähigkeiten (`ollama show`) | completion, **vision**, tools, thinking | completion, **vision**, audio, tools, thinking |
| Laden kalt (SATA-SSD, `use_mmap false`) | 45,5 s | 21,5 s |
| `memory.stat anon` geladen | 15,7 GB | 8,3 GB |
| `anon` mit 8089-Token-Prompt | 16,3 GB | 8,9 GB |
| → Bedarf in `KI_HG_MODELLE` (hochgerechnet auf 16k gefüllt) | **17** | **10** |
| Antwort-Tokens/s (kurz / 8k-Prompt) | 8,7 / 6,9 | 3,2 / 2,6 |
| Prompt-Tokens/s (8k-Prompt) | 35,5 → 8k Prompt ≈ 3,8 min | 15,7 → ≈ 8,6 min |
| `think` + `format` (JSON-Schema) zusammen | geht: Denk-Text getrennt, Inhalt schema-gültig | geht |

- Der Seitencache beim Laden füllt den Container bis an `mem_limit` (19,0 GB) und wird dann zurückgegeben —
  kein OOM; der Slice erreichte dabei 21,9 GB (Grenze 22 GB). Swap von Trust one blieb 0, `MemAvailable` ≥ 18,7 GB.
- Der 12B-Rückfall ist auf dem Prozessor **2,7× langsamer** als das 26B (MoE, ~4B aktiv) — er spart nur Speicher.
- `think` ohne `format` liefert kein reines JSON (Codeblock) → immer mit `format` aufrufen. Den Denk-Text nie
  speichern oder loggen (Masterplan §2.3), nur seine Länge.
- Beobachtung für E2.4: beide Modelle ordneten den kurzen Mietvertrag-Probetext als `sonstiges` statt `vertrag`
  ein (Zahlen 3/36 richtig) — Qualität erst im Probelauf beurteilen, nicht aus einem Mini-Prompt.
- Während das 12B kalt lud, brauchte die erste `bge-m3`-Einbettung auf `schnell` 19,7 s (bge-m3 selbst kalt +
  Lesekonkurrenz auf der SSD); warm danach ≤ 1,3 s. Für E2.4: I/O beim Laden des Hauptmodells messen.

**Kontrollierte OOM-Tests (2026-10-11, bestanden):**
1. Container-Grenze: `docker update --memory 6g --memory-swap 6g eventline-ki-ollama-gruendlich`, 12B laden →
   nur `llama-server` in `gruendlich` vom Kernel beendet (`oom_kill 1`), `ollama serve` lief weiter (gleiche
   PID, kein Neustart), alle anderen Container `oom_kill 0`, `/health` ok. Grenze danach zurückgesetzt.
2. Slice-Grenze: `systemctl set-property --runtime system-eventlineki.slice MemoryMax=<anon + 5 GB>`, 12B laden →
   `oom_memcg=/system.slice/system-eventlineki.slice`, Opfer `llama-server` von `gruendlich`; `ollama`,
   `whisper`, `dienst`, `db`, `egress`, `caddy` `oom_kill 0`; parallel 5/5 Einbettungen auf `schnell` ok
   (≤ 1,3 s). Laufzeit-Drop-in danach entfernt (`/run/systemd/system.control/…`), Slice wieder 22 GB.

## Speicher-Rahmen (Slice) und Speicherprofil

- **Slice** `system-eventlineki.slice` (`systemd/`, installiert von `install.sh`): `MemoryMax=22G`,
  `CPUWeight=800`, Geschwister von `system-trustone.slice` (Trust one: `MemoryMax=20G`, `MemoryHigh=18G`,
  `CPUWeight=50`). Alle Compose-Dienste haben `cgroup_parent` darauf; `install.sh` warnt, wenn ein Container
  nicht darin läuft. Prüfen: `systemctl status system-eventlineki.slice` (zeigt Speicher und Container).
  Name ohne Bindestrich, weil `-` bei systemd die Hierarchie ist (Masterplan nennt `eventline-ki.slice`;
  der läge als `eventline.slice/eventline-ki.slice` ausserhalb von `system.slice`).
- **Docker:** systemd-Cgroup-Treiber, cgroup v2, Docker 29.8, runc 1.5.1. `/proc/meminfo` im Container ist der
  Host-Wert (kein lxcfs, geprüft) — `MemAvailable` und `/proc/pressure/memory` sind im Dienst direkt lesbar.
  Den Slice sieht der Dienst wegen des eigenen Cgroup-Namespaces nur über den nur lesbaren Bind-Mount
  `/sys/fs/cgroup/system.slice/system-eventlineki.slice` → `/ki-slice` (`docker-compose.yml`, seit E2.3).
- **`oom_score_adj`:** −500 für ollama, whisper, dienst, db, egress, caddy; −300 für `gruendlich`. Bei
  Speichernot des ganzen Rigs trifft der Kernel zuerst Trust one; im vollen Slice zuerst das Hauptmodell.
- **Speicherprofil** (Masterplan E2.0): `eventline-ki-speicherprofil.timer` ruft jede Minute
  `messung/speicherprofil.sh` auf → `/srv/eventline-ki/data/messung/speicherprofil-<Tag>.csv` (Tresor, root
  0700, 30 Tage). Spalten: `MemAvailable`, Swap, PSI, `pgmajfault`, Slice und jeder KI-Container
  (`memory.current`), `trust-one-swarm` und `system-trustone.slice` (nur gelesen). Auswertung:
  `sudo python3 messung/auswerten.py [--stunden 24] [--bedarf 17]` — zeigt u. a., ob Trust one über 20 GB lag
  und wie oft das Speicher-Tor offen gewesen wäre (je Stunde, Nacht 19–07). Achtung: `memory.current` des
  Slices enthält Seitencache und steht nach jedem Lesen eines Modells bis an die 22 GB (gemessen 2026-10-11:
  Median 20,8 GB, `memory.events max` > 200 000, ohne OOM) — mit `memory.current` wäre das Tor fast nie offen.
  Darum zeichnet das Profil auch `ki_slice_anon`/`ki_slice_file` auf, und die Auswertung rechnet das Tor mit
  `anon`. Der Planer (E2.3) rechnet nach Vertrag (Masterplan §2.4) mit `memory.current − inactive_file`
  (s. «Hauptmodell: Planer, Speicher-Tor, Wächter»).
  Abschalten: `sudo systemctl disable --now eventline-ki-speicherprofil.timer`.

## Hauptmodell: Planer, Speicher-Tor, Wächter (E2.3)

Masterplan §2.3–§2.6. Code: `dienst/app/{planer,speicher,hintergrund}.py`, Job-Arten und Job-Liste
`dienst/app/jobs/__init__.py`, Aufrufe an `gruendlich` über `llm.Ollama(base_url=…, schleuse=False)`.
Läuft nur mit `KI_HG_AKTIV=1`; ohne Arbeit in der Job-Liste lädt es nie ein Modell.

- **Planer:** Nacht 19:00–07:00 (`KI_NACHT_START`/`KI_TAG_START`, Europe/Zurich), `num_thread`
  `KI_HG_THREADS_NACHT` (10); um 06:45 wird entladen. Tagsüber nur mit `KI_HG_TAG=1` (`KI_HG_THREADS_TAG`, 6).
  Moduswechsel/Fensterende: laufenden Schritt fertig, dann `keep_alive 0`. Das Hauptmodell lädt nur, wenn kein
  FSM-Auftrag läuft oder wartet (20 s Ruhe) und der Archiv-Index nicht gerade läuft. Umgekehrt liest der
  Tiefen-Index nicht, solange das Hauptmodell geladen ist oder lädt (Wartegrund `hauptmodell`).
- **Leiter + Tor:** erstes installiertes, nicht gesperrtes Modell aus `KI_HG_MODELLE`, dessen Tor **2 min am
  Stück** offen ist. Tor offen = `memory.current − inactive_file` des Slices + Bedarf + **`KI_HG_PUFFER_GB` (3)** ≤
  Budget (`memory.max` des Slices, 22 GB) **und** `MemAvailable` ≥ Bedarf/2 (KI hat Vorrang: Trust one wird dafür
  verdrängt). Der Puffer ist der Platz für Ablage, Beleg und Diktat neben dem geladenen Hauptmodell. Folge: das 26B
  (17) lädt nur, wenn höchstens 2 GB nicht rückgewinnbar belegt sind (gemessen 11.10. 22:37: 1,4 GB; Leerlauf mit
  geladenem `gemma3:4b`/Whisper bis 2,4 GB) — sonst wartet es, nach 30 min gilt das 12B (10 + 3). In den
  ersten 30 min wird nur auf das oberste Modell gewartet, danach gilt für den Rest der Nacht der 12B-Rückfall.
  Höchstens `KI_HG_MAX_LADUNGEN` (3) Ladevorgänge je Fenster. Ein geladenes Modell bleibt (Hysterese).
- **Wächter** (alle 2 s, nur solange das Hauptmodell geladen ist oder lädt): ganzer Rig `MemAvailable <
  KI_HG_NOT_GB` (1), PSI `full avg10 > 30` oder `pgmajfault` 10 s über 3000/s; **KI-Slice** (seit Review E2,
  Build 20261011-2249): weniger als `KI_HG_NOT_GB` frei im Slice (`ki_knapp`, Budget − nicht rückgewinnbar) oder
  Swap des Slices seit Beginn der Überwachung um mehr als 256 MB gewachsen (`ki_swap`) → Stream trennen, entladen,
  Schritt `pausiert`, Protokoll `hg_<job>` mit `speicher`; frühestens nach `KI_HG_PAUSE_S` (600) und 5 min offenem
  Tor weiter. Grund für die Slice-Signale: `gruendlich` darf nicht auslagern (`memory.swap.max` 4096), `ollama`,
  `whisper`, `dienst`, `db` dürfen es (`swap.max` = `mem_limit`). Läuft der Slice voll, lagert der Kernel darum
  Ablage, Diktat und DB aus, während der Rig als Ganzes ruhig aussieht (`MemAvailable` > 20 GB, PSI ≈ 0).
  `memory.events max` taugt nicht als Signal (der Seitencache füllt den Slice ohnehin, > 230 000 Ereignisse ohne Not).
  **Offen:** Masterplan §2.5 nennt die Auslöser abschliessend — die zwei Slice-Signale müssen dort nachgetragen
  werden (Eltern-Session), bevor `KI_HG_AKTIV` oder `KI_HG_TAG` eingeschaltet wird.
- **`/api/ps` antwortet nicht** (Fehler/Zeitüberschreitung, gerade bei Speichernot): Stand «unbekannt» — kein OOM,
  keine Sperre, das Modell gilt als geladen (Wächter bleibt aktiv, Wartegrund `ps_unbekannt`, es wird nicht
  gerechnet). Entladen schickt `keep_alive 0` trotzdem: ohne Prompt lädt das ein nicht geladenes Modell nie (geprüft
  auf 0.35.1 am 11.10. 22:40 mit `gemma4:12b`: Antwort `done_reason unload` nach 0,0 s, `/api/ps` leer, Speicher von
  `gruendlich` unverändert). Nimmt `gruendlich` auch das nicht an, bleibt es als `entladen_offen` in `/health` und
  wird jede Runde wiederholt; vorher lädt nichts Neues.
- **Ausgerollt 11.10. 22:49 (Build `20261011-2249`, Review E2):** alle Tests grün (alt + neu, 189 im Image, dazu
  `test_tiefe_db` 4/4 gegen eine Wegwerf-DB), `/health` ok, Warteschlange 0; Spalte `archiv_text.versuche` im Tresor
  angelegt (449 Zeilen, 0 mit Fehler); Start-Log `puffer_gb 3.0`, `KI_INDEX_NACHT` 19:05, `lernen False`; `/health`
  `speicher.ki_swap_gb` 0,2. Nur `dienst` neu erstellt. Hauptmodell-Code live nicht geprüft (`KI_HG_AKTIV=0`).
- **OOM** (Modell nach einem Fehler sicher nicht mehr in `/api/ps`, oder `gruendlich` neu gestartet): Modell 24 h
  gesperrt (`data/dienst/hg-sperren.json`), Protokoll `hg_oom`, nächste Stufe der Leiter.
- **Neustart des Dienstes** (Deploy, Absturz): Ladungen, Rückfall, Beginn der Hauptmodell-Phase und eine laufende
  Wächter-Pause des Fensters stehen in `data/dienst/hg-planer.json` (nur Zahlen) und gelten weiter — ein Neustart
  in der Nacht erlaubt keine drei weiteren Ladungen.
- **Schritt:** höchstens `KI_HG_SCHRITT_MAX_S` (600 s), sonst `fehler` und weiter. Optionen immer
  `use_mmap false, num_gpu 0, num_ctx KI_HG_NUM_CTX, num_thread` aus dem Planer, `keep_alive 15m`. Der
  Denk-Text wird nie gespeichert, nur gezählt. `gpu.SCHLEUSE` nimmt das Hauptmodell nie.
- **Job-Liste** `hg_auftraege` in der Rig-DB (Tresor), `UNIQUE(art, schluessel, rezept)`. Arten heute: nur
  `probe` (Rechenaufgabe ohne Dokument). Zweiter Blick, Fristen, Rückstau ZZ folgen in E4 mit `KI_JOB_*`.
- **`/health`:** `hintergrund` (Modus, geladenes Modell, Wartegrund, Ladungen, Sperren, Zähler der Job-Liste)
  und `speicher` (GB-Werte des Slices, `MemAvailable`, Swap, PSI) — nur Zahlen und Modellnamen.

Abnahme / Probe (Nacht, oder tagsüber mit `KI_HG_TAG=1`):

```bash
sudo sed -i 's/^KI_HG_AKTIV=0$/KI_HG_AKTIV=1/' /etc/eventline-ki/env && sudo $C up -d dienst
docker exec eventline-ki-dienst python -m app.hintergrund probe     # Schritt anlegen; «status» zeigt die Zähler
# … /health → hintergrund.schritte.fertig, Protokoll: hg_laden, hg_probe
sudo sed -i 's/^KI_HG_AKTIV=1$/KI_HG_AKTIV=0/' /etc/eventline-ki/env && sudo $C up -d dienst   # entlädt beim Beenden
```

**Live-Probe 2026-10-11 21:42 (Build 20261011-2141), nur Zahlen:** Tor nach genau 2 min offen (Slice vorher
0,28 GB, `MemAvailable` 37,4 GB) → 26B geladen in 48,9 s → Probe-Schritt 29,2 s (153 Denk-Tokens, nicht
gespeichert) → `fertig`. Geladen: `anon` 16,2 GB, `inactive_file` 3,2 GB, `active_file` 0,1 GB
(→ nicht rückgewinnbar 16,5 GB), `memory.current` 19,65 GB (Spitze beim Laden 19,66 GB, `inactive_file`
bis 9,4 GB — mit `use_mmap false` landet die gelesene GGUF als *inaktiver* Cache), `MemAvailable` ~21 GB, Swap
unverändert, Schwarm aktiv. Abbruch live (Zählaufgabe, Event nach 4 s): Verbindung nach 0,09 s getrennt, CPU von
`gruendlich` 0 %, Modell blieb geladen. Beim Abschalten (`KI_HG_AKTIV=0`) entladen, `anon` zurück auf 0,1 GB.

## Messung E2.4 — Gemma 4 26B gegen gemma3:4b (Nacht 11./12.10., nur Kennzahlen)

Ablauf: `probelauf.py` (Build `20261011-2326`, ab Teil b `20261012-0023`) mit `--modell gemma4:26b-a4b-it-qat
--ollama-url http://ollama-gruendlich:11434 --use-mmap 0 --num-gpu 0 --num-thread 10 --num-ctx 16384 --bild-schnell`
(ohne Denkmodus, Begründung unten), Seed 42, je Ordner 5, max 80, 126 Dateien aus 02/03/04/05/08, Zwillinge
ausgeschlossen, NAS-Ordnerliste 421 Pfade (eine FSM-Liste `fsm-ordnerliste.json` gab es nicht), Index 165 Vorbilder.
Geteilt in Teil a (`--max-dateien 14`, 40 Dateien = Vorlauf) und Teil b (`--max-dateien 80 --ab 14`, 86); gemma3:4b
in derselben Nacht mit demselben Code als Kontrolle. Reports `/data/probelauf/e24-{g4,g3}-{e,n}-{a,b}` (im Dienst-Container).

| Lauf | Dateien | Top-1 | Top-3 | Kategorie | Ziel unter Kandidaten | Fehler | Zeit je Datei |
|---|---:|---:|---:|---:|---:|---:|---:|
| gemma3:4b einsortiert (Kontrolle) | 126 | 54,8 % | 78,6 % | 96,0 % | 90,5 % | 0 | 5,4 s |
| **Gemma 4 26B einsortiert** | 124 von 126 | **58,1 %** | **78,2 %** | 94,4 % | 90,3 % | 2 (OOM) | 89 s (Median 77–88 s) |
| gemma3:4b neutral (Kontrolle) | 126 | 43,7 % | 63,5 % | 84,1 % | 73,0 % | 0 | 5,3 s |
| gemma3:4b neutral, Vorlauf-Teil | 40 | 47,5 % | 60,0 % | 65,0 % | 67,5 % | 0 | 7,5 s |
| **Gemma 4 26B neutral, Vorlauf-Teil** | 40 | **47,5 %** | **62,5 %** | 65,0 % | 67,5 % | 0 | 97 s |
| gemma3:4b einsortiert, Vorlauf-Teil | 40 | 72,5 % | 90,0 % | 90,0 % | 92,5 % | 0 | 7,2 s |
| Gemma 4 26B einsortiert, Vorlauf-Teil | 38 von 40 | 73,7 % | 89,5 % | 86,8 % | 92,1 % | 2 (OOM) | 83 s |

- Die Kontrolle trifft die Referenz (55/79 bzw. 44/64) — der Messweg ist unverändert.
- Je Freigabe einsortiert (Gemma 4 / gemma3): 02_LOCATIONS 65,0/80,0 gegen 58,5/80,5; 03_PROJEKTE_EVENTS 51,4/75,0 gegen
  49,3/75,3; 08_SICHERHEIT_ASA 40/80 gegen 60/80; 05 je 100/100. Zählt man die 2 OOM-Dateien als Fehlgriff: 57,1/77,0.
- **Ergebnis: kein belastbarer Qualitätsgewinn.** +3 Punkte Top-1 einsortiert (≈ 4 Dateien), Top-3 gleich, neutral gleich;
  die Decke bleibt die Rangliste (Ziel unter den Kandidaten 90 % bzw. 68 %, bei beiden Modellen identisch).
- Zeit (Prozessor, 10 Threads, Trust one lief mit 5–9 Kernen mit): Stufe 1 Median 60 s (Prompt ~1500 Tokens in 23 s ≈ 65 Tok/s,
  Antwort ~265 Tokens in 34 s ≈ 7,8 Tok/s), Stufe 2 Median 23 s. Kein Prompt-Cache über Dateien: Gemma nutzt Sliding-Window-
  Attention, `llama-server` rechnet jeden neuen Prompt voll («forcing full prompt re-processing … SWA»). Laden 42 s je Ladung.
- **OOM (wichtig für E2.3/Planer):** Ollama 0.35.1 startet `llama-server` mit Prompt-Cache **8192 MiB im RAM** (~0,45 GiB je
  Prompt, wegen SWA nutzlos). `anon` von «gruendlich» wuchs von 15,8 auf 18,9 GiB → 4× vom Kernel beendet (`mem_limit` 19g,
  23:24, 23:44, 23:57, 00:15), jeweils nach ~8–10 Dateien. Ab Teil b mit `--entladen-alle 3` (Entladen nach je 3 Dateien,
  +14 s je Datei): 0 OOM. Ohne Gegenmassnahme stirbt das Hauptmodell im Planer etwa alle 20 min. Abhilfe offen (Eltern-Session):
  Cache abschalten (`llama-server --cache-ram 0`; ob Ollama `LLAMA_ARG_CACHE_RAM` an den Runner durchreicht, ist ungeprüft)
  oder der Planer entlädt nach N Schritten; ein höheres `mem_limit` reicht nicht dauerhaft (Cache bis 8 GiB).
- **Bilder:** im Rauchtest (6 Dateien, Bild an Gemma 4) ebenfalls OOM; gemessen wurde deshalb mit `--bild-schnell`
  (16 Bild-Aufrufe von 126 Dateien gingen wie heute an gemma3:4b auf der GPU). Ob ein Bild allein den Speicher sprengt oder
  der Cache, ist nicht getrennt — Bild-Messung mit Cache aus offen.
- **Denkmodus:** Rauchtest 1 Datei mit `--think` (`num_predict` 1000 + 2048): nach 571 s keine Antwort (Budget vom Denken
  aufgebraucht, Inhalt leer). Mit ~8 Tok/s kostet Denken je Aufruf Minuten — für 126 Dateien in einer Nacht nicht machbar,
  darum ohne gemessen. Qualität mit Denken unbekannt.
- **Speicher und Trust one (Monitor alle 5 s):** Slice bis 22,0 GB (Grenze), `anon` des Slices bis 20,0 GB; dabei lagerte der
  Kernel **die anderen KI-Container** (dienst, schnell, db, whisper) bis 7,8 GB in den Swap aus (Host-Swap 8 GB fast voll,
  `pgmajfault` bis 750/s während der gemma3-Kontrolle bei noch geladenem 26B) — genau das Slice-Signal `ki_swap` des Wächters.
  Rig gesamt: `MemAvailable` min 11,9 GB, PSI memory full max 5,9, PSI io full max 22 (beim Laden), Abbruchgrenzen
  (< 1 GB, PSI full > 30) nie erreicht. Trust one: Swap 0, Speicher 10,5–13,8 GB, Schwarm durchgehend aktiv, I/O-Druck
  max 0,14; CPU-Druck (`cpu.pressure some`) bis 71 % in der ersten Stunde (Backtests mit ~9 Kernen + 10 Threads Gemma 4),
  danach ≤ 8 %. Nach Ende: Modell entladen, Swap zurück auf 0,3 GB.

**Empfehlung (Entscheid Eltern-Session/Mischa):** `KI_HG_TAG=0` lassen (kein Qualitätsgewinn bei 16× Zeit, CPU-Konkurrenz
mit Trust one und den Live-Extraktionen). `KI_HG_GPU_NACHT=0` lassen (Bedingung «≥ 1,5× Tokens/s» nicht gemessen; VRAM-
Matrix nicht gefahren). Threads: Nacht 10 beibehalten (gemessen, Trust one blieb ohne Swap und aktiv); Tag 6 unerprobt.
Vor `KI_HG_AKTIV=1`: OOM-Ursache Prompt-Cache beheben und das 26B nicht für die Ablage-Ordnerwahl einsetzen — der Wert
liegt, wenn überhaupt, bei Aufgaben ohne Rangliste (Fristen, Rückstau ZZ), was diese Messung nicht prüft.

## Tiefen-Index, Inhaltssuche, Frag das Archiv, Live-Trefferquote (E2.5–E2.7)

Masterplan §2.7, §3.1–§3.4 (MP-1 bis MP-4). Code: `dienst/app/tiefe.py` (Walker, Abschnitte, Tabellen, Lauf),
`dienst/app/jobs/tiefe.py` (Planer-Thread der Nacht), `dienst/app/suche.py`, `dienst/app/archiv_frage.py`,
`dienst/app/jobs/lernen.py`; Worker `dienst/app/worker.py`, FSM-Client `dienst/app/fsm.py`.

**Schalter** (`/etc/eventline-ki/env`, Standard 0, wirken mit `$C up -d dienst`):

| Schalter | Wirkung |
|---|---|
| `KI_TIEFE_AKTIV` | Tiefen-Index nachts aufbauen (`KI_TIEFE_MAX_H` 3 h je Nacht, `KI_TIEFE_OCR_SEITEN` 30, `KI_TIEFE_MAX_ZEICHEN` 300 000) — braucht das Hauptmodell nicht, läuft auch mit `KI_HG_AKTIV=0` |
| `KI_SUCHE_AKTIV` | Art `nas_suche` annehmen und im Herzschlag melden |
| `KI_ARCHIV_FRAGE_AKTIV` | Art `archiv_frage` annehmen und im Herzschlag melden |
| `KI_LERNEN_AKTIV` | Vorschläge jeder `ablage_analyse` merken (nur Pfade) und nach jedem Vorbilder-Lauf auswerten. **Seit 11.10. 23 Uhr wieder 0** (Review E2: stand auf 1, fehlt aber in Masterplan §2.8 und hängt im Ablage-Pfad) — einschalten erst, wenn der Schalter im Vertrag steht und Mischa E2.7 freigibt |

**Tiefen-Index (E2.5).** Tabellen im db-Container (Tresor), angelegt idempotent beim ersten Zugriff:
`archiv_text` (Pfad, Grösse, mtime, sha256, Text-Rezept, Seiten, OCR, Sprache, Zeichen, **Volltext** mit den
Seitenmarken `[Seite N]`, Fehlercode) und `archiv_abschnitte` (Abschnitte ~800 Zeichen, 120 Überlappung, an Absatz- und
Seitengrenzen, nie über eine Seite hinweg; `tsv` = `to_tsvector('german', text)` mit GIN-Index; Einbettung `bge-m3`
ohne Präfix; `ON DELETE CASCADE` an `archiv_text`). Text liegt nur hier (E5) — der Vorbilder-Index `archiv_dateien`
bleibt ohne Text.
- **Was gelesen wird:** alle lesbaren Freigaben **inklusive `ZZ_*`** (jede Tiefe, auch die Freigabe
  `ZZ_Dokumente_zum_Einsortieren`) und **`06_PERSONAL`** (E4/E5: der NAS-Bereich ist nur Admin), auch Dateien direkt in
  einer Freigabe; nie `99_System`, nie versteckte Einträge (`.`, `@`, `#`, `~$`), nie Dateien in der NAS-Wurzel.
  Endungen wie der Vorbilder-Index (PDF, DOCX, XLSX, TXT/CSV/MD, Bilder).
- **Wann:** nur nachts (Planer: 19:00–07:00, ab 06:45 nicht mehr), höchstens `KI_TIEFE_MAX_H` je Nacht-Fenster
  (Stand mit verbrauchten Sekunden im Tresor `data/dienst/tiefe-stand.json`, übersteht einen Neustart). Nach einem
  vollständigen Durchgang ruht er bis zur nächsten Nacht. Reihenfolge: läuft der Vorbilder-Index, wartet der
  Tiefen-Index (vor jeder Datei); das Hauptmodell lädt nicht, solange der Tiefen-Index läuft. Aufträge vom FSM haben
  immer Vorrang: vor jeder Datei und jedem Einbettungs-Stapel (≤ 32 Abschnitte, nimmt die GPU-Schleuse kurz) 20 s Ruhe.
- **Inkrementell:** gleiche Grösse + mtime + Text-Rezept → nichts; gleicher sha256 an neuem Ort (verschoben) → Text
  und Abschnitte per SQL übernommen, ohne neu zu lesen; nur das Abschnitt-Rezept geändert (z. B. anderes
  Einbettungsmodell) → aus dem gespeicherten Text neu zerlegt; sonst neu gelesen. Unlesbare Dateien (Passwort, > 50 MB,
  beschädigt) bekommen eine Zeile ohne Text mit Fehlercode und werden erst nach einer Änderung neu versucht.
  **Vorübergehende Fehler** (`zeit` nach 25 min, `kind_-9` = Kindprozess vom Kernel beendet, `kind_ausgabe`, andere
  `kind_*`) gelten nicht als gelesen: Zeile ohne Text mit Versuchszähler (`archiv_text.versuche`, Spalte idempotent
  ergänzt), nie übernommen, frühestens nach 6 h (also nächste Nacht) erneut, höchstens 3 Versuche, danach aufgegeben bis
  zur nächsten Änderung. `/health` → `tiefe.lesen_wiederholen` / `lesen_aufgegeben`; `dateien` und `gelesen_anteil`
  zählen sie nicht mit.
- **Textextraktion im Kindprozess** (`python -m app.tiefe extrakt …`): `nice 15`, `OMP_THREAD_LIMIT=2`,
  `oom_score_adj 1000` (vererbt an ocrmypdf/tesseract) — bei Speichernot im Dienst-Container stirbt dieser Prozess, nie
  der Dienst; der Text kommt über die Pipe, nie auf die Platte; Halt oder 25 min → ganze Prozessgruppe beendet. Die
  Umgebung des Live-Pfads (Ablage-OCR) bleibt unverändert.
- **Löschen** wie beim Vorbilder-Index: nur aus Freigaben, die vollständig aufgelistet wurden (eine nicht eingehängte
  = leere Freigabe oder ein nicht lesbarer Unterordner zählt als unvollständig → dort nichts entfernt, neuer Versuch
  nach 10 min), und nie, wenn auf einmal 50 % oder mehr des Bestands verschwinden (Bremse). Entfernt wird nach dem
  Lesen (Verschobenes ist dann schon übernommen), auch wenn das Zeitbudget das Lesen beendet hat.
- **Status:** `/health` → `tiefe { laeuft, dateien, mit_text, abschnitte, nas_dateien, gelesen_anteil, letzter_lauf,
  nacht { fenster, sekunden, budget_s, fertig }, letzte_bilanz }`; je Lauf eine Log-Zeile `Tiefen-Index: …` (nur
  Zähler). Von Hand: `$C exec dienst python -m app.tiefe status`.

**Inhaltssuche `nas_suche` (E2.6, MP-3).** Payload `{ q, limit }` (q 2–200 Zeichen, limit 1–50, Standard 20).
Einbettung der Frage (`bge-m3`, tagsüber 07–19 Uhr `keep_alive 2h` — mit `KI_SUCHE_AKTIV` oder
`KI_ARCHIV_FRAGE_AKTIV` tagsüber auch bei jeder anderen `bge-m3`-Einbettung ohne eigenen Wert, also Ablage, Vorbilder-
und Tiefen-Index; sonst setzte jede Ablage das Modell auf 5 min zurück), Vektor-Top-50 + Volltext-Top-50
(`ts_rank`, `websearch_to_tsquery('german', q)`), vereint per RRF (k = 60), je Datei die beste Stelle, `score` 0..1
(1 = Rang 1 in beiden Listen). Ergebnis **nur** `{ treffer: [{ pfad, seite, score }], index: { dateien,
gelesen_anteil }, dauer_ms }` — **nie Abschnittstext** (Schema-Test `tests/test_suche.py`). Name, Ordner und Datum
ergänzt das FSM aus `ablage_datei_index`. Ist die Einbettung nicht da (Modell lädt), sucht sie nur im Volltext.
Eigene DB-Verbindung mit `statement_timeout 5 s` (wartet nie hinter dem Indexlauf).

**Frag das Archiv `archiv_frage` (E2.6, MP-4).** Payload `{ frage }` (3–500 Zeichen). Suche wie oben → beste 8
Abschnitte (≤ 18 000 Zeichen) → Antwort **nur** aus diesen Auszügen mit `KI_MODELL_TEXT` (`gemma3:4b`, gleiches
`num_ctx` wie die Ablage, kein Neuladen). Nie das Hauptmodell (Entscheid E1, Masterplan §1.5). Keine passende
Fundstelle (kein Volltext-Treffer und beste Vektor-Ähnlichkeit < 0,45, oder das Modell meldet «nicht gefunden») →
`antwort` = «Dazu finde ich im Archiv nichts.», `quellen: []`. Ergebnis `{ antwort (≤ 4000), quellen: [{ pfad, seite }]
(≤ 8), modell, dauer_ms }`. Frage und Antwort gehen nie in Log oder Protokoll.

**Fähigkeiten und Abholtakt (MP-1, MP-2).** Jeder Poll (auch `nur_herzschlag`) trägt `arten=<kommagetrennt>`:
`ablage_analyse,beleg_analyse,warenkorb_analyse,diktat`, dazu `nas_suche`/`archiv_frage` nur mit Schalter — daran
schaltet das FSM seine Routen frei (`kiBereit`). Schickt `GET /api/ki/sync` `naechster_poll_ms` (jemand hat im FSM die
Suche oder das Archiv offen, `POST /api/ki/wach`), pollt der Worker nach `max(250 ms, naechster_poll_ms)` statt nach
2 s; fehlt das Feld, gilt wieder der normale Takt. Die Phase-3-Arten (`archiv_index`, `zz_einsortieren`,
`fristen_scan`) gibt es nicht mehr (MP-9).

**Live-Trefferquote (E2.7).** Nach jeder `ablage_analyse` legt der Worker `sha256`, den vorgeschlagenen Ordner, die
zwei Alternativen, die Quelle des Entscheids (regel/ki/rangliste/…) und das Modell in eine Warteschlange; ein eigener
Thread schreibt sie in `ablage_vorschlaege` (nur Pfade — der Live-Pfad wartet nie). Nach jedem Lauf des
Vorbilder-Index (Start, nachts `KI_INDEX_NACHT`) wird ausgewertet: Ordner der Datei mit gleichem sha256 in
`archiv_dateien` = tatsächlicher Ablageort → je Tag (Datum des Vorschlags, je Datei der letzte) `qualitaet_tag(datum,
n, top1, top3, ohne_vorschlag)`. Dateien unter `ZZ_*` stehen nicht im Vorbilder-Index und zählen nicht. Keine
Gewichtsänderung, nichts ans FSM. 90 Tage aufbewahrt. `/health` → `lernen { tage_7 { n, top1, top3 }, tage_30 {…},
offen, gemerkt, letzte_auswertung }`.

**Messung 2026-10-11 (Build `20261011-2221`, nur Zahlen, direkt im Container — nicht über das FSM):**
- Tiefen-Index erster Durchgang ab 22:12: nach ~8 min 163 Dateien / 967 Abschnitte, nach ~17 min 303 von 449 lesbaren
  NAS-Dateien (67 %), 1804 Abschnitte; Dienst-Container ~230 MB, Kindprozess nice 15, ocrmypdf nice 19.
- Inhaltssuche warm (6 Suchbegriffe): Einbettung 7–12 ms, Vektor-Top-50 5–9 ms, Volltext ≤ 1 ms; ganzer Handler
  27–290 ms. Läuft gleichzeitig ein Einbettungs-Stapel des Tiefen-Index, wartet die Suche bis ~1,7 s auf die
  GPU-Schleuse (im Betrieb pausiert der Index vor dem nächsten Stapel, sobald ein Auftrag läuft). Trefferqualität
  (MRR@10, Recall@20) erst mit der Liste von Mischa/Leo (20–30 echte Suchanfragen).
- Frag das Archiv warm: 1,0–2,1 s Modell (Prompt ~2000 Tokens, Antwort ~100 Tokens), gesamt 2–6 s; kalt (gemma3:4b
  nicht geladen) einmal 86 s. Ohne Treffer im Index: fester Satz in ~2 s ohne Modellaufruf.

**Tests ohne Netz** (wie alle): `tests/test_tiefe.py`, `tests/test_suche.py`, `tests/test_lernen.py`. Das SQL prüft
`tests/test_tiefe_db.py` gegen eine **Wegwerf-Datenbank** (Anleitung im Kopf der Datei: eigenes internes Netz +
`pgvector/pgvector:pg16`, danach beides entfernen); ohne `TEST_PG_DSN` wird er übersprungen.

## Rückfall auf den vorherigen Build

`install.sh` sichert vor jedem Bau den laufenden Stand als `eventline-ki/dienst:vorher` und
`eventline-ki/caddy:vorher`. Zurück (ohne neu zu bauen):

```bash
docker tag eventline-ki/dienst:vorher eventline-ki/dienst:local
$C up -d --no-build dienst
```

Neue Funktionen stehen hinter Schaltern (`KI_HG_*`, `KI_TIEFE_AKTIV`, `KI_SUCHE_AKTIV`, `KI_ARCHIV_FRAGE_AKTIV`,
`KI_LERNEN_AKTIV`, Standard 0): meist reicht Schalter auf 0 und `$C up -d dienst`.

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
4. **Rangliste** (deterministisch, `ordnerwahl.py`): **Regeln zuerst** — INT-Nummer **mit «INT»** im
   Dateinamen («INT-26-014», «INT26014», «Offerte_INT-26-014») → der Projektordner mit dieser Nummer
   (eindeutig = entschieden, kein zweiter Modellaufruf; doppelte Nummer = beide vorne). Die blosse Form
   «26-014» ohne «INT» entscheidet **nicht** (Lieferanten-Offert-/Rechnungsnummern sehen gleich aus) — sie
   gibt wie «INT-…» im Text nur einen Zuschlag (`TEXT_INT`), das Modell wählt. Erkannte Person bei
   personenbezogenem Typ → nur die Personalakte dieser Person (`NNNN_Vorname_Nachname` in einer
   PERSONAL-Freigabe, **alle** Namensteile gleich, auch kurze wie «Li»; Akte ohne Unterordner = entschieden).
   Ist ein Regel-Bereich erkannt (Projekt, Akte), bekommt jeder Unterordner darin einen Sockel (`REGEL/2`) —
   auch ein Scan ohne Text hat dann Kandidaten. Ordner in oder unter `ZZ_*` (jede Tiefe) sind nie Kandidat
   und nie Ziel eines `neuer_ordner`. Danach Stimmen der Nachbarn je Ordner (exp((s − s_max)/0,05)), Übertrag auf gleichnamige
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
  ab `KI_INDEX_NACHT` (Standard **19:05** Europe/Zurich seit 2026-10-11, Masterplan §2.3: die Ablage des Tages ist
  Vorbild, bevor Tiefen-Index und Hauptmodell rechnen; vorher 02:30. Fenster 4 h als Zeitdifferenz, auch über Mitternacht —
  23:30 gilt bis 03:30; ein Neustart am Tag holt nichts nach; ein ungültiger Wert wird beim Start als Fehler
  geloggt und es gibt keinen Nachtlauf). Inkrementell: gleiche Grösse + mtime → nichts; gleicher sha256 an
  neuem Ort → Einbettung übernommen; sonst Text (OCR höchstens `KI_INDEX_OCR_SEITEN`=3 Seiten) + Einbettung.
  Vor jeder Einbettung derselbe VRAM-Schritt wie in der Ablage (`archiv.platz_fuer_einbettung`).
- **NAS fehlt = nichts löschen (Review 2026-10-11, Befund 1):** `/mnt/eventline-nas` ist auf dem Rig ein
  normaler Ordner, jede Freigabe darunter ein eigener CIFS-Mount (`eventline-ki-nas.service`); eine nicht
  eingehängte Freigabe ist ein **leerer Ordner**, kein Fehler. Darum: (a) je Freigabe gilt «unvollständig»,
  wenn sie nicht lesbar ist, keine Einträge hat oder kein Mount-Punkt ist, obwohl die anderen einer sind —
  dort wird nichts entfernt, der Lauf zählt als unterbrochen (`/health` `freigaben_unvollstaendig`) und wird
  nach 10 min wiederholt; (b) Bremse: verschwinden in einem Durchgang 50 % oder mehr des Bestands (oder wurde
  nichts geprüft), wird nichts entfernt; (c) der Lauf startet erst, wenn mindestens eine Freigabe lesbar ist
  und Einträge hat; (d) `eventline-ki.service` hat `Wants=`/`After=eventline-ki-nas.service`, und der
  Bind-Mount im Compose hat `propagation: rslave` (Host-Mounts sind `shared`) — ein späteres Einhängen kommt
  im Container an. Ordner-Einbettungen fallen nur bei vollständigem Durchgang weg. Folge der Bremse: wird
  wirklich die Hälfte des Archivs auf einmal verschoben/gelöscht, bleibt der Index stehen (alte Zeilen
  bleiben, Neues kommt dazu) — dann von Hand prüfen.
- **Nie Vorbild:** `ZZ_*` auf **jeder** Tiefe (Hauskonvention für Altes/Archiv/zum Einsortieren — die
  FSM-Liste filtert nicht nach Namen und führt solche Ordner als aktiv, darum filtern Index und Rangliste),
  `99_System`, versteckte Einträge (`.`, `@`, `#`, `~$`), Dateien in der Freigabe-Wurzel; was im FSM nicht
  als aktiver Ordner steht, zählt bei der Wahl nicht.
- **FSM-Ordnerliste für den Probelauf:** der Dienst legt die Ordnerliste, die mit jedem Ablage-Auftrag kommt
  (aktive Ordner, Vererbung angewandt), bei Änderung im Tresor ab: `/srv/eventline-ki/data/dienst/fsm-ordnerliste.json`
  (nur Pfade, im Container `/data/fsm-ordnerliste.json`). Ein eigener Abruf ohne Auftrag geht nicht — das FSM
  schickt den Kontext nur mit beanspruchten Aufträgen.
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

**Korrektur nach dem Review (Nachmessung 2026-10-11, Build `20261011-1215`, Seed 42, 126 Dateien, Index 165
Vorbilder, Ordnerliste 421 NAS-Pfade, Reports `/data/probelauf/review-20261011-seed42-ohne-zwillinge[-neutral]`):**
Die Werte oben sind zu optimistisch. 21 der 126 Testdateien hatten im selben Ordner einen Fast-Zwilling
(gleiches Dokument als PDF und DOCX, Versionen; Kosinus > 0,95 oder gleicher Namensstamm), den das alte
Leave-one-out (nur gleiche sha256) nicht ausschloss — der Zwilling «verriet» den Ordner. Ausserdem nutzte die
Messung die bereits einsortierten (sprechenden) Dateinamen. Ehrlich gemessen:

| Variante | Top-1 | Top-3 | Kategorie | Rangliste ohne KI 1/3/5 | Regel / KI | Median / Max |
|---|---|---|---|---|---|---|
| ohne Zwillinge (einsortierte Dateinamen) | **55 %** | **79 %** | 96 % | 49 %/79 %/84 % | 8 / 118 | 4,6 s / 65 s |
| ohne Zwillinge + neutrale Dateinamen (wie roher Upload «Scan_001.pdf») | **44 %** | **64 %** | 83 % | 39 %/62 %/67 % | 0 / 126 | 4,8 s / 64 s |

Je Freigabe (ohne Zwillinge, einsortiert / neutral): 02_LOCATIONS 56 % / 44 % Top-1 (Top-3 80 % / 68 %),
03_PROJEKTE_EVENTS 49 % / 45 % (75 % / 64 %), 05_VERKAUF_MARKETING 100 % / 0 % (dort trägt nur der Name),
08_SICHERHEIT_ASA 60 % / 60 %. Der Live-Betrieb liegt zwischen den beiden Zeilen: Uploads haben oft sprechende,
aber nicht einsortierte Namen. Deshalb V8 (§SPEC 3.1): das Rig liefert eine präzise, minimierte Einordnung,
Claude entscheidet den Ordner — die lokale Wahl bleibt der Rückfall.

## V8 Rig-Seite — Einordnung für den Claude-Entscheid (SPEC §3.1)

Seit Build `20261011-1509` (2026-10-11, Review-Nachträge Builds `20261011-1553` und `20261011-1721`) liefert `ablage_analyse` zusätzlich zu den
bisherigen Feldern (lokale Wahl und Rückfall im FSM; gleiche Felder und gleiche Quote, aber einzelne Entscheide sind
andere, weil der gemeinsame SYSTEM-Prompt für beide Stufen länger wurde):

| Feld | Inhalt | Woher |
|---|---|---|
| `einordnung.was` | 1–2 Sätze, was das Dokument ist und wozu es dient (≤ 300 Zeichen), minimiert | Stufe 1, Feld `was` |
| `einordnung.typ` | DOK_TYPEN-Key (geprüft wie `typ`; Foto ohne Text = `sonstiges`) | Stufe 1 |
| `einordnung.betreff` | `betreff` minimiert, an Wortgrenze auf ≤ 80 Zeichen | Stufe 1 |
| `einordnung.partei` | nur Organisationen (`partei_art = organisation`), nie bei personenbezogenen Dokumenten, nie ein Profilname | Stufe 1, `partei` + `partei_art` |
| `einordnung.bezug` | `{ art: location/projekt/kunde/partner/firma/person/null, name }`; bei `person`/`firma` oder Profilname `name` null | Stufe 1, `bezug_art`/`bezug_name` |
| `einordnung.jahr` | Jahr aus `dok_datum`, sonst Angabe des Modells (1990 … heute+5) | Stufe 1 |
| `einordnung.personenbezogen` | Modell-`true` ODER erkannte Person ODER Bezug `person` ODER Personen-Typ (Flag `person` des FSM, sonst lohnabrechnung/behoerde/zertifikat) ODER Personalakten-Regel ODER (Review) Profilname in `was`/`betreff`/`partei`/`bezug_name` des Modells ODER Personal-Ordner im Spiel (bester Kandidat der Rangliste, Kandidat eines Regel-Bereichs oder lokal gewählter Ordner unter einer Freigabe mit «personal»). Das **rohe** Feld `person` des Modells zählt nicht: mit Mitarbeiterliste im Prompt füllt gemma3:4b es fast immer (12 von 12 Location-Dokumenten), das machte im Build `1701` 56 von 63 Dokumenten «personenbezogen» — Build `1721` nimmt das Signal heraus | deterministisch |
| `einordnung.sprache` | `de`/`fr`/`it`/`en` aus Funktionswörtern des Texts, sonst null | deterministisch |
| `einordnung.seiten` | Seitenzahl (PDF/Bild) oder null | Extraktion |
| `kandidaten` | bis 8 Ordner der Rangliste (Reihenfolge der Rangliste), `gewicht` = Punkte relativ zum ersten (1.0), nie steigend, 2 Stellen, ≥ 0,01; `quelle` `regel` = aus erkanntem Regel-Bereich (INT im Dateinamen, auch mehrdeutig; Personalakte), sonst `vorbild` | `ordnerwahl.py` |
| `regel_ordner` | Pfad, wenn eine Regel verbindlich entscheidet (INT mit «INT» im Dateinamen → eindeutiger Projektordner ohne Unterordner; eindeutige Personalakte ohne Unterordner), sonst null | `ordnerwahl.py` |

**Kein zusätzlicher Modellaufruf:** die sechs Felder `was, bezug_art, bezug_name, partei_art, jahr, personenbezogen`
hängen hinten am JSON-Schema der Stufe 1 (die bisherigen Felder entstehen zuerst). Die V8-Regeln stehen im gemeinsamen
SYSTEM-Prompt, der auch für Stufe 2 gilt — darum ändern sich einzelne Typen (Stufe 1) und Wahlen (Stufe 2), die Quote
bleibt gleich (Basis gegen V8, einsortiert: Rangliste-Top-1 49,2 → 48,4 %, Kategorie 96,0 → 96,8 %, Modell wählt
Rang 1 93 → 98, verbessert 13 → 11, verschlechtert 6 → 3). Echte Gleichheit je Datei gäbe es nur mit den V8-Regeln
ausserhalb des gemeinsamen Prompts.

**Minimierung auf dem Rig** (`dienst/app/einordnung.py`, Spiegel von `minimiereText` im FSM — das FSM minimiert
nochmals): E-Mail, IBAN, AHV `756.…`, Telefon (international und CH), Beträge mit CHF/EUR/Fr./sFr./Rp./€/Franken/
Euro/Rappen, Zahlen mit Apostroph-Tausendertrenner, nackte 6+-stellige Zahlen → «[…]»; alle Namen aus
`kontext.namen_alle` und `mitarbeiter` (NFC wie im FSM) in **jeder** Reihenfolge der Namensteile (bis 4 Teile,
darüber Rotationen), mit Komma oder Unterstrich, Gross/Klein egal, auch mit gefalteten Umlauten (Näf = Naef) →
«[Mitarbeiter/in]». `beschrieb`/`zusammenfassung` werden nicht minimiert — sie gehen nie an Claude.

**Zusätzlich nur auf dem Rig (Review 2026-10-11, im FSM noch nicht gespiegelt):** Beträge ohne Währung mit zwei
Dezimalen oder «.–» (`980.50`, `1250,00`, `4500.–`; nicht Datum «11.10.», Uhrzeit «14.30 Uhr», Masse «12.00 m»,
«2.50 %»), Zahl nach einem Betragswort (Total, Pauschale, Betrag, Summe, Preis, Kosten, Honorar, Gage, Budget, Miete,
Anzahlung, Rabatt — ausser einer Jahreszahl), Postkonto `12-3456-7`, Strasse/Weg/Gasse/Platz/… + Hausnummer und
«Rue/Route/Via … 12», PLZ + Ort (`4051 Basel`, `CH-…`, `D-…`; nicht `2026 Basel` und nicht Mengen wie `1500 Gäste`,
`1200 Stühle`, `2000 Personen` — Build `1721`; Ortsnamen wie Bettingen/Zimmerwald/Wattwil bleiben PLZ + Ort) → «[…]»; Anrede (Herr/Herrn/Frau/
Hr./Fr., optional Dr./Prof.) + 1–2 grossgeschriebene Wörter → «Anrede […]», bzw. «Anrede [Mitarbeiter/in]», wenn ein
Wort ein Teil (≥ 3 Zeichen) eines Profilnamens ist. Bewusst in Kauf genommen: ein grossgeschriebenes Nomen direkt
nach dem Namen fällt mit weg, und «Lieferschein vom 11.10» (Datum ohne Schlusspunkt) wird zu «[…]».

**Probelauf-Export:** `probelauf.py --export <datei> [--namen-alle-datei <datei>]` schreibt je Testdatei
`{ freigabe, soll, variante, einordnung, kandidaten, regel_ordner, lokal: { ordner, alternativen }, ms }` — nie
Beschrieb, Zusammenfassung, Text, Dateiname oder Pfad der Testdatei.

**Messwerte lokal (2026-10-11, Seed 42, 126 Dateien aus 02/03/04/05/08, je Ordner 5, max 80, Zwillinge
ausgeschlossen, NAS-Ordnerliste 421 Pfade, Index 165 Vorbilder, `namen_alle` 10 Profilnamen, Mitarbeiterliste leer
wie in der Nachmessung; Reports `/data/probelauf/v8-basis-seed42` und `/data/probelauf/v8-export/report-*`):**

| Lauf | Top-1 | Top-3 | Kategorie | Rangliste 1/3/5 | Ziel unter den ≤ 8 Kandidaten | `regel_ordner` (richtig) | personenbezogen | Median / Max je Datei |
|---|---|---|---|---|---|---|---|---|
| vorher, Build `1443`, einsortierte Namen | 55 % | 79 % | 96 % | 49/79/84 % | – | – | – | 4,6 s / 67 s |
| V8, einsortierte Namen | 55 % | 79 % | 97 % | 48/79/84 % | **90 %** (Kandidat 1: 48 %) | 8 (8) | 6 | 3,8 s / 63 s |
| V8, neutrale Namen («dokument.pdf») | 44 % | 64 % | 84 % | 39/62/67 % | **73 %** (Kandidat 1: 39 %) | 0 | 9 | 3,8 s / 63 s |

- Lokale Wahl unverändert (55/79 bzw. 44/64 — gleich wie in der Nachmessung), 0 Fehler, `num_ctx` durchgehend 8192.
- Zeit: kein Anstieg je Datei (Median 4,6 → 3,8 s, Laufzeit 700 → 605 s). Die reine Antwortzeit je Modellaufruf
  stieg im Median um 12 % (1285 → 1441 ms, sechs Felder mehr), Prompt-Tokens im Median 1584 → 1914 (längerer
  statischer Anfang, KV-Cache). Dass die Datei insgesamt schneller wurde, ist eher Streuung/Last des Basislaufs als
  ein Effekt von V8 — belastbar ist: **≤ +12 %, Ziel ≤ 20 % eingehalten**.
- Je Freigabe (einsortiert / neutral), Ziel unter den Kandidaten: 02_LOCATIONS 93 % / 78 %, 03_PROJEKTE_EVENTS
  89 % / 75 %, 05_VERKAUF_MARKETING 100 % / 0 %, 08_SICHERHEIT_ASA 80 % / 80 %, 04_PARTNER 1/1 / 1/1.
- Abdeckung der Einordnung (einsortiert): `was` 126/126, `partei` 71, `bezug.art` 126, `jahr` 126, `sprache` 50
  (viele Pläne/Tabellen ohne Fliesstext). Export-Prüfung: keine fremden Schlüssel, eine zweite Minimierung ändert
  an keinem Feld etwas; `was` im Median 94 Zeichen, max. 276.
- Die Trefferquote mit Claude misst die FSM-Seite aus den Exporten (Claude-Entscheid gegen `soll`).

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
  zu klein für den Modellwechsel (Seitencache zählt mit). Prüfen: `cat /sys/fs/cgroup/system.slice/system-eventlineki.slice/docker-$(docker inspect eventline-ki-ollama --format '{{.Id}}').scope/memory.events`
  (`oom_kill` > 0) und `mem_limit` von `ollama` in `docker-compose.yml` erhöhen. `oom_kill` in
  `/sys/fs/cgroup/system.slice/system-eventlineki.slice/memory.events` (ohne Container) = der ganze Slice war bei
  22 GB — dann trifft es zuerst `ollama-gruendlich` (gewollt, Masterplan §2.1).
- **Caddy startet nicht (Port):** 443 muss auf 192.168.1.128, 10.9.0.2 (WireGuard aktiv?) und 127.0.0.1 frei sein.
- **Kein Zertifikat:** `$C logs caddy` — DNS-Eintrag `ki.in.eventline-basel.com` → 192.168.1.128 und Cloudflare-Token (Zone-DNS-Edit) prüfen.
- **Unit startet nicht:** `AssertPathIsMountPoint` — der Tresor war nicht gemountet; `systemctl start eventline-ki-vault` und erneut.
- **Diktat hängt («Spracherkennung hat zu lange gebraucht»), obwohl whisper «healthy» ist:** `DELETE /api/ps/<modell>`
  (Entladen per API) verklemmt diese Server-Version dauerhaft (Deadlock im Modell-Manager, 2026-10-03 gemessen) — der
  Dienst ruft es deshalb nie auf. Wer es von Hand getan hat: `$C restart whisper`. Den VRAM gibt Whisper nach
  `WHISPER__TTL` (5 min) selbst frei.
- **Dienst meldet «FSM lehnt den Sync-Token ab»:** `KI_SYNC_TOKEN` in `/etc/eventline-ki/env` und auf Vercel müssen gleich sein.
- Trust-one-Dienste (Schwarm, Atlas/Hermes, Bots) werden von diesem Stack nie berührt; `systemctl is-active trust-one-swarm` vor und nach jeder Aktion prüfen.
