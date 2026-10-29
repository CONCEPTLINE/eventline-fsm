// Änderungen an Lohndaten (Lohnzeilen, Firmensätze, Anstellungen) — Phase 2.
//
// Jede Änderung läuft über die DB-Funktion lohn_aenderung_direkt (alles oder
// nichts, Protokoll alt/neu/wer per Trigger, Migration 364). Betrifft sie
// abgerechnete (gesperrte) Monate, bricht der Sperr-Trigger ab — dann stellt
// der Server einen ANTRAG mit Begründung, den eine zweite Person (anderer
// Admin oder die Vertretung) auf einem vertrauten Gerät innert 24 h bestätigt
// (gleiches Muster wie rechte_antraege). Nach der Bestätigung rechnet der
// Kern die betroffenen Monate desselben Jahres neu und schlägt je
// abweichendem Monat eine Korrekturfassung vor (lohn_korrektur_vorschlaege).

import type { SupabaseClient } from "@supabase/supabase-js";
import { notifySystem } from "@/lib/notification-service";
import { recipientsWithPermission } from "@/lib/notification-recipients";
import { logError } from "@/lib/log";
import { ladeAlleSeiten, monatKey, rechneMonate } from "./daten";
import { LOHN_RECHT } from "./zugriff";
import { rechteAntraegeHref } from "@/lib/antraege-links";

export type LohnTabelle = "employee_compensation" | "payroll_defaults" | "lohn_anstellungen";

export interface Operation {
  op: "insert" | "update" | "delete";
  tabelle: LohnTabelle;
  id?: string;
  werte?: Record<string, unknown>;
}

export type Bereich = "lohnzeile" | "firmensaetze" | "anstellung";

export type AenderungsErgebnis =
  | { modus: "direkt"; ids: (string | null)[] }
  | { modus: "antrag"; antragId: string; gueltigBis: string; betrifftAb: string | null }
  | { modus: "begruendung_noetig"; meldung: string; betrifftAb: string | null };

/** Meldung des Sperr-Triggers (Migration 364). */
const SPERRE = /nur per Antrag/;

export const ANTRAG_HINWEIS_LOHN =
  "Die Änderung betrifft abgerechnete Monate — beantragt. Sie wird wirksam, wenn eine zweite Person (anderer Admin oder Vertretung) innert 24 h auf einem vertrauten Gerät bestätigt. Danach schlägt das System Korrekturfassungen vor.";

function datumAusMeldung(m: string): string | null {
  const t = /\(ab (\d{2})\.(\d{2})\.(\d{4})\)/.exec(m);
  return t ? `${t[3]}-${t[2]}-${t[1]}` : null;
}

async function melde(admin: SupabaseClient, titel: string, text: string, ohne: string | null) {
  try {
    const empfaenger = (await recipientsWithPermission(admin, LOHN_RECHT)).filter((id) => id !== ohne);
    if (empfaenger.length === 0) return;
    await notifySystem(admin, { recipients: empfaenger, title: titel, message: text, link: rechteAntraegeHref() });
  } catch (e) {
    logError("lohn.aenderung.meldung", e);
  }
}

/** Ändern — direkt, oder (abgerechnete Monate) als Antrag mit Begründung. */
export async function aendereLohndaten(
  admin: SupabaseClient,
  a: {
    operationen: Operation[];
    bereich: Bereich;
    profileId: string | null;
    zielName: string | null;
    beschreibung: string;
    begruendung: string | null;
    akteurId: string;
    akteurName: string | null;
  },
): Promise<AenderungsErgebnis> {
  const { data, error } = await admin.rpc("lohn_aenderung_direkt", {
    p_operationen: a.operationen,
    p_akteur: a.akteurId,
    p_akteur_name: a.akteurName,
  });
  if (!error) return { modus: "direkt", ids: (data as (string | null)[]) ?? [] };
  if (!SPERRE.test(error.message)) throw new Error(error.message);

  const betrifftAb = datumAusMeldung(error.message);
  const begruendung = (a.begruendung ?? "").trim();
  if (begruendung.length < 10) {
    return { modus: "begruendung_noetig", meldung: error.message, betrifftAb };
  }
  const { data: antrag, error: insErr } = await admin
    .from("lohn_aenderungs_antraege")
    .insert({
      bereich: a.bereich,
      profile_id: a.profileId,
      ziel_name: a.zielName,
      beschreibung: a.beschreibung,
      begruendung,
      operationen: a.operationen,
      betrifft_ab: betrifftAb,
      beantragt_von: a.akteurId,
      beantragt_von_name: a.akteurName,
    })
    .select("id, gueltig_bis")
    .single();
  if (insErr || !antrag) throw new Error(`Antrag konnte nicht gespeichert werden: ${insErr?.message ?? "keine Antwort"}`);
  await melde(admin, "Lohndaten: Antrag wartet auf Bestätigung", `${a.akteurName ?? "Jemand"}: ${a.beschreibung} — Begründung: ${begruendung}`, a.akteurId);
  return { modus: "antrag", antragId: antrag.id as string, gueltigBis: antrag.gueltig_bis as string, betrifftAb };
}

export interface AntragZeile {
  id: string;
  bereich: Bereich;
  profile_id: string | null;
  ziel_name: string | null;
  beschreibung: string;
  begruendung: string;
  operationen: Operation[];
  betrifft_ab: string | null;
  status: "offen" | "bestaetigt" | "abgelehnt";
  beantragt_von: string;
  beantragt_von_name: string | null;
  beantragt_at: string;
  gueltig_bis: string;
  entschieden_von_name: string | null;
  entschieden_at: string | null;
  ablehnung_grund: string | null;
}

/** Warum DIESE Person einen Lohndaten-Antrag nicht bestätigen darf (null =
 *  darf; Lohnrecht und vertrautes Gerät prüft die Route vorher). Eine Regel für
 *  /api/hr/lohn-antraege (darf_bestaetigen) und den Zähler offener Anträge
 *  (src/lib/lohn/antraege-zaehler.ts). */
export function lohnHinderungsgrund(
  a: Pick<AntragZeile, "status" | "gueltig_bis" | "beantragt_von" | "profile_id">,
  ich: string,
  ansichtAls: boolean,
): string | null {
  if (a.status !== "offen") return a.status === "bestaetigt" ? "Schon bestätigt." : "Abgelehnt.";
  if (Date.parse(a.gueltig_bis) <= Date.now()) return "Abgelaufen (älter als 24 h) — bitte neu beantragen.";
  if (ansichtAls) return "In «Ansicht als» ist keine Bestätigung möglich.";
  if (a.beantragt_von === ich) return "Eigener Antrag — bestätigt eine zweite Person.";
  if (a.profile_id === ich) return "Den eigenen Lohn bestätigt eine zweite Person.";
  return null;
}

export async function ladeAntraege(admin: SupabaseClient): Promise<AntragZeile[]> {
  const { data, error } = await admin
    .from("lohn_aenderungs_antraege")
    .select("id, bereich, profile_id, ziel_name, beschreibung, begruendung, operationen, betrifft_ab, status, beantragt_von, beantragt_von_name, beantragt_at, gueltig_bis, entschieden_von_name, entschieden_at, ablehnung_grund")
    .order("beantragt_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(`Anträge konnten nicht geladen werden: ${error.message}`);
  return (data ?? []) as AntragZeile[];
}

/** Antrag bestätigen (DB prüft Vier Augen), danach Korrektur-Vorschläge. */
export async function bestaetigeAntrag(
  admin: SupabaseClient,
  id: string,
  bestaetiger: { id: string; name: string | null },
): Promise<{ vorschlaege: number; fehler: string[] }> {
  const { data, error } = await admin.rpc("lohn_aenderung_ausfuehren", {
    p_id: id, p_bestaetiger: bestaetiger.id, p_bestaetiger_name: bestaetiger.name, p_notweg_grund: null,
  });
  if (error) throw new Error(error.message);
  const r = data as { bereich: Bereich; profile_id: string | null; betrifft_ab: string | null };
  const ab = r.betrifft_ab ?? `${new Date().getFullYear()}-01-01`;
  return erstelleKorrekturVorschlaege(admin, {
    jahr: Number(ab.slice(0, 4)),
    profileIds: r.profile_id ? [r.profile_id] : null,
    abDatum: ab,
    nachAuszahlung: r.bereich === "firmensaetze",
    antragId: id,
  });
}

export async function lehneAntragAb(admin: SupabaseClient, id: string, actor: { id: string; name: string | null }, grund: string | null) {
  const { data, error } = await admin
    .from("lohn_aenderungs_antraege")
    .update({ status: "abgelehnt", entschieden_von: actor.id, entschieden_von_name: actor.name, entschieden_at: new Date().toISOString(), ablehnung_grund: grund })
    .eq("id", id)
    .eq("status", "offen")
    .select("id");
  if (error) throw new Error(error.message);
  if (!data || data.length !== 1) throw new Error("Antrag ist nicht mehr offen");
}

interface GueltigeFassung {
  id: string;
  profile_id: string;
  jahr: number;
  monat: number;
  brutto: number | string;
  netto: number | string;
  auszahlungsdatum: string;
  orig: string | null;
}

/**
 * Rechnet die Monate eines Jahres mit gültiger Fassung neu (Kern, Sätze nach
 * der ursprünglichen Auszahlung) und schlägt je abweichendem Monat eine
 * Korrekturfassung vor. Ein offener Vorschlag je Person/Monat wird
 * aktualisiert. Gibt Anzahl Vorschläge und Kern-Fehler zurück.
 *   - abDatum: nur Monate, die dieses Datum berühren oder später liegen
 *   - nachAuszahlung: Firmensätze — Monate mit ursprünglicher Auszahlung ab abDatum
 */
export async function erstelleKorrekturVorschlaege(
  admin: SupabaseClient,
  a: { jahr: number; profileIds: string[] | null; abDatum?: string; nachAuszahlung?: boolean; antragId?: string | null },
): Promise<{ vorschlaege: number; fehler: string[] }> {
  const fassungen = await ladeAlleSeiten<GueltigeFassung>(
    (von, bis) => {
      let q = admin.from("lohn_fassungen_gueltig").select("id, profile_id, jahr, monat, brutto, netto, auszahlungsdatum, orig:ergebnis->>auszahlungsdatum").eq("jahr", a.jahr);
      if (a.profileIds) q = q.in("profile_id", a.profileIds);
      return q.order("profile_id").order("monat").range(von, bis);
    },
    "Fassungen",
  );
  const betroffen = fassungen.filter((f) => {
    if (!a.abDatum) return true;
    if (a.nachAuszahlung) return (f.orig ?? f.auszahlungsdatum) >= a.abDatum;
    const monatsEnde = `${f.jahr}-${String(f.monat).padStart(2, "0")}-31`;
    return monatsEnde >= a.abDatum;
  });
  const jePerson = new Map<string, GueltigeFassung[]>();
  for (const f of betroffen) jePerson.set(f.profile_id, [...(jePerson.get(f.profile_id) ?? []), f]);

  let vorschlaege = 0;
  const fehler: string[] = [];
  for (const [id, liste] of jePerson) {
    const satzDatum = new Map(liste.map((f) => [monatKey(f.jahr, f.monat), f.orig ?? f.auszahlungsdatum]));
    const { ergebnisse, personen } = await rechneMonate(admin, [id], liste.map((f) => ({ jahr: f.jahr, monat: f.monat })), {
      auszahlungsdatum: (j, m) => satzDatum.get(monatKey(j, m))!,
    });
    const name = personen.get(id)?.name ?? id;
    for (const f of liste) {
      const r = ergebnisse.get(id)?.get(monatKey(f.jahr, f.monat));
      if (!r) continue;
      if (!r.ok) {
        fehler.push(`${name} ${monatKey(f.jahr, f.monat)}: ${r.fehler}`);
        continue;
      }
      const nettoAlt = Number(f.netto);
      const bruttoAlt = Number(f.brutto);
      const differenz = Number((r.ergebnis.netto - nettoAlt).toFixed(2));
      if (Math.abs(differenz) < 0.005 && Math.abs(r.ergebnis.brutto - bruttoAlt) < 0.005) continue;
      const werte = {
        profile_id: id, jahr: f.jahr, monat: f.monat, antrag_id: a.antragId ?? null, vorfassung_id: f.id,
        brutto_alt: bruttoAlt, brutto_neu: r.ergebnis.brutto, netto_alt: nettoAlt, netto_neu: r.ergebnis.netto, differenz,
      };
      const { data: offen, error: e1 } = await admin
        .from("lohn_korrektur_vorschlaege").select("id").eq("profile_id", id).eq("jahr", f.jahr).eq("monat", f.monat).eq("status", "offen").maybeSingle();
      if (e1) throw new Error(e1.message);
      const { error: e2 } = offen
        ? await admin.from("lohn_korrektur_vorschlaege").update(werte).eq("id", offen.id)
        : await admin.from("lohn_korrektur_vorschlaege").insert(werte);
      if (e2) throw new Error(`Vorschlag konnte nicht gespeichert werden: ${e2.message}`);
      vorschlaege++;
    }
  }
  return { vorschlaege, fehler };
}
