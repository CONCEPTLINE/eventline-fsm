# EVENTLINE Lokale KI — Spezifikation v1.1 (2026-10-02, nachgeführt 2026-10-11)

Entscheid Mischa/Leo 2026-10-02: Vertrauliche Dokumente werden nur noch von einer
**lokalen KI auf dem Rig im EVENTLINE-Büro** verarbeitet. Nichts davon geht an einen
KI-Anbieter. Claude bleibt für Nicht-Vertrauliches (Auftrags-Eingang, Code, Layouts).

Diese Datei ist der **Vertrag** zwischen allen Teilen (Rig, KI-Dienst, FSM). Wer etwas
baut, hält sich daran; Abweichungen werden hier zuerst eingetragen. Was seit dem ersten
Deploy (2026-10-02) entschieden oder geändert wurde, ist in §2–§5 eingearbeitet und in §7
als Protokoll festgehalten (Vertragspunkte V1–V7, Modellentscheid, Betrieb, offene Punkte).

## 1. Grundsätze

1. **Dokument-Inhalte verlassen das Haus nie.** Weg: Browser/NAS → Supabase-Bucket
   (nur Transit, wie heute bei der Ablage) → KI-Dienst im Büro → Ergebnis (Name, Ordner,
   Frist, Kennzahlen) zurück ans FSM. Bucket-Objekte werden nach der Verarbeitung gelöscht.
2. **Archiv-Antworten gehen direkt vom Rig in den Browser** (Büro-Netz oder VPN), nie
   über Vercel/Supabase. Nicht erreichbar = Funktion zeigt das an, bricht nichts.
3. **Abschottung auf dem Rig:** eigener Linux-Benutzer, verschlüsseltes Laufwerk,
   KI-Container ohne Internet (nur ein Ausgangs-Proxy mit Erlaubnisliste: Supabase +
   FSM), kein Zugriff für Atlas/Hermes, Zugriffs-Protokoll (auditd) auf den Daten.
4. **Atmen:** Modell wird nur bei Arbeit geladen (5 min Leerlauf → entladen), KI-Container
   mit höherem CPU-Gewicht, Arbeitsspeicher-Deckel; Schwarm läuft weiter.
5. **Fallback immer:** Ist die KI offline, funktioniert alles wie heute (Beschrieb tippen,
   Claude für Belege, Browser-Diktat). Nie stiller Fehlschlag — immer Hinweis in der UI.
6. **Secret-Werte** nie in Chat, Logs oder Commits. Quelle: `projects\_secrets\eventline-ki.txt`.

## 2. Komponenten

### 2.1 Rig (Büro, `ssh rig`, 192.168.1.128, Ubuntu 24.04, RTX 3070 8 GB, 46 GB Arbeitsspeicher)

Arbeitsspeicher seit 2026-10-11: 2 × 16 + 2 × 8 GB, alle Riegel mit 2133 statt 2666 MT/s (gemischte Bestückung).
Zeitmessungen vor diesem Umbau sind mit späteren nicht vergleichbar.

| Teil | Festlegung |
|---|---|
| Benutzer | `eventline-ki` (uid/gid 1500, kein Login-Shell), Gruppe `eventline-ki` |
| Verzeichnisse | `/srv/eventline-ki/data` (LUKS-Mount, 1500:1500 0700), `/srv/eventline-ki/repo` (Checkout von `rig/eventline-ki/` aus dem FSM-Repo), `/etc/eventline-ki/` (root 0700: `env` (0600), `caddy.env`, `vault.key`, `nas.cred`) |
| Tresor | LUKS2-Datei `/var/lib/eventline-ki/vault.img` (200 GB sparse), Keyfile `/etc/eventline-ki/vault.key`; `eventline-ki-vault.service` (cryptsetup open + mount, `Before=docker.service`, `RequiredBy` der Compose-Unit). Tresor-Schlüssel zusätzlich im zentralen Token-Register (`projects\_secrets\`) gesichert (2026-10-03) — Wert nie hier |
| Compose | Projekt `eventline-ki`, Datei `rig/eventline-ki/docker-compose.yml`; Netze `ki-intern` (`internal: true`) und `ki-egress` (bridge). Entschieden: `dienst` hängt **nur** in `ki-intern`; nur `egress` und `caddy` in beiden Netzen. GPU per CDI (`nvidia.com/gpu=all`) mit `capabilities: [gpu]` (vom Compose-Schema v5 verlangt, bei CDI ohne Wirkung). **Images gepinnt** seit 2026-10-02 (`ollama/ollama:0.35.1`, whisper und squid per Digest); Update = bewusst ändern, `install.sh`, §5 wiederholen. Konfig-**Verzeichnisse** (`./egress`, `./caddy`) statt Einzeldateien gemountet (Einzeldatei-Mount zeigte nach einem Update den alten Inode → `reconfigure`/`reload` las die alte Fassung). Env-Änderung wirkt erst mit `docker compose … up -d dienst` — `restart dienst` liest `/etc/eventline-ki/env` **nicht** neu (gemessen 2026-10-03) |
| Unit | `eventline-ki.service` (oneshot, `RemainAfterExit`): `Wants`/`After` `nvidia-cdi-refresh.service` (die CDI-Spezifikation liegt im tmpfs und entsteht bei jedem Booten neu — startet der Stack vorher, finden die Container die GPU nicht); `ExecStartPre` erzeugt `/var/run/cdi/nvidia.yaml` nur, wenn weder dort noch unter `/etc/cdi/` eine liegt; `AssertPathIsMountPoint=/srv/eventline-ki/data`; `Restart=on-failure`, `RestartSec=30`, `TimeoutStartSec=900` |
| `ollama` | `ollama/ollama:0.35.1`, GPU per CDI, `OLLAMA_KEEP_ALIVE=5m`, `OLLAMA_MAX_LOADED_MODELS=2` (seit 2026-10-04/11: Sprachmodell + Einbettungsmodell `bge-m3` bleiben zusammen geladen; mit 1 lud jede Ablage zweimal um), `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0` (KV-Cache in 8 statt 16 bit, halbiert den Cache, Qualitätsverlust nicht messbar), Volume `data/ollama`, nur `ki-intern`, mem_limit 12g (8g: memcg-OOM beim Modellwechsel — mmap-Seitencache zählt im cgroup mit, 2026-10-02). **Kontextfenster:** Ablage `KI_LLM_NUM_CTX` 8192 — seit der Ordnerwahl nach Vorbild steht keine Ordnerliste mehr im Prompt, das Fenster bleibt bei 8192 (wächst nur noch bei riesigen Mitarbeiterlisten in 4096er-Stufen; ohne das kürzt Ollama still auf die Hälfte: gemessen 9261 Tokens bei 8192 → 4098, Regeln weg); Bild `KI_BILD_NUM_CTX` **8192** (env, seit 2026-10-11) — gleiches Fenster für Beleg und Ablage, denn ein Fensterwechsel 8192 ↔ 16384 lädt dasselbe Modell neu (3,3–5,0 s gemessen), gleiches Fenster 2 ms |
| `whisper` | `fedirz/faster-whisper-server:latest-cuda` (Digest gepinnt, Stand Okt 2024; Projekt heisst heute «speaches»), OpenAI-kompatibel `/v1/audio/transcriptions`, Modell `Systran/faster-whisper-medium` (Kandidat `deepdml/faster-whisper-large-v3-turbo-ct2` offen), `WHISPER__TTL=300`, `HF_HUB_OFFLINE=1`, Start `uv run --no-sync` (ohne Internet kein Sync → Crash-Schleife), GPU, nur `ki-intern`, mem_limit 8g (4g: OOM beim Laden, 2026-10-02; gemessen 2026-10-03 Peak 1564 MiB, oom_kill 0). Erkennung mit Silero-VAD (`vad_filter`), Segmente mit `no_speech_prob` > 0,6 werden verworfen → Stille ergibt leeren Text statt eines erfundenen Satzes. **Entladen nur per TTL:** `DELETE /api/ps/<modell>` verklemmt diese Server-Version dauerhaft (Deadlock im Modell-Manager, Aufruf kehrt nie zurück, jede weitere Erkennung hängt bis zum Container-Neustart, Healthcheck bleibt grün — reproduziert 2026-10-03); der Dienst ruft es nie auf |
| `db` | `pgvector/pgvector:pg16`, Volume `data/pg`, nur `ki-intern`, mem_limit 2g, Passwort aus env |
| `egress` | Squid (`ubuntu/squid`, Digest gepinnt) mit Erlaubnisliste **nur** CONNECT:443 zu exakt `uxtotpniwbwyoznwkygd.supabase.co` und `eventline-fsm-usyk.vercel.app` (kein `*.supabase.co` — die signierten Storage-URLs liegen auf demselben Host; so auch kein fremdes Supabase-Projekt); beide Netze; alles andere → 403. Protokoll (nur Host + Status) in Datei `/var/log/squid/` — Squid läuft als `proxy` und darf das stdout des Containers nicht öffnen —, der Entrypoint spiegelt nach stdout, tägliche Rotation (`logfile_rotate 1`, `squid -k rotate` aus Compose) |
| `dienst` | Build `rig/eventline-ki/dienst/` (Python 3.12, FastAPI/uvicorn, Port 8700), `HTTPS_PROXY`/`HTTP_PROXY=http://egress:3128`, `NO_PROXY=ollama,whisper,db,localhost,127.0.0.1`, uid 1500, **nur `ki-intern`**, `read_only` Dateisystem, `/tmp` als tmpfs 256 MB, `TMPDIR=/data/tmp` (Tresor), Mounts `data/dienst` (rw), `/mnt/eventline-nas` (ro), `./probelauf` (ro); mem_limit 4g; GPU nur für `nvidia-smi` (Name + freier VRAM in `/health` und Herzschlag) |
| `caddy` | Eigenbau `caddy:2-builder` + `github.com/caddy-dns/cloudflare`; Host-Ports 192.168.1.128:443, 10.9.0.2:443 und 127.0.0.1:443; `ki.in.eventline-basel.com` → `reverse_proxy dienst:8700` (`flush_interval -1` für SSE); `request_body max_size 1MB` (nur Archiv-Fragen — Dateien und Diktate laufen über die Warteschlange); Zertifikat per DNS-01 (Cloudflare-Token aus `caddy.env`); Verzeichnis-Mount `./caddy`; beide Netze |
| CPU/RAM | Compose `cpu_shares: 2048` für `dienst`/`ollama`/`whisper` = cgroup-v2 `cpu.weight` **174 gegenüber 100** beim Schwarm und allen anderen Containern (gemessen auf dem Rig, Docker 29.8/runc mit quadratischer Umrechnung; die ältere lineare Umrechnung ergäbe nur 79 → nach einem Runtime-Wechsel nachmessen: `cat /sys/fs/cgroup/system.slice/docker-<id>.scope/cpu.weight`); mem_limits s. o.; Schwarm behält MemoryMax 16G |
| auditd | Lesezugriffe fremder Benutzer (uid ≠ 1500/999, z. B. root/mischa) auf `data/dokumente` **und** `data/dienst` (TMPDIR mit Downloads, OCR-Zwischenständen, Diktat-Audio), Key `eventline_ki_zugriff`; Regeln `rig/eventline-ki/audit/eventline-ki.rules`, nach dem Einhängen des Tresors neu geladen; auswerten `ausearch -k eventline_ki_zugriff` |
| NAS | CIFS read-only, NAS-Benutzer `eventline-ki` (**nur lesen**), **10 Freigaben** unter `/mnt/eventline-nas/<Freigabe>` (`Elements` ausgeschlossen), `credentials=/etc/eventline-ki/nas.cred`, `uid=1500,gid=1500,ro,noexec` — eingerichtet 2026-10-03, damit ist der Phase-1-Probelauf möglich |
| DNS / Erreichbarkeit | Cloudflare-Zone eventline-basel.com, nur Subdomain `in.`: A `ki.in.eventline-basel.com` → 192.168.1.128 (nicht proxied). **Im Büro-Netz nicht auflösbar:** der Router (192.168.1.1) filtert per DNS-Rebind-Schutz öffentliche Namen auf private Adressen (`dig @1.1.1.1` liefert die Adresse, der Browser «Server nicht gefunden») → Ausnahme im Router offen; der Rig selbst hat einen `/etc/hosts`-Eintrag. Folge: Diktat über die Warteschlange (V4), Direkt-API nur fürs Archiv (V6). Rig-Adresse kommt per DHCP (MAC `b4:2e:99:fe:47:1a`) — Caddy bindet fest an 192.168.1.128, **DHCP-Reservierung offen** (Mischa) |

**Modelle (Entscheid 2026-10-03):** Text **und** Bild `gemma3:4b` (`KI_MODELL_TEXT` = `KI_MODELL_BILD`
in `/etc/eventline-ki/env`), Einbettungen `bge-m3` (Phase 3), Whisper `Systran/faster-whisper-medium`.
Pflicht war: Modell muss bei Belegen **und** Ablage zu 100 % in der GPU rechnen (sonst lagert
llama.cpp Schichten auf die CPU aus, Faktor 10–20 langsamer). Vergleich mit korrektem Fenster
(ctx 16384, 365 Ordner, 25 Mitarbeiter, 3 synthetische 2-Seiten-PDFs, 21 Felder):

| Modell | Felder | Ordner | GPU | Ablage warm Ø | Ergebnis |
|---|---|---|---|---|---|
| `qwen3:8b` | 17/21 | 2/3 | 92 % (6,22 GiB, 1073 MiB frei) | 19,3 s | beste Qualität, scheitert an der 100-%-Pflicht |
| `gemma3:4b` | 15/21 | 0/3 (einmal falsche Person) | 100 %, 3273 MiB frei | 9,9 s | **gewählt** — einziges Modell, das Belege 9/9 und Ablage ganz in der GPU schafft |
| `qwen2.5vl:3b` | 15/21 | 0/3 | 100 % | 4,5 s | gleiche Trefferzahl, kein Vorteil; zweites Modell = Modellwechsel |
| `qwen2.5vl:7b` | — | — | 73 % | — | ausgeschieden (VRAM) |

Beleg mit `gemma3:4b`: 9/9, kalt 4,2 s, warm Ø 1,6 s, `ollama ps` 100 % GPU, nach 321 s entladen
(VRAM danach 875 MiB belegt). Ein Modell für beides spart den Modellwechsel; mit `gemma3:4b` passen
Whisper (~2,0 GB) + Modell + Schwarm gleichzeitig in die 8 GB. Code-Standardwerte (`config.py`,
Compose-Profil `modelle`) sind seit 2026-10-03 ebenfalls `gemma3:4b`/`bge-m3`.

**Entscheid bestätigt 2026-10-11 (Ordnerwahl nach Vorbild, Kandidaten-Entscheid):** `qwen3:8b` wäre
nur zulässig gewesen, wenn es beim Kandidaten-Entscheid (ctx 8192) zu 100 % in die GPU passt — mit
geladenem Whisper und Schwarm, > 500 MiB Reserve — und der Wechsel Beleg ↔ Ablage unter 6 s bleibt.
Gemessen (Schwarm 914 MiB): allein 100 % GPU mit 1182 MiB frei, aber mit `bge-m3` nicht gemeinsam
ladbar (Ollama wirft es hinaus → je Ablage zwei Neuladungen 2,7–6,4 s + 3,0–4,5 s, KV-Cache weg),
Wechsel zu `gemma3:4b` (Beleg) 6,1–10,4 s, mit geladenem Whisper nur 61 % in der GPU (Laden 12,7 s).
Qualitätsgewinn laut Labor nur +1 bis +3 Punkte Top-1. `gemma3:4b`: 100 % GPU, mit `bge-m3` zusammen
geladen (2179 MiB frei), mit Whisper 100 % GPU (1024 MiB frei; `bge-m3` dann nur noch zu 6 % in der
GPU → der Dienst entlädt das Sprachmodell vor der Einbettung, `KI_EMBED_MIN_FREI_MB`). Tabelle:
`rig/eventline-ki/README.md` «VRAM und Modellwechsel».

### 2.2 KI-Dienst (`rig/eventline-ki/dienst/`, Python)

Aufgaben:
1. **Warteschlange** (`/api/ki/sync` auf dem FSM, Bearer `KI_SYNC_TOKEN`): alle 2 s
   abholen (bei Arbeit sofort erneut), **ein Auftrag pro Abholung** (V2 — der Dienst
   arbeitet seriell, ein zweiter beanspruchter Auftrag läge nur herum), Ergebnis posten,
   Herzschlag mit jedem Poll; **während ein Auftrag läuft, alle 20 s zusätzlich
   `?nur_herzschlag=1` aus einem eigenen Thread** (V1), damit lange Aufträge die KI nicht
   «offline» wirken lassen. FSM-Fehler → Backoff bis 30 s; nicht zustellbare Ergebnisse
   werden nachgemeldet (max 50 gepuffert); Dateireste im Tresor nach 1 h gelöscht.
   Verarbeitung je `art`:
   - `ablage_analyse`: Datei per signierter URL laden → Text (PDF-Text, sonst OCR
     Tesseract deu+eng; DOCX/XLSX/TXT; Bilder: OCR + Bildmodell) → Sprachmodell
     (strukturierte JSON-Antwort per Ollama `format`, Feldgrenzen als `maxLength` im
     Schema, Zusammenfassung auf ganze Sätze gekürzt, Nachprüfung `pruefe_ergebnis` mit
     denselben Grenzen; Kontextfenster s. §2.1 `ollama`) → Ergebnis (siehe 3.1).
     **Ordnerwahl nach Vorbild (seit 2026-10-11, Build `20261011-1048`; ersetzt die zweistufige
     Wahl aus der ganzen Ordnerliste vom 2026-10-03, die live-nah nur 15 %/43 % traf):**
     Einbettung `bge-m3` aus Dateiname + Textanfang → die 15 ähnlichsten einsortierten Dateien aus
     dem **Archiv-Index** (`archiv_dateien`, pgvector im db-Container, nur Ordner der FSM-Liste) →
     Stufe 1 (alle Felder ausser Ordner, Prompt ohne Ordnerliste, statischer Anfang = KV-Cache) →
     **Rangliste** (`ordnerwahl.py`, deterministisch): Regeln zuerst (INT-Nummer **mit «INT»** im
     Dateinamen → Projektordner, eindeutig = entschieden; die blosse Form «26-014» ohne «INT» ist nur
     ein Zuschlag wie «INT-…» im Text, nie ein Entscheid; erkannte Person → nur ihre Personalakte, alle
     Namensteile gleich, auch kurze; im erkannten Regel-Bereich hat jeder Unterordner einen Sockel
     `REGEL/2`, damit auch Scans ohne Text Kandidaten haben; **`ZZ_*` auf jeder Tiefe nie Kandidat,
     nie Ziel eines `neuer_ordner`** — Hauskonvention für Altes/Archiv, die FSM-Liste filtert nicht
     nach Namen), dann Stimmen
     der Nachbarn, gleichnamige Unterordner anderer Entitäten, Kategorie-Summe, Ordnernamen
     (seltene Pfad-Wörter, Einbettung Dokument ↔ Pfad), Dokumenttyp-Zuschlag → Stufe 2: das Modell
     wählt unter den besten **5 Kandidaten** (volle Pfade + Dateinamen der Vorbilder, Schema-Enum)
     oder `""` (→ `ordner null`, ggf. `neuer_ordner`); derselbe Prompt plus Anhang. «token repeat
     limit» → zweiter Versuch mit wenig Zufall, sonst bester Kandidat. `ordner_alternativen` = zwei
     nächstbeste gültige Pfade (3.1). Bild ohne lesbaren Text → `typ sonstiges` fest, Ordner nur bei
     klarem Dateinamen/Vorbild. Alles strikt gegen die FSM-Liste geprüft. Knapper VRAM (Whisper
     noch geladen): Sprachmodell vor der Einbettung entladen (`KI_EMBED_MIN_FREI_MB`). Verworfen
     nach Messung (2026-10-03/04): Baum mit Kurz-IDs (oberste Ebene 94 % → 77 %), eine Stufe mit
     allen Blattordnern (10 % exakt), zweistufig Kategorie → Blatt (15 %/43 % live-nah), 8 statt 5
     Kandidaten (Ziel häufiger dabei, Top-1 nicht besser), `qwen3:8b` (VRAM/Modellwechsel, §2.1).
     Ablauf, Betrieb des Index und Messwerte: `rig/eventline-ki/README.md` «Ordnerwahl».
   - `beleg_analyse` / `warenkorb_analyse`: Bild → Bildmodell → JSON wie heute (3.2/3.3).
   - `diktat` (V3): Aufnahme (audio/*, ≤ 10 MB) per signierter URL → ffmpeg 16 kHz
     Mono-WAV → Whisper (de, VAD, Segmente mit `no_speech_prob` > 0,6 verworfen) →
     `{ text, dauer_ms }` (3.4). Vor dem Diktat wird das Sprachmodell entladen, wenn
     weniger als 2000 MB VRAM frei sind (`KI_WHISPER_MIN_FREI_MB`); Sprachmodell und
     Whisper rechnen nie gleichzeitig (Schleuse). Whisper selbst wird **nie** per API
     entladen (Deadlock, §2.1) — sein TTL räumt den VRAM.
   - **Archiv-Index für die Ordnerwahl (live seit 2026-10-11, kein Auftrag des FSM, eigener
     Thread `ki-archiv`):** NAS-Mount (read-only) durchgehen, je Datei Pfad, Ordner, Name, Grösse,
     mtime, sha256, Rezept und **eine** Einbettung (`bge-m3`, Dateiname + 2000 Zeichen Textanfang)
     in `archiv_dateien`; Ordnerpfade in `archiv_ordner`; **nie Text**. Lauf beim Start
     (`KI_INDEX_START_S` 120 s, sobald 20 s kein Auftrag lief) und nachts ab `KI_INDEX_NACHT`
     (02:30 Europe/Zurich, Fenster 4 h als Zeitdifferenz, auch über Mitternacht); inkrementell
     (Grösse+mtime gleich → nichts; gleicher sha256 anderswo → Einbettung übernommen; sonst Text mit
     höchstens `KI_INDEX_OCR_SEITEN` OCR-Seiten + Einbettung, davor derselbe VRAM-Schritt wie in der
     Ablage). **Verschwundenes wird nur bei vollständigem Durchgang entfernt:** jede Freigabe ist ein
     eigener CIFS-Mount unter einem normalen Ordner; nicht eingehängt/leer/unlesbar = «unvollständig» →
     für diese Freigabe nichts entfernt, Lauf unterbrochen, neuer Versuch nach 10 min; Bremse bei
     ≥ 50 % Schwund; Start erst, wenn eine Freigabe lesbar ist; Unit `Wants/After
     eventline-ki-nas.service`, Bind-Mount `rslave`. Nie `ZZ_*` (jede Tiefe), `99_System`, versteckte
     Einträge; inaktive Ordner zählen bei der Wahl nicht (FSM-Liste). Aufträge haben Vorrang: der Lauf
     wartet vor jeder Datei und Einbettung, bis der Worker ruht, nice 15. Status in `/health`
     (`archiv`, inkl. `freigaben_unvollstaendig`). Tabellen idempotent beim ersten Zugriff angelegt.
     Die FSM-Ordnerliste eines Ablage-Auftrags legt der Dienst bei Änderung als
     `<KI_DATA_DIR>/fsm-ordnerliste.json` (nur Pfade, Tresor) ab — Messgrundlage für den Probelauf.
   - `archiv_index` als Volltext/Abschnitts-Index für «Frag das Archiv» (Phase 3): Abschnitte
     (~800 Zeichen, 120 Überlappung) → Einbettungen → `db` (pgvector) + Volltext (`german`) — offen.
   - `zz_einsortieren` (Phase 3): für Dateien unter gegebenen Pfaden Zielordner + Name
     vorschlagen (Ordnerliste + Inhalt) → Vorschläge ans FSM.
   - `fristen_scan` (Phase 3): aus indexierten Dokumenten Fristen (Kündigung, Ablauf,
     Vertragsende) → Vorschläge ans FSM.
2. **Direkt-API** (über Caddy, HTTPS, CORS nur `KI_CORS_ORIGINS`) — **nur noch fürs Archiv**
   (V6, Phase 3). `POST /v1/diktat` ist **entfernt**: das Diktat läuft über die Warteschlange
   (`/api/ki/diktat`), weil die Direktadresse im Büro-Netz nicht auflösbar (DNS-Rebind-Schutz,
   §2.1) und unterwegs ohnehin nicht erreichbar ist.
   - `GET /health` → `{ ok, version, modell, gpu: {name, frei_mb}, warteschlange,
     archiv: { aktiv, anzahl, letzter_lauf, laeuft, letzte_bilanz } }` (ohne Auth, keine
     Geheimnisse; `archiv` seit 2026-10-11 = Stand des Vorbilder-Index, nur Zähler/Zeiten).
   - `POST /v1/archiv/frage` (`{ frage }`, ticket scope=archiv) → SSE: `{delta}` …
     `{done, quellen: [{pfad, name, auszug, seite?}]}`; Antwort nur aus Fundstellen,
     sonst «Dazu finde ich im Archiv nichts». Bis Phase 3: 503 «Archiv-Index folgt in
     Phase 3», falsches/abgelaufenes Ticket 401.
3. **Protokoll** (lokale Tabelle `ki_protokoll`): Zeit, Art, Quelle (fsm|direkt), Dauer,
   Modell, ok/fehler — keine Inhalte. Ans FSM gehen nur Kennzahlen.

Tickets (geteiltes Geheimnis `KI_TICKET_SECRET`): `v1.<base64url(json)>.<hex hmac-sha256>`
mit `json = { sub, scope: "archiv", exp: unix }` — **Scope nur noch `archiv`** (V6); 10 Minuten
gültig; Rig prüft Signatur + Ablauf + Scope.

### 2.3 FSM (Next.js auf Vercel, Supabase)

**Migration 288:**
- `ki_auftraege(id uuid pk, art text, status text 'offen'|'laeuft'|'fertig'|'fehler',
  payload jsonb, ergebnis jsonb, fehler text, versuche int default 0, created_by uuid,
  created_at, started_at, finished_at)`; Index `(status, created_at)`; RLS: select nur
  eigene Zeilen oder Admin; insert/update/delete nur Service-Role.
- `ki_status(id int pk default 1, online_seit, letzter_poll, version, modell, gpu jsonb,
  warteschlange int, letzter_fehler text)`; RLS: select für interne Mitarbeiter.

**Lib `src/lib/ki/`:** `typen.ts` (KiArt inkl. `diktat`, Payload-/Ergebnis-Typen aus Abschnitt 3,
`KiTicketScope = "archiv"`), `queue.ts` (`speichereKiTmp`, `erstelleKiAuftrag`,
`warteAufErgebnis(id, timeoutMs)`, `loescheKiAuftrag`, `loescheKiTmp`, `kiOnline()` =
letzter_poll < 90 s, `raeumeKiAuf()`), `ticket.ts` (HMAC erzeugen), `konstanten.ts`
(`KI_ARTEN`, `KI_SYNC_BATCH = 1`, `KI_HAENGT_NACH_MS` = 20 min, Timeouts Beleg 90 s /
Ablage 180 s / Diktat 60 s, Housekeeping-Fristen 1 h / 24 h / 30 Tage, Diktat ≤ 10 MB /
20 000 Zeichen, Bucket `nas-ablage`, Tmp-Präfix `ki-tmp/`).

**Routen:**
- `GET /api/ki/sync` (Bearer `KI_SYNC_TOKEN`, timing-safe, Muster `/api/ablage/sync`; ohne
  konfiguriertes Secret 503): Herzschlag in `ki_status` (Query `?modell=&version=&gpu=&warteschlange=`).
  **`?nur_herzschlag=1`** (V1) → nur Herzschlag, keine Abholung, kein Zurücksetzen, kein
  Housekeeping, Antwort `{ auftraege: [] }`. Sonst **ein** `offen`-Auftrag (V2): **Diktate
  zuerst** (dort wartet jemand live am Mikrofon), danach FIFO; je Zeile atomar beansprucht
  (`offen` + `versuche`) → `laeuft` (+`started_at`, `versuche+1`); Payload mit signierter URL
  (3600 s) und Kontext (für `ablage_analyse`: aktive Ordnerpfade, DOK_TYPEN, Namen der aktiven
  internen Mitarbeiter, heutiges Datum); Datei nicht mehr im Bucket → `fehler`. Hängende
  `laeuft` > **20 min** (Summe der Rig-Timeouts Download/OCR/Modell) → wieder `offen`
  (max 2 Versuche, dann `fehler`). Housekeeping (V7) höchstens alle 15 min pro Instanz.
- `POST /api/ki/sync` `{ ergebnisse: [{id, ok, ergebnis?, fehler?}] }` → `fertig`/`fehler`;
  nur `laeuft`-Aufträge nehmen ein Ergebnis an (ein spätes Ergebnis überschreibt keinen
  Neuversuch/Abbruch). Server-seitige Bereinigung: Ablage nur Typen/Ordner/Person aus dem
  Kontext, Datumsfelder `YYYY-MM-DD`; Diktat nur `{ text ≤ 20 000, dauer_ms }`. Tmp-Objekte
  von Beleg-, Warenkorb- und Diktat-Aufträgen werden sofort gelöscht; die Ablage-Datei bleibt
  bis `upload`/`tmp_id`. **V8:** bei `ablage_analyse` legt das FSM den Zielordner fest
  (Regel → Claude mit minimierter Einordnung → lokal, §3.1); `maxDuration 60` (Claude max. 25 s,
  das Rig wartet bis 90 s auf die Antwort).
- ~~`POST /api/ki/auftrag`~~ **entfernt** — Aufträge entstehen nur server-seitig
  (`ki-upload`, `diktat`, `analyze-*`); kein Nutzer schiebt Pfade in die Warteschlange.
- `GET /api/ki/auftrag/[id]` (Ersteller oder Admin, per RLS) → `{ status, ergebnis, fehler }`.
- `POST /api/ki/diktat` (V4; requireUser + **nur interne Mitarbeiter**, Portal-Konten 403;
  multipart `audio`, audio/*, ≤ 10 MB; `maxDuration 90`): KI offline → sofort **503**
  `{ offline: true }` (Aufnahme wird nicht angefasst); sonst Aufnahme nach `ki-tmp/<uuid>`,
  Auftrag `diktat`, bis **60 s** warten → **200** `{ text }` («» = nichts erkannt) /
  **504** `{ zeitueberschreitung: true }` / **502** (Rig meldet Fehler). Aufnahme und
  Auftragszeile werden in jedem Fall gelöscht (V7).
- `POST /api/ki/ticket` `{ scope }` — **nur `archiv`** (V6): `requireTrustedDevice("nas:ablage")`
  (Admin) → `{ ticket, exp, url }`; kein Diktat-Ticket mehr.
- `GET /api/ki/status` (requireUser, Nutzer-Client → RLS: Portal-Konten sehen «offline»,
  `Cache-Control: no-store`) → `{ online, letzter_poll, modell, warteschlange }`.
- `POST /api/ablage/ki-upload` (Admin, multipart) → KI offline: sofort 503 `{ offline: true }`
  (kein 50-MB-Upload für nichts); sonst Datei nach `nas-ablage/ki-tmp/<uuid>`, Auftrag
  `ablage_analyse` → `{ auftrag_id, tmp_id }`.
  **`DELETE /api/ablage/ki-upload?tmp_id=<uuid>`** (Admin, V5): Karte entfernt ohne
  abzulegen → Übergabe-Datei löschen (zuerst — ein gerade abgeholter Auftrag bekommt keine
  URL mehr), laufender Auftrag → `fehler «abgebrochen»` (sein spätes Ergebnis wird nicht
  angenommen), übrige Zeilen zu dieser Datei gelöscht.
- `/api/ablage/upload` mit `tmp_id` statt `file`: Originalname/Mime sind die Server-Wahrheit
  aus dem KI-Auftrag, Bytes aus dem Übergabe-Bucket, Hash/Duplikatprüfung wie beim direkten
  Upload. Auftrag oder Datei fehlt → **404 `{ tmp_fehlt: true }`**; der Client hält die Datei
  im Browser und lädt sie genau einmal selbst hoch. Nach erfolgreicher Ablage wird der
  KI-Auftrag gelöscht (V7).
- `/api/tickets/analyze-receipt` + `analyze-material`: **kein OpenAI mehr.** Reihenfolge:
  lokale KI (wenn `kiOnline()`, Bild als `ki-tmp/<uuid>`, Auftrag, bis **90 s** warten —
  `KI_TIMEOUT_BELEG_MS`, Kaltstart des Bildmodells ab LUKS-Platte 20–50 s; Route
  `maxDuration 150`) → sonst Claude Vision (`structuredCall`, Bild base64). Antwortform unverändert.
- **Housekeeping (V7, Datenschutz — Ergebnisse enthalten Dokumentinhalte):** Wer ein Ergebnis
  gelesen hat, löscht die Zeile (`loescheKiAuftrag`). Rest räumt `raeumeKiAuf()` — gedrosselt
  im Abhol-Pfad und täglich 02:00 aus `/api/cron/db-retention` (greift auch, wenn das Rig
  nicht pollt): Ergebnisse fertig/fehler > **1 h** → `ergebnis = null`; `offen` > **24 h**
  → `fehler`; `ki-tmp`-Objekte > **24 h** löschen; Zeilen > **30 Tage** löschen.

**UI:**
- NAS-Ablage: Datei rein → sofort `ki-upload` → Karte «Lokale KI liest das Dokument…»
  (Spinner, Fortschritt) → Ergebnis füllt Beschrieb + alle Felder → Phase «prüfen».
  Offline/Timeout → heutiger Weg (Beschrieb tippen, Claude nur mit Beschrieb) + Hinweis.
  Karte entfernen → `DELETE ki-upload?tmp_id`; `404 tmp_fehlt` beim Ablegen → Datei einmal
  selbst hochladen. Kopfzeile NAS: Chip «Lokale KI · online/offline». **V8:** neben dem
  Zielordner ein Chip «Regel» / «Vorbild» / «Claude» (`ordner_quelle`; Tooltip = `ordner_begruendung`,
  sonst Erklärung der Quelle); bei `ordner_sicherheit = "niedrig"` Chip amber und Zeile
  «Unsicher — bitte prüfen». Wählt der Nutzer einen anderen Ordner, fällt der Chip weg.
- Eingang «Diktieren» (V4): `GET /api/ki/status` (3 s Timeout, Ergebnis 60 s im Modul
  gemerkt) → online: MediaRecorder (64 kbit/s, max. 5 min ≈ 2,4 MB) → `POST /api/ki/diktat`;
  offline/503/504/Fehler oder kein Mikrofon/Browser ohne MediaRecorder → Browser-
  Spracherkennung mit Hinweis «Diktat über den Browser (Google) — …». Kein Aufruf von
  `NEXT_PUBLIC_KI_URL/health` aus dem Browser mehr (DNS-Rebind, §2.1).
- «Frag das Archiv» (Phase 3): Tab im NAS-Bereich, nur Admin + vertrautes Gerät; Frage →
  Ticket → Direkt-API (SSE) → Antwort + Quellen (Link in Explorer, Abrufen).

## 3. Datenformate (identisch auf Rig und FSM)

### 3.1 `ablage_analyse`
Payload (vom FSM): `{ storage_path, file_name, mime, size }` + Kontext (s. GET sync).
Ergebnis:
```json
{ "beschrieb": "Haftpflicht-Police AXA, Nr. 12345, gültig ab 1.1.2026, kündbar bis 30.6.2027",
  "typ": "vertrag", "betreff": "Haftpflicht AXA", "person": null, "partei": "AXA",
  "nummer": "12345", "dok_datum": "2026-01-01", "frist": "2027-06-30",
  "ordner": "00_ADMIN_RECHT/02_Versicherungen", "neuer_ordner": null,
  "ordner_alternativen": ["00_ADMIN_RECHT/03_Sonstige_Dauervertraege", "01_FINANZEN/02_Versicherungen"],
  "zusammenfassung": "…", "sha256": "…", "seiten": 3, "ocr": false,
  "modell": "gemma3:4b", "dauer_ms": 8400 }
```
`typ` ∈ DOK_TYPEN-Keys (`lib/ablage-doktypen.ts`); `ordner` exakt aus der Liste oder null;
`person` = voller Name aus der Mitarbeiterliste oder null; Datumsfelder `YYYY-MM-DD`.
Nachtrag 2026-10-11 (Ordnerwahl nach Vorbild, §2.2): `ordner` = voller Pfad aus der FSM-Liste oder
null (Regel-Treffer, Entscheid des Modells unter höchstens 5 Kandidaten, oder «keiner passt»);
`neuer_ordner` `<Eltern-Pfad aus der Liste>/<Neuer_Name>` oder null, nur wenn `ordner` null ist;
`ordner_alternativen` = bis zu 2 weitere gültige Pfade der Rangliste (nie der Hauptordner, nie
Pfade ausserhalb der Liste; leer möglich) — das FSM zeigt sie als Chips (`api/ki/sync` prüft sie
erneut gegen die Liste). Bild ohne lesbaren Text (Foto): `ordner` und `neuer_ordner` null, `typ`
`sonstiges`.

**V8 (2026-10-11) — Ablage-Entscheid durch Claude.** Das Rig liefert zusätzlich
`einordnung: { was (1–2 Sätze, auf dem Rig minimiert), typ, betreff, partei|null,
bezug: { art: "location"|"projekt"|"kunde"|"partner"|"firma"|"person"|null, name|null },
jahr: "YYYY"|null, personenbezogen: boolean, sprache|null, seiten|null }`,
`kandidaten: [{ pfad, quelle: "vorbild"|"regel", gewicht }]` (max 8) und `regel_ordner: string|null`
(verbindlich: INT-Nummer → Projektordner, Personalakte → Akte der Person). Das FSM legt daraus den
Zielordner fest (`src/lib/ki/ablage-entscheid.ts`, Aufruf in `POST /api/ki/sync`):
1. `regel_ordner` gültig (aktive Liste) → `ordner`, `ordner_quelle = "regel"`, Alternativen aus den
   Kandidaten (max 2, gültig, ≠ ordner), **kein** Claude-Aufruf.
2. Sonst, wenn `einordnung` vorhanden und `ANTHROPIC_API_KEY` gesetzt: Minimierung im FSM nochmals
   erzwungen (Beträge mit CHF/EUR/Fr./sFr./Rp. — Punkt optional, Tausendertrenner `'` oder Leerzeichen —,
   Zahlen mit Apostroph-Tausendertrenner, IBAN, AHV `756.…`, E-Mail, Telefon, 6+-stellige Zahlen → «[…]»;
   volle Namen **aller** Profile (`kontext.namen_alle`, auch inaktive — `mitarbeiter` bleibt die
   Personen-Auswahl) in jeder Rotation der Namensteile, auch «Nachname, Vorname» → «[Mitarbeiter/in]»).
   `einordnung.typ` zählt nur als DOK_TYPEN-Key (sonst leer), `sprache` nur als Kennung
   `^[a-z]{2,3}(-[A-Z]{2})?$` (sonst null). **Personenbezogen** = `personenbezogen`-Flag ODER im Ergebnis
   erkannte Person ODER `bezug.art = "person"` ODER `typ` (Rig oder Einordnung) ∈ `KI_PERSON_TYPEN`
   (lohnabrechnung, behoerde, zertifikat) → kein Claude, `ordner_quelle = "lokal"`. Sonst `structuredCall`
   (strict-Tool) mit Ordnerbaum **ohne Personalakten** (Teilbäume, deren Blatt die Akte eines Profils ist —
   `NNNN_Vorname_Nachname` oder `Nachname_Vorname`, Umlaute gefaltet wie im Rig, unter einer Wurzel mit
   «Personal» im Namen, Vorlagen `0000_*` ausgenommen — fallen samt Unterordnern weg, der Elternordner
   bleibt; Kandidaten und lokale Wahl werden gleich gefiltert), Hauskonvention, Einordnung, Kandidaten
   (Gewicht/Quelle) und der Wahl des lokalen Modells → `{ ordner, alternativen (max 2), sicherheit:
   hoch|mittel|niedrig, begruendung ≤ 120 }`, geprüft gegen die gekappte Liste (erfundener Pfad →
   `ordner` null). Treffer: `ordner`, `ordner_alternativen` (ohne Claude-Alternativen bleiben die lokalen),
   `ordner_quelle = "claude"`, `ordner_sicherheit`, `ordner_begruendung`. **Kein Treffer** (leer oder erfunden):
   `ordner` null, `ordner_sicherheit = "niedrig"`, `ordner_alternativen` = Wahl des lokalen Modells zuerst,
   dann dessen Alternativen, Claude-Alternativen füllen auf (max 2); `neuer_ordner` bleibt.
3. Claude-Fehler/Zeitüberschreitung → lokales Ergebnis, `ordner_quelle = "lokal"`, `logError` nur mit
   Kennzahlen; der Auftrag scheitert nie. **Zeitbudget:** `POST /api/ki/sync` hat `KI_SYNC_POST_BUDGET_MS`
   (**45 s** ab Eingang) für ALLE Ergebnisse eines Batches (`maxDuration 60`); die Claude-Entscheide laufen
   parallel, jeder wartet höchstens min(`KI_ENTSCHEID_TIMEOUT_MS` 25 s, Restbudget); Restbudget unter
   `KI_ENTSCHEID_MIN_REST_MS` (5 s) → kein Claude-Aufruf, `ordner_quelle = "lokal"`. So bekommt das Rig immer
   rechtzeitig seinen 200 (sonst schickte es den Batch endlos erneut).
4. Datenschutz: `einordnung`/`kandidaten` werden **nicht** persistiert (in `ki_auftraege.ergebnis` stehen nur
   die Entscheidungsfelder); `beschrieb`/`zusammenfassung` gehen nie an Claude. Ein Rig ohne V8-Felder →
   Ergebnis wie bisher (kein `ordner_quelle`, kein Chip). Der Kontext (GET sync) trägt dafür zusätzlich
   `namen_alle` (alle Profilnamen); der Rig liest nur die ihm bekannten Felder.
5. **Rig-Seite live seit 2026-10-11, Build `20261011-1509`** (`dienst/app/einordnung.py`, `handlers/ablage.py`,
   `ordnerwahl.py`): die Einordnung kommt aus **derselben** Antwort der Stufe 1 (sechs Schema-Felder hinten
   angehängt: `was, bezug_art, bezug_name, partei_art, jahr, personenbezogen` — kein weiterer Modellaufruf),
   wird deterministisch geprüft und auf dem Rig minimiert (gleiche Muster wie das FSM, Namen aus `namen_alle` +
   `mitarbeiter` in jeder Reihenfolge der Teile, auch mit gefalteten Umlauten); `partei` nur bei
   `partei_art = organisation` und nicht personenbezogen; `bezug.name` null bei `person`/`firma`/Profilname;
   `personenbezogen` = Modell ODER erkannte Person ODER Bezug `person` ODER Personen-Typ ODER Personalakten-Regel
   ODER (Review, Builds `20261011-1553`/`-1721`) Profilname in `was`/`betreff`/`partei`/`bezug_name` des Modells
   ODER Personal-Ordner im Spiel (bester Kandidat der Rangliste, Kandidat eines Regel-Bereichs oder lokal gewählter
   Ordner unter einer Freigabe mit «personal») — schliesst die Lücke «Arbeitsvertrag = Typ `vertrag`, das FSM setzt
   keine Person, die Akten-Regel greift nicht». Das **rohe** Modellfeld `person` zählt bewusst nicht (gemma3:4b
   füllt es mit Mitarbeiterliste fast immer: 55 von 63 Testdateien; als Signal machte es 56 von 63 Dokumenten
   personenbezogen und Claude wäre kaum noch gefragt worden). Die Rig-Minimierung kennt zusätzlich Beträge ohne
   Währung, Betragswort + Zahl, Postkonto, Strasse + Hausnummer, PLZ + Ort (nicht Mengen wie «1500 Gäste») und
   Anrede + Name — **im FSM (`minimiereText`) noch nicht gespiegelt** (FSM-Seite, offen);
   `jahr` aus `dok_datum`, sonst Modell; `sprache` deterministisch (de/fr/it/en) aus Funktionswörtern.
   `kandidaten` = bis 8 der Rangliste in deren Reihenfolge, `gewicht` relativ zum ersten (1.0), nie steigend;
   `quelle = regel` nur aus einem erkannten Regel-Bereich (INT-Nummer im Dateinamen, auch mehrdeutig;
   Personalakte) — Hinweise («INT-…» im Text, «26-014» ohne INT) zählen als `vorbild`. `regel_ordner` = der von
   einer Regel entschiedene Ordner (eindeutig, ohne Unterordner), sonst null. Die bisherigen Felder bleiben
   dieselben, mit gleicher Quote — einzelne Entscheide sind aber andere (der gemeinsame SYSTEM-Prompt beider Stufen
   wurde länger). Felder und Messwerte: `rig/eventline-ki/README.md` «V8 Rig-Seite».

### 3.2 `beleg_analyse` — Ergebnis wie heute: `{ ok, issues[], extracted: { betrag_chf, kaufdatum, lieferant } }`
### 3.3 `warenkorb_analyse` — `{ ok, issues[], extracted: { items: [{ artikel, menge, betrag_chf }] } }`
### 3.4 `diktat` (V3)
Payload: `{ storage_path, file_name, mime, size }` (Aufnahme audio/* ≤ 10 MB unter `ki-tmp/<uuid>`).
Ergebnis: `{ "text": "…", "dauer_ms": 1800 }` — Text getrimmt, höchstens 20 000 Zeichen (Rig und
FSM kappen gleich), leer = nichts erkannt (Stille, nur Rauschen). Kein `text`-Feld = kein gültiges Ergebnis.
### 3.5 Herzschlag — `?modell=&version=&gpu=<name|frei_mb>&warteschlange=`
Mit jedem Poll; während eines laufenden Auftrags zusätzlich alle 20 s `&nur_herzschlag=1`
(V1, Antwort `{ auftraege: [] }`). Leere Angaben werden weggelassen, das FSM behält dann den
letzten bekannten Wert.

## 4. Secrets / Env

| Wo | Variablen |
|---|---|
| Vercel + `.env.local` | `KI_SYNC_TOKEN` (≥ 32 Zeichen, sonst gilt die Route als nicht konfiguriert → 503), `KI_TICKET_SECRET`, `NEXT_PUBLIC_KI_URL=https://ki.in.eventline-basel.com` (gesetzt 2026-10-02; seit V6 nur noch als Ziel-URL im Archiv-Ticket, nicht mehr vom Browser direkt abgefragt), `CRON_SECRET` (bestehend, für `db-retention`) |
| Rig `/etc/eventline-ki/env` (root 0600) | `FSM_URL=https://eventline-fsm-usyk.vercel.app`, `KI_SYNC_TOKEN`, `KI_TICKET_SECRET`, `KI_CORS_ORIGINS=https://eventline-fsm-usyk.vercel.app,http://localhost:3000`, `PG_PASSWORD`, `KI_MODELL_TEXT=gemma3:4b`, `KI_MODELL_BILD=gemma3:4b` (seit 2026-10-03, s. §2.1), `KI_MODELL_EMBED=bge-m3`, `KI_BILD_NUM_CTX=8192` (seit 2026-10-11 gesetzt: ein Fenster für Beleg und Ablage, §2.1), optional `KI_MODELL_WHISPER` (Standard `Systran/faster-whisper-medium`). Weitere Dienst-Werte mit Code-Standard (`config.py`), nur bei Bedarf setzen: `KI_LLM_NUM_CTX=8192`, `KI_WHISPER_NO_SPEECH_MAX=0.6`, `KI_WHISPER_MIN_FREI_MB=2000`, `KI_EMBED_MIN_FREI_MB=2000`, `KI_DIKTAT_TIMEOUT_S=120`, `KI_LLM_TIMEOUT_S=300`, Archiv-Index `KI_NAS_WURZEL=/mnt/eventline-nas`, `KI_INDEX_START_S=120`, `KI_INDEX_NACHT=02:30`, `KI_INDEX_OCR_SEITEN=3`. **Änderungen wirken erst nach `docker compose … up -d dienst`** (`restart` liest die Datei nicht neu, 2026-10-03) |
| Rig `/etc/eventline-ki/caddy.env` | `CLOUDFLARE_API_TOKEN` (aus `_secrets/cloudflare-eventline.txt`) |

## 5. Verifikation (Pflicht vor «fertig»)

Stand 2026-10-03 (Bericht Rig-Abschluss, Build `20261003-0510`): 1, 2, 3, 6 bestanden; 4 offen; 5 eingeschränkt.

1. Egress: aus `dienst` → `https://api.anthropic.com` **muss scheitern** (Proxy 403),
   `https://uxtotpniwbwyoznwkygd.supabase.co` muss gehen (`python -m app.pruefe egress`). ✔
2. GPU: Modell laut §2.1 (`gemma3:4b`, nicht mehr `qwen3:8b`) antwortet; Tokens/s + VRAM
   protokolliert; nach 5 min Leerlauf ist der VRAM wieder frei. ✔ Beleg 9/9, kalt 4,2 s /
   warm Ø 1,6 s, `ollama ps` 100 % GPU, nach 321 s entladen (875 MiB belegt).
3. Whisper: deutsche Probe-Audio → Text; **Stille → leerer Text**. ✔ espeak-Satz kalt 3,7 s /
   warm 0,8 s wortgenau; 1 s Stille kalt 1,3 s / warm 0,2 s → leer (zwei Runden mit kaltem
   Cache, Container-Neustart); VRAM per TTL frei (316 s nach der letzten Erkennung `/api/ps`
   leer, sauber «unloaded»); mem_limit 8g: oom_kill 0, Peak 1564 MiB.
4. FSM-Rundlauf: `beleg_analyse` mit Testbild → Ergebnis < 90 s, Tmp-Objekt gelöscht;
   zusätzlich `diktat` über `/api/ki/diktat` → Text. **Offen — Blocker:** die Live-FSM
   (sha `29f0f03`) liefert für `/api/ki/sync` und `/api/ki/status` **404** (Routen liegen im
   Repo unter `src/app/api/ki/`, sind aber nicht deployt); der Dienst pollt seit 2026-10-03
   00:19 ins Leere (HTTP 404, Backoff 30 s). Herzschlag-Thread bisher nur per Test im
   Container geprüft. **Folgt nach dem FSM-Deploy.**
5. Direkt-API: `GET https://ki.in.eventline-basel.com/health` = 200 mit gültigem Zertifikat;
   falsches/abgelaufenes Ticket = 401. Aus dem **Büro-Netz erst nach der Router-Ausnahme**
   (DNS-Rebind-Schutz, §2.1) prüfbar — bis dahin vom Rig selbst (`/etc/hosts`) oder per VPN.
6. Schwarm läuft während und nach den Tests weiter (`systemctl is-active trust-one-swarm`). ✔
7. Dienst-Tests (im Dienst-Image, Stand 2026-10-11 V8-Review nach RAM-Einbau, Build `20261011-1721`):
   `tests/test_ablage.py` (32), `test_ordnerwahl.py` (17), `test_einordnung.py` (15),
   `test_archiv.py` (15), `test_ticket.py` (10), `test_diktat.py` (7), `test_worker.py` (7) grün — im bisherigen
   Image (Builds `20261011-1553` bzw. `-1701`) vor jedem Deploy und im neuen danach; Repo und Rig LF-normalisiert identisch. «Diktat während eines Indexlaufs» ist per Unit-Test
   abgedeckt (Index wartet auf einen laufenden Auftrag, Einbettung durch die Schleuse), nicht live
   getestet (hätte Prod-Warteschlange und Protokoll beschrieben). Bei jedem Code-Update wiederholen (`install.sh --ohne-modelle`
   bzw. Deploy-Kette aus `install.sh`-Kopf).

## 6. Phasen

0. Fundament (dieses Dokument, Rig, Dienst-Gerüst, FSM-Warteschlange, Belege ohne OpenAI)
   — Rig und Dienst **abgeschlossen** (Build `20261003-0510`); FSM-Seite im Repo fertig
   (`tsc --noEmit` rc=0), **Deploy offen** (§5.4).
1. Probelauf gegen das sortierte NAS (Trefferquote) — gelaufen 2026-10-03/04 und 2026-10-11
   (live-nah, Leave-one-out; Messwerte `rig/eventline-ki/README.md` «Ordnerwahl»). Ergebnis:
   zweistufige Wahl aus der ganzen Liste verworfen, **Ordnerwahl nach Vorbild** gebaut (§2.2).
2. Ablage ohne Tippen · Belege lokal · Diktat lokal (über die Warteschlange, V4) — live.
3. Archiv-Index für die Ordnerwahl — **live seit 2026-10-11** (§2.2). Offen: Frag das Archiv
   (Abschnitte + Volltext), ZZ einsortieren, Fristen (einzige Nutzung der Direkt-API, V6).
4. Personalakten-Check
5. Lernschleife (Korrekturen → Beispiele; der Index läuft bereits nachts). Modellwechsel zu
   `qwen3:8b` **verworfen 2026-10-11** (VRAM mit `bge-m3`/Whisper, Modellwechsel > 6 s, nur
   +1–3 Punkte, §2.1) — mehr Vorbilder (Korrekturen aus dem FSM) sind der Hebel.

## 7. Entscheide und Abweichungen seit dem ersten Deploy (Protokoll)

Kurz und sachlich; die normative Fassung steht in §2–§5. Keine Secret-Werte.

**2026-10-02 — erster Deploy (Rig):**
- `ollama` mem_limit 8g → **12g**, `whisper` 4g → **8g** (memcg-OOM: mmap-Seitencache zählt mit).
- `dienst` nur in `ki-intern`; Egress ausschliesslich über Squid; Erlaubnisliste auf **zwei exakte
  Hosts** reduziert (kein `*.supabase.co`).
- Images gepinnt; `capabilities: [gpu]` bei CDI (Schema-Pflicht, wirkungslos); Konfig-Verzeichnisse
  statt Einzeldatei-Mounts; Squid-Log in Datei + tägliche Rotation; Whisper `uv run --no-sync`.
- Unit: `Wants`/`After nvidia-cdi-refresh.service`, `ExecStartPre` erzeugt die CDI-Spezifikation
  bei Fehlen, `Restart=on-failure`; auditd zusätzlich auf `data/dienst`; `/etc/hosts`-Eintrag auf dem Rig.
- `cpu_shares 2048` gemessen = `cpu.weight` 174 gegenüber 100 (cgroup v2).

**2026-10-03 — Vertragspunkte V1–V7 (Rig ↔ FSM, beidseitig umgesetzt):**
- **V1** Herzschlag `GET /api/ki/sync?nur_herzschlag=1` alle 20 s während eines Auftrags.
- **V2** Abholung Batch **1**, **Diktate zuerst**, Hängen-Grenze **20 min** (statt 3 / FIFO / 10 min).
- **V3** neue Art `diktat` → `{ text, dauer_ms }`.
- **V4** `POST /api/ki/diktat` (interne Nutzer; 503 offline / 504 Zeitüberschreitung / 502 Rig-Fehler;
  60 s warten; `maxDuration 90`).
- **V5** `DELETE /api/ablage/ki-upload?tmp_id` (Karte entfernt → Datei + Auftrag weg, laufender
  Auftrag «abgebrochen»).
- **V6** Direkt-API **nur Archiv** (Phase 3): kein `/v1/diktat`, Ticket-Scope nur `archiv`.
- **V7** Ergebnisse nach Gebrauch löschen; Housekeeping 1 h / 24 h / 30 Tage im Abhol-Pfad
  (15-min-Drossel) und im Cron `db-retention`.
- Dazu: `KI_TIMEOUT_BELEG_MS` 45 s → **90 s** (Kaltstart ab LUKS); `upload` mit fehlender
  `tmp_id`-Datei → **404 + `tmp_fehlt`**; `POST /api/ki/auftrag` **entfernt**.

**2026-10-11 — V8 «Ablage-Entscheid durch Claude» (FSM-Seite gebaut; Rig-Seite live ab Build `20261011-1509`,
Eintrag unten):** Idee Mischa — statt dass die lokale KI den Ordner rät, erzeugt sie eine präzise, minimierte
Einordnung; Claude sortiert anhand der Ordnerliste ein. Dokumentinhalte verlassen das Haus nie, nur die
minimierte Einordnung (im FSM nochmals minimiert). Felder/Ablauf §3.1; UI-Chip «Regel/Vorbild/Claude» §2.3;
`KI_ENTSCHEID_TIMEOUT_MS = 25 s`, `POST /api/ki/sync` `maxDuration 60`. Review-Nachtrag gleichen Tags:
Zeitbudget 45 s über den ganzen Batch (Entscheide parallel), Personenbezug auch lokal (Typ/Bezug), Baum
ohne Personalakten, Namens-Rotationen, Betrags-/Typ-/Sprach-Validierung, «kein Treffer» → lokale Wahl voran (§3.1).

**2026-10-11 — V8 Rig-Seite live (Build `20261011-1509`):**
- `einordnung` aus derselben Antwort der Stufe 1 (sechs Schema-Felder hinten angehängt, kein weiterer Modellaufruf),
  Prüfung und Minimierung in `dienst/app/einordnung.py` (Spiegel von `minimiereText`, Namen aus `namen_alle` +
  `mitarbeiter` in jeder Reihenfolge, auch gefaltete Umlaute); `kandidaten` (≤ 8, Gewicht relativ, nie steigend,
  `quelle regel` nur aus erkanntem Regel-Bereich — neues Feld `Kandidat.regel_bereich` in `ordnerwahl.py`) und
  `regel_ordner` (= Regel-Entscheid). Bisherige Felder unverändert. `lese_kontext` liest `namen_alle`.
- `probelauf.py`: `--export` (JSONL ohne Text/Dateiname/Pfad der Testdatei) und `--namen-alle-datei`; Report mit `v8`.
- Tests 31/17/11 (neu `test_einordnung.py`)/15/10/7/7 grün im alten und neuen Image (§5.7).
- Messung (Seed 42, 126 Dateien, Zwillinge aus): lokale Wahl unverändert 55/79 % (einsortiert) bzw. 44/64 %
  (neutral); Ziel unter den ≤ 8 Kandidaten 90 % bzw. 73 %; `regel_ordner` 8/8 richtig (nur einsortiert); Median je
  Datei 4,6 → 3,8 s (Antwortzeit je Aufruf +12 %, Ziel ≤ 20 % eingehalten). Zwei Exporte für die Claude-Messung der
  FSM-Seite übergeben, auf dem Rig danach gelöscht (Kennzahlen-Reports bleiben unter `/data/probelauf/v8-*`).
- Offen: `jahr` und `bezug.art` sind bei 126/126 gesetzt — das Modell lässt sie kaum leer (Jahr evtl. geraten,
  wenn kein Datum im Dokument steht); die Wirkung zeigt erst die Claude-Messung. `namen_alle` im Live-Kontext
  bisher nur per Test geprüft (das FSM schickt es seit Commit b8edb8e).

**2026-10-03 — Rig-Abschluss:**
- `ablage.py`: Feldgrenzen (`MAX_ZEICHEN`) als `maxLength` im JSON-Schema, `ganze_saetze()` für die
  Zusammenfassung, konsistente Grenzen in `pruefe_ergebnis`; Kontextfenster wächst in 4096er-Stufen
  bis 32768 (Ollama kürzte bei 8192 still auf 4098 Tokens). Neuer Test `tests/test_ablage.py`
  (11 Tests); alle vier Testdateien grün (11/10/7/6). Deploy per tar + `install.sh --ohne-modelle`,
  Build `20261003-0510`.
- **Modellentscheid** `gemma3:4b` für Text und Bild (Messwerte §2.1): einziges Modell mit Belegen 9/9
  und Ablage zu 100 % in der GPU; `qwen3:8b` wäre besser (17/21, Ordner 2/3), scheitert aber an der
  100-%-Pflicht (92 %); `qwen2.5vl:3b` ohne Vorteil. In `/etc/eventline-ki/env` gesetzt (Rechte
  root 0600 erhalten). Dabei gemessen: `docker compose restart dienst` liest die env-Datei nicht
  neu, `up -d dienst` schon → README korrigiert.
- **Produktionsfehler behoben:** `DELETE /api/ps/<modell>` (Whisper entladen, vom Worker vor jedem
  LLM-Auftrag aufgerufen) verklemmte faster-whisper-server dauerhaft (Deadlock; Healthcheck blieb
  grün). Entladen komplett entfernt (`whisper.py`, `worker._vram_fuer_llm`); Whisper gibt den VRAM
  per `WHISPER__TTL` selbst frei (verifiziert). Mit `gemma3:4b` passen Whisper (~2,1 GB) + Modell +
  Schwarm gleichzeitig in die 8 GB.
- Whisper: `mem_limit 8g` aktiv (oom_kill 0, Peak 1564 MiB); VAD + Verwurf von Segmenten mit
  `no_speech_prob` > 0,6.
- NAS: Benutzer `eventline-ki` nur lesen, 10 Freigaben unter `/mnt/eventline-nas` (`Elements`
  ausgeschlossen); Tresor-Schlüssel im Token-Register gesichert.

**2026-10-04 — Probelauf Phase 1 und Umbau der Ordnerwahl (Vorgänger-Session):**
- Live-nah gemessen (Ordnerliste aller 424 Pfade, Leave-one-out): zweistufige Wahl Kategorie → Blatt
  nur 15 % (02_LOCATIONS) / 43 % (03_PROJEKTE) exakt → verworfen. Gebaut: Archiv-Index (`archiv.py`,
  pgvector, nur Einbettung + Metadaten), Rangliste mit Regeln (`ordnerwahl.py`), Kandidaten-Entscheid
  des Modells, `ordner_alternativen`; `OLLAMA_MAX_LOADED_MODELS` 1 → **2**. Labor: gemma3:4b Top-1 59 %,
  Top-3 80 %, Ziel unter 5 Kandidaten 86 %; qwen3:8b 60–62 %. Nicht ausgerollt (Session abgebrochen).

**2026-10-11 — Ordnerwahl nach Vorbild produktiv (Build `20261011-1048`):**
- Deploy des Stands vom 2026-10-04 plus: Index-Status in `/health` (`archiv`), Indexlauf wartet bei
  nicht eingehängtem NAS statt aufzugeben, Sprachmodell wird bei knappem VRAM vor der Einbettung
  entladen (`KI_EMBED_MIN_FREI_MB`). Tests 25/12/7/10/7/6 grün (altes und neues Image).
- **Modellentscheid bestätigt:** `gemma3:4b` (Messung §2.1; `qwen3:8b` passt nicht mit `bge-m3` und
  Whisper, Wechsel 6,1–10,4 s).
- `KI_BILD_NUM_CTX` 16384 → **8192** in der env (ein Fenster für Beleg und Ablage; Fensterwechsel lud das
  Modell neu, 3,3–5,0 s).
- Archiv-Index: Tabellen vorhanden (vom Labor angelegt, 167 Vorbilder, 424 Ordnerpfade), Erstlauf nach dem
  Deploy 167 geprüft / 167 unverändert in 1 s; Nachtlauf 02:30. Labor-Server und `/tmp`-Reste des
  Vorgängers auf dem Rig entfernt.
- **Finale Messung Produktionspfad** (Seed 42 / Seed 7, je 126 Dateien aus 02/03/04/05/08, live-nah,
  Leave-one-out): Top-1 **60 % / 59 %**, Top-3 **80 % / 81 %**, Kategorie 96 %, leer 0 %, Fehler 0,
  Median 5,1 / 4,8 s, Max 67–68 s, `num_ctx` 8192 durchgehend, Modell neu geladen 1×/0×; Entscheid Regel
  10, KI 116. 02_LOCATIONS 71 / 85–88 (Ziel erreicht), 03_PROJEKTE_EVENTS 49–51 / 75 (zieht den Schnitt:
  Projektordner mit je einer Datei haben im Leave-one-out kein Vorbild), 05 100/100. **Ziel 70/85 gesamt
  nicht erreicht**; Hebel: Vorbilder (jedes einsortierte Dokument wird mit dem Nachtlauf eines),
  INT-Nummer im Dateinamen (Regel trifft 10/10). Tabelle: `rig/eventline-ki/README.md` «Ordnerwahl».
- Nachgezogen am selben Tag (zweiter Deploy): Entladen vor der Einbettung nur für geladene Modelle ausser
  `bge-m3`; Dokumentation. Aktueller Build: `/health`.

**2026-10-11 nachmittags — Review der Ordnerwahl, neun Befunde behoben (Builds `20261011-1215` und
`20261011-1443`):**
- Kritisch: Der Indexlauf hätte bei nicht eingehängten Freigaben alle Vorbilder gelöscht. Jetzt: je Freigabe
  Mount-Prüfung (unvollständige Freigaben werden nicht bereinigt), Bremse (nie mehr als 50 % des Bestands in
  einem Durchgang entfernen), danach 10 Minuten Pause statt Dauerschleife; `eventline-ki.service` mit
  `Wants=/After=eventline-ki-nas.service` (Reboot-fest).
- «26-033» ohne «INT» entscheidet nicht mehr hart (Lieferanten-Nummern haben dieselbe Form), nur noch
  Zuschlag; Regel-Bereiche geben allen Unterordnern einen Sockel (kein leerer Kandidatensatz);
  Personalakte nur bei gleicher Wortmenge (auch kurze Vornamen wie «Li»); ZZ_ auf jeder Tiefe weder Vorbild
  noch Kandidat noch neuer Ordner; Nachtfenster als Zeitdifferenz (auch nach 20 Uhr gültig); VRAM-Check vor
  jeder Index-Einbettung.
- Messung ehrlich gemacht (Zwillinge ausgeschlossen, Variante mit neutralen Dateinamen, `--ordner-datei`
  für die FSM-Liste). **Neue Referenz:** Top-1 55 % / Top-3 79 % (einsortierte Namen) bzw. 44 % / 64 %
  (rohe Upload-Namen); die früheren 60/80 waren durch Fast-Zwillinge geschönt. Konsequenz: V8 (Claude
  entscheidet aus der minimierten Einordnung) hat Priorität; die lokale Wahl bleibt Rückfall.

**Betrieb / Restrisiken (offen):**
- `ki.in.eventline-basel.com` im Büro-Netz nicht auflösbar (DNS-Rebind-Schutz des Routers) →
  Router-Ausnahme offen; bis dahin Diktat nur über die Warteschlange (so gebaut), Archiv-Direkt-API
  erst mit Ausnahme/VPN nutzbar.
- DHCP-Reservierung für den Rig (MAC `b4:2e:99:fe:47:1a`) offen bei Mischa — ohne sie bricht der
  Stack nach einem Adresswechsel (Caddy-Bind, DNS-Eintrag).
- Restrisiko: Benutzer `mischa` ist in der `docker`-Gruppe (= root-gleich auf dem Rig, kann in die
  Container und den gemounteten Tresor); Lesezugriffe werden per auditd protokolliert (uid ≠ 1500/999).
- **Blocker FSM:** `/api/ki/sync` und `/api/ki/status` sind auf der Live-FSM (sha `29f0f03`) nicht
  deployt (404) → Rundlauf §5.4 erst nach dem Deploy. Vor dem Push: Migration 288 auf Prod, Vercel-Env
  `KI_SYNC_TOKEN`/`KI_TICKET_SECRET` prüfen (Pre-Push-Audit).
- Code-Standardwerte der Modelle (`config.py`, Compose-Profil `modelle`) noch `qwen3:8b`/`qwen2.5vl:7b`;
  massgeblich ist die env-Datei. Whisper-Kandidat `large-v3-turbo` ungetestet.
