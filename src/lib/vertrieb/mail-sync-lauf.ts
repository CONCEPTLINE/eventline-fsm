import "server-only";

/**
 * Vertrieb › Kampagnen: ein Abgleich-Lauf mit Leos Microsoft-365-Postfach.
 * Aufrufer: Cron /api/cron/vertrieb-mail-sync (alle 15 Min.) und der Knopf
 * «Jetzt abgleichen» (/api/vertrieb/mail-sync). Zuordnung: mail-sync.ts.
 *
 * Ablauf: Access-Token über m365.ts → «Gesendet» und Posteingang lesen
 * (Betreff/Adressen/Zeit/Konversation/ID) → nur bei Unzustellbarkeits-
 * Meldungen zusätzlich deren Text, um den ursprünglichen Empfänger zu finden
 * (nur im Speicher, nie gespeichert) → alle Änderungen in EINEM Aufruf
 * schreiben (vertrieb_abgleich_speichern, Migration 366).
 * Fehler crashen nie: letzter_sync_fehler wird gesetzt, Ergebnis ok:false.
 * Wird die Seitenzahl-Grenze erreicht, wird das gemeldet (nie still).
 *
 * Status-Änderungen schreibt die DB nur, wenn der Status noch derselbe ist
 * und kein Mensch ihn gesetzt hat (status_manuell = false) — so überholt der
 * Abgleich nie eine Eingabe, die während des Laufs kam.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { GRAPH, graphGet, graphSeiten, holeAccessToken, odataZeit } from "@/lib/vertrieb/m365";
import { antwortText } from "@/lib/vertrieb/antwort-text";
import {
  berechneAbgleich,
  eingangFenster,
  gesendetFenster,
  istBounce,
  ndrAdressen,
  type EingangsMail,
  type GesendeteMail,
  type SyncKontakt,
} from "@/lib/vertrieb/mail-sync";

/** Höchstens so viele Seiten à 100 Mails je Ordner und Lauf. */
const MAX_SEITEN = 100;
/** Höchstens so viele Unzustellbarkeits-Meldungen je Lauf im Text lesen. */
const MAX_NDR = 50;
/** Ein hängengebliebener Lauf gibt die Sperre nach 5 Min. frei. */
const SPERRE_MS = 5 * 60 * 1000;

export interface MailSyncErgebnis {
  ok: boolean;
  fehler?: string;
  /** Lauf übersprungen (nicht verbunden / läuft schon) — kein Fehler. */
  uebersprungen?: string;
  /** Lauf ging durch, aber nicht vollständig (z. B. Seitengrenze). */
  hinweis?: string;
  gesendet?: number;
  antworten?: number;
  unzustellbar?: number;
}

export type DbKontakt = SyncKontakt & { mail_geplant_am: string | null };

const KONTAKT_SPALTEN =
  "id, status, status_manuell, email, mail_an, mail_betreff, mail_geplant_am, mail_gesendet_am, mail_conversation_id, graph_message_id, letzte_antwort_am, letzte_antwort_betreff, antworten_anzahl, antwort_graph_ids";

export async function fuehreMailSyncAus(): Promise<MailSyncErgebnis> {
  const admin = createAdminClient();

  const { data: verbindung, error: vErr } = await admin
    .from("vertrieb_m365_verbindung")
    .select("refresh_token, letzter_sync_am")
    .eq("id", 1)
    .maybeSingle();
  if (vErr) {
    logError("vertrieb-mail-sync", vErr);
    return { ok: false, fehler: "Verbindung nicht lesbar" };
  }
  if (!verbindung?.refresh_token) return { ok: false, uebersprungen: "Postfach nicht verbunden" };

  // Sperre: nur ein Lauf gleichzeitig (Cron + Knopf).
  const jetzt = new Date();
  const { data: gesperrt, error: sErr } = await admin
    .from("vertrieb_m365_verbindung")
    .update({ sync_gestartet_am: jetzt.toISOString() })
    .eq("id", 1)
    .or(`sync_gestartet_am.is.null,sync_gestartet_am.lt.${new Date(jetzt.getTime() - SPERRE_MS).toISOString()}`)
    .select("id");
  if (sErr) {
    logError("vertrieb-mail-sync", sErr, { schritt: "sperre" });
    return { ok: false, fehler: "Abgleich konnte nicht starten (Sperre)" };
  }
  if (!gesperrt?.length) return { ok: false, uebersprungen: "Abgleich läuft bereits" };

  try {
    const accessToken = await holeAccessToken(admin);
    const kontakte = await ladeKontakte(admin);
    const gekuerzt: string[] = [];

    const gesendetAb = gesendetFenster(kontakte);
    const gesendet = gesendetAb ? await leseGesendet(accessToken, gesendetAb, gekuerzt) : [];

    // Erst Versand erkennen — neu Gesendetes erweitert das Eingangsfenster.
    const neuGesendet = berechneAbgleich(kontakte, gesendet, [])
      .map((a) => a.felder.mail_gesendet_am)
      .filter((x): x is string => !!x);
    const eingangAb = eingangFenster(kontakte, verbindung.letzter_sync_am, neuGesendet);
    const eingang = eingangAb ? await leseEingang(accessToken, eingangAb, gekuerzt) : [];

    const aenderungen = berechneAbgleich(kontakte, gesendet, eingang);
    if (aenderungen.length) {
      const { error } = await admin.rpc("vertrieb_abgleich_speichern", {
        p_aenderungen: aenderungen.map((a) => ({
          id: a.id,
          felder: a.felder,
          ...(a.status ? { status_von: a.status.von, status_nach: a.status.nach } : {}),
        })),
      });
      if (error) throw new Error(`Speichern fehlgeschlagen: ${error.message}`);
    }
    const ergebnis = {
      gesendet: aenderungen.filter((a) => a.felder.mail_gesendet_am).length,
      antworten: aenderungen.filter((a) => a.felder.antworten_anzahl).length,
      unzustellbar: aenderungen.filter((a) => a.status?.nach === "unzustellbar").length,
    };

    const hinweis = gekuerzt.length
      ? `Abgleich unvollständig: zu viele Mails in ${gekuerzt.join(" und ")} (mehr als ${MAX_SEITEN * 100})`
      : null;
    if (hinweis) logError("vertrieb-mail-sync", hinweis);
    const { error: abschlussErr } = await admin
      .from("vertrieb_m365_verbindung")
      .update({ letzter_sync_am: new Date().toISOString(), letzter_sync_fehler: hinweis, sync_gestartet_am: null })
      .eq("id", 1);
    if (abschlussErr) logError("vertrieb-mail-sync", abschlussErr, { schritt: "abschluss" });
    return { ok: true, ...ergebnis, ...(hinweis ? { hinweis } : {}) };
  } catch (e) {
    const fehler = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    logError("vertrieb-mail-sync", e);
    const { error: fErr } = await admin
      .from("vertrieb_m365_verbindung")
      .update({ letzter_sync_fehler: fehler, sync_gestartet_am: null })
      .eq("id", 1);
    if (fErr) logError("vertrieb-mail-sync", fErr, { schritt: "fehler speichern" });
    return { ok: false, fehler };
  }
}

/** Alle Kontakte aktiver Kampagnen — Keyset über id (nie Offset). */
export async function ladeKontakte(admin: ReturnType<typeof createAdminClient>): Promise<DbKontakt[]> {
  const { data: kampagnen, error: kErr } = await admin.from("vertrieb_kampagnen").select("id").eq("aktiv", true);
  if (kErr) throw new Error(`Kampagnen nicht lesbar: ${kErr.message}`);
  const ids = (kampagnen ?? []).map((k) => k.id as string);
  if (ids.length === 0) return [];
  const alle: DbKontakt[] = [];
  let nach: string | null = null;
  for (;;) {
    let q = admin.from("vertrieb_kampagne_kontakte").select(KONTAKT_SPALTEN).in("kampagne_id", ids).order("id").limit(1000);
    if (nach) q = q.gt("id", nach);
    const { data, error } = await q;
    if (error) throw new Error(`Kontakte nicht lesbar: ${error.message}`);
    const rows = (data ?? []) as DbKontakt[];
    alle.push(...rows);
    if (rows.length < 1000) return alle;
    nach = rows[rows.length - 1].id;
  }
}

type GraphAdresse = { emailAddress?: { address?: string } };
type GraphBody = { contentType?: string; content?: string };

async function leseGesendet(accessToken: string, ab: string, gekuerzt: string[]): Promise<GesendeteMail[]> {
  const filter = encodeURIComponent(`sentDateTime ge ${odataZeit(ab)}`);
  const { werte, gekuerzt: zuViel } = await graphSeiten<{
    id?: string; conversationId?: string; subject?: string; toRecipients?: GraphAdresse[]; sentDateTime?: string;
  }>(
    accessToken,
    `${GRAPH}/me/mailFolders/sentitems/messages?$select=id,conversationId,subject,toRecipients,sentDateTime&$filter=${filter}&$orderby=sentDateTime asc&$top=100`,
    MAX_SEITEN,
  );
  if (zuViel) gekuerzt.push("«Gesendet»");
  return werte
    .filter((m) => m.sentDateTime)
    .map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      betreff: m.subject ?? "",
      an: (m.toRecipients ?? []).map((r) => r.emailAddress?.address ?? "").filter(Boolean),
      gesendetAm: m.sentDateTime!,
    }));
}

async function leseEingang(accessToken: string, ab: string, gekuerzt: string[]): Promise<EingangsMail[]> {
  const filter = encodeURIComponent(`receivedDateTime ge ${odataZeit(ab)}`);
  const { werte, gekuerzt: zuViel } = await graphSeiten<{
    id?: string; conversationId?: string; subject?: string; from?: GraphAdresse; receivedDateTime?: string;
  }>(
    accessToken,
    `${GRAPH}/me/mailFolders/inbox/messages?$select=id,conversationId,subject,from,receivedDateTime&$filter=${filter}&$orderby=receivedDateTime asc&$top=100`,
    MAX_SEITEN,
  );
  if (zuViel) gekuerzt.push("Posteingang");
  const mails: EingangsMail[] = werte
    .filter((m) => m.receivedDateTime && m.from?.emailAddress?.address)
    .map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      betreff: m.subject ?? "",
      von: m.from!.emailAddress!.address!,
      empfangenAm: m.receivedDateTime!,
    }));

  // Unzustellbarkeits-Meldungen: ursprünglichen Empfänger aus dem Text lesen
  // (nur im Speicher). Neueste zuerst, höchstens MAX_NDR je Lauf.
  const bounces = mails.filter((m) => m.id && istBounce(m)).slice(-MAX_NDR);
  for (const m of bounces) {
    try {
      const voll = await graphGet<{ body?: GraphBody }>(
        accessToken,
        `${GRAPH}/me/messages/${encodeURIComponent(m.id!)}?$select=body`,
        { Prefer: 'outlook.body-content-type="text"' },
      );
      m.ndrEmpfaenger = ndrAdressen(antwortText(null, voll?.body));
    } catch (e) {
      logError("vertrieb-mail-sync", e, { schritt: "ndr lesen" });
    }
  }
  return mails;
}
