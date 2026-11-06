# Vertrag Etappe 1 — Kalender (Barakuba)

Verbindliche Schnittstelle zwischen den Bau-Agenten. Abweichungen nur über die Hauptsession.
Freigegebene Vorlage (Mischa «top alles perfekt», 05.11.2026): Skizze im Worktree
`C:\Users\misch\projects\eventline-fsm-skizze` — `src/components/skizze/partner/**` (Partnerportal),
`src/components/skizze/intern/**` + `src/app/(app)/skizze/location-kalender` (intern) +
`src/app/(app)/skizze/personal` (Personal-Zuteilung). Optik und Verhalten 1:1 von dort übernehmen,
Demo-State durch echte API ersetzen.

## Datenbank — Migration `384_standort_kalender_eintraege.sql` (idempotent, nur additiv)

1. `standort_termine` (aus 382) erweitern:
   - `quelle text null check (quelle in ('programmheft'))`
   - `quelle_id text null check (char_length(quelle_id) <= 300)` — Kennung des Programmheft-Eintrags (URL)
   - unique index `(location_id, quelle_id) where quelle_id is not null`
   - `quelle = 'programmheft'` ⇒ Art «programm» im Kalender, sonst «termin».
2. Neu `standort_serien` — Veranstaltung (einmalig oder wiederkehrend), wird beim Laden aufgelöst:
   `id uuid pk, location_id → locations on delete cascade, titel (1–200), kunde (≤200) null, notiz (≤2000) null,
   datum date (erster Tag), ganztaegig bool, von time null, bis time null,
   wiederholung text check in ('nie','woechentlich','monatlich'), wochentage smallint[] not null default '{}' (Mo=0…So=6),
   bis_datum date null (null = ohne Ende; bei 'nie' immer null), ausnahmen jsonb not null default '{}'
   (Schlüssel = ursprünglicher Tag YYYY-MM-DD → "geloescht" | {titel,kunde,notiz,datum,ganztaegig,von,bis}),
   erstellt_von → profiles null, created_at, updated_at (+ Trigger update_updated_at)`.
3. Neu `standort_uebernahmen` — «EVENTLINE übernimmt alle Privatvermietungen von–bis»:
   `id, location_id, von date, bis date check (bis >= von), notiz (≤2000) null, erstellt_von, created_at, updated_at`.
4. Neu `standort_mitarbeiter` — Mitarbeiter ↔ Location (n:m):
   `location_id → locations on delete cascade, profile_id → profiles on delete cascade, created_at, erstellt_von,
   primary key (location_id, profile_id)`.
5. RLS wie 382: alle vier Verben, `is_internal_user()` + `has_permission('locations:view'|'locations:edit')`.
   `standort_mitarbeiter`: select mit `locations:view` ODER Personal-Leserecht; schreiben mit dem Recht,
   das heute Personal bearbeiten darf (im Code nachsehen, z. B. `users:edit`). Partner: KEINE Policy —
   nur über `/api/partner/**` mit Service-Rolle nach `requirePartnerPortal`. anon: alles entziehen.

## Gemeinsame Typen — `src/lib/standort-kalender.ts` (Backend-Agent besitzt die Datei)

```ts
export type KalenderArt = "termin" | "veranstaltung" | "programm" | "anfrage" | "auftrag" | "belegt";
export interface KalenderEintrag {            // bestehend, ergänzt um:
  // … alle bisherigen Felder …
  serieId: string | null;       // nur veranstaltung
  serienTag: string | null;     // ursprünglicher Tag der Serien-Instanz (YYYY-MM-DD)
  wiederkehrend: boolean;       // veranstaltung mit wiederholung != 'nie'
  quelleId: string | null;      // nur programm
}
export type Wiederholung = "nie" | "woechentlich" | "monatlich";
export interface SerieEingabe { titel; kunde|null; notiz|null; datum; ganztaegig; von; bis; wiederholung; wochentage: number[]; bisDatum: string|null }
export interface Uebernahme { id: string; von: string; bis: string; notiz: string | null }
export type VerfuegbarStufe = "frei" | "knapp" | "nicht";
export interface TagVerfuegbarkeit { tag: string; stufe: VerfuegbarStufe; frei: string[]; weg: { name: string; grund: string }[]; text: string }
export interface ProgrammFund { quelleId: string; titel: string; datum: string; von: string | null; bis: string | null; url: string; status: "neu" | "vorhanden" | "geaendert" }
export interface KalenderAntwort {
  eintraege: KalenderEintrag[];
  uebernahmen: Uebernahme[];
  /** nur Tage im Zeitraum mit stufe != "frei"; leer, wenn der Location niemand zugeteilt ist */
  verfuegbarkeit: TagVerfuegbarkeit[];
}
```

## Endpunkte

Partner (nach `requirePartnerPortal`, Standort aus der Sitzung, Recht `partner:belegungsplan:view` / `:edit`):
- `GET  /api/partner/belegungsplan?start&end` → `KalenderAntwort` (Route bleibt, Inhalt erweitert)
- `POST/PATCH/DELETE /api/partner/kalender-termine` — wie heute (Einzeltermin)
- `POST /api/partner/kalender-serien` (SerieEingabe) · `PATCH /api/partner/kalender-serien/[id]` body
  `{ umfang: "serie" | "nur_diesen", serienTag?, eingabe }` · `DELETE …/[id]?umfang=serie|nur_diesen&serienTag=`
- `POST/PATCH/DELETE /api/partner/uebernahmen[/id]` ({von,bis,notiz})
- `GET  /api/partner/programmheft` → `{ funde: ProgrammFund[], quelle: string }` (liest
  https://www.barakuba.ch/veranstaltungen/ serverseitig, vergleicht mit standort_termine.quelle_id)
- `POST /api/partner/programmheft` body `{ quelleIds: string[] }` → übernimmt gewählte Funde als Programm-Termine

Intern (RLS-Client, `locations:view`/`:edit`) — gleiche Formen unter `/api/standorte/[id]/…`:
`belegungsplan` (GET, erweitert, mit vollen Namen in verfuegbarkeit), `kalender-termine`, `kalender-serien`,
`uebernahmen`, `programmheft`, plus `GET/PUT /api/standorte/[id]/mitarbeiter` (`{ profileIds: string[] }`)
und `GET/PUT /api/personal/[id]/standorte` (`{ locationIds: string[] }`).

## Verfügbarkeit (Regel, Mischa 04.11.)
Pro Tag und Location: zugeteilte Personen (`standort_mitarbeiter`). Eine Person ist «frei», wenn sie an dem
Tag KEINE Abwesenheit hat und KEINEN Einsatz bei einem Auftrag an einer ANDEREN Location (ganzer Tag zählt).
0 frei ⇒ «nicht» («EVENTLINE nicht verfügbar»), 1 frei ⇒ «knapp», ≥2 ⇒ «frei». Niemand zugeteilt ⇒ keine Angabe.
Partner sieht nur Stufe + Text ohne Gründe der Abwesenheit (Datenschutz: «nicht verfügbar» / «knapp»).

## Benennung
UI: «Belegungsplan» heisst überall «Kalender» (Partnerportal + intern). Partner-Route neu `/partner/kalender`,
`/partner/belegungsplan` leitet dorthin um. API-Pfade und Rechte-Slugs bleiben (keine Umbenennung in der DB).
