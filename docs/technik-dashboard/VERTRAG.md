# Technik-Dashboard · VERTRAG (verbindlich für alle drei Bau-Agenten)

Stand 12.10.2026. Freigabe Mischa: «ja baue alles, alles was ich machen muss mache ich am Ende».
Gebaut wird die echte Seite `/technik` nach dem freigegebenen Entwurf «digitaler Zwilling»:
`C:\tmp\eventline-technik-dashboard\project\Main.dc.html` (dunkel), `Hell.dc.html` (hell), Generator `gen-main.mjs`,
Regeln `spec.md` §3, Plan `Plan.dc.html`. Dieser Vertrag geht bei Widerspruch dem Entwurf und `spec.md` vor.

Drei Agenten bauen parallel. Jeder fasst **nur seine Dateien** an (§0). Wer eine fremde Datei braucht, baut gegen
diesen Vertrag und nicht gegen den Stand der anderen.

---

## 0. Zuständigkeiten (disjunkt)

| Agent | Dateien (nur diese) |
|---|---|
| **A · FSM-Backend** | `supabase/migrations/313_technik_dashboard.sql` (Nummer ist belegt, Datei liegt schon da) · `src/lib/technik-dashboard/typen.ts` (zuerst, 1:1 aus §2.4 und §6.2) · `src/lib/technik-dashboard/{konstanten,paket,ampeln,stand-server,alarme}.ts` + Tests `paket.test.ts`, `ampeln.test.ts` · `src/app/api/technik/messwerte/route.ts` · `src/app/api/technik/stand/route.ts` · `src/app/api/cron/technik-alarme/route.ts` · `vercel.json` (+1 Cron) · `src/app/api/cron/db-retention/route.ts` (+1 RPC-Aufruf) · `src/lib/notification-service.ts` (+2 Funktionen) · `src/lib/notification-meta.ts` (+1 Typ) · `src/types/index.ts` (+1 Union-Wert) |
| **B · Seite** | `src/app/(app)/technik/page.tsx` · `src/app/(app)/technik/loading.tsx` · `src/components/technik-dashboard/**` · `src/lib/constants.ts` (+1 Eintrag in `ADMIN_NAV_GROUP`) · `src/lib/permissions.ts` (`ADMIN_ONLY_PREFIXES` + Kommentar) · `src/lib/nav-icons.ts` (+`Server`) |
| **C · Rig** | `rig/eventline-ki/messung/technik_sammler.py` (neu) · `rig/eventline-ki/systemd/eventline-ki-technik.service` (neu) · `rig/eventline-ki/install.sh` (additiv) · `rig/eventline-ki/README.md` (neuer Abschnitt) · `rig/eventline-ki/dienst/app/technik.py` (neu) · `rig/eventline-ki/dienst/app/{main.py,llm.py,config.py}` (nur additive Mini-Änderungen) · `rig/eventline-ki/dienst/tests/test_technik.py` (neu) |

**Namensraum:** `src/lib/technik.ts` und `technik-server.ts` gehören der Technik-*Planung* (Aufträge, Lieferantenportal,
Migration 263). Das Dashboard benutzt ausschliesslich `technik-dashboard/` bzw. die Tabellen `technik_*` aus 313
(die Planung heisst `job_technik_*`, keine Kollision). Route `/technik` und `/api/technik/*` sind frei
(die Planung liegt unter `/api/jobs/[id]/technik`).

**Für alle:** Kein git schreibend (die Eltern-Session committet, pusht und spielt 313 ein). `main` = LIVE, DB geteilt
mit Prod. Keine Secrets ausgeben. Keine Hostnamen, IP- oder MAC-Adressen, Freigabe-Namen, Hauspfade in Paket, UI
oder Logs. App-`ANTHROPIC_API_KEY` nie verwenden. Nie Passwörter ändern. NAS nie einloggen.

---

## 1. Datenweg

```
Rig-Host                                  KI-Dienst (Container)                    FSM (Vercel)                         Seite /technik
technik_sammler.py ──(alle 10 s, atomar)──► /data/technik/stand.json ──(alle 60 s)──► POST /api/technik/messwerte ─► technik_stand
 (systemd eventline-ki-technik.service)    + Ollama /api/ps,/api/tags,/api/version   rigAuthFehler (KI_SYNC_TOKEN)     technik_messwerte (Minute)
 NAS-Basis 60 s · SNMP 5 min (ruhend)      + eigener Zustand, Tempo, Antwortzeit     Ereignisse ableiten                technik_ereignisse
                                           über Ausgang (egress) + Rig-Anmeldung                                        ▲
                                                                                    GET /api/technik/stand ◄──(15 s, nur sichtbarer Tab, nur Admin)
                                                                                    Cron technik-alarme (5 min) ─► technik_zustaende, Mitteilung + Mail
                                                                                    Cron db-retention (täglich) + technik-alarme (stündlich) ─► technik_verdichten()
```

### 1.1 Sammler auf dem Rig-Host (Agent C)

- `rig/eventline-ki/messung/technik_sammler.py`, **nur Python-3-Standardbibliothek**, läuft als Dauerdienst
  `eventline-ki-technik.service` (`Type=simple`, `Restart=always`, `RestartSec=10`, `Nice=10`,
  `IOSchedulingClass=idle`, `MemoryMax=96M`, `CPUQuota=10%`, `ConditionPathIsMountPoint=/srv/eventline-ki/data`,
  `After=docker.service`; Härtung so weit, wie die Messung es erlaubt, auf dem Rig geprüft). Ein Dauerdienst statt
  Timer, weil 5- und 10-Minuten-Mittel einen Speicher über mehrere Messungen brauchen. Muster für Unit, Kopfkommentar
  und Installation: `eventline-ki-speicherprofil.{service,timer}` und `messung/speicherprofil.sh`.
- **Ausgabe:** `/srv/eventline-ki/data/dienst/technik/stand.json` (Ordner `root:1500 0750`, Datei `root:1500 0640`).
  Der KI-Dienst sieht sie ohne Compose-Änderung als `/data/technik/stand.json` (bestehender Mount
  `/srv/eventline-ki/data/dienst:/data`). Schreiben **atomar**: `stand.json.tmp` im selben Ordner, `fsync`,
  `os.replace`. Ist der Tresor nicht eingehängt, wird nichts geschrieben.
- **Inhalt der Datei** = der Block `rig` und der Block `nas` aus §2 (fertig validierbar), dazu `minute` (§2.3).
- **Takte:**

| Was | Takt | Quelle |
|---|---|---|
| Prozessor (Temperatur Paket/Kerne/Chipsatz, Last, Takt, Drosselzähler), RAM (`/proc/meminfo`, PSI, `pswpin`/`pswpout` — seit 15.10.2026 statt `pgmajfault`), Netz/Platte-Zähler, Slices | 10 s | `/sys/class/hwmon`, `/proc/stat`, `/proc/cpuinfo`, `/sys/devices/system/cpu/cpu*/thermal_throttle/package_throttle_count`, `/proc/pressure/memory`, `/proc/vmstat`, `/proc/net/dev`, `/proc/diskstats`, cgroup-Dateien |
| Grafikkarte | 10 s | `nvidia-smi --query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,power.limit,fan.speed,pstate,driver_version,clocks.gr,clocks.max.gr --format=csv,noheader,nounits` (nie `name`) |
| Dienste | 30 s | `docker ps -q --filter label=com.docker.compose.project=eventline-ki` + `docker inspect` (wie speicherprofil.sh), Speicher je Container aus der cgroup des PID |
| Platten-Belegung System/Tresor | 60 s | `os.statvfs` auf `/` und `/srv/eventline-ki/data` |
| SSD-Gesundheit und -Temperatur | 5 min | `smartctl -H -A --json` (smartmontools darf installiert werden; fehlt es → `ssd.status = "nicht_verfuegbar"`) |
| RAM-Module | beim Start, dann 1×/Tag | `dmidecode -t memory` → nur Steckplatz-Nummer und Grösse in GB (nie Hersteller, Teilenummer, Seriennummer) |
| NAS-Basis | 60 s, **eigener Unterprozess, hartes Zeitlimit 5 s** | `statvfs` auf eine eingehängte Freigabe (alle liegen auf demselben Volume), Liste der aktiven Einhängungen unter `/mnt/eventline-nas`, TCP-Verbindungstest Dateifreigabe und Weboberfläche **ohne Login** |
| NAS-SNMP | 5 min, eigener Unterprozess, Zeitlimit 10 s | siehe §1.3 (nur, solange keine Mess-Container eingerichtet sind) |
| NAS-Mess-Container (Exporter) | 60 s, eigener Unterprozess, hartes Zeitlimit 15 s (je Verbindung 6 s) | siehe §1.4 — Vorrang vor SNMP |
| Geladene KI-Modelle (§2.7) | `/api/ps` 10 s (Zeitlimit 3 s je Instanz), Prozesse 10 s, Manifeste höchstens alle 5 min | Ollama `GET /api/ps` beider Instanzen im internen Netz; `/proc/<pid>/{comm,cmdline,stat,status}` nur für PIDs aus `cgroup.procs` der zwei Ollama-Container; Manifeste unter `/srv/eventline-ki/data/ollama/models/manifests` (Blob → Modellname) |
| Leistung der lokalen KI (§2.6) | 10 min, Zeitlimit 30 s | `docker exec` in den Container «datenbank» (ID aus der Dienst-Abfrage, nur Label `eventline-ki`), `psql` mit `PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=8000`: nur Zähler, Dauern, Seiten/Zeichen, Grössen und Selbsttest-Anteile aus `ki_protokoll`, `archiv_text`, `archiv_karte`, `selbsttest_laeufe` — nie Pfade, Namen, Texte |

- **Lüftersensor:** Nur wenn ein Treiber ohne Kernel-Parameter und ohne Neustart lädt (z. B. `modprobe` des
  Super-I/O-Treibers) und danach `fan*_input` in hwmon erscheint. Dann dauerhaft über
  `/etc/modules-load.d/eventline-technik.conf`. Sonst bleibt `cpu.luefter_rpm` weg (Seite: «kommt mit Freigabe am Rig»).
- **Trust one nur als Summe:** gelesen werden ausschliesslich `system-trustone.slice/{memory.current,memory.high,memory.max,cpu.stat}`
  und seit 15.10.2026 aus `memory.stat` der Slice die Zeile `anon` (fester Speicher, Summe; für die Belegung §2.7).
  Keine Trust-Container, keine Prozesse, keine Logs, keine Bedienung. `docker`-Abfragen sind strikt auf das Label
  `com.docker.compose.project=eventline-ki` gefiltert.
- **Dienst-Namen generisch** (Abbildung im Sammler, Einweg-Container `ollama-modelle`/`whisper-modelle` werden ignoriert):

| Container | `name` im Paket | Anzeige (Seite) |
|---|---|---|
| eventline-ki-dienst | `ki_dienst` | KI-Dienst |
| eventline-ki-ollama | `ollama_schnell` | Ollama schnell |
| eventline-ki-ollama-gruendlich | `ollama_gruendlich` | Ollama gründlich |
| eventline-ki-whisper | `whisper` | Whisper (Sprache) |
| eventline-ki-db | `datenbank` | Datenbank |
| eventline-ki-caddy | `webserver` | Webserver |
| eventline-ki-egress | `ausgang` | Ausgang |

- **Freigaben-Soll** kommt aus der Einhänge-Konfiguration (Mount-Units unter `/etc/systemd/system` für
  `/mnt/eventline-nas/*`), nie aus dem Ist. Lässt sich das Soll nicht bestimmen → `soll: null`.
- **Logs** (journal): nur Zustandswörter und Zahlen, keine Adressen, keine Pfade unter `/mnt`, keine Fehlertexte von smbclient/snmp.

### 1.2 KI-Dienst ergänzt und sendet (Agent C)

- Neues Modul `dienst/app/technik.py` mit einem Thread «Technik-Melder», gestartet und gestoppt in `main.py`
  (`lebenszyklus`, je 1–3 Zeilen, **vor jeder Änderung neu lesen**, ein zweiter Workflow arbeitet an `jobs`/`planer`).
  Schalter in `config.py` (additiv): `KI_TECHNIK_AKTIV` (Standard an), `KI_TECHNIK_DATEI` (Standard `/data/technik/stand.json`).
- Alle **60 s**: Datei lesen (fehlt/kaputt → `rig`/`nas` weglassen, nie abbrechen), Ollama beider Instanzen nur über
  `GET /api/ps`, `/api/tags`, `/api/version` (Zeitlimit 3 s; **nie** `/api/generate` o. ä., das würde laden),
  eigenen Zustand ergänzen (laufender Auftrag, Warteschlange, Archiv- und Tiefen-Index-Stand, Schalter,
  Hauptmodell geladen, seit 15.10.2026 eigene Hintergrundarbeit `hintergrund` §2.7) → Block `ki`.
- **Tempo:** `llm.py` merkt sich nach jeder eigenen Ollama-Antwort `eval_count`/`eval_duration` als
  `letztes_tempo = {tokens_s, modell, am}` (modulweite Variable mit Lock, +wenige Zeilen; die Werte liegen dort schon vor,
  siehe `llm.py` «antwort_tokens»/«antwort_ms»).
- **Senden:** eigener `httpx.Client` nach dem Muster `FsmClient` in `fsm.py` (gleiche `cfg.fsm_url`, `cfg.proxy`,
  `trust_env=False`, Header `Authorization: Bearer {cfg.sync_token}`, `User-Agent: eventline-ki/{VERSION}`),
  Zeitlimit 15 s. `fsm.py` wird **nicht** geändert. `POST /api/technik/messwerte`, Body = Paket §2.
  Die Laufzeit dieses POST ist der Messwert `ki.fsm_antwort_ms` im **nächsten** Paket; Fehlschläge zählen
  `ki.fsm_fehler_in_folge`. Bei 401/503/Netzfehler: loggen (nur Statuscode), weiter im Takt, kein Nachsenden alter Pakete.
- Es wird **nichts** an den 2-s-Herzschlag `/api/ki/sync` gehängt.

### 1.3 NAS-SNMP (Agent C) — gebaut, aber RUHEND

- SNMP **v3, nur lesend** (`authPriv`), Client-Werkzeug `snmpget`/`snmpwalk` (Paket `snmp`, nur Client, **kein** `snmpd`)
  darf installiert werden.
- Zugangsdaten nur in `/etc/eventline-ki/technik-snmp.env` (root `0600`):
  `NAS_SNMP_BENUTZER`, `NAS_SNMP_AUTH_PROTOKOLL` (SHA/SHA-256), `NAS_SNMP_AUTH_PASSWORT`, `NAS_SNMP_PRIV_PROTOKOLL`
  (AES), `NAS_SNMP_PRIV_PASSWORT`. Die Adresse des NAS liest der Sammler aus der Einhänge-Konfiguration; sie verlässt
  den Sammler nie. Die Datei wird alle 5 min neu gelesen (Einschalten ohne Neustart).
- Datei fehlt → `snmp.status = "nicht_eingerichtet"`, **keine** Abfrage. Datei vorhanden, aber unvollständig/ungültig
  (Feld fehlt, Passwort < 8 Zeichen oder mit Leerzeichen/#/Anführungszeichen, Protokoll unbekannt, Rechte nicht
  root 0600) → `"nicht_eingerichtet"` mit `grund: "zugang_ungueltig"`, keine Abfrage; der Sammler loggt je
  Zustandswechsel eine Warnung mit Feldname und Grund (nie Werte). Werkzeug fehlt →
  `"nicht_eingerichtet"` mit `grund: "werkzeug_fehlt"`. Zeitüberschreitung/Anmeldefehler → `"fehler"` mit `grund`.
- Abgefragt werden nur Standard-MIBs (HOST-RESOURCES, UCD-SNMP, LM-SENSORS, soweit vorhanden): Systemtemperatur,
  Plattentemperaturen je Schacht, Plattengesundheit, Pool/RAID-Zustand, Last, RAM-Belegung, Laufzeit.
  Was nicht lesbar ist, fehlt im Paket (Seite: «nicht lesbar»). **Nie** Modell, Seriennummer, Systemname,
  Hersteller oder Versionstexte.

### 1.4 NAS-Hardware über Mess-Container (Nachtrag 13.10.2026, Vorrang vor SNMP)

UGOS Pro bietet SNMP nur als Client (für USVs), nicht als Agent. Darum laufen auf dem NAS zwei kleine, nur lesende
Container (UGOS-Docker-App › Projekt, Dateien `rig/eventline-ki/nas-messung/`, Anleitung dort im README):
`prom/node-exporter` (Port 9100: hwmon, mdadm, filesystem `/volumeN`, meminfo, cpu, stat) und
`prometheuscommunity/smartctl-exporter` (Port 9633: nur SATA `sd*`, schlafende Platten werden nicht geweckt, SMART
höchstens alle 5 min), beide fest gepinnt, mit Basic-Auth (bcrypt-Hash in der Compose-Datei), `network_mode: host`
(damit die UGOS-Firewall die Ports filtert; Freigabe nur für die Adresse des Rigs).

- Zugang nur in `/etc/eventline-ki/technik-nas.env` (root `0600`): `NAS_EXPORTER_BENUTZER`, `NAS_EXPORTER_PASSWORT`
  (12–128 Zeichen, ohne Leerzeichen/#/Anführungszeichen), optional `NAS_EXPORTER_ADRESSE` (leer = Adresse aus der
  Einhänge-Konfiguration), `NAS_EXPORTER_PORT_SYSTEM` (9100), `NAS_EXPORTER_PORT_PLATTEN` (9633), `NAS_SCHAECHTE`
  (eingebaute Schächte, ganze Zahl 1–16, Standard 4). Erzeugt von
  `nas-messung/zugang-erzeugen.sh` (Zufallspasswort, nie angezeigt; ins NAS kommt nur der Hash). Neu gelesen alle 60 s.
- Datei fehlt → alles wie bisher (SNMP-Pfad §1.3, ohne dessen Datei `snmp.status = "nicht_eingerichtet"`). Datei da, aber
  ungültig (Feld, Länge, Zeichen, Adresse, Port, Schachtzahl, Rechte nicht root 0600) → `"nicht_eingerichtet"` mit
  `grund: "zugang_ungueltig"`, keine Abfrage, Journal-Warnung je Zustandswechsel mit Feldname und Grund (nie Werte).
- Abfrage im Kind (`--exporter-probe`, Zugang über stdin, kein Proxy, keine Weiterleitungen): das Kind wertet aus und
  gibt nur Zahlen/Zustandswörter zurück. 401/403 → `anmeldung`, Zeitüberschreitung → `zeitlimit`, keine Verbindung →
  `keine_antwort`, sonst `unbekannt`. Liefert einer der beiden Container, ist `status = "ok"` (was fehlt, zeigt die
  Seite als «nicht lesbar»); scheitern beide → `"fehler"` mit dem hilfreichsten Grund (anmeldung vor keine_antwort vor
  zeitlimit).
- Werte in denselben Block `nas.snmp` (Name bleibt aus Kompatibilität), dazu `quelle: "exporter"` (SNMP setzt
  `quelle: "snmp"`, sobald sein Zugang da ist): `cpu_temp_c` (hwmon coretemp/k10temp, Paket vor Kernen),
  `system_temp_c` (Board-Fühler: Super-I/O vor Chipsatz vor acpitz; unbeschaltete 0/±128/127 °C verworfen; Platten-,
  NVMe-, RAM-, Netzwerk-Fühler zählen nicht), `last_prozent` (Rate der CPU-Zeit zwischen zwei Abfragen, Leerlauf =
  idle + iowait), `ram_prozent` (MemTotal − MemAvailable), `uptime_s`, `raid` (schlechtester md-Verbund:
  recovering/resync → `wiederaufbau`, fehlende/ausgefallene Platte oder inactive → `degradiert`, active/check →
  `normal`), `platten[]` je SATA-Platte: `schacht` = Buchstabe (sda = 1, sdb = 2 …, stabil auch bei schlafender Platte),
  `temp_c`, `gesundheit` (SMART nicht bestanden oder «DISK FAILING» → `fehler`; umgelagerte/ausstehende/nicht
  korrigierbare Sektoren > 0, Vorwarn-Attribut jetzt/früher unter Schwelle oder Selbsttest-Fehler → `warnung`),
  `betriebsstunden`, `umgelagert` (5), `ausstehend` (197), `nicht_korrigierbar` (198), `crc_fehler` (199),
  `extern: true` (nur gesetzt, sonst fehlt das Feld) für jede Platte mit `schacht` > `NAS_SCHAECHTE`. Annahme:
  sda … sdN sind die N eingebauten Schächte, alles danach ist extern (USB, z. B. die Sicherungsplatte); `schacht`
  bleibt auch dann die Gerätenummer (stabil). Die Seite zeigt externe Platten nicht in einem Schacht, sondern als
  «USB-Platte» (bei mehreren «USB-Platte 1», «USB-Platte 2» nach Gerätenummer); in die Ampeln Plattentemperatur und
  Plattengesundheit zählen sie mit denselben Grenzen, die Texte nennen sie «USB-Platte (n)», Schächte «Schacht 0n».
  Liefert die Freigabe kein Volume (§1.1), setzt der Sammler `nas.volume` aus dem grössten `/volumeN` des Exporters.
- **Nie** ins Paket oder Log: Geräte-, Modell-, Seriennummern-, Fühler- und Chipnamen, Mount-Pfade, Adressen.

---

## 2. Paket (POST /api/technik/messwerte)

### 2.1 Regeln

- JSON, `Content-Type: application/json`, **höchstens 64 KiB** (sonst 413). Feld `v` = Schemaversion, heute `1`
  (anderes `v` → 400 `{"success":false,"error":"version"}`).
- Anmeldung: `rigAuthFehler(request)` aus `src/lib/ki/rig-auth.ts` als erste Zeile (Bearer `KI_SYNC_TOKEN`,
  timing-safe; 503 ohne Secret, 401 bei falschem Token). **Kein neuer Schlüssel.**
- **Alle Felder optional-tolerant:** Fehlende Blöcke/Felder sind normal (Sensor fehlt, NAS hängt). Unbekannte Felder
  werden still verworfen. Zahlen werden auf Plausibilitätsbereiche geklemmt oder verworfen (Temperaturen −20…150 °C,
  Prozent 0…100, Bytes 0…2^53, Zähler ≥ 0). Strings nur über Weißlisten/Regex:
  Modellnamen `/^[a-z0-9][a-z0-9._:\/-]{0,79}$/i`, `pstate` `/^P\d{1,2}$/`, `treiber`/`version` `/^[0-9][0-9a-z.+-]{0,39}$/i`,
  Auftragsart ∈ `KI_ARTEN` (`src/lib/ki/konstanten.ts`), Dienst-Namen ∈ Tabelle §1.1, Zeitstempel ISO und
  höchstens 5 min in der Zukunft. Arrays gekappt: `dienste` 12, `modelle` 50, `geladen` 10, `platten` 8, `module` 8,
  `luefter_rpm` 8. **Zod ist im Projekt nicht vorhanden** → handgeschriebene Leser in `paket.ts`
  (`lesePaket(roh: unknown): { paket: PaketV1 } | { fehler: string }`), Stil wie `src/lib/ki/bereinigen.ts`, mit Tests.
- Bytes heissen `*_b`, Temperaturen `*_c`, Prozent `*_prozent`. Alle Zeiten ISO-8601 UTC.
- Antwort: `200 {"success":true,"steuerung":{…}}` (Block `steuerung` siehe §2.5); sonst wertet der Dienst nur den Status aus.

### 2.2 Beispiel (Werte vom 12.10., gekürzt)

```json
{
  "v": 1,
  "gesendet_am": "2026-10-12T05:53:10Z",
  "rig": {
    "gemessen_am": "2026-10-12T05:53:04Z",
    "uptime_s": 53640,
    "cpu": { "temp_c": 71, "temp_c_5min": 70.4, "temp_c_max_1min": 84, "kerne_temp_c": [53, 72], "chipsatz_temp_c": 32,
             "last_prozent": 23, "last_prozent_5min": 31, "last_prozent_10min": 43, "takt_mhz": 3800, "takt_mhz_max_kern": 4800,
             "kerne": 10, "threads": 20, "drosselung": false, "anteil_kerne": { "ki": 0.8, "trustone": 2.0 } },
    "gpu": { "temp_c": 46, "temp_c_max_1min": 46, "last_prozent": 0, "vram_belegt_mib": 9, "vram_gesamt_mib": 8192,
             "watt": 20.4, "watt_grenze": 270, "luefter_prozent": 0, "pstate": "P8", "treiber": "595.91", "takt_mhz": 210, "takt_max_mhz": 2130 },
    "ram": { "eingebaut_gb": 48, "module": [{ "platz": 1, "groesse_gb": 8 }, { "platz": 2, "groesse_gb": 16, "temp_c": 42 }],
             "gesamt_b": 50465865728, "verfuegbar_b": 38440000000, "frei_b": 20100000000, "swap_gesamt_b": 8589934592, "swap_belegt_b": 279000000,
             "psi_full_avg10": 0, "psi_some_avg10": 0, "swap_ein_bps_5min": 0, "swap_aus_bps_5min": 0,
             "ki": { "belegt_b": 3650000000, "fest_b": 1400000000, "cache_b": 2250000000, "grenze_b": 23622320128, "swap_b": 322000000 },
             "trustone": { "summe_b": 11060000000, "grenze_hoch_b": 19327352832, "grenze_max_b": 21474836480 } },
    "platten": { "system": { "gesamt_b": 1967000000000, "belegt_b": 281000000000 },
                 "tresor": { "gesamt_b": 210000000000, "belegt_b": 44000000000 },
                 "ssd": { "status": "ok", "temp_c": 38, "gesundheit": "ok", "abnutzung_prozent": 3, "betriebsstunden": 4120 } },
    "io": { "gelesen_b": 62900000000, "geschrieben_b": 42100000000, "netz_rx_b": 47300000000, "netz_tx_b": 1400000000, "vpn_rx_b": 1180000000, "vpn_tx_b": 320000000 },
    "dienste": [ { "name": "ki_dienst", "zustand": "laeuft", "gesund": true, "gestartet_am": "2026-10-12T05:50:00Z", "neustarts": 0, "oom": false, "speicher_b": 83886080, "grenze_b": 4294967296 },
                 { "name": "webserver", "zustand": "laeuft", "gesund": null, "gestartet_am": "2026-10-11T18:28:00Z", "neustarts": 0, "oom": false, "speicher_b": 11534336, "grenze_b": 268435456 } ],
    "minute": { "cpu.temp": 70.8, "cpu.temp.max": 84, "cpu.last": 25.1, "cpu.last.max": 41, "gpu.temp": 46, "gpu.last": 0, "ram.verfuegbar_gb": 35.8 }
  },
  "ki": {
    "version": "0.1.0+20261012-0023", "eingestellt": "gemma3:4b",
    "instanzen": [ { "name": "schnell", "erreichbar": true, "version": "0.35.1", "grenze_b": 12884901888 },
                   { "name": "gruendlich", "erreichbar": true, "version": "0.35.1", "grenze_b": 20401094656 } ],
    "modelle": [ { "name": "gemma3:4b", "groesse_b": 3300000000 }, { "name": "gemma4:26b-a4b", "groesse_b": 15600000000 } ],
    "geladen": [],
    "auftrag": null, "warteschlange": 0, "tempo": null,
    "archiv": { "anzahl": 165, "letzter_lauf": "2026-10-12T05:51:43Z", "neu": 0, "fehler": 0, "dauer_s": 2.1 },
    "tiefen_index": { "dateien": 449, "nas_dateien": 449, "mit_text": 395, "abschnitte": 2309, "letzter_lauf": "2026-10-11T20:25:45Z", "nacht_fertig": true },
    "schalter": { "suche": true, "archiv_frage": true, "hintergrund": false, "lernen": false, "tiefe": true, "hauptmodell": false },
    "hauptmodell_geladen": false, "fsm_antwort_ms": 210, "fsm_fehler_in_folge": 0
  },
  "nas": {
    "gemessen_am": "2026-10-12T05:53:00Z", "erreichbar": true, "fehlversuche_in_folge": 0,
    "dateifreigabe": true, "weboberflaeche": true,
    "volume": { "gesamt_b": 7968531677184, "belegt_b": 532500000000 },
    "freigaben": { "soll": 21, "ist": 21, "schreibend": 11, "lesend": 10, "fehlt_seit": null },
    "snmp": { "status": "nicht_eingerichtet" }
  }
}
```

### 2.3 Minutenwerte (`rig.minute`, und abgeleitet für `ki`/`nas`)

Der Sammler bildet aus den 6 Messungen der letzten Minute Mittel (Schlüssel ohne Endung) und Maximum (Endung `.max`).
Nur diese Schlüssel werden gespeichert (`MINUTEN_SCHLUESSEL` in `konstanten.ts`, andere verworfen):

| Quelle | Schlüssel |
|---|---|
| rig (vom Sammler) | `cpu.temp`, `cpu.temp.max`, `cpu.last`, `cpu.last.max`, `cpu.takt_mhz`, `gpu.temp`, `gpu.temp.max`, `gpu.last`, `gpu.last.max`, `gpu.vram_mib`, `gpu.watt`, `ram.verfuegbar_gb`, `ram.ki_gb`, `ram.ki_fest_gb`, `ram.trustone_gb`, `ram.swap_gb`, `ram.psi_full`, `ram.psi_full.max`, `ram.swap_ein_bps`, `ram.swap_aus_bps` (Bytes/s aus `pswpin`/`pswpout`, seit 15.10.2026; `ram.seitenfehler_s[.max]` entfallen), `netz.rx_bps`, `netz.tx_bps`, `platte.lesen_bps`, `platte.schreiben_bps`, `ssd.temp`, `kuehlung.kuehlmittel_c`, `kuehlung.pumpe_rpm`, `kuehlung.luefter_rpm` (Mittel aller Lüfter, §2.5) |
| ki (vom FSM aus dem Block `ki` abgeleitet) | `ki.warteschlange`, `ki.geladen_gb`, `ki.tokens_s`, `ki.fsm_antwort_ms` |
| nas (vom FSM abgeleitet, nur wenn `nas.gemessen_am` neu) | `nas.belegt_prozent`, `nas.system_temp`, `nas.platte_temp.max`, `nas.last` |

GB-Werte hier binär (GiB), wie das System zählt; Anzeige siehe §6.4.

### 2.5 Kühlung und Lüfter-Profil (Nachtrag 14.10.2026, Mischa)

Das Rig steuert Lüfter und Pumpe nach Temperatur (Profile), alle LEDs sind aus. **Rig → App** im Block `rig`
(alle Zahlen optional; zusätzlich füllt das Rig `rig.cpu.luefter_rpm` mit den Radiator-Lüftern):

```json
"kuehlung": {
  "status": "ok" | "fehler" | "nicht_eingerichtet", "grund": "<Code, optional>",
  "profil_aktiv": "leise" | "ausgewogen" | "kuehl",
  "luefter": [ { "nr": 1, "ort": "radiator" | "front" | "heck" | "boden" | "unbekannt", "rpm": 1234, "prozent": 40 } ],
  "pumpe_rpm": 2100, "pumpe_prozent": 60, "kuehlmittel_c": 31.5,
  "leds": "aus" | "an" | "unbekannt"
}
```

Validierung (`paket.ts`): ohne gültigen `status` fällt der Block weg; `grund` nur `/^[a-z][a-z0-9_]{0,39}$/` (Code,
nie Fehlertext); unbekanntes `profil_aktiv`/`leds` fällt weg, unbekannter `ort` wird `unbekannt`; `luefter` höchstens
12, `nr` 1–99 (fehlt sie: Lage in der Liste), doppelte Nummern einmal; Drehzahlen 0–30’000 ganzzahlig, Prozent
geklemmt, Kühlmittel −20…150 °C. Minutenreihen siehe §2.3.

**App → Rig:** Die Antwort auf `POST /api/technik/messwerte` enthält
`"steuerung": { "luefter_profil": "leise" | "ausgewogen" | "kuehl", "stand": "<ISO>" }` — das gewünschte Profil aus
`technik_steuerung` (Migration 318, Standard «ausgewogen», `stand` = Zeitpunkt der letzten Änderung). Ist die
Einstellung nicht lesbar, fehlt `steuerung`; das Rig behält dann sein aktives Profil. Das Rig übernimmt binnen
≤ 2 min und meldet `profil_aktiv`. Gesetzt wird das Profil auf der Seite (`POST /api/technik/steuerung`,
`{ "luefter_profil": … }`, nur Admins, setzt `geaendert_von`/`geaendert_am`); `GET /api/technik/stand` liefert
`steuerung: { luefter_profil, geaendert_am } | null`.

### 2.6 Leistung der lokalen KI (Nachtrag 15.10.2026, Mischa: «wie gut ist deine KI»)

Der Sammler rechnet alle 10 min aus der Rig-DB (§1.1, nur lesend) und legt das Ergebnis in **`rig.leistung`** — der
KI-Dienst reicht den Block `rig` unverändert weiter, im Dienst ist nichts zu ändern. Nur Zahlen und Zeitpunkte:

```json
"leistung": {
  "stand": "2026-10-15T15:44:47Z",            // Auswertung auf dem Rig
  "seit": "2026-10-02T20:50:50Z",             // erster Protokoll-Eintrag = Beginn der Messung
  "zeitraeume": {
    "7d": {
      "auftraege": [ { "art": "nas_suche", "n": 41, "ok": 41, "median_ms": 59, "max_ms": 6235 },        // ki_protokoll
                     { "art": "nacht_zz", "n": 282, "ok": 282, "median_ms": 3958, "max_ms": 13594,
                       "mit_seiten": 270, "ms_seite_text": 1830, "ms_seite_gescannt": 4100,             // seit 15.10.
                       "seiten_max": 22, "zeichen_max": 61234, "teile_max": 7 } ],
      "gelesen": { "dateien": 449, "mit_text": 395, "gescannt": 88, "seiten": 668, "seiten_max": 80,   // archiv_text
                   "zeichen_max": 206385, "mb_max": 17.5, "gemessen": 12, "s_seite_text": 0.21,
                   "s_seite_gescannt": 3.4, "s_datei_median": 0.9, "s_datei_max": 61.5 },
      "fristen_geprueft": { "dateien": 395, "mit_frist": 73 },                                           // archiv_karte
      "selbsttest": { "laeufe": 3, "top1": 0.533, "top3": 0.683, "top1_ohne_name": 0.4, "top3_ohne_name": 0.6, "ms_median": 4603 }
    },
    "30d": { … }, "alle": { … }
  },
  "selbsttest": [ { "am": "2026-10-15T03:37:46Z", "dateien": 40, "top1": 0.45, "top3": 0.65,
                    "top1_ohne_name": 0.325, "top3_ohne_name": 0.575, "ms_median": 4355 } ]          // neueste zuerst, höchstens 30
}
```

- **Auftraege:** Arten nur aus der Weissliste `KI_ARTEN` + `nacht_fristen`, `nacht_zz`, `sicherheit_rapport` (je Art
  einmal, höchstens 12), `ok ≤ n`, Dauern ganzzahlig 0…24 h (Median/Längste nur der erfolgreichen).
- **Dokumente der Aufträge** (Nachtrag 15.10. abends, `ki_protokoll.seiten/zeichen/gescannt/teile`, nur Arten mit
  Dokument: `ablage_analyse`, `beleg_analyse`, `warenkorb_analyse`, `nacht_zz`): über die erfolgreichen Aufträge mit
  Seitenzahl `ms_seite_text`/`ms_seite_gescannt` = Median der ganzen Rechenzeit / Seiten des Dokuments, `seiten_max`,
  `zeichen_max` (Länge des gelesenen Texts), `teile_max` (Rückstau ZZ liest in Teilen zu 10 000 Zeichen; Ablage, Beleg: 1),
  `mit_seiten ≤ ok`. Ein Beleg-Foto zählt als 1 Seite, gescannt, ohne Zeichen. Eigene SQL-Anweisung — fehlt die Spalte
  (Dienst noch nicht neu gestartet), fehlen nur diese Felder.
- **Gelesen** (Tiefen-Index, Dateien ohne Lesefehler, `extrahiert` im Zeitraum): Zähler und grösste Werte. **Lesezeit
  seit 15.10. exakt** (`archiv_text.dauer_ms` = Dauer der Textextraktion im Kindprozess, mit Texterkennung; ohne Prüfsumme,
  Zerlegen, Einbetten und Warten): `gemessen` = Dateien mit Messung (≤ `dateien`), je Seite = Dauer / gelesene Seiten
  (gescannt: min(Seiten, N) — der Index erkennt höchstens die ersten N Seiten, N aus dem Text-Rezept «ocrN»), getrennt nach
  Text und gescannt, je Datei Median und Längste. Übernommene (verschoben, gleicher Inhalt) und unlesbare Dateien haben
  keine Lesezeit, ältere Zeilen auch nicht (nie nachträglich geschätzt). Ohne `gemessen` (Rig ohne Messung) keine Zeiten —
  der frühere Abstand der Zeitstempel ist weg.
- **Selbsttest:** Anteile 0…1 (mit Dateinamen `top1`/`top3`, ohne `*_ohne_name`), Mittel je Zeitraum und die Läufe.
- **Belegquote** (Nachtrag 16.10.2026, Rezepte `zz/v4` und `fristen/v3`, `ki_protokoll.belege`): je Zeitraum
  `"belege": { "zz": 40, "fristen": 21, "felder": { "datum": { "angegeben": 30, "belegt": 27 }, …, "fristen": {…} } }` —
  `zz`/`fristen` = erfolgreiche Nachtarbeit-Schritte mit Belegen, je Feld (Datum, Zeitraum, Status, Bezug, Absender,
  Empfänger, Beteiligte, Rolle, Fristen) die Angaben der lokalen KI und davon die mit wörtlicher Belegstelle im gelesenen
  Teil — Beleg der KI, sonst der Wert selbst im Teil (`belegt ≤ angegeben`, unbekannte Felder fallen weg). Ohne eine
  Datei mit Belegen fehlt der Block. Eigene
  SQL-Anweisung — fehlt die Spalte (Dienst noch nicht neu gestartet), fehlt nur dieser Teil.
- **Zweiter Blick** (Nachtrag 16.10.2026, Tabelle `zweiter_blick` im Tresor): je Zeitraum
  `"zweiter_blick": { "anders": 100, "gleich": 17, "entschieden": 0, "zu_lang": 0, "fristen_neu": 0, "ms_median": 82400 }`
  — vom Hauptmodell nachgelesene Dokumente je Ergebnis, Fristen nur vom grossen Modell, Median der Dauer (nur
  anders/gleich). Ohne ein Dokument fehlt der Block; `paket.ts` rechnet `nachgelesen = anders + gleich`. Dazu im FSM
  `technik_leistung()` → `zweiter_blick` (Vorschläge mit `zz/v4+zb`, ersetzt mit festgehaltenem Vorgänger, davon
  geändert, Ordner/Name — Migration 347). Eigene SQL-Anweisung — fehlt die Tabelle, fehlt nur dieser Teil.
- Validierung in `paket.ts` (`leseLeistung`): ohne gültigen `stand` oder ohne lesbaren Zeitraum fällt der Block weg; ein
  kaputter Zeitraum fällt allein weg. `GET /api/technik/stand` liefert `rig` **ohne** `leistung` (die Seite pollt alle
  15 s); gelesen wird der Block nur über `GET /api/technik/leistung` (§6.5).

### 2.7 Geladene KI-Modelle und Belegung des Arbeitsspeichers (Nachtrag 15.10.2026, Mischa)

Mischa: «Warum sehe ich das grosse Modell nicht, wenn es aktiv ist?» und «es soll auch RAM abfragen, dort kann ja auch
was laufen». Der Dienst kennt nur seine eigenen Aufträge; ein Modell kann auch ausserhalb rechnen (Messung, Test,
Hauptmodell). Darum misst der **Sammler** je geladenem Modell selbst (alle 10 s, §1.1) und legt es in `rig.ki_modelle`;
die Belegung des Arbeitsspeichers steht in `rig.ram.belegung`. Der **Melder** ergänzt `ki.hintergrund`.

```json
"ki_modelle": [ { "instanz": "gruendlich", "name": "gemma4:26b-a4b-it-qat", "rolle": "sprache", "zustand": "geladen",
                  "groesse_b": 15651370432, "vram_b": 0, "kontext": 16384, "entlaedt_am": "2026-10-15T21:01:41Z",
                  "cpu_prozent": 997.3, "rechnet": true, "rss_b": 17952096256, "ram_b": 17936297984 } ],
"ram": { …, "belegung": { "ki_modelle_b": 17932156928, "ki_rest_b": 289910374, "trustone_b": 12294422528,
                          "system_b": 2834656256, "verfuegbar_b": 17061416960 } },
"ki":  { …, "hintergrund": "rueckstau_zz" }
```

- **Quelle je Modell:** Ollama `GET /api/ps` beider Instanzen (Adresse im internen Netz aus `docker inspect`, nur private
  Adressen, ohne Proxy, Zeitlimit 3 s, lädt nie ein Modell): Name (Weissliste wie `MODELL_RE`), `groesse_b` (= `size`),
  `vram_b` (= `size_vram`; im Arbeitsspeicher liegt `groesse_b − vram_b`), Kontext, `entlaedt_am` (nur innerhalb von
  2 Tagen). Dazu der **llama-server-Prozess** des Modells: nur PIDs aus `cgroup.procs` der zwei Ollama-Container
  (nie andere Prozesse), Blob aus der Befehlszeile → Name über die Manifeste im Tresor, `rolle` = `einbettung` bei
  `--embedding`, sonst `sprache`; `cpu_prozent` = CPU-Zeit im Mittel seit der letzten Messung (100 = ein Kern),
  `rechnet` = ab 25 % (Leerlauf 0–2 %, Rechnen auf der Grafikkarte ~100 %, auf dem Prozessor bis 1000 %), `rss_b` (VmRSS)
  und `ram_b` (RssAnon = fester Speicher: Gewichte im Arbeitsspeicher und Zwischenspeicher für Anfragen — genau dort lag
  das 8,8-GB-Problem der GPU-Instanz). Prozess ohne `/api/ps`-Eintrag = `zustand: "laedt"`; Eintrag ohne Prozess =
  geladen, ohne Last. Höchstens 6 Einträge; leer = keines geladen; fehlt der Block, misst der Sammler (noch) nicht.
- **Belegung** (nur vollständig): `ki_modelle_b` = Summe `ram_b` der Modelle (höchstens der feste Speicher des KI-Bereichs),
  `ki_rest_b` = fester Speicher des KI-Bereichs (`memory.stat anon` der Slice) ohne Modelle, `trustone_b` = `memory.stat
  anon` der Trust-one-Slice (**nur die Summe**, §1.1), `system_b` = nicht verfügbar minus KI minus Trust one, `verfuegbar_b`
  = `MemAvailable` (der freigebbare Zwischenspeicher zählt dazu). Die Teile gehen zusammen auf den ganzen Speicher auf
  (`paket.ts` verwirft eine Belegung, die mehr als 5 % darüber liegt).
- **`ki.hintergrund`** (fehlt = keine): was der Dienst gerade selbst rechnet, aus seinem `/health`-Bild —
  `rueckstau_zz` | `fristen` | `selbsttest` (Nachtarbeit), `tiefen_index`, `vorbilder_index` (Archiv), `doppel_pruefung`,
  `hauptmodell` (nur mit laufendem Schritt oder beim Laden, «geladen» allein heisst nicht «rechnet»).
- **Seite:** «KI rechnet», sobald ein Auftrag läuft **oder** ein Modell rechnet (Last). Rechnet ein Modell ohne Auftrag und
  ohne `ki.hintergrund`, steht «rechnet ausserhalb der Warteschlange (z. B. Messung/Test)». Ein Problem der KI-Ampel bleibt
  sichtbar (der Chip «Rechnet» ersetzt nur «gut»). Anzeige je Modell: Rolle nach Instanz («Grosses Modell» = gründlich,
  «Schnelles Modell» = schnell, «Suchmodell» = Einbettung) mit Grösse aus dem Namen, Ort «Grafikkarte» | «Prozessor» |
  «60 % Grafikkarte / 40 % Prozessor», Zustand, Grösse (§6.3).

### 2.4 Typen (Agent A legt `src/lib/technik-dashboard/typen.ts` **als Erstes 1:1** an)

```ts
// Technik-Dashboard: Paket vom Rig (v1) und Antwort von GET /api/technik/stand.
// Verbindlich laut docs/technik-dashboard/VERTRAG.md — Aenderungen nur ueber den Vertrag.

export type DienstName = "ki_dienst" | "ollama_schnell" | "ollama_gruendlich" | "whisper" | "datenbank" | "webserver" | "ausgang";
export type Instanz = "schnell" | "gruendlich";

/** Luefter-Profil des Rigs (§2.5): die App setzt den Wunsch, das Rig meldet das aktive. */
export type LuefterProfil = "leise" | "ausgewogen" | "kuehl";
export type LuefterOrt = "radiator" | "front" | "heck" | "boden" | "unbekannt";

/** Kuehlung des Rigs (§2.5): Luefter und Pumpe nach Temperatur gesteuert, alle Zahlen optional. */
export interface KuehlungPaket {
  status: "ok" | "fehler" | "nicht_eingerichtet";
  grund?: string;                       // Code (snake_case), nie Fehlertext
  profil_aktiv?: LuefterProfil;
  luefter?: Array<{ nr: number; ort: LuefterOrt; rpm?: number; prozent?: number }>;
  pumpe_rpm?: number; pumpe_prozent?: number; kuehlmittel_c?: number;
  leds?: "aus" | "an" | "unbekannt";
}

export interface RigPaket {
  gemessen_am: string;
  uptime_s?: number;
  cpu?: {
    temp_c?: number; temp_c_5min?: number; temp_c_max_1min?: number;
    kerne_temp_c?: [number, number]; chipsatz_temp_c?: number;
    last_prozent?: number; last_prozent_5min?: number; last_prozent_10min?: number;
    takt_mhz?: number; takt_mhz_max_kern?: number; kerne?: number; threads?: number;
    drosselung?: boolean;
    luefter_rpm?: number[] | null;
    anteil_kerne?: { ki?: number; trustone?: number };
  };
  gpu?: {
    temp_c?: number; temp_c_max_1min?: number; last_prozent?: number;
    vram_belegt_mib?: number; vram_gesamt_mib?: number; watt?: number; watt_grenze?: number;
    luefter_prozent?: number; pstate?: string; treiber?: string; takt_mhz?: number; takt_max_mhz?: number;
  };
  ram?: {
    eingebaut_gb?: number;
    module?: Array<{ platz: number; groesse_gb: number; temp_c?: number | null }>;
    gesamt_b?: number; verfuegbar_b?: number; frei_b?: number; swap_gesamt_b?: number; swap_belegt_b?: number;
    psi_full_avg10?: number; psi_some_avg10?: number;
    // aktives Ein-/Auslagern (Bytes/s, 5-Minuten-Mittel aus /proc/vmstat pswpin/pswpout), §2.3 — seit 15.10.2026
    swap_ein_bps_5min?: number; swap_aus_bps_5min?: number;
    ki?: { belegt_b?: number; fest_b?: number; cache_b?: number; grenze_b?: number; swap_b?: number };
    trustone?: { summe_b?: number; grenze_hoch_b?: number; grenze_max_b?: number };
    belegung?: RamBelegung;                       // §2.7 — seit 15.10.2026
  };
  platten?: {
    system?: { gesamt_b: number; belegt_b: number };
    tresor?: { gesamt_b: number; belegt_b: number };
    ssd?: { status: "ok" | "nicht_verfuegbar"; temp_c?: number | null; gesundheit?: "ok" | "warnung" | "fehler" | null; abnutzung_prozent?: number | null; betriebsstunden?: number | null };
  };
  io?: { gelesen_b?: number; geschrieben_b?: number; netz_rx_b?: number; netz_tx_b?: number; vpn_rx_b?: number; vpn_tx_b?: number };
  dienste?: Array<{
    name: DienstName; zustand: "laeuft" | "startet" | "neustart" | "gestoppt";
    gesund: boolean | null; gestartet_am?: string; neustarts?: number; oom?: boolean;
    speicher_b?: number; grenze_b?: number | null;
  }>;
  kuehlung?: KuehlungPaket;
  ki_modelle?: KiModellLast[];                    // §2.7 — seit 15.10.2026
  /** Leistung der lokalen KI (§2.6): nur Zahlen, vom Sammler alle 10 min aus der Rig-DB gerechnet. */
  leistung?: LeistungRig;
  minute?: Record<string, number>;
}

// Geladene KI-Modelle und Belegung (§2.7) — vollstaendig in typen.ts
export type KiModellRolle = "sprache" | "einbettung";
export interface KiModellLast { instanz: Instanz; zustand: "geladen" | "laedt"; name?: string; rolle?: KiModellRolle;
  groesse_b?: number; vram_b?: number; kontext?: number; entlaedt_am?: string; cpu_prozent?: number; rechnet?: boolean;
  rss_b?: number; ram_b?: number }
export interface RamBelegung { ki_modelle_b: number; ki_rest_b: number; trustone_b: number; system_b: number; verfuegbar_b: number }
export type KiHintergrund = "rueckstau_zz" | "fristen" | "selbsttest" | "tiefen_index" | "vorbilder_index" | "doppel_pruefung" | "hauptmodell";

// Leistung der lokalen KI (§2.6) — vollstaendig in typen.ts
export type LeistungZeitraum = "7d" | "30d" | "alle";
export interface LeistungAuftraege { art: string; n: number; ok: number; median_ms?: number; max_ms?: number;
  mit_seiten?: number; ms_seite_text?: number; ms_seite_gescannt?: number; seiten_max?: number; zeichen_max?: number; teile_max?: number }
export interface LeistungGelesen { dateien: number; mit_text?: number; gescannt?: number; seiten?: number; seiten_max?: number;
  zeichen_max?: number; mb_max?: number; gemessen?: number; s_seite_text?: number; s_seite_gescannt?: number;
  s_datei_median?: number; s_datei_max?: number }
export interface LeistungSelbsttest { top1?: number; top3?: number; top1_ohne_name?: number; top3_ohne_name?: number; ms_median?: number }
export interface LeistungSelbsttestLauf extends LeistungSelbsttest { am: string; dateien: number }
export interface LeistungBlock { auftraege: LeistungAuftraege[]; gelesen?: LeistungGelesen;
  fristen_geprueft?: { dateien: number; mit_frist: number }; selbsttest?: LeistungSelbsttest & { laeufe: number } }
export interface LeistungRig { stand: string; seit?: string; zeitraeume: Partial<Record<LeistungZeitraum, LeistungBlock>>;
  selbsttest?: LeistungSelbsttestLauf[] }

export interface KiPaket {
  version?: string; eingestellt?: string;
  instanzen?: Array<{ name: Instanz; erreichbar: boolean; version?: string; grenze_b?: number }>;
  modelle?: Array<{ name: string; groesse_b: number }>;
  geladen?: Array<{ name: string; instanz: Instanz; groesse_b: number; vram_b: number; entlaedt_am?: string }>;
  auftrag?: { art: string; seit: string; modell?: string } | null;
  warteschlange?: number;
  tempo?: { tokens_s: number; modell: string; am: string } | null;
  archiv?: { anzahl?: number; letzter_lauf?: string; neu?: number; fehler?: number; dauer_s?: number };
  tiefen_index?: { dateien?: number; nas_dateien?: number; mit_text?: number; abschnitte?: number; letzter_lauf?: string; nacht_fertig?: boolean };
  schalter?: Partial<Record<"suche" | "archiv_frage" | "hintergrund" | "lernen" | "tiefe" | "hauptmodell", boolean>>;
  hauptmodell_geladen?: boolean;
  hintergrund?: KiHintergrund;                    // §2.7 — seit 15.10.2026
  fsm_antwort_ms?: number | null; fsm_fehler_in_folge?: number;
}

export type SnmpGrund = "zeitlimit" | "anmeldung" | "keine_antwort" | "werkzeug_fehlt" | "zugang_ungueltig" | "unbekannt";
/** Woher die NAS-Hardwarewerte kommen (§1.3 SNMP, §1.4 Mess-Container); fehlt bei «nicht_eingerichtet» ohne Zugang. */
export type HardwareQuelle = "snmp" | "exporter";
export interface NasPaket {
  gemessen_am: string;
  erreichbar: boolean; fehlversuche_in_folge: number;
  dateifreigabe?: boolean; weboberflaeche?: boolean;
  volume?: { gesamt_b: number; belegt_b: number } | null;
  freigaben?: { soll: number | null; ist: number; schreibend?: number; lesend?: number; fehlt_seit?: string | null };
  snmp: {
    status: "nicht_eingerichtet" | "ok" | "fehler"; grund?: SnmpGrund; gemessen_am?: string;
    quelle?: HardwareQuelle;
    system_temp_c?: number; cpu_temp_c?: number;
    platten?: Array<{
      schacht: number; temp_c?: number; gesundheit?: "ok" | "warnung" | "fehler";
      // nur vom Exporter (§1.4): Betriebsstunden und SMART-Rohzaehler
      betriebsstunden?: number; umgelagert?: number; ausstehend?: number; nicht_korrigierbar?: number; crc_fehler?: number;
      // nur vom Exporter (§1.4): Platte steckt nicht im Gehaeuse (USB), schacht = Geraetenummer > NAS_SCHAECHTE
      extern?: boolean;
    }>;
    raid?: "normal" | "wiederaufbau" | "degradiert" | null;
    last_prozent?: number; ram_prozent?: number; uptime_s?: number;
  };
}

export interface PaketV1 { v: 1; gesendet_am: string; rig?: RigPaket; ki?: KiPaket; nas?: NasPaket }

/** Antwort von POST /api/technik/messwerte an das Rig (§2.5): gewuenschtes Profil und seit wann. */
export interface SteuerungRig { luefter_profil: LuefterProfil; stand: string }
/** Gewuenschtes Profil fuer die Seite (technik_steuerung, Migration 318). */
export interface SteuerungStand { luefter_profil: LuefterProfil; geaendert_am: string | null }

// ---- Antwort GET /api/technik/stand (siehe §6.2) ----
export type Stufe = "gut" | "warnung" | "kritisch" | "neutral";
export type NeutralArt = "kommt" | "ruht" | "soll_offen" | "veraltet" | "info" | "nie_gemeldet" | "nicht_lesbar";
export type Bauteil = "cpu" | "gpu" | "ram" | "platten" | "dienste" | "ki" | "app" | "ablage" | "nas" | "index" | "hardware" | "backup";
export type Kachel = "rig" | "ki" | "ram" | "platten" | "nas" | "backup" | "verbindung" | "messwerte";
export type Bereich = "6h" | "24h" | "7d";

export interface Ampel {
  schluessel: string;        // z. B. "cpu.temp", "dienst.ollama_schnell"
  bauteil: Bauteil;
  kachel: Kachel | null;
  stufe: Stufe;
  neutral?: NeutralArt;      // nur bei stufe "neutral"
  titel: string;             // «Prozessor-Temperatur»
  wert: string | null;       // fertig formatiert (de-CH): «71 °C»
  text: string;              // ein Satz Klartext, ohne Fachjargon
  seit: string | null;       // ISO: seit wann diese Stufe gilt (technik_zustaende), null = gerade eben/unbekannt
  alarm: boolean;            // darf bei kritisch alarmieren (§5)
}

export interface Ereignis {
  id: string;
  zeitpunkt: string | null;  // null = «andauernd»
  stufe: "kritisch" | "warnung" | "hinweis" | "gut";
  art: "zustand" | "neustart" | "absturz" | "alarm" | "entwarnung" | "hinweis";
  bauteil: Bauteil | null;
  text: string;
}

export interface Reihen {
  bereich: Bereich;
  schritt_s: number;         // 60 (6h), 300 (24h), 3600 (7d)
  von: string; bis: string;
  // je Schluessel aus MINUTEN_SCHLUESSEL (ohne ".max"): [t_ms, mittel, spitze]
  werte: Record<string, Array<[number, number | null, number | null]>>;
  neustarts: string[];       // ISO, fuer die Luecke/Marke in den Kurven
}

export interface FsmStand {
  ki_online: boolean;
  ki_letzter_poll: string | null;
  ki_online_seit: string | null;
  ki_version: string | null;
  ki_letzter_fehler: string | null;        // gekuerzt auf 200 Zeichen
  warteschlange_offen: number;
  aeltester_offen_am: string | null;
  auftraege_24h: number;
  backup: { letzte_ok_am: string | null; letzte_meldung_am: string | null; letzte_status: "ok" | "fehler" | null;
            groesse_gesamt: string | null; groesse_db: string | null; groesse_dokumente: string | null;
            warnmails_7d: number; letzte_warnmail_am: string | null; nie_gemeldet: boolean };
  sync: { letzter_poll: string | null; intervall_s: number | null };
  index: { letzter_scan: string | null; dateien: number };
}

export interface TechnikStand {
  success: true;
  jetzt: string;
  hat_daten: boolean;                               // false = noch nie ein Paket angekommen
  gesamt: { stufe: Stufe; probleme: Ampel[] };       // probleme = warnung/kritisch, kritisch zuerst
  ampeln: Ampel[];
  rig: RigPaket | null; rig_alter_s: number | null;  // Alter = jetzt − rig.gemessen_am
  ki: KiPaket | null; ki_alter_s: number | null;
  nas: NasPaket | null; nas_alter_s: number | null;
  fsm: FsmStand;
  steuerung: SteuerungStand | null;                  // null = nicht lesbar
  ereignisse: Ereignis[];                            // neueste zuerst, Zeitraum = bereich (max. 200)
  reihen: Reihen | null;                             // nur bei ?reihen=1
}

// ---- Antwort GET /api/technik/leistung (siehe §6.5) ----
export interface LeistungAblage {
  logik: "lokal" | "claude"; seit: string | null; vorschlaege: number; offen: number;
  unveraendert: number; geaendert: number; ordner_geaendert: number; name_geaendert: number; abgelehnt: number;
  entscheid_von: string | null; entscheid_bis: string | null;
}
export interface LeistungUploads {
  seit: string | null; mit_vorschlag: number; unveraendert: number; ordner_geaendert: number; name_geaendert: number;
  quellen: { regel: number; lokal: number; claude: number; beschrieb: number };
}
export interface LeistungGroesstes { seiten: number; herkunft: "app" | "zz"; am: string }
export interface TechnikLeistung {
  success: true; jetzt: string; zeitraum: LeistungZeitraum; von: string | null;
  rig: { stand: string; seit: string | null; block: LeistungBlock | null; selbsttest: LeistungSelbsttestLauf[] } | null;
  ablage: LeistungAblage[];
  uploads: LeistungUploads;
  groesstes: LeistungGroesstes | null;
  fristen: { seit: string | null; gefunden: number; bestaetigt: number; verworfen: number; offen: number };
  sicherheit: { seit: string | null; rapporte: number };
}
```

---

## 3. Speicherung (Migration 313, Agent A)

Muster RLS: Migration `274_nas_backup_status.sql`. Alle vier Tabellen: RLS an, **SELECT nur `(select public.is_admin())`**,
INSERT/UPDATE/DELETE je eine Policy mit `false`. Geschrieben wird nur mit `createAdminClient()` (service_role).

```sql
technik_stand       (quelle text primary key check (quelle in ('rig','ki','nas')),
                     werte jsonb not null, gemessen_am timestamptz not null, empfangen_am timestamptz not null default now())
technik_messwerte   (quelle text not null check (...), minute timestamptz not null, werte jsonb not null,  -- flach {schluessel: zahl}
                     primary key (quelle, minute))
technik_stunden     (quelle text not null, stunde timestamptz not null, werte jsonb not null,           -- {schluessel: {avg,min,max,n}}
                     primary key (quelle, stunde))
technik_ereignisse  (id uuid pk default gen_random_uuid(), zeitpunkt timestamptz not null default now(),
                     art text not null check (art in ('zustand','neustart','absturz','alarm','entwarnung','hinweis')),
                     stufe text not null check (stufe in ('gut','warnung','kritisch','hinweis')),
                     bauteil text, schluessel text, text text not null check (char_length(text) <= 300))
                     + index (zeitpunkt desc)
technik_zustaende   (schluessel text primary key, stufe text not null, seit timestamptz not null,
                     kritisch_seit timestamptz, alarm_gesendet_am timestamptz, alarm_offen boolean not null default false,
                     aktualisiert timestamptz not null default now())
```

**Migration 318** (`technik_steuerung`, §2.5): eine Zeile (`id smallint = 1`), `luefter_profil` ∈ leise/ausgewogen/kuehl
(Standard ausgewogen), `geaendert_von uuid → profiles(id)`, `geaendert_am`. RLS: SELECT und UPDATE nur
`(select public.is_admin())`, INSERT/DELETE `false` (nur service_role).

Zusätzlich (additiv, für die Frische-Abfrage «Datei-Index»):
`create index if not exists idx_ablage_datei_index_aktualisiert on ablage_datei_index (aktualisiert desc);`

**Aufbewahrung:** Minutenwerte **48 h**, Stundenwerte **90 Tage**, Ereignisse **90 Tage**, Zustände ohne Ablauf (wenige Zeilen).

**Funktionen** (beide `security definer`, `set search_path = public`, `revoke all … from public, anon, authenticated`,
`grant execute … to service_role`; beide mehrfach ausführbar ohne Schaden):

- `technik_verdichten() returns jsonb`: berechnet für **alle vollständigen Stunden**, die noch in `technik_messwerte`
  liegen, je Quelle und Schlüssel avg/min/max/n (`jsonb_each`, Schlüssel mit Endung `.max` → max der Maxima) und
  upsertet `technik_stunden`. Minuten werden nur **stundenweise** gelöscht (Grenze `date_trunc('hour', now() − 48 h)`),
  darum liegt jede Stunde ab dieser Grenze noch vollständig vor und wird neu verdichtet; ältere Stunden werden nie
  überschrieben, nur ergänzt, falls sie fehlen (Review 2026-10-12: sonst ersetzte eine angeschnittene Stunde die
  vollständige Zeile). Danach löschen: Minuten vor der Grenze, Stunden älter 90 Tage, Ereignisse älter 90 Tage.
  Gleichzeitige Aufrufe (Stunden-Cron und db-retention um 02:00 UTC) sperrt ein Advisory-Lock; der zweite gibt
  `{ "uebersprungen": true }` zurück. Rückgabe sonst: Zähler je Schritt.
- `technik_reihe(p_quelle text, p_von timestamptz, p_bis timestamptz, p_schritt_s int, p_schluessel text[])
   returns table (t timestamptz, schluessel text, mittel double precision, spitze double precision)`:
  Buckets zu `p_schritt_s`; `mittel` = Mittel des Schlüssels, `spitze` = max des `.max`-Schlüssels (falls vorhanden,
  sonst max des Mittels). Für Buckets ≥ 3600 s aus `technik_stunden`, ergänzt um die noch nicht verdichteten
  Stunden aus `technik_messwerte`.

**Aufrufer:** `db-retention` (täglich 02:00) ruft `admin.rpc("technik_verdichten")` zusätzlich auf (Fehler nur
`logError("cron.db-retention.technik", …)`, nie werfen). Der neue Cron `technik-alarme` ruft sie zusätzlich in der
ersten Ausführung jeder Stunde auf (Minute < 5), damit «7 Tage» aktuell bleibt.

**Ingest** (`POST /api/technik/messwerte`) pro Paket:
1. `rigAuthFehler` → Grösse → `lesePaket`.
2. Vorherigen `technik_stand` lesen (für Ereignisse), dann `technik_stand` upserten je vorhandenem Block
   (`gemessen_am` = `rig.gemessen_am` / `gesendet_am` für ki / `nas.gemessen_am`).
3. `technik_messwerte` upserten: `rig` → `rig.minute` (gefiltert), `ki`/`nas` → abgeleitete Schlüssel §2.3;
   `minute = date_trunc('minute', gemessen_am)`, `on conflict do update` (Wiederholungen schaden nicht).
4. Ereignisse ableiten (Texte erzeugt das FSM aus Vorlagen, **nie** Text vom Rig übernehmen):
   - `uptime_s` kleiner als vorher → `neustart`/`hinweis` «Rig neu gestartet» mit `zeitpunkt = gemessen_am − uptime_s`.
   - Dienst: `neustarts` gestiegen → `absturz`/`warnung` «{Dienst} unerwartet neu gestartet»;
     `gestartet_am` neu ohne gestiegene `neustarts` → `neustart`/`hinweis` «{Dienst} neu gestartet»;
     `oom` neu true → `absturz`/`kritisch` «{Dienst} wegen Speichermangel beendet».
   - `ki.archiv.letzter_lauf` neu → `hinweis` «Archiv-Lauf: {neu} neu, {fehler} Fehler, {dauer} s».
   - `ki.tiefen_index.letzter_lauf` neu → `hinweis` «Tiefen-Index: {dateien} von {nas_dateien} Dateien gelesen».
5. `200 {"success":true}`. Fehler: `logError("technik.messwerte", e)` + 500 ohne Details.

---

## 4. Ampel-Regeln (`src/lib/technik-dashboard/ampeln.ts`, reine Funktion, getestet)

`bewerteAmpeln(eingabe: { jetzt, rig, ki, nas, fsm: FsmStand, abstuerze24h: Record<DienstName, number>,
vorher: Record<string, Stufe> }): Ampel[]` — dieselbe Funktion nutzen `GET /api/technik/stand` und der Cron
`technik-alarme` (keine zweite Logik). `vorher` = letzte Stufe aus `technik_zustaende` für die Hysterese.

**Grundsätze** (aus `spec.md` §3): Status nie nur über Farbe (Icon + Wort). Gesamt = schlechteste nicht-neutrale Stufe.
Temperatur/Last: bewertet werden 5-Minuten-Mittel und Minuten-Maximum; einzelne Spitzen darunter nur als Hinweis.
**Hysterese:** Eine Stufe fällt erst zurück, wenn der Wert die Grenze um die Hysterese unterschreitet
(Temperaturen 3 °C, Prozent 5 Punkte, GB 0,5 GB, Zeiten/Zustände ohne Hysterese).
**Veraltet:** Ist «Messwerte aktuell» nicht gut (Rig-Stand älter 3 min), werden alle aus `rig` abgeleiteten Ampeln
`neutral`/`veraltet` mit Text «Stand vor X min» und alarmieren nicht. Ist `nas.gemessen_am` älter 5 min, gilt dasselbe für
die NAS-Ampeln. Ist die KI offline, wird `ki.warteschlange` neutral (das Problem ist dann «Rig online»).

| Schlüssel | Bauteil · Kachel | gut | Warnung | kritisch | Alarm |
|---|---|---|---|---|---|
| `verbindung.online` (jetzt − `ki_status.letzter_poll`) | app · verbindung | < 90 s (`KI_ONLINE_FENSTER_MS`) | 90 s – 10 min | > 10 min | ja |
| `messwerte.frische` (jetzt − `rig.gemessen_am`) | app · messwerte | < 3 min | 3 – 10 min | > 10 min oder nie | ja (nur wenn `verbindung.online` gut — sonst ist das die Ursache) |
| `verbindung.antwortzeit` (`ki.fsm_antwort_ms`) | app · verbindung | < 1 s | 1 – 3 s | > 3 s oder `fsm_fehler_in_folge` ≥ 3 | nein |
| `cpu.temp` | cpu · rig | 5-min-Mittel ≤ 85 °C und Minuten-Max < 95 °C | 5-min-Mittel > 85 °C oder Minuten-Max ≥ 95 °C | ≥ 98 °C oder `drosselung` | ja |
| `cpu.temp` Hinweis | — | Minuten-Max zwischen 80 und 95 °C bei sonst gut → Text-Zusatz «Spitze X °C, Warnung erst ab 95 °C» (Stufe bleibt gut) | | | |
| `cpu.last` | cpu · rig | 5-min-Mittel < 80 % | 80 – 95 % | 10-min-Mittel > 95 % | nein |
| `kuehlung` (§2.5) | cpu · rig | Pumpe und alle Lüfter drehen | ein Lüfter 0 U/min (bei 0 % gewollt, zählt nicht) oder `status = fehler` | Pumpe 0 U/min oder bei `status = ok` ohne Drehzahl | ja (nur kritisch) · fehlt/`nicht_eingerichtet` → neutral/`kommt` «Kühlungs-Steuerung noch nicht eingerichtet» |
| `gpu.temp` | gpu · rig | < 75 °C | 75 – 85 °C | > 85 °C | ja |
| `ram.verfuegbar` | ram · ram | > 8 GB | 4 – 8 GB | < 4 GB | ja |
| `ram.druck` (PSI memory, Mittel 10 s) | ram · ram | `some` < 5 % | `some` ≥ 5 % (einzelne Programme warten) | `full` > 30 % (alle stehen still, = Abbruchgrenze des KI-Wächters) | ja (nur kritisch) · Hysterese 2 Punkte · ohne `some` zählt `full` |
| `ram.auslagern` (aktives Ein-/Auslagern, 5-min-Mittel, grössere Richtung) | ram · ram | < 10 MB/s | ≥ 10 MB/s | – (keine) | nein · Hysterese 2 MB/s · ohne Messung neutral/`nicht_lesbar` |
| `ram.ki_fest` (`ram.ki.fest_b / grenze_b`, nie den Zwischenspeicher) | ram · ram | < 80 % | 80 – 95 % | > 95 % | ja |
| `ram.trustone` | ram · — | immer `neutral`/`info`, nur Summe | – | – | nie |
| `ram.swap` (belegte Auslagerung) | ram · ram | immer `neutral`/`info` | – | – | nie |

**Arbeitsspeicher-Neuregel (15.10.2026, Mischa: «wieso steht beim RAM die ganze Zeit Warnung?»).** Belegte Auslagerung
allein ist kein Engpass: Linux lässt alte, ruhende Seiten dort liegen (seit 14.10. 01 Uhr 2,2–2,7 GB bei 28–34 GB
verfügbar, Speicherdruck 0, in 150 s Messung 0 B/s ein und aus). Bis dahin «Warnung ab 2 GB, kritisch über 6 GB» —
jetzt nur noch Info. Bewertet werden verfügbarer RAM, Speicherdruck und aktives Ein-/Auslagern. Kalibriert am
Speicherprofil 11.10. 20:30 – 15.10. 17:00 (5552 Minuten) und den Minutenreihen 12.–15.10.: Normalbetrieb verfügbar
mind. 20,1 GB, Speicherdruck höchstens 2,3 (Minuten-Spitze), netto ausgelagert höchstens 5,5 MB/s im 5-Minuten-Mittel
(kein Fenster ab 8 MB/s); Messnacht 11./12.10. (26B, KI-Bereich am Anschlag, 4 Speicher-Abbrüche) verfügbar mind.
11,9 GB, Speicherdruck bis 5,6 (5,9 im 5-s-Monitor), netto ausgelagert bis 21,9 MB/s (9 Fenster ab 10 MB/s) → dort
Warnungen, kein Alarm. Die Seitenfehler-Ampel (`ram.seitenfehler`, `pgmajfault`) entfällt: beim Lesen von Dateien
stiegen die Seitenfehler im Normalbetrieb höher (Minuten-Spitze 1786/s) als in der Messnacht (728/s).
| `platte.system`, `platte.tresor` | platten · platten | < 80 % | 80 – 90 % | > 90 % | ja |
| `ssd.temp` | platten · platten | < 60 °C | 60 – 70 °C | > 70 °C | ja · `ssd.status ≠ ok` → neutral/`kommt` «kommt mit Freigabe am Rig» |
| `ssd.gesundheit` | platten · platten | `ok` | `warnung` oder Abnutzung ≥ 90 % | `fehler` | ja · sonst wie oben |
| `dienst.<name>` (je Dienst) | dienste · rig | läuft und gesund (oder ohne Healthcheck) | Absturz in den letzten 24 h (`technik_ereignisse` art `absturz`) oder `startet`/`neustart` | `gesund = false`, `gestoppt`, `oom`, **fehlt** (Pflichtdienst aus `DIENST_NAMEN` nicht im Paket, `ollama_gruendlich` nur bei Schalter `hauptmodell`) | ja (Warnung nie) |
| `ki.warteschlange` (ältester offener `ki_auftraege`) | ki · ki | < 10 min · leer → `neutral`/`ruht` wenn kein Auftrag läuft | 10 – 30 min | > 30 min | ja |
| `nas.erreichbar` | nas · nas | `fehlversuche_in_folge` = 0 | 1 – 2 | ≥ 3 | ja |
| `nas.volume` | nas · nas | < 80 % | 80 – 90 % | > 90 % | ja |
| `nas.freigaben` | nas · nas | ist = soll | eine fehlt < 10 min (`fehlt_seit`) | eine fehlt > 10 min | ja · `soll = null` → neutral/`soll_offen` |
| `nas.hw.systemtemp` | hardware · — | < 70 °C | 70 – 85 °C | > 85 °C | ja, nur bei `snmp.status = ok` |
| `nas.hw.plattentemp` (max) | hardware · — | < 45 °C | 45 – 55 °C | > 55 °C | ja, nur bei ok · inkl. externer Platten (§1.4) |
| `nas.hw.plattengesundheit` | hardware · — | alle ok | eine `warnung` | eine `fehler` | ja, nur bei ok · inkl. externer Platten (§1.4) |
| `nas.hw.raid` | hardware · — | normal | wiederaufbau | degradiert | ja, nur bei ok |
| `nas.hw.zugang` | hardware · — | `snmp.status = ok` | `fehler` (Text nach `grund`) oder `grund = zugang_ungueltig` | – | nein · `nicht_eingerichtet` → neutral/`kommt` «kommt mit NAS-Zugang» für **alle** `nas.hw.*` |
| `backup.fsm` (`nas_backup_runs`) | backup · backup | letzte OK < 26 h | 26 – 48 h | > 48 h oder neueste Meldung `fehler` | In-App ja, **Mail nein** (die verschickt schon `nas-backup-check`) · nie gemeldet → neutral/`nie_gemeldet` |
| `ablage.sync` (`ablage_sync_status.letzter_poll`) | ablage · — | < 5 min | 5 – 15 min | > 15 min | ja |
| `ablage.index` (`max(ablage_datei_index.aktualisiert)`) | index · — | < 30 min | 30 – 60 min | > 60 min | ja |

**Folge-Alarme:** Ist `verbindung.online` kritisch oder `messwerte.frische` kritisch (nach dem ersten Paket), melden
`ablage.sync` und `ablage.index` nicht (`alarm = false`) — beide laufen auf dem Rig und wären nur Folgen davon. Die
Ampel zeigt den Zustand weiter.

**Kacheln der Statusleiste** (Reihenfolge wie `spec.md` §2.1): Rig, KI, Arbeitsspeicher, Platten, NAS, Backup,
Verbindung FSM, Messwerte. Stufe einer Kachel = schlechteste Ampel mit dieser `kachel`. Werte der Kacheln wie im
Entwurf (Rig: Prozessor-Temperatur, KI: «Ruht»/«Rechnet», RAM: «X GB frei», Platten: höchste Belegung, NAS:
«Erreichbar», Backup: Alter, Verbindung: Antwortzeit, Messwerte: «aktuell»/«vor X min»).

**Konstanten** (Grenzen, Hysterese, Fenster) stehen nur in `konstanten.ts`, die Seite liest Grenzlinien für die Kurven
von dort (eine Quelle).

---

## 5. Alarme (Cron `technik-alarme`, Agent A)

- `GET /api/cron/technik-alarme`, Absicherung exakt wie `nas-backup-check` (`CRON_SECRET` fehlt → 503, falscher
  Bearer → 401). `vercel.json`: `{ "path": "/api/cron/technik-alarme", "schedule": "*/5 * * * *" }`
  (wie `refresh-counts`).
- Ablauf je Lauf: Stand laden (dieselbe Ladefunktion wie GET, `stand-server.ts`) → `bewerteAmpeln` →
  mit `technik_zustaende` vergleichen:
  - Stufe gewechselt → Zeile aktualisieren (`seit`, bei Eintritt in kritisch `kritisch_seit`) und Ereignis
    `zustand` («Prozessor-Temperatur: Warnung, 5-Minuten-Mittel 87 °C»). Neutral ↔ neutral erzeugt kein Ereignis.
  - **Alarm**, wenn `alarm = true` und Stufe kritisch und `kritisch_seit ≤ jetzt − 10 min` und
    (`alarm_gesendet_am` leer oder `≤ jetzt − 6 h`; ist der letzte Alarm noch offen, also nicht entwarnt,
    `≤ jetzt − 24 h` = Erinnerung höchstens 1× pro Tag) → `alarm_gesendet_am = jetzt`, `alarm_offen = true`,
    Ereignis `alarm`.
  - **Entwarnung**, wenn `alarm_offen` und Stufe nicht mehr kritisch → `alarm_offen = false`, Ereignis `entwarnung`,
    Mitteilung **ohne Mail**.
- **Bündeln:** Alle in einem Lauf fälligen Alarme ergeben **eine** Mitteilung und **eine** Mail pro Admin
  (Titel nennt das schlimmste Problem, Text listet alle). Ebenso Entwarnungen.
- **Empfänger:** alle aktiven Admins (`profiles.role = 'admin'`, `is_active = true`), wie `nas-backup-check`.
- **Kanal:** neue Funktionen in `src/lib/notification-service.ts` über das bestehende `deliver()`:
  `notifyTechnikAlarm(client, { recipients, titel, zeilen: string[] })` (In-App + Push + Mail über
  `mailRahmen`, Link `/technik`) und `notifyTechnikEntwarnung(client, { recipients, titel, zeilen })` (ohne `mail`).
  Neuer `NotificationType` `"technik_alarm"` in `src/types/index.ts` und `NOTIFICATION_META`
  (`icon: AlertTriangle`, `accent: "red"`, `label: "Technik-Alarm"`, `audience: "intern"`, **`configurable: false`**,
  weil nur Admins ihn bekommen und er in der Matrix aller Mitarbeiter nichts verloren hat). Die Tabelle
  `notifications` hat keinen Check auf `type` (geprüft) → keine Migration dafür.
- **Mail:** Betreff `EVENTLINE Technik: {Titel}` (Versalien, kein Emoji). Inhalt Klartext-Sätze aus den Ampel-Texten,
  Link «Zur Technik-Seite», Hinweis «Diese Meldung kommt höchstens alle 6 Stunden je Problem.» Keine Adressen,
  keine Gerätenamen, keine Marken. Ohne Mail-Konfiguration (`isMailConfigured()` false) nur In-App, `logError`.
- **Keine Alarme** für: neutrale Ampeln (`kommt`, `ruht`, `soll_offen`, `veraltet`, `nie_gemeldet`, `nicht_lesbar`),
  `nas.hw.*` ohne SNMP-Zugang, Trust one, Warnungen. Backup: Mitteilung ja, Mail nein (§4).
- Antwort `{ success, gewechselt, alarme, entwarnungen }`; nie werfen, Fehler `logError("cron.technik-alarme", e)`.

---

## 6. Seite `/technik` (Agent B) und Lese-API (Agent A)

### 6.1 Zugang und Navigation

- `ADMIN_ONLY_PREFIXES` in `src/lib/permissions.ts`: `["/nas", "/ablage", "/technik"]` (+ Kommentarzeile).
  Damit blendet die Sidebar den Eintrag für Nicht-Admins aus und `isPathAllowed` leitet um. **Kein Rechte-Slug.**
- `ADMIN_NAV_GROUP` in `src/lib/constants.ts`: `{ href: "/technik", label: "Technik", icon: "Server" }` direkt **nach** NAS.
  `Server` in `src/lib/nav-icons.ts` importieren und in `NAV_ICON_MAP` aufnehmen.
- Handy: Die Sidebar ist unter `md` versteckt, das Mehr-Sheet zeigt nur die festen Listen `MEHR_ICH`/`MEHR_ARBEIT`
  (`src/lib/mobile-seiten.ts`), `/technik` ist keine `FELD_PREFIXES`-Seite → bekommt automatisch den Büro-Hinweis.
  **Kein** `nurDesktop`-Kennzeichen nötig, kein Eintrag in `mobile`/Mehr-Sheet.
- `GET /api/technik/stand`: erste Zeile `const auth = await requireAdmin(); if (auth.error) return auth.error;`
  (`src/lib/api-auth.ts`), danach `createAdminClient()`. Kein `/anleitung`-Eintrag, kein `app-updates`-Eintrag (Admin-Thema).

### 6.2 Lese-API `GET /api/technik/stand?bereich=6h|24h|7d&reihen=0|1`

- Antwort = `TechnikStand` (§2.4). `bereich` Standard `6h`; `reihen=1` liefert `reihen` (sonst `null`).
  Ereignisse: Zeitraum = `bereich`, max. 200, neueste zuerst; zusammengeführt aus `technik_ereignisse` und abgeleitet
  aus `nas_backup_runs` (Meldung ok/fehler) und `nas_backup_alerts` («Warn-Mail zur FSM-Sicherung an die Admins
  verschickt»). Ein laufendes kritisches Problem erscheint oben mit `zeitpunkt: null` («andauernd»).
- Quellen (parallel, alle klein): `technik_stand` (3 Zeilen), `technik_zustaende`, `technik_ereignisse`,
  `ki_status` (Zeile 1: `letzter_poll`, `online_seit`, `version`, `letzter_fehler`; **`ki_status.gpu` nie ausliefern**,
  es enthält den Kartennamen), `ki_auftraege` (offen: Anzahl + ältestes `created_at`; 24 h: Anzahl),
  `nas_backup_runs` (limit 10), `nas_backup_alerts` (7 Tage), `ablage_sync_status`, `ablage_datei_index`
  (Anzahl + `max(aktualisiert)` über den neuen Index), `technik_reihe(...)` nur bei `reihen=1`.
- Schritt: 6h → 60 s, 24h → 300 s, 7d → 3600 s. Reihen-Schlüssel: alle aus §2.3 ohne `.max` (die Spitze kommt im Tupel).
- `Cache-Control: no-store`. Fehler → 500 `{ success:false, error:"Technik-Stand konnte nicht geladen werden" }` + `logError`.

### 6.3 Seite

- Dateien: `src/app/(app)/technik/page.tsx` (Client-Seite wie `/nas`), `loading.tsx` (Shimmer-Skeleton wie
  `src/app/(app)/nas/loading.tsx`), Bausteine unter `src/components/technik-dashboard/`.
- **Darstellung = Entwurf.** Szene, Formen, Bewegung, Schublade und Texte aus `gen-main.mjs` übernehmen
  (Funktionen `panels()`, `part`, `chartOne`, `ring`, Konstanten `THEMES`, `STS`, `KEYS`, `LADE`, `ARIA`), aber
  mit echten Daten aus der API statt `werte-1210.json`:
  - Rig im Seitenblick: Pumpenkopf mit Prozessor-Temperatur, Schläuche zum Radiator im Deckel, Riegel nach
    `ram.module` (Anzahl/Steckplatz/Grösse, mit und ohne Kühlblech wie Entwurf), Grafikkarte mit drei Lüftern und
    Temperatur auf dem Seitendisplay, Front-Lüfter, hintere Kammer (Netzteil, SSD) als Skizze.
    Lüfter drehen nach `gpu.luefter_prozent` bzw. echten Drehzahlen: die drei Front-Lüfter je einzeln nach
    `rig.kuehlung.luefter` (Ort `front`), sonst nach dem Mittel bzw. `cpu.luefter_rpm` (fehlt → ruhig, kein
    erfundener Wert). Meldet das Rig `leds: "aus"`, sind Lichtleisten und Lüfterringe unbeleuchtet gezeichnet.
  - Kühlung (§2.5) hat keinen eigenen Bauteil-Schlüssel: Das Panel `cpu` heisst «Prozessor und Kühlung» und zeigt
    nach den Prozessor-Kacheln den Abschnitt Kühlung (Profil-Umschalter Leise · Ausgewogen · Kühl, Drehzahl je
    Lüfter, Pumpe, Kühlmittel, LEDs, Kurven, Grenzwerte). Die Front-Lüfter gehören im Fokus-Modus zum Prozessor.
  - NAS-Front mit vier nummerierten Schächten, Ein-Knopf, Lämpchen; Netzwerk-Lampe blinkt bei Ablage-Abgleich
    (`ablage.sync` gut und `letzter_poll` < 90 s). Schachtbestückung neutral, solange SNMP keine `platten` liefert.
  - Leitungen Rig ↔ App (Verbindung) und Rig ↔ NAS (Ablage) mit Zustand der zugehörigen Ampel.
  - Bauteile = `Bauteil` (§2.4) plus `ereignisse` und `uebersicht` wie `KEYS` im Entwurf. Klick öffnet die
    Schublade mit Kacheln, Kurven (`cpu`, `gpu`, `ram`: Zeitraum-Umschalter **6 h · 24 h · 7 Tage**, echte `<button>`
    mit `aria-pressed`), Grenzen-Tabelle und Text aus der Ampel.
  - Die Entwurfs-Tweaks («Beispiel Warnung/Kritisch/KI rechnet», «bewegung») **entfallen**. Bewegung nur ohne
    `prefers-reduced-motion`.
  - **Fokus-Modus und «auf einen Blick»** (Mischa 2026-10-14): Ein gewähltes Bauteil hebt sich ab (Ring + Schein in
    seiner Zustandsfarbe), der Rest der Szene wird gedimmt und entsättigt (~220 ms, `sicht.ts`: `fokusVon`,
    `geraetGedimmt`, `teilGedimmt`). Zurück: Esc, Schliessen-Knopf, Klick ins Leere der Szene, erneuter Klick aufs
    Bauteil. Hover = Vorschau (state-driven). Die Szene zeigt je Bauteil nur den wichtigsten Wert + Zustand, alles
    Weitere steht im Panel. Szene und Details füllen die Fensterhöhe (Details scrollen intern); der 24-h-Streifen
    steht in der Übersicht der Detail-Spalte, bei schmalem Fenster (Schublade) unter der Szene.
  - **Geladene Modelle und RAM-Belegung** (§2.7, 15.10.2026, `modelle.ts`): «Jetzt gerade» zeigt unter «KI rechnet/ruht»
    je geladenem Modell eine Zeile «Grosses Modell (26B) · Prozessor · rechnet · 15 GB» (höchstens 3, Rest als Zahl;
    gekürzt wird nur Rolle/Ort, nie Zustand und Grösse) und gegebenenfalls «rechnet ausserhalb der Warteschlange
    (z. B. Messung/Test)». Panel `ki`: Abschnitt «Geladene Modelle» (Ort, Rechenlast in Kernen, entlädt in, Modell im
    Grafik-/Arbeitsspeicher, was der Prozess im Arbeitsspeicher belegt). Panel `ram`: «Wer belegt den
    Arbeitsspeicher» (Balken in Teilen + Legende: je Modell, übriger KI-Bereich, Trust one, System und Programme,
    verfügbar); der Balken der Fahne «Arbeitsspeicher» zeigt dieselben Teile. Panel `gpu` nennt nur Modelle mit Anteil
    im Grafikspeicher.
- **Keine Hardware-Marken**, nirgends (auch nicht in `aria-label`, `data-tooltip`, Kommentaren im ausgelieferten
  Markup): keine Prozessor-, Grafikkarten-, Board-, SSD- oder NAS-Hersteller und -Modelle. Erlaubt sind Software-
  und Modellnamen (`gemma3:4b`, «Ollama schnell»). Was nicht gemessen wird, wird neutral gezeichnet.
- **Trust one** nur als eine graue Zone/Summe «Trust one · X von 20 GB», ohne Ampel, ohne Bedienung.
- **Zustände:** gut/Warnung/kritisch als Pill mit Icon + Wort (`spec.md` §6.1), neutral für `kommt` (Schloss,
  «kommt mit NAS-Zugang» / «kommt mit Freigabe am Rig» / «kommt mit KI-Planer»), `ruht`, `soll_offen`, `veraltet`
  («Stand vor X min» an jeder betroffenen Kachel), `nie_gemeldet`, `nicht_lesbar`. Gesamt-Banner oben = `gesamt`.
  `hat_daten = false` → EmptyState (`src/components/ui/empty-state.tsx`) «Noch keine Messwerte vom Rig» plus die
  Teile, die ohne Rig gehen (Backup, Abgleich, Index).
- **Aktualisierung:** `stand` alle **15 s** mit `reihen=0`, `reihen` alle 60 s und sofort bei Zeitraum-Wechsel;
  beides **nur bei sichtbarem Tab** (`document.visibilityState`, bei `visibilitychange` sofort nachladen).
  Kein Realtime. Kopf zeigt «Stand HH:MM · aktualisiert sich alle 15 s». Ein Ladefehler: Toast (`sonner`) einmal pro
  Fehlerserie, letzte Daten bleiben stehen und werden als veraltet markiert. Knöpfe mit sofortigem Ladefeedback.
- **Reload-Zustand per URL:** `?teil=<bauteil>&bereich=6h|24h|7d` (`router.replace`, kein History-Spam). Schublade zu =
  `teil` fehlt.
- **Nur Laptop:** Unter **1024 px** Fensterbreite nur EmptyState «Technik ist für den Laptop gebaut» (Icon Laptop),
  keine umgebaute Handy-Ansicht. Geprüft wird bei 1280 und 1440 px Fenster mit Sidebar (240 px), ohne Querscrollen.
- **Hell/dunkel über das App-Theme** (`next-themes`, Klasse `.dark`): Szenen-Farben als CSS-Variablen in einem auf
  `.technik-zwilling` begrenzten Block, hell aus `THEMES.hell`, dunkel aus `THEMES.dunkel` des Generators.
  Allgemeine Flächen über die App-Tokens (`bg-card`, `border-border`, `text-muted-foreground` …).
- App-Regeln: Datum/Zeit immer `timeZone: "Europe/Zurich"` im Format de-CH; Erklärungen über `data-tooltip`
  (nie `title=`); Hover state-driven bzw. `.row-hover`/`.card-hover`; falls ein Auswahlfeld nötig wird
  `SearchableSelect`; Bedienknöpfe als Kasten-Buttons; Zahlen `tabular-nums`; EVENTLINE in Versalien.

### 6.4 Einheiten in der Anzeige

- Platten und NAS **dezimal** (1 GB = 10⁹ B, 1 TB = 10¹² B), wie Hersteller zählen: SSD «2 TB», NAS «533 GB von 8,0 TB».
- Arbeitsspeicher und Grafikspeicher **binär**, beschriftet «GB» (Konvention): «48 GB eingebaut · 47 nutzbar».
- Tempo in «Tokens pro Sekunde» mit Tooltip «Tokens sind Wortteile, keine Wörter».
- Ein-/Auslagern in MB/s (binär wie RAM), Paket und Minutenreihen in Bytes/s.

### 6.5 Abschnitt «Leistung» im KI-Panel (Nachtrag 15.10.2026, Mischa)

«Füge noch irgendwo klein ‹Performance› hinzu, wo man nachschauen kann, wie lange wie viele Seiten dauern, wie oft
die KI richtig liegt, was das grösste akzeptierte Dokument ist — wenn jemand fragt ‹was kann deine KI, wie gut ist
sie›, zeigt man ihnen das.» Kein neuer Bereich, keine neue Seite: Abschnitt im Panel `ki` nach den Kacheln
(`src/components/technik-dashboard/leistung-teil.tsx`), Zeitraum-Umschalter **7 Tage · 30 Tage · gesamt** (Standard
30 Tage, in der URL als `?leistung=7d|alle`). Jede Kennzahl mit einer sichtbaren Zeile «wie gemessen»; keine
Dokumentnamen, Inhalte oder Personennamen. Was im Zeitraum fehlt, steht als «keine», nie geschätzt.

- `GET /api/technik/leistung?zeitraum=7d|30d|alle` (`requireAdmin`, `no-store`): Rig-Teil aus `technik_stand`
  (`rig.leistung`, §2.6), FSM-Teil aus **`technik_leistung(p_von)`** (Migrationen 335/339, security definer, nur
  service_role, 60 s gecacht): Entscheide über Ablage-Vorschläge je Logik (`lokal` seit 12.10., `claude` seit 15.10.;
  unverändert/geändert nach derselben Regel wie `nas_ablage_lernbeispiele`, gezählt ab Start der jeweiligen Logik),
  **Ablagen aus der App** (`uploads`, 339: Upload und Mail-Eingang mit KI-Vorschlag — unverändert = Ordner UND Name wie
  vorgeschlagen, Ordner/Name geändert, je Quelle `regel`/`lokal`/`claude`/`beschrieb`), **grösstes übernommenes
  Dokument** (`groesstes`, 339: meiste Seiten unter den Vorschlägen, deren Ordner übernommen wurde — App: `ki_ordner =
  ordner_pfad`; Rückstau ZZ: übernommen in den vorgeschlagenen Ordner, Seiten aus `nas_zz_beschriebe.beschrieb.seiten`;
  nur `seiten`, `herkunft` app|zz, `am`), KI-Fristen (gefunden/bestätigt/verworfen/offen), Sicherheits-Rapporte der KI
  (`security_runs.narrative`).
- Kennzahlen: gelesene Dokumente/Seiten (davon gescannt), Lesezeit je Seite (Text/gescannt, exakt je Datei) und je
  Dokument (Median, längstes), grösstes übernommenes Dokument (Seiten; dazu das grösste gelesene: Seiten, Zeichen, MB),
  Selbsttest richtiger Ordner (erster Vorschlag / unter den ersten drei, mit und ohne Dateinamen, Verlauf der Nächte),
  Zeit je Datei im Selbsttest, Aufträge der App (Ablage, Inhaltssuche, Frag das Archiv, Belege/Diktate: Anzahl, Median,
  längste; Ablage und Rückstau dazu Rechenzeit je Seite, grösstes Dokument, Teile), Rückstau vorbereitet, Ablage aus der
  App (Trefferquote), Ablage-Entscheide ZZ, Fristen, Sicherheits-Rapporte (mit Rechenzeit je Rapport).
- Laden beim Öffnen, beim Zeitraum-Wechsel (Spinner im Knopf, alte Werte gedimmt) und alle 5 min bei sichtbarem Tab;
  Fehler: ein Toast je Fehlerserie, letzte Werte bleiben.
- **Nachträge gebaut 15.10.2026 abends:** (1) `ki_protokoll` je Auftrag mit Seiten, Zeichen, gescannt, Teile (Ablage,
  Belege/Warenkorb, Rückstau ZZ; Rig `protokoll.py`, `worker.py`, `nachtarbeit.py`); (2) `archiv_text.dauer_ms` (Rig
  `tiefe.py`) → exakte Lesezeit; (3) Protokoll-Eintrag `sicherheit_rapport` (Art, Quelle `rig`, Rechenzeit ohne den Weg
  zum FSM, Modell nur wenn gefragt); (4) FSM-Ablage: `ablage_items.ki_quelle/ki_ordner/ki_name/seiten` (Migration 339,
  `lib/ki/ablage-ki-vorschlag`): die NAS-Seite schickt beim Ablegen die Momentaufnahme des letzten KI-Vorschlags der Karte
  mit, der Server baut den vorgeschlagenen Namen nach demselben Schema und Tag wie den finalen; Seiten nur aus dem Ergebnis
  der lokalen KI. Die Lerntabelle `nas_ablage_lernbeispiele` (329) bleibt dem Rückstau ZZ vorbehalten (sie speist Claudes
  Beispiele — personenbezogene Uploads dürfen dort nie hin).
- **Nachtrag 16.10.2026 — Belegquote:** Kennzahl «Belegquote» nach den Aufträgen: Anteil der Angaben im Beschrieb mit
  Belegstelle (gesamt und je Feld) und der Fristen (getrennt), dazu «wie gemessen» (das Rig prüft ohne KI, ob der Beleg
  wörtlich im gelesenen Teil steht und den Wert trägt — sonst, ob der Wert selbst dort steht; Unbelegtes steht als
  «unbekannt»). Ohne Messung: «noch keine».

### 6.6 Tab «Wissen» (Nachtrag 16.10.2026, Mischa: «sollte bei Technik sein unter einem Tab ‹Wissen›; bei Unklarheiten soll dort die KI auch fragen»)

- Die Seite hat zwei Tabs (TabsNav, CLAUDE.md B4): **Übersicht** (das Dashboard, unverändert; die Tab-Zeile steht unter der
  Kopfzeile und wird für die Fensterhöhe mitgemessen) und **Wissen** (`wissen-teil.tsx`). Tab in der URL (`?tab=wissen`),
  Badge = offene Fragen der KI. Nur Admins, nur Laptop.
- **Firmenwissen** (Migration 344 `ki_wissen`, RLS nur Admin, alle 4 Verben): Kategorie (Abkürzung/Begriff,
  Benennungsregel, Zuordnung, Ansprechpartner/Rolle, Ordner-Hinweis, Sonstiges), Begriff/Titel, Erklärung, optional Bezug
  auf Stammdaten (Location, Kunde, Lieferant, Person), aktiv, geändert von/am. Suche und Filter in der DB
  (`GET /api/technik/wissen?q=&kategorie=&status=`, Zustand in der URL `?wq=&wkat=&wstatus=`), Bearbeiten im Modal.
  Keine E-Mails, Konto-, AHV-, Telefonnummern, Beträge oder Gesundheitsangaben (Prüfung im Server).
- **Nutzung:** aktive Einträge im Nacht-Kontext des Rigs (`GET /api/ki/kontext`, Feld `wissen`; im Beschrieb-Prompt nur
  die zum Teil passenden, ohne Benennungsregeln/Ordner-Hinweise, ≤ 800 Zeichen) und im Claude-Prompt der Ordner-/
  Namenswahl im Rückstau ZZ (`lib/ki/wissen.waehleWissen`: alle Benennungsregeln + Treffer über Begriff/Bezug in
  Dateiname, Ablageort, Beschrieb, Kandidaten, Fakten; ≤ 2400 Zeichen).
- **Offene Fragen der KI** (`ki_wissen_fragen`, `ki_wissen_fragen_dokumente`): Claude liefert je Dokument 0–2
  Rückfragen (unbekannte Abkürzung, Zuordnung Kunde/Lieferant/Partner, unbekannte Person, mehrdeutige Benennung), gleicher
  Filter wie der Beschrieb, dedupliziert über Art + gefalteten Begriff, Zähler «betrifft n Dokumente».
  `POST /api/technik/wissen/fragen` beantworten → Wissens-Eintrag (Kategorie vorgeschlagen) und die offenen,
  unentschiedenen Vorschläge der betroffenen Dateien zur Neuberechnung (Beschrieb → «wartet», der Cron ersetzt den eigenen
  alten Vorschlag); verwerfen → kommt nicht wieder. Eine offene Frage, die kein Dokument mehr stellt, wird «erledigt».

---

## 7. Datenschutz und Grenzen

- Vom NAS kommen nur Zahlen und Zustandswörter: keine Datei-, Ordner- oder Freigabe-Namen, keine Inhalte, kein Login
  ins NAS (SNMP v3 nur lesend bzw. die nur lesenden Mess-Container §1.4 mit eigenem Passwort, erst nach Mischas
  Einrichtung aktiv).
- Trust one: nur `memory.current/high/max` und `cpu.stat` der Slice. Keine Container, Prozesse, Logs, keine Bedienung.
- Keine Hostnamen, IP-/MAC-Adressen, Seriennummern, Hersteller- oder Modellbezeichnungen in Paket, DB, UI, Mail oder Logs.
- Fehlertexte vom Rig gibt es im Paket nicht (nur Codes, z. B. `snmp.grund`); `ki_status.letzter_fehler` wird auf
  200 Zeichen gekürzt und nur Admins gezeigt.
- Lesen nur Admins (RLS + `requireAdmin` + `ADMIN_ONLY_PREFIXES`), Schreiben nur service_role über die Rig-Anmeldung.
- Kein Realtime, keine neuen Secrets im FSM, keine neuen offenen Ports am Rig (einziger Weg nach draussen: Ausgang).

---

## 8. Rollout-Reihenfolge

1. **Migration 313** als Datei (Agent A). Die Eltern-Session spielt sie ein (Prod/lokal teilen die DB).
2. **FSM-Deploy** (Eltern-Session pusht `main` nach Typecheck/Tests): Route nimmt Pakete an, Seite zeigt
   «Noch keine Messwerte vom Rig», Cron läuft (ohne Daten: `messwerte.frische` = kritisch «nie» → **kein Alarm**,
   solange `technik_stand` leer ist; erster Alarm frühestens 10 min nach dem ersten Paket).
3. **Rig-Deploy** (Agent C), nur seriell:
   `flock /tmp/eventline-ki-deploy.lock sudo -n bash <ordner>/install.sh …` wie im README, vorher `/health` prüfen:
   Warteschlange 0. `docker.service` nie neu starten, Trust one nie anfassen. `install.sh` installiert additiv
   `eventline-ki-technik.service` (Muster `PROFIL_UNITS`), legt `/srv/eventline-ki/data/dienst/technik` an,
   installiert smartmontools und das SNMP-Client-Paket, versucht den Lüftertreiber (§1.1).
4. **Prüfen:** `technik_stand` hat drei Zeilen und wird jede Minute frisch, Seite als Admin bei 1280/1440 px hell und
   dunkel, ein Nicht-Admin bekommt 403/Umleitung, Cron-Antwort ohne Fehler.
5. **Am Ende durch Mischa** (die Seite zeigt bis dahin «kommt mit NAS-Zugang»):
   a) im NAS SNMP v3 nur lesend einschalten (eigener Benutzer, v1/v2c aus, wenn möglich nur vom Rig erreichbar);
   b) die Zugangsdaten auf dem Rig in `/etc/eventline-ki/technik-snmp.env` (root `0600`, Felder §1.3) hinterlegen —
      ohne Neustart, der Sammler liest die Datei alle 5 min.
   **Stand 13.10.:** UGOS Pro hat keinen SNMP-Agenten → stattdessen die Mess-Container nach §1.4
   (`rig/eventline-ki/nas-messung/README.md`): Zugang auf dem Rig erzeugen, Compose im NAS als Projekt anlegen,
   Firewall-Regel für 9100/9633 nur vom Rig. Ohne Neustart, der Sammler liest `technik-nas.env` alle 60 s.
