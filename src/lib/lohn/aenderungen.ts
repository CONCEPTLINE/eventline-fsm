// Änderungen an Stempeln (time_entries) gesperrter Monate.
//
// Jede Änderung läuft über die DB-Funktion lohn_aenderung_direkt (alles oder
// nichts, Protokoll alt/neu/wer per Trigger, Migration 364). Betrifft sie
// abgerechnete (gesperrte) Monate, bricht der Sperr-Trigger ab — dann stellt
// der Server einen ANTRAG mit Begründung, den eine zweite Person (anderer
// Admin oder die Vertretung) auf einem vertrauten Gerät innert 24 h bestätigt
// (gleiches Muster wie rechte_antraege). Trust flow sieht die Änderung über
// /api/flow/stempel (nachtraeglich_geaendert). Lohnzeilen, Firmensätze,
// Anstellungen und Zusatzposten führt seit November 2026 Trust flow
// (Lohn-Abbau 11.11.2026, Migration 389).

import type { SupabaseClient } from "@supabase/supabase-js";
import { notifySystem } from "@/lib/notification-service";
import { recipientsWithPermission } from "@/lib/notification-recipients";
import { logError } from "@/lib/log";
import { LOHN_RECHT } from "./zugriff";
import { rechteAntraegeHref } from "@/lib/antraege-links";

export type LohnTabelle = "time_entries";

export interface Operation {
  op: "insert" | "update" | "delete";
  tabelle: LohnTabelle;
  id?: string;
  werte?: Record<string, unknown>;
}

export type Bereich = "stempel";

export type AenderungsErgebnis =
  | { modus: "direkt"; ids: (string | null)[] }
  | { modus: "antrag"; antragId: string; gueltigBis: string; betrifftAb: string | null }
  | { modus: "begruendung_noetig"; meldung: string; betrifftAb: string | null };

/** Meldung des Sperr-Triggers (Migration 364). */
const SPERRE = /nur per Antrag/;

const BEREICH_TEXT: Record<Bereich, string> = {
  stempel: "Stempel",
};

export const ANTRAG_HINWEIS_LOHN =
  "Die Änderung betrifft abgerechnete Monate — beantragt. Sie wird wirksam, wenn eine zweite Person (anderer Admin oder Vertretung) innert 24 h auf einem vertrauten Gerät bestätigt.";

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
  // Meldung auch als Push (Sperrbildschirm): ohne Beträge und Begründung — Details nur im Reiter.
  await melde(admin, "Lohndaten: Antrag wartet auf Bestätigung",
    `${a.akteurName ?? "Jemand"} beantragt eine Änderung (${BEREICH_TEXT[a.bereich]}${a.zielName ? `, ${a.zielName}` : ""}) — Details und Bestätigen unter Freigaben › Rechte & Lohndaten.`, a.akteurId);
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
  if (a.profile_id === ich) return "Eigene Stempel bestätigt eine zweite Person.";
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

/** Antrag bestätigen (DB prüft Vier Augen und führt die Änderung aus). */
export async function bestaetigeAntrag(
  admin: SupabaseClient,
  id: string,
  bestaetiger: { id: string; name: string | null },
): Promise<void> {
  const { error } = await admin.rpc("lohn_aenderung_ausfuehren", {
    p_id: id, p_bestaetiger: bestaetiger.id, p_bestaetiger_name: bestaetiger.name, p_notweg_grund: null,
  });
  if (error) throw new Error(error.message);
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
