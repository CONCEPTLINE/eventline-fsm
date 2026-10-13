# Handy-Ansicht EVENTLINE — Wissen für künftige Mobile-Aufträge

Stand 2026-10-14 (main `fd0ea40c`). Für jede Session, die am Handy-Teil von eventline-fsm baut.
Zuerst lesen, dann bauen. Regeln aus `CLAUDE.md` (A + B) gelten zusätzlich.

## 1. Grundsätze (Entscheide Leo/Mischa)
- **Wer und wo:** Das Handy bekommt nur Feld-/Operations-Funktionen (Stempeln, Einsätze, Kalender, Todos,
  Tickets & Belege, Rapporte, Ferien, Locations nachschlagen). Admin-, Technik- und Auswertungsseiten sind
  Laptop-Seiten. Der Büro-Bildschirm (`/bildschirm`) ist ein Wand-TV, kein Handy-Thema.
- **Desktop bleibt unverändert.** Handy-Anpassungen nur mit `max-md:`-Klassen bzw. eigenem Handy-Baum
  (`useIsMobile()`); md = 768 px.
- **Masse «Dicht»** (Entscheid 13.10. nach Bildvergleich, nicht wieder «Kompakt» vorschlagen): Knöpfe 34 px,
  grosse Knöpfe 40 px, Listenzeilen 42–52 px, untere Leiste 48 px, mobiler Kopf 46 px (Titel 18 px, 16 px Rand),
  Seitenrand 10 px, Schrift 12–17 px. Abbildung alt→neu: 44→34, 48→36, 52→40, 56→42, 60→46, 64→48, 68→52;
  text-[14px]→12, 15→13, 16→14, 17→15, 19→16, 20→17; p-4→10 px, py-3→7 px.
- **Tailwind-Falle:** Grundschrift 15 px → `h-11` = 41 px. Am Handy immer px-Werte (`h-[34px]`).
- **Eingabefelder 16 px Schrift** (sonst zoomt iOS beim Antippen).
- **Uhrzeiten nur mit `ZeitFeld`** (`src/components/ui/zeit-feld.tsx`, Zifferntastatur, «0930»→09:30), nie
  `<input type="time">` — Android öffnet sonst einen Uhr-Dialog statt der Tastatur.
- **Hover gibt es am Handy nicht:** Knöpfe, die nur bei Hover erscheinen (`opacity-0 group-hover:…`), sind am
  Handy unsichtbar aber antippbar → am Handy immer sichtbar machen (`max-md:opacity-100`), 34-px-Tastfläche.
- **Kein Vorschau-Link nötig** für Handy-Arbeit: bauen, mit Screenshots prüfen, dann direkt auf main pushen.

## 2. Aufbau
| Teil | Datei |
|---|---|
| Weiche Handy/Desktop | `src/lib/use-is-mobile.ts` (true/false/null — bei null Skelett, keine Abfragen starten) |
| Mobiler Kopf | `src/components/mobile/mobile-kopf.tsx` — Titel aus den Breadcrumbs der Seite (Detailseiten setzen ihren Namen nur am Handy, Muster `standorte/[id]/page.tsx`) |
| Untere Leiste | `src/components/layout/mobile-nav.tsx` (Dashboard, Todos, Stempeln, Kalender, Mehr) + `mobile/mehr-sheet.tsx` |
| Höhen | `globals.css`: `--kopf-h` calc(46px + safe-area) bzw. 82px mit Büro-Hinweis, `--nav-h` 52px; Toasts +54 px |
| Statusleiste | `src/components/theme-color-sync.tsx`: genau EIN `theme-color`-Meta, folgt dem App-Theme (next-themes), nicht dem Handy. Keine `themeColor` in Layout-`viewport`-Exports. Manifest `#fafafa`. Am S22 bestätigt: keine schwarzen Ränder mehr (14.10.). |
| Dashboard | `(app)/dashboard/page.tsx`: Handy + Nicht-Admin → `mobile/heute-screen.tsx`; Admin behält das Raster |
| Kalender | `(app)/kalender/page.tsx` → `mobile/kalender-monat.tsx` (iPhone-Monatsansicht, s. u.) |
| Auftrag / Rapport | `mobile/auftrag-feld.tsx`, `mobile/rapport-mobil.tsx` |
| Weitere Handy-Screens | `mobile/stempel-sheet.tsx`, `stempelzeiten-mobil.tsx`, `ferien-mobil.tsx`, `tickets-mobil.tsx`, `todos-mobil.tsx`, `mein-konto-mobil.tsx`, `lade-fehler.tsx`, `offline-streifen.tsx`, `uebertragungen-sheet.tsx`, `app-install-hinweis.tsx` |
| Modals | `ui/modal.tsx` wird am Handy zum Bottom-Sheet (`max-md:`); Formulare darin einspaltig |
| Partnerportal | `components/partner/partner-mobil-nav.tsx`, `app/partner/(portal)/layout.tsx` (Seitenrand 10 px) |
| Lieferantenportal | am Handy nur Hinweis «am Computer öffnen» |

## 3. Offline
- `src/lib/offline/db.ts` (IndexedDB v3, u. a. `rapport_drafts` Schlüssel [user_id, job_id]),
  `stempel-outbox.ts`, `rapport-outbox.ts`, `sync-trigger.ts`, `sw-vorladen.ts`; Service Worker `src/app/sw.js`
  (Feld-Seiten-Cache, SEITE_VORLADEN, 4-s-Lie-Fi-Fallback); `src/lib/me-cache.ts` (localStorage).
- `src/lib/einsaetze.ts`: `ladeMeineEinsaetze` (bisTag **exklusiv**), `ladeGecacht` (Offline-Stand mit
  «Stand HH:MM · offline»), Zürich-Tage `zuerichTag`/`plusTage`. `meId` immer aus `usePermissions()`, nie
  `auth.getUser()` («Ansicht als»).
- `api-auth` liefert bei Auth-Ausfall 503 (kein Abmelden ohne Netz). Abmelden = nur dieses Gerät.

## 4. Kalender am Handy (`mobile/kalender-monat.tsx`)
- Monatsraster wie iPhone: heute roter Kreis, gewählter Tag dunkler Kreis, Punkte/Pillen (max. 4 Segmente) in
  den Desktop-Legendenfarben: Auftrag rot, Vermietung hellblau (`EinsatzJob.vermietung` aus `jobs.was_anfrage`),
  Projekt grün, Termin ohne Auftrag grau, Abwesenheit gelb.
- Tag antippen → Tagesliste (Zeilen mit Farbbalken; Abwesenheiten mit Namen, eigene «Du · …»).
- Ich|Team (`?sicht=team`, nur scope ≠ self); Team lädt alle sichtbaren genehmigten Abwesenheiten (RLS
  `time_off_select_team`). Zustand `?tag=YYYY-MM-DD` per `history.replaceState(null, …)` (kein Server-Request).
- Wischen: 3-Monats-Track folgt dem Finger, Schwelle 25 % oder Schwung > 0.4 px/ms, 280 ms Gleiten, Höhe gleitet
  mit, Nachbarmonate vorgeladen (In-Memory-Cache), während der Animation Eingaben gesperrt, reduced motion beachtet.
- «+» nur mit `can("kalender:create")` → `NeuerTerminModal` mit `sheet` (Auftragsliste erst beim Antippen der
  Suche). Wer «+» sieht, regeln Leo/Mischa über die Rollen (Einstellungen → Rollen → Kalender «Erstellen») —
  kein offener Punkt, Rollen nie eigenmächtig ändern.

## 5. Prüfen (Pflicht vor «fertig»)
- `npx tsc --noEmit` (Fehler unter `.next/` = Altlasten), ESLint ohne neue Befunde gegenüber `git show HEAD:<datei>`.
- **Screenshots am S22-Format** (360×780, DPR 3, Android-UA, Touch), hell + dunkel, als Admin und per «Ansicht als»
  (Dario Knezevic = Team-Leiter mit Einsätzen; Basil Erny = Partner). Impersonation ist nur-lesen (423 bei
  Schreibversuchen); Developer-Mode danach zurücksetzen. Automatisch prüfen: Seitenbreite = 360, nichts ausserhalb,
  keine Text-Überlappung, nichts abgeschnitten. Auf Mischas PC liegen fertige Skripte in
  `C:\Users\misch\projects\_tools\eventline-mobile\` (README dort).
- Popup «Neue Funktionen in der App» erscheint nach jedem neuen `/anleitung`-Eintrag — im Test schliessen.
- Live prüfen: `/api/version` zeigt den 7-stelligen SHA nach 1–2 min.

## 6. Git-Fallen (hart gelernt)
- Nur eigene Dateien mit Pfad stagen. Schlägt ein Pfad fehl (z. B. alter Name nach `git mv`), bricht **das ganze**
  `git add` ab → danach `git status` prüfen, bevor committet wird.
- Vorschau-Branch nach Squash/Rebase nicht mehr fast-forward → unter neuem Branch-Namen pushen, nie `--force`.
- Vor jedem Push `git fetch` + Überschneidung prüfen (`comm` der geänderten Dateien), Konflikte in
  `src/lib/app-updates.ts` = beide Einträge behalten, neuester zuoberst.
- Team-weite Handy-Features bekommen einen `/anleitung`-Eintrag (`src/lib/app-updates.ts`), Admin-Interna nicht.

## 7. Offene Punkte (Stand 14.10.)
- Eingabefeld-Rahmen 1 px vs. 2 px uneinheitlich (`ui/input.tsx` `file:border-0`) — nicht geändert, weil Desktop-weit.
- Location-Plan-Betrachter am Handy fix 620 px hoch, kein Zwei-Finger-Zoom (Laptop-Funktion, gelassen).
- `NeuerTerminModal`: «keine Auswahl = mir selbst» nutzt `auth.getUser()` (unter «Ansicht als» der echte Admin).
- Fenster «Neuer Verrechnungssatz» nutzt nicht `ui/modal.tsx`.
