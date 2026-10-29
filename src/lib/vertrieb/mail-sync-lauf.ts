import "server-only";

/**
 * Vertrieb › Kampagnen: ein Abgleich-Lauf mit Leos Microsoft-365-Postfach.
 * Aufrufer: Cron /api/cron/vertrieb-mail-sync (alle 15 Min.) und der Knopf
 * «Jetzt abgleichen» (/api/vertrieb/mail-sync). Zuordnung: mail-sync.ts.
 *
 * Ablauf: Access-Token über m365.ts → «Gesendet» und Posteingang lesen
 * (nur Betreff/Adressen/Zeit/ID, nie Text) → Änderungen schreiben.
 * Fehler crashen nie: letzter_sync_fehler wird gesetzt, Ergebnis ok:false.
 *
 * Status-Änderungen werden nur geschrieben, wenn der Status in der DB noch
 * derselbe ist und kein Mensch ihn gesetzt hat (status_manuell = false) —
 * so überholt der Abgleich nie eine Eingabe, die während des Laufs kam.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { GRAPH, graphSeiten, holeAccessToken, odataZeit } from "@/lib/vertrieb/m365";
import {
  berechneAbgleich,
  eingangFenster,
  gesendetFenster,
  type EingangsMail,
  type GesendeteMail,
  type SyncKontakt,
} from "@/lib/vertrieb/mail-sync";

/** Höchstens so viele Seiten à 100 Mails je Ordner und Lauf. */
const MAX_SEITEN = 100;
/** Ein hängengebliebener Lauf gibt die Sperre nach 5 Min. frei. */
const SPERRE_MS = 5 * 60 * 1000;

export interface MailSyncErgebnis {
  ok: boolean;
  fehler?: string;
  /** Lauf übersprungen (nicht verbunden / läuft schon) — kein Fehler. */
  uebersprungen?: string;
  gesendet?: number;
  antworten?: number;
  unzustellbar?: number;
}

export type DbKontakt = SyncKontakt & { mail_geplant_am: string | null };

const KONTAKT_SPALTEN =
  "id, status, status_manuell, email, mail_an, mail_betreff, mail_geplant_am, mail_gesendet_am, letzte_antwort_am, letzte_antwort_betreff, letzte_antwort_graph_id, antworten_anzahl";

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
  const { data: gesperrt } = await admin
    .from("vertrieb_m365_verbindung")
    .update({ sync_gestartet_am: jetzt.toISOString() })
    .eq("id", 1)
    .or(`sync_gestartet_am.is.null,sync_gestartet_am.lt.${new Date(jetzt.getTime() - SPERRE_MS).toISOString()}`)
    .select("id");
  if (!gesperrt?.length) return { ok: false, uebersprungen: "Abgleich läuft bereits" };

  try {
    const accessToken = await holeAccessToken(admin);
    const kontakte = await ladeKontakte(admin);

    const gesendetAb = gesendetFenster(kontakte);
    const gesendet = gesendetAb ? await leseGesendet(accessToken, gesendetAb) : [];

    // Erst Versand erkennen — neu Gesendetes erweitert das Eingangsfenster.
    const neuGesendet = berechneAbgleich(kontakte, gesendet, [])
      .map((a) => a.felder.mail_gesendet_am)
      .filter((x): x is string => !!x);
    const eingangAb = eingangFenster(kontakte, verbindung.letzter_sync_am, neuGesendet);
    const eingang = eingangAb ? await leseEingang(accessToken, eingangAb) : [];

    const aenderungen = berechneAbgleich(kontakte, gesendet, eingang);
    const ergebnis = { gesendet: 0, antworten: 0, unzustellbar: 0 };
    for (const a of aenderungen) {
      if (Object.keys(a.felder).length) {
        const { error } = await admin.from("vertrieb_kampagne_kontakte").update(a.felder).eq("id", a.id);
        if (error) throw new Error(`Speichern fehlgeschlagen: ${error.message}`);
        if (a.felder.mail_gesendet_am) ergebnis.gesendet++;
        if (a.felder.antworten_anzahl) ergebnis.antworten++;
      }
      if (a.status) {
        const { error } = await admin
          .from("vertrieb_kampagne_kontakte")
          .update({ status: a.status.nach })
          .eq("id", a.id)
          .eq("status", a.status.von)
          .eq("status_manuell", false);
        if (error) throw new Error(`Speichern fehlgeschlagen: ${error.message}`);
        if (a.status.nach === "unzustellbar") ergebnis.unzustellbar++;
      }
    }

    await admin
      .from("vertrieb_m365_verbindung")
      .update({ letzter_sync_am: new Date().toISOString(), letzter_sync_fehler: null, sync_gestartet_am: null })
      .eq("id", 1);
    return { ok: true, ...ergebnis };
  } catch (e) {
    const fehler = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    logError("vertrieb-mail-sync", e);
    await admin
      .from("vertrieb_m365_verbindung")
      .update({ letzter_sync_fehler: fehler, sync_gestartet_am: null })
      .eq("id", 1);
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

async function leseGesendet(accessToken: string, ab: string): Promise<GesendeteMail[]> {
  const filter = encodeURIComponent(`sentDateTime ge ${odataZeit(ab)}`);
  const rows = await graphSeiten<{ subject?: string; toRecipients?: GraphAdresse[]; sentDateTime?: string }>(
    accessToken,
    `${GRAPH}/me/mailFolders/sentitems/messages?$select=subject,toRecipients,sentDateTime&$filter=${filter}&$top=100`,
    MAX_SEITEN,
  );
  return rows
    .filter((m) => m.sentDateTime)
    .map((m) => ({
      betreff: m.subject ?? "",
      an: (m.toRecipients ?? []).map((r) => r.emailAddress?.address ?? "").filter(Boolean),
      gesendetAm: m.sentDateTime!,
    }));
}

async function leseEingang(accessToken: string, ab: string): Promise<EingangsMail[]> {
  const filter = encodeURIComponent(`receivedDateTime ge ${odataZeit(ab)}`);
  const rows = await graphSeiten<{ id?: string; subject?: string; from?: GraphAdresse; receivedDateTime?: string }>(
    accessToken,
    `${GRAPH}/me/mailFolders/inbox/messages?$select=id,subject,from,receivedDateTime&$filter=${filter}&$top=100`,
    MAX_SEITEN,
  );
  return rows
    .filter((m) => m.receivedDateTime && m.from?.emailAddress?.address)
    .map((m) => ({ id: m.id, betreff: m.subject ?? "", von: m.from!.emailAddress!.address!, empfangenAm: m.receivedDateTime! }));
}
