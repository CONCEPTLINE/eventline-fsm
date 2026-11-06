# Vertrag Etappe 2 — Vermietungs-Ablauf (Barakuba)

Verbindliche Schnittstelle zwischen den Bau-Agenten. Abweichungen nur über die Hauptsession.
Freigegebene Vorlage (Mischa «top alles perfekt», 05.11.2026): Skizze
`C:\Users\misch\projects\eventline-fsm-skizze\src\components\skizze\vermietung\**` + `src/app/(app)/skizze/vermietung/page.tsx`
(daten.ts = Felder, Konditionen, Schritte, Mail-Regeln; panels.tsx = Inhalt je Schritt; vertrag.tsx = Vertragstext in Basils Namen;
eml.ts = Outlook-Entwurf; reiter.tsx = Tabs + Eckdaten-Karte; strahl.tsx = Schritt-Leiste; mailverlauf.tsx = Verlauf mit Rückgängig).
Unterlagen: `C:\Users\misch\AppData\Local\Temp\claude\6d3342cacb779526\8912eec0-0fbc-40d1-8ec7-4b2b42643674\scratchpad\barakuba-unterlagen.md`
+ Ordner `...\scratchpad\dropbox\a\` (Mietbedingungen, Vertrags-Vorlagen «Du Vorlage Vertrag Freitag.doc», Formulare, Infoblatt,
Checkliste), Poller-Merkblatt `C:\Users\misch\Downloads\MI Poller-Merkblatt_190506.pdf`.

## Fachliche Regeln (fix, mit Basil abgesprochen — nicht ändern)
- Vermietung = NORMALER Location-Auftrag (`jobs.job_type='location'`, `location_id` = Barakuba). KEIN Tag/Typ/Badge «Vermietung» in der UI.
  Intern schaltet allein das Vorhandensein einer Zeile in `auftrag_ablauf` die Ablauf-Ansicht ein.
- 5 Schritte: 1 Anfrage & Konditionen · 2 Bestätigung · 3 Vertrag & Pollerformular · 4 Vertrag unterschrieben · 5 Übergabe erfolgt.
  Strahl links: grau = offen, grün = erledigt, rot = aktuell. Rechts der Inhalt des aktuellen (oder angeklickten) Schritts.
- Bis «Vertrag unterschrieben» ist der Auftrag im Partner-Kalender für Basil VERBORGEN (intern sichtbar ab Zusage).
- Übergabe: 1 h ab 14:00 am Veranstaltungstag (real ~40 Min, bewusst 1 h). Übergabeperson nur aus den der Location zugeteilten
  Personen (`standort_mitarbeiter`, Etappe 1). Infomail 7 Tage vorher wird nur VORBEREITET — ein Klick öffnet den Entwurf in Outlook.
- Vertrag im Namen von Basil (Ich-Form, Unterschrift Basil Erny) aus seiner Vorlage + Kundendaten. Komplettservice: Preis individuell
  (optionales Preisfeld; leer = keine Kosten-Zeile). Basil rechnet alles mit dem Kunden ab; EVENTLINE stellt Basil Rechnung.
- Tabs bei Aufträgen MIT Ablauf nur: Ablauf · Rapport & Abschluss · Dokumente & Historie (ersetzen die anderen; ohne Ablauf bleibt alles wie heute).
  Eckdaten-Karte ganz zuklappbar, Standard zugeklappt (localStorage `auftrag-eckdaten-offen`). Kein Zeitstrahl.
- Mails werden NICHT aus der App versendet. «In Outlook öffnen» lädt eine .eml mit `X-Unsent: 1` (An = Kunde, CC = auftrag@in.eventline-basel.com).

## Datenbank — Migration `385_auftrag_ablauf.sql` (idempotent, nur additiv)
- `auftrag_ablauf` (1:1 zu jobs): `job_id uuid pk → jobs on delete cascade, schritt smallint not null default 1 check 1..5`
  (= aktueller Schritt), `erledigt smallint[] not null default '{}'`, `felder jsonb not null default '{}'` (Typ `AblaufFelder` = `Felder`
  aus Skizze daten.ts), `fixiert_am timestamptz null` (Zusage), `unterschrieben_am timestamptz null`,
  `uebergabe_person_id → profiles null`, `uebergabe_start timestamptz null`, `vertrag_dokument_id → documents null on delete set null`,
  `abgeschlossen_am timestamptz null`, `created_at, updated_at` (+Trigger).
- `auftrag_ablauf_ereignisse`: `id, job_id → jobs cascade, zeit timestamptz default now(), text text, schritt smallint null` (setzt diesen
  Schritt erledigt), `quelle text check in ('mail','manuell','system')`, `auftrag_mail_id → auftrag_mails null`, `rueckgaengig_am timestamptz null`,
  `erstellt_von → profiles null`.
- RLS: alle vier Verben, intern, gleiches Recht wie Aufträge lesen/bearbeiten (Slugs in src/lib/permissions.ts nachsehen, z. B. jobs:view/jobs:edit).
  Partner: keine Policy. anon: entziehen.
- `auftrag_mails` += `cc text[] null` (für Erkennung und Anzeige).

## Mail-Erkennung (Eingang auftrag@)
1. Neuer Auftrag: Mail ohne Zuordnung (Nummer/Verlauf/KI finden nichts) und
   a) Absender = Partner-Konto (`profiles.role='partner'`, `partner_location_id` mit `partner_kalender=true`) ODER
   b) KI erkennt eindeutig eine neue Privatvermietungs-Anfrage für eine solche Location
   → Auftrag anlegen (job_type location, status 'anfrage', Titel «<Anlass> <Mieter>», start/end aus Datum + Beginn, contact_* aus Feldern,
   project_lead_id = Profil leo@eventline-basel.com, Fallback erster aktiver Admin), `auftrag_ablauf` Schritt 1 mit aus Mail/Anhang
   (Vorbesprechungs-Formular) gelesenen Feldern, Ereignis «Ablauf erkannt …». Sonst Verhalten wie heute (wartet).
2. Mail mit Zuordnung zu einem Auftrag MIT Ablauf: Einordnung per KI (structuredCall) in
   `konditionen_an_kunde | zusage_kunde | bestaetigung_an_kunde | vertrag_an_kunde | vertrag_unterschrieben | felder_ergaenzung | sonstiges`
   → Wirkung wie Skizze DEMO_SKRIPT: konditionen→Schritt 1 erledigt; zusage→fixiert_am + status 'offen' (intern im Kalender);
   bestaetigung→2; vertrag_an_kunde (mit Anhängen)→3; vertrag_unterschrieben→4 + unterschrieben_am (ab jetzt für Basil sichtbar),
   Anhang als Dokument; felder_ergaenzung→fehlende Felder ergänzen (nie manuell gesetzte überschreiben). Jede Wirkung = Ereignis mit
   Rückgängig. Schritt 5 nur manuell («Übergabe erfolgt»), danach bis Event-Ende aktiv, dann «Abrechnung» (Rapport & Abschluss).
   Nur Mails mit auftrag@ in TO oder CC kommen überhaupt an — ausgehende Mails von @eventline-basel.com mit CC sind der Normalfall.

## Endpunkte (intern, RLS-Client)
- `GET  /api/jobs/[id]/ablauf` → `{ ablauf, ereignisse, mails (auftrag_mails des Jobs, neueste zuerst, mit cc), personal: TagVerfuegbarkeit-Personen der Location am Tag }`
- `PATCH /api/jobs/[id]/ablauf` body `{ felder?: Partial<AblaufFelder>, uebergabe_person_id?, uebergabe_start? }`
- `POST /api/jobs/[id]/ablauf/schritt` body `{ aktion: "erledigt" | "zurueck", schritt }` (manuell, mit Ereignis)
- `POST /api/jobs/[id]/ablauf/ereignisse/[eid]/rueckgaengig`
- `POST /api/jobs/[id]/ablauf/vertrag` → erzeugt Vertrags-PDF (pdf-lib, Text aus Skizze vertrag.tsx/Basils Vorlage), legt es in
  `documents` (bucket documents, `jobs/{id}/vertrag/…`, folder «Vertrag»), setzt vertrag_dokument_id → `{ dokumentId, url }`
- `GET  /api/jobs/[id]/ablauf/eml?art=konditionen|bestaetigung|vertrag|infomail` → `message/rfc822`-Download (Anhänge bei vertrag:
  Vertrag-PDF + Infoblatt + Checkliste + Poller-Merkblatt; statische Unterlagen als Dateien unter `src/lib/ablauf/unterlagen/`).
