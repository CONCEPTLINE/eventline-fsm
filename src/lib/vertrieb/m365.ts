import "server-only";

/**
 * Vertrieb: Zugang zu Leos Microsoft-365-Postfach (Microsoft Graph).
 * Eine Stelle für Client, Recht (Scope), Token-Erneuerung und Graph-Abrufe —
 * genutzt vom Abgleich (mail-sync-lauf.ts) und vom Anzeigen der Antworten
 * (/api/vertrieb/antworten). Client, Scope und URLs stehen in
 * m365-konstanten.json (auch vom Verbinden-Skript gelesen).
 *
 * Recht: Mail.Read — Leos bewusster Entscheid (29.10.2026), damit er Antworten
 * im FSM lesen kann. Mailinhalte werden nur live angezeigt bzw. im Speicher
 * ausgewertet, nie gespeichert.
 *
 * Der Refresh-Token liegt VERSCHLÜSSELT in vertrieb_m365_verbindung (nur
 * Server, token-krypto.ts). Verbinden: node scripts/vertrieb-postfach-verbinden.mjs.
 * Microsoft gibt bei jeder Erneuerung einen neuen zurück — der wird
 * verschlüsselt gespeichert; ein alter unverschlüsselter Token ebenso.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { entschluessele, verschluessele } from "@/lib/vertrieb/token-krypto";
import KONSTANTEN from "@/lib/vertrieb/m365-konstanten.json";

export const M365_SCOPE = KONSTANTEN.scope;
export const GRAPH = "https://graph.microsoft.com/v1.0";

type Admin = ReturnType<typeof createAdminClient>;

/** Fehler, den die Oberfläche als Klartext zeigen darf (kein Token-Inhalt). */
export class PostfachFehler extends Error {
  constructor(message: string, readonly code: "nicht_verbunden" | "anmeldung" | "graph") {
    super(message);
    this.name = "PostfachFehler";
  }
}

/** Access-Token im Speicher der Server-Instanz (ca. 60 Min. gültig) — nicht
 *  bei jedem Aufruf neu erneuern (Audit, NIEDRIG 9). */
let zwischenspeicher: { token: string; bis: number } | null = null;

/** Gültiges Access-Token aus dem gespeicherten Refresh-Token. */
export async function holeAccessToken(admin: Admin): Promise<string> {
  if (zwischenspeicher && zwischenspeicher.bis > Date.now() + 60_000) return zwischenspeicher.token;

  const { data, error } = await admin
    .from("vertrieb_m365_verbindung")
    .select("refresh_token")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    logError("vertrieb-m365", error, { schritt: "verbindung lesen" });
    throw new PostfachFehler("Verbindung zum Postfach nicht lesbar", "graph");
  }
  const gespeichert = data?.refresh_token as string | undefined;
  if (!gespeichert) throw new PostfachFehler("Postfach nicht verbunden", "nicht_verbunden");

  let refreshToken: string;
  let warVerschluesselt: boolean;
  try {
    ({ klar: refreshToken, warVerschluesselt } = entschluessele(gespeichert));
  } catch {
    throw new PostfachFehler("Gespeicherter Postfach-Schlüssel nicht lesbar — Postfach neu verbinden", "anmeldung");
  }

  const res = await fetch(KONSTANTEN.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: KONSTANTEN.clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: M365_SCOPE,
    }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    // Nur Code + erste Zeile der Beschreibung — nie Token-Werte.
    const grund = json.error_description?.split(/\r?\n/)[0] ?? `HTTP ${res.status}`;
    throw new PostfachFehler(`Anmeldung bei Microsoft fehlgeschlagen (${json.error ?? res.status}): ${grund}`, "anmeldung");
  }
  const neu = json.refresh_token ?? refreshToken;
  if (neu !== refreshToken || !warVerschluesselt) {
    const { error: uErr } = await admin
      .from("vertrieb_m365_verbindung")
      .update({ refresh_token: verschluessele(neu), aktualisiert_am: new Date().toISOString() })
      .eq("id", 1);
    if (uErr) logError("vertrieb-m365", uErr, { schritt: "refresh_token speichern" });
  }
  zwischenspeicher = { token: json.access_token, bis: Date.now() + (json.expires_in ?? 3600) * 1000 };
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
  if (res.status === 401) zwischenspeicher = null;
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new PostfachFehler(`Postfach nicht lesbar (${j?.error?.code ?? res.status}): ${j?.error?.message ?? ""}`.trim(), "graph");
  }
  return (await res.json()) as T;
}

/** Alle Seiten einer Graph-Liste (höchstens maxSeiten). `gekuerzt` = es
 *  gäbe noch mehr — der Aufrufer muss das melden, nie still übergehen. */
export async function graphSeiten<T>(
  accessToken: string,
  startUrl: string,
  maxSeiten = 100,
  headers: Record<string, string> = {},
): Promise<{ werte: T[]; gekuerzt: boolean }> {
  const werte: T[] = [];
  let url: string | null = startUrl;
  for (let seite = 0; url && seite < maxSeiten; seite++) {
    const json: { value?: T[]; "@odata.nextLink"?: string } | null =
      await graphGet<{ value?: T[]; "@odata.nextLink"?: string }>(accessToken, url, headers);
    werte.push(...(json?.value ?? []));
    url = json?.["@odata.nextLink"] ?? null;
  }
  return { werte, gekuerzt: url !== null };
}

/** OData-Zeitliteral ohne Millisekunden: 2026-11-01T08:00:00Z */
export const odataZeit = (iso: string) => new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");

/** OData-Zeichenkette: einfache Anführungszeichen verdoppeln. */
export const odataText = (s: string) => `'${s.replace(/'/g, "''")}'`;
