# NAS-Messwerte für das Technik-Dashboard einrichten

**Wozu:** Die Seite `/technik` im FSM zeigt beim NAS bisher «kommt mit NAS-Zugang». Nach dieser Einrichtung zeigt
sie Prozessor- und Board-Temperatur, je Platte Temperatur, Gesundheit und Betriebsstunden, den Zustand des
Speicherpools (RAID), Last und Arbeitsspeicher des NAS.

**Wie:** Auf dem NAS laufen zwei kleine Mess-Container, die nur lesen. Das Rig fragt sie jede Minute mit einem
eigenen Passwort ab. Ins NAS selbst loggt sich dabei niemand ein, und die Firewall lässt nur das Rig an die
Messwerte.

**Dauer:** etwa 15 Minuten. **Du brauchst:** den Zugang zum Rig (`ssh rig` in PowerShell) und die UGOS-Weboberfläche
als Admin.

Technische Einzelheiten stehen im Vertrag (`docs/technik-dashboard/VERTRAG.md` §1.4).

---

## Schritt 1: Zugang auf dem Rig erzeugen

1. PowerShell öffnen und eingeben:
   ```
   ssh rig
   sudo bash /srv/eventline-ki/repo/eventline-ki/nas-messung/zugang-erzeugen.sh
   ```
2. Das Skript erfindet ein langes Zufallspasswort und speichert es auf dem Rig. Angezeigt wird es nirgends.
   Ausgegeben wird:
   - eine lange **Compose-Datei** zwischen zwei Linien aus `=====`. Die kommt in Schritt 2 ins NAS;
   - die Zeile **«Adresse des Rigs für die Firewall-Regel im NAS: …»**. Diese Adresse notieren, du brauchst sie in Schritt 3.
3. Die Compose-Datei bequem in die Zwischenablage holen: ein **zweites** PowerShell-Fenster öffnen (nicht im
   ssh) und eingeben:
   ```
   ssh rig "sudo cat /etc/eventline-ki/technik-nas-compose.yml" | Set-Clipboard
   ```
   Danach liegt die ganze Datei in der Zwischenablage. Du kannst sie auch im Terminal markieren und kopieren.

Bis Schritt 2 erledigt ist, zeigt `/technik` beim NAS «Hardware · Fehler». Das ist normal.

## Schritt 2: Projekt in der UGOS-Docker-App anlegen

1. UGOS im Browser öffnen und als Admin anmelden.
2. Die App **Docker** öffnen. Ist sie noch nicht installiert: **App Center** › «Docker» suchen › **Installieren**.
3. Links auf **Projekt** klicken, dann auf **Erstellen**.
4. **Projektname:** `eventline-nas-messung`
5. **Speicherpfad:** ins Feld klicken › Ordner **docker** wählen › **Ordner erstellen** › Name `eventline-nas-messung`
   › bestätigen › diesen neuen Ordner auswählen › bestätigen.
6. Im Feld **Compose-Konfiguration** den vorhandenen Text ganz löschen und die Compose-Datei aus Schritt 1 einfügen
   (Strg+V).
7. **«Nach dem Erstellen sofort ausführen»** anhaken und auf **Bereitstellen** klicken.
8. Warten, bis beide Container **«Läuft»** zeigen: `eventline-nas-system` und `eventline-nas-platten`. Beim ersten
   Mal lädt das NAS die beiden Programme herunter, das dauert 1–2 Minuten.

*Hinweis:* Die Knöpfe können je nach UGOS-Version leicht anders heissen. Auf Englisch heissen sie «Project › Create»,
«Project name», «Storage path», «Compose configuration», «Run immediately after creation» und «Deploy».

## Schritt 3: Firewall, damit nur das Rig die Ports 9100 und 9633 erreicht

In UGOS: **Systemsteuerung › Sicherheit › Firewall**.

- **Ist die Firewall schon eingeschaltet und eine Konfiguration aktiv:** die beiden Regeln unten **in dieser
  Konfiguration ergänzen**. Lege keine neue an, denn es gilt immer nur eine.
- **Sonst:** «Firewall aktivieren» anhaken und unter «Firewall-Konfiguration» auf **Neu** klicken.

Zwei Regeln anlegen (**Regeln hinzufügen**):

| | Regel A (oben) | Regel B (darunter) |
|---|---|---|
| Aktion | **Erlauben** | **Verweigern** |
| Schnittstelle | der Anschluss, an dem das Hausnetz hängt (meist LAN1) | derselbe |
| Port | «Benutzerdefiniert» › Zielport › **TCP** › `9100,9633` | dasselbe |
| Quell-IP | «Bestimmte IP-Adresse» › **Adresse des Rigs** aus Schritt 1 | **Alle** |

- **Reihenfolge:** Regel A muss **über** Regel B stehen, denn die Regeln gelten von oben nach unten. Mit der Maus lassen
  sie sich verschieben.
- Ganz unten steht, was gilt, wenn keine Regel passt. Das bleibt auf **«Zugriff erlauben»**. Sonst sperrst du für
  alle Computer auch die Dateifreigabe und die Weboberfläche.
- «Aktivieren» anhaken und mit **OK** speichern.

**Probe am eigenen PC:** Im Browser `http://<Adresse des NAS>:9100/metrics` öffnen. Die Seite darf **nicht laden**
und muss mit einer Zeitüberschreitung enden. Erscheint stattdessen eine Passwortabfrage, greift die Firewall nicht.
Bitte dann der KI-Session Bescheid geben. Geschützt sind die Werte durch das Passwort trotzdem.

## Schritt 4: Prüfen

Nach 1–2 Minuten zeigt `/technik` beim NAS **«Hardware»** mit Temperaturen, Platten und Speicherpool. Wer genauer
schauen will, gibt auf dem Rig ein:

```
sudo journalctl -u eventline-ki-technik -n 30 | grep NAS-
```

| Steht dort | Bedeutet | Was tun |
|---|---|---|
| `NAS-Exporter ok/-` | alles läuft | nichts |
| `NAS-Exporter ok/- (ohne platten: …)` | nur der Platten-Container antwortet nicht | in der Docker-App das Protokoll von `eventline-nas-platten` ansehen |
| `NAS-Exporter fehler/keine_antwort` | Container laufen nicht, oder die Firewall sperrt das Rig | Schritt 2 (läuft?) und Regel A (Adresse des Rigs richtig?) prüfen |
| `NAS-Exporter fehler/anmeldung` | Passwort passt nicht: Die Compose-Datei im NAS stammt von einem älteren Zugang | `sudo bash …/zugang-erzeugen.sh --zeigen`, im Projekt «Bearbeiten», neu einfügen, neu starten |
| `NAS-Exporter fehler/zeitlimit` | NAS antwortet zu langsam | eine Weile beobachten, sonst Bescheid geben |
| `NAS-Exporter nicht_eingerichtet/zugang_ungueltig` | Datei auf dem Rig beschädigt | `sudo bash …/zugang-erzeugen.sh --neu`, danach Schritt 2 mit der neuen Compose-Datei wiederholen |

## Wenn etwas nicht klappt

- **Ein Container startet immer wieder neu:** In der Docker-App unter Container › Protokoll nachsehen.
  - «address already in use»: Der Port ist auf dem NAS schon belegt. Bitte der KI-Session melden. Ändern müsste man
    den Port an drei Stellen gleichzeitig: in der Compose-Datei, in der Datei auf dem Rig und in der Firewall-Regel.
  - «Passwort-Hash fehlt»: Statt der fertigen Datei wurde die Vorlage eingefügt. Schritt 1 und 2 wiederholen.
- **Der Platten-Container lässt sich nicht erstellen** (Fehler zu `device_cgroup_rules`), **oder er findet keine Platten**
  (im Protokoll steht «Number of devices found» mit `count=0`): Die Ausweichlösung braucht die Gerätenamen der Platten.
  Bitte der KI-Session melden, sie baut die passende Fassung.
- **Die Schachtnummern auf `/technik` passen nicht zum Gehäuse:** In UGOS unter Speicher › Festplatten die Temperatur
  je Schacht mit `/technik` vergleichen und der KI-Session melden.

## Rückgängig machen

1. In der Docker-App das Projekt `eventline-nas-messung` stoppen und löschen.
2. In der Firewall die Regeln A und B löschen.
3. Auf dem Rig eingeben: `sudo rm /etc/eventline-ki/technik-nas.env /etc/eventline-ki/technik-nas-compose.yml`

Danach zeigt `/technik` wieder «kommt mit NAS-Zugang».

---

## Was die Container dürfen

- **eventline-nas-system** (`prom/node-exporter:v1.12.1`) läuft als Benutzer «nobody» ohne Sonderrechte. Es sieht das
  NAS-Dateisystem nur lesend und liest nur Temperaturfühler, Speicherpool-Zustand, Belegung von `/volume1`,
  Prozessorzeit, Arbeitsspeicher und die Startzeit.
- **eventline-nas-platten** (`prometheuscommunity/smartctl-exporter:v0.15.0`) läuft als root mit einem einzigen
  Sonderrecht: Es darf SMART-Befehle an Platten senden. Es darf die SATA-Platten nur zum Lesen öffnen und kommt an
  keine anderen Geräte heran. Es ist kein «privileged»-Container. Schlafende Platten werden nicht geweckt, und SMART
  wird höchstens alle 5 Minuten gelesen.
- Beide haben ein schreibgeschütztes Dateisystem, höchstens 64 bzw. 96 MB Arbeitsspeicher und einen Viertel Kern,
  dazu kleine Protokolle (höchstens 2 MB).
- Zum Rig gehen nur Zahlen und Zustandswörter. Platten heissen dort nur «Schacht 1–4», ohne Modell und Seriennummer.

## Was noch unsicher ist (geprüft am 13.10.2026)

- **Geprüft** hat die KI-Session dieselbe Compose-Datei auf dem Rig (Docker 29, ohne Netz, danach entfernt). Beide
  Container starten. Ein falsches Passwort wird mit 401 abgewiesen. Der Platten-Container liest mit dem eingeschränkten
  Zugriff echte SMART-Werte einer SATA-SSD. Der Auswerter des Sammlers verarbeitet die echte Ausgabe beider Programme.
- **Nicht geprüft auf UGOS** (die KI-Session loggt sich nie ins NAS ein):
  - Die Docker-App von UGOS (Docker etwa 26) nimmt Projekte mit `network_mode: host`. UGREEN nutzt das selbst im
    Home-Assistant-Beispiel. Sie nimmt auch eigene Pfade wie `/var/run/docker.sock`. Ob sie
    `device_cgroup_rules` und `/dev:/dev:ro` ohne Rückfrage annimmt, ist nicht dokumentiert. Privilegierte Container
    sind laut Anleitungen Dritter möglich, werden hier aber bewusst nicht gebraucht.
  - Ob die UGOS-Firewall Container im Host-Netz filtert, ist nicht dokumentiert. Die Probe in Schritt 3 zeigt es.
  - Für den Speicherpool wird angenommen, dass UGOS den Linux-Standard `mdadm` nutzt. Steht auf `/technik`
    «Speicherpool: nicht lesbar», ist das nicht so.
  - Welche Temperaturfühler das Board meldet, ist offen. Fehlt die Board-Temperatur, steht «nicht lesbar».
  - Die Schachtnummern folgen den Gerätenamen (sda = Schacht 1 …). Angenommen wird, dass UGOS das System auf der
    eingebauten NVMe-SSD hat und die vier Schächte sda bis sdd sind. Bei einem leeren Schacht vor einem belegten kann
    die Nummer verrutschen.
  - Ob die Ports 9100 und 9633 auf dem NAS frei sind.
