# EVENTLINE NAS-Sync (UGREEN)

Holt die im FSM unter **NAS-Ablage** abgelegten Dokumente automatisch in
die Ordnerstruktur des UGREEN-NAS. Das NAS braucht dafür **keine**
Erreichbarkeit aus dem Internet — es fragt selbst beim FSM nach
(ausgehende Verbindung, alle 60 Sekunden).

Kein Dokument wird inhaltlich analysiert: Übertragen werden Datei,
Zielordner und der im FSM erfasste Dateiname — sonst nichts.

## Einrichtung auf dem UGREEN (einmalig, ~10 Minuten)

Voraussetzung: In UGOS die **Docker**-App installieren (App Center).

1. Diesen Ordner (`docs/nas-sync/`) auf das NAS kopieren, z.B. nach
   `docker/eventline-sync/`.
2. In der Docker-App ein **Image bauen** aus diesem Ordner (Dockerfile
   wird erkannt) — Name z.B. `eventline-sync`.
3. **Container erstellen** mit:
   - **Volume**: die Ziel-Freigabe des NAS (dort, wo die Ordnerstruktur
     liegt) → im Container auf `/daten` mounten.
   - **Umgebungsvariablen**:
     | Variable | Wert |
     |---|---|
     | `FSM_URL` | `https://eventline-fsm-usyk.vercel.app` |
     | `ABLAGE_SYNC_TOKEN` | das Sync-Secret (liegt bei Mischa im Token-Register: `_secrets/eventline-ablage-sync-token.txt`) |
     | `NAS_BASIS` | `/daten` |
   - **Neustart-Richtlinie**: `always` (läuft nach NAS-Reboot weiter).
4. Container starten. Im Log erscheint
   `EVENTLINE NAS-Sync gestartet — Ziel: /daten, Intervall: 60s`.

Test: Im FSM unter **NAS-Ablage** ein Dokument ablegen — nach spätestens
einer Minute liegt es im gewählten NAS-Ordner, und im FSM wechselt der
Status von «Wartet auf Sync» auf «Auf NAS».

## Verhalten

- Dateien werden erst als `.part` geschrieben und dann umbenannt — nie
  halbe Dateien im Zielordner.
- Erst nach erfolgreichem Ablegen wird dem FSM bestätigt; das FSM räumt
  dann den Übergabe-Speicher auf. Schlägt etwas fehl, kommt die Datei
  beim nächsten Durchlauf automatisch wieder.
- Alternative ohne Docker: `node sync.mjs` (Node 18+) mit denselben
  Umgebungsvariablen auf einem Büro-PC, der die NAS-Freigabe gemountet
  hat (`NAS_BASIS` z.B. `Z:/`).
