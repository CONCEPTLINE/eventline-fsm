# EVENTLINE NAS-Sync (läuft auf dem Büro-Rig)

Holt die im FSM unter **NAS-Ablage** abgelegten Dokumente automatisch in
die Ordnerstruktur des UGREEN-NAS und führt Lösch-/Verschiebe-Aufträge
aus. Das NAS braucht dafür **keine** Erreichbarkeit aus dem Internet —
der Sync fragt selbst beim FSM nach (ausgehende Verbindung, alle 60 s).

Kein Dokument wird inhaltlich analysiert: Übertragen werden Datei,
Zielordner und der im FSM erfasste Dateiname — sonst nichts.

Zusätzlich meldet der Sync die **Ordnerstruktur** des NAS ans FSM
(füllt die Zielordner-Auswahl automatisch, ca. alle 10 Minuten).
Standardmässig OHNE Tiefen-Beschränkung (alle Ebenen). Optionale
Umgebungsvariablen: `SCAN_TIEFE`/`DATEI_TIEFE` (Notbremse in Ebenen)
und `SCAN_AUSSCHLUSS` (kommagetrennte Top-Ordner, die nicht in die
Auswahl gehören; Default `99_System`). Versteckte/System-Ordner
(`@…`, `.…`, `#…`) sind immer ausgenommen.

## Wo es läuft (seit 2026-10-11)

Der Sync läuft **nicht mehr auf dem UGREEN**, sondern als Docker-Container
`eventline-sync` auf dem Büro-Rig (192.168.1.128), neben der lokalen KI.
Grund: Auf dem UGREEN blieben Lösch-Aufträge hängen (Papierkorb-Verschiebung
über Freigabe-Grenzen hinweg); auf dem Rig sind alle Freigaben einzeln
eingehängt und der Sync erkennt eine fehlende Freigabe sicher.

| Baustein | Ort |
|---|---|
| Programm | `rig:/srv/eventline-sync/sync.mjs` (= diese `sync.mjs`, nach Änderung per `scp` dorthin kopieren) |
| Container | `rig:/srv/eventline-sync/docker-compose.yml` (Image `node:22-alpine`, Daten unter `/daten`) |
| NAS-Freigaben (schreibend) | `rig:/mnt/eventline-nas-rw/<Freigabe>` — 11 Freigaben inkl. `99_System`, SMB-Konto `eventline-sync` (nur Schreibrecht, kein Admin) |
| Zugangsdaten | `rig:/etc/eventline-sync/nas.cred` (nur root lesbar); Sync-Token in der Compose-Umgebung. Werte im Token-Register bei Mischa (`_secrets/nas-eventline-sync.txt`, `_secrets/eventline-ablage-sync-token.txt`) |
| Dienste | `eventline-sync-nas.service` (hängt die Freigaben ein) → `eventline-sync.service` (startet den Container). `eventline-sync-nas-retry.timer` holt alle 2 Minuten fehlende Freigaben nach (NAS beim Boot noch nicht da) |

Alltag:

```bash
ssh rig
docker logs --since 10m eventline-sync          # was tut der Sync gerade
systemctl status eventline-sync-nas.service     # sind die Freigaben eingehängt
mount | grep -c eventline-nas-rw                # 11 = alle Freigaben da
```

Wartung (z. B. NAS-Passwort geändert): **beides** stoppen, sonst startet der
Timer den Dienst wieder:

```bash
sudo systemctl stop eventline-sync-nas-retry.timer eventline-sync-nas.service
# … Zugangsdaten in /etc/eventline-sync/nas.cred anpassen …
sudo systemctl start eventline-sync-nas-retry.timer eventline-sync-nas.service
```

Neue `sync.mjs` ausrollen: Datei nach `rig:/srv/eventline-sync/` kopieren und
`sudo systemctl restart eventline-sync.service`.

## Umgebungsvariablen

| Variable | Wert |
|---|---|
| `FSM_URL` | `https://eventline-fsm-usyk.vercel.app` |
| `ABLAGE_SYNC_TOKEN` | Sync-Secret (Vercel-Env gleichen Namens muss übereinstimmen; rotiert am 2026-10-03) |
| `NAS_BASIS` | `/daten` (im Container; auf dem Rig `/mnt/eventline-nas-rw`) |

Test: Im FSM unter **NAS-Ablage** ein Dokument ablegen — nach spätestens
einer Minute liegt es im gewählten NAS-Ordner, und im FSM wechselt der
Status von «Wartet auf Sync» auf «Auf NAS».

## Verhalten

- Dateien werden erst als `.part` geschrieben und dann umbenannt — nie
  halbe Dateien im Zielordner.
- Erst nach erfolgreichem Ablegen wird dem FSM bestätigt; das FSM räumt
  dann den Übergabe-Speicher auf. Schlägt etwas fehl, kommt die Datei
  beim nächsten Durchlauf automatisch wieder.
- Löschen = Verschieben in den Papierkorb der jeweiligen Freigabe
  (`#recycle`). Liegt der Papierkorb auf einem anderen Dateisystem,
  wird kopiert und danach gelöscht (EXDEV-Fallback).
- Ist eine Freigabe nicht eingehängt (Prüfung über das Dateisystem, nicht
  über Marker-Dateien), wird sie übersprungen und beim nächsten Durchlauf
  erneut versucht — nie wird in ein leeres Mount-Verzeichnis geschrieben.
- Antwortet das FSM mit 401 (Token passt nicht) oder 503, wartet der Sync
  und meldet das im Log, statt im Sekundentakt weiterzuhämmern.
- Alternative ohne Docker: `node sync.mjs` (Node 18+) mit denselben
  Umgebungsvariablen auf einem PC, der die NAS-Freigabe gemountet hat
  (`NAS_BASIS` z.B. `Z:/`).

## Alt (bis 2026-10-11): Container auf dem UGREEN

Der frühere Docker-Container `eventline-sync` in der UGOS-Docker-App ist
abgelöst und soll dort entfernt werden (sonst laufen zwei Syncs gegen
dasselbe FSM). Das NAS-Backup (pg_dump + rclone, meldet sich mit
`NAS_BACKUP_TOKEN` beim FSM) läuft weiterhin auf dem UGREEN und ist davon
unabhängig.
