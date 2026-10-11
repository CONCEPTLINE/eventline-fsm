# Rig-Masterplan lokale KI — Umsetzungsvertrag v1 (2026-10-11)

Freigegeben von Mischa am 11.10.2026: «ok kannst bauen, wir machen es mit Gemma 4».

**Geltung.** Diese Datei ist der **eine** verbindliche Vertrag zwischen Rig (KI-Dienst) und FSM für den Ausbau.
Sie ersetzt die beiden Entwürfe (Rig, FSM) und löst ihre Widersprüche auf. `SPEC.md` bleibt der Vertrag für
alles Bestehende. Was hier neu festgelegt ist, wird in Paket **E1.0** in `SPEC.md` übertragen (§1.2, §2.2,
§3, §7). Bis dahin gilt bei Widerspruch für die **neuen** Teile dieser Plan. Abweichungen werden zuerst hier
eingetragen, dann gebaut.

**Kurz in Klartext.**
- Tagsüber bleibt alles so schnell wie heute: Ablage, Belege und Diktat laufen weiter auf dem kleinen Modell
  auf der Grafikkarte. Niemand wartet je auf das grosse Modell.
- Neu läuft nachts ein **grosses Modell (Gemma 4)** auf dem Prozessor. Es schaut die Ablage des Tages ein
  zweites Mal an, macht Vorschläge für die 368 Dateien in den `ZZ_*`-Ordnern und findet Fristen in Verträgen.
- Neu gibt es eine **Inhaltssuche** im NAS («finde den Vertrag, in dem die Miete steht») und **«Frag das
  Archiv»**. Beides läuft über die bestehende Warteschlange, dauert Sekunden und hat kein Cloud-KI dabei.
- Alles kommt hinter Schaltern. Die Routen werden zuerst ohne Bedienung gebaut, die Oberfläche erst, wenn
  das Rig liefert.

---

## 1. Grundsatz, Entscheide, Abgrenzung

### 1.1 Grundsatz (unverändert aus SPEC §1)
Dokumentinhalte gehen nie zu einem Cloud-KI-Anbieter. Nichts aus der Nachtarbeit, der Suche oder dem Archiv
läuft über Claude. Der Squid-Proxy bleibt unverändert (nur Supabase + FSM). Ist das Rig offline, funktioniert
alles wie heute, mit Hinweis in der UI.

### 1.2 Entscheide Mischa vom 11.10.2026 (verbindlich)

| Nr | Entscheid | Folge für den Bau |
|---|---|---|
| E1 | Ablage und Belege: der sofortige Vorschlag kommt weiter von `gemma3:4b` (GPU). Das Hauptmodell prüft **nachts** nach und meldet Abweichungen («zweiter Blick»). | **Kein FSM-Auftrag geht ans Hauptmodell.** Es arbeitet nur in Jobs, die das Rig selbst plant. Keine Spur `gruendlich`, kein `nimmt`. |
| E2 | Hauptmodell `gemma4:26b-a4b-it-qat` (15,6 GB, liest Bilder), Rückfall `gemma4:12b-it-qat` (7,2 GB). Speicher (48 GB verbaut, ~46 GB nutzbar): EVENTLINE-KI **22 GB**, Trust one **20 GB**, System/Puffer **4 GB**. Qwen 3.6 später nur messen. | §2.1–§2.4. Beide Tags am 11.10. im Ollama-Katalog bestätigt (mit Bildteil `projector`). |
| E3 | «Frag das Archiv» als Auftrag über `ki_auftraege` (Supabase Zürich). Das Rig sucht und antwortet lokal. Zurück gehen nur Antworttext und Quellenpfade, die Zeile wird nach dem Lesen gelöscht. | SPEC §1.2 wird geändert (E1.0). Keine Auszüge, kein Direktweg nötig. |
| E4/E5 | Der ganze NAS-Bereich ist **nur Admin**. Personalakten sind voll durchsuchbar und in «Frag das Archiv» enthalten. Textabschnitte dürfen im verschlüsselten Tresor des Rigs liegen. | Keine Sonderregel für `06_PERSONAL`. SPEC §2.2 («nie Text») gilt weiter für den Vorbilder-Index, der neue Tiefen-Index speichert Text (E1.0). |
| E6 | Rückstau-ZZ-Vorschläge im bestehenden Tab «Ablage» als eigene Gruppe **«Rückstau ZZ»** (bestätigen/korrigieren wie die bestehenden Vorschläge). Fristen im Dashboard unter **«Braucht Aufmerksamkeit»** (bestehende Darstellung). | Kein neuer Tab, keine neue Seite. |

### 1.3 Gestrichen (nicht bauen, auch nicht «vorbereiten»)
Diktat-Ausbau (Whisper-CH, Rapport aus Diktat, `diktat_struktur`, `vokabular`); lokaler «Ersatz für Claude»
(stattdessen klare Meldung, §3.9); NAS-Vorschau-Upload durch den KI-Dienst (`nas_vorschau`); Umbenennen in ZZ
(`neuer_name`, Änderung an `sync.mjs`); Gitter-Suche/Auto-Gewichte der Rangliste; doppelter Lernpfad im FSM
(`ablage_items.ki_ordner*`); Abhol-Optimierung in `/api/ki/sync`; PK-Umbau `archiv_dateien` + Schattenindex;
`POST /api/ki/meldungen`; `ki_status.claude_gesperrt_bis`; `fortschritt`-Spalte.

### 1.4 Später (nicht in diesem Plan)
Duplikate über die Liste hinaus (nie löschen); monatlicher Neudurchlauf (nur bei Modellwechsel); Direktweg
`/v1/suche` und SSE für das Archiv; Morgenbericht-Tabelle; `qwen3-embedding` statt `bge-m3` (nur nach Messung
mit mindestens +3 Punkten); `halfvec`/HNSW-Index (ab ~50 000 Abschnitten); Messung Qwen 3.6.

### 1.5 Aufgelöste Widersprüche der Entwürfe (Kritik Punkt B)

| Thema | Entwurf Rig | Entwurf FSM | **Vertrag** |
|---|---|---|---|
| Nachtarbeit | `POST /api/ki/meldungen`, Ordnerliste aus Datei (14 Tage alt erlaubt) | `GET /api/ki/kontext` + `POST /api/ki/nachtarbeit` | **`GET /api/ki/kontext` + `POST /api/ki/nachtarbeit`.** Das Rig holt vor jeder Job-Phase einen frischen Kontext. Älter als 60 min = Job startet nicht (§3.5). |
| Suche | Warteschlange **und** `/v1/suche` direkt | nur Warteschlange, `GET /api/ki/status?wach=1` | **Nur Warteschlange.** Adaptiver Abholtakt, geweckt per **`POST /api/ki/wach`** (kein GET mit Nebenwirkung, §3.2). |
| Frag das Archiv | nur direkt per SSE | Warteschlange mit `gruendlich` | **Warteschlange, `archiv_frage`, immer `gemma3:4b`** (E1, E3). Kein `gruendlich`, kein Fortschritt. |
| Lernschleife | sha256-Abgleich im Rig-Index + Gitter-Suche | `ki_ordner`-Spalten + `entschieden` im Kontext | **Nur auf dem Rig.** Der bestehende nächtliche Vorbilder-Index macht jede abgelegte Datei zum Vorbild; dazu nur die Live-Trefferquote messen (§2.7). |
| Fristen | Datum muss im Text stehen | Datum vom Rig | **KI liefert Bedingungen, das FSM rechnet das Datum deterministisch** (`src/lib/ki/fristen.ts`, §3.7). |
| Rechte | — | `requirePermission("nas:ablage")` | **Wie die NAS-Seite heute: `requireAdmin` / RLS `(select is_admin())`.** «Frag das Archiv» wie das bestehende Archiv-Ticket: `requireTrustedDevice("nas:ablage")`. |

---

## 2. Rig-Architektur

### 2.1 Speicher-Aufteilung und Grenzen

| Bereich | Budget | Durchsetzung |
|---|---|---|
| EVENTLINE-KI (alle Container von `eventline-ki`) | 22 GB | **Vorrang vor Trust one** (Mischa 11.10., 18:10). systemd-Slice `system-eventlineki.slice` mit `MemoryMax=22G`, alle Compose-Dienste mit `cgroup_parent: system-eventlineki.slice`. **Name bewusst ohne Bindestrich in «eventlineki»:** ein Bindestrich im Slice-Namen bedeutet bei systemd Hierarchie — `eventline-ki.slice` läge als `eventline.slice/eventline-ki.slice` ausserhalb von `system.slice`. Dazu die bestehenden `mem_limit` je Container (unverändert). |
| Trust one | 20 GB | wird **nicht angefasst**; hält sich selbst unter 20 GB (Auftrag an die Trust-one-Session vom 11.10.). Wird es knapp, weicht Trust one, nicht die KI. |
| System/Puffer | 4 GB | Speicher-Tor und Wächter (§2.4, §2.5). |

- **Vorrang (verbindlich, ersetzt den Prüfer-Vorschlag):** 1. wartende KI-Aufträge (`schnell`: Ablage, Beleg,
  Diktat, Suche, Archiv-Frage), 2. Hauptmodell (`gruendlich`), 3. Trust one. Kein KI-Container wird für Trust one
  zurückgenommen.
- Wirkt `cgroup_parent` mit dem Docker-Cgroup-Treiber des Rigs nicht (Prüfung E2.0), entfällt der Slice. Dann
  begrenzen die Container-Grenzen, das Speicher-Tor und `oom_score_adj`. Das wird in SPEC §2.1 notiert.
- `oom_score_adj` der KI-Container ist **negativ** (`ollama`, `dienst`, `db`, `whisper` −500, `gruendlich` −300):
  Bei Speichernot des ganzen Rigs trifft der Kernel zuerst Trust-one-Prozesse. Läuft dagegen der KI-Slice selbst
  voll, stirbt darin zuerst das Hauptmodell (grösster Verbrauch, höchster Wert), nie Ablage, Belege oder Suche.
- `memswap_limit = mem_limit` beim Hauptmodell: es wird selbst nie ausgelagert. Wird der Speicher knapp, lagert
  der Kernel Trust one aus. Das ist so gewollt.

### 2.2 Zwei Ollama-Instanzen

**`ollama` (schnell, bestehend):** `cpu_shares` bleibt **2048** (doppeltes Gewicht gegenüber Trust one mit 1024 —
die KI hat Vorrang). Dasselbe für `whisper` und `dienst`. Neu `OLLAMA_NOPRUNE: "1"` und `oom_score_adj: -500`.
Modelle: `gemma3:4b` + `bge-m3` (bzw. das in E2.6 gemessene Suchmodell).

**`ollama-gruendlich` (neu), Stufe A (Standard): ohne GPU-Gerät, nur Prozessor.**
```yaml
ollama-gruendlich:
  image: ollama/ollama:<Version aus E2.0, gepinnt>   # nur diese Instanz bekommt bei Bedarf ein neueres Image
  container_name: eventline-ki-ollama-gruendlich
  restart: unless-stopped
  networks: [ki-intern]
  cgroup_parent: system-eventlineki.slice   # nicht «eventline-ki.slice» (Bindestrich = Hierarchie, §2.1)
  environment:
    OLLAMA_HOST: 0.0.0.0:11434
    OLLAMA_KEEP_ALIVE: 15m
    OLLAMA_MAX_LOADED_MODELS: "1"
    OLLAMA_NUM_PARALLEL: "1"
    OLLAMA_FLASH_ATTENTION: "1"
    OLLAMA_KV_CACHE_TYPE: q8_0
    OLLAMA_NOPRUNE: "1"
    OLLAMA_LOAD_TIMEOUT: 15m
  volumes:
    - /srv/eventline-ki/data/ollama-gruendlich:/root/.ollama
    - /srv/eventline-ki/data/ollama/models:/root/.ollama/models:ro
  cpu_shares: 1536         # über Trust one (1024), unter `schnell` (2048): Wartende gewinnen innerhalb der KI
  mem_limit: 19g           # Gemma 4 26B: 15,6 GB Gewichte + KV 16k (q8) + Runner; E2.2 misst und korrigiert
  memswap_limit: 19g
  oom_score_adj: -300      # bei Speichernot des Rigs vor Trust one geschützt; im KI-Slice stirbt es als erstes
  # kein <<: *gpu  → kein CUDA-Speicher, keine Konkurrenz um die 8 GB VRAM
```
- Alle Aufrufe an `gruendlich` mit `options.use_mmap: false` (Gewichte als fester Speicher, kein stilles
  Nachladen von der SATA-SSD bei Druck), `num_gpu: 0`, `num_ctx: KI_HG_NUM_CTX` (16384, immer gleich, sonst
  Neuladen), `num_thread` aus dem Planer.
- **Stufe B (Schalter `KI_HG_GPU_NACHT=1`, erst nach Messung E2.4):** GPU-Gerät dazu, `OLLAMA_GPU_OVERHEAD`
  = **5,75 GiB** Reserve (gemma3:4b@8192 3,3 + bge-m3 1,2 + Schwarm 0,9 + 0,35 Rand). Nur einschalten, wenn
  die Messung mindestens 1,5× Tokens/s zeigt **und** die VRAM-Matrix (Ablage, Beleg, Diktat bei geladenem
  Hauptmodell) ohne Neuladen von `gemma3:4b` durchläuft. Sonst bleibt Stufe A.
- Modelle lädt weiter der Profil-Container `ollama-modelle` über `ki-egress` (Squid bleibt unverändert). Falls
  `gemma4` ein neueres Ollama braucht, zieht ein Profil-Container mit dem `gruendlich`-Image.

### 2.3 Planer (Tag/Nacht), Europe/Zurich

| Modus | Zeit | Hauptmodell | Jobs in dieser Reihenfolge |
|---|---|---|---|
| NACHT | 19:00–07:00 (`KI_NACHT_START`, `KI_TAG_START`) | an, `num_thread` = `KI_HG_THREADS_NACHT` (10) | 19:00 Kontext holen → 19:05 Vorbilder-Index (bestehend; `KI_INDEX_NACHT` 02:30 → **19:05**, damit die Ablage des Tages Vorbild ist) → Tiefen-Index (höchstens `KI_TIEFE_MAX_H` = 3 h pro Nacht) → **Hauptmodell-Phase:** Zweiter Blick (Ablage des Tages) → Fristen (Dokumentkarten) → Rückstau ZZ → 05:30 Selbsttest (nur Produktionsmodelle) → 06:45 Hauptmodell entladen |
| TAG | 07:00–19:00 | an (`KI_HG_TAG=1`, eingeschaltet nach E2.4), `num_thread` = `KI_HG_THREADS_TAG` (6) | Rückstand Fristen und ZZ, neue Dokumente gründlich; wartende Aufträge haben immer Vorrang |

- Moduswechsel: laufenden Schritt fertig rechnen, dann `keep_alive: 0`. Ein Schritt = eine Datei, höchstens
  `KI_HG_SCHRITT_MAX_S` (600 s), sonst Schritt `fehler`, weiter mit der nächsten Datei.
- Lokale Job-Liste im Tresor `hg_auftraege(id, art, schluessel, rezept, status offen|laeuft|pausiert|fertig|fehler,
  versuche, erstellt, begonnen, beendet, fehler)`, `UNIQUE(art, schluessel, rezept)`. Schritte sind idempotent.
- Denkmodus (`think`) ist an; der Denk-Text wird **nie** gespeichert oder geloggt, nur seine Token-Anzahl.
  Ob `format` (JSON-Schema) mit `think` zusammen geht, prüft E2.2; sonst zweiter Aufruf ohne Denken zum Formen.

### 2.4 Modell-Leiter und Speicher-Tor

- `KI_HG_MODELLE="gemma4:26b-a4b-it-qat@17,gemma4:12b-it-qat@9"` (Name@Bedarf in GB, Stufe A; E2.2 ersetzt
  die Zahlen durch Messwerte `memory.stat anon`).
- **Tor (KI hat Vorrang):** Modell darf laden, wenn das **KI-Budget** es erlaubt (**nicht rückgewinnbarer**
  Speicher des Slices + Bedarf ≤ 22 GB) **und** `MemAvailable` (Host-Wert aus `/proc/meminfo`, im Container sichtbar — E2.0 prüft das)
  ≥ Bedarf / 2 ist, 2 Minuten am Stück. Den Rest gibt der Kernel aus Seitencache und Trust one frei — so gewollt.
  Die untere Grenze verhindert nur, dass der ganze Rig ins Stocken gerät.
- **Nicht rückgewinnbar** = `memory.current − inactive_file` aus `memory.stat` des Slices
  (`system-eventlineki.slice`). Nicht `memory.current` allein: in cgroup v2 zählt dort auch der Seitencache mit
  (GGUF-Dateien, OCR-Dateien im Tiefen-Index, Datenbank), den der Kernel sofort freigibt. Sonst bliebe das Tor
  nach dem Tiefen-Index zu (z. B. 8 GB, grösstenteils Cache: 8 + 17 > 22), und der Planer nähme ohne echten
  Speichermangel jede Nacht den 12B-Rückfall. Umsetzung im Rig-Planer (E2.3), Test in `test_speicher.py` mit
  dem Fall «viel Seitencache» (Tor offen) neben «viel anon» (Tor zu).
- `waehle()`: erstes installiertes Modell der Leiter, dessen Tor offen ist und das nicht gesperrt ist. Sonst
  warten und alle `KI_HG_NEU_PRUEFEN_S` (300 s) neu prüfen. Öffnet das 26B-Tor in den ersten 30 min der
  Hauptmodell-Phase nie, nimmt der Planer für diese Nacht den 12B-Rückfall.
- Ein geladenes Modell bleibt bis zum Fensterende oder bis der Wächter auslöst (Hysterese).
- **Nachlade-Begrenzung:** höchstens `KI_HG_MAX_LADUNGEN` (3) Ladevorgänge des Hauptmodells pro Fenster
  (Rückfallwechsel zählt mit). Danach ruht die Hauptmodell-Phase bis zum nächsten Fenster. Grund: jedes Laden
  liest 8–16 GB von der langsamen SATA-SSD (ca. 35–70 s).
- **OOM erkannt** (Modell während eines Schritts nicht mehr in `/api/ps`, oder `gruendlich` neu gestartet) →
  Modell 24 h gesperrt, Eintrag im Protokoll, nächste Stufe der Leiter.
- **Auswertung des 24-h-Profils (E2.0):** zeigt, ob Trust one seine 20 GB einhält. Hält es sie nicht ein, meldet
  das Rig das an Mischa; die KI lädt trotzdem (Vorrang), Trust one wird dann ausgelagert.

### 2.5 Wächter (eigener Thread, alle 2 s, nur wenn das Hauptmodell geladen ist oder lädt)

- **Zweck:** nicht Trust one schonen (die KI hat Vorrang), sondern verhindern, dass der ganze Rig ins Stocken
  gerät — sonst litten auch die wartenden KI-Aufträge.
- **Auslöser** (jeder einzeln): `MemAvailable < KI_HG_NOT_GB` (1); PSI `/proc/pressure/memory` `full avg10 > 30`
  (schweres Auslagern bremst alles); `pgmajfault` aus `/proc/vmstat` 10 s lang über 3000/s. Dass Trust one in den
  Swap geht, ist allein **kein** Auslöser.
- **Abbruch:** Event setzen → der Hintergrund-Thread schliesst den Stream (Ollama bricht beim
  Verbindungsabbruch ab) → `POST gruendlich/api/generate {model, keep_alive: 0}` → Job `pausiert`, Protokoll
  `art=hg_<job>, fehler="speicher"`.
- **Während des Ladens** kann der Wächter das Laden nicht sicher stoppen. Dort schützen Tor (vorher),
  Slice/`mem_limit` und `oom_score_adj` (währenddessen); sobald `/api/ps` das Modell zeigt, entlädt er.
- **Wiederaufnahme:** frühestens nach `KI_HG_PAUSE_S` (600 s) und nur bei offenem Tor (5 min am Stück); zählt
  gegen die Nachlade-Begrenzung.

### 2.6 Vorrang und GPU-Schleuse

- Reihenfolge: wartende KI-Aufträge vor Hauptmodell vor Trust one (§2.1).
- Aufrufe an `gruendlich` nehmen **nie** `gpu.SCHLEUSE` (Client mit `schleuse=False`). In Stufe A hat
  `gruendlich` keine GPU; Wartende (Ablage, Beleg, Diktat, Suche, Archiv) laufen unberührt auf `schnell`.
- Einbettungen des Tiefen-Index gehen an `schnell` und nehmen die Schleuse pro Stapel (≤ 32 Texte) kurz, wie
  heute. Vor jedem Stapel und jeder OCR-Datei gilt `zustand.ruhig(20 s)` wie beim Vorbilder-Index.
- Stufe B: der Hintergrund-Thread prüft nach jedem Stream-Chunk `zustand.laeuft`; läuft ein Auftrag, schliesst
  er den Stream, Job `pausiert (vorrang)`, Neustart des Schritts nach `ruhig(20 s)`. Das Modell bleibt geladen.
- Tesseract im Tiefen-Index mit `OMP_THREAD_LIMIT=2` und `nice 15`.

### 2.7 Neue Tabellen im Tresor (db-Container, Anlage idempotent wie `archiv.DDL`)

| Tabelle | Inhalt | Hinweis |
|---|---|---|
| `archiv_text(pfad pk, sha256, rezept_text, seiten, ocr, sprache, zeichen, text, extrahiert)` | Volltext je Datei | einmal lesen, mehrfach nutzen |
| `archiv_abschnitte(id, pfad, nr, seite, text, tsv GENERATED (to_tsvector('german', text)), rezept, einbettung vector)` | Abschnitte ~800 Zeichen, 120 Überlappung, an Absatz-/Seitengrenzen | `GIN(tsv)`, Index `(pfad)`; Einbettung `bge-m3` ohne Präfix |
| `archiv_karte(pfad pk, sha256, typ, dok_datum, partei, personenbezogen, modell, rezept_llm, erstellt)` | Dokumentkarte (Fristen-Job) | kein Freitext |
| `archiv_fristen(pfad, art, bedingungen jsonb, seite, sicherheit, gemeldet_at, …)` | Fristen-Bedingungen vor der Meldung | `UNIQUE(pfad, art, bedingungen)` |
| `zz_vorschlaege`, `nachpruefungen` | Ergebnis + `gemeldet_at` | idempotentes Melden |
| `ablage_vorschlaege(sha256, ordner_vorschlag, alternativen, quelle, modell, zeit)` | vom Worker nach jeder `ablage_analyse` geschrieben, nur Pfade | Grundlage für Zweiter Blick und Live-Trefferquote; 90 Tage |
| `qualitaet_tag(datum, top1, top3, n, …)`, `selbsttest_laeufe` | nur Kennzahlen | in `/health` sichtbar |

- Der Tiefen-Index liest **alle** lesbaren Freigaben inklusive `ZZ_*` und `06_PERSONAL` (E4/E5), ohne
  `99_System` und versteckte Einträge, mit eigenem Walker. Löschen nur bei vollständigem Durchgang einer
  Freigabe, Bremse bei ≥ 50 % Schwund (gleiche Regeln wie der Vorbilder-Index, SPEC §2.2).
- Der Vorbilder-Index (`archiv_dateien`) bleibt unverändert bei `bge-m3`, ohne Text.
- **Lernschleife = bestehender Vorbilder-Index + Messung.** Nachts: Vorschläge aus `ablage_vorschlaege` gegen
  den tatsächlichen Ablageort (per sha256 im Index) → `qualitaet_tag`. Keine Gewichts-Anpassung.

### 2.8 Schalter auf dem Rig (`/etc/eventline-ki/env`, Standard = aus)

| Schalter | Wirkung |
|---|---|
| `KI_HG_AKTIV=0/1` | Planer, Wächter, Hintergrund-Thread überhaupt starten |
| `KI_HG_TAG=0/1` | Hauptmodell auch tagsüber (Ziel: an; eingeschaltet nach der Messung E2.4) |
| `KI_HG_GPU_NACHT=0/1` | Stufe B (nur nach E2.4) |
| `KI_TIEFE_AKTIV=0/1` | Tiefen-Index aufbauen |
| `KI_SUCHE_AKTIV=0/1` | Art `nas_suche` annehmen und melden (§3.1) |
| `KI_ARCHIV_FRAGE_AKTIV=0/1` | Art `archiv_frage` annehmen und melden |
| `KI_JOB_ZWEITER_BLICK`, `KI_JOB_FRISTEN`, `KI_JOB_ZZ`, `KI_JOB_SELBSTTEST`, `KI_JOB_DUPLIKATE` | je Job |
| Zahlen | `KI_HG_MODELLE`, `KI_HG_PUFFER_GB` 3, `KI_HG_NOT_GB` 1, `KI_HG_MAX_LADUNGEN` 3, `KI_HG_PAUSE_S` 600, `KI_HG_NEU_PRUEFEN_S` 300, `KI_HG_SCHRITT_MAX_S` 600, `KI_HG_THREADS_NACHT` 10, `KI_HG_THREADS_TAG` 6, `KI_HG_NUM_CTX` 16384, `KI_TIEFE_MAX_H` 3, `KI_TIEFE_OCR_SEITEN` 30, `KI_KONTEXT_MAX_ALTER_S` 3600 |

Rückfall für alles: Schalter auf 0, `docker compose … up -d dienst` (nicht `restart`, SPEC §4).

---

## 3. Schnittstellen Rig ↔ FSM (Vertragspunkte MP-1 bis MP-9)

### 3.0 Gemeinsame Regeln
- **Pfade** sind relativ zur NAS-Wurzel, mit `/`, ohne führenden `/`, Unicode NFC, inklusive Dateiname
  (gleiche Form wie `archiv_dateien.pfad`). Nie `..`.
- **Unicode im FSM:** `ablage_datei_index.pfad` und `ablage_ordner.pfad` speichern die Schreibweise der Platte
  (vom Mac oft NFD; auf dem Linux-NAS sind NFC- und NFD-Namen verschiedene Dateien). Das FSM vergleicht
  Rig-Pfade deshalb in NFC, schreibt in `nas_vorschlaege` (`pfad`, `ordner_ist`, `ziel_ordner`,
  `alternativen`, `gewaehlt_ordner`), `ablage_fristen.pfad` und `ablage_moves` aber immer die Schreibweise aus
  Datei-Index bzw. Ordnerliste. Was das FSM ans Rig zurückgibt (`vorschlaege_bekannt`, `fristen_bekannt`), ist NFC.
  Zwillinge (gleicher Name in NFC und NFD): die NFC-Form gewinnt, sonst gilt der Pfad als nicht im Index.
- **Auth:** Rig → FSM immer `Authorization: Bearer KI_SYNC_TOKEN` (timing-safe, ohne Secret 503).
- **Kein Inhalt in Logs:** Route-Handler loggen bei diesen Arten nur `id`, Art, Dauer, Fehlercode — nie
  `frage`, `q`, `antwort`, `pfad`.

### 3.1 MP-1 Fähigkeiten-Meldung
- Das Rig hängt an **jeden** Poll (auch `nur_herzschlag`) `&arten=<kommagetrennt>` an: die Arten, die es
  annimmt (Basis: `ablage_analyse,beleg_analyse,warenkorb_analyse,diktat`; dazu `nas_suche` bei
  `KI_SUCHE_AKTIV=1`, `archiv_frage` bei `KI_ARCHIV_FRAGE_AKTIV=1`).
- Das FSM speichert sie gefiltert gegen `KI_ARTEN` in `ki_status.arten text[]`. Fehlt der Parameter (altes
  Rig), bleibt der letzte Wert; `null` gilt als «nur die vier Basis-Arten».
- `kiBereit(art)` (`src/lib/ki/queue.ts`) = online **und** `art ∈ arten`. Neue Routen antworten sonst
  **503 `{ nicht_bereit: true }`**, die UI zeigt das Element dann nicht oder mit Hinweis.
- Damit schaltet das Rig neue Funktionen ein und aus; das FSM braucht dafür keinen eigenen Schalter.

### 3.2 MP-2 Priorität und adaptiver Abholtakt
- `ki_auftraege.prioritaet smallint not null default 50`, gesetzt beim Anlegen aus `KI_PRIORITAET`:
  `diktat 100`, `nas_suche 90`, `archiv_frage 80`, alle übrigen `50` (Reihenfolge der bisherigen Arten bleibt
  also gleich: Diktate zuerst, dann FIFO).
- `GET /api/ki/sync`: die **bestehenden zwei Abfragen bleiben** (zuerst Diktate, dann der Rest). Einzige
  Änderung: in der zweiten Abfrage `order by prioritaet desc` vor `created_at` — das reicht für `nas_suche` 90 /
  `archiv_frage` 80 vor 50. Der Umbau zu einer Abfrage ist gestrichen (Mischa 11.10.: «Abhol-Optimierung in
  /api/ki/sync … nicht angefragt, heisser Live-Pfad»); die Diktat-Bevorzugung hängt so weiter nicht an der Spalte.
- `POST /api/ki/wach` (neu, `requireAdmin`, Body leer) → setzt `ki_status.eilig_bis = now() + 90 s`, schreibt
  aber nur, wenn der bisherige Wert vor `now() + 60 s` liegt (Drossel). Antwort `204`. Aufruf aus der UI beim
  Fokus ins NAS-Suchfeld und beim Öffnen von «Frag das Archiv».
- `GET /api/ki/sync` antwortet zusätzlich mit `naechster_poll_ms: 300`, solange `eilig_bis > now()`; sonst
  fehlt das Feld. Das Rig pollt dann nach `max(250, naechster_poll_ms)` ms statt nach 2 s
  (`poll_intervall_s` heute mindestens 0,5 s → Untergrenze für diesen Fall 0,25 s). Bei `nur_herzschlag` kein
  Feld.

### 3.3 MP-3 Art `nas_suche`
- **Route** `POST /api/ki/suche` (`requireAdmin`, `maxDuration 15`). Body `{ q }` (getrimmt, 2–200 Zeichen,
  sonst 400). Rig offline → **503 `{ offline: true }`**, Art nicht gemeldet → **503 `{ nicht_bereit: true }`**.
- Auftrag `nas_suche`, Payload `{ q, limit: 20 }`. Warten bis **8 s**, Abfrage alle **250 ms**
  (`warteAufErgebnis(id, ms, { pollMs })`). Danach Zeile **in jedem Fall löschen** (wie Diktat), auch bei
  Zeitüberschreitung — ein spätes Ergebnis wird nicht mehr angenommen.
- **Rig-Ergebnis** (Handler ≤ 3 s):
  ```json
  { "treffer": [ { "pfad": "02_LOCATIONS/Volkshaus/Mietvertrag_2025.pdf", "seite": 3, "score": 0.82 } ],
    "index": { "dateien": 2140, "gelesen_anteil": 0.63 }, "dauer_ms": 410 }
  ```
  Verfahren: Einbettung der Frage (`bge-m3`, warm halten 07–19 Uhr mit `keep_alive "2h"`), Vektor-Top-50 +
  `ts_rank(websearch_to_tsquery('german', q))`-Top-50, vereint per RRF (k = 60), je Datei die beste Stelle,
  Top 20, `score` auf 0..1 normiert. **Nie ein Textfeld.**
- **FSM-Bereinigung** (POST sync): höchstens 50 Treffer, nur `pfad` (String ≤ 1000, ohne `..`), `seite`
  (Ganzzahl ≥ 1 oder null), `score` (0..1); alle anderen Felder fallen weg.
- **Antwort an den Browser:** Treffer nur, wenn `pfad` in `ablage_datei_index` steht und nicht unter
  `99_System/`; ergänzt um `name`, `ordner`, `geaendert` aus dem Index:
  `{ treffer: [{ pfad, name, ordner, seite, score, geaendert }], gelesen_anteil, dauer_ms }`.
  Zeitüberschreitung → **504 `{ zeitueberschreitung: true }`**; Rig-Fehler → **502**.
- Grenze, bewusst akzeptiert: der Worker arbeitet seriell. Läuft gerade eine Ablage-OCR, wartet die Suche
  dahinter (dann 504 mit «Inhaltssuche gerade belegt, gleich nochmals»). Die Namenssuche ist davon unberührt.

### 3.4 MP-4 Art `archiv_frage`
- **Route** `POST /api/ki/archiv` (`requireTrustedDevice("nas:ablage")`, wie das bestehende Archiv-Ticket).
  Body `{ frage }` (3–500 Zeichen). Offline/nicht bereit → 503 wie oben. Sonst Auftrag (Priorität 80),
  Antwort sofort `{ auftrag_id }`.
- **Route** `GET /api/ki/archiv/[id]` (gleiches Recht; nur eigener Auftrag, `created_by = user`) →
  `{ status: "offen"|"laeuft" }` oder bei `fertig` das Ergebnis — **die Zeile wird dabei gelöscht** (nur einmal
  lesbar). `fehler` → `{ status: "fehler", fehler }` und löschen. Unbekannte id → 404.
- **Rig-Ergebnis** (Handler ≤ 120 s, `gemma3:4b` auf `schnell`):
  ```json
  { "antwort": "Laut Mietvertrag mit dem Volkshaus beträgt die Kündigungsfrist 6 Monate …",
    "quellen": [ { "pfad": "02_LOCATIONS/Volkshaus/Mietvertrag_2025.pdf", "seite": 3 } ],
    "modell": "gemma3:4b", "dauer_ms": 18400 }
  ```
  Ablauf: Suche wie `nas_suche` → beste 8 Abschnitte (≤ 6000 Tokens) → Antwort **nur** aus diesen
  Fundstellen. Keine passende Fundstelle → `antwort` = «Dazu finde ich im Archiv nichts.», `quellen: []`.
- **FSM-Bereinigung:** `antwort` String ≤ 4000, `quellen` ≤ 8 mit `pfad`/`seite` wie oben, sonst nichts.
  Beim Ausliefern Quellen gegen den Index filtern und um `name`/`ordner` ergänzen.
- **Browser:** fragt `GET` alle 1,5 s ab, gibt nach 150 s auf («dauert zu lange»). Frage und Antwort bleiben
  nur im Tab (`sessionStorage`), damit ein Reload sie nicht verliert (§10); nie in der URL.

### 3.5 MP-5 Nachtarbeit: `GET /api/ki/kontext`
- Bearer, `maxDuration 30`, keine Nebenwirkung. Antwort:
  ```json
  { "erzeugt_am": "2026-10-12T17:00:03Z", "heute": "2026-10-12",
    "ordner": ["00_ADMIN_RECHT/02_Versicherungen", "…"],
    "dok_typen": [{ "key": "vertrag", "label": "Vertrag", "person": false }],
    "mitarbeiter": ["…"], "namen_alle": ["…"],
    "vorschlaege_bekannt": [{ "art": "zz", "pfad": "…", "status": "offen" }],
    "fristen_bekannt": [{ "pfad": "…", "art": "kuendigung", "datum": "2027-03-31", "status": "verworfen" }] }
  ```
  `ordner`/`dok_typen`/`mitarbeiter`/`namen_alle` aus derselben Funktion wie bei `ablage_analyse`
  (`ladeAblageKontext` nach `src/lib/ki/kontext.ts` verschieben, eine Quelle). `vorschlaege_bekannt` = offene,
  angenommene/korrigierte (Verschiebung steht noch aus) plus abgelehnte der letzten 180 Tage (höchstens 5000); `fristen_bekannt` = alle KI-Fristen
  (höchstens 5000).
- Das Rig holt den Kontext vor jeder Job-Phase und nach je 50 Schritten neu, legt ihn im Tresor ab (auch als
  `fsm-ordnerliste.json` für den Probelauf) und **startet keinen Job mit einem Kontext älter als
  `KI_KONTEXT_MAX_ALTER_S` (60 min)**. Kein Kontext → Job wartet, nichts wird geraten.

### 3.6 MP-6 Nachtarbeit: `POST /api/ki/nachtarbeit`
Bearer, `maxDuration 60`, höchstens **200 Einträge** pro Aufruf (Summe beider Listen), idempotent.
```json
{ "lauf_id": "2026-10-12-nacht", "modell": "gemma4:26b-a4b-it-qat",
  "vorschlaege": [
    { "art": "zz", "pfad": "ZZ_Alt/Scan_0042.pdf", "sha256": "…", "ordner_ist": "ZZ_Alt",
      "ziel_ordner": "01_FINANZEN/02_Versicherungen", "alternativen": ["00_ADMIN_RECHT/02_Versicherungen"],
      "sicherheit": "mittel", "quelle": "modell", "begruendung": "Police einer Sachversicherung" } ],
  "fristen": [
    { "pfad": "00_ADMIN_RECHT/03_Dauervertraege/Leasing_Kopierer.pdf", "sha256": "…", "art": "kuendigung",
      "bedingungen": { "beginn": "2024-01-01", "ende": null, "faellig": null, "laufzeit_monate": 36,
                       "verlaengerung_monate": 12, "kuendigungsfrist": { "anzahl": 3, "einheit": "monate" } },
      "partei": "Canon", "seite": 2, "sicherheit": "hoch" } ] }
```
**Vorschläge** (`art` ∈ `zz`, `nachpruefung`):
- `pfad` muss in `ablage_datei_index` stehen und `ordner_ist` dem Index-Ordner entsprechen (sonst
  `pfad_bewegt`).
- `zz`: `pfad` liegt unter einem `ZZ_*`-Segment. `nachpruefung`: `pfad` liegt **nicht** unter `ZZ_*`, und
  `ziel_ordner ≠ ordner_ist`.
- `ziel_ordner` und jede Alternative: aktiver Ordner aus dem Kontext, nie ein `ZZ_*`-Segment in irgendeiner
  Tiefe, nie unter einem inaktiven Ordner. Ungültige Alternativen fallen still weg (max 2).
- `sicherheit` ∈ `hoch|mittel|niedrig`, `quelle` ∈ `regel|vorbild|modell`. `begruendung` ≤ 120 Zeichen, im
  FSM nochmals durch `minimiereText`; bei personenbezogenem Dokument schickt das Rig **keine** Begründung.
- Kein Vorschlag ohne Ziel (passt nichts, meldet das Rig nichts). Kein `neuer_ordner`, kein `neuer_name`.
- Schon offen **oder angenommen/korrigiert** (Verschiebung steht noch aus, z. B. Sync hängt) für `(art, pfad)`
  → nichts ändern (`doppelt`). Abgelehnt in den letzten 180 Tagen mit gleichem
  Ziel → abgewiesen (`abgelehnt_bekannt`).

**Fristen** (Bedingungen statt Datum, Hausregel «WO rechnen deterministisch, KI nur WAS»):
- `art` ∈ `kuendigung|ablauf|vertragsende|verlaengerung|zahlung|sonstige`.
- `bedingungen`: `beginn`, `ende`, `faellig` (je `YYYY-MM-DD` oder null), `laufzeit_monate` (1–120|null),
  `verlaengerung_monate` (1–60|null), `kuendigungsfrist` (`{ anzahl 1–24, einheit: tage|wochen|monate }`|null).
- **Prüfung gegen Erfindung auf dem Rig (Pflicht):** jedes Datum und jede Zahl der Bedingungen muss im
  Quellabschnitt stehen (Datum in üblichen Schreibweisen, Zahl als Ziffer oder Zahlwort). Sonst verwerfen.
- `partei` (≤ 60) nur bei Organisationen und nicht personenbezogen, minimiert; sonst weglassen.
- **Datum rechnet das FSM** (`berechneFrist(art, bedingungen, heute)` in `src/lib/ki/fristen.ts`, rein,
  getestet), siehe §3.7. Ergebnis null → abgewiesen (`frist_unvollstaendig` / `frist_vergangen` /
  `frist_zu_fern`).
- Eintrag als `ablage_fristen` mit `quelle 'ki'`, `status 'vorschlag'`, `grundlage = bedingungen` (ohne Text),
  `bezeichnung` **strukturiert erzeugt**, nie zitiert: `«<Art> · <Partei>»`, ohne Partei `«<Art> · <Dateiname>»`
  (Dateiname aus dem Index, ≤ 120). Für dieselbe Datei existiert schon eine Frist mit gleichem Datum (jede Art,
  jeder Status, auch eine aus der FSM-Ablage) → `frist_bekannt`. «Dieselbe Datei» = gleicher `pfad`, gleiches
  `ablage_item_id` **oder gleicher `sha256`** — so bleibt eine verworfene Frist auch verworfen, wenn die Datei
  danach verschoben wurde (z. B. angenommener Rückstau-ZZ-Vorschlag). Eine verworfene Frist wird nie wiederbelebt.
- Verknüpfung zur FSM-Ablage: gibt es ein `ablage_items` mit `inhalt_hash = sha256` (beim Bau prüfen, ob
  `inhalt_hash` sha256 ist) oder `ordner_pfad || '/' || abgelegt_name = pfad`, wird `ablage_item_id` gesetzt.

**Antwort:** `{ success: true, angenommen: n, doppelt: n, abgewiesen: [{ liste: "vorschlaege"|"fristen", index, grund }] }`.
Das Rig setzt `gemeldet_at` für angenommene, doppelte und abgewiesene Einträge (abgewiesen wird nicht erneut
gemeldet, nur im Protokoll gezählt). FSM nicht erreichbar → Puffer im Tresor (höchstens 2000 Einträge),
Wiederholung mit Backoff 30 s bis 15 min.

### 3.7 Frist-Rechnung (FSM, `src/lib/ki/fristen.ts`)
1. `art ∈ {zahlung, sonstige}` oder `faellig` gesetzt → `datum = faellig`.
2. Vertragsende `E` = `ende`, sonst `beginn + laufzeit_monate − 1 Tag`, sonst keine Frist.
3. `E < heute` und `verlaengerung_monate` → `E` so oft um die Verlängerung schieben, bis `E ≥ heute`;
   ohne Verlängerung → `frist_vergangen`. Periode k wird **immer vom Ausgangs-Ende** gerechnet
   (`E_k = E_0 + k × verlaengerung`), nie Schritt für Schritt — sonst gälte ein geklemmter Tag (30.01. → 28.02.)
   danach als Monatsende und das Datum wanderte auf den 31.
4. `art ∈ {ablauf, vertragsende, verlaengerung}` → `datum = E`.
5. `art = kuendigung` → braucht `kuendigungsfrist`; `datum = E − Frist` (Monate kalendarisch: ist `E` ein
   Monatsende, ist das Ergebnis das Monatsende des Zielmonats, z. B. 31.12. − 3 Monate = 30.09.; sonst Tag
   geklemmt; Wochen = 7 × n Tage). Liegt `datum < heute` und gibt es eine Verlängerung → nächste Periode
   (Schritt 3 mit `E + verlaengerung`); sonst `frist_vergangen`.
6. Plausibel nur `heute ≤ datum ≤ heute + 10 Jahre` (sonst `frist_zu_fern`). Alle Daten als Kalendertage in
   Europe/Zurich, keine `Date`-Zeitzonen-Arithmetik (Rechnung auf `YYYY-MM-DD`).

### 3.8 MP-7 Bestätigen und Rückmeldung (FSM, nur Admin)
- `POST /api/ablage/nas-vorschlaege` `{ entscheide: [{ id, aktion: "annehmen"|"korrigieren"|"ablehnen", ordner? }] }`
  (höchstens 50, `requireAdmin`, Admin-Client). Je Eintrag: Status bedingt von `offen` auf
  `angenommen`/`korrigiert`/`abgelehnt` (+ `gewaehlt_ordner`, `entschieden_von/_am`); bei annehmen/korrigieren
  `ablage_moves (pfad, ziel_ordner)` einfügen (Ziel nur aktiv, nie `ZZ_*`, nie `99_System`). Pfad nicht mehr im Index → `veraltet`, 409. Schon ein
  Verschiebe-Auftrag offen (`pfad` unique) → Status zurück auf `offen`, 409. Antwort je Eintrag ok/Fehler.
- `POST /api/ablage/sync` (bestehend, Rückmeldung `verschoben`): passenden Vorschlag
  (`pfad`, Status `angenommen|korrigiert`) auf `erledigt` setzen.
- `/api/ablage/datei-index` am Scan-Ende (dort verschwinden Dateien): offene Vorschläge, deren `pfad` nicht
  mehr im Index steht → `veraltet`. Angenommene/korrigierte, deren `pfad` nicht mehr im Index steht und für die
  kein Verschiebe-Auftrag mehr offen ist (abgebrochen, Rückmeldung verloren): Datei liegt unter
  `gewaehlt_ordner` → `erledigt`, sonst → `veraltet`.
- `POST /api/ablage/fristen` `{ id, aktion: "bestaetigen"|"verwerfen"|"erledigt", datum? }` (`requireAdmin`):
  bestätigen (Datum vorher änderbar) → `aktiv`; verwerfen → `verworfen`; erledigt → `erledigt`.

### 3.9 MP-8 Claude am Limit (statt lokalem Ersatz)
`src/lib/ai/anthropic.ts` `structuredCall` wertet `Anthropic.APIError` aus und wirft `ClaudeNichtVerfuegbarError`
mit klarer deutscher Meldung (`message`) und `grund`:
- 402, oder 400 mit Text zu Guthaben/Nutzungslimit → «Claude ist gerade nicht verfügbar: Guthaben oder
  Nutzungslimit erreicht. Bitte Mischa informieren.» (`grund: "limit"`)
- 429 → «Claude ist gerade ausgelastet. Bitte in ein paar Minuten nochmals versuchen.» (`"ueberlastet"`)
- 529/Overloaded → gleiche Meldung (`"ueberlastet"`)
- 401/403 → «Claude-Zugang ungültig. Bitte Mischa informieren.» (`"zugang"`)
Kein Datenbank-Zustand, kein Nachholen. Die Original-Meldung der API (Sperrdatum, 401 vs. 403) bleibt in
`detail` und wird beim Einordnen einmal geloggt (`ai.claude.nicht_verfuegbar`), weil die Routen danach nur die
deutsche `message` loggen. V8 (`ablage-entscheid.ts`) fängt den Fehler wie bisher und fällt auf
lokal zurück (keine Meldung). Welche Routen ausserhalb des KI-Bereichs die Meldung heute verschlucken, listet
E1.7 auf; deren Anpassung nur nach Abstimmung mit der jeweiligen Session.

### 3.10 MP-9 Housekeeping-Ergänzung
`raeumeKiAuf()`: Zeilen der Arten `nas_suche` und `archiv_frage` werden nach **1 h** in jedem Zustand
**gelöscht** (nicht nur geleert). Dieser Schritt (`raeumeFluechtigeAuf`) läuft zusätzlich bei **jeder neuen
Archiv-Frage** (`POST /api/ki/archiv`, auch wenn das Rig offline ist) — sonst hielte nur der Abholpfad (Rig
online, höchstens alle 15 min) und der tägliche Cron die 1-h-Grenze ein. `KI_ARTEN` ohne `archiv_index`, `zz_einsortieren`, `fristen_scan`, dafür mit
`nas_suche`, `archiv_frage`; auf dem Rig fällt `ARTEN_PHASE_3` weg.

### 3.11 Fehler und Zeitlimits (Übersicht)

| Endpunkt | Recht | Zeitlimit | Fehler |
|---|---|---|---|
| `POST /api/ki/wach` | Admin | < 1 s | 401/403 |
| `POST /api/ki/suche` | Admin | wartet 8 s, `maxDuration 15`; Rig-Handler ≤ 3 s | 400, 503 `offline`/`nicht_bereit`, 504 `zeitueberschreitung`, 502 |
| `POST /api/ki/archiv` | Admin + vertrautes Gerät | sofort | 400, 403 Gerät, 503 |
| `GET /api/ki/archiv/[id]` | dito, eigener Auftrag | Browser 150 s; Rig-Handler ≤ 120 s | 404, `status: fehler` |
| `GET /api/ki/kontext` | Bearer | `maxDuration 30`, Rig-Timeout 30 s | 401, 503 ohne Secret, 500 |
| `POST /api/ki/nachtarbeit` | Bearer | `maxDuration 60`, Rig-Timeout 90 s, ≤ 200 Einträge | 400 (Form/zu viele), 401, 500 → Rig wiederholt |
| `POST /api/ablage/nas-vorschlaege` | Admin | ≤ 50 Entscheide | 400, 409 je Eintrag |
| `POST /api/ablage/fristen` | Admin | — | 400, 404 |
| Hauptmodell-Schritt (Rig) | — | ≤ 600 s je Datei | Schritt `fehler`, weiter |

---

## 4. Datenmodell FSM

**Nummern:** unmittelbar vor dem Anlegen `git fetch --all`, höchste Nummer auf `main` **und** allen Branches
+ 1. Unten als **N, N+1, N+2**. Stand 11.10. abends (`git fetch --all`): `300_akquise_projekt` auf `main`,
`301_service_reports_zugeteilte_techniker` auf `mobile` → **vergeben: N = 302, N+1 = 303, N+2 = 304**
(`302_ki_masterplan.sql`, `303_nas_vorschlaege.sql`, `304_ablage_fristen.sql`). Vor dem Commit nochmals prüfen
und bei Bedarf höher nummerieren (Verweise in `queue.ts`, `typen.ts`, `nachtarbeit.ts` nachziehen). Alle Migrationen idempotent und nur additiv; eingespielt werden sie von der Eltern-Session
(`node scripts/apply-migration.mjs …`), danach mit einer Abfrage geprüft.

**Rechte:** Die NAS-Seite nutzt heute `requireAdmin` und RLS `(select is_admin())` auf allen NAS-Tabellen
(271, 277, 282). Die neuen Tabellen machen es genau gleich, **alle 4 Verben**. Admins dürfen damit alles; kein
neuer Rechte-Slug. Bekommt der NAS-Bereich später einen vergebbaren Slug, werden alle NAS-Tabellen in einer
Migration gemeinsam umgestellt.

### N `ki_masterplan`
```sql
alter table public.ki_auftraege add column if not exists prioritaet smallint not null default 50;
update public.ki_auftraege set prioritaet = 100 where art = 'diktat' and status = 'offen' and prioritaet = 50;
create index if not exists idx_ki_auftraege_abholung
  on public.ki_auftraege (status, prioritaet desc, created_at);
alter table public.ki_status
  add column if not exists eilig_bis timestamptz,
  add column if not exists arten text[];

-- ki_auftraege_select (288) ersetzen: die flüchtigen Arten liest nur noch die Service-Role.
drop policy if exists ki_auftraege_select on public.ki_auftraege;
create policy ki_auftraege_select on public.ki_auftraege
  for select to authenticated
  using ((created_by = auth.uid() or (select public.is_admin()))
         and art not in ('nas_suche', 'archiv_frage'));
```
**Eine geänderte Policy:** `ki_auftraege_select` aus 288 galt sonst auch für `nas_suche`/`archiv_frage`. Ein Admin
auf einem **nicht** vertrauten Gerät (z. B. Handy) könnte mit Anon-Key und Session direkt über PostgREST Fragen
und Antworten aller Admins lesen (auch zu Personalakten), bevor sie abgeholt und gelöscht sind — die Gerätesperre
von `/api/ki/archiv/[id]` wäre wirkungslos. Diese Arten liest deshalb nur die Service-Role in den eigenen Routen
(`/api/ki/suche`, `/api/ki/archiv/[id]`). Schreiben bleibt wie in 288 nur der Service-Role vorbehalten,
`ki_status` select wie bisher.

### N+1 `nas_vorschlaege`
```sql
create table if not exists public.nas_vorschlaege (
  id uuid primary key default gen_random_uuid(),
  art text not null check (art in ('zz','nachpruefung')),
  pfad text not null,
  sha256 text,
  ordner_ist text not null,
  ziel_ordner text not null,
  alternativen text[] not null default '{}' check (cardinality(alternativen) <= 2),
  sicherheit text not null check (sicherheit in ('hoch','mittel','niedrig')),
  quelle text not null check (quelle in ('regel','vorbild','modell')),
  begruendung text check (char_length(begruendung) <= 120),
  modell text,
  lauf_id text,
  status text not null default 'offen'
    check (status in ('offen','angenommen','korrigiert','abgelehnt','erledigt','veraltet')),
  gewaehlt_ordner text,
  entschieden_von uuid references public.profiles(id) on delete set null,
  entschieden_am timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists nas_vorschlaege_offen_uq on public.nas_vorschlaege (art, pfad) where status = 'offen';
create index if not exists nas_vorschlaege_status on public.nas_vorschlaege (status, art, created_at);
alter table public.nas_vorschlaege enable row level security;
-- select / insert (with check) / update (using + with check) / delete: (select public.is_admin())
```

### N+2 `ablage_fristen` (eine Quelle für alle Fristen)
Heute stehen Fristen nur in `ablage_items.frist` + `frist_erinnert` (Migration 282). Geschrieben werden sie nur
von `POST /api/ablage/upload`; gelesen von Cron `api/cron/ablage-fristen` (Mails 30/7/0) und Büro-Bildschirm
`api/bildschirm/daten` (`fristen_30_tage`). Das NAS-Formular schickt `frist` nur an die Upload-Route.
```sql
create table if not exists public.ablage_fristen (
  id uuid primary key default gen_random_uuid(),
  ablage_item_id uuid references public.ablage_items(id) on delete cascade,
  pfad text,
  sha256 text,
  art text not null check (art in ('kuendigung','ablauf','vertragsende','verlaengerung','zahlung','sonstige')),
  datum date not null,
  bezeichnung text not null check (char_length(bezeichnung) <= 120),
  grundlage jsonb,                     -- KI-Bedingungen, ohne Text
  quelle text not null check (quelle in ('ablage','ki','manuell')),
  status text not null default 'aktiv' check (status in ('vorschlag','aktiv','verworfen','erledigt')),
  sicherheit text check (sicherheit in ('hoch','mittel','niedrig')),
  erinnert jsonb not null default '[]'::jsonb,
  entschieden_von uuid references public.profiles(id) on delete set null,
  entschieden_am timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ablage_fristen_bezug check (ablage_item_id is not null or pfad is not null)
);
create unique index if not exists ablage_fristen_uq
  on public.ablage_fristen (coalesce(ablage_item_id::text, pfad), art, datum);
create index if not exists ablage_fristen_offen on public.ablage_fristen (datum) where status in ('aktiv','vorschlag');
create index if not exists ablage_fristen_pfad on public.ablage_fristen (pfad);
create index if not exists ablage_fristen_item on public.ablage_fristen (ablage_item_id);
create index if not exists ablage_fristen_sha on public.ablage_fristen (sha256) where sha256 is not null;  -- frist_bekannt nach Verschieben
alter table public.ablage_fristen enable row level security;
-- alle 4 Verben: (select public.is_admin())

-- Backfill (idempotent; nach dem Umstellen der Leser in E3.4 nochmals ausführen):
insert into public.ablage_fristen (ablage_item_id, pfad, art, datum, bezeichnung, quelle, status, erinnert)
select i.id, i.ordner_pfad || '/' || i.abgelegt_name, 'sonstige', i.frist,
       left(i.abgelegt_name, 120), 'ablage', 'aktiv', i.frist_erinnert
from public.ablage_items i
where i.frist is not null
on conflict do nothing;
```
### Später (eigene Migration, erst nach dem Deploy von E3.4)
`ablage_items.frist` und `frist_erinnert` entfernen (alle Layer weg).

---

## 5. Datenschutz: was wo liegt, wie lange

| Was | Wo | Wie lange |
|---|---|---|
| Suchbegriff, Suchtreffer (Pfad, Seite, Score) | `ki_auftraege` (Supabase Zürich) | bis gelesen (Sekunden), Zeile in jedem Fall gelöscht; Reste nach 1 h gelöscht |
| Archiv-Frage, Antworttext, Quellenpfade | `ki_auftraege` (über PostgREST für niemanden lesbar, nur Service-Role, §4 N); im Browser nur `sessionStorage` des Tabs | Zeile beim Lesen gelöscht, Reste nach 1 h (geräumt bei jeder neuen Frage, im Abholpfad und im Cron, §3.10); nie in URL, Logs oder Claude |
| Volltext, Abschnitte, Einbettungen | Rig-Tresor (LUKS, auditd) | solange die Datei auf dem NAS liegt (Löschbremse); bei Rezeptwechsel neu |
| Dokumentkarte, Fristen-Bedingungen, Seiten | Rig-Tresor | wie oben |
| Denk-Text des Hauptmodells | nirgends | nie gespeichert, nur Token-Anzahl |
| ZZ-/Zweiter-Blick-Vorschläge (Pfad, Ordner, Sicherheit, Begründung ≤ 120, minimiert, ohne bei Personenbezug) | `nas_vorschlaege` (nur Admin) | offen bis entschieden; erledigt/veraltet 30 Tage, abgelehnt/korrigiert 180 Tage (danach `db-retention`) |
| Fristen (Datum, Art, strukturierte Bezeichnung, Bedingungen ohne Text) | `ablage_fristen` (nur Admin) | aktiv/vorschlag dauerhaft; erledigt 1 Jahr; verworfen bleibt (Sperre gegen Wiedervorschlag) |
| Ablage-Vorschlags-Log (sha256, Ordner), Kennzahlen | Rig-Tresor | 90 Tage; nur Kennzahlen in `/health` |
| Protokolle (Rig `ki_protokoll`, Vercel-Logs) | Rig / Vercel | nur Art, Dauer, Status, Fehlercode — nie Inhalt |

Nicht neu: Richtung Cloud-KI geht aus diesem Plan **nichts**. Squid-Erlaubnisliste unverändert. Kein neuer
Abflussweg vom NAS nach Supabase (keine Vorschau-Uploads; Abruf weiter über `ablage_abrufe`).
Personalakten: per E4/E5 enthalten, geschützt durch «nur Admin» (RLS + Route) und beim Archiv zusätzlich
durch das vertraute Gerät.

---

## 6. Arbeitspakete

Grundregeln für alle Pakete: `main` ist live, Datenbank geteilt. **`GET /api/ki/sync` nie aufrufen, auch nicht
lokal** (lokal = Prod-Datenbank, ein Aufruf beansprucht echte Aufträge). Sync-Logik nur über reine Funktionen
testen. Testzeilen exakt zurücksetzen (`count: 'exact'`). Rig-Deploy nur durch die KI-Session; vor und nach
jedem Rig-Paket `systemctl is-active trust-one-swarm`. Vor jedem FSM-Push: `npx tsc --noEmit`, eslint ohne neue
Befunde, `npm test`, adversarischer Selbst-Review (§16).

### Etappe 1 — FSM-Grundlage (ohne Bedienung)

| Paket | Inhalt | Dateien | Tests / Abnahme |
|---|---|---|---|
| E1.0 | SPEC-Übertrag, **erst wenn der andere Agent mit `SPEC.md` fertig ist**: §1.2 (E3), §2.1 Slice-Name `system-eventlineki.slice` mit Grund (Bindestrich = Hierarchie), §2.2 Tiefen-Index mit Text (E5), §3 neue Arten, Phase-3-Arten streichen, §7 Protokolleintrag «Masterplan v1» | `docs/lokale-ki/SPEC.md` | gelesen gegen diesen Plan |
| E1.1 | Migration N | `supabase/migrations/N_ki_masterplan.sql` | nach dem Einspielen: Spalten + Index per Abfrage; Policy `ki_auftraege_select`: eine Admin-Session sieht über PostgREST keine `nas_suche`/`archiv_frage`-Zeile |
| E1.2 | Konstanten/Typen/Queue: `KI_ARTEN` neu, `KI_PRIORITAET`, `KI_EILIG_FENSTER_MS` 90 000, `KI_EILIG_POLL_MS` 300, `KI_SUCHE_TIMEOUT_MS` 8 000, `KI_SUCHE_POLL_MS` 250, `KI_ARCHIV_*`; `erstelleKiAuftrag` setzt `prioritaet`; `warteAufErgebnis(…, { pollMs })`; `kiBereit(art)`; Housekeeping MP-9; `ladeAblageKontext` → `src/lib/ki/kontext.ts` | `src/lib/ki/{konstanten,typen,queue,kontext}.ts` | vitest: Prioritäten, `kiBereit` mit `arten = null` |
| E1.3 | `GET /api/ki/sync`: zweite Kandidaten-Abfrage zusätzlich nach `prioritaet` (zwei Abfragen bleiben), `arten` speichern, `naechster_poll_ms`; `POST`: Bereinigung `nas_suche`/`archiv_frage` (reine Funktionen in `src/lib/ki/bereinigen.ts`) | `src/app/api/ki/sync/route.ts`, `src/lib/ki/bereinigen.ts` | vitest: Bereinigung entfernt Textfelder, kappt Längen, verwirft `..` |
| E1.4 | `POST /api/ki/wach` | `src/app/api/ki/wach/route.ts` | Drossel: zweiter Aufruf innert 30 s schreibt nicht |
| E1.5 | Suche + Archiv-Routen | `src/app/api/ki/suche/route.ts`, `src/app/api/ki/archiv/route.ts`, `src/app/api/ki/archiv/[id]/route.ts` | 503 `nicht_bereit` solange das Rig die Art nicht meldet (Live-Prüfung ohne Rig-Änderung) |
| E1.6 | Migrationen N+1, N+2 (mit Backfill); `GET /api/ki/kontext`, `POST /api/ki/nachtarbeit`; Prüf- und Rechenlogik rein | `supabase/migrations/…`, `src/app/api/ki/kontext/route.ts`, `src/app/api/ki/nachtarbeit/route.ts`, `src/lib/ki/{nachtarbeit,fristen}.ts` | vitest: ZZ-Ziel abgewiesen (jede Tiefe), inaktiver Ordner, `pfad_bewegt`, `doppelt` (auch angenommen/korrigiert), `abgelehnt_bekannt`, verworfene Frist bleibt verworfen (auch nach Verschieben, gleicher `sha256`); Frist-Rechnung (Monatsende, 30.01. monatlich ohne Drift auf den 31., Verlängerung über mehrere Perioden, vergangene Frist, 10-Jahres-Grenze, fehlende Kündigungsfrist); Backfill-Anzahl = Anzahl `frist is not null` |
| E1.7 | Claude am Limit | `src/lib/ai/anthropic.ts` | vitest: Einteilung 402/400-Limit/429/529/401/403; Liste der Routen, die die Meldung verschlucken |

### Etappe 2 — Rig

| Paket | Inhalt | Dateien | Tests / Abnahme |
|---|---|---|---|
| E2.0 | **Sofort, parallel zu Etappe 1:** 24-h-Speicherprofil (Host-Skript, jede Minute MemAvailable, SwapFree, `memory.current` von trust-one-swarm, CSV im Tresor); `/proc/meminfo` im Container = Host?; Docker-Cgroup-Treiber (`docker info`) für den Slice; welche Ollama-Version lädt `gemma4`; `cpu_shares` der KI bleiben 2048 (Vorrang), negatives `oom_score_adj` setzen (§2.1) | `docker-compose.yml`, Messskript unter `rig/eventline-ki/messung/` | `cpu.weight` der KI-Container über Trust one; Profil ausgewertet (§2.4) |
| E2.1 | Slice + `ollama-gruendlich` (Stufe A) | `docker-compose.yml`, `install.sh` (Verzeichnis `ollama-gruendlich` 0700, Image `:vorher` sichern), `systemd/system-eventlineki.slice` (Name §2.1) | `cpu.weight` von `gruendlich` über Trust one und unter `schnell` (§2.2), `memory.max`, `memory.swap.max`, negatives `oom_score_adj` (§2.1); Modellverzeichnis nur lesbar; **kontrollierter OOM im KI-Slice** (`mem_limit` kurz 6g, Modell laden → nur `gruendlich` stirbt, Ablage/Suche laufen weiter) |
| E2.2 | Modelle laden (26B + 12B), Fähigkeit «vision» per `ollama show` | Profil `ollama-modelle`, README «Modell wechseln» | Mini-Prompt mit `use_mmap false`, `num_gpu 0`: `memory.stat anon` ≈ Bedarf, Tokens/s; `format` + `think` zusammen; Zahlen in `KI_HG_MODELLE` |
| E2.3 | Planer, Speicher-Tor, Wächter, Hintergrund-Thread, Job-Liste | neu `dienst/app/{speicher,planer,hintergrund}.py`, `dienst/app/jobs/__init__.py`; Änderungen `llm.py` (`base_url`, `schleuse=False`, `chat_stream` mit Abbruch, Optionen), `config.py`, `main.py` (`/health` + `hintergrund`/`speicher`, nur Zahlen), `worker.py` | neu `test_speicher.py` (Tor rechnet `memory.current − inactive_file`: viel Seitencache → offen, viel anon → zu), `test_planer.py` (Grenzen 06:59/07:00/18:59/19:00, Tor, Hysterese, Leiter, Nachlade-Grenze, OOM-Sperre), `test_hintergrund.py` (Abbruch, Pause, Wiederaufnahme, Schleuse nie gehalten → Diktat wartet < 1 s); bestehende Tests grün; live mit Dummy-Job (`KI_HG_AKTIV=1`) |
| E2.4 | **Messung** (nur nachts): `probelauf.py` mit `--ollama-url`, `--think`, `--use-mmap 0`, `--num-gpu`, `--num-thread`; 40er-Vorlauf, dann 126 Dateien Seed 42, beide Namensvarianten, Gemma 4 26B gegen `gemma3:4b` (Referenz 55/79 bzw. 44/64); Speicherspitzen; Latenz der Handels-Bots und I/O von Trust one während des Ladens; VRAM-Matrix für Stufe B | `probelauf/probelauf.py`, README | Abbruch bei: Schwarm nicht aktiv, Swap +1 GB, MemAvailable < 4 GB. Ergebnis: Entscheid `KI_HG_TAG`, `KI_HG_GPU_NACHT`, `KI_HG_THREADS_*` |
| E2.5 | Tiefen-Index | neu `dienst/app/tiefe.py`, `dienst/app/jobs/tiefe.py`; `extract.py` (Seitenmarken) | Abschnitte/Seitenmarken, Löschbremse bei leerer Freigabe, ZZ und Personal enthalten, `99_System` nie |
| E2.6 | `nas_suche` + `archiv_frage` im Worker, `arten` im Herzschlag, adaptiver Takt | neu `dienst/app/suche.py`, `dienst/app/archiv_frage.py`; `worker.py` (Arten ohne Datei), `fsm.py` (`arten`, `naechster_poll_ms`) | Schema-Test: Suche liefert nie Text; ohne Fundstelle fester Satz; Latenz warm < 1,5 s; Messung mit 20–30 echten Suchanfragen (MRR@10, Recall@20) — **braucht Liste von Mischa/Leo** |
| E2.7 | Live-Trefferquote | `worker.py` schreibt `ablage_vorschlaege`; neu `dienst/app/jobs/lernen.py` | Quote in `/health`; keine Gewichtsänderung |

### Etappe 3 — UI (erst wenn das Rig die jeweilige Art meldet)

Vor jedem Umbau `git show main:src/app/(app)/nas/page.tsx` lesen (§17). `nas/page.tsx` hat 2680 Zeilen: Neues
als eigene Komponenten unter `src/components/nas/`. Spinner im Knopf, Fehler als Toast, `EmptyState`,
`data-tooltip`, Datum mit `timeZone: "Europe/Zurich"`.

| Paket | Inhalt | Dateien | Abnahme |
|---|---|---|---|
| E3.1 | Suche: unter den Namenstreffern die Gruppe «Im Inhalt gefunden · lokale KI» (Spinner-Chip während der Suche; offline: «Inhaltssuche nur mit lokaler KI»; `gelesen_anteil < 1`: «x % des Archivs gelesen»). Zeile wie die bestehenden Treffer + Seite + Chip «Inhalt»; Klick = bestehender Abruf/Ordnersprung. `POST /api/ki/wach` beim Fokus. | `src/components/nas/inhalt-treffer.tsx`, Einbindung `nas/page.tsx` | jeden Klick live; Rig offline simuliert über `nicht_bereit` |
| E3.2 | Gruppe **«Rückstau ZZ»** im Tab «Ablage», gleiche Karte wie «Per Mail eingegangen» (`nas/page.tsx` ab Zeile 2059): Dateiname, Ziel-Chip, «Oder:»-Chips wie `ordner_alternativen` (Zeilen 2261–2287), «Anderer Ordner…» per `SearchableSelect`, Sicherheits-Chip (amber bei «niedrig»), Begründung als `data-tooltip`, Knöpfe «Übernehmen»/«Ablehnen» (`kasten`), sichtbar nur bei offenen Vorschlägen | `src/components/nas/vorschlaege-gruppe.tsx`, `src/app/api/ablage/nas-vorschlaege/route.ts`, `src/app/api/ablage/sync/route.ts`, `src/app/api/ablage/datei-index/route.ts` | Testzeile anlegen → annehmen → `ablage_moves` vorhanden → Testzeilen exakt löschen |
| E3.3 | «Frag das Archiv»: zweiter Knopf in der Suchkarte für den eingegebenen Text, Antwortfeld über den Treffern (Sekunden-Zähler), Quellen als Zeilen; ohne vertrautes Gerät ein Hinweis | `src/components/nas/archiv-frage.tsx` | Reload behält Frage/Antwort (`sessionStorage`) |
| E3.4 | **Fristen-Zeile** im Dashboard «Braucht Aufmerksamkeit»: `AufmerksamkeitRechte.fristen` (Admin), `AufmerksamkeitDaten.fristen_30_tage` = `ablage_fristen` mit Status `aktiv` oder `vorschlag` und Datum heute bis +30 Tage; Zeile «Frist in 30 Tagen»/«Fristen in 30 Tagen», `amber`, Icon `CalendarClock`, Link `/nas?tab=ablage&gruppe=fristen&from=dashboard`. Dazu Gruppe «Fristen» im Tab «Ablage» (gleiche Karte, nur sichtbar bei Einträgen): Datum, Art, Bezeichnung, Quelle, bei Vorschlag Bestätigen (Datum änderbar)/Verwerfen, bei aktiv Erledigt. Leser umstellen: Cron (`erinnert` statt `frist_erinnert`, nur `aktiv`), Büro-Bildschirm (`fristen_30_tage` nur `aktiv`), Upload schreibt in `ablage_fristen` (`quelle ablage`, `aktiv`); Backfill nochmals | `src/lib/dashboard-admin-data.ts`, `src/app/api/dashboard/route.ts`, `src/components/dashboard/{typen.ts,aufmerksamkeit-karte.tsx}`, `src/components/nas/fristen-gruppe.tsx`, `src/app/api/ablage/fristen/route.ts`, `src/app/api/cron/ablage-fristen/route.ts`, `src/app/api/bildschirm/daten/route.ts`, `src/app/api/ablage/upload/route.ts` | **Dashboard-Dateien sind Mobile-Gebiet: vorher abstimmen.** Cron-Stufen 30/7/0 auf der neuen Tabelle per Unit-Test; Zähler Bildschirm vorher = nachher |

### Etappe 4 — Nachtarbeit (alles hinter `KI_JOB_*`)

| Paket | Inhalt | Dateien (Rig) | Tests / Abnahme |
|---|---|---|---|
| E4.1 | Kontext holen (Alter ≤ 60 min), Melde-Puffer, Backoff | `fsm.py` (`hole_kontext`, `melde_nachtarbeit`), neu `dienst/app/nachtarbeit.py` | Kontext zu alt → kein Lauf; Puffer überlebt Neustart |
| E4.2 | Zweiter Blick Ablage: heute neu im Index aufgetauchte Dateien mit sha256 in `ablage_vorschlaege`; Hauptmodell entscheidet unter ≤ 5 Kandidaten der Rangliste (gleicher Kern wie `ablage_analyse`, ohne Download, Text aus `archiv_text`); weicht es mit Sicherheit ≥ mittel vom tatsächlichen Ordner ab → Vorschlag `nachpruefung` | neu `jobs/zweiter_blick.py` | nie `ZZ_*` als Ziel; Ziel ≠ Ist |
| E4.3 | Fristen: Regex-Vorfilter (kündbar, Kündigung, Laufzeit, gültig bis, Ablauf, Vertragsende, verlängert sich, Frist, zahlbar bis) auf `archiv_text`, dann Hauptmodell → Dokumentkarte + Bedingungen; Prüfung gegen Erfindung; Meldung | neu `jobs/fristen.py` | erfundenes Datum/Zahl → verworfen; Minimierung `partei`; Idempotenz |
| E4.4 | Rückstau ZZ: 368 Dateien unter `ZZ_*`, ein Durchlauf mit Denkmodus, Ziel nur aus der aktiven Liste, Sicherheit: Regel = hoch, Modell und Rangliste einig = hoch, sonst mittel/niedrig; kein Ziel → keine Meldung | neu `jobs/zz.py` | nie `ZZ_*`/inaktiv als Ziel; Liste veraltet → kein Lauf |
| E4.5 | Selbsttest 05:30: 40 Dateien (rotierender Seed, Zwillinge aus, beide Namensvarianten) mit den Produktionsmodellen + Egress-Test (`api.anthropic.com` muss scheitern) | neu `jobs/selbsttest.py` | Kennzahlen in `/health`, nichts ans FSM |
| E4.6 | Belege zweiter Blick: **nur nach Abstimmung mit der Mobile-Session** (Belege sind deren Gebiet; die Belegbilder liegen im Bucket `documents`). Bis dahin Messung über eine Testmenge (30–40 echte Belege mit bestätigten Werten, gemma3:4b gegen Gemma 4), Ergebnis als Kennzahl | — | — |
| E4.7 | Duplikate-Liste (später): exakt (sha256) und fast (Kosinus > 0,97 und MinHash > 0,9), nur Liste auf dem Rig, nie löschen; Anzeige im FSM erst nach Freigabe | neu `jobs/duplikate.py` | ohne LLM |

**Reihenfolge der Freischaltung:** E1 → E2.0/E2.1/E2.2/E2.3 → E2.4 (Messung, Entscheid Tag/GPU) → E2.5/E2.6 →
`KI_SUCHE_AKTIV=1` → E3.1 → `KI_ARCHIV_FRAGE_AKTIV=1` → E3.3 → E4.1 → E4.2/E4.4 → E3.2 →
E4.3 → E3.4 → E4.5. Die UI eines Pakets geht erst live, wenn die zugehörige Rig-Art bzw. der Job eine Nacht
fehlerfrei gelaufen ist.

---

## 7. Offen (vor dem jeweiligen Paket klären)

1. **Leos OK (§17)** vor E3.4 und E4.2: Gruppe «Fristen» im Tab «Ablage» (Bestätigen der KI-Fristen) und
   Anzeige des Zweiten Blicks als Gruppe «Zweiter Blick» neben «Rückstau ZZ» (gleiche Karte). Beides folgt
   dem von Mischa freigegebenen Muster, ist aber eine sichtbare Ergänzung.
2. **Mobile-Session:** Dashboard-Zeile (E3.4) und Belege zweiter Blick (E4.6).
3. **Mischa/Leo:** 20–30 echte Suchanfragen mit erwarteter Datei (E2.6); Testmenge Belege (E4.6).
4. **SPEC-Übertrag E1.0** nach Abschluss des anderen Agenten an `SPEC.md`.
5. Ergebnis E2.0 (24-h-Profil): öffnet das 20-GB-Tor nachts zu selten, entscheidet Mischa über 64 GB RAM
   (ca. CHF 203); bis dahin arbeitet der 12B-Rückfall.
