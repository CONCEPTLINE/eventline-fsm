// Alarm-Mail an die Lohnverwaltung, wenn der automatische Lohnlauf Hilfe braucht
// (Lohn-Umbau Phase 4 «Monatsabschluss»).
//
// Wann: der Lauf hatte Fehler, Monate sind blockiert (Stempel prüfen), der
// Status konnte nicht gespeichert werden, die Planung schlug fehl — oder der
// Lauf konnte gar nicht starten. Zusätzlich zur Glocke (lauf.ts «melde»).
//
// Muster wie die Technik-Alarme in Trust one (src/lib/technik/alarme.ts):
//   - Empfänger = alle aktiven Personen mit Lohnrecht (Admins immer;
//     recipientsWithPermission) mit E-Mail-Adresse.
//   - EINE Mail je Lauf (je Empfänger eine Zustellung, keine fremden
//     Adressen im «An»). Der Lauf wird in lohn_lauf atomar «beansprucht»
//     (alarm_gesendet_at nur setzen, wenn noch leer) — nie doppelt.
//   - Beansprucht wird nur, wenn der Mailversand eingerichtet ist; sonst bleibt
//     alarm_gesendet_at leer und alarm_fehler sagt warum (in der App sichtbar).
//   - Ergebnis in lohn_lauf.alarm_gesendet_at / alarm_empfaenger / alarm_fehler.
//   - KEINE Beträge in der Mail (Mail ist kein sicherer Kanal für Lohn) — Namen,
//     Monate und Gründe reichen; Beträge stehen nur in der App.
//   - Wirft nie (Fehler landen im Log und in alarm_fehler).
//
// Täglicher Lauf → bei einem andauernden Problem täglich eine Mail. Gewollt:
// der Lohn muss bis zum Auszahlungstag stehen.

import type { SupabaseClient } from "@supabase/supabase-js";
import { logError } from "@/lib/log";
import { escapeHtml, isMailConfigured, mailErrorMessage, mailLinkHref, mailRahmen, sendMailBatch } from "@/lib/mail";
import { recipientsWithPermission } from "@/lib/notification-recipients";
import { monatLabel } from "./monate";
import { LOHN_RECHT } from "./zugriff";

/** Ergebnis-Zeile eines Laufs (Teilmenge von LaufErgebnisZeile, ohne Zyklus-Import). */
export interface AlarmZeile {
  name: string;
  monat: string; // YYYY-MM
  fehler?: string;
  blockiert?: string;
}

export interface LaufAlarm {
  /** null = es gibt keinen Lauf-Eintrag (Start fehlgeschlagen). */
  laufId: string | null;
  art: "start" | "planung" | "ergebnis";
  /** Freitext (Start-/Planungsfehler, Speicherfehler). */
  text?: string;
  zusammenfassung?: string;
  ergebnisse?: AlarmZeile[];
}

export const ALARM_MAX_ZEILEN = 20;

/** Link auf Lohn › Monatsstunden (optional mit Monat YYYY-MM). */
export function monatsstundenLink(monat?: string | null): string {
  return `/lohn?ansicht=team&tab=monatsstunden${monat && /^\d{4}-\d{2}$/.test(monat) ? `&monat=${monat}` : ""}`;
}

/** Beträge aus Freitexten entfernen («CHF 1'234.50» → «CHF …»). Fehlertexte
 *  kommen aus dem Rechenkern/der DB und könnten einen Betrag enthalten. */
export function ohneBetraege(text: string): string {
  return text.replace(/(CHF|Fr\.)\s*-?\s*[\d'’]+(?:[.,]\d+)?/gi, "$1 …");
}

const WANN = new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

const monatText = (schluessel: string) => monatLabel({ jahr: Number(schluessel.slice(0, 4)), monat: Number(schluessel.slice(5, 7)) });

/** Zeilen der Mail (ohne Beträge). */
export function alarmZeilen(a: LaufAlarm): string[] {
  const out: string[] = [];
  if (a.text) out.push(ohneBetraege(a.text));
  const zeilen = a.ergebnisse ?? [];
  const blockiert = zeilen.filter((z) => z.blockiert);
  const fehler = zeilen.filter((z) => !z.blockiert);
  for (const z of [...fehler, ...blockiert].slice(0, ALARM_MAX_ZEILEN)) {
    const art = z.blockiert ? "Blockiert" : "Fehler";
    out.push(`${art}: ${z.name} · ${monatText(z.monat)} — ${ohneBetraege(z.blockiert ?? z.fehler ?? "unbekannt")}`);
  }
  if (zeilen.length > ALARM_MAX_ZEILEN) out.push(`… und ${zeilen.length - ALARM_MAX_ZEILEN} weitere (siehe App)`);
  return out;
}

export function alarmBetreff(a: LaufAlarm): string {
  if (a.art === "start") return "EVENTLINE Lohnlauf: konnte nicht starten";
  if (a.art === "planung") return "EVENTLINE Lohnlauf: fehlgeschlagen";
  const zeilen = a.ergebnisse ?? [];
  const blockiert = zeilen.filter((z) => z.blockiert).length;
  const fehler = zeilen.length - blockiert;
  const teile: string[] = [];
  if (fehler) teile.push(`${fehler} Fehler`);
  if (blockiert) teile.push(`${blockiert} blockiert (Stempel prüfen)`);
  if (teile.length === 0) teile.push("Status nicht gespeichert");
  return `EVENTLINE Lohnlauf: ${teile.join(", ")}`;
}

function appLink(pfad: string): string | null {
  return mailLinkHref(`${process.env.NEXT_PUBLIC_APP_URL ?? "https://eventline-basel.com"}${pfad}`);
}

/** Mail-HTML (alle Werte escaped). Exportiert für Tests. */
export function alarmMailHtml(a: LaufAlarm, zeitpunkt: Date = new Date()): string {
  const wann = WANN.format(zeitpunkt);
  const ersterMonat = (a.ergebnisse ?? []).map((z) => z.monat).sort()[0] ?? null;
  const link = appLink(monatsstundenLink(ersterMonat));
  const einleitung = a.art === "start"
    ? `Der automatische Lohnlauf (${wann}) konnte nicht starten:`
    : `Der automatische Lohnlauf (${wann}) braucht deine Aufmerksamkeit${a.zusammenfassung ? ` — ${a.zusammenfassung}` : ""}:`;
  const zeilen = alarmZeilen(a);
  return mailRahmen({
    titel: "EVENTLINE · Lohnlauf",
    headerBg: "#b91c1c",
    inhaltHtml: `
      <p style="margin:0 0 12px">Hallo,</p>
      <p style="margin:0 0 16px">${escapeHtml(einleitung)}</p>
      <div style="background:#fef2f2;padding:16px;border-radius:8px;border-left:4px solid #b91c1c;margin:0 0 16px">
        ${zeilen.map((z) => `<p style="margin:0 0 6px">${escapeHtml(z)}</p>`).join("")}
      </div>
      <p style="margin:0 0 16px;color:#374151">Blockiert heisst: offener oder ungeprüfter sehr langer Stempel — erst prüfen bzw. Ende setzen, dann wird die Abrechnung erstellt.</p>
      ${link ? `<p style="margin:0 0 16px"><a href="${link}" style="display:inline-block;padding:10px 18px;background:#111827;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600">Lohn › Monatsstunden öffnen</a></p>` : ""}
      <p style="margin:0;color:#9ca3af;font-size:12px">Diese Mail kommt bei jedem Lohnlauf mit Fehlern oder blockierten Monaten. Beträge stehen nur in der App.</p>
    `,
  });
}

/** Mailadressen aller aktiven Personen mit Lohnrecht (klein, ohne Doppelte). Wirft bei DB-Fehlern. */
export async function ladeAlarmEmpfaenger(admin: SupabaseClient): Promise<string[]> {
  const ids = await recipientsWithPermission(admin, LOHN_RECHT);
  if (ids.length === 0) return [];
  const adressen = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await admin.from("profiles").select("email").in("id", ids.slice(i, i + 200)).eq("is_active", true);
    if (error) throw new Error(`Empfänger konnten nicht geladen werden: ${error.message}`);
    for (const p of (data ?? []) as { email: string | null }[]) {
      const e = p.email?.trim().toLowerCase();
      if (e && e.includes("@")) adressen.add(e);
    }
  }
  return [...adressen];
}

async function festhalten(admin: SupabaseClient, laufId: string | null, felder: Record<string, unknown>) {
  if (!laufId) return;
  const { error } = await admin.from("lohn_lauf").update(felder).eq("id", laufId);
  if (error) logError("lohn.alarm.festhalten", error, { laufId });
}

/** Alarm senden. Wirft nie; Ergebnis steht in lohn_lauf.alarm_* (sofern ein Lauf existiert). */
export async function sendeLaufAlarm(admin: SupabaseClient, a: LaufAlarm): Promise<{ gesendet: number; fehler: string | null }> {
  try {
    let empfaenger: string[];
    try {
      empfaenger = await ladeAlarmEmpfaenger(admin);
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      logError("lohn.alarm.empfaenger", e, { laufId: a.laufId });
      await festhalten(admin, a.laufId, { alarm_fehler: text.slice(0, 500) });
      return { gesendet: 0, fehler: text };
    }
    if (!isMailConfigured()) {
      // Nicht beanspruchen — die Lücke ist in der App sichtbar (alarm_fehler).
      const text = "Mailversand nicht eingerichtet (RESEND_API_KEY fehlt)";
      logError("lohn.alarm.mail-nicht-eingerichtet", null, { laufId: a.laufId, empfaenger: empfaenger.length });
      await festhalten(admin, a.laufId, { alarm_empfaenger: empfaenger.length, alarm_fehler: text });
      return { gesendet: 0, fehler: text };
    }
    if (empfaenger.length === 0) {
      const text = "Keine Empfänger: niemand mit Lohnrecht hat eine E-Mail-Adresse";
      logError("lohn.alarm.keine-empfaenger", null, { laufId: a.laufId });
      await festhalten(admin, a.laufId, { alarm_empfaenger: 0, alarm_fehler: text });
      return { gesendet: 0, fehler: text };
    }

    // Beanspruchen: nur wer alarm_gesendet_at von leer auf jetzt stellt, sendet.
    if (a.laufId) {
      const { data, error } = await admin
        .from("lohn_lauf")
        .update({ alarm_gesendet_at: new Date().toISOString() })
        .eq("id", a.laufId)
        .is("alarm_gesendet_at", null)
        .select("id");
      if (error) {
        logError("lohn.alarm.beanspruchen", error, { laufId: a.laufId });
        return { gesendet: 0, fehler: error.message };
      }
      if (!data || data.length === 0) return { gesendet: 0, fehler: null }; // schon gesendet
    }

    const subject = alarmBetreff(a);
    const html = alarmMailHtml(a);
    const { sent, failed } = await sendMailBatch(empfaenger.map((to) => ({ to, subject, html })));
    for (const f of failed) logError("lohn.alarm.mail", f.error, { laufId: a.laufId });
    const fehlerText = failed.length
      ? `${failed.length} von ${empfaenger.length} nicht zugestellt: ${mailErrorMessage(failed[0].error) ?? "unbekannt"}`.slice(0, 500)
      : null;
    await festhalten(admin, a.laufId, {
      alarm_empfaenger: sent.length,
      alarm_fehler: fehlerText,
      // Ging gar nichts raus, gilt der Alarm nicht als gesendet.
      ...(sent.length === 0 ? { alarm_gesendet_at: null } : {}),
    });
    return { gesendet: sent.length, fehler: fehlerText };
  } catch (e) {
    logError("lohn.alarm", e, { laufId: a.laufId });
    return { gesendet: 0, fehler: e instanceof Error ? e.message : String(e) };
  }
}
