@AGENTS.md

# eventline-fsm — Regeln für JEDE Session auf JEDEM Gerät

Diese Datei reist mit dem Repo und wird von Claude Code automatisch geladen. Sie enthält
(A) die FSM-Bau- & UI-Regeln (identisch zu `projects/CLAUDE.md` auf Mischas PC) und
(B) die eventline-spezifischen Projektregeln, die früher nur im Gedächtnis einer Session lagen.
Wer hier etwas ändert, ändert es für alle Sessions — Regeln nur mit Leo/Mischa anpassen.

# FSM — Bau- & UI-Regeln (gilt für ALLE FSM-Instanzen)

Diese Datei wird **automatisch geladen**, sobald eine Session in einem Projekt unter `projects/` läuft
(Eltern-Ordner-CLAUDE.md) — eventline-fsm, conceptline-fsm, gores-fsm, bombay-staffing und künftige Klone.
Die Grundregeln zur **Arbeitsweise (§0)** und **Git-Disziplin (§13)** stehen global in `~/.claude/CLAUDE.md`.
In Nicht-FSM-Projekten (z.B. trust-core, conceptline-website) gelten hiervon nur die allgemeinen Teile
(Qualität, Verifizieren, Robustheit) — die FSM-UI-Spezifika nicht.
Auf Abruf in jeder Session: „lies die FSM-Regeln aus projects/CLAUDE.md".

Sie müssen bei jedem Build befolgt werden, **ohne dass Leo sie erneut nennen muss.**
Projekt-spezifische Details (Branding, IDs, „main = live" etc.) stehen in den einzelnen Memory-Files, nicht hier.

---

## 1. Was gebaut wird

- **Strikt nur bauen, was angefragt ist.** Keine ungefragten Features. Mitdenken → als Frage formulieren, nicht eigenmächtig einbauen.
- **Less but intuitive — Hinzufügen ≠ besser.** Im Zweifel subtrahieren. Keine inflationären Cards/Buttons.
- **Wenn etwas weg soll, dann komplett weg.** Bei „lösch X" alle Layer entfernen: DB-Spalte, Type, Code, UI. Kein toter Code im Hintergrund.
- **Platzhalter respektieren.** Bewusste „Diese Seite folgt"-Platzhalter nicht eigenmächtig neu bauen.

## 2. Wie gebaut wird (Grundhaltung)

- **Von der Struktur arbeiten, niemals von der UI.** Erst Daten-/Layout-Mechanik durchdenken, dann UI. „Das System soll verheben, professionell." Keine Workarounds.
- **Qualität vor Geschwindigkeit — von Anfang an richtig.** Niemals den schnellsten Weg. Lieber Library/echte Daten installieren als approximieren.
- **Auf lange Sicht bauen (100+ Mitarbeiter).** Architektur langfristig denken, keine Quick-Fixes.
- **Robust by default.** Fragile Patterns vermeiden wenn robuste verfügbar sind: `position: fixed` inline, signed URLs, idempotente Migrationen, Toast bei Fehler.
- **Bestehende Patterns prüfen vor Neubau.** Vor neuem Feature greppen wie Ähnliches schon gelöst ist (Resend, requireAdmin, kasten, Modal). Nie die Default-Lösung wenn eine Eventline-Variante existiert.
- **Konsistenz als Grundregel.** Gleiche Bedeutung = gleiche Darstellung app-weit. Bei Änderungen alle vergleichbaren Stellen mit-anpassen.

## 3. UI-Konventionen (app-weit gleich)

- **Kompakte UI, kein unnötiges Scrollen.** Sections als Mini-Labels, Felder horizontal wo möglich, Cards nicht inflationär.
- **Enter ist Tab, niemals Submit.** Global via `useEnterAsTab()` im `(app)/layout`. Custom-Handler müssen `e.preventDefault()` rufen.
- **Hover IMMER state-driven mit inline-style.** Tailwind `hover:`/`group-hover:` greifen hier unzuverlässig. Jedes interaktive Element: `useState` + `onMouseEnter/Leave` + inline-style (oder `kasten`/`card-hover`-Klassen).
- **Dark-Mode-Sichtbarkeit beachten.** `foreground/[0.03]` verschwindet im Dark. Dark-Werte immer ~2–3x kräftiger setzen.
- **Tooltips via `data-tooltip="..."`**, nicht `title=` (globales CSS in `globals.css`).
- **Dropdowns via `<SearchableSelect>`**, nicht natives `<select>`.
- **Action-Buttons via Kasten-Button-System** (`globals.css` @layer components, Tone-Klassen statt Solid-Fill; Primäraktion = `kasten kasten-<accent>`).
- **Firmenname im UI in Versalien** (EVENTLINE / CONCEPTLINE / GORES / konsistent pro Marke). Code-Identifier/Domains/Emails bleiben klein.

## 4. Daten & Zeit

- **Datenoperationen aus der DB, nicht aus dem JS-State.** Counts/Suche/Filter immer server-seitig. State-Counts skalieren nicht.
- **Datums-Anzeige IMMER mit `timeZone: 'Europe/Zurich'`.** Kein `.slice(0,10)`, kein `toLocale*` ohne timeZone. (Auftrag-Datum-Bug „NIE MEHR".)

## 5. Rechte / RLS

- **Admins dürfen immer alles.** Kein neuer Permission-Slug darf Admin separat verlangen — immer via `has_permission()` / `hasPermission()` gaten.
- **Bei neuen RLS-Rollen alle 4 Verben explizit policy-en** (select/insert/update/delete).

## 6. Verifizieren vor „fertig"

- **Build success ≠ funktioniert.** Nach jeder Änderung aktiv durchdenken (Overflow, Edge Cases) und Risiken benennen.
- **Jeden Action-Button manuell exercieren** bevor „fertig". Destruktive Actions mit `count: 'exact'` verifizieren.

## 7. Ladeanimationen / sofortiges Ladefeedback (Pflicht)

Der Nutzer darf **nie** im Unklaren sein, ob etwas passiert. Bei jeder Aktion und jeder Navigation
sofort sichtbares Feedback. Gilt auch für Agenten, die neue Seiten/Buttons bauen.

- **Buttons / Server-Actions → Spinner im Button, Button disabled solange läuft.**
  - Form mit Server-Action: `const { pending } = useFormStatus()` → `disabled={pending}`, `Loader2 className="h-4 w-4 animate-spin"` + Text „Wird … …".
  - Nicht-Form-Aktion (Klick löst `startTransition`/async aus): `useTransition()` → `isPending`, gleiche Spinner-Logik. Alternativ lokaler `useState`-`loading`.
  - Muster (conceptline-fsm `src/app/login/submit-button.tsx`): `{pending && <Loader2 className="h-4 w-4 animate-spin" />}` / `{pending ? "Wird angemeldet…" : "Anmelden"}`
- **Navigation zwischen Routen → `loading.tsx` je Route** (Next.js Suspense). Zeigt sofort beim Klick ein **Skeleton** im Layout der Zielseite.
  - `Skeleton` = `<div className="shimmer rounded-md …" />` (`src/components/ui/skeleton.tsx`), Shimmer via `globals.css` (`.shimmer` + `@keyframes shimmer`).
  - Skeleton soll das echte Layout grob nachbilden (Header, Suchleiste, Tabellenzeilen), nicht ein leerer Spinner.
- **Seiten-Mount → `page-enter`-Klasse** für sanftes Einblenden (`animation: page-in 0.22s …` in `globals.css`).
- **Fehler → immer Toast** (`sonner`), nie stiller Fehlschlag.

## 8. Version-Update-Meldung (Pflicht bei JEDEM FSM)

Wenn ein neuer Build deployt ist, sollen offene Tabs eine **dezente Meldung „Neue Version verfügbar"**
mit **„Neu laden"-Button** zeigen — **KEIN automatisches Hard-Reload** (würde laufende Eingaben/Speichervorgänge
abbrechen und Daten verlieren). Referenz-Implementierung: **conceptline-fsm**. Beim Aufsetzen/Klonen eines FSM
1:1 mit übernehmen. Bausteine:

1. **`scripts/generate-build-info.mjs`** erzeugt `src/lib/build-info.ts` mit `sha` (aus Git bzw. Vercel-Env-Vars).
   Als `predev`/`prebuild`-Hook in `package.json` verdrahten → SHA ist immer aktuell zum Build.
2. **`src/app/api/version/route.ts`** — `export const dynamic = "force-dynamic"`, gibt `{ sha: BUILD_INFO.sha }`
   mit `Cache-Control: no-store` zurück (= SHA des aktuell deployten Builds).
3. **`src/components/version-watcher.tsx`** (`"use client"`) — vergleicht eingebaute `BUILD_INFO.sha` mit `/api/version`:
   - Poll alle `60_000 ms` **und** bei `visibilitychange` → sichtbar.
   - Lokal (`sha === "dev"` oder leer) nichts tun.
   - Bei Unterschied **einmal** (`useRef`-Guard): `toast("Neue Version verfügbar", { description: "Lade neu, um auf dem aktuellen Stand zu sein.", action: { label: "Neu laden", onClick: () => window.location.reload() }, duration: Infinity })`.
4. **Mounten** in `src/app/layout.tsx`: `<VersionWatcher />`.

## 9. Lade-Performance: Vorladen & Caching (Pflicht bei JEDEM FSM)

Schnelles Gefühl durch Vorladen der wahrscheinlich-nächsten Seite und Zwischenspeichern
selten-ändernder Daten. Referenz-Implementierung: **bombay-staffing**.

- **`PrefetchLink` statt nacktem `<Link>` für Navigations-Links** (`src/components/shell/prefetch-link.tsx`).
  Lädt die Zielseite bei Klick-ABSICHT vor — `onMouseEnter` / `onFocus` / `onTouchStart` —, genau **einmal** je Ziel
  (`useRef`-Guard), `prefetch={false}` am Link selbst. → Detailseite ist meist schon geladen, wenn geklickt wird.
- **Sichtbare Top-Einträge eager vorladen.** In Listen/Browsern die ersten paar Ziele direkt prefetchen,
  z.B. `events.slice(0, 4).forEach((e) => router.prefetch("/events/" + e.id))`.
- **Selten-ändernde Daten quer über Requests cachen** mit `unstable_cache` + Tag (Muster: `src/lib/positions.ts`):
  `unstable_cache(fn, [key, id], { tags: [xTag(id)], revalidate: 3600 })`. Beim Ändern gezielt
  `revalidateTag(xTag(id))` auffrischen — nicht die ganze Seite. Cache-Funktion nutzt den Admin-Client
  (keine Request-Cookies im Cache).
- Zusammen mit §7 (`loading.tsx`-Skeletons streamen sofort) fühlt sich Navigation dadurch instant an.

## 10. Seiten-Zustand über Reload erhalten (Pflicht)

Bei **Browser-Reload (F5)** landet der Nutzer wieder auf **exakt derselben Seite mit denselben
Einstellungen** wie vorher — **nie** zurück auf die Ausgangslage/Default der Seite. Alles was der
Nutzer eingestellt hat, muss den Reload überleben: aktiver Tab, Filter, Suchbegriff, gewählte
Ansicht/Sortierung, aufgeklappte Bereiche, Dichte-Modus, ausgewählter Eintrag usw.

Zwei bewährte Mechanismen (beide bereits in den FSMs im Einsatz):

- **URL-Query-Params** für navigations-/teilbaren Zustand (welche Ansicht/welcher Tab/welche Detail-Auswahl).
  Beim Umschalten `history.replaceState` bzw. `router.replace("?tab=…")`, beim Mount aus `useSearchParams()`
  lesen. Vorteil: überlebt Reload **und** funktioniert mit Vor-/Zurück-Knopf und Teilen des Links.
  Muster: `bombay-staffing` `src/components/ui/pagination.tsx`, `eventline-fsm` `auftraege/neu`.
- **localStorage** für persönliche Filter/Suche/Präferenzen (pro Nutzer, nicht teilbar).
  Lazy-Init aus dem Storage: `useState(() => typeof window !== "undefined" ? localStorage.getItem("<key>") ?? <default> : <default>)`,
  und bei jeder Änderung per `useEffect` zurückschreiben. Key projekt-eindeutig benennen
  (z.B. `auftraege-status`, `cl-density`). Muster: `eventline-fsm` `auftraege/page.tsx`, Dichte-Modus in `providers.tsx`.

Faustregel: **URL** wenn der Zustand „wo bin ich" bestimmt oder teilbar sein soll; **localStorage** für
persönliche Filter-/Anzeige-Vorlieben. Immer `typeof window`-Guard (SSR). Kein Zustand darf nur im
flüchtigen React-State liegen, wenn ein Reload ihn verlieren würde.

## 11. Dropdown / Auswahl-Feld — Standard-Rezept (`SearchableSelect`)

**Jedes** Auswahl-Feld nutzt die app-eigene Combobox `SearchableSelect` (`src/components/ui/searchable-select.tsx`),
**nie** ein natives `<select>`. Referenz-Umsetzung: **Kundenauswahl im „neues Objekt"-Formular** von
gores-fsm (`src/components/objekte/objekt-form.tsx`). So wird sie verwendet:

```tsx
<SearchableSelect
  name="kunde_id"                 // Form-tauglich: rendert intern <input type="hidden" name=…>
  defaultValue={objekt?.kunde_id ?? ""}
  placeholder="— kein Kunde —"     // Anzeige wenn nichts gewählt
  searchPlaceholder="Kunde suchen …"
  allowClear                       // fügt eine leere „—"-Option oben ein → Auswahl entfernbar
  options={kunden.map((k) => ({ value: k.id, label: k.name }))}
/>
```

Eigenschaften des Rezepts (kommen alle aus der Komponente, nicht selbst nachbauen):

- **Optionen** = `{ value, label, sublabel? }[]`. Server-geladene Daten (z.B. Kunden) im Parent auf dieses Shape mappen.
  `sublabel` erscheint klein unter dem Label und wird mitdurchsucht.
- **Suchfeld erscheint automatisch ab > 8 Optionen** (per `searchable` erzwing-/unterdrückbar). Sucht in `label` + `sublabel`.
- **Form-Integration** über `name` → verstecktes `<input type="hidden">`; funktioniert in normalen `<form>`/Server-Actions.
  Alternativ controlled via `value` + `onChange`.
- **`allowClear`** setzt eine leere Option (`value:""`) mit dem `placeholder`-Text an den Anfang → Nutzer kann „nichts" wählen.
- **Tastatur**: ↑/↓ navigieren, Enter wählt, Esc schließt; Klick ausserhalb schließt. Fokus springt beim Öffnen ins Suchfeld.
- **Styling** über bestehende `select`/`card`/`input`-Klassen und Tokens (`var(--accent)`, `var(--muted)`) → passt sich Marke & Dark-Mode automatisch an.

## 12. „Powered by CONCEPTLINE" — Pflicht bei JEDEM FSM/PSA

Jede FSM-/PSA-Instanz (auch White-Label-Kunden wie GORES) muss **irgendwo sichtbar
„powered by CONCEPTLINE"** tragen — CONCEPTLINE immer in Versalien (siehe §3). Referenz: **bombay-staffing**.

- **Platzierung:** dezent im **Sidebar-Footer** (unter der Navigation), abgetrennt per Border, in kleiner
  Muted-Schrift. Muster (`src/app/(app)/layout.tsx`):
  ```tsx
  <div className="border-t border-border px-4 py-2.5">
    <p className="text-[0.6875rem] text-muted-foreground">
      powered by <span className="font-medium text-foreground/80">CONCEPTLINE</span>
    </p>
  </div>
  ```
- **Zusätzlich in den Metadaten** (`src/app/layout.tsx`, `metadata.description`): z.B.
  `"Personaleinsatzplanung … – powered by CONCEPTLINE"`.
- „powered by" klein, **CONCEPTLINE** in Versalien und leicht kräftiger (`font-medium text-foreground/80`).
  Nie das Kunden-Branding damit überdecken — bleibt bewusst unaufdringlich.

## 14. UI-Fallstricke, app-weit (hart gelernt)

- **Modal MUSS den Hintergrund-Scroll sperren**, solange offen: `document.body` `overflow:hidden` **plus**
  Scrollbar-Breite als `padding-right` ausgleichen (sonst springt der Inhalt), beim Schliessen sauber zurücksetzen.
  Zentral in der Modal-Komponente, nicht pro Aufruf.
- **Emoji-Flaggen (🇨🇭) rendern auf WINDOWS NICHT** — der Nutzer sieht nur „CH". Für Flaggen echte Bilder
  nehmen (z. B. `flagcdn.com/20x15/ch.png`, mit 2x-`srcSet` + `onError`-Fallback), keine Regional-Indicator-Emoji.
  Leo ist auf Windows → gilt für jede sichtbare UI.
- **Adaptive Layouts inhalt-getrieben, NICHT zwang-gefüllt:** Karten nach Inhalt sizen; `flex-1`-Strecken
  erzeugt leere, gestreckte Kästen (Leerraum im Kasten). „Fit-to-Viewport ohne Seiten-Scroll" nur für
  Glance-Dashboards — lange Listen-Seiten dürfen/sollen scrollen. Überlange Widgets per `max-height`
  INTERN scrollen (Kopfzeile ggf. sticky). Grosse Screens über `max-w`-Stufe (`2xl:`) breiter nutzen.

## 15. Such-/Deep-Link-/Auswahl-Muster

- **Datensatz „öffnen + in der Liste markieren":** die markierte Zeile via **Callback-Ref** genau einmal
  beim Mount in den Blick scrollen (`scrollIntoView({block:'nearest'})` + `lastScrolledId`-Guard) — NICHT
  via `useEffect` an `[cap]`, sonst reisst jeder Infinite-Scroll-Nachlad zurück zur Zeile, und bei async
  nachgeladenen Listen feuert der Effekt gar nicht.
- Liegt der Datensatz „woanders" (fremde Ansicht, Archiv, spätere Seite), zuerst den **Kontext umschalten**
  (Besitzer-Ansicht/Archiv laden), DANN auswählen. Die Detail-Ansicht rendert immer aus dem gewählten
  Objekt — die Listen-Markierung ist „best effort", wenn der Satz (noch) nicht geladen ist.
- **Globale Suche über ALLE Datensätze** (jeder Besitzer, jeder Status inkl. Archiv) mit Ergebnis-Dropdown
  + „wo liegt er"-Badge schlägt mehrere Spalten-Suchen. Deep-Link `?id=` + globale Suche teilen sich dieselbe
  „intelligent öffnen"-Funktion.
- **int4-Falle:** Schliesst eine `.or()`-Volltextsuche eine Ganzzahl-ID-Spalte via `.eq` ein, sprengt eine
  grosse eingetippte Zahl (z. B. Telefonnummer) int4 → „integer out of range" → GANZE Query failt still.
  Immer `n <= 2147483647` gaten. Und Query-Fehler NIE verschlucken → `toast.error` (siehe §7).

## 16. Vor Deploy adversarisch prüfen (nicht-triviale Changes)

- Bei nicht-trivialen Änderungen VOR dem Push einen adversarischen Selbst-Review fahren (mehrere Blickwinkel:
  Korrektheit/Race, Edge-Cases, Regression). Das hat diese Session echte Bugs gefangen, die im Build grün
  durchgingen (int-Overflow in der Suche, Scroll-Trap beim Infinite-Scroll). Verstärkt §6: **Build success ≠
  funktioniert** — der Review ist die zweite Verteidigungslinie, gerade wenn ein Live-Klick-Test nicht möglich ist.

## 17. UI-Umbauten bestehender Screens (hart gelernt)

Wenn ein bestehender Screen umgebaut oder ein neues UI-Muster übernommen wird,
gelten diese Regeln. Verstoss = Design-Regression die Leo IMMER bemerkt.

- **Vor jedem Umbau: `git show main:<pfad>` lesen.** Die aktuelle Working-Copy
  ist NICHT die Wahrheit — main ist es. Parallele Sessions oder frühere Agenten-
  Läufe können die Referenz zerstört haben, ohne dass es dir auffällt. Never
  modify what you haven't first read in its canonical (= main) form.
- **Bei Agenten-Aufträgen konkrete Referenz-Files nennen — nicht „grepp irgendwo
  im repo".** Statt „nimm das etablierte Underline-Muster" schreib „öffne
  `git show main:src/app/(app)/einstellungen/page.tsx` Zeile 137-160 und kopiere
  den nav-Block exakt". Vage Anweisungen erzeugen Agenten-Raten, das ergibt
  Regressionen.
- **Bei Screenshots von Leo: nicht raten was der Bug ist — verifizieren.**
  Wenn Leo einen Screenshot schickt und sagt „das ist falsch": entweder
  Playwright-Screenshot des Live-Zustands ziehen, ODER `git show main:<file>`
  gegen den aktuellen Zustand lesen. Nur dann fix schreiben. „TypeScript grün"
  ≠ „sieht richtig aus".
- **Strukturelle Design-Änderungen brauchen Leos OK — Agenten dürfen sie NICHT
  autonom entscheiden.** „5 flache Tabs statt 2-Ebenen-Struktur" ist eine
  Design-Entscheidung, keine Umsetzung. Wenn ein Vorschlag die Struktur ändert
  (Menge/Hierarchie/Semantik von Screen-Elementen), zuerst Leo bestätigen
  lassen, dann bauen.
- **Design-Referenz-Memories nutzen.** Für wiederverwendbare Muster (Tabs,
  Kasten-Buttons, Modals, EmptyStates, Form-Layouts) existieren Memory-Files
  mit Referenz-Zeilen aus main. Vor Nutzung/Modifikation IMMER die Referenz
  lesen. Wenn ein neues Muster kanonisch werden soll: neues Memory-File
  anlegen mit dem Referenz-Pfad.

---


---

# B. eventline-fsm — Projektregeln (verbindlich, geräteunabhängig)

## B1. Live-Betrieb
- **`main` = Live-Produktion.** Jeder Push deployt sofort auf Vercel (Projekt `eventline-fsm-usyk`, Team `conceptline`).
  Live-URL `https://eventline-fsm-usyk.vercel.app` (`www.eventline-basel.com` ist die Marketing-Seite, NICHT die App).
- **Datenbank ist localhost + prod GETEILT** (Supabase Zürich `uxtotpniwbwyoznwkygd`). Jede lokale Datenänderung ist live.
  Prod-Daten nur auf klare Anweisung ändern; Test-Eingriffe exakt zurücksetzen (count: exact prüfen).
- **Migrationen** in `supabase/migrations/NNN_*.sql`, fortlaufend nummeriert, idempotent, NUR additiv im selben Push.
  Spalten/Tabellen droppen erst NACH dem Deploy des Codes, der sie nicht mehr braucht (eigene spätere Migration).
- **Deploy-Ablauf:** `npx tsc --noEmit` grün → eslint auf geänderte Dateien (keine NEUEN Befunde; Baseline per
  `git show HEAD:<datei> | npx eslint --stdin --stdin-filename <datei>`) → Commit → `git pull --rebase --autostash origin main`
  → `git push origin main` → Deploy abwarten (`/api/version` liefert den 7-stelligen SHA, 60–120 s) → Live prüfen.
  NIE `--force`. Konflikte in `src/lib/build-info.ts` = generierte SHA, eine Seite nehmen.
- **Parallele Sessions** (Mischa und Leo auf verschiedenen Geräten) arbeiten am selben `main`: nie gleichzeitig an denselben
  Dateien; vor jedem Push `git fetch` + Rebase; Behauptungen über den Stand immer gegen `origin/main` prüfen.
- **Gemeinsamer Arbeitsordner:** Auf Mischas PC arbeiten oft MEHRERE Sessions und Agenten im selben Ordner. Deshalb nur eigene
  Dateien mit Pfad stagen (`git add <pfad>`), NIE `git add -A`/`git add .`/`git commit -a`, NIE `git stash`, NIE `git checkout --`
  oder `git restore` auf Dateien, die man nicht selbst geändert hat. Fremde uncommittete Änderungen stehen lassen.
- **Grössere Umbauten** (z. B. eine Seite komplett neu) auf einem eigenen Branch mit Vercel-Vorschau-Link, erst nach Freigabe auf `main`.
- Pushes/Commits/Typechecks IMMER im Vordergrund (keine Hintergrund-Pushes).

## B2. Schlüssel & Umgebung
- Keine Secrets im Repo. Werte liegen in `.env.local` (gitignored) bzw. auf Mischas PC im Token-Register
  `C:\Users\misch\projects\_secrets\` (Format `NAME=wert`). Auf anderen Geräten: `npx vercel env pull .env.local`
  (Projekt `eventline-fsm-usyk`, Scope `conceptline`) oder Supabase-Dashboard. Werte nie im Chat/Log ausgeben.
- Agenten dürfen NIE Passwörter ändern oder zurücksetzen, um sich einzuloggen.
- **Migrationen/SQL einspielen** braucht einen persönlichen Supabase-Zugangsschlüssel (`SUPABASE_ACCESS_TOKEN=sbp_…`) in
  `.env.local` — der Service-Role-Key reicht dafür nicht (er darf nur Zeilen lesen/schreiben). Jede Person erstellt ihren
  eigenen (supabase.com → Konto → Access Tokens; Owner sind leo@ und admin@), nie Schlüssel teilen. Einspielen mit
  `node scripts/apply-migration.mjs supabase/migrations/<datei>.sql`, danach mit einer Abfrage prüfen.
  Achtung: `vercel env pull .env.local` überschreibt die Datei — den Schlüssel danach wieder eintragen.
- **Migrationsnummer:** vor dem Anlegen `git fetch --all` und die höchste Nummer auf `main` UND allen offenen Branches
  nehmen, +1 (zwei Sessions vergeben sonst dieselbe Nummer).

## B3. Produkt-Entscheide (gelten weiter)
- **Wer und wo (Mischa, 2026-10-11):** Vor jedem Plan und Bau klären und im Plan nennen, WER eine Funktion braucht
  (Rolle/Recht; Technik, Interna, Auswertungen = Admins bzw. passender Rechte-Slug) und WO sie gebraucht wird.
  Das Handy bekommt nur, was im Feld während Operations wichtig ist (Stempeln, Einsätze, Todos, Tickets, Belege, Rapporte).
  Admin-, Technik- und Auswertungsseiten sind Laptop-Seiten ohne eigene Handy-Ansicht. Unklar → kurz fragen statt annehmen.
- Firmenname im UI immer **EVENTLINE** (Versalien); Code/Domains/Mails klein.
- **Kein `/anleitung`-Eintrag** (`src/lib/app-updates.ts`) für Dinge, die nur Admins/Mischa/Leo betreffen
  (Büro-Bildschirm, lokale KI, Dashboard-Interna). Einträge nur für Features, die das ganze Team betreffen.
- Dashboard ist FEST (kein Baukasten): Raster 3×2, Bereiche nach Rechten + Rollen-Schalter `roles.dashboard_bereiche_aus`;
  Basis `src/lib/dashboard-bereiche.ts`, Raster `src/components/dashboard/raster.ts`.
- Projekte und Aufträge bleiben fachlich getrennt. Partner (Location-Portal) ≠ Lieferant (Catering/Technik).
- Verantwortliche Person pro Auftrag ist Pflicht (`project_lead_id`), Avatar neutral grau (`src/components/ui/person-avatar.tsx`).
- Herzog Tech ist der einzige Techniklieferant (keine Auswahl).
- **Lokale KI im Büro-Rig:** Rig-Code (`rig/eventline-ki/`, `rig/eventline-sync/`) und Vertrag (`docs/lokale-ki/SPEC.md`,
  `MASTERPLAN.md`) liegen seit 2026-10-24 im **Trust-one-Repo**; nur die KI-Session (Mischa) deployt auf dem Rig. Das ERP nutzt
  die lokale KI weiter für Diktat (`/api/ki/diktat`), Beleg- und Warenkorb-Erkennung (`/api/tickets/analyze-*`) und den
  Sicherheits-Rapport (`/api/ki/sicherheit`) — über die Warteschlange `ki_auftraege`/`ki_status` (`/api/ki/sync`, `src/lib/ki/`).
  Dokument-INHALTE verlassen das Haus nie; an Cloud-KI gehen nur minimierte Einordnungen/Beschriebe.
- **Ablage (NAS) und Technik-Dashboard leben in Trust one** (`https://one.trust-group.ch`, Bereich «eventline-gmbh»), nicht mehr
  im ERP (kein `/nas`, kein `/technik`). Das ERP leitet nur Mail-Anhänge an `ablage@…` weiter und zeigt die Fristen-Zahl im
  Dashboard/Büro-Bildschirm (`src/lib/trust-one-ablage.ts`, env `TRUST_ONE_URL`, `TRUST_ONE_ABLAGE_TOKEN`). Neue Ablage- oder
  Technik-Funktionen dort bauen, nicht hier. `nas-backup/` bleibt hier (sichert die ERP-DB), meldet aber an Trust one.
- Datums-/Zeitanzeige IMMER `timeZone: "Europe/Zurich"`.

## B4. Design-Referenzen (erst lesen, dann bauen)
- Kasten-Buttons: `src/app/globals.css` (`.kasten`, Tone-Klassen; rot = destruktiv, kasten nie für Navigation).
- Modal: `src/components/ui/modal.tsx` + `useConfirm`; EmptyState: `src/components/ui/empty-state.tsx` (alle Listen).
- Dropdowns: `src/components/ui/searchable-select.tsx`; Tooltips: `data-tooltip` (TooltipLayer), nie `title=`.
- **Tabs = IMMER `<TabsNav>`** (`src/components/ui/tabs-nav.tsx`): Underline, roter Strich `border-red-500`, je Tab ein
  Icon `h-4 w-4` + Label (Referenz-Optik: Portal-Umschalter oben in Einstellungen, Seite Sicherheit). Gilt für JEDE
  Umschaltung zwischen verschiedenen Inhalten/Bereichen einer Seite. Kasten-Knöpfe (`kasten-active`/`kasten-toggle-off`)
  sind als Tabs **veraltet** (Leo, 2026-10-15) — nur noch für Filter DERSELBEN Liste (z. B. «Aktiv | Archiv», Zeitraum).
  Wenn Leo/Mischa «mach Tabs» sagen, ist immer TabsNav gemeint.
- Sticky-Kopf: `src/components/ui/sticky-filter-bar.tsx`; Zeilen-Hover: `.row-hover` in `globals.css`.
- Vorschau von Dokumenten app-weit: `src/components/pdf-popup.tsx`.

## B5. Mobile-Overhaul (eigene Session, SEHR WICHTIG)
Mitarbeiter arbeiten täglich am Handy. Vorgehen in 4 Wellen: Bestandsaufnahme (Screenshots 390×844, hell/dunkel, als Admin und
Techniker) → Konzept als Design-Leinwand zur Freigabe → Bauen nach Nutzung (Techniker zuerst: Stempeln, Einsätze, Todos, Tickets,
Belege) → Review je Welle. **Freigegeben seit 2026-10-11 12:45.** Sperrliste (andere Session baut dort gerade, nicht anfassen):
`src/app/api/ki/**` und `src/lib/ki/**` (lokale KI fürs ERP: Diktat, Belege, Warenkorb, Sicherheits-Rapport — die KI-Session
baut dort). Ablage/NAS-Seite und Technik-Dashboard gibt es im ERP seit 2026-10-24 nicht mehr (Trust one). Der Büro-Bildschirm
(`/bildschirm`) ist ein Wand-TV und kein Mobile-Thema. Vertriebsseiten (`src/app/(app)/vertrieb/**`, `src/components/vertrieb/**`)
gehören Leos Session (kompletter Umbau). Hover-Rezepte für Zeilen/Karten: `.row-hover` und `.card-hover` in `globals.css`
(seit 2026-10-11 app-weit einheitlich; auf Touch-Geräten bleibt der Tint nach dem Tippen hängen — Thema für Mobile).
**Vor jedem Mobile-Auftrag `docs/mobile/HANDY-WISSEN.md` lesen** (Masse «Dicht», Aufbau, Offline, Kalender, Prüf-Ablauf
am S22-Format, Git-Fallen, offene Punkte) und es nach dem Auftrag nachführen.

## B6. Wer ist wer
- **Leo** = Geschäftsführer EVENTLINE, Nicht-Entwickler, deutsch. **Mischa** = IT, Nicht-Entwickler, deutsch; schreibt oft vom
  selben Konto wie Leo — nie annehmen, wer gerade schreibt; Leo in der 3. Person nennen, wenn Mischa schreibt.
- Knapp antworten, entschieden handeln, Tools ohne Rückfrage ausführen, nie «soll ich…?». Nur bauen, was angefragt ist.
