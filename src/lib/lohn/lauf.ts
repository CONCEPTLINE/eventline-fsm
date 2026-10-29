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
// Systemweg: kein Benutzer, keine Gerätesperre — der Aufrufer (Cron-Route)
// prüft das Cron-Geheimnis zeitsicher. Siehe src/app/api/cron/auto-lohnabrechnung.

import type { SupabaseClient } from "@supabase/supabase-js";
import { logError } from "@/lib/log";
import { todayLocalIso } from "@/lib/swiss-time";
import { notifySystem } from "@/lib/notification-service";
import { recipientsWithPermission } from "@/lib/notification-recipients";
import {
  gesperrteMonateAb,
  monatLabel,
  monatSchluessel,
  monatsErster,
  monatsLetzter,
  vergleicheMonat,
  type LohnMonat,
} from "./monate";
import { erzeugeUndSpeichereLohnabrechnung } from "./abrechnung";
import { LohnFehler } from "./fassung";
import { LOHN_RECHT, ladeLohnEinstellungen } from "./zugriff";

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

export function planeLauf(input: {
  heute: string;
  laufAb: LohnMonat;
  comps: CompZeile[];
  personen: Map<string, PersonInfo>;
  /** Schlüssel `${profileId}|YYYY-MM` aller Monate mit gültiger Fassung. */
  vorhanden: Set<string>;
  /** Schlüssel der Monate, deren Abrechnung im Papierkorb liegt (ohne gültige). */
  imPapierkorb?: Set<string>;
}): { auftraege: LaufAuftrag[]; hinweise: LaufHinweis[] } {
  const monate = gesperrteMonateAb(input.laufAb, input.heute);
  const proPerson = new Map<string, CompZeile[]>();
  for (const c of input.comps) {
    const l = proPerson.get(c.profile_id) ?? [];
    l.push(c);
    proPerson.set(c.profile_id, l);
  }

  const auftraege: LaufAuftrag[] = [];
  const hinweise: LaufHinweis[] = [];
  const ids = Array.from(proPerson.keys()).sort((a, b) =>
    (input.personen.get(a)?.name ?? a).localeCompare(input.personen.get(b)?.name ?? b, "de-CH"),
  );
  for (const profileId of ids) {
    const person = input.personen.get(profileId);
    if (!person) continue; // Profil fehlt (verwaiste Lohnzeile) — nichts erzeugen
    let zeilen = proPerson.get(profileId)!;
    if (!person.aktiv) {
      const offen = zeilen.some((z) => z.effective_to === null);
      if (offen) {
        // Austritt unbekannt: lieber nichts erzeugen als Monate nach dem
        // Austritt abrechnen.
        const fehlend = monate.some((m) => zeileImMonat(zeilen, m) && !input.vorhanden.has(`${profileId}|${monatSchluessel(m)}`));
        if (fehlend) {
          hinweise.push({ profileId, name: person.name, text: "inaktiv, Lohnzeile ohne Ende — Austritt in der Lohnzeile eintragen; bis dahin keine automatische Abrechnung" });
        }
        continue;
      }
      zeilen = zeilen.filter((z) => z.effective_to !== null);
    }
    for (const m of monate) {
      const z = zeileImMonat(zeilen, m);
      if (!z) continue; // vor Eintritt / nach Austritt
      if (z.wage_exempt === true) continue;
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
  status: "ok" | "teilweise" | "fehler" | "laeuft_schon" | "probe";
  lauf_id: string | null;
  heute: string;
  lauf_ab: string | null;
  geplant: number;
  erstellt: number;
  fehler: number;
  offen: number;
  ergebnisse: LaufErgebnisZeile[];
  hinweise: LaufHinweis[];
  plan?: { profile_id: string; name: string; monat: string }[];
  meldung?: string;
}

async function melde(admin: SupabaseClient, titel: string, text: string) {
  try {
    const empfaenger = await recipientsWithPermission(admin, LOHN_RECHT);
    if (empfaenger.length === 0) return;
    await notifySystem(admin, {
      recipients: empfaenger,
      title: titel,
      message: text,
      link: "/lohn?ansicht=team&tab=dokumente",
    });
  } catch (e) {
    logError("lohn.lauf.meldung", e);
  }
}

/** Den Lauf ausführen. `probe` = nur planen, nichts schreiben. */
export async function fuehreLohnLaufAus(
  admin: SupabaseClient,
  opts: { ausloeser: "cron" | "manuell"; probe?: boolean; heute?: string; maxAnzahl?: number },
): Promise<LaufAntwort> {
  const heute = opts.heute ?? todayLocalIso();
  const leer: LaufAntwort = { status: "ok", lauf_id: null, heute, lauf_ab: null, geplant: 0, erstellt: 0, fehler: 0, offen: 0, ergebnisse: [], hinweise: [] };

  let laufId: string | null = null;
  if (!opts.probe) {
    const { data, error } = await admin.rpc("lohn_lauf_starten", { p_ausloeser: opts.ausloeser });
    if (error) {
      logError("lohn.lauf.start", error);
      await melde(admin, "Lohnlauf konnte nicht starten", error.message);
      return { ...leer, status: "fehler", meldung: `Lauf konnte nicht starten: ${error.message}` };
    }
    if (!data) return { ...leer, status: "laeuft_schon", meldung: "Es läuft bereits ein Lohnlauf." };
    laufId = data as string;
  }

  const abschliessen = async (a: LaufAntwort, zusammenfassung: string): Promise<LaufAntwort> => {
    if (!laufId) return a;
    const { error } = await admin
      .from("lohn_lauf")
      .update({
        status: a.status,
        beendet_at: new Date().toISOString(),
        erstellt: a.erstellt,
        fehler: a.fehler,
        offen: a.offen,
        ergebnisse: a.ergebnisse,
        hinweise: a.hinweise,
        zusammenfassung,
      })
      .eq("id", laufId);
    if (error) {
      logError("lohn.lauf.abschluss", error, { laufId });
      await melde(admin, "Lohnlauf: Status konnte nicht gespeichert werden", `${zusammenfassung} — ${error.message}`);
    }
    return a;
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
    plan = planeLauf({ heute, laufAb, comps, personen, vorhanden, imPapierkorb });
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    logError("lohn.lauf.planen", e);
    const a: LaufAntwort = { ...leer, lauf_id: laufId, status: "fehler", meldung: `Planung fehlgeschlagen: ${text}` };
    if (!opts.probe) {
      await melde(admin, "Lohnlauf fehlgeschlagen", `Planung fehlgeschlagen: ${text}`);
      return abschliessen(a, `Planung fehlgeschlagen: ${text}`);
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
  const fehler = ergebnisse.filter((r) => !r.ok);
  const erstellt = ergebnisse.filter((r) => r.ok && !r.uebersprungen).length;
  const hinweise = [...plan.hinweise];
  if (offen > 0) hinweise.push({ profileId: "", name: "", text: `${offen} weitere Abrechnung(en) folgen beim nächsten Lauf` });

  const status: LaufAntwort["status"] = fehler.length === 0 ? "ok" : erstellt > 0 ? "teilweise" : "fehler";
  const zusammenfassung = `${erstellt} erstellt, ${fehler.length} Fehler${offen ? `, ${offen} offen` : ""}`;

  if (fehler.length > 0) {
    const zeilen = fehler.slice(0, 5).map((f) => `${f.name} ${monatLabel({ jahr: Number(f.monat.slice(0, 4)), monat: Number(f.monat.slice(5, 7)) })}: ${f.fehler}`);
    if (fehler.length > 5) zeilen.push(`… und ${fehler.length - 5} weitere`);
    await melde(admin, `Lohnlauf: ${fehler.length} Abrechnung(en) fehlgeschlagen`, zeilen.join("\n"));
  }

  return abschliessen(
    {
      status,
      lauf_id: laufId,
      heute,
      lauf_ab: monatSchluessel(laufAb),
      geplant: plan.auftraege.length,
      erstellt,
      fehler: fehler.length,
      offen,
      ergebnisse,
      hinweise,
    },
    zusammenfassung,
  );
}
