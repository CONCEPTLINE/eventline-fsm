// Zustellung von Lohnabrechnungen an die Mitarbeitenden (Lohn-Umbau Phase 4).
//
// VERTRAG (von src/lib/lohn/abrechnung.ts nach jeder neuen Fassung aufgerufen):
//   meldeNeueAbrechnung(admin, { profileId, jahr, monat, wageDocumentId, art })
//   - hält in lohn_dokument_zustellung «bereitgestellt» fest (+ aktuelle Wahl digital/Papier)
//   - meldet der Person über den Benachrichtigungsdienst (Typ lohn_dokument,
//     In-App/Push/Mail je Kanal-Einstellung), dass eine neue Abrechnung
//     bereitliegt — OHNE Beträge; benachrichtigt_at/_kanaele = Nachweis
//   - wirft NIE (Fehler nur loggen) — die Abrechnung ist zu diesem Zeitpunkt gespeichert.
//
// Wahl digital/Papier (lohn_zustellung_wahl, Historie, nie ändern/löschen):
//   - aktuelle Wahl = jüngster Eintrag; quelle selbst | lohnverwaltung | uebernommen
//   - digital = Einwilligung (wie bisher profiles.lohndokumente_digital_accepted_*
//     — beide werden gleich geschrieben); papier = Einwilligung widerrufen
//     (profiles-Felder werden geleert)
//   - keine Wahl = noch keine Einwilligung → wie Papier behandeln (die
//     Lohnverwaltung druckt aus), die Person wird beim Öffnen gefragt.
//
// Geöffnet: zählt nur, wenn die Person SELBST ihr Dokument abruft
// (src/app/api/hr/wage-documents/[id], RPC lohn_dokument_geoeffnet).
//
// Nur Server (Admin-Client).

import type { SupabaseClient } from "@supabase/supabase-js";
import { logError } from "@/lib/log";
import { notifyLohnDokument } from "@/lib/notification-service";
import { monatLabel } from "./monate";

export interface NeueAbrechnung {
  profileId: string;
  jahr: number;
  monat: number;
  wageDocumentId: string;
  art: "regulaer" | "korrektur";
}

export type ZustellWahl = "digital" | "papier";
export type ZustellQuelle = "selbst" | "lohnverwaltung" | "uebernommen";

/** Fassung des Einwilligungstexts (Meine Lohndokumente). */
export const DIGITAL_EINWILLIGUNG_VERSION = "1.0";

export interface WahlEintrag {
  id: string | null;
  wahl: ZustellWahl;
  version: string | null;
  gewaehlt_at: string;
  quelle: ZustellQuelle;
  akteur_name: string | null;
  notiz: string | null;
}

/** Aktuelle Wahl einer Person (null = noch keine). Fällt auf die Einwilligung
 *  in profiles zurück, falls sie (vor Phase 4 / zwischen Migration und Code)
 *  ohne Historien-Eintrag gesetzt wurde. Wirft bei Ladefehlern. */
export async function ladeAktuelleWahl(admin: SupabaseClient, profileId: string): Promise<WahlEintrag | null> {
  const { data, error } = await admin
    .from("lohn_zustellung_wahl")
    .select("id, wahl, version, gewaehlt_at, quelle, akteur_name, notiz")
    .eq("profile_id", profileId)
    .order("gewaehlt_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Zustell-Wahl konnte nicht geladen werden: ${error.message}`);
  if (data) return data as WahlEintrag;
  const { data: p, error: pErr } = await admin
    .from("profiles")
    .select("lohndokumente_digital_accepted_at, lohndokumente_digital_accepted_version")
    .eq("id", profileId)
    .maybeSingle();
  if (pErr) throw new Error(`Einwilligung konnte nicht geladen werden: ${pErr.message}`);
  if (!p?.lohndokumente_digital_accepted_at) return null;
  return {
    id: null,
    wahl: "digital",
    version: (p.lohndokumente_digital_accepted_version as string | null) ?? null,
    gewaehlt_at: p.lohndokumente_digital_accepted_at as string,
    quelle: "uebernommen",
    akteur_name: null,
    notiz: null,
  };
}

/** Historie (neueste zuerst). */
export async function ladeWahlHistorie(admin: SupabaseClient, profileId: string): Promise<WahlEintrag[]> {
  const { data, error } = await admin
    .from("lohn_zustellung_wahl")
    .select("id, wahl, version, gewaehlt_at, quelle, akteur_name, notiz")
    .eq("profile_id", profileId)
    .order("gewaehlt_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(`Zustell-Wahl konnte nicht geladen werden: ${error.message}`);
  return (data ?? []) as WahlEintrag[];
}

/** Wahl speichern (neuer Historien-Eintrag + Einwilligung in profiles). Wirft bei Fehlern. */
export async function speichereWahl(
  admin: SupabaseClient,
  w: { profileId: string; wahl: ZustellWahl; quelle: Exclude<ZustellQuelle, "uebernommen">; akteurId: string | null; akteurName: string | null; notiz?: string | null },
): Promise<void> {
  const jetzt = new Date().toISOString();
  const { error } = await admin.from("lohn_zustellung_wahl").insert({
    profile_id: w.profileId,
    wahl: w.wahl,
    version: w.wahl === "digital" ? DIGITAL_EINWILLIGUNG_VERSION : null,
    gewaehlt_at: jetzt,
    quelle: w.quelle,
    akteur_id: w.akteurId,
    akteur_name: w.akteurName,
    notiz: w.notiz?.trim() || null,
  });
  if (error) throw new Error(`Wahl konnte nicht gespeichert werden: ${error.message}`);
  const { error: pErr } = await admin
    .from("profiles")
    .update(
      w.wahl === "digital"
        ? { lohndokumente_digital_accepted_at: jetzt, lohndokumente_digital_accepted_version: DIGITAL_EINWILLIGUNG_VERSION }
        : { lohndokumente_digital_accepted_at: null, lohndokumente_digital_accepted_version: null },
    )
    .eq("id", w.profileId);
  if (pErr) throw new Error(`Einwilligung konnte nicht gespeichert werden: ${pErr.message}`);
}

/** Kanäle des Nachweises: app | push | mail. */
export function kanaeleAus(z: { in_app: string[]; push: string[]; email: string[] }, profileId: string): string[] {
  const out: string[] = [];
  if (z.in_app.includes(profileId)) out.push("app");
  if (z.push.includes(profileId)) out.push("push");
  if (z.email.includes(profileId)) out.push("mail");
  return out;
}

export async function meldeNeueAbrechnung(admin: SupabaseClient, a: NeueAbrechnung): Promise<void> {
  try {
    let wahl: ZustellWahl | null = null;
    try {
      wahl = (await ladeAktuelleWahl(admin, a.profileId))?.wahl ?? null;
    } catch (e) {
      logError("lohn.zustellung.wahl", e, { profileId: a.profileId });
    }
    // Eine Korrekturfassung behält die wage_documents-Zeile (neue Fassung,
    // neue PDF) — der Nachweis gilt dann für die NEUE Fassung: zurücksetzen.
    const { error } = await admin
      .from("lohn_dokument_zustellung")
      .upsert(
        {
          wage_document_id: a.wageDocumentId,
          profile_id: a.profileId,
          bereitgestellt_at: new Date().toISOString(),
          wahl,
          benachrichtigt_at: null,
          benachrichtigt_kanaele: null,
          erstmals_geoeffnet_at: null,
          zuletzt_geoeffnet_at: null,
          anzahl_geoeffnet: 0,
          ausgedruckt_at: null,
          ausgedruckt_von_name: null,
        },
        { onConflict: "wage_document_id" },
      );
    if (error) {
      logError("lohn.zustellung.bereitgestellt", error, { wageDocumentId: a.wageDocumentId });
      return;
    }

    // Ausgetretene (inaktive) Personen werden nicht benachrichtigt — sie
    // kommen nicht mehr in die App; die Lohnverwaltung sieht «nicht benachrichtigt».
    const { data: p, error: pErr } = await admin.from("profiles").select("is_active").eq("id", a.profileId).maybeSingle();
    if (pErr) {
      logError("lohn.zustellung.profil", pErr, { profileId: a.profileId });
      return;
    }
    if (p?.is_active !== true) return;

    const zugestellt = await notifyLohnDokument(admin, {
      userId: a.profileId,
      wageDocumentId: a.wageDocumentId,
      monatLabel: monatLabel({ jahr: a.jahr, monat: a.monat }),
      korrektur: a.art === "korrektur",
      papier: wahl !== "digital",
    });
    const kanaele = kanaeleAus(zugestellt, a.profileId);
    if (kanaele.length === 0) return; // alle Kanäle aus oder nichts angekommen → nicht «benachrichtigt»
    const { error: uErr } = await admin
      .from("lohn_dokument_zustellung")
      .update({ benachrichtigt_at: new Date().toISOString(), benachrichtigt_kanaele: kanaele })
      .eq("wage_document_id", a.wageDocumentId);
    if (uErr) logError("lohn.zustellung.benachrichtigt", uErr, { wageDocumentId: a.wageDocumentId });
  } catch (e) {
    logError("lohn.zustellung", e, { profileId: a.profileId, wageDocumentId: a.wageDocumentId });
  }
}

/** Person öffnet ihr eigenes Dokument (nie für Admins/«Ansicht als» aufrufen). Wirft nie. */
export async function zaehleGeoeffnet(admin: SupabaseClient, wageDocumentId: string, profileId: string): Promise<void> {
  const { error } = await admin.rpc("lohn_dokument_geoeffnet", { p_wage_document_id: wageDocumentId, p_profile_id: profileId });
  if (error) logError("lohn.zustellung.geoeffnet", error, { wageDocumentId });
}
