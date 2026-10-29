import "server-only";

/**
 * Vertrieb: Zugang zu Leos Microsoft-365-Postfach (Microsoft Graph).
 * Eine Stelle für Client, Recht (Scope), Token-Erneuerung und Graph-Abrufe —
 * genutzt vom Abgleich (mail-sync-lauf.ts) und vom Anzeigen der Antworten
 * (/api/vertrieb/antworten).
 *
 * Der Refresh-Token liegt in vertrieb_m365_verbindung (nur Server). Microsoft
 * gibt bei jeder Erneuerung einen neuen zurück — der wird gespeichert.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";

const TOKEN_URL = "https://login.microsoftonline.com/organizations/oauth2/v2.0/token";
const CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
/** Recht auf das Postfach: Mail.Read (Betreff/Adressen/Zeit UND Text, damit
 *  das Detail die Antwort zeigen kann). Gespeichert wird nie ein Mailtext. */
export const M365_SCOPE = "Mail.Read offline_access";
export const GRAPH = "https://graph.microsoft.com/v1.0";

type Admin = ReturnType<typeof createAdminClient>;

/** Fehler, den die Oberfläche als Klartext zeigen darf (kein Token-Inhalt). */
export class PostfachFehler extends Error {
  constructor(message: string, readonly code: "nicht_verbunden" | "anmeldung" | "graph") {
    super(message);
    this.name = "PostfachFehler";
  }
}

/** Gültiges Access-Token aus dem gespeicherten Refresh-Token. */
export async function holeAccessToken(admin: Admin): Promise<string> {
  const { data, error } = await admin
    .from("vertrieb_m365_verbindung")
    .select("refresh_token")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new PostfachFehler("Verbindung zum Postfach nicht lesbar", "graph");
  const refreshToken = data?.refresh_token as string | undefined;
  if (!refreshToken) throw new PostfachFehler("Postfach nicht verbunden", "nicht_verbunden");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: M365_SCOPE,
    }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    // Nur Code + erste Zeile der Beschreibung — nie Token-Werte.
    const grund = json.error_description?.split(/\r?\n/)[0] ?? `HTTP ${res.status}`;
    throw new PostfachFehler(`Anmeldung bei Microsoft fehlgeschlagen (${json.error ?? res.status}): ${grund}`, "anmeldung");
  }
  if (json.refresh_token && json.refresh_token !== refreshToken) {
    const { error: uErr } = await admin
      .from("vertrieb_m365_verbindung")
      .update({ refresh_token: json.refresh_token, aktualisiert_am: new Date().toISOString() })
      .eq("id", 1);
    if (uErr) logError("vertrieb-m365", uErr, { schritt: "refresh_token speichern" });
  }
  return json.access_token;
}

/** GET auf Graph mit einfacher Wiederholung bei 429/503. 404 → null. */
export async function graphGet<T>(
  accessToken: string,
  url: string,
  headers: Record<string, string> = {},
  versuch = 0,
): Promise<T | null> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, ...headers }, cache: "no-store" });
  if ((res.status === 429 || res.status === 503) && versuch < 2) {
    const warten = Math.min(Number(res.headers.get("retry-after")) || 2, 10);
    await new Promise((r) => setTimeout(r, warten * 1000));
    return graphGet<T>(accessToken, url, headers, versuch + 1);
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new PostfachFehler(`Postfach nicht lesbar (${j?.error?.code ?? res.status}): ${j?.error?.message ?? ""}`.trim(), "graph");
  }
  return (await res.json()) as T;
}

/** Alle Seiten einer Graph-Liste (höchstens maxSeiten). */
export async function graphSeiten<T>(accessToken: string, startUrl: string, maxSeiten = 100, headers: Record<string, string> = {}): Promise<T[]> {
  const alle: T[] = [];
  let url: string | null = startUrl;
  for (let seite = 0; url && seite < maxSeiten; seite++) {
    const json: { value?: T[]; "@odata.nextLink"?: string } | null =
      await graphGet<{ value?: T[]; "@odata.nextLink"?: string }>(accessToken, url, headers);
    alle.push(...(json?.value ?? []));
    url = json?.["@odata.nextLink"] ?? null;
  }
  return alle;
}

/** OData-Zeitliteral ohne Millisekunden: 2026-11-01T08:00:00Z */
export const odataZeit = (iso: string) => new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");

/** OData-Zeichenkette: einfache Anführungszeichen verdoppeln. */
export const odataText = (s: string) => `'${s.replace(/'/g, "''")}'`;
