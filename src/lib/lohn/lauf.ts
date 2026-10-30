// Automatischer Lohnlauf (Phase 1, Befund 4 + S5).
//
// Läuft täglich (Cron). Holt ALLE gesperrten Monate ohne gültige Fassung nach
// — nicht nur den Vormonat —, ab `lohn_einstellungen.lauf_ab` (frühere Monate
// gehören zur Korrektur und werden nie automatisch erzeugt).
//
// Wer, welcher Monat (planeLauf, rein):
//   - je Person die Lohnzeile, die im Monat gilt (wie die Abrechnung: jüngstes
//     «gültig ab», das den Monat berührt). Keine Zeile = vor Eintritt / nach
//     Austritt → kein Monat. Eintrittsmonat zählt (Eintritt Mitte Monat).
//   - Phase 2: ist die Anstellung erfasst (lohn_anstellungen), zählen nur
//     Monate, die die Anstellung berühren (kein Abrechnen vor Eintritt /
//     nach Austritt); der Austritt ersetzt dann auch den Hinweis bei
//     inaktiven Personen.
//   - wage_exempt (kein Lohn) oder auto_lohnabrechnung aus → kein Monat.
//   - inaktive Person: nur Monate aus Lohnzeilen MIT Ende (Austritt bekannt,
//     Schlussabrechnung). Offene Lohnzeile einer inaktiven Person → keine
//     Monate, Hinweis «Austritt in der Lohnzeile eintragen».
//   - Monate mit gültiger Fassung (auch manuell hochgeladen) → übersprungen.
//   - Monate, deren Abrechnung im Papierkorb liegt → nicht erzeugt, Hinweis.
//   - Monate ohne Stunden → Abrechnung über CHF 0 (Pflicht).
//
// Fehler (arbeiteAb): jede Person/jeder Monat einzeln; ein Fehler betrifft nur
// diese Abrechnung. Der Lauf hält Status + Ergebnis in lohn_lauf fest (in der
// App sichtbar) und meldet Fehler den Personen mit Lohnrecht (Glocke).
//
// Phase 4 «Monatsabschluss»: Hat die Person im Monat einen offenen oder einen
// ungeprüften sehr langen Stempel, bricht die Abrechnung mit LohnFehler
// «stempel_pruefen» ab (src/lib/lohn/stempel-pruefung.ts). Das ist KEIN Fehler,
// sondern «blockiert»: eigenes Feld im Ergebnis, Zähler lohn_lauf.blockiert,
// Status «blockiert» (wenn sonst nichts schiefging). Bei Fehlern oder
// blockierten Monaten — und wenn der Lauf gar nicht starten kann — geht
// zusätzlich zur Glocke EINE Alarm-Mail je Lauf an die Lohnverwaltung
// (src/lib/lohn/alarm.ts, ohne Beträge), festgehalten in lohn_lauf.alarm_*.
//
// Entscheid Mischa 30.10.2026: Das ERP rechnet bis lohn_einstellungen.lauf_bis
// (November 2026), danach Trust flow/Bexio. Monate nach lauf_bis plant der
// Lauf gar nicht (höchstens EIN Hinweis je Lauf, kein Fehler, kein Alarm); die
// Statusspalte zeigt dort «über Trust flow».
//
// Systemweg: kein Benutzer, keine Gerätesperre — der Aufrufer (Cron-Route)
// prüft das Cron-Geheimnis zeitsicher. Siehe src/app/api/cron/auto-lohnabrechnung.
//
// Wartung (Migration 363, src/lib/wartung.ts): Ist «Lohn» in Wartung, läuft
// nichts — die Cron-Route ruft pausiereLohnLauf() statt fuehreLohnLaufAus()
// und hält «pausiert (Wartung)» in lohn_lauf fest.

import type { SupabaseClient } from "@supabase/supabase-js";
import { logError } from "@/lib/log";
import { todayLocalIso } from "@/lib/swiss-time";
import { notifySystem } from "@/lib/notification-service";
import { recipientsWithPermission } from "@/lib/notification-recipients";
import {
  gesperrteMonateAb,
  monatLabel,
  naechsterMonat,
  monatSchluessel,
  monatsErster,
  monatsLetzter,
  vergleicheMonat,
  type LohnMonat,
} from "./monate";
import { erzeugeUndSpeichereLohnabrechnung } from "./abrechnung";
import { LohnFehler } from "./fassung";
import { LOHN_RECHT, ladeLohnEinstellungen, nachLaufBis } from "./zugriff";
import { monatsstundenLink, ohneBetraege, sendeLaufAlarm } from "./alarm";

/** Code der Abrechnung, wenn Stempel des Monats erst geprüft werden müssen. */
export const STEMPEL_PRUEFEN = "stempel_pruefen";

export const SYSTEM_NAME = "Automatischer Lohnlauf";
/** Höchstens so viele Abrechnungen pro Lauf (Laufzeit); der Rest folgt am nächsten Tag. */
export const MAX_PRO_LAUF = 60;

export interface CompZeile {
  profile_id: string;
  effective_from: string;
  effective_to: string | null;
  wage_exempt: boolean | null;
  auto_lohnabrechnung: boolean | null;
}

export interface PersonInfo {
  name: string;
  aktiv: boolean;
}

export interface AnstellungZeile {
  profile_id: string;
  eintritt: string;
  austritt: string | null;
}

/** Berührt der Monat eine der Anstellungen? */
export function monatInAnstellung(anst: AnstellungZeile[], m: LohnMonat): boolean {
  const erster = monatsErster(m);
  const letzter = monatsLetzter(m);
  return anst.some((a) => a.eintritt <= letzter && (a.austritt == null || a.austritt >= erster));
}

export interface LaufAuftrag {
  profileId: string;
  name: string;
  monat: LohnMonat;
}

export interface LaufHinweis {
  profileId: string;
  name: string;
  text: string;
}

/** Lohnzeile, die im Monat gilt (jüngstes effective_from, das den Monat berührt). */
export function zeileImMonat(zeilen: CompZeile[], m: LohnMonat): CompZeile | null {
  const erster = monatsErster(m);
  const letzter = monatsLetzter(m);
  let best: CompZeile | null = null;
  for (const z of zeilen) {
    if (z.effective_from > letzter) continue;
    if (z.effective_to && z.effective_to < erster) continue;
    if (!best || z.effective_from > best.effective_from) best = z;
  }
  return best;
}

/** Lohnzeilen, die fürs Abrechnen zählen. null = inaktive Person mit offener
 *  Lohnzeile und ohne bekannten Austritt (lieber nichts abrechnen als Monate
 *  nach dem Austritt; der Lauf gibt einen Hinweis). Inaktiv mit bekanntem
 *  Ende: nur Lohnzeilen MIT Ende (Schlussabrechnung). */
export function lohnzeilenFuerAbrechnung(zeilen: CompZeile[], aktiv: boolean, anst: AnstellungZeile[]): CompZeile[] | null {
  const austrittBekannt = anst.length > 0 && anst.every((a) => a.austritt !== null);
  if (aktiv || austrittBekannt) return zeilen;
  if (zeilen.some((z) => z.effective_to === null)) return null;
  return zeilen.filter((z) => z.effective_to !== null);
}

/** Lohnzeile, nach der der Monat abzurechnen ist; null = keine Abrechnung
 *  nötig (vor Eintritt / nach Austritt der Anstellung, keine Lohnzeile, kein
 *  Lohn). «Automatisch abrechnen aus» zählt hier NICHT — dann ist die
 *  Abrechnung trotzdem nötig, nur von Hand (Statusspalte «fehlt»). */
export function abrechnungsZeile(zeilen: CompZeile[], anst: AnstellungZeile[], m: LohnMonat): CompZeile | null {
  if (anst.length > 0 && !monatInAnstellung(anst, m)) return null;
  const z = zeileImMonat(zeilen, m);
  if (!z || z.wage_exempt === true) return null;
  return z;
}

/** Hinweis im Lauf-Protokoll für Monate nach lauf_bis. */
export function laufBisHinweis(laufBis: LohnMonat): string {
  return `Ab ${monatLabel(naechsterMonat(laufBis))} rechnet Trust flow/Bexio — der Lauf erzeugt dafür keine Lohnabrechnungen mehr.`;
}

export function planeLauf(input: {
  heute: string;
  laufAb: LohnMonat;
  comps: CompZeile[];
  personen: Map<string, PersonInfo>;
  /** Schlüssel `${profileId}|YYYY-MM` aller Monate mit gültiger Fassung. */
  vorhanden: Set<string>;
  /** Schlüssel der Monate, deren Abrechnung im Papierkorb liegt (ohne gültige). */
  imPapierkorb?: Set<string>;
  /** Erfasste Anstellungen (Phase 2); fehlt eine Person, gilt nur die Lohnzeile. */
  anstellungen?: AnstellungZeile[];
  /** Letzter ERP-Lohnmonat (lohn_einstellungen.lauf_bis); danach Trust flow/Bexio. */
  laufBis?: LohnMonat | null;
}): { auftraege: LaufAuftrag[]; hinweise: LaufHinweis[] } {
  const gesperrt = gesperrteMonateAb(input.laufAb, input.heute);
  const monate = gesperrt.filter((m) => !nachLaufBis(input.laufBis ?? null, m));
  const proPerson = new Map<string, CompZeile[]>();
  for (const c of input.comps) {
    const l = proPerson.get(c.profile_id) ?? [];
    l.push(c);
    proPerson.set(c.profile_id, l);
  }

  const auftraege: LaufAuftrag[] = [];
  const hinweise: LaufHinweis[] = [];
  if (input.laufBis && monate.length < gesperrt.length) {
    // Einmal je Lauf, nicht je Person — kein Fehler, kein Alarm.
    hinweise.push({ profileId: "", name: "", text: laufBisHinweis(input.laufBis) });
  }
  const ids = Array.from(proPerson.keys()).sort((a, b) =>
    (input.personen.get(a)?.name ?? a).localeCompare(input.personen.get(b)?.name ?? b, "de-CH"),
  );
  for (const profileId of ids) {
    const person = input.personen.get(profileId);
    if (!person) continue; // Profil fehlt (verwaiste Lohnzeile) — nichts erzeugen
    const alle = proPerson.get(profileId)!;
    const anst = (input.anstellungen ?? []).filter((a) => a.profile_id === profileId);
    const zeilen = lohnzeilenFuerAbrechnung(alle, person.aktiv, anst);
    if (zeilen === null) {
      // Austritt unbekannt: lieber nichts erzeugen als Monate nach dem
      // Austritt abrechnen.
      const fehlend = monate.some((m) => zeileImMonat(alle, m) && !input.vorhanden.has(`${profileId}|${monatSchluessel(m)}`));
      if (fehlend) {
        hinweise.push({ profileId, name: person.name, text: "inaktiv, Lohnzeile ohne Ende — Austritt in der Lohnzeile eintragen; bis dahin keine automatische Abrechnung" });
      }
      continue;
    }
    for (const m of monate) {
      const z = abrechnungsZeile(zeilen, anst, m);
      if (!z) continue; // vor Eintritt / nach Austritt, keine Lohnzeile, kein Lohn
      if (z.auto_lohnabrechnung === false) continue;
      if (input.vorhanden.has(`${profileId}|${monatSchluessel(m)}`)) continue;
      if (input.imPapierkorb?.has(`${profileId}|${monatSchluessel(m)}`)) {
        // Bewusst weggelegt — der Lauf entscheidet das nicht selbst.
        hinweise.push({ profileId, name: person.name, text: `${monatLabel(m)}: Abrechnung liegt im Papierkorb — wiederherstellen oder neu erzeugen` });
        continue;
      }
      auftraege.push({ profileId, name: person.name, monat: m });
    }
  }
  auftraege.sort((a, b) => vergleicheMonat(a.monat, b.monat) || a.name.localeCompare(b.name, "de-CH"));
  return { auftraege, hinweise };
}

export interface LaufErgebnisZeile {
  profile_id: string;
  name: string;
  monat: string; // YYYY-MM
  ok: boolean;
  version?: number;
  uebersprungen?: string;
  fehler?: string;
  /** Phase 4: Monat blockiert (Stempel prüfen) — keine Abrechnung, aber kein
   *  Fehler. Text = Grund (stempelProblemText, ohne Beträge). ok ist dann false. */
  blockiert?: string;
}

export type LaufStatus = "ok" | "teilweise" | "fehler" | "blockiert";

/** Status und Zähler eines Laufs aus seinen Ergebnissen:
 *  Fehler gehen vor (teilweise, wenn trotzdem etwas erstellt wurde), sonst
 *  «blockiert», wenn ein Monat auf die Stempel-Prüfung wartet, sonst ok. */
export function laufStatus(ergebnisse: LaufErgebnisZeile[]): { status: LaufStatus; erstellt: number; fehler: number; blockiert: number } {
  const erstellt = ergebnisse.filter((r) => r.ok && !r.uebersprungen).length;
  const blockiert = ergebnisse.filter((r) => !r.ok && r.blockiert).length;
  const fehler = ergebnisse.filter((r) => !r.ok && !r.blockiert).length;
  const status: LaufStatus = fehler > 0 ? (erstellt > 0 ? "teilweise" : "fehler") : blockiert > 0 ? "blockiert" : "ok";
  return { status, erstellt, fehler, blockiert };
}

/** «3 erstellt, 1 blockiert (Stempel prüfen), 0 Fehler, 2 offen» */
export function laufZusammenfassung(z: { erstellt: number; blockiert: number; fehler: number; offen: number }): string {
  return `${z.erstellt} erstellt${z.blockiert ? `, ${z.blockiert} blockiert (Stempel prüfen)` : ""}, ${z.fehler} Fehler${z.offen ? `, ${z.offen} offen` : ""}`;
}

/** Arbeitet die Aufträge nacheinander ab; ein Fehler betrifft nur seinen
 *  Auftrag. `erzeuge` ist austauschbar (Tests). */
export async function arbeiteAb(
  auftraege: LaufAuftrag[],
  erzeuge: (a: LaufAuftrag) => Promise<{ version: number }>,
): Promise<LaufErgebnisZeile[]> {
  const out: LaufErgebnisZeile[] = [];
  for (const a of auftraege) {
    const basis = { profile_id: a.profileId, name: a.name, monat: monatSchluessel(a.monat) };
    try {
      const r = await erzeuge(a);
      out.push({ ...basis, ok: true, version: r.version });
    } catch (e) {
      if (e instanceof LohnFehler && e.code === "neue_fassung") {
        // Inzwischen erzeugt (z. B. von Hand) — kein Fehler, nichts überschrieben.
        out.push({ ...basis, ok: true, uebersprungen: "inzwischen vorhanden" });
        continue;
      }
      if (e instanceof LohnFehler && e.code === "lauf_bis") {
        // Monat nach dem letzten ERP-Lohnmonat (Trust flow/Bexio) — kein Fehler.
        out.push({ ...basis, ok: true, uebersprungen: "über Trust flow" });
        continue;
      }
      if (e instanceof LohnFehler && e.code === STEMPEL_PRUEFEN) {
        // Offener / ungeprüfter langer Stempel: die Abrechnung wäre zu tief.
        // Erwartet, kein Fehler — die Lohnverwaltung prüft (Statusspalte).
        out.push({ ...basis, ok: false, blockiert: e.message });
        continue;
      }
      const text = e instanceof Error ? e.message : String(e);
      logError("lohn.lauf.abrechnung", e, { profileId: a.profileId, monat: basis.monat });
      out.push({ ...basis, ok: false, fehler: text });
    }
  }
  return out;
}

async function ladeAlle<T>(abfrage: (von: number, bis: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const seite = 1000;
  const alle: T[] = [];
  for (let von = 0; ; von += seite) {
    const { data, error } = await abfrage(von, von + seite - 1);
    if (error) throw new Error(error.message);
    alle.push(...(data ?? []));
    if (!data || data.length < seite) return alle;
  }
}

export interface LaufAntwort {
  status: LaufStatus | "laeuft_schon" | "probe" | "pausiert";
  lauf_id: string | null;
  heute: string;
  lauf_ab: string | null;
  geplant: number;
  erstellt: number;
  fehler: number;
  /** Phase 4: Monate, die auf die Stempel-Prüfung warten. */
  blockiert: number;
  offen: number;
  ergebnisse: LaufErgebnisZeile[];
  hinweise: LaufHinweis[];
  plan?: { profile_id: string; name: string; monat: string }[];
  meldung?: string;
}

async function melde(admin: SupabaseClient, titel: string, text: string, link = "/lohn?ansicht=team&tab=dokumente") {
  try {
    const empfaenger = await recipientsWithPermission(admin, LOHN_RECHT);
    if (empfaenger.length === 0) return;
    await notifySystem(admin, {
      recipients: empfaenger,
      title: ohneBetraege(titel),
      message: ohneBetraege(text),
      link,
    });
  } catch (e) {
    logError("lohn.lauf.meldung", e);
  }
}

const monatAus = (schluessel: string): LohnMonat => ({ jahr: Number(schluessel.slice(0, 4)), monat: Number(schluessel.slice(5, 7)) });

/** Glocke: Fehler und blockierte Monate in EINER Meldung (Titel beginnt mit «Lohnlauf:»). */
function meldungsText(fehler: LaufErgebnisZeile[], blockiert: LaufErgebnisZeile[]): { titel: string; text: string } {
  const teile: string[] = [];
  if (fehler.length) teile.push(`${fehler.length} Abrechnung(en) fehlgeschlagen`);
  if (blockiert.length) teile.push(`${blockiert.length} blockiert — Stempel prüfen`);
  const zeilen = [...fehler, ...blockiert]
    .slice(0, 5)
    .map((f) => `${f.name} ${monatLabel(monatAus(f.monat))}: ${f.blockiert ?? f.fehler}`);
  const alle = fehler.length + blockiert.length;
  if (alle > 5) zeilen.push(`… und ${alle - 5} weitere`);
  return { titel: `Lohnlauf: ${teile.join(", ")}`, text: zeilen.join("\n") };
}

/** Den Lauf ausführen. `probe` = nur planen, nichts schreiben. */
export async function fuehreLohnLaufAus(
  admin: SupabaseClient,
  opts: { ausloeser: "cron" | "manuell"; probe?: boolean; heute?: string; maxAnzahl?: number },
): Promise<LaufAntwort> {
  const heute = opts.heute ?? todayLocalIso();
  const leer: LaufAntwort = { status: "ok", lauf_id: null, heute, lauf_ab: null, geplant: 0, erstellt: 0, fehler: 0, blockiert: 0, offen: 0, ergebnisse: [], hinweise: [] };

  let laufId: string | null = null;
  if (!opts.probe) {
    const { data, error } = await admin.rpc("lohn_lauf_starten", { p_ausloeser: opts.ausloeser });
    if (error) {
      logError("lohn.lauf.start", error);
      await melde(admin, "Lohnlauf konnte nicht starten", error.message);
      await sendeLaufAlarm(admin, { laufId: null, art: "start", text: `Lauf konnte nicht starten: ${error.message}` });
      return { ...leer, status: "fehler", meldung: `Lauf konnte nicht starten: ${error.message}` };
    }
    if (!data) return { ...leer, status: "laeuft_schon", meldung: "Es läuft bereits ein Lohnlauf." };
    laufId = data as string;
  }

  /** Status festhalten; liefert den Fehlertext, wenn das nicht ging. */
  const abschliessen = async (a: LaufAntwort, zusammenfassung: string): Promise<string | null> => {
    if (!laufId) return null;
    const { error } = await admin
      .from("lohn_lauf")
      .update({
        status: a.status,
        beendet_at: new Date().toISOString(),
        erstellt: a.erstellt,
        fehler: a.fehler,
        blockiert: a.blockiert,
        offen: a.offen,
        ergebnisse: a.ergebnisse,
        hinweise: a.hinweise,
        zusammenfassung,
      })
      .eq("id", laufId);
    if (error) {
      logError("lohn.lauf.abschluss", error, { laufId });
      await melde(admin, "Lohnlauf: Status konnte nicht gespeichert werden", `${zusammenfassung} — ${error.message}`);
      return error.message;
    }
    return null;
  };

  // --- Planen -------------------------------------------------------------
  let plan: ReturnType<typeof planeLauf>;
  let laufAb: LohnMonat;
  try {
    const einst = await ladeLohnEinstellungen(admin);
    laufAb = einst.laufAb;
    const comps = await ladeAlle<CompZeile>((von, bis) =>
      admin
        .from("employee_compensation")
        .select("profile_id, effective_from, effective_to, wage_exempt, auto_lohnabrechnung")
        .order("id")
        .range(von, bis),
    );
    const ids = Array.from(new Set(comps.map((c) => c.profile_id)));
    const personen = new Map<string, PersonInfo>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await admin.from("profiles").select("id, full_name, is_active").in("id", ids.slice(i, i + 200));
      if (error) throw new Error(`Profile: ${error.message}`);
      for (const p of data ?? []) personen.set(p.id as string, { name: (p.full_name as string) ?? "?", aktiv: p.is_active === true });
    }
    const docs = await ladeAlle<{ profile_id: string; year: number; period_month: number; archived_at: string | null }>((von, bis) =>
      admin
        .from("wage_documents")
        .select("profile_id, year, period_month, archived_at")
        .eq("doc_type", "lohnabrechnung")
        .is("superseded_at", null)
        .gte("year", laufAb.jahr)
        .order("id")
        .range(von, bis),
    );
    const schluessel = (d: { profile_id: string; year: number; period_month: number }) =>
      `${d.profile_id}|${monatSchluessel({ jahr: d.year, monat: d.period_month })}`;
    const vorhanden = new Set(docs.filter((d) => !d.archived_at).map(schluessel));
    const imPapierkorb = new Set(docs.filter((d) => d.archived_at).map(schluessel));
    const anstellungen = await ladeAlle<AnstellungZeile & { id: string }>((von, bis) =>
      admin.from("lohn_anstellungen").select("id, profile_id, eintritt, austritt").order("id").range(von, bis),
    );
    plan = planeLauf({ heute, laufAb, comps, personen, vorhanden, imPapierkorb, anstellungen, laufBis: einst.laufBis });
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    logError("lohn.lauf.planen", e);
    const a: LaufAntwort = { ...leer, lauf_id: laufId, status: "fehler", meldung: `Planung fehlgeschlagen: ${text}` };
    if (!opts.probe) {
      await melde(admin, "Lohnlauf fehlgeschlagen", `Planung fehlgeschlagen: ${text}`);
      const speicherFehler = await abschliessen(a, `Planung fehlgeschlagen: ${text}`);
      await sendeLaufAlarm(admin, {
        laufId,
        art: "planung",
        text: `Planung fehlgeschlagen: ${text}${speicherFehler ? ` — Status nicht gespeichert: ${speicherFehler}` : ""}`,
      });
    }
    return a;
  }

  const max = opts.maxAnzahl ?? MAX_PRO_LAUF;
  const jetzt = plan.auftraege.slice(0, max);
  const offen = plan.auftraege.length - jetzt.length;

  if (opts.probe) {
    return {
      ...leer,
      status: "probe",
      lauf_ab: monatSchluessel(laufAb),
      geplant: plan.auftraege.length,
      offen,
      hinweise: plan.hinweise,
      plan: plan.auftraege.map((a) => ({ profile_id: a.profileId, name: a.name, monat: monatSchluessel(a.monat) })),
    };
  }

  // --- Abarbeiten ---------------------------------------------------------
  const ergebnisse = await arbeiteAb(jetzt, (a) =>
    erzeugeUndSpeichereLohnabrechnung(admin, {
      profileId: a.profileId,
      year: a.monat.jahr,
      month: a.monat.monat,
      actorId: null,
      actorName: SYSTEM_NAME,
      neueFassung: false,
    }),
  );
  const z = laufStatus(ergebnisse);
  const fehlerZeilen = ergebnisse.filter((r) => !r.ok && !r.blockiert);
  const blockiertZeilen = ergebnisse.filter((r) => !r.ok && r.blockiert);
  const hinweise = [...plan.hinweise];
  if (offen > 0) hinweise.push({ profileId: "", name: "", text: `${offen} weitere Abrechnung(en) folgen beim nächsten Lauf` });
  const zusammenfassung = laufZusammenfassung({ ...z, offen });

  // Frühester betroffener Monat — dorthin führen Glocke und Alarm-Mail.
  const probleme = [...fehlerZeilen, ...blockiertZeilen];
  const ersterMonat = probleme.map((r) => r.monat).sort()[0];
  if (probleme.length > 0) {
    const m = meldungsText(fehlerZeilen, blockiertZeilen);
    await melde(admin, m.titel, m.text, monatsstundenLink(ersterMonat));
  }

  const antwort: LaufAntwort = {
    status: z.status,
    lauf_id: laufId,
    heute,
    lauf_ab: monatSchluessel(laufAb),
    geplant: plan.auftraege.length,
    erstellt: z.erstellt,
    fehler: z.fehler,
    blockiert: z.blockiert,
    offen,
    ergebnisse,
    hinweise,
  };
  const speicherFehler = await abschliessen(antwort, zusammenfassung);
  if (probleme.length > 0 || speicherFehler) {
    await sendeLaufAlarm(admin, {
      laufId,
      art: "ergebnis",
      zusammenfassung,
      ergebnisse: probleme,
      text: speicherFehler ? `Status des Laufs konnte nicht gespeichert werden: ${speicherFehler}` : undefined,
    });
  }
  return antwort;
}

/** Zusammenfassung eines pausierten Laufs (lohn_lauf, in der App sichtbar). */
export const LAUF_PAUSIERT = "pausiert (Wartung)";

/** Wartung «Lohn»: nichts erzeugen, nur den Status festhalten (probe: nicht
 *  einmal das). Keine Glocke — die Pause ist gewollt und täglich gleich. */
export async function pausiereLohnLauf(
  admin: SupabaseClient,
  opts: { ausloeser: "cron" | "manuell"; probe?: boolean; heute?: string },
): Promise<LaufAntwort> {
  const heute = opts.heute ?? todayLocalIso();
  const antwort: LaufAntwort = {
    status: "pausiert", lauf_id: null, heute, lauf_ab: null, geplant: 0, erstellt: 0, fehler: 0, blockiert: 0, offen: 0,
    ergebnisse: [], hinweise: [], meldung: `Lohnlauf ${LAUF_PAUSIERT}`,
  };
  if (opts.probe) return antwort;
  const jetzt = new Date().toISOString();
  const { data, error } = await admin
    .from("lohn_lauf")
    .insert({ ausloeser: opts.ausloeser, status: "pausiert", gestartet_at: jetzt, beendet_at: jetzt, zusammenfassung: LAUF_PAUSIERT })
    .select("id")
    .single();
  if (error) {
    logError("lohn.lauf.pause", error);
    return { ...antwort, status: "fehler", meldung: `Pause konnte nicht festgehalten werden: ${error.message}` };
  }
  return { ...antwort, lauf_id: (data?.id as string | undefined) ?? null };
}

// ---------------------------------------------------------------------------
// Statusspalte «Monatsabschluss» (Lohn › Monatsstunden, Phase 4)
// ---------------------------------------------------------------------------

/**
 *   offen       Monat noch nicht gesperrt (Anzeige «—»)
 *   keine       keine Abrechnung nötig (kein Lohn, vor Eintritt/nach Austritt)
 *   fehlt       gesperrt, nötig, keine gültige Fassung
 *   erstellt    gültige Fassung, noch nicht als ausbezahlt markiert
 *   blockiert   gesperrt, keine Fassung, offene/ungeprüfte lange Stempel
 *   korrektur   offener Korrektur-Vorschlag oder unbezahlte Korrekturfassung
 *   fehler      letzter Lauf ist für Person/Monat mit Fehler gescheitert
 *   ausbezahlt  letzte Fassung als ausbezahlt markiert (Altbestand: gilt als ausbezahlt)
 *   trust_flow  Monat nach lauf_bis — rechnet Trust flow/Bexio (keine Abrechnung im ERP)
 */
export type MonatsStatus = "offen" | "keine" | "fehlt" | "erstellt" | "blockiert" | "korrektur" | "fehler" | "ausbezahlt" | "trust_flow";

export function bestimmeMonatsStatus(i: {
  gesperrt: boolean;
  /** Abrechnung nötig (abrechnungsZeile ≠ null). */
  noetig: boolean;
  /** Art der gültigen (letzten) Fassung, null = keine. */
  fassungArt: "regulaer" | "korrektur" | "altbestand" | null;
  /** Gültige Lohnabrechnung ohne Momentaufnahme (hochgeladen). */
  manuell: boolean;
  /** Nicht stornierte Auszahlung zur letzten Fassung. */
  ausbezahlt: boolean;
  vorschlagOffen: boolean;
  stempelProbleme: number;
  laufFehler: string | null;
  /** Monat nach lohn_einstellungen.lauf_bis (Trust flow/Bexio). */
  nachLaufBis?: boolean;
  /** Gültige Lohnabrechnung aus Bexio (Quelle «bexio», über Trust flow; Migration 369). */
  bexio?: boolean;
}): MonatsStatus {
  // Nach dem letzten ERP-Lohnmonat: nie «fehlt»/«blockiert» — dort rechnet Trust flow.
  // Eine Lohnabrechnung aus Bexio ist dort der Normalfall (keine Momentaufnahme, nicht «hochgeladen»).
  if (i.nachLaufBis && !i.fassungArt && (i.bexio || !i.manuell)) return i.noetig || i.bexio ? "trust_flow" : "keine";
  if (!i.gesperrt) return "offen";
  if (i.fassungArt) {
    if (i.vorschlagOffen) return "korrektur";
    if (i.ausbezahlt || i.fassungArt === "altbestand") return "ausbezahlt";
    if (i.fassungArt === "korrektur") return "korrektur";
    return "erstellt";
  }
  if (i.manuell) return "erstellt";
  if (!i.noetig) return "keine";
  if (i.stempelProbleme > 0) return "blockiert";
  if (i.laufFehler) return "fehler";
  return "fehlt";
}
