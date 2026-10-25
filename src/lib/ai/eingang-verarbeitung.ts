// Kern der Auftrag-Eingang-Verarbeitung — von ZWEI Aufrufern genutzt:
//  - /api/ai/eingang (User legt Element in der App ab; Auth + Sichtbarkeit
//    prueft die Route vorher unter USER-RLS)
//  - /api/inbound/mail (weitergeleitete Mail via Resend-Webhook; kein User)
// Dazu der Nachlauf auf den Bestand (scripts/eingang-nachlauf.mts, Modus
// nurPositionsgruppen) — gleiche Regeln, nur die Positionsgruppen.
// Laeuft komplett auf dem Admin-Client. Wirft bei Fehlern (nachdem das
// Element auf ai_status='fehler' gesetzt wurde) — der Aufrufer entscheidet
// ueber die Antwort.

import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import { structuredCall } from "@/lib/ai/anthropic";
import { logTechnik, festerTechnikLieferant } from "@/lib/technik-server";
import { TECHNIK_BEZEICHNUNG_MAX, TECHNIK_TEXT_MAX, TECHNIK_TITEL_MAX, gruppeLabel, gruppeNummer } from "@/lib/technik";
import { auftragArchiviert } from "@/lib/archiv";
import { logError } from "@/lib/log";

/** Kategorie, wenn keine Katalog-Kategorie passt. */
const KATEGORIE_SONSTIGES = "Sonstiges";

/** Quellen-Regel der Positionsgruppen (Leo 2026-10-25: «Er soll keine Daten
 *  aus Offerten nehmen, sondern aus dem, was der Kunde sagt.») — EIN Text fuer
 *  Systemprompt und Schema, im Vollauf wie im Nachlauf (nurPositionsgruppen).
 *  Vorfall INT-26306: Gruppen «Zeiten gemaess Offerte …» und «Stundensatz
 *  max. CHF 30.00» aus Leos Antwortmail mit zitiertem Offert-Verlauf. */
const REGEL_POSITIONSGRUPPEN =
  "QUELLE der positionsgruppen ist AUSSCHLIESSLICH, was der KUNDE selbst verlangt, beschreibt oder ausdrücklich bestätigt " +
  "(dazu zählen technische Vorgaben, die der Kunde mitschickt, z.B. Band-Rider oder Technikliste der Künstler, und Notizen des " +
  "EVENTLINE-Teams, die Kundenangaben wiedergeben, z.B. aus einem Telefonat). " +
  "NIE aus Offerten/Angeboten (Bexio-Offerte, Offert-PDF, 'gemäss Offerte', von EVENTLINE offerierte Positionen oder Leistungen) " +
  "und NIE aus Vorschlägen von EVENTLINE, die der Kunde nicht ausdrücklich bestätigt hat. " +
  "Ist der NEUE EINGANG selbst eine Offerte/ein Angebot von EVENTLINE, bleibt positionsgruppen leer. " +
  "ZITIERTE MAILVERLÄUFE: bei jeder Nachricht den Absender prüfen — Text von EVENTLINE (@eventline-basel.com, Mails 'via bexio.com') " +
  "ist KEINE Quelle, nur die Nachrichten des Kunden. Bestätigt der Kunde etwas, das EVENTLINE vorgeschlagen hat (z.B. Zeiten), " +
  "formuliere es als Kundenaussage OHNE Bezug auf Offerte/Angebot, z.B. titel 'Einsatzzeiten', beschreibung " +
  "'Fr ca. 14–18 Uhr, Sa ca. 9–19 Uhr (vom Kunden bestätigt)'. " +
  "BISHERIGE ZUSAMMENFASSUNG und CHRONIK dienen nur der Einordnung — ihre Offert- und Preisangaben nie übernehmen. " +
  "KEINE Preise, Beträge, Stundensätze, Budgets, Rabatte, Zahlungs- oder Vertragskonditionen und keine Preisverhandlung — " +
  "eine Preisvorstellung des Kunden ist KEINE Position. Der Techniklieferant sieht alles.";

/** Harte Sperre hinter der Regel: Preis-/Offert-Bezug in Titel, Beschreibung,
 *  Bezeichnung oder Details → die KI-Aenderung wird NICHT gespeichert (der
 *  Techniklieferant sieht alles). Bewusst eng: Waehrungs-Betraege, «30.-»,
 *  Stundensatz & Co., Rabatt, Budget, Offerte/offeriert, Angebot — nicht
 *  «Fr.» (Freitag) und nicht «Preis» (Preisverleihung, Preise uebergeben). */
const RE_PREIS_OFFERTE =
  /\b(?:CHF|SFr|EUR|Franken)\b|€|\d\s?\.[-–](?!\d)|\b(?:Stunden(?:satz|ansatz|preis|lohn)|Tages(?:satz|ansatz)|Rabatt\w*|Budget\w*|Skonto|Offert\w*|offerier\w*|Angebot(?:s|e|en)?)\b/i;

export function preisOderOffertBezug(...texte: (string | null | undefined)[]): boolean {
  return texte.some((t) => !!t && RE_PREIS_OFFERTE.test(t));
}

/** Eingang von EVENTLINE selbst (eigene Antwort oder Weiterleitung). */
function vonEventline(absender: string | null | undefined): boolean {
  return /@([a-z0-9-]+\.)*eventline-basel\.com>?$/i.test((absender ?? "").trim());
}

// Supabase-Join kommt je nach Kardinalitaet als Objekt ODER Array zurueck.
function relName(v: unknown): string | null {
  const o = Array.isArray(v) ? v[0] : v;
  return o && typeof o === "object" && "name" in o ? String((o as { name: unknown }).name) : null;
}

export type DatumVorschlag = { start_datum: string; end_datum: string; grund: string };

export type TerminVorschlag = {
  aktion: "erstellen" | "aendern";
  termin_id: string | null;
  titel: string;
  start: string;
  ende: string | null;
  grund: string;
};

export type EinzelpositionVorschlag = {
  aktion: "neu" | "aendern" | "entfernen";
  position_id: string | null;
  menge: number;
  bezeichnung: string;
  kategorie: string;
  details: string | null;
};

export type GruppenVorschlag = {
  aktion: "neu" | "aendern" | "unveraendert" | "entfernen";
  gruppe_id: string | null;
  titel: string;
  beschreibung: string;
  einzelpositionen: EinzelpositionVorschlag[];
};

/** Im Nachlauf (nurPositionsgruppen) fehlen alle Felder ausser
 *  kundenaussagen + positionsgruppen. */
type Ergebnis = {
  zusammenfassung?: string;
  datum_aenderung?: { start_datum: string; end_datum: string | null; grund: string } | null;
  inhalt_datum?: string | null;
  termin_vorschlaege?: TerminVorschlag[];
  kundenaussagen?: string;
  positionsgruppen: GruppenVorschlag[];
};

/** Ergebnis-Schema (strict-Tool). positionsgruppen steht bewusst ZULETZT:
 *  an erster Stelle lieferte das Modell im Test (2026-10-25) leere Listen —
 *  erst nach der Zusammenfassung hat es den Eingang «durchdacht».
 *  Die Kategorien der Einzelpositionen
 *  kommen aus dem Katalog des festen Techniklieferanten — die KI ordnet
 *  zu, statt alles unter «Sonstiges» abzulegen. Strict-Schemas kennen kein
 *  "minimum" — die Menge ist «integer», das Runden/Mindestens-1 macht der Code.
 *  kundenaussagen (nicht gespeichert) ist der Arbeitsschritt VOR den Gruppen:
 *  erst die Aussagen des Kunden herausloesen, dann nur daraus Gruppen bilden.
 *  nurGruppen = Nachlauf auf den Bestand: nur kundenaussagen + positionsgruppen. */
function ergebnisSchema(kategorien: string[], nurGruppen = false) {
  const kategorieFeld = kategorien.length
    ? {
        type: "string",
        enum: [...kategorien, KATEGORIE_SONSTIGES],
        description: `Passende Kategorie aus dem Katalog des Techniklieferanten; «${KATEGORIE_SONSTIGES}» nur wenn wirklich keine passt.`,
      }
    : { type: "string", description: `Kurze Kategorie (z.B. Audio, Licht, Video, Bühne, Mobiliar), sonst «${KATEGORIE_SONSTIGES}».` };
  const voll = {
  type: "object",
  additionalProperties: false,
  required: ["zusammenfassung", "datum_aenderung", "inhalt_datum", "termin_vorschlaege", "kundenaussagen", "positionsgruppen"],
  properties: {
    zusammenfassung: {
      type: "string",
      description:
        "KURZFASSUNG im Telegrammstil — der Leser muss in ZWEI BLICKEN erfassen, was Sache ist. " +
        "ZWINGEND: Zeile '=== OPERATIV ===' (Durchführung), dann Zeile '=== ADMINISTRATIV ===' (Geschäftliches). " +
        "Pro Kachel MAXIMAL 6 Stichpunkte, jeder genau EINE Zeile im Format '- Schlagwort: Kernaussage'. " +
        "Das Schlagwort ist KURZ (1-3 Wörter, nie über 30 Zeichen), ohne Klammer-Zusätze und ohne Doppelpunkt — alle Details gehören in die Kernaussage. " +
        "Die Kernaussage ist ein KLARER, verständlicher Satz für jemanden, der den Vorgang nicht kennt — kurz, aber kein kryptisches Fragment. " +
        "Abkürzungen und Fachjargon aus Mails NIE unerklärt übernehmen: ausschreiben oder in Klammern erklären (z.B. 'Tech' → 'technische Probe', 'Get-in' → 'Zugang zur Location'). " +
        "Fremdsprachige Eingänge ins Deutsche übertragen. Zahlen und Fakten NUR, wenn sie wörtlich im Eingang stehen — nichts errechnen, nichts schätzen. " +
        "Wichtigstes zuoberst: aktueller Stand und was zu tun ist. Offene/zu klärende Punkte als '- OFFEN: …' — " +
        "IMMER als vollständiger, selbsterklärender Auftrag formuliert (was ist zu tun/zu klären, ggf. mit wem und bis wann), " +
        "z.B. '- OFFEN: Frau Pappenberger antworten, ob die Offerte für beide Lieferszenarien gilt' — NIE nur ein Stichwort. " +
        "Meldet das neue Element, dass ein offener Punkt erledigt/geklärt ist, ENTFERNE ihn aus OFFEN (nicht als erledigt stehen lassen). " +
        "TEAM-EINTRÄGE (intern vom EVENTLINE-Team erfasst, keine Mails): Das Team dokumentiert NACH dem Erledigen — was drinsteht, IST gemacht und die Kundschaft darüber bereits informiert. " +
        "Leite daraus NIEMALS neue Offen-Punkte ab (kein 'prüfen', 'mitteilen', 'anpassen', 'informieren') und ENTFERNE bestehende Offen-Punkte, die dadurch erledigt oder hinfällig sind. " +
        "Offen bleibt nur, was das Team AUSDRÜCKLICH als offene Frage oder noch zu erledigende Aufgabe formuliert. " +
        "Nennt ein neueres Element andere Zahlen, Namen oder Termine als bisher (z.B. 6 statt 9 Podeste), ERSETZE die alte Angabe ÜBERALL in der Zusammenfassung — auch in Offen-Punkten; die alte Zahl darf nirgends stehen bleiben. " +
        "ZEITLOGIK: Massgeblich ist das SENDEDATUM des Inhalts (bei Weiterleitungen die Sent:/Gesendet:-Daten im Verlauf), NICHT die Reihenfolge des Eintreffens. " +
        "Ordne das neue Element anhand der CHRONIK zeitlich ein: Ist es NEUER, ersetzt sein Stand die älteren Angaben. " +
        "Ist es ÄLTER als bereits Verarbeitetes, ergänze nur fehlende Hintergründe — den aktuellen Stand (geklärte Fragen, aktuelle Namen/Termine/Abmachungen) darfst du damit NICHT zurückdrehen. " +
        "KEINE Abschnitts-Titel, KEINE Detail-Aufzählungen (Stückzahlen-Listen etc. bündeln — Details bleiben im Eingang abrufbar). " +
        "KEINE Meta-Hinweise über Abweichungen zwischen den Systemdaten des Auftrags (Datum, Ort, Kunde) und dem Eingang — sie veralten, sobald das Team " +
        "die Daten korrigiert. Ein abweichendes Event-Datum gehört AUSSCHLIESSLICH in datum_aenderung (Vorschlag mit Entscheid); die Zusammenfassung " +
        "beschreibt nur die Veranstaltung und den Stand. Steht ein solcher Hinweis noch in der bisherigen Zusammenfassung, entferne ihn. " +
        "Deutsch, nichts erfinden. Leere Kachel: Marker-Zeile trotzdem schreiben.",
    },
    datum_aenderung: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["start_datum", "end_datum", "grund"],
      description:
        "NUR wenn der neue Eingang EINDEUTIG ein neues/verschobenes Event-Datum fuer DIESEN Auftrag nennt — sonst null.",
      properties: {
        start_datum: { type: "string", description: "Neues Event-Startdatum als YYYY-MM-DD." },
        end_datum: { type: ["string", "null"], description: "Neues Enddatum als YYYY-MM-DD, null = gleich wie Start." },
        grund: { type: "string", description: "Ein Satz: woraus sich das neue Datum ergibt." },
      },
    },
    inhalt_datum: {
      type: ["string", "null"],
      description:
        "SENDEDATUM des Inhalts als ISO (YYYY-MM-DD oder mit Zeit): bei weitergeleiteten Mails das NEUSTE Datum " +
        "im Verlauf (Sent:/Gesendet:-Zeilen), nicht das Weiterleitungsdatum; null wenn nicht erkennbar.",
    },
    termin_vorschlaege: {
      type: "array",
      description:
        "NUR wenn das neue Element konkrete Auftrags-Termine mit Datum UND Uhrzeit nennt (Aufbau, Abbau, Probe, Lieferung, Besprechung vor Ort). " +
        "Du legst NIE selbst Termine an — das Team wird gefragt. " +
        "Vergleiche mit BESTEHENDE TERMINE: existiert der Termin schon mit gleicher Zeit, NICHT vorschlagen; " +
        "existiert er mit anderer Zeit, aktion 'aendern' mit dessen termin_id; sonst aktion 'erstellen'. Leer wenn keine Termine genannt.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["aktion", "termin_id", "titel", "start", "ende", "grund"],
        properties: {
          aktion: { type: "string", enum: ["erstellen", "aendern"] },
          termin_id: { type: ["string", "null"], description: "Bei 'aendern' die id aus BESTEHENDE TERMINE, sonst null." },
          titel: { type: "string", description: "Kurzer Termin-Titel, z.B. 'Aufbau' oder 'Abbau'." },
          start: { type: "string", description: "Beginn als ISO 8601 MIT Schweizer Zeitzonen-Offset, z.B. 2026-09-22T13:30:00+02:00." },
          ende: { type: ["string", "null"], description: "Ende als ISO 8601 mit Offset, null wenn unbekannt." },
          grund: { type: "string", description: "Ein Satz: woraus sich der Termin ergibt." },
        },
      },
    },
    kundenaussagen: {
      type: "string",
      description:
        "Arbeitsschritt VOR positionsgruppen (wird nicht gespeichert): die Aussagen des KUNDEN im NEUEN EINGANG zu Technik, Bühne, Mobiliar, " +
        "Personal, Betreuung, Begehung und Zeiten — je Zeile '- <wer>: <Aussage>'. Text von EVENTLINE, Offerten/Angebote und Preise gehören NICHT hierher. " +
        "'keine', wenn der Kunde dazu nichts sagt.",
    },
    positionsgruppen: {
      type: "array",
      description:
        "Die ANFORDERUNGEN des Kunden als nummerierte POSITIONSGRUPPEN — was er braucht oder wünscht, AUCH WENN noch nichts gebucht ist " +
        "(Technik, Bühne, Mobiliar, Personal, technische Betreuung, Begehung). Gebildet NUR aus kundenaussagen. " +
        REGEL_POSITIONSGRUPPEN + " " +
        "EINE Gruppe je Wunsch: kurzer titel + beschreibung im Klartext mit ALLEN Angaben aus dem Eingang zu diesem Wunsch " +
        "(Masse, Personenzahl, Zweck, Ort im Raum, Zeiten), z.B. titel 'Rahmen', beschreibung '3 m hoch, 4 m breit, um ein Tuch darin zu spannen'. " +
        "einzelpositionen = konkretes MATERIAL dieser Gruppe mit Menge — AUSSCHLIESSLICH was der Eingang woertlich nennt " +
        "(z.B. '2 Stative und eine 4-m-Traverse' => 2x Stativ, 1x Traverse 4 m). Schreibt der Kunde generisch ('ein Rahmen', 'Ton bis hinten gut hoerbar'), " +
        "bleibt einzelpositionen LEER — der Techniklieferant waehlt dann die passende Loesung. NIE Material erfinden, ergaenzen oder aus Erfahrung ableiten. " +
        "Wuensche ohne Material (z.B. 'Ton bis hinten gut hoerbar', 'Technikcheck ab 17:30') sind Gruppen ohne Einzelpositionen. " +
        "LISTEN (Band-Rider, Technik- oder Kanalliste): Gruppen so gliedern wie die Liste selbst (z.B. je Musiker/Instrument, Abschnitt 'Backline') " +
        "und jedes Material mit der Menge GENAU wie im jeweiligen Abschnitt — nie über Abschnitte hinweg zusammenzählen oder umrechnen. " +
        "Ein blosser Hinweis auf eine solche Liste ('Rider kommt mit', 'Technik gemäss Rider') ist KEINE eigene Gruppe. " +
        "Vom Kunden bestelltes Material ohne passenden Wunsch bekommt eine eigene Gruppe (z.B. titel 'Mobiliar', Einzelposition 10x Stehtisch). " +
        "Gegen BESTEHENDE POSITIONSGRUPPEN abgleichen (IDs exakt uebernehmen): gleicher Wunsch, nichts Neues = NICHT auffuehren; " +
        "neue/andere Angaben zu einem bestehenden Wunsch (z.B. 'doch 5 m breit') = 'aendern' mit gruppe_id und der VOLLSTAENDIGEN neuen beschreibung " +
        "(alte Angaben, die weiter gelten, mitschreiben; die ueberholte Angabe ersetzen) — NIE eine zweite Gruppe fuer denselben Wunsch; " +
        "Gruppe bleibt, aber ihr Material aendert sich = 'unveraendert' mit gruppe_id (titel/beschreibung wie bisher) und den Einzelpositionen; " +
        "vom Kunden gestrichen = 'entfernen' mit gruppe_id. Gruppen mit Schutz MANUELL hat das Team von Hand gepflegt: " +
        "nur aufführen, wenn der Eingang dazu wirklich Neues sagt (das Team entscheidet dann). Leer wenn keine Anforderungen erwaehnt.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["aktion", "gruppe_id", "titel", "beschreibung", "einzelpositionen"],
        properties: {
          aktion: { type: "string", enum: ["neu", "aendern", "unveraendert", "entfernen"] },
          gruppe_id: { type: ["string", "null"], description: "Bei 'aendern'/'unveraendert'/'entfernen' die gruppe_id aus BESTEHENDE POSITIONSGRUPPEN, bei 'neu' null." },
          titel: { type: "string", description: "Kurzer Titel, 1-3 Wörter (Deutsch mit Umlauten), z.B. 'Rahmen', 'Beschallung', 'Bühnenlicht'." },
          beschreibung: {
            type: "string",
            description:
              "Klartext mit allen Angaben zu diesem Wunsch im AKTUELLEN Stand (Deutsch mit echten Umlauten ä/ö/ü, nie ae/oe/ue; ohne Preise) — keine Aenderungshinweise wie 'korrigiert von …', " +
              "kein Material, das schon als Einzelposition steht. Leer nur, wenn der Titel schon alles sagt.",
          },
          einzelpositionen: {
            type: "array",
            description:
              "Material dieser Gruppe — NUR woertlich genanntes. Bei bestehenden Einzelpositionen (siehe Liste unter der Gruppe): " +
              "gleich = NICHT auffuehren; andere Menge/Details (z.B. 3 statt 2 Stative) = 'aendern' mit position_id; weggefallen = 'entfernen' mit position_id.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["aktion", "position_id", "menge", "bezeichnung", "kategorie", "details"],
              properties: {
                aktion: { type: "string", enum: ["neu", "aendern", "entfernen"] },
                position_id: { type: ["string", "null"], description: "Bei 'aendern'/'entfernen' die position_id aus der Liste, sonst null." },
                menge: { type: "integer", description: "Stueckzahl als ganze Zahl ab 1 (genannte Zahl; ohne Zahl 1 und in details 'Anzahl nicht genannt')." },
                bezeichnung: { type: "string", description: "Kurzbezeichnung, z.B. 'Stativ' oder 'Traverse 4 m' (ohne Preise)." },
                kategorie: kategorieFeld,
                details: { type: ["string", "null"], description: "Woertliche Zusatzinfos (z.B. 'ueber Lichtpult regelbar', Masse), ohne Preise, sonst null." },
              },
            },
          },
        },
      },
    },
  },
  };
  if (!nurGruppen) return voll;
  return {
    type: "object",
    additionalProperties: false,
    required: ["kundenaussagen", "positionsgruppen"],
    properties: { kundenaussagen: voll.properties.kundenaussagen, positionsgruppen: voll.properties.positionsgruppen },
  };
}

type PositionRow = {
  id: string;
  gruppe_id: string;
  status: string;
  menge: number;
  bezeichnung: string;
  details: string | null;
  quelle_item_id: string | null;
  created_via: string | null;
  manuell_geaendert_at: string | null;
  inhalt_geaendert_at: string | null;
  created_at: string;
};

type GruppeRow = {
  id: string;
  nummer: number;
  titel: string;
  text: string;
  quelle_item_id: string | null;
  created_via: string | null;
  manuell_geaendert_at: string | null;
  inhalt_geaendert_at: string | null;
  created_at: string;
};

/** KI-Menge → ganze Zahl ab 1 (Spalte menge ist integer); ungueltig = null. */
function kiMenge(v: unknown): number | null {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100000) : null;
}

/** Von der KI angelegt und nie von Hand angepasst — nur solche Eintraege
 *  darf die KI aendern oder loeschen («manuell erfasst/geaendert = tabu»). */
function kiEigen(r: { created_via: string | null; manuell_geaendert_at: string | null }): boolean {
  return r.created_via === "ki" && !r.manuell_geaendert_at;
}

/** Kontext-Block «BESTEHENDE POSITIONSGRUPPEN» fuer die KI: je Gruppe
 *  id, Nummer, Titel, Beschreibung, Schutz und darunter die Einzelpositionen. */
function kontextGruppen(gruppen: GruppeRow[], positionen: PositionRow[], mitRueckmeldung: Set<string>): string {
  if (!gruppen.length && !positionen.length) return "\nBisher keine Positionsgruppen erfasst.";
  const posZeile = (p: PositionRow) => {
    const schutz = !kiEigen(p) ? "MANUELL" : p.status === "bestaetigt" || mitRueckmeldung.has(p.id) ? "vom Lieferanten bestaetigt/kommentiert" : "KI";
    return `   - ${p.id} | ${p.menge}x | ${p.bezeichnung}${p.details ? ` (${p.details})` : ""} | ${schutz}`;
  };
  const bloecke = gruppen.map((g) => {
    const pos = positionen.filter((p) => p.gruppe_id === g.id);
    return [
      `${g.id} | Pos ${String(g.nummer).padStart(2, "0")} | ${g.titel} | ${g.text.replace(/\s+/g, " ").trim() || "-"} | Schutz: ${kiEigen(g) ? "KI" : "MANUELL"}`,
      pos.length ? `   Einzelpositionen (position_id | menge | bezeichnung | Schutz):\n${pos.map(posZeile).join("\n")}` : "   (keine Einzelpositionen)",
    ].join("\n");
  });
  return `\nBESTEHENDE POSITIONSGRUPPEN (gruppe_id | Pos | titel | beschreibung | Schutz):\n${bloecke.join("\n")}`;
}

/** Schreibfehler NIE verschlucken: wer hier wirft, markiert das Element als
 *  fehlerhaft (catch unten) — es wird nichts als «erfasst» gemeldet. */
function pruefe(error: { message: string } | null, was: string): void {
  if (error) throw new Error(`${was} fehlgeschlagen: ${error.message}`);
}

export async function verarbeiteEingangItem(opts: {
  admin: SupabaseClient;
  jobId: string;
  itemId: string;
  /** App-User der das Element abgelegt hat; null bei Mail-Eingang. */
  actorUserId: string | null;
  /** Nachlauf auf den Bestand (CLAUDE.md B3 «Neuerungen auch auf den
   *  Bestand»): NUR die Positionsgruppen neu pflegen — Zusammenfassung,
   *  Datums-/Termin-Vorschlaege und Status des Elements bleiben unberuehrt,
   *  ein Fehler setzt das Element NICHT auf «fehler» (der Aufrufer
   *  protokolliert ihn). */
  nurPositionsgruppen?: boolean;
}): Promise<{ datumVorschlag: DatumVorschlag | null; terminVorschlaege: number; verworfen: number }> {
  const { admin, jobId, itemId, actorUserId } = opts;
  const nurGruppen = opts.nurPositionsgruppen === true;

  const { data: job } = await admin
    .from("jobs")
    .select("id, status, title, job_number, start_date, end_date, description, ai_summary, customer:customers(name), location:locations(name)")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) throw new Error("Auftrag nicht gefunden");

  // Archiv = nur lesen (src/lib/archiv.ts): eine Mail an auftrag@in… zu einem
  // abgeschlossenen/stornierten Auftrag bleibt im Verlauf (lesbar), aber die
  // KI aendert den Auftrag nicht mehr (Zusammenfassung, Technik, Wuensche,
  // Vorschlaege). Element als erledigt markieren, damit es nicht haengt.
  if (auftragArchiviert((job as { status?: string | null }).status)) {
    if (nurGruppen) return { datumVorschlag: null, terminVorschlaege: 0, verworfen: 0 };
    const { error: archivErr } = await admin
      .from("job_inbox_items")
      .update({ ai_status: "verarbeitet", ai_error: null })
      .eq("id", itemId)
      .eq("job_id", jobId);
    pruefe(archivErr, "Status speichern");
    return { datumVorschlag: null, terminVorschlaege: 0, verworfen: 0 };
  }

  const { data: item } = await admin
    .from("job_inbox_items")
    .select("id, job_id, kind, content, file_path, file_name, mime_type, absender")
    .eq("id", itemId)
    .eq("job_id", jobId)
    .maybeSingle();
  if (!item) throw new Error("Eingang-Element nicht gefunden");

  // WICHTIG fuer die Wiederverarbeitung: Eintraege, die DIESES Element
  // frueher selbst per KI erzeugt hat, werden unten geloescht und neu
  // erzeugt — sie duerfen deshalb NICHT als "bestehend" im Kontext
  // stehen, sonst haelt die KI sie fuer Duplikate, schlaegt nichts vor,
  // und nach dem Loeschen sind sie weg (Vorfall INT-26319, 2026-10-02).
  const eigenesKi = (r: { quelle_item_id?: string | null; created_via?: string | null }) =>
    r.quelle_item_id === itemId && r.created_via === "ki";

  // Bestehende Positionsgruppen + Einzelpositionen (Migration 352) — damit
  // die KI 'aendern' statt Duplikat liefert. Schutzregeln:
  //  - Von Hand erfasst oder angepasst (created_via 'manuell' bzw.
  //    manuell_geaendert_at): die KI aendert/loescht NIE (Vorschlag nur in
  //    der Aktivitaet).
  //  - Einzelpositionen mit Rueckmeldung/Kommentar oder Bestaetigung werden
  //    NIE geloescht (ON DELETE CASCADE nahm sonst Philippes Rueckmeldungen
  //    still mit) — hoechstens angepasst; faellt eine weg, wird «entfernen»
  //    nur protokolliert. Eine Gruppe mit solchen Positionen ebenso.
  const [grpRes, posRes, revRes, komRes] = await Promise.all([
    admin
      .from("job_anforderungen")
      .select("id, nummer, titel, text, quelle_item_id, created_via, manuell_geaendert_at, inhalt_geaendert_at, created_at")
      .eq("job_id", jobId)
      .order("nummer", { ascending: true }),
    admin
      .from("job_technik_positionen")
      .select("id, gruppe_id, status, menge, bezeichnung, details, quelle_item_id, created_via, manuell_geaendert_at, inhalt_geaendert_at, created_at")
      .eq("job_id", jobId)
      .order("created_at", { ascending: true }),
    admin.from("job_technik_reviews").select("position_id").eq("job_id", jobId),
    admin.from("job_technik_kommentare").select("position_id").eq("job_id", jobId),
  ]);
  const ladeFehler = grpRes.error ?? posRes.error ?? revRes.error ?? komRes.error;
  if (ladeFehler) {
    // Ohne vollstaendiges Bild (Rueckmeldungen!) nicht weiterarbeiten —
    // sonst koennte eine geschuetzte Position geloescht werden.
    const msg = `Technik-Positionen laden fehlgeschlagen: ${ladeFehler.message}`;
    if (!nurGruppen) await admin.from("job_inbox_items").update({ ai_status: "fehler", ai_error: msg }).eq("id", itemId);
    throw new Error(msg);
  }
  const mitRueckmeldung = new Set(
    [...((revRes.data ?? []) as { position_id: string | null }[]), ...((komRes.data ?? []) as { position_id: string | null }[])]
      .map((r) => r.position_id)
      .filter((id): id is string => !!id),
  );
  /** Darf nie still geloescht werden (Lieferant hat sie gesehen/bewertet). */
  const geschuetzt = (p: PositionRow) => p.status === "bestaetigt" || mitRueckmeldung.has(p.id);
  /** KI darf die Einzelposition loeschen. */
  const posLoeschbar = (p: PositionRow) => kiEigen(p) && !geschuetzt(p);
  const positionenAlle = (posRes.data ?? []) as PositionRow[];
  const gruppenAlle = (grpRes.data ?? []) as GruppeRow[];
  // Wiederverarbeitung DIESES Elements: seine eigenen, unberuehrten
  // KI-Eintraege werden neu erzeugt statt verdoppelt — sie stehen deshalb
  // NICHT im Kontext. «Unberuehrt» = nie von Hand oder durch ein spaeteres
  // Element geaendert (inhalt_geaendert_at) und nicht geschuetzt; eine
  // Gruppe nur, wenn auch alle ihre Einzelpositionen ersetzbar sind.
  const posErsetzbar = (p: PositionRow) => eigenesKi(p) && posLoeschbar(p) && !p.inhalt_geaendert_at;
  const ersetzbarPos = positionenAlle.filter(posErsetzbar);
  const ersetzbarPosIds = new Set(ersetzbarPos.map((p) => p.id));
  const ersetzbarGrp = gruppenAlle.filter((g) =>
    eigenesKi(g) && kiEigen(g) && !g.inhalt_geaendert_at &&
    positionenAlle.every((p) => p.gruppe_id !== g.id || ersetzbarPosIds.has(p.id)));
  const ersetzbarGrpIds = new Set(ersetzbarGrp.map((g) => g.id));
  const gruppen = gruppenAlle.filter((g) => !ersetzbarGrpIds.has(g.id));
  const positionen = positionenAlle.filter((p) => !ersetzbarPosIds.has(p.id) && !ersetzbarGrpIds.has(p.gruppe_id));
  const grpLoeschbar = (g: GruppeRow) =>
    kiEigen(g) && positionen.every((p) => p.gruppe_id !== g.id || posLoeschbar(p));

  // Kategorien aus dem Katalog des festen Techniklieferanten (Zuordnung
  // statt pauschal «Sonstiges»).
  let kategorien: string[] = [];
  const fest = await festerTechnikLieferant(admin);
  if (fest.ok) {
    // Fehlt der Katalog (Fehler), geht es ohne Zuordnung weiter («Sonstiges»).
    const { data: kat } = await admin
      .from("lieferant_katalog_artikel")
      .select("hauptkategorie")
      .eq("lieferant_id", fest.lieferant.id)
      .eq("is_active", true);
    kategorien = Array.from(new Set(((kat ?? []) as { hauptkategorie: string | null }[])
      .map((k) => (k.hauptkategorie ?? "").trim())
      .filter((k) => k && k !== KATEGORIE_SONSTIGES)))
      .sort((a, b) => a.localeCompare(b, "de"));
  }

  // Bestehende Termine — damit die KI 'aendern' statt Duplikat vorschlaegt.
  const { data: termine } = await admin
    .from("job_appointments")
    .select("id, title, start_time, end_time")
    .eq("job_id", jobId)
    .order("start_time");

  // Chronik der bereits verarbeiteten Elemente — damit die KI einordnen
  // kann, ob das NEUE Element zeitlich VOR oder NACH dem bisherigen Wissen
  // liegt (Mails treffen in beliebiger Reihenfolge ein).
  const { data: chronikRows } = await admin
    .from("job_inbox_items")
    .select("kind, absender, content, file_name, created_at, inhalt_datum")
    .eq("job_id", jobId)
    .eq("ai_status", "verarbeitet")
    .neq("id", itemId)
    .order("created_at", { ascending: true })
    .limit(20);
  const chronik = (chronikRows ?? [])
    .map((c) => {
      const wann = (c.inhalt_datum ?? c.created_at ?? "").slice(0, 16).replace("T", " ");
      const was = c.kind === "text" ? (c.content ?? "").replace(/\s+/g, " ").slice(0, 90) : `Datei ${c.file_name}`;
      return `${wann} | ${c.absender ?? "App"} | ${was}`;
    })
    .join("\n");

  // ── KI-Kontext bauen ─────────────────────────────────────────
  const content: Anthropic.ContentBlockParam[] = [];
  const kontext = [
    `AUFTRAG ${job.job_number ?? ""}: ${job.title}`,
    relName(job.customer) ? `Kunde: ${relName(job.customer)}` : null,
    relName(job.location) ? `Ort: ${relName(job.location)}` : null,
    job.start_date ? `Zeitraum: ${job.start_date} bis ${job.end_date ?? "?"}` : null,
    job.description ? `Beschreibung: ${job.description}` : null,
    job.ai_summary ? `\nBISHERIGE ZUSAMMENFASSUNG:\n${job.ai_summary}` : null,
    chronik ? `\nCHRONIK bereits verarbeiteter Elemente (Sendedatum | von | Inhalt):\n${chronik}` : null,
    termine?.length
      ? `\nBESTEHENDE TERMINE (id | start | ende | titel):\n` +
        termine.map((t) => `${t.id} | ${t.start_time} | ${t.end_time ?? "-"} | ${t.title}`).join("\n")
      : "\nBisher keine Termine auf dem Auftrag.",
    kontextGruppen(gruppen, positionen, mitRueckmeldung),
  ].filter(Boolean).join("\n");
  content.push({ type: "text", text: kontext });

  // Absender EVENTLINE (eigene Antwort/Weiterleitung): der oberste Text ist
  // keine Kundenaussage — das sagt die App der KI ausdruecklich (Regel Leo).
  const herkunft = !item.absender
    ? " (intern vom EVENTLINE-Team erfasst)"
    : vonEventline(item.absender)
      ? ` (per Mail von ${item.absender} = EVENTLINE selbst: deren eigener Text ist KEINE Kundenaussage — Kundenaussagen nur aus zitierten Nachrichten des Kunden)`
      : ` (per Mail von ${item.absender})`;
  if (item.kind === "text" && item.content) {
    content.push({ type: "text", text: `\nNEUER EINGANG (Text${herkunft}):\n${item.content}` });
  } else if (item.kind === "datei" && item.file_path) {
    const { data: signed } = await admin.storage.from("documents").createSignedUrl(item.file_path, 600);
    const mime = item.mime_type ?? "";
    if (signed?.signedUrl && mime.startsWith("image/")) {
      content.push({ type: "text", text: `\nNEUER EINGANG (Bild "${item.file_name}"${herkunft}):` });
      content.push({ type: "image", source: { type: "url", url: signed.signedUrl } });
    } else if (signed?.signedUrl && mime === "application/pdf") {
      content.push({ type: "text", text: `\nNEUER EINGANG (PDF "${item.file_name}"${herkunft}):` });
      content.push({ type: "document", source: { type: "url", url: signed.signedUrl } });
    } else {
      content.push({ type: "text", text: `\nNEUER EINGANG: Datei "${item.file_name}" (${mime || "unbekannter Typ"}) — Inhalt nicht lesbar, nur zur Kenntnis.` });
    }
  }

  // Aufgabe (4) — gleicher Wortlaut im Vollauf und im Nachlauf.
  const aufgabeGruppen =
    "Pflege in positionsgruppen die Wünsche des KUNDEN (auch ungebucht): zuerst in kundenaussagen die Aussagen des Kunden herauslösen, " +
    "dann je Wunsch EINE nummerierte Gruppe mit Kurztitel und Klartext-Beschreibung, darunter Einzelpositionen NUR für woertlich genanntes Material " +
    "(nie erfinden — ohne Nennung waehlt der Techniklieferant die Loesung). Folge-Eingänge ÄNDERN bestehende Gruppen (vollständige neue Beschreibung) " +
    "statt neue anzulegen; die Gruppen beschreiben IMMER den aktuellen Stand (Zeitlogik gilt auch hier). " +
    REGEL_POSITIONSGRUPPEN + " " +
    "IDs exakt aus der Liste übernehmen. Im Zweifel lieber weniger ändern.";
  const rolle =
    "Du bist das Gedächtnis eines Veranstaltungstechnik-Auftrags der Firma EVENTLINE (Basel). " +
    "Du erhältst den Auftragskontext, die bisherige Zusammenfassung und EIN neues Eingang-Element " +
    "(diktierte Notiz, weitergeleitete Kunden-Mail, Screenshot, Foto oder PDF). ";

  try {
    const ergebnis = await structuredCall<Ergebnis>({
      system: nurGruppen
        ? rolle +
          "NACHLAUF: Das Element ist schon verarbeitet, die Zusammenfassung ist aktuell und dient nur der Einordnung. " +
          "Deine EINZIGE Aufgabe: " + aufgabeGruppen
        : rolle +
          "Aufgaben: (1) Zusammenfassung aktualisieren — strukturiert nach Schema-Vorgabe (Abschnitte in GROSSBUCHSTABEN + '- '-Stichpunkte), sachlich, nichts erfinden. " +
          "(2) Schlage in datum_aenderung ein neues Event-Datum vor, wenn (a) der Eingang eine Verschiebung DIESES Auftrags nennt, ODER " +
          "(b) das bisherige Event-Datum wegfällt (Absage, Eigenregie, keine Unterstützung nötig) UND ein konkreter nächster Termin genannt wird, " +
          "auf den der Auftrag sinnvoll weiterlaufen könnte — der grund muss die Lage ehrlich beschreiben (z.B. 'bisheriges Datum entfällt; nächstes Konzert am …'). " +
          "Das Team wird IMMER GEFRAGT, bevor umdatiert wird — im Zweifel also vorschlagen. Nur bei beiläufiger Terminerwähnung ohne Bezug: null. " +
          "(3) Nennt das Element konkrete Auftrags-Termine (Aufbau, Abbau, Probe, Lieferung, Besprechung), schlage sie in termin_vorschlaege vor — " +
          "NIE selbst anlegen, das Team entscheidet per Nachfrage. Gegen BESTEHENDE TERMINE abgleichen (gleich = nichts, andere Zeit = 'aendern'). " +
          "(4) " + aufgabeGruppen,
      content,
      toolName: "ergebnis_speichern",
      toolDescription: nurGruppen
        ? "Speichert die Positionsgruppen (mit Einzelpositionen) für den Auftrag."
        : "Speichert Zusammenfassung, Vorschläge und Positionsgruppen (mit Einzelpositionen) für den Auftrag.",
      schema: ergebnisSchema(kategorien, nurGruppen),
      // Zusammenfassung + Gruppen mit Einzelpositionen + Termine koennen das
      // 4096er-Default sprengen — das Modell wuerde dann still die
      // groesste Liste opfern (Lektion aus dem Raum-Modell).
      maxTokens: 12000,
    });

    if (!nurGruppen) {
      if (typeof ergebnis.zusammenfassung !== "string") throw new Error("KI-Antwort ohne Zusammenfassung");
      const { error: sumErr } = await admin.from("jobs").update({ ai_summary: ergebnis.zusammenfassung }).eq("id", jobId);
      pruefe(sumErr, "Zusammenfassung speichern");
    }

    // Neues Event-Datum wird NIE direkt gesetzt — nur als persistenter
    // Vorschlag am Auftrag (Banner auf der Uebersicht, bis Entscheidung).
    // Im Nachlauf gibt es keine Vorschlaege (Feld fehlt im Schema).
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const v = nurGruppen ? null : ergebnis.datum_aenderung;
    const datumVorschlag: DatumVorschlag | null = v && DATE_RE.test(v.start_datum)
      ? {
          start_datum: v.start_datum,
          end_datum: v.end_datum && DATE_RE.test(v.end_datum) ? v.end_datum : v.start_datum,
          grund: v.grund,
        }
      : null;
    if (datumVorschlag) {
      const { error } = await admin
        .from("jobs")
        .update({ ai_datum_vorschlag: { ...datumVorschlag, item_id: itemId, created_at: new Date().toISOString() } })
        .eq("id", jobId);
      pruefe(error, "Datums-Vorschlag speichern");
    }

    // Positionsgruppen + Einzelpositionen anwenden (Migration 352).
    // Idempotente Wiederverarbeitung: die unberuehrten Eintraege DIESES
    // Elements ersetzen statt ergaenzen. Von Hand gepflegte Eintraege und
    // geschuetzte Einzelpositionen (Rueckmeldung, Kommentar, Bestaetigung)
    // aendert/loescht die KI nie — sie protokolliert dann nur einen Vorschlag
    // in der Aktivitaet, das Team entscheidet.
    const ki = { id: actorUserId, name: "Eingang-KI" };
    const gruppeById = new Map(gruppen.map((g) => [g.id, g]));
    const positionById = new Map(positionen.map((p) => [p.id, p]));
    const katGueltig = new Set(kategorien);
    const vorschlaege = ergebnis.positionsgruppen ?? [];
    /** Wegen Preis-/Offert-Bezug nicht gespeicherte KI-Aenderungen. */
    let verworfen = 0;
    if (ersetzbarPos.length) {
      const { error } = await admin
        .from("job_technik_positionen")
        .delete()
        .in("id", ersetzbarPos.map((p) => p.id))
        .eq("job_id", jobId);
      pruefe(error, "Alte KI-Positionen ersetzen");
    }
    if (ersetzbarGrp.length) {
      const { error } = await admin
        .from("job_anforderungen")
        .delete()
        .in("id", ersetzbarGrp.map((g) => g.id))
        .eq("job_id", jobId);
      pruefe(error, "Alte KI-Positionsgruppen ersetzen");
    }

    const titelVon = (v: GruppenVorschlag) => (v.titel ?? "").trim().slice(0, TECHNIK_TITEL_MAX);
    const textVon = (v: GruppenVorschlag) => (v.beschreibung ?? "").trim().slice(0, TECHNIK_TEXT_MAX);
    const posDaten = (e: EinzelpositionVorschlag) => ({
      menge: kiMenge(e.menge),
      bezeichnung: (e.bezeichnung ?? "").trim().slice(0, TECHNIK_BEZEICHNUNG_MAX),
      // Mit Katalog nur dessen Kategorien; ohne Katalog die Kurz-Kategorie der KI.
      kategorie: (kategorien.length
        ? (katGueltig.has((e.kategorie ?? "").trim()) ? e.kategorie.trim() : "")
        : (e.kategorie ?? "").trim().slice(0, TECHNIK_BEZEICHNUNG_MAX)) || KATEGORIE_SONSTIGES,
      details: (e.details ?? "").trim().slice(0, TECHNIK_TEXT_MAX) || null,
    });

    const neueGruppen: string[] = [];
    const neuePositionen: string[] = [];
    for (const v of vorschlaege) {
      // 1. Gruppe aufloesen bzw. anlegen
      let ziel: { id: string; nummer: number; titel: string; text: string } | null = null;
      if (v.aktion === "neu") {
        const titel = titelVon(v);
        if (!titel) continue;
        // Harte Sperre: Preis-/Offert-Bezug → Gruppe samt Material verwerfen.
        if (preisOderOffertBezug(titel, textVon(v))) { verworfen++; continue; }
        const { data, error } = await admin
          .from("job_anforderungen")
          .insert({
            job_id: jobId,
            titel,
            text: textVon(v),
            created_via: "ki",
            quelle_item_id: itemId,
            created_by: actorUserId,
          })
          .select("id, nummer, titel, text")
          .single();
        pruefe(error, "Positionsgruppe speichern");
        ziel = data as { id: string; nummer: number; titel: string; text: string };
        neueGruppen.push(gruppeLabel(ziel));
      } else {
        const alt = v.gruppe_id ? gruppeById.get(v.gruppe_id) : undefined;
        if (!alt) continue; // erfundene/unbekannte ID: nichts anfassen
        ziel = alt;
        if (v.aktion === "aendern") {
          const titel = titelVon(v) || alt.titel;
          const text = textVon(v);
          const gleich = titel === alt.titel && text === alt.text.trim();
          // Preis-/Offert-Bezug: weder speichern noch (mit Text) protokollieren.
          if (!gleich && preisOderOffertBezug(titel, text)) {
            verworfen++;
          } else if (!gleich) {
            if (kiEigen(alt)) {
              const { error } = await admin
                .from("job_anforderungen")
                .update({ titel, text })
                .eq("id", alt.id)
                .eq("job_id", jobId);
              pruefe(error, "Positionsgruppe anpassen");
              await logTechnik(admin, jobId, ki, "ki_gruppe_geaendert",
                `Aus dem Eingang angepasst: ${gruppeLabel({ nummer: alt.nummer, titel })}${text ? ` — «${text.slice(0, 120)}»` : ""}`,
                { gruppe_id: alt.id });
              ziel = { ...alt, titel, text };
            } else {
              await logTechnik(admin, jobId, ki, "ki_gruppe_aendern_vorgeschlagen",
                `Eingang nennt Neues zu ${gruppeLabel(alt)} (von Hand gepflegt, nicht geändert) — bitte prüfen: «${(text || titel).slice(0, 200)}»`,
                { gruppe_id: alt.id });
            }
          }
        } else if (v.aktion === "entfernen") {
          if (grpLoeschbar(alt)) {
            const weg = positionen.filter((p) => p.gruppe_id === alt.id);
            const { error } = await admin.from("job_anforderungen").delete().eq("id", alt.id).eq("job_id", jobId);
            pruefe(error, "Positionsgruppe entfernen");
            // Einzelpositionen gingen per CASCADE mit — einzeln protokollieren
            // («nie gesehen = nie entfernt», lib/technik entfernungGesehen).
            for (const p of weg) {
              positionById.delete(p.id);
              await logTechnik(admin, jobId, ki, "ki_entfernt", `Aus dem Eingang entfernt: ${p.menge}× ${p.bezeichnung}`,
                { position_id: p.id, position_angelegt_at: p.created_at });
            }
            gruppeById.delete(alt.id);
            await logTechnik(admin, jobId, ki, "ki_gruppe_entfernt", `Aus dem Eingang entfernt: ${gruppeLabel(alt)}`,
              { gruppe_id: alt.id, angelegt_at: alt.created_at });
          } else {
            await logTechnik(admin, jobId, ki, "ki_entfernen_vorgeschlagen",
              `Eingang nennt ${gruppeLabel(alt)} nicht mehr — Position bleibt stehen (von Hand gepflegt oder Rückmeldung/Bestätigung vorhanden), bitte prüfen und bei Bedarf von Hand entfernen`,
              { gruppe_id: alt.id });
          }
          continue;
        }
      }

      // 2. Einzelpositionen dieser Gruppe
      const neu = (v.einzelpositionen ?? [])
        .filter((e) => e.aktion === "neu")
        .map(posDaten)
        .filter((e): e is ReturnType<typeof posDaten> & { menge: number } => !!e.bezeichnung && e.menge !== null)
        .filter((e) => (preisOderOffertBezug(e.bezeichnung, e.details) ? (verworfen++, false) : true));
      if (neu.length && ziel) {
        const zielId = ziel.id;
        const { error } = await admin.from("job_technik_positionen").insert(
          neu.map((e) => ({
            job_id: jobId,
            gruppe_id: zielId,
            menge: e.menge,
            bezeichnung: e.bezeichnung,
            kategorie: e.kategorie,
            details: e.details,
            quelle: "kunde",
            created_via: "ki",
            quelle_item_id: itemId,
            created_by: actorUserId,
          })),
        );
        pruefe(error, "Einzelpositionen aus dem Eingang speichern");
        neuePositionen.push(...neu.map((e) => `${e.menge}× ${e.bezeichnung} (${gruppeNummer(ziel!.nummer)})`));
      }
      for (const e of v.einzelpositionen ?? []) {
        if (e.aktion === "neu") continue;
        const alt = e.position_id ? positionById.get(e.position_id) : undefined;
        if (!alt) continue;
        if (e.aktion === "aendern") {
          const d = posDaten(e);
          if (!d.menge || !d.bezeichnung) continue;
          const gleich = d.menge === alt.menge && d.bezeichnung === alt.bezeichnung && d.details === (alt.details ?? null);
          // Nichts wirklich geaendert: Bestaetigung des Lieferanten NICHT antasten.
          if (gleich) continue;
          if (preisOderOffertBezug(d.bezeichnung, d.details)) { verworfen++; continue; }
          if (!kiEigen(alt)) {
            await logTechnik(admin, jobId, ki, "ki_aendern_vorgeschlagen",
              `Eingang nennt «${d.menge}× ${d.bezeichnung}» statt «${alt.menge}× ${alt.bezeichnung}» (von Hand gepflegt, nicht geändert) — bitte prüfen`,
              { position_id: alt.id });
            continue;
          }
          // Aenderung durch neue Kunden-Info -> eine bestehende Bestaetigung
          // gilt nicht mehr, Position faellt auf 'geplant' zurueck. In place —
          // Rueckmeldungen und Kommentare bleiben an der Position.
          const { error } = await admin
            .from("job_technik_positionen")
            .update({
              menge: d.menge,
              bezeichnung: d.bezeichnung,
              details: d.details,
              status: "geplant",
              bestaetigt_by: null,
              bestaetigt_at: null,
            })
            .eq("id", alt.id)
            .eq("job_id", jobId);
          pruefe(error, "Einzelposition anpassen");
          await logTechnik(admin, jobId, ki, "ki_geaendert",
            `Aus dem Eingang angepasst: ${alt.menge}× ${alt.bezeichnung} → ${d.menge}× ${d.bezeichnung}`, { position_id: alt.id });
        } else if (e.aktion === "entfernen") {
          if (!posLoeschbar(alt)) {
            // Nicht still loeschen — Rueckmeldungen/Kommentare/Bestaetigung
            // des Lieferanten gingen sonst mit (ON DELETE CASCADE), und von
            // Hand Gepflegtes entscheidet das Team.
            await logTechnik(admin, jobId, ki, "ki_entfernen_vorgeschlagen",
              `Eingang nennt «${alt.menge}× ${alt.bezeichnung}» nicht mehr — Einzelposition bleibt stehen (von Hand gepflegt oder Rückmeldung/Bestätigung vorhanden), bitte prüfen und bei Bedarf von Hand entfernen`,
              { position_id: alt.id });
            continue;
          }
          const { error } = await admin.from("job_technik_positionen").delete().eq("id", alt.id).eq("job_id", jobId);
          pruefe(error, "Einzelposition entfernen");
          positionById.delete(alt.id);
          // position_angelegt_at: «nie gesehen = nie entfernt» (lib/technik entfernungGesehen).
          await logTechnik(admin, jobId, ki, "ki_entfernt", `Aus dem Eingang entfernt: ${alt.menge}× ${alt.bezeichnung}`,
            { position_id: alt.id, position_angelegt_at: alt.created_at });
        }
      }
    }
    if (neueGruppen.length) {
      await logTechnik(admin, jobId, ki, "ki_gruppen", `Aus dem Eingang erfasst: ${neueGruppen.join(", ")}`);
    }
    if (neuePositionen.length) {
      await logTechnik(admin, jobId, ki, "ki_positionen", `Einzelpositionen aus dem Eingang erfasst: ${neuePositionen.join(", ")}`);
    }
    if (verworfen) {
      // Nur ins Server-Log (ohne Text) — die Technik-Aktivitaet sieht auch der Lieferant.
      logError("eingang.preisbezug_verworfen", new Error(`${verworfen} KI-Änderung(en) mit Preis-/Offert-Bezug verworfen`), { jobId, itemId });
    }
    if (nurGruppen) return { datumVorschlag: null, terminVorschlaege: 0, verworfen };

    // Termin-Vorschlaege: NIE direkt anlegen — persistenter Vorschlag am
    // Auftrag (Banner in der Uebersicht), das Team entscheidet.
    const terminIds = new Set((termine ?? []).map((t) => t.id));
    const terminVorschlaege = (ergebnis.termin_vorschlaege ?? []).filter((t) => {
      if (!t.titel || !t.start || Number.isNaN(Date.parse(t.start))) return false;
      if (t.ende && Number.isNaN(Date.parse(t.ende))) return false;
      if (t.aktion === "aendern" && (!t.termin_id || !terminIds.has(t.termin_id))) return false;
      return true;
    });
    if (terminVorschlaege.length) {
      const { error } = await admin
        .from("jobs")
        .update({ ai_termin_vorschlaege: { vorschlaege: terminVorschlaege, item_id: itemId, created_at: new Date().toISOString() } })
        .eq("id", jobId);
      pruefe(error, "Termin-Vorschläge speichern");
    }

    // inhalt_datum nur uebernehmen, wenn es ein valides Datum ist.
    const inhaltDatum =
      ergebnis.inhalt_datum && !Number.isNaN(Date.parse(ergebnis.inhalt_datum)) ? ergebnis.inhalt_datum : null;
    const { error: statusErr } = await admin
      .from("job_inbox_items")
      .update({ ai_status: "verarbeitet", ai_error: null, inhalt_datum: inhaltDatum })
      .eq("id", itemId);
    pruefe(statusErr, "Status speichern");

    return { datumVorschlag, terminVorschlaege: terminVorschlaege.length, verworfen };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "KI-Verarbeitung fehlgeschlagen";
    // Nachlauf: Element bleibt «verarbeitet» (sonst wuerde die Selbstheilung
    // im Eingang-Tab es VOLL neu verarbeiten) — der Aufrufer protokolliert.
    if (!nurGruppen) await admin.from("job_inbox_items").update({ ai_status: "fehler", ai_error: msg }).eq("id", itemId);
    throw new Error(msg);
  }
}
