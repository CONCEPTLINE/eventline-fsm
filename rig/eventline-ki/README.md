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
| `messung/` | Speicherprofil jede Minute (`speicherprofil.sh`) und Auswertung (`auswerten.py`), nur Zahlen; Technik-Sammler (`technik_sammler.py`, Dauerdienst `eventline-ki-technik.service`) |
| `kuehlung/` | Lüfter/Pumpe nach Temperatur, alle LEDs aus, Profil aus der App (`kuehlung.py`, OpenLinkHub, liquidctl, OpenRGB, eigenes `install.sh`) — Abschnitt «Kühlung & LEDs» |
| `nas-messung/` | Mess-Container fürs NAS (UGOS-Docker-Projekt, nur lesend) und `zugang-erzeugen.sh` — Anleitung im README dort |
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

## Speicher der GPU-Instanz: Prompt-Cache aus (15.10.2026)

**Befund (Messnacht 15.10.):** nach ~40 Dokumenten am Stück hielt `eventline-ki-ollama` 8,8 GiB Arbeitsspeicher
(`mem_limit` 12g), frei erst beim Entladen nach `OLLAMA_KEEP_ALIVE` (5 min). Mit «Arbeiten, wenn frei» (Rückstau ZZ,
hunderte Dateien am Stück) ein Absturzrisiko — und neben dem Hauptmodell der Grund für Wächter-Abbrüche `ki_knapp`.

**Ursache (belegt):** Ollama 0.35.1 startet `llama-server` ohne `--cache-ram`, also mit dem Standard **8192 MiB
Host-RAM für zwischengespeicherte Prompts** (Log `load_model: prompt cache is enabled, size limit: 8192 MiB`, «idle slots
will be saved to prompt cache upon starting a new task»). Vor jedem neuen Auftrag legt der Server den letzten Prompt samt
Kontext-Checkpoints dort ab: je Prompt 0,22–0,33 GiB (gemma3:4b, ctx 8192, KV q8_0) — Log `cache state: 26 prompts,
7935 MiB (limits: 8192 MiB …)`. Nutzen fast keiner: in 24 h 424 Suchen, davon meist `lcp = 8, f_keep = 0.002` (nichts
wiederverwendbar), höchstens ~1000–2000 Tokens Vorspann gespart = 0,2–0,4 s bei ~4900 Prompt-Tokens/s auf der Karte
(Gemma: Sliding-Window-Attention; die Wiederverwendung im eigenen Slot über Kontext-Checkpoints bleibt unberührt).

**Lösung an der Wurzel:** `LLAMA_ARG_CACHE_RAM: "0"` in der Umgebung von `ollama` (`docker-compose.yml`). `llama-server`
erbt die Umgebung von `ollama serve` (geprüft: `/proc/<pid>/environ` des Runners enthält die `OLLAMA_*` des Containers)
und liest `LLAMA_ARG_CACHE_RAM` wie `--cache-ram` (Text im Binary `libllama-common.so`). Probe 15.10. in einem
Wegwerf-Container (gleiches Image, nur CPU, `--network none`, bge-m3): Log `prompt cache is disabled - use --cache-ram N
to enable it` und `--cache-idle-slots requires --cache-ram, disabling`. Statischer Test: `python3 test_stack.py`.
`ollama-gruendlich` ist unverändert (gleiche Ursache der OOMs vom 11./12.10. — dort entlädt heute nur die Messung selbst
nach je N Dateien; dieselbe Zeile dort einzutragen ist der naheliegende nächste Schritt, Entscheid Eltern-Session).

Wirksam erst nach `$C up -d ollama` (neuer Container; lädt die Modelle beim nächsten Auftrag neu, ~3–6 s). Prüfen:
`$C logs ollama 2>&1 | grep "prompt cache"` → «disabled». **Eingespielt 15.10.2026, 23:18 (Build 20261015-2318).**

**Messung vorher/nachher (15.10.2026, 23:13–23:46, Container `eventline-ki-ollama`, alle 2 s: `memory.stat anon` und
`memory.current` der Container-cgroup, VmRSS der llama-server):** synthetische Last wie Ablage/Rückstau — je Datei zwei
Aufrufe an gemma3:4b (Stufe 1, Stufe 2 mit gleichem Anfang), ~4400 Prompt-Tokens, ctx 8192, jede Datei anderer Text
(aus Silben, kein Dokumentinhalt); dazu ein echter Selbsttest-Trockenlauf (Ablage-Analyse auf 60 Dateien je mit und ohne
Dateiname = 120 Analysen, mit Suchmodell, schreibt nichts).

| Lauf | Dateien | anon max | `memory.current` max | llama-server RSS max | Prompt-Cache | Zeit |
|---|---|---|---|---|---|---|
| vorher (Standard 8192 MiB) | 40 | **7,92 GiB** | **12,00 GiB = Grenze** | 8,59 GiB | an, zuletzt 27 Prompts / 7947 MiB | Stufe 1 Ø 1,56 s, Stufe 2 Ø 0,37 s |
| nachher (`LLAMA_ARG_CACHE_RAM=0`) | 120 | **0,95 GiB** (flach) | 1,27 GiB | 1,53 GiB | aus | Stufe 1 Ø 1,62 s, Stufe 2 Ø 0,38 s |
| nachher, echter Selbsttest | 60 × 2 | **1,96 GiB** (zwei Modelle) | 4,10 GiB | 4,49 GiB (2 Prozesse) | aus | Median 4,6 s je Analyse (vorher 4,4–4,9 s), 0 Fehler, Trefferquote wie zuvor |

Ohne Prompt-Cache bleibt der Speicher nach dem Laden flach, unabhängig von der Zahl der Dateien; die Wiederverwendung
des gemeinsamen Anfangs im eigenen Slot (Stufe 2) wirkt weiter, Tempo unverändert. Vorher lief der Container schon nach
40 Dateien an seine 12-GB-Grenze (der Kernel verdrängte nur noch Datei-Seiten). Werkzeuge der Messung: `messe_ollama.sh`
(Abtaster), `last_ollama.py` (Last), lagen nur unter `/tmp` des Rigs.

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
  Cache abschalten (`llama-server --cache-ram 0`; **seit 15.10. geprüft: Ollama reicht `LLAMA_ARG_CACHE_RAM` an den Runner
  durch**, auf der GPU-Instanz gesetzt — Abschnitt «Speicher der GPU-Instanz: Prompt-Cache aus»)
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

**Schalter** (`/etc/eventline-ki/env`, Standard im Code 0, wirken mit `$C up -d dienst`). Stand auf dem Rig:
`KI_TIEFE_AKTIV=1`, **`KI_SUCHE_AKTIV=1` und `KI_ARCHIV_FRAGE_AKTIV=1` seit 12.10.2026 07:49** (Inhaltssuche und «Frag
das Archiv» live für Admins), `KI_LERNEN_AKTIV=0`.

| Schalter | Wirkung |
|---|---|
| `KI_TIEFE_AKTIV` | Tiefen-Index nachts aufbauen (`KI_TIEFE_MAX_H` 3 h je Nacht, `KI_TIEFE_OCR_SEITEN` 30, `KI_TIEFE_MAX_ZEICHEN` 300 000) — braucht das Hauptmodell nicht, läuft auch mit `KI_HG_AKTIV=0`. **Auf dem Rig an** (12.10.: 449 von 449 Dateien gelesen) |
| `KI_SUCHE_AKTIV` | Art `nas_suche` annehmen und im Herzschlag melden. **Auf dem Rig an seit 12.10. 07:49** |
| `KI_ARCHIV_FRAGE_AKTIV` | Art `archiv_frage` annehmen und im Herzschlag melden. **Auf dem Rig an seit 12.10. 07:49** |
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
- **Wann:** nur nachts (Planer: 19:00–07:00, ab 06:45 nicht mehr) — schwere Arbeit (OCR, Einbettungen), bewusst
  NICHT Teil von «Arbeiten, wenn frei» (das gilt nur für Rückstau ZZ und Fristen, Abschnitt Nachtarbeit) —, höchstens
  `KI_TIEFE_MAX_H` je Nacht-Fenster
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
Einbettung der Frage (`bge-m3`; während des Planer-Tags `KI_TAG_START`–`KI_NACHT_START` mit `keep_alive` bis
Tagesende, mindestens 5 min — mit `KI_SUCHE_AKTIV` oder `KI_ARCHIV_FRAGE_AKTIV` auch bei jeder anderen
`bge-m3`-Einbettung ohne eigenen Wert, also Ablage, Vorbilder- und Tiefen-Index; sonst setzte jede Ablage das Modell auf
5 min zurück. Den VRAM kostet das nichts: braucht ein anderes Modell den Platz, wirft Ollama das unbenutzte `bge-m3`
hinaus, und vor einem Diktat entlädt der Dienst bei Enge alles), Vektor-Top-50 + Volltext-Top-50
(`ts_rank`, `websearch_to_tsquery('german', q)`), Mindest-Ähnlichkeit (unten), vereint per RRF (k = 60), je Datei die
beste Stelle, `score` 0..1 (1 = Rang 1 in beiden Listen). Ergebnis **nur** `{ treffer: [{ pfad, seite, score }],
index: { dateien, gelesen_anteil }, dauer_ms, modus }` — **nie Abschnittstext** (Schema-Test `tests/test_suche.py`).
`modus` = `kombiniert` (Vektor + Volltext) oder `volltext` (Einbettung nicht rechtzeitig da); das FSM reicht es bis
in den Browser durch (Hinweis «nur Volltext — KI-Suche startet gerade», solche Ergebnisse werden nicht
zwischengespeichert). Name, Ordner und Datum ergänzt das FSM aus `ablage_datei_index`.
Eigene DB-Verbindung mit `statement_timeout 5 s` (wartet nie hinter dem Indexlauf).
- **Kaltstart (Befund Live-Test 12.10.):** ist `bge-m3` nicht geladen, wartete die Suche bis 6 s auf die Einbettung —
  mit dem Abholen über Vercel (Funktionen in `iad1`, DB in Zürich: 2,2–2,8 s je Anfrage, obwohl das Rig nur 42–72 ms
  rechnet) über dem FSM-Zeitlimit von 8 s. Jetzt wartet sie **höchstens 2 s** (`EINBETTUNG_WARTEN_S`) und liefert sonst
  sofort das Volltext-Ergebnis mit `modus: "volltext"`; das Laden läuft im Hintergrund fertig (eigener Faden, bis
  30 s), die nächste Suche ist warm. Eine Einbettung, die bis dahin noch nicht begonnen hat, wird verworfen (kein Stau).
- **Vorladen beim Wach-Impuls (MP-2):** schickt das FSM `naechster_poll_ms` (Fokus ins Suchfeld oder «Frag das Archiv»
  geöffnet → `ki_status.eilig_bis`), prüft der Worker **im Leerlauf** höchstens alle 5 s, ob `bge-m3` geladen ist, und
  lädt es sonst im Hintergrund (`Suche.vorwaermen`, `Ollama.vorladen`). Es wartet nie auf die GPU-Schleuse (belegt →
  nichts, neuer Versuch beim nächsten Impuls), lädt nur bei mindestens `KI_EMBED_MIN_FREI_MB` freiem VRAM und entlädt dafür nie ein
  anderes Modell — `gemma3:4b` (Ablage, Belege) und Whisper (Diktat) bleiben unberührt. Mit Arbeit in der Hand wird
  nicht vorgeladen. Log: `Inhaltssuche: bge-m3 vorgeladen (Wach-Impuls), Laden N ms`.
- **Mindest-Ähnlichkeit (kalibriert 12.10. auf dem Tiefen-Index, 449 Dateien, nur Scores und eigene Suchbegriffe):**
  Volltext-Stellen bleiben immer. Stellen, die **nur** die Vektorliste findet, bleiben
  1. mit **Wort-Anker** (`TiefenIndex.kennt_woerter`, eine tsquery über den GIN-Index, Median 3,5 ms, höchstens 20 ms)
     ab Kosinus **0,45** (dieselbe Schwelle wie «Frag das Archiv»). Anker ist: ein ganzes Wort der Anfrage steht im
     Index; oder ein Index-Wort ab **5 Buchstaben** steckt in einem Wort der Anfrage (**Teilwort**: Komposita wie
     «Spesenabrechnung» → «abrechn», viele Tippfehler wie «Mitvertrag» → «vertrag»); oder ein Wort der Anfrage ab 5
     Buchstaben ist Anfang eines Index-Worts (**Präfix**: halb getippt «Mietvert», «Stornierung» → «storni…»).
     Teilwort/Präfix nur aus reinen Buchstaben-Wörtern bis 40 Zeichen (nie Zahlen).
  2. **ohne Anker** (Englisch, Synonym ohne gemeinsames Wort) nur bei **dichter Nachbarschaft**: mindestens **10**
     Stellen ab **0,53** in der Vektor-Top-50 — dann bleiben genau diese.

  | Anfragen | beste Vektor-Ähnlichkeit | Anker | Stellen ≥ 0,53 (Top-50) | Dateien mit Treffer (neu) |
  |---|---|---|---|---|
  | 10 Fachbegriffe (Vertrag, Rechnung, Offerte, Mietvertrag, Versicherung, Lohnausweis, Bewilligung, Catering, Technik, Kündigung) | 0,49–0,62 | 10 von 10 (ganzes Wort) | 0–50 | 10 von 10 |
  | 10 mehrwortige Fachanfragen | 0,55–0,70 | 10 von 10 | 1–50 | 10 von 10 |
  | **25 korrekte Begriffe, nicht wörtlich im Index** (Komposita «Spesenabrechnung», «Mietvertragsverlängerung», «Kündigungsschreiben», «Steuererklärung», «Bankverbindung» …; «Stornierung»; Englisch «invoice», «contract», «receipt», «salary», «lease» …) | 0,45–0,62 | 12 (Teilwort/Präfix) | 0–50 | **18 von 25** (vorher 0): 12 mit Anker, 6 über Verteilung (invoice 40, salary 34, receipt 28, cancellation 15, lease 15, «employment contract» 13 Stellen ≥ 0,53) |
  | 8 Tippfehler («Mitvertrag», «Rechnnung» …) | 0,51–0,56 | 6 von 8 (Teilwort/Präfix) | 0–4 | 6 von 8 (vorher 0) |
  | 8 halb getippte Wörter («Mietvert», «Kündigun» …) | 0,43–0,56 | 8 von 8 | 0–7 | 6 von 8 (2 ohne Stelle ≥ 0,45) |
  | 290 zufällige Unsinn-Zeichenfolgen (darunter die 10 vorgegebenen wie «xqzvwkjj») | 0,37–0,60 (Median ~0,47) | 2 von 290 (je ein kurzes ganzes Wort, «foo bar baz» → «bar»); Teilwort/Präfix 0 | **höchstens 5** | 2 von 230 nachgeprüften; die 10 vorgegebenen: 0 |
  | 150 deutsch klingende Pseudo-Wörter («Gelschedorschaft») | 0,34–0,50 | 20 (meist «…schaft») | 0 | 2 (5 bzw. 20 Dateien, beide mit Anker) |

  Eine reine Schwelle trennt nicht: Unsinn erreicht bis 0,603, echte Einzelbegriffe liegen ab 0,49 — über 0,60
  verlören fast alle echten Anfragen ihre Vektor-Treffer. Die erste Fassung (nur ganze Wörter) war dafür zu streng:
  korrekt geschriebene Komposita, Synonyme und Englisch hatten 0 Treffer, weil die Kalibrierung nur Begriffe prüfte,
  die wörtlich im Index stehen. Preis jetzt: Englisch/Synonyme mit dünner Nachbarschaft («contract» 6, «insurance» 4,
  «deposit» 2 Stellen ≥ 0,53) und zwei Tippfehler ohne Teilwort («Offrte», «Cattering») bleiben ohne Vektor-Treffer —
  der Abstand zum Unsinn (höchstens 5) ist dort zu klein. Pseudo-Wörter mit echtem Wortteil haben einen Anker, aber
  meist keine Stelle ≥ 0,45 (18 von 20 ohne Treffer). Log je Suche: Treffer, Vektor, Volltext, verworfen,
  Wort-Anker (ja/Verteilung/nein) — nie der Suchbegriff.

**Frag das Archiv `archiv_frage` (E2.6, MP-4).** Payload `{ frage }` (3–500 Zeichen). Suche wie oben → beste 8
Abschnitte (≤ 18 000 Zeichen) → Antwort **nur** aus diesen Auszügen mit `KI_MODELL_TEXT` (`gemma3:4b`, gleiches
`num_ctx` wie die Ablage, kein Neuladen). Nie das Hauptmodell (Entscheid E1, Masterplan §1.5). Keine passende
Fundstelle (kein Volltext-Treffer und keine Vektor-Stelle nach der Regel der Suche oben — Unsinn also ohne
Modellaufruf —, oder das Modell meldet «nicht gefunden») →
`antwort` = «Dazu finde ich im Archiv nichts.», `quellen: []`. Ergebnis `{ antwort (≤ 4000), quellen: [{ pfad, seite }]
(≤ 8), modell, dauer_ms }`. Frage und Antwort gehen nie in Log oder Protokoll.
- **Kaltstart:** die Frage läuft asynchron (Auftrag + Abfrage über `/api/ki/archiv/[id]`, kein 8-s-Limit) und wartet
  deshalb nicht nur 2 s wie die Suche, sondern die volle Ladefrist der Einbettung (`EINBETTUNG_TIMEOUT_S`, 30 s;
  `Suche.stellen(frage, frist_s=…)`). Kommt die Einbettung trotzdem nicht (Ollama weg) und findet der Volltext allein
  nichts, ist «nichts im Archiv» nicht belegt: dann Fehler «Das Suchmodell der lokalen KI ist gerade nicht bereit —
  bitte gleich nochmals fragen» statt des festen Satzes (Test `test_archiv_frage_kaltstart_wartet_aufs_modell`).

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

## Technik-Dashboard: Sammler und Melder

Vertrag: `docs/technik-dashboard/VERTRAG.md` §1–§2 (Seite `/technik` im FSM, nur Admins). Nur Zahlen und
Zustandswörter — keine Hostnamen, Adressen, Freigabe-Namen, Hersteller, Modelle, Seriennummern, Fehlertexte.

- **Sammler** `messung/technik_sammler.py` (nur Python-Standardbibliothek) als Dauerdienst
  `eventline-ki-technik.service` (root, `Nice=10`, `IOSchedulingClass=idle`, `MemoryMax=96M`, `CPUQuota=10%`,
  `ProtectSystem=strict`, schreibt nur `/srv/eventline-ki/data/dienst/technik/`). Alle 10 s: Prozessor (hwmon,
  `/proc/stat`, Takt, Drosselzähler), Grafikkarte (`nvidia-smi`, nie `name`), RAM (`/proc/meminfo`, PSI,
  `pgmajfault`, KI-Slice, Trust one **nur als Summe** `memory.current/high/max` + `cpu.stat`), Platten-/Netz-Zähler.
  In einem eigenen Thread mit harten Zeitlimits: Dienste (docker, gefiltert auf `com.docker.compose.project=eventline-ki`,
  30 s), Belegung `/` und Tresor (60 s), SSD (`smartctl -H -A --json`, 5 min), RAM-Module (`dmidecode -t 17`, nur
  Steckplatz und Grösse, täglich), NAS-Basis (60 s, **eigener Unterprozess, 5 s Zeitlimit**: TCP-Test Dateifreigabe/
  Weboberfläche ohne Login, `statvfs` auf eine eingehängte Freigabe — eine hängende CIFS-Einhängung wird getötet und
  blockiert den Sammler nie), NAS-Hardware über die Mess-Container auf dem NAS (60 s, eigener Unterprozess, 15 s,
  ruhend bis `/etc/eventline-ki/technik-nas.env` da ist, dann Vorrang) bzw. sonst NAS-SNMP (5 min, 10 s, ruhend).
  Ausgabe atomar (`stand.json.tmp` → fsync → `os.replace`) als `root:1500 0640`; ohne eingehängten Tresor wird
  nichts geschrieben.
- **Tresor schliessen:** nur mit `sudo systemctl stop eventline-ki-vault` (nachdem der KI-Stack gestoppt ist) — das
  stoppt zuerst auch den Sammler (`BindsTo`), dessen eigener Mount-Namespace den Tresor sonst festhält und
  `cryptsetup close` mit «device in use» scheitern lässt. `systemctl start eventline-ki-vault` startet ihn wieder
  (`WantedBy`). Wer `eventline-ki-vault close` direkt aufruft, vorher `sudo systemctl stop eventline-ki-technik`;
  der Sammler prüft die Einhängung zusätzlich aus Sicht des Hosts (`/proc/1/mountinfo`) und beendet sich ohne Tresor.
- **Hängende Werkzeuge:** Läuft `nvidia-smi` (5 s) oder `smartctl` (30 s) ins Zeitlimit, startet kein neuer Lauf,
  solange der alte Prozess lebt, und das Werkzeug ruht 5 min (Feld fehlt → Seite «nicht lesbar»).
- **SNMP-Zugang ungültig** (Feld fehlt, Passwort < 8 Zeichen oder mit Leerzeichen/#/Anführungszeichen, Protokoll
  unbekannt, Rechte nicht root 0600): `snmp.grund = "zugang_ungueltig"`, die Seite sagt das; im Journal steht je
  Zustandswechsel eine Warnung mit Feldname und Grund (nie Werte).
- **Freigaben-Soll** = Anzahl `NAS_SHARES` in `/etc/eventline-ki/env` (lesend, `/mnt/eventline-nas`) plus
  `/etc/eventline-sync/env` (schreibend, `/mnt/eventline-nas-rw`); Ist aus `/proc/1/mountinfo` (Host-Sicht, fasst kein
  Dateisystem an). Die NAS-Adresse (`NAS_HOST`) bleibt im Sammler.
- **«oom»** je Dienst = in den letzten 15 min stieg `oom_kill` der Container-Cgroup (oder der Container ist daran
  gestorben). Dockers `OOMKilled` allein bleibt bis zum nächsten Neustart stehen (z. B. der gewollte Test vom 11.10.
  an `gruendlich`) und wäre sonst dauerhaft «kritisch».
- **Raten** in `minute` (`netz.*_bps`, `platte.*_bps`) sind **Bytes pro Sekunde**, GB-Werte binär (GiB).
- **Melder** `dienst/app/technik.py` im KI-Dienst (`KI_TECHNIK_AKTIV`, Standard an; `KI_TECHNIK_DATEI`, Standard
  `/data/technik/stand.json`): alle 60 s Datei lesen (fehlt/kaputt/älter 15 min → Block weg), Ollama beider
  Instanzen nur über `/api/version`, `/api/tags`, `/api/ps` (3 s), Auftrag/Warteschlange/Archiv/Tiefen-Index/Schalter
  aus dem `/health`-Bild, Tempo der letzten eigenen Antwort (`llm.letztes_tempo`) → `POST /api/technik/messwerte`
  (Rig-Anmeldung `KI_SYNC_TOKEN`, über `egress`, 15 s). 404/405/501 (Route im FSM noch nicht live) → still weiter im
  Takt; geloggt wird nur ein Wechsel des Zustands mit Statuscode. Kein Nachsenden, nichts am Herzschlag.
- **Lüftersensor:** Der Super-I/O-Treiber lädt ohne Kernel-Parameter, findet auf diesem Board aber nur den
  Zweitchip (alle Lüfter 0 U/min); der Hauptchip wird vom Kernel-Treiber nicht erkannt. Ein `force_id` auf einen
  fremden Chip würde in Register schreiben, die nicht passen — **nicht erzwungen**. `install.sh` prüft das einmal
  (Merker `/var/lib/eventline-technik/luefter-geprueft`, zum erneuten Prüfen löschen) und trägt den Treiber nur ein,
  wenn er echte Drehzahlen liefert. Seit 14.10. kommen die Drehzahlen stattdessen vom LINK-Hub (Abschnitt «Kühlung &
  LEDs»): `cpu.luefter_rpm` = Radiator-Lüfter bzw. alle 7, solange kein Ort zugeordnet ist.
- **Werkzeuge** installiert `install.sh` bei Bedarf: `smartmontools` (der mitgelieferte Dienst `smartd` wird
  abgeschaltet, der Sammler ruft `smartctl` selbst) und `snmp` (nur Client, kein `snmpd`).

**NAS-Hardware über Mess-Container (Mischa, empfohlen — UGOS Pro hat keinen SNMP-Agenten):** Anleitung
`nas-messung/README.md`, Vertrag §1.4. Kurz: `sudo bash nas-messung/zugang-erzeugen.sh` auf dem Rig (Zufallspasswort
nur in `/etc/eventline-ki/technik-nas.env`, fertige Compose-Datei mit bcrypt-Hash in
`/etc/eventline-ki/technik-nas-compose.yml`), Compose in der UGOS-Docker-App als Projekt anlegen
(`prom/node-exporter:v1.12.1` auf 9100, `prometheuscommunity/smartctl-exporter:v0.15.0` auf 9633, Host-Netz,
Basic-Auth), UGOS-Firewall: 9100/9633 nur von der Adresse des Rigs. Der Sammler fragt beide alle 60 s im Kind
(`--exporter-probe`, Zugang über stdin, ohne Proxy/Weiterleitung) und füllt denselben Block `nas.snmp` mit
`quelle: "exporter"`. Log: `NAS-Exporter ok/-`, `… fehler/anmeldung|keine_antwort|zeitlimit`,
`… ok/- (ohne platten: …)`, `… nicht_eingerichtet/zugang_ungueltig`. Datei löschen = zurück zu SNMP bzw. «kommt».

**NAS-SNMP einschalten (nur falls ein NAS mit SNMP-Agent kommt):** im NAS SNMP **v3, nur lesend** (eigener Benutzer,
`authPriv`, v1/v2c aus, wenn möglich nur vom Rig erreichbar), dann auf dem Rig:

```bash
sudo install -m 0600 -o root -g root /dev/null /etc/eventline-ki/technik-snmp.env
sudoedit /etc/eventline-ki/technik-snmp.env
#   NAS_SNMP_BENUTZER=…            NAS_SNMP_AUTH_PROTOKOLL=SHA     (oder SHA-256)
#   NAS_SNMP_AUTH_PASSWORT=…       NAS_SNMP_PRIV_PROTOKOLL=AES
#   NAS_SNMP_PRIV_PASSWORT=…       (Passwörter mind. 8 Zeichen, ohne Leerzeichen, # und Anführungszeichen)
```

Kein Neustart nötig: der Sammler liest die Datei alle 5 min (Log: `NAS-SNMP ok/-` bzw. `fehler/anmeldung`,
`fehler/zeitlimit`). Die Zugangsdaten gehen nie auf die Kommandozeile (eigene `snmp.conf` im Laufzeit-Ordner,
nach jeder Abfrage gelöscht). Abgefragt werden nur Standard-MIBs (HOST-RESOURCES, UCD-SNMP, LM-SENSORS); was das NAS
dort nicht liefert, fehlt im Paket (Seite: «nicht lesbar»). Ungetestet, solange kein Zugang besteht — insbesondere
die Zuordnung der Platten-Temperaturen zu den Schächten (Reihenfolge der Fühler) und der Pool-Zustand.

**Prüfen:**

```bash
systemctl status eventline-ki-technik          # läuft, Speicher < 96 MB
journalctl -u eventline-ki-technik -n 20       # nur Zustandswörter
sudo python3 -c "import json;d=json.load(open('/srv/eventline-ki/data/dienst/technik/stand.json'));print(d['rig']['gemessen_am'],d['rig']['cpu']['temp_c'],d['nas']['freigaben'])"
$C logs dienst | grep Technik-Messwerte        # «zugestellt» bzw. «FSM kennt die Route noch nicht (HTTP 404)»
docker run --rm --network none -v /srv/eventline-ki/repo/eventline-ki:/t:ro -w /t/dienst eventline-ki/dienst:local python tests/test_technik.py
```

Abschalten: `sudo systemctl disable --now eventline-ki-technik` (Sammler) bzw. `KI_TECHNIK_AKTIV=0` und
`$C up -d dienst` (Melder).

### Leistung der lokalen KI (`rig.leistung`, VERTRAG §2.6)

Der Sammler liest alle 10 min **nur lesend** sechs Teile aus der Rig-DB (je ein `psql -c`; scheitert einer, fehlt nur
er): `auftraege` (ki_protokoll je Art), `dokumente` (Seiten/Zeichen/gescannt/Teile je Art mit Dokument), `gelesen`
(archiv_text: Zähler, grösste Werte), `lesezeit` (archiv_text.dauer_ms), `fristen`, `selbsttest`. Datenquellen im Dienst
(Nachtrag 15.10.2026, alle Spalten idempotent beim ersten Zugriff angelegt, alte Zeilen bleiben leer — nie geschätzt):

| Spalte / Eintrag | geschrieben von | Inhalt |
|---|---|---|
| `ki_protokoll.seiten`, `zeichen`, `gescannt`, `teile` | `worker.py` (Ablage: nach dem Lesen, auch wenn danach das Modell scheitert; Beleg/Warenkorb: Foto = 1 Seite, gescannt, ohne Zeichen), `nachtarbeit.py` (Rückstau ZZ: aus archiv_text, Teile zu 10 000 Zeichen; ohne Ziel keine Seiten) | nur Zahlen, Grenzen 100 000 Seiten/Teile, 10⁸ Zeichen |
| `archiv_text.dauer_ms` | `tiefe.py` | Dauer der Textextraktion je Datei (Kindprozess mit Texterkennung) — ohne Prüfsumme, Zerlegen, Einbetten, Warten; übernommene (verschoben) und unlesbare Dateien ohne Wert |
| `ki_protokoll` Art `sicherheit_rapport`, Quelle `rig` | `sicherheit.py` | Rechenzeit je Rapport (ohne den Weg zum FSM), Modell nur wenn es gefragt wurde, ok = FSM hat angenommen (sonst `HTTP <code>`/`melden`) |

Je Seite: Protokoll = ganze Rechenzeit / Seiten (Median der erfolgreichen); Tiefen-Index = Lesezeit / gelesene Seiten,
bei gescannten durch min(Seiten, N) (N = `KI_TIEFE_OCR_SEITEN`, steht als «ocrN» im Text-Rezept). Prüfen:

```bash
$C exec db psql -U eventline -d eventline_ki -c "select art, count(*), count(seiten), max(seiten), max(teile) from ki_protokoll where zeit > now() - interval '1 day' group by art"
$C exec db psql -U eventline -d eventline_ki -c "select count(*) filter (where dauer_ms is not null), round(avg(dauer_ms)) from archiv_text"
sudo python3 -c "import json;d=json.load(open('/srv/eventline-ki/data/dienst/technik/stand.json'));print(json.dumps(d['rig'].get('leistung',{}).get('zeitraeume',{}).get('7d'))[:600])"
```

Tests: `messung/test_sammler_leistung.py` (ohne DB), `messung/test_sammler_leistung_db.py` (Schema-Nachtrag idempotent,
SQL des Sammlers gegen echte Zeilen — Wegwerf-DB wie `tests/test_tiefe_db.py`).

### Geladene KI-Modelle und RAM-Belegung (`rig.ki_modelle`, `rig.ram.belegung`, VERTRAG §2.7)

Seit 15.10.2026 misst der Sammler je geladenem Modell **beider** Ollama-Instanzen: `/api/ps` (Adresse im internen Netz
aus `docker inspect`, alle 10 s, Zeitlimit 3 s, lädt nie ein Modell) und den llama-server-Prozess dazu — nur PIDs aus
`cgroup.procs` der zwei Ollama-Container: CPU im Mittel seit der letzten Messung (`rechnet` ab 25 % = ¼ Kern), VmRSS
und RssAnon (fester Speicher inkl. Prompt-Cache). Blob → Modellname über die Manifeste im Tresor; `--embedding` in der
Befehlszeile = Suchmodell (unter Ollama 0.35.1 geprüft: nur bge-m3 startet damit). Dazu `ram.belegung` (KI-Modelle,
übriger KI-Bereich, Trust one als `memory.stat anon` der Slice — nur die Summe —, System, verfügbar). Der Melder ergänzt
`ki.hintergrund` (Nachtarbeit, Indexe, Doppel-Prüfung, Hauptmodell mit laufendem Schritt). Prüfen:

```bash
sudo python3 -c "import json;d=json.load(open('/srv/eventline-ki/data/dienst/technik/stand.json'));r=d['rig'];print(json.dumps(r.get('ki_modelle')), json.dumps(r.get('ram',{}).get('belegung')))"
```

Tests: `messung/test_sammler_ki_modelle.py` (Manifeste, Prozesse nur aus dem Container, /api/ps, Zusammenführen, CPU,
Belegung), `dienst/tests/test_technik.py` (`hintergrund_aus`).

## Kühlung & LEDs

Ordner `kuehlung/`, eingerichtet 14.10.2026 (Mischa). Ziel: Lüfter und Pumpe nach Temperatur statt Werksstufe, alle
LEDs aus, Drehzahlen ins Technik-Dashboard, Lüfterprofil aus der App. Hängt **nicht** am Tresor und nicht am KI-Stack
— die Kühlung läuft ab dem Start des Rigs, auch wenn der Tresor zu ist. Grafikkarten-Lüfter: unverändert Treiber-
Automatik (wird nirgends angefasst; OpenLinkHub startet kein `nvidia-smi`). Kein Kernel-Parameter, kein Neustart nötig.

**Hardware (gelesen, nichts erraten):** iCUE-LINK-Hub mit 7 Lüftern (Kanäle 1–5 an Anschluss 1, 13–14 an Anschluss 2;
bei gleicher Leistung drehen 1/3/5 rund 20 % schneller als 2/4/13/14 — vermutlich zwei Grössen, bei 100 % gemessen
2110 bzw. 1710 U/min), Kraken X53/63/73 (Pumpe, Kühlmittel-Fühler, LED-Ring + Logo, Firmware 2.1.0), Mainboard-LEDs
(IT5702), 2 RAM-Riegel mit LEDs (Vengeance RGB Pro; die zwei anderen haben keine), Grafikkarte mit LEDs (Fusion-2-GPU).

**Installiert** (`sudo bash kuehlung/install.sh`, idempotent, Versionen fest):

| Was | Version / Quelle | Prüfung |
|---|---|---|
| liquidctl (Pumpe, Kühlmittel, Kraken-LEDs) | `1.13.0-2` aus Ubuntu (apt) | apt-Signatur |
| OpenLinkHub (LINK-Hub: Lüfterkurven, Hub-LEDs) | `0.9.2`, GitHub-Release `OpenLinkHub_0.9.2_amd64.tar.gz` → `/opt/OpenLinkHub` | SHA-256 `e1a2211f…c0c` = GitHub-Digest |
| OpenRGB (Mainboard, RAM, Grafikkarte LEDs) | `1.0` AppImage von Codeberg, ausgepackt → `/opt/openrgb-1.0` | SHA-256 `a77d9fea…ebf` (Codeberg veröffentlicht keine — am 14.10. festgehalten) |
| Laufzeit-Bibliotheken | `libpipewire-0.3-0t64` (OpenLinkHub), `libegl1 libopengl0 libice6 libsm6` (OpenRGB) | apt |

- **udev:** nur die Zeile des Projekts für den LINK-Hub (`1b1c:0c3f` → Besitzer `openlinkhub`); die übrigen ~190
  Corsair-Geräte und die `uinput`-Regel (Tastatur-Nachbildung) bewusst nicht. OpenRGB läuft als root (kein udev nötig).
- **OpenLinkHub** als `openlinkhub` (System-Benutzer), eigene Unit statt der des Projekts: nur `127.0.0.1:27003`
  (`config.json`, `install.sh` prüft mit `ss -ltnp`), Netz nur localhost, nur `hidraw`, kein `nvidia-smi`
  (`defaultNvidiaGPU: -1` + `InaccessiblePaths`), Speicher/Gamepad/Mainboard-Funktionen aus, `Restart=always` ohne
  Startgrenze. Weboberfläche bei Bedarf über SSH-Tunnel: `ssh -L 27003:127.0.0.1:27003 rig`.
- **OpenRGB** nur mit drei Erkennern (`/etc/eventline-kuehlung/openrgb/OpenRGB.json`): «Gigabyte RGB Fusion 2 USB»,
  «Corsair DRAM», «Gigabyte GeForce RTX 3070 MASTER» — alle ~1900 anderen aus, vor allem LINK-Hub und Kraken (die
  gehören OpenLinkHub bzw. liquidctl). Die Liste holt `install.sh` ohne Erkennung (als `nobody`, mit Startverzögerung).
  RAM-LEDs gingen ohne Kernel-Parameter (SMBus `i2c-i801` war schon geladen) — erledigt.

**Aufbau (3 Units + OpenLinkHub):**

- `eventline-kuehlung-boot.service` (oneshot, vor OpenLinkHub, `kuehlung.py boot`): gemerktes Profil → Pumpenkurve in
  den Kraken, LED-Ring/Logo aus, Mainboard/RAM/Grafikkarte «Direct» schwarz (keines kennt «Off»). Geht bei Stromverlust
  verloren, darum bei jedem Start. Ergebnis in `/run/eventline-kuehlung/boot.json`.
- `OpenLinkHub.service`: fährt die Lüfterkurve des Profils (OpenLinkHub-Profile `eventlineLeise|Ausgewogen|Kuehl`,
  geschrieben von `kuehlung.py olh-profile`). Fühler «External HwMon» = `/run/eventline-kuehlung/regel_temp`.
- `eventline-kuehlung.service` (`kuehlung.py dienst`, `Type=notify`, `WatchdogSec=30`): schreibt alle 2 s die
  **Regeltemperatur** = CPU-Package-Temperatur, geglättet (steigt mit τ 10 s, fällt mit τ 60 s — sonst «pumpen» die
  Lüfter hörbar mit jeder Lastspitze; gemessen schwankt die CPU unter Teillast 64↔90 °C binnen Sekunden), ab 88 °C
  ungeglättet; Kühlmittel ≥ 45 °C → 95 °C (= 100 %); Fühler nicht lesbar → 90 °C (= 100 %). Dazu: Wunschprofil der App
  übernehmen (≤ 15 s), Pumpenkurve + Kraken-LEDs alle 15 min neu setzen, Hub-LEDs/Profil am Hub selbst heilen, Status
  für den Sammler (`/run/eventline-kuehlung/status.json`), Wächter für OpenLinkHub. Kein Mount-Namensraum (er liest die
  Wunschdatei im Tresor; ein eigener Namensraum könnte den Tresor beim Schliessen festhalten).

**Kurven** (einzige Quelle: `PROFILE` in `kuehlung.py`; `test_technik.py` prüft Boden, 100 %-Grenzen, Monotonie und
dass «kuehl» ≥ «ausgewogen» ≥ «leise» bei jeder Temperatur). Lüfter nach Regeltemperatur, Pumpe nach Kühlmittel
(im Kraken gespeichert, regelt ohne Software weiter):

| Profil | Lüfter (Regeltemperatur °C → %) | Pumpe (Kühlmittel °C → %) |
|---|---|---|
| `leise` | ≤45→25 · 60→30 · 70→40 · 78→60 · 85→80 · ≥90→100 | ≤30→50 · 36→55 · 40→70 · 43→85 · ≥45→100 |
| `ausgewogen` (Standard) | ≤40→25 · 50→28 · 60→38 · 68→55 · 76→75 · ≥84→100 | ≤30→55 · 35→65 · 40→80 · 43→90 · ≥45→100 |
| `kuehl` | ≤35→30 · 50→45 · 60→60 · 68→80 · ≥75→100 | ≤30→70 · 35→85 · ≥40→100 |

Begründung: 25 % ist genau die Werksstufe des Hubs (~480–530 U/min) — im Leerlauf also nicht lauter als bisher. Unter
KI-/Dauerlast (Regeltemperatur 65–75 °C) liefert «ausgewogen» 45–70 % (≈ 1000–1450 U/min) und die Pumpe 55–65 % bei
30–35 °C Kühlmittel. Die Radiatorlüfter senken vor allem das Kühlmittel; die CPU liegt bei Last ~30–40 K darüber,
darum die steile Strecke 60–84 °C. Sicherheitsboden in allen Profilen: Lüfter nie unter 25 %, Pumpe nie unter 50 %,
ab Regeltemperatur 90 °C bzw. Kühlmittel 45 °C → 100 %.

**Gemessen (14.10., nachts, je 60 s, vergleichbare Grundlast Trust one + KI, Load 7,7–8,5):** vorher (Hub Werksstufe
~500 U/min, Pumpe 40 %) CPU Ø 75,9 °C, Spitze 90 °C, Kühlmittel 41,4 °C; nachher («ausgewogen», Lüfter ~58 %,
Pumpe 57 %) CPU Ø 65,5 °C, Spitze 73 °C, Kühlmittel 31,5 °C.

**Ausfallverhalten (gemessen 14.10.):**

| Fall | Was der Hub tut | Absicherung | Ergebnis |
|---|---|---|---|
| OpenLinkHub sauber gestoppt (`systemctl stop`) | Hardware-Modus: nach < 10 s **~480–530 U/min** (25 %), Werks-LEDs | `eventline-kuehlung` übernimmt nach 60 s selbst («Notbetrieb», 100 %) | 100 %: 2110/1710 U/min; Start von OpenLinkHub → Hub nach 0,7 s freigegeben (Sperre `hub.lock`), Kurve wieder aktiv |
| OpenLinkHub abgestürzt (SIGKILL) | hält die letzte Leistung (90 s gemessen, kein Rückfall) | `Restart=always`, 3 s, ohne Startgrenze | läuft nach 3 s wieder |
| OpenLinkHub hängt (SIGSTOP) | hält die letzte Leistung | Wächter: API 30 s stumm → Neustart (höchstens alle 5 min) | nach 30 s neu gestartet, 10 s später «ok» |
| `eventline-kuehlung` abgestürzt | Kurve läuft weiter | ExecStopPost: `regel_temp` → Verweis auf den CPU-Fühler (ungeglättet), `Restart=always` 5 s | Verweis gesetzt, nach 5 s wieder Datei |
| `eventline-kuehlung` hängt | dito | systemd-Wächter 30 s → Neustart | nach 30 s neu gestartet |
| Rig-Start | Hub bis OpenLinkHub läuft auf Werksstufe | Start-Unit vor OpenLinkHub, Pumpe/LEDs neu | — |

Während der Tests blieb die CPU ≤ 75 °C. **Wartung am Hub** (OpenLinkHub absichtlich stoppen): erst
`sudo systemctl stop eventline-kuehlung`, sonst greift nach 60 s der Notbetrieb (100 %, laut — gewollt als Signal).

**Profil aus der App:** Die Antwort auf `POST /api/technik/messwerte` enthält `steuerung.luefter_profil`. Der Melder
(`dienst/app/technik.py`) prüft es (nur `leise|ausgewogen|kuehl`, `stand` ISO-Zeit) und schreibt nur den Namen nach
`/data/steuerung/luefter_profil` (= Host `/srv/eventline-ki/data/dienst/steuerung/luefter_profil`, atomar, nur bei
Änderung). Fehlt das Feld oder ist es ungültig, bleibt die Datei. Der Host-Dienst liest sie alle 15 s vorsichtig
(Ordner und Datei echt, kein Verweis, ≤ 64 B, Besitzer 1500/root) und merkt das Profil in
`/var/lib/eventline-kuehlung/profil` (gilt auch ohne Tresor; Start: `ausgewogen`). Übernahme gemessen: 8 s nach der
Datei, ≤ 75 s nach der App. Von Hand: `sudo python3 kuehlung/kuehlung.py profil kuehl` (bis die App wechselt).

**Paket** (`rig.kuehlung`, Vertrag): `status ok|fehler|nicht_eingerichtet`, `grund` (`notbetrieb`, `hub_dienst_steht`,
`hub_antwortet_nicht`, `pumpe_nicht_lesbar`, `cpu_fuehler_fehlt`, vom Sammler: `dienst_steht` = Status älter 60 s,
`status_kaputt`), `profil_aktiv`, `luefter[] {nr, ort, rpm, prozent}` (`prozent` = vorgegebene Leistung der Kurve),
`pumpe_rpm`, `pumpe_prozent`, `kuehlmittel_c`, `leds aus|an|unbekannt` («aus» nur, wenn Hub, Pumpe und OpenRGB es
seit diesem Start bestätigt haben). Pumpe nicht lesbar ⇒ nie «ok» ohne `pumpe_rpm` (die Seite hielte das für eine
stehende Pumpe); «ok» mit `pumpe_rpm: 0` heisst wirklich «steht». `rig.cpu.luefter_rpm` = Radiator-Lüfter, solange
kein Ort bekannt ist alle 7. Minutenwerte `kuehlung.kuehlmittel_c`, `kuehlung.pumpe_rpm`, `kuehlung.luefter_rpm`
(Mittel). Keine Seriennummern, Gerätenamen oder Marken.

**Ort der Lüfter:** Der Hub weiss nicht, wo ein Lüfter sitzt — darum `ort: "unbekannt"`. Einmal von Hand zuordnen
(Kanal → `radiator|front|heck|boden`), wirkt ohne Neustart:

```bash
sudo tee /etc/eventline-kuehlung/luefter-orte.json <<'EOF'
{"1": "front", "2": "front", "3": "front", "4": "heck", "5": "boden", "13": "radiator", "14": "radiator"}
EOF
```

(Beispielwerte! Kanal 1–5 = Kette an Anschluss 1 des Hubs in Kabel-Reihenfolge, 13–14 = Anschluss 2.)

**Prüfen:**

```bash
systemctl status eventline-kuehlung OpenLinkHub eventline-kuehlung-boot
python3 kuehlung/kuehlung.py status                 # Status-Datei lesbar
journalctl -u eventline-kuehlung -n 20               # nur Zustandswechsel («Kühlung ok, ausgewogen»)
sudo ss -ltnp | grep 27003                           # nur 127.0.0.1
sudo liquidctl --match kraken status                 # Kühlmittel, Pumpe
sudo systemctl stop eventline-kuehlung OpenLinkHub && sudo python3 kuehlung/kuehlung.py hub-lesen --wach   # Ausfalltest; danach beide starten
```

**Zurück auf Werkszustand:** `sudo systemctl disable --now eventline-kuehlung eventline-kuehlung-boot OpenLinkHub` —
der Hub geht sofort in den Hardware-Modus (Werksstufe ~500 U/min, Werks-LEDs); Pumpenkurve und Mainboard/RAM/GPU-LEDs
bleiben bis zum nächsten Stromverlust, danach Werkszustand. Ganz entfernen: Units in `/etc/systemd/system/`
(`OpenLinkHub`, `eventline-kuehlung`, `eventline-kuehlung-boot`), `/etc/udev/rules.d/99-openlinkhub.rules`,
`/etc/tmpfiles.d/eventline-kuehlung.conf`, `/opt/OpenLinkHub`, `/opt/openrgb-1.0`, `/etc/eventline-kuehlung`,
`/var/lib/eventline-kuehlung` löschen, `userdel openlinkhub`, `apt remove liquidctl`, `systemctl daemon-reload`,
`udevadm control --reload-rules`.

## Nachtarbeit: Fristen, Rückstau ZZ, Selbsttest (Etappe 4)

Masterplan §3.5–§3.7, E4.1/E4.3/E4.4/E4.5. Code: `dienst/app/nachtarbeit.py` (Thread «ki-nacht», Kontext, Tresor,
Melde-Puffer, Trockenlauf), `dienst/app/jobs/{fristen,zz,selbsttest}.py`; `fsm.py` (`hole_kontext`,
`melde_nachtarbeit`). **Entscheid nach E2.4:** alles mit dem schnellen Modell `KI_MODELL_TEXT` (`gemma3:4b`) auf der
GPU-Instanz, ohne Denkmodus, gleiches `num_ctx` wie die Ablage (kein Neuladen); das Hauptmodell bleibt aus. E4.2
(zweiter Blick) entfällt, E4.6 (Belege) ist nicht gebaut. **E4.7 Duplikate seit 15.10.2026** als eigener Thread
`ki-doppel` (`dienst/app/duplikate.py`, ohne Modell, Schalter `KI_DOPPEL_AKTIV`, Standard 1): exakt / gleicher Inhalt in
anderer Form / neuere Fassung über das ganze NAS, nur Pfade und Werte ans FSM (`POST /api/ki/doppel`), Schwellen und
Kalibrierung im Kopf der Datei und in `docs/lokale-ki/SPEC.md` §7. `/health` → `doppel` (letzter Lauf, Dauer, Zähler
`dateien`, `mit_text`, `gruppen_exakt`, `gruppen_inhalt`, `gruppen_fassung`, gemeldet). Verschiebt und löscht nie — das
macht nur ein Mensch im FSM (Quarantäne `99_System/Duplikate/…`). Tests: `tests/test_duplikate.py`.

**Vorschaubild (Auftragsart `vorschau`, seit 15.10.2026, `dienst/app/vorschau.py`, Schalter `KI_VORSCHAU_AKTIV`, Standard 1):**
die Mini-Vorschau der NAS-Seite fragt nicht mehr die ganze Datei beim NAS-Sync an, sondern lässt das Rig die erste Seite
direkt vom NAS-Mount rendern (PDF `pdftoppm`, Bilder Pillow, Office/iWork nur mit eingebettetem Vorschaubild) — JPEG ≤ 900 px,
Qualität 70, Base64 im Ergebnis, ohne Modell und ohne GPU. Zwischenspeicher nur im Tresor (`/data/vorschau`, sha256-Schlüssel,
≤ 512 MB, nichts älter als 30 Tage). Gemessen 15.10.: Rendern PDF 90–110 ms, JPEG 130–210 ms, PNG ~0,6 s, aus dem Speicher
1–5 ms; ganzer Weg über die Warteschlange 0,7–1,9 s (vorher bis ~1 min über den NAS-Sync). Tests: `tests/test_vorschau.py`.

| Schalter (`/etc/eventline-ki/env`, Standard 0) | Wirkung |
|---|---|
| `KI_JOB_FRISTEN` | Fristen aus dem Tiefen-Index, Meldung der Liste `fristen` |
| `KI_JOB_ZZ` | Rückstau ZZ, höchstens `KI_JOB_ZZ_MAX` (200; auf dem Rig 400) Dateien je Fenster, Meldung der Liste `vorschlaege` |
| `KI_JOB_SELBSTTEST` | ab `KI_SELBSTTEST_ZEIT` (05:30) einmal je Nacht, `KI_SELBSTTEST_N` (40) Dateien × 2 Namensvarianten |
| `KI_FREI_AKTIV` | **Standard 1** (seit 15.10.): Rückstau ZZ und Fristen arbeiten, wenn der Rig frei ist — auch tagsüber; 0 = nur nachts wie bisher |
| `KI_KONTEXT_MAX_ALTER_S` | 3600 — älterer Kontext: kein Schritt |

- **Wann («Arbeiten, wenn frei», Mischa 15.10.2026):** Rückstau ZZ und Fristen sind leichte Arbeit (schnelles Modell
  auf der GPU-Instanz, dieselbe Schleuse wie die Aufträge) und laufen in **jedem** Fenster — tagsüber wie nachts —,
  sobald der Rig frei ist: kein FSM-Auftrag läuft oder wartet (20 s Pause), Vorbilder- und Tiefen-Index laufen nicht,
  das Hauptmodell ist weder geladen noch am Laden, und der Speicher ist nicht knapp (`speicher.leicht_frei`:
  MemAvailable ≥ 2 × `KI_HG_NOT_GB`, PSI full avg10 ≤ 30, im KI-Slice mindestens `KI_HG_NOT_GB` Luft; nicht lesbare
  Werte gelten nicht als Not). Das wird **vor jedem Schritt** (= eine Datei) und zwischen den Teilen eines langen
  Dokuments neu geprüft; ein wartender Auftrag (Suche, Archiv-Frage, Beleg, Ablage, Diktat) wartet also höchstens auf
  einen Modellaufruf (GPU-Schleuse), danach pausiert der Job (Grund `vorrang`/`speicher` in `/health`). **Schwere Arbeit
  bleibt nachts:** Hauptmodell (Planer, `KI_HG_TAG`) und Tiefen-Index (19:00–06:45) unverändert; der Selbsttest läuft nur
  nachts ab 05:30 (bis 06:45). Reihenfolge seit 15.10.: **ZZ → Fristen** (die Einsortier-Liste wartet auf Menschen;
  Fristen v2 rechnet vorhandene Ergebnisse neu) — vorher Fristen → ZZ. Zähler und «fertig» gelten je Fenster
  (`<Datum>/tag` 07:00–19:00, `<Datum des Abends>/nacht`); ein Fensterwechsel beendet den Durchgang, der nächste macht
  mit den übrigen Dateien weiter. Ergebnisse liegen nach jedem Schritt im Tresor (`zz_vorschlaege`/`archiv_karte`
  je Datei + Rezept) — ein Neustart oder Vorrang verliert höchstens den laufenden Schritt, nichts wird doppelt
  gerechnet oder gemeldet. `KI_FREI_AKTIV=0` (+ `$C up -d dienst`): zurück zu «nur nachts» (19:00–06:45).
- **Kontext (MP-5):** `GET /api/ki/kontext` vor jeder Job-Phase (ausser er ist < 5 min alt) und nach je 50
  Schritten; Ablage `data/dienst/nacht-kontext.json` und `fsm-ordnerliste.json` (Probelauf). Fehlt er oder ist er
  älter als 60 min: kein Schritt, nichts wird geraten.
- **Fristen (E4.3):** Vorfilter (kündbar, Kündigung, Laufzeit, gültig bis, Ablauf, Vertragsende, verlängert sich,
  Frist, zahlbar bis) → Auszüge = Abschnitte mit Treffer (höchstens 6, Grenzen wie `tiefe.zerlege`) + Kopf →
  `gemma3:4b` schemagebunden (Dokumentkarte + Bedingungen). **Prüfung gegen Erfindung:** jedes Datum (31.03.2027,
  31.3.27, 31. März 2027, 2027-03-31, March 31, 2027 …) und jede Zahl mit ihrer Einheit (Ziffer oder Zahlwort, «drei (3)
  Monate», «dreimonatig», «ein weiteres Jahr»; Monate auch als ganze Jahre; nach der Einheit nur ihre Endungen und
  eine Wortgrenze — «3 Monatsmieten», «1 Jahresbeitrag», «2 Wochenplan» belegen nichts) muss im Quellabschnitt stehen — sonst
  verworfen; Bedingungen, aus denen das FSM kein Datum rechnen kann, ebenso. Sicherheit: Wort der Art im Abschnitt =
  hoch, sonst mittel; OCR-Text eine Stufe tiefer. `partei` nur bei Organisationen, nicht personenbezogen, minimiert,
  ≤ 60 Zeichen und nur, wenn sie im Dokument steht. Das Datum rechnet das FSM (`berechneFrist`).
- **Rückstau ZZ ab Rezept `zz/v3` (15.10.2026, «Stärken verteilen», Mischa):** das Rig entscheidet den Ordner NICHT
  mehr. `jobs/zz.zz_beschreiben`: Vorbilder (bge-m3) → die lokale KI liest das GANZE Dokument in Teilen zu 10 000
  Zeichen (400 Überlapp; Teil 2… bekommt den bisherigen Beschrieb und ergänzt/korrigiert ihn; zwischen den Teilen
  Vorrang für wartende Aufträge) → `filtere_beschrieb` (deterministisch: Felder mit Betrag/Nummer/IBAN/AHV/Telefon/
  E-Mail/Adresse/Gesundheits- oder Kündigungsgrund fallen ganz weg, Zitate raus, Namen/Absender nur wenn im Dokument,
  Dateinamen oder Ablageort belegt, Datum/Status nur wenn belegt) → Fakten-Hinweise aus `ablageregeln.py` (Person aus
  Dateiname/Ablageort/Text — Namensabgleich mit Umlaut-Faltung und einem Tippfehler je Namensteil —, ob ihre
  Personalakte existiert, Location/Partner mit eigenem Ordner, Entwurf, Datum, INT-Nummer, Regel-Hinweis, ähnlichste
  Ordner nach Vorbild, Regel-Namensvorschlag) → Meldung `beschrieb`/`fakten`/`kandidaten` ans FSM. Dort entscheidet
  Claude (lib/ki/zz-entscheid), ein Mensch gibt frei. Neu gerechnet wird jede Datei ohne Eintrag dieses Rezepts im
  FSM (offene Vorschläge älterer Rezepte ersetzt das FSM). Fristen ab `fristen/v2`: alle Abschnitte mit
  Vorfilter-Treffer in Teilen zu 6 (vorher nur die ersten 6), je Teil gegen Erfindung geprüft, dann zusammengeführt.
  Die folgenden Punkte beschreiben den Stand bis zz/v2.
- **Rückstau ZZ (E4.4, bis zz/v2):** jede Datei unter `ZZ_*` einmal (je sha256 + Rezept), Text aus `archiv_text`, Kern wie
  `ablage_analyse` (Vorbilder → Stufe 1 → Rangliste → Stufe 2 unter den besten 5). Ziele nur aus der aktiven Liste,
  nie `ZZ_*` (jede Tiefe), nie `99_System`, nie der Ist-Ordner. Sicherheit: Regel = hoch (`regel`); Modell wählt
  Platz 1 der Rangliste = hoch (`vorbild`); Platz 2–3 mittel, 4–5 niedrig (`modell`); ohne lesbaren Text höchstens
  niedrig. **Seit Rezept `zz/v2` (14.10.) gedeckelt durch `ordnerwahl.evidenz()`:** ohne Vorbild mit Ähnlichkeit
  ≥ 0,80 im Zielordner höchstens niedrig, 0,80–0,85 höchstens mittel (Regel-Bereich mittel); `vorbild` nur bei Platz 1
  und Sicherheit über niedrig. Kein Ziel (Modell wählt keinen, Stufe 2 scheitert) → keine Meldung, Zeile `kein_ziel` im Tresor.
  Begründung = minimierte Einordnung `was` (≤ 120), bei personenbezogenen Dokumenten und Personal-Ordnern keine.
  Pfade mit offenem/angenommenem Vorschlag im Kontext werden übersprungen — auch nach einem Rezeptwechsel; neu
  gerechnet wird eine Datei erst, wenn ihr Vorschlag im FSM entschieden (abgelehnt) ist.

**Befund und Fix 14.10.2026 (Rückstau ZZ, SCALA-Entwürfe als Sammelbecken):** 78 der 282 offenen Vorschläge zielten
auf `02_LOCATIONS/002506_SCALA_BASEL/02_Verwaltungsvertraege/01_Entwuerfe` (77 «hoch»), 74 ohne SCALA-Bezug im Namen.
Ursache (Diagnose im Container, nur Zahlen): (1) dort liegen 5 Dateien + 2 in `Historie` = 3 Dokumente als docx+pdf
und Versionen — jede Fassung stimmte einzeln; (2) die Stimmen waren nur relativ (Summe 1): die ZZ-Dateien haben kaum
ähnliche Vorbilder (stärkste Ähnlichkeit Median 0,68, 75 % unter 0,75), trotzdem bekam der «am wenigsten unähnliche»
Ordner die volle Masse plus Kategorie-Zuschlag und Übertrag von den Entwurfsordnern der anderen Locations; (3) «hoch»
hiess nur «Modell wählt Platz 1», was gemma3:4b fast immer tut. Fix in `ordnerwahl.py`: Fast-Zwillinge (Kosinus > 0,95
oder gleicher Namensstamm) stimmen je Ordner einmal; `evidenz()` deckelt die Sicherheit (ZZ). Leave-one-out der
Rangliste ohne KI (92 Dateien der aktiven Ordner, Zwillinge ausgeschlossen): Top-1 48,9 → 50,0 % (neutral 35,9 →
34,8 %), Top-3 73,9 → 78,3 % (neutral 59,8 → 62,0 %); Evidenz-Klassen treffen hoch 73 % / mittel 50 % / niedrig 32 %
(neutral 69 / 38 / 13 %). Selbsttest Seed 20261013 (40 Dateien, mit gemma3:4b) Top-1 / Top-3 vorher 55 / 65 %,
nachher 55 / 75 % (neutral 40 / 50 → 37,5 / 52,5 %), Build 20261015-0741.
**Verworfen:** Stimmen-Masse nach stärkster Ähnlichkeit (0,60 → 0,1, 0,85 → 1) — senkte den Selbsttest auf 47,5 / 57,5 %
(neutral 35 / 50 %), weil Ordnernamen mit «EVENTLINE GmbH» (Datenschutzkonzept) jedem Firmendokument nah sind und
das neue Sammelbecken wurden. Folge: auf den 282 ZZ-Dateien steht SCALA-Entwürfe weiter 74× auf Platz 1, aber 72× als
«unsicher» (Evidenz gesamt 49 hoch / 233 niedrig); die 2 «hoch» haben ein Vorbild ≥ 0,97 dort.
- **Melden (MP-6):** Puffer = Zeilen ohne `gemeldet_at` in `zz_vorschlaege`/`archiv_fristen` (Tresor, höchstens 2000 —
  dann ruhen die Jobs), gemeldet zu Beginn jeder Runde (30 s) und seit 15.10. während eines langen Durchgangs alle 25
  Schritte (`MELDEN_ALLE_SCHRITTE`, sonst sah das FSM die ersten Ergebnisse erst am Ende des Durchgangs), Pakete ≤ 200,
  Backoff 30 s → 15 min bei Netz, 5xx und jedem 4xx ausser 400/413/422
  (auch 403/404/405/409 — z. B. Route nach einem Rollback kurz weg: der Puffer bleibt), auch tagsüber. `gemeldet_at` +
  `ergebnis` (`ok` oder Grund des FSM) für angenommene, doppelte und abgewiesene; nur 400/413/422 (Form/Grösse,
  erneutes Senden hilft nicht) → `http_4xx`.
- **Selbsttest (E4.5):** Stichprobe aus dem Vorbilder-Index (Seed = Datum der Nacht, nur aktive Ordner), echte
  `ablage_analyse` je Datei mit Original- und neutralem Namen, die Datei und ihre Fast-Zwillinge sind kein Vorbild;
  dazu Egress: `api.anthropic.com` über den Proxy und direkt muss scheitern. Nur Kennzahlen in `/health` und
  `selbsttest_laeufe` (90 Tage).
- **Tresor-Tabellen** (beim ersten Start mit Schalter angelegt): `archiv_karte` (je Datei: Status, Typ, Datum,
  Partei, personenbezogen), `archiv_fristen` (`UNIQUE(pfad, art, bedingungen)`), `zz_vorschlaege`
  (`UNIQUE(pfad, sha256, rezept)`), `selbsttest_laeufe`. Fehlerhafte Schritte werden in späteren Nächten höchstens
  3× wiederholt.
- **`/health` → `nachtarbeit`:** Schalter, `laeuft`, `grund` (tag, vorarbeit, vorrang, kein_kontext, puffer_voll,
  `fristen:fertig` …), Kontext-Alter, Stand der Nacht mit Zählern, Puffer, Meldungen, Tresor-Zähler, letzter
  Selbsttest — nur Zahlen. Neu auf oberster Ebene: `laeuft` (Art des FSM-Auftrags in Arbeit).

**Trockenlauf** (sofort, ohne Nachtfenster, nichts ans FSM — nur `GET /api/ki/kontext` —, nichts in die
Nachtarbeit-Tabellen; Schalter nur für diesen Prozess; wartet, solange der Dienst einen Auftrag hat):

```bash
docker exec -e KI_JOB_FRISTEN=1 -e KI_JOB_ZZ=1 -e KI_JOB_SELBSTTEST=1 eventline-ki-dienst \
  python -m app.nachtarbeit trocken [--zz-max 200] [--fristen-max 0] [--ohne-selbsttest]
```

**Tests ohne Netz:** `tests/test_fristen_zz.py`, `tests/test_nachtarbeit.py`; das SQL `tests/test_nachtarbeit_db.py`
gegen eine Wegwerf-Datenbank (Anleitung im Kopf der Datei).

**Trockenlauf 12.10.2026 tagsüber (Build `20261012-1230`/`-1308`, nur Zahlen, nichts ans FSM, Kontext 363 Ordner):**
- **Fristen** (395 Dateien mit Text, 3 min): 322 ohne Vorfilter-Treffer, 73 ans Modell (Median 1,9 s) → 82 Fristen roh →
  **28 angenommen in 26 Dateien** (17 hoch, 11 mittel; Kündigung 10, Ablauf 10, Zahlung 5, Vertragsende 2, sonstige 1),
  verworfen: 37 erfunden (Datum/Zahl nicht im Abschnitt), 10 leer, 6 Zahl ausserhalb des Rahmens, 1 unvollständig;
  12 Datumsfelder unlesbar (als «nicht angegeben» gewertet). Partei bei 41 von 73 Karten, 24 personenbezogen.
  (Erster Lauf mit Build `-1230`: 23 angenommen, 30 «ungültig» — Modell schrieb Daten als 31.12.2026; seit `-1308`
  gelesen, die Prüfung gegen den Text bleibt.)
- **Rückstau ZZ** (Grenze 200 erreicht, 13 min, Median 3,9 s): 200 Vorschläge — hoch 118, mittel 31, niedrig 51
  (32 Dateien ohne Text); Quelle vorbild 148 / modell 52 / regel 0; 149 mit Begründung, 51 personenbezogen (ohne);
  alle mit Alternativen. Kein «kein Ziel» — gemma3:4b wählt praktisch immer einen Kandidaten. Behoben im Lauf:
  Dateien, deren *Name* mit `ZZ_` beginnt, in normalen Ordnern zählten als Rückstau (jetzt nur der Ordner).
- **Selbsttest** (40 Dateien × 2, 12 min): einsortiert Top-1 60 %, Top-3 75 %, Kategorie 80 %; neutral 50 / 72,5 / 70 %;
  0 Fehler, Median 4,4 s. Egress: `api.anthropic.com` über den Proxy abgewiesen, direkt `ConnectError`, FSM über
  den Proxy HTTP 200.
- **Lesart (bis 14.10., Rezept zz/v1):** «hoch» bei ZZ hiess «Modell und Rangliste einig» (Vertrag) — die Ordnerwahl trifft im Selbsttest in
  60 % den richtigen Ordner (Top-3 75 %); die Bestätigung im FSM bleibt nötig.

## Rückfall auf den vorherigen Build

`install.sh` sichert vor jedem Bau den laufenden Stand als `eventline-ki/dienst:vorher` und
`eventline-ki/caddy:vorher`. Zurück (ohne neu zu bauen):

```bash
docker tag eventline-ki/dienst:vorher eventline-ki/dienst:local
$C up -d --no-build dienst
```

Neue Funktionen stehen hinter Schaltern (`KI_HG_*`, `KI_TIEFE_AKTIV`, `KI_SUCHE_AKTIV`, `KI_ARCHIV_FRAGE_AKTIV`,
`KI_LERNEN_AKTIV`, `KI_JOB_*`, Standard im Code 0; auf dem Rig an: `KI_TIEFE_AKTIV`, seit 12.10. 07:49 auch `KI_SUCHE_AKTIV` und
`KI_ARCHIV_FRAGE_AKTIV`): meist reicht Schalter auf 0 und `$C up -d dienst`.

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
$C exec db psql -U eventline -d eventline_ki -c "select zeit, art, quelle, dauer_ms, modell, ok, fehler, seiten, zeichen, gescannt, teile from ki_protokoll order by zeit desc limit 20"
```

Das Protokoll enthält nur Metadaten (Zeit, Art, Dauer, Modell, ok/Fehlertext; seit 15.10. bei Aufträgen mit Dokument
Seiten, Zeichen, gescannt, Teile) — nie Inhalte.

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
