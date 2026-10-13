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
| Prozessor (Temperatur Paket/Kerne/Chipsatz, Last, Takt, Drosselzähler), RAM (`/proc/meminfo`, PSI, `pgmajfault`), Netz/Platte-Zähler, Slices | 10 s | `/sys/class/hwmon`, `/proc/stat`, `/proc/cpuinfo`, `/sys/devices/system/cpu/cpu*/thermal_throttle/package_throttle_count`, `/proc/pressure/memory`, `/proc/vmstat`, `/proc/net/dev`, `/proc/diskstats`, cgroup-Dateien |
| Grafikkarte | 10 s | `nvidia-smi --query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,power.limit,fan.speed,pstate,driver_version,clocks.gr,clocks.max.gr --format=csv,noheader,nounits` (nie `name`) |
| Dienste | 30 s | `docker ps -q --filter label=com.docker.compose.project=eventline-ki` + `docker inspect` (wie speicherprofil.sh), Speicher je Container aus der cgroup des PID |
| Platten-Belegung System/Tresor | 60 s | `os.statvfs` auf `/` und `/srv/eventline-ki/data` |
| SSD-Gesundheit und -Temperatur | 5 min | `smartctl -H -A --json` (smartmontools darf installiert werden; fehlt es → `ssd.status = "nicht_verfuegbar"`) |
| RAM-Module | beim Start, dann 1×/Tag | `dmidecode -t memory` → nur Steckplatz-Nummer und Grösse in GB (nie Hersteller, Teilenummer, Seriennummer) |
| NAS-Basis | 60 s, **eigener Unterprozess, hartes Zeitlimit 5 s** | `statvfs` auf eine eingehängte Freigabe (alle liegen auf demselben Volume), Liste der aktiven Einhängungen unter `/mnt/eventline-nas`, TCP-Verbindungstest Dateifreigabe und Weboberfläche **ohne Login** |
| NAS-SNMP | 5 min, eigener Unterprozess, Zeitlimit 10 s | siehe §1.3 (nur, solange keine Mess-Container eingerichtet sind) |
| NAS-Mess-Container (Exporter) | 60 s, eigener Unterprozess, hartes Zeitlimit 15 s (je Verbindung 6 s) | siehe §1.4 — Vorrang vor SNMP |

- **Lüftersensor:** Nur wenn ein Treiber ohne Kernel-Parameter und ohne Neustart lädt (z. B. `modprobe` des
  Super-I/O-Treibers) und danach `fan*_input` in hwmon erscheint. Dann dauerhaft über
  `/etc/modules-load.d/eventline-technik.conf`. Sonst bleibt `cpu.luefter_rpm` weg (Seite: «kommt mit Freigabe am Rig»).
- **Trust one nur als Summe:** gelesen werden ausschliesslich `system-trustone.slice/{memory.current,memory.high,memory.max,cpu.stat}`.
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
  Hauptmodell geladen) → Block `ki`.
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
  Einhänge-Konfiguration), `NAS_EXPORTER_PORT_SYSTEM` (9100), `NAS_EXPORTER_PORT_PLATTEN` (9633). Erzeugt von
  `nas-messung/zugang-erzeugen.sh` (Zufallspasswort, nie angezeigt; ins NAS kommt nur der Hash). Neu gelesen alle 60 s.
- Datei fehlt → alles wie bisher (SNMP-Pfad §1.3, ohne dessen Datei `snmp.status = "nicht_eingerichtet"`). Datei da, aber
  ungültig (Feld, Länge, Zeichen, Adresse, Port, Rechte nicht root 0600) → `"nicht_eingerichtet"` mit
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
  `betriebsstunden`, `umgelagert` (5), `ausstehend` (197), `nicht_korrigierbar` (198), `crc_fehler` (199).
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
- Antwort: `200 {"success":true}`; der Dienst wertet nur den Status aus.

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
             "psi_full_avg10": 0, "psi_some_avg10": 0, "seitenfehler_s": 0,
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
| rig (vom Sammler) | `cpu.temp`, `cpu.temp.max`, `cpu.last`, `cpu.last.max`, `cpu.takt_mhz`, `gpu.temp`, `gpu.temp.max`, `gpu.last`, `gpu.last.max`, `gpu.vram_mib`, `gpu.watt`, `ram.verfuegbar_gb`, `ram.ki_gb`, `ram.ki_fest_gb`, `ram.trustone_gb`, `ram.swap_gb`, `ram.psi_full`, `ram.psi_full.max`, `ram.seitenfehler_s`, `ram.seitenfehler_s.max`, `netz.rx_bps`, `netz.tx_bps`, `platte.lesen_bps`, `platte.schreiben_bps`, `ssd.temp` |
| ki (vom FSM aus dem Block `ki` abgeleitet) | `ki.warteschlange`, `ki.geladen_gb`, `ki.tokens_s`, `ki.fsm_antwort_ms` |
| nas (vom FSM abgeleitet, nur wenn `nas.gemessen_am` neu) | `nas.belegt_prozent`, `nas.system_temp`, `nas.platte_temp.max`, `nas.last` |

GB-Werte hier binär (GiB), wie das System zählt; Anzeige siehe §6.4.

### 2.4 Typen (Agent A legt `src/lib/technik-dashboard/typen.ts` **als Erstes 1:1** an)

```ts
// Technik-Dashboard: Paket vom Rig (v1) und Antwort von GET /api/technik/stand.
// Verbindlich laut docs/technik-dashboard/VERTRAG.md — Aenderungen nur ueber den Vertrag.

export type DienstName = "ki_dienst" | "ollama_schnell" | "ollama_gruendlich" | "whisper" | "datenbank" | "webserver" | "ausgang";
export type Instanz = "schnell" | "gruendlich";

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
    psi_full_avg10?: number; psi_some_avg10?: number; seitenfehler_s?: number;
    ki?: { belegt_b?: number; fest_b?: number; cache_b?: number; grenze_b?: number; swap_b?: number };
    trustone?: { summe_b?: number; grenze_hoch_b?: number; grenze_max_b?: number };
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
  minute?: Record<string, number>;
}

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
    }>;
    raid?: "normal" | "wiederaufbau" | "degradiert" | null;
    last_prozent?: number; ram_prozent?: number; uptime_s?: number;
  };
}

export interface PaketV1 { v: 1; gesendet_am: string; rig?: RigPaket; ki?: KiPaket; nas?: NasPaket }

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
  ereignisse: Ereignis[];                            // neueste zuerst, Zeitraum = bereich (max. 200)
  reihen: Reihen | null;                             // nur bei ?reihen=1
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
| `gpu.temp` | gpu · rig | < 75 °C | 75 – 85 °C | > 85 °C | ja |
| `ram.verfuegbar` | ram · ram | > 8 GB | 4 – 8 GB | < 4 GB | ja |
| `ram.druck` (`psi_full_avg10`) | ram · ram | < 5 | 5 – 30 | > 30 | ja |
| `ram.seitenfehler` | ram · ram | < 500 /s | 500 – 3000 /s | > 3000 /s | nein |
| `ram.ki_fest` (`ram.ki.fest_b / grenze_b`, nie den Zwischenspeicher) | ram · ram | < 80 % | 80 – 95 % | > 95 % | ja |
| `ram.trustone` | ram · — | immer `neutral`/`info`, nur Summe | – | – | nie |
| `ram.swap` | ram · ram | < 2 GB | 2 – 6 GB | > 6 GB | nein |
| `platte.system`, `platte.tresor` | platten · platten | < 80 % | 80 – 90 % | > 90 % | ja |
| `ssd.temp` | platten · platten | < 60 °C | 60 – 70 °C | > 70 °C | ja · `ssd.status ≠ ok` → neutral/`kommt` «kommt mit Freigabe am Rig» |
| `ssd.gesundheit` | platten · platten | `ok` | `warnung` oder Abnutzung ≥ 90 % | `fehler` | ja · sonst wie oben |
| `dienst.<name>` (je Dienst) | dienste · rig | läuft und gesund (oder ohne Healthcheck) | Absturz in den letzten 24 h (`technik_ereignisse` art `absturz`) oder `startet`/`neustart` | `gesund = false`, `gestoppt`, `oom`, **fehlt** (Pflichtdienst aus `DIENST_NAMEN` nicht im Paket, `ollama_gruendlich` nur bei Schalter `hauptmodell`) | ja (Warnung nie) |
| `ki.warteschlange` (ältester offener `ki_auftraege`) | ki · ki | < 10 min · leer → `neutral`/`ruht` wenn kein Auftrag läuft | 10 – 30 min | > 30 min | ja |
| `nas.erreichbar` | nas · nas | `fehlversuche_in_folge` = 0 | 1 – 2 | ≥ 3 | ja |
| `nas.volume` | nas · nas | < 80 % | 80 – 90 % | > 90 % | ja |
| `nas.freigaben` | nas · nas | ist = soll | eine fehlt < 10 min (`fehlt_seit`) | eine fehlt > 10 min | ja · `soll = null` → neutral/`soll_offen` |
| `nas.hw.systemtemp` | hardware · — | < 70 °C | 70 – 85 °C | > 85 °C | ja, nur bei `snmp.status = ok` |
| `nas.hw.plattentemp` (max) | hardware · — | < 45 °C | 45 – 55 °C | > 55 °C | ja, nur bei ok |
| `nas.hw.plattengesundheit` | hardware · — | alle ok | eine `warnung` | eine `fehler` | ja, nur bei ok |
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
    Lüfter drehen nach `gpu.luefter_prozent` bzw. `cpu.luefter_rpm` (fehlt → ruhig, kein erfundener Wert).
  - NAS-Front mit vier nummerierten Schächten, Ein-Knopf, Lämpchen; Netzwerk-Lampe blinkt bei Ablage-Abgleich
    (`ablage.sync` gut und `letzter_poll` < 90 s). Schachtbestückung neutral, solange SNMP keine `platten` liefert.
  - Leitungen Rig ↔ App (Verbindung) und Rig ↔ NAS (Ablage) mit Zustand der zugehörigen Ampel.
  - Bauteile = `Bauteil` (§2.4) plus `ereignisse` und `uebersicht` wie `KEYS` im Entwurf. Klick öffnet die
    Schublade mit Kacheln, Kurven (`cpu`, `gpu`, `ram`: Zeitraum-Umschalter **6 h · 24 h · 7 Tage**, echte `<button>`
    mit `aria-pressed`), Grenzen-Tabelle und Text aus der Ampel.
  - Die Entwurfs-Tweaks («Beispiel Warnung/Kritisch/KI rechnet», «bewegung») **entfallen**. Bewegung nur ohne
    `prefers-reduced-motion`.
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
