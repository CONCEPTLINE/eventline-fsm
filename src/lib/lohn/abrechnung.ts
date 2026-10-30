// Lohnabrechnung rechnen, als Momentaufnahme speichern und daraus die PDF
// drucken (Phase 2 — ein Rechenkern für alle Wege, src/lib/lohn/kern).
//
// Ablauf:
//   1. Eingaben laden (daten.ts) → Rechenkern → Ergebnis (Mengen, Positionen,
//      Brutto, Abzüge, Netto, NBU 7/87, Hinweise). Fehlende Daten = Fehler.
//   2. Momentaufnahme {Eingaben, Druckangaben, Ergebnis} + Prüfsumme.
//   3. PDF aus der Momentaufnahme drucken (momentaufnahme.ts).
//   4. PDF + Zeile + Momentaufnahme in EINER Transaktion speichern (fassung.ts,
//      RPC lohn_momentaufnahme_speichern). Nie überschreiben.
//
// Fassungen:
//   - regulär: erste Fassung eines Monats, Auszahlung = Netto.
//   - Korrektur: ersetzt genau einen Monat; ausbezahlt wird die Differenz zur
//     Vorfassung an einem eigenen Auszahlungsdatum; Begründung Pflicht.
//     Gerechnet wird der Monat mit den Sätzen seiner ursprünglichen
//     Auszahlung (Auszahlungsprinzip), die Differenz zählt am neuen Tag.
//   - Altbestand: alte PDFs ohne Momentaufnahme werden erst übernommen
//     (scripts/lohn-altbestand.mjs) — vorher ist keine neue Fassung möglich.
// Nur gesperrte Monate (ab dem 5. des Folgemonats).
//
// Phase 4: Vor dem Rechnen die Stempel prüfen — offene oder ungeprüfte sehr
// lange Stempel im Monat blockieren (LohnFehler 409 «stempel_pruefen», Lauf
// und Knopf). Ausbezahlt wird Netto + Spesen (Zusatzposten); die Korrektur
// zahlt die Differenz zum Auszahlungsbetrag der Vorfassung. Nach dem
// Speichern wird die Person benachrichtigt (zustellung.ts, wirft nie).
// Lohnmonate nach lohn_einstellungen.lauf_bis (ab Dezember 2026 Trust
// flow/Bexio) → LohnFehler 400 «lauf_bis», weder regulär noch Korrektur.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompanySettings } from "@/lib/company-settings";
import { todayLocalIso } from "@/lib/swiss-time";
import { KERN_VERSION, type MonatsEingabe, type MonatsErgebnis } from "./kern";
import { monatKey, rechneMonate, regelAuszahlungsdatum, type LohnPerson } from "./daten";
import {
  LohnFehler,
  ladeArchivierteFassung,
  ladeGueltigeFassung,
  speichereMomentaufnahme,
  type MomentaufnahmeErgebnis,
} from "./fassung";
import {
  auszahlungBetrag,
  druckeLohnabrechnung,
  pruefsummeMomentaufnahme,
  sha256Hex,
  zeilenWerte,
  type MomentaufnahmeEingaben,
  type Vorfassung,
} from "./momentaufnahme";
import { monatLabel } from "./monate";
import { ladeLohnEinstellungen, meldungNachLaufBis, nachLaufBis } from "./zugriff";
import { ladeStempelProbleme, stempelProblemText } from "./stempel-pruefung";
import { meldeNeueAbrechnung } from "./zustellung";
import { logError } from "@/lib/log";

/** Firmenangaben für den PDF-Kopf — Ladefehler bricht ab. */
export async function ladeFirmaStreng(admin: SupabaseClient): Promise<CompanySettings> {
  const { data, error } = await admin
    .from("company_settings")
    .select("name, street, zip, city, country, phone, email, website, uid_number, iban")
    .eq("id", "default")
    .maybeSingle();
  if (error) throw new LohnFehler(`Firmenangaben konnten nicht geladen werden: ${error.message}`);
  const t = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    name: t(data?.name) || "EVENTLINE GmbH",
    street: t(data?.street),
    zip: t(data?.zip),
    city: t(data?.city),
    country: t(data?.country) || "Schweiz",
    phone: t(data?.phone),
    email: t(data?.email),
    website: t(data?.website),
    uid_number: t(data?.uid_number),
    iban: t(data?.iban),
  };
}

/** Ist der Monat gesperrt? Gefragt wird die DB (dieselbe Uhr und Regel wie
 *  die Stempel-Sperre, public.is_time_entry_locked). */
export async function istMonatGesperrtDb(admin: SupabaseClient, year: number, month: number): Promise<boolean> {
  const mitte = `${year}-${String(month).padStart(2, "0")}-15T12:00:00Z`;
  const { data, error } = await admin.rpc("is_time_entry_locked", { p_clock_in: mitte });
  if (error) throw new LohnFehler(`Monatssperre konnte nicht geprüft werden: ${error.message}`);
  return data === true;
}

/** Nächster regulärer Auszahlungstag ab heute (Korrekturen laufen mit dem nächsten Lohn). */
export function naechsteAuszahlung(heute: string, arbeitstag: number): string {
  const [j, m] = heute.split("-").map(Number);
  const vormonat = m === 1 ? { j: j - 1, m: 12 } : { j, m: m - 1 };
  const kandidat = regelAuszahlungsdatum(vormonat.j, vormonat.m, arbeitstag);
  return kandidat >= heute ? kandidat : regelAuszahlungsdatum(j, m, arbeitstag);
}

export interface GerechneterMonat {
  person: LohnPerson;
  eingabe: MonatsEingabe;
  ergebnis: MonatsErgebnis;
}

/** Einen Monat einer Person rechnen (ohne zu speichern). Kern-Fehler → LohnFehler 400. */
export async function rechneLohnabrechnung(
  admin: SupabaseClient,
  profileId: string,
  year: number,
  month: number,
  opts: { auszahlungsdatum?: string } = {},
): Promise<GerechneterMonat> {
  const { personen, ergebnisse } = await rechneMonate(admin, [profileId], [{ jahr: year, monat: month }], {
    auszahlungsdatum: opts.auszahlungsdatum ? () => opts.auszahlungsdatum! : undefined,
  });
  const person = personen.get(profileId);
  const r = ergebnisse.get(profileId)?.get(monatKey(year, month));
  if (!person || !r) throw new LohnFehler("Mitarbeiter nicht gefunden", 404);
  if (!r.ok) throw new LohnFehler(`${monatLabel({ jahr: year, monat: month })}: ${r.fehler}`, 400, r.code);
  return { person, eingabe: r.eingabe, ergebnis: r.ergebnis };
}

interface MomentaufnahmeZeile {
  id: string;
  fassung: number;
  brutto: number | string;
  total_abzuege: number | string;
  netto: number | string;
  auszahlungsbetrag: number | string | null;
  art: string;
  auszahlungsdatum: string;
  erstellt_at: string | null;
  orig: string | null;
}

async function ladeLetzteMomentaufnahme(admin: SupabaseClient, profileId: string, year: number, month: number): Promise<MomentaufnahmeZeile | null> {
  const { data, error } = await admin
    .from("lohn_momentaufnahmen")
    .select("id, fassung, brutto, total_abzuege, netto, auszahlungsbetrag, art, auszahlungsdatum, erstellt_at, orig:ergebnis->>auszahlungsdatum")
    .eq("profile_id", profileId)
    .eq("jahr", year)
    .eq("monat", month)
    .order("fassung", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new LohnFehler(`Momentaufnahmen konnten nicht geladen werden: ${error.message}`);
  return (data as MomentaufnahmeZeile | null) ?? null;
}

export interface AbrechnungErgebnis extends MomentaufnahmeErgebnis {
  stunden: number;
  brutto: number;
  netto: number;
  art: "regulaer" | "korrektur";
  fassung: number | null;
  auszahlung: number | null;
  auszahlungsdatum: string;
}

/** Abrechnung rechnen, als Momentaufnahme speichern und PDF drucken (Route,
 *  Lauf, Korrektur-Vorschläge).
 *  - nur gesperrte Monate (sonst LohnFehler 400, code «nicht_gesperrt»)
 *  - gibt es schon eine gültige Fassung und ist `neueFassung` nicht gesetzt:
 *    LohnFehler 409, code «neue_fassung» (UI fragt nach, Lauf überspringt)
 *  - neue Fassung = Korrekturfassung: Begründung Pflicht, Auszahlung der
 *    Differenz am nächsten Auszahlungstag (oder `auszahlungsdatum`). */
export async function erzeugeUndSpeichereLohnabrechnung(
  admin: SupabaseClient,
  args: {
    profileId: string;
    year: number;
    month: number;
    actorId: string | null;
    actorName: string | null;
    neueFassung: boolean;
    begruendung?: string | null;
    auszahlungsdatum?: string | null;
  },
): Promise<AbrechnungErgebnis> {
  const { profileId, year, month } = args;
  const label = monatLabel({ jahr: year, monat: month });
  // Nach dem letzten ERP-Lohnmonat (lauf_bis, Entscheid 30.10.2026: ab
  // Dezember 2026 Trust flow/Bexio) weder Abrechnung noch Korrektur — vor
  // allem anderen, mit demselben Klartext wie die Datenbank.
  const einst = await ladeLohnEinstellungen(admin);
  if (einst.laufBis && nachLaufBis(einst.laufBis, { jahr: year, monat: month })) {
    throw new LohnFehler(meldungNachLaufBis(einst.laufBis), 400, "lauf_bis");
  }
  if (!(await istMonatGesperrtDb(admin, year, month))) {
    throw new LohnFehler(
      `${label} ist noch nicht abgeschlossen — Lohnabrechnungen entstehen erst ab dem 5. des Folgemonats (Monat gesperrt).`,
      400,
      "nicht_gesperrt",
    );
  }
  const gueltig = await ladeGueltigeFassung(admin, profileId, "lohnabrechnung", year, month);
  if (!args.neueFassung) {
    if (gueltig) {
      throw new LohnFehler(
        `Für ${label} gibt es schon eine Lohnabrechnung (Fassung ${gueltig.version}). Eine Korrekturfassung ersetzt sie (Begründung, Auszahlung der Differenz); die bisherige bleibt erhalten.`,
        409,
        "neue_fassung",
      );
    }
    const imKorb = await ladeArchivierteFassung(admin, profileId, "lohnabrechnung", year, month);
    if (imKorb) {
      throw new LohnFehler(
        `Die Lohnabrechnung ${label} (Fassung ${imKorb.version}) liegt im Papierkorb. Wiederherstellen — oder eine Korrekturfassung erzeugen (die im Papierkorb bleibt im Protokoll erhalten).`,
        409,
        "neue_fassung",
      );
    }
  }

  const vorher = await ladeLetzteMomentaufnahme(admin, profileId, year, month);
  if (!vorher && gueltig) {
    throw new LohnFehler(
      `${label}: Die bestehende Lohnabrechnung hat noch keine Momentaufnahme — zuerst den Altbestand übernehmen (scripts/lohn-altbestand.mjs).`,
      409,
      "altbestand",
    );
  }
  const art: "regulaer" | "korrektur" = vorher ? "korrektur" : "regulaer";
  const begruendung = (args.begruendung ?? "").trim() || null;
  if (art === "korrektur" && (!begruendung || begruendung.length < 10)) {
    throw new LohnFehler("Korrekturfassung: Begründung fehlt (mindestens 10 Zeichen).", 400, "begruendung_fehlt");
  }

  // Stempel prüfen (Phase 4): ein offener Stempel zählt nicht, ein sehr
  // langer ist meist ein vergessenes Ausstempeln — erst klären, dann rechnen.
  const probleme = (await ladeStempelProbleme(admin, [profileId], year, month)).get(profileId) ?? [];
  if (probleme.length > 0) {
    throw new LohnFehler(`${label}: ${stempelProblemText(probleme)}`, 409, "stempel_pruefen");
  }

  const regelDatum = regelAuszahlungsdatum(year, month, einst.auszahlungArbeitstag);
  // Sätze nach der ursprünglichen Auszahlung des Monats; die Korrektur zahlt
  // die Differenz an ihrem eigenen Tag.
  const satzDatum = vorher?.orig ?? (art === "regulaer" ? (args.auszahlungsdatum ?? regelDatum) : regelDatum);
  const auszahlungsdatum = art === "korrektur"
    ? (args.auszahlungsdatum ?? naechsteAuszahlung(todayLocalIso(), einst.auszahlungArbeitstag))
    : satzDatum;

  const { person, eingabe, ergebnis } = await rechneLohnabrechnung(admin, profileId, year, month, { auszahlungsdatum: satzDatum });
  const vorfassung: Vorfassung | null = vorher
    ? {
        fassung: vorher.fassung,
        netto: Number(vorher.netto),
        auszahlungsdatum: vorher.auszahlungsdatum,
        art: vorher.art,
        brutto: Number(vorher.brutto),
        totalAbzuege: Number(vorher.total_abzuege),
        auszahlungsbetrag: vorher.auszahlungsbetrag == null ? null : Number(vorher.auszahlungsbetrag),
        erstelltAm: vorher.erstellt_at,
      }
    : null;
  const auszahlung = auszahlungBetrag(ergebnis, vorfassung);
  const firma = await ladeFirmaStreng(admin);
  const jetzt = new Date();
  const eingaben: MomentaufnahmeEingaben = {
    kern: eingabe,
    // Keine Mail der Person in der Momentaufnahme (steht nicht auf der Abrechnung).
    druck: { firma, person: { name: person.name, email: null }, erstelltAm: jetzt.toISOString() },
  };
  const pruefsumme = pruefsummeMomentaufnahme({ art, auszahlungsdatum, auszahlung, vorfassung, eingaben, ergebnis });
  const fassungNr = (vorher?.fassung ?? 0) + 1;
  const pdf = druckeLohnabrechnung({ art, fassung: fassungNr, auszahlungsdatum, auszahlung, begruendung, vorfassung, eingaben, ergebnis, pruefsumme });

  const f = await speichereMomentaufnahme(admin, {
    profileId,
    jahr: year,
    monat: month,
    art,
    pdf,
    pdfSha256: sha256Hex(pdf),
    actorId: args.actorId,
    actorName: args.actorName,
    nurWennKeineGueltige: !args.neueFassung,
    auszahlungsdatum,
    kernVersion: KERN_VERSION,
    eingaben,
    ergebnis,
    pruefsumme,
    werte: zeilenWerte(ergebnis),
    begruendung,
    erwarteteAuszahlung: auszahlung,
    jetzt,
  });
  if (f.modus === "vorhanden") {
    throw new LohnFehler(`Für ${label} wurde gerade eine Lohnabrechnung gespeichert — nichts überschrieben.`, 409, "neue_fassung");
  }
  // Person benachrichtigen (Zustellung) — wirft laut Vertrag nie; die
  // Abrechnung ist gespeichert, ein Fehler hier darf sie nicht melden.
  try {
    await meldeNeueAbrechnung(admin, { profileId, jahr: year, monat: month, wageDocumentId: f.id, art });
  } catch (e) {
    logError("lohn.abrechnung.zustellung", e, { profileId, year, month });
  }
  return {
    ...f,
    stunden: ergebnis.mengen.minuten / 60,
    brutto: ergebnis.brutto,
    netto: ergebnis.netto,
    art,
    fassung: f.fassung,
    auszahlung: f.auszahlung,
    auszahlungsdatum,
  };
}
