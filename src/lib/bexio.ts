// Bexio-OAuth + API-Client.
//
// Singleton-Verbindung: Eine Reihe in public.bexio_connection (id=1) hält Access-
// und Refresh-Token des gemeinsamen Firma-Accounts. Alle Mitarbeiter pushen Kontakte
// ueber diesen geteilten Token — wer ihn faktisch erstellt hat, ist im Bexio-
// Audit-Log zu sehen.
//
// Wichtig: Tokens NIE an den Client schicken. Frontend ruft API-Routes auf, die
// hier die Token-Verwaltung serverseitig kapseln.

import { createAdminClient } from "@/lib/supabase/admin";
import { logWarn } from "@/lib/log";

// Bexio hat den IdP von idp.bexio.com auf auth.bexio.com migriert. Beim
// Verbinden auf den alten Endpunkten gibt's 404 — auth.bexio.com ist der
// aktuelle.
const AUTH_URL = "https://auth.bexio.com/realms/bexio/protocol/openid-connect/auth";
const TOKEN_URL = "https://auth.bexio.com/realms/bexio/protocol/openid-connect/token";
const API_BASE = "https://api.bexio.com";

// Was wir mindestens brauchen: openid (OIDC), offline_access (Refresh-Token),
// contact_show + contact_edit (Lesen + Anlegen von Kontakten),
// kb_invoice_show (Rechnungen suchen — fuer den "Rechnungsnummer -> Bexio
// oeffnen"-Link auf abgerechneten Auftraegen).
//
// Optionale Erweiterung: 'accounting' (Kontenrahmen + Buchungen, read-only)
// fuer das Budget-Soll/Ist-Feature. Wird nur bei der entsprechenden
// Connect-Flow-Variante mitgeschickt (?include=accounting), damit Bexio nicht
// die zusaetzliche Berechtigung anfragt wenn der User Budget gar nicht nutzt.
export const BASE_SCOPES = ["openid", "offline_access", "contact_show", "contact_edit", "kb_invoice_show"];
export const ACCOUNTING_SCOPE = "accounting";

/** Legacy-Alias — wird vor dem ersten Re-Auth noch vom Connect-Code referenziert.
 *  Neue Code-Pfade nutzen scopesFor(). */
export const SCOPES = BASE_SCOPES;

/** Baut die Scope-Liste fuer einen OAuth-Flow. extras erlaubt Module-Add-Ons. */
export function scopesFor(extras: { accounting?: boolean } = {}): string[] {
  const scopes = [...BASE_SCOPES];
  if (extras.accounting) scopes.push(ACCOUNTING_SCOPE);
  return scopes;
}

// Wieviele Millisekunden VOR Token-Ablauf wir refreshen — verhindert dass eine
// laufende User-Aktion mitten drin auf 401 laeuft. 60s ist der uebliche Branchen-
// Default fuer OAuth-Refresh-Buffer.
const TOKEN_REFRESH_BUFFER_MS = 60_000;

// Bexio-Country-IDs (aus deren API-Doku). Nur die fuer uns relevanten europaeischen
// Nachbarlaender — bei Bedarf erweitern. Schluessel ist der ISO-2-Code aus unserem
// customers.country-Feld.
export const BEXIO_COUNTRY_ID: Record<string, number> = {
  CH: 1,
  DE: 2,
  AT: 3,
  FR: 4,
  IT: 5,
  LI: 6,
};

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  id_token?: string;
}

interface BexioConnection {
  id: number;
  /** @deprecated Plain-text-Token. Lese Token via getStoredToken() statt
   *  diese Spalte. Wird in Cleanup-Migration entfernt. */
  access_token: string | null;
  /** @deprecated Plain-text-Token. Wird in Cleanup-Migration entfernt. */
  refresh_token: string | null;
  access_token_secret_id: string | null;
  refresh_token_secret_id: string | null;
  expires_at: string;
  scope: string | null;
  bexio_company_id: string | null;
  bexio_user_email: string | null;
  bexio_user_id: number | null;
  connected_by: string | null;
  connected_at: string;
  updated_at: string;
  feature_contacts: boolean;
  feature_accounting: boolean;
}

// ===== Vault-gestuetzte Token-Persistenz =====
//
// Tokens leben in supabase_vault (verschluesselt at-rest, separater Audit-Pfad).
// Server-Code (mit service_role) ruft die SECURITY-DEFINER-RPCs aus Migration 110.
// authenticated/anon kommen nicht ran — RPCs sind explizit auf service_role gegrantet.

async function getStoredToken(kind: "access" | "refresh"): Promise<string | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("bexio_token_get", { kind });
  if (error) {
    logWarn("bexio.vault", `bexio_token_get(${kind}) fehlgeschlagen: ${error.message}`);
    return null;
  }
  return (data as string | null) ?? null;
}

async function setStoredToken(kind: "access" | "refresh", value: string): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.rpc("bexio_token_set", { kind, new_value: value });
  if (error) {
    throw new Error(`bexio_token_set(${kind}) fehlgeschlagen: ${error.message}`);
  }
}

export function getAuthorizeUrl(state: string, extras: { accounting?: boolean } = {}): string {
  const params = new URLSearchParams({
    client_id: process.env.BEXIO_CLIENT_ID!,
    redirect_uri: process.env.BEXIO_REDIRECT_URI!,
    response_type: "code",
    scope: scopesFor(extras).join(" "),
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.BEXIO_REDIRECT_URI!,
      client_id: process.env.BEXIO_CLIENT_ID!,
      client_secret: process.env.BEXIO_CLIENT_SECRET!,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token-Exchange fehlgeschlagen (${res.status}): ${text}`);
  }
  return (await res.json()) as TokenResponse;
}

async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: process.env.BEXIO_CLIENT_ID!,
      client_secret: process.env.BEXIO_CLIENT_SECRET!,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token-Refresh fehlgeschlagen (${res.status}): ${text}`);
  }
  return (await res.json()) as TokenResponse;
}

export async function saveConnection(
  tokens: TokenResponse,
  connectedBy: string | null,
  meta: { email?: string | null; companyId?: string | null; userId?: number | null }
) {
  const supabase = createAdminClient();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const grantedScope = tokens.scope ?? BASE_SCOPES.join(" ");
  const hasAccounting = grantedScope.split(/\s+/).includes(ACCOUNTING_SCOPE);

  // Metadaten in der Tabelle, Tokens in Vault. Die plain-text-Spalten
  // access_token/refresh_token werden NICHT mehr beschrieben — sind nur
  // noch fuer Backward-Compat-Reads relevant solange die Cleanup-Migration
  // sie nicht entfernt hat.
  const { error } = await supabase.from("bexio_connection").upsert({
    id: 1,
    // Plain-Spalten leeren — neuer Wert liegt nur im Vault.
    access_token: null,
    refresh_token: null,
    expires_at: expiresAt,
    scope: grantedScope,
    bexio_user_email: meta.email ?? null,
    bexio_company_id: meta.companyId ?? null,
    bexio_user_id: meta.userId ?? null,
    connected_by: connectedBy,
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    // Modul-Flags entsprechend granted-Scopes setzen. feature_contacts ist
    // standardmaessig immer an (Base-Scopes haben es), feature_accounting
    // nur wenn der erweiterte Scope gewaehrt wurde.
    feature_contacts: true,
    feature_accounting: hasAccounting,
  });
  if (error) throw new Error(`Verbindung speichern fehlgeschlagen: ${error.message}`);

  await setStoredToken("access", tokens.access_token);
  await setStoredToken("refresh", tokens.refresh_token);
}

// Holt die numerische Bexio-User-ID des aktuell verbundenen Accounts. Wird als
// user_id + owner_id beim Kontakt-Anlegen mitgeschickt — beides Pflichtfelder.
// Cacht in der bexio_connection-Reihe; faellt zurueck auf /3.0/users/me wenn
// noch nicht hinterlegt (z.B. weil die Verbindung aus der Zeit vor dieser
// Migration stammt).
export async function getBexioUserId(): Promise<number> {
  const conn = await getConnection();
  if (!conn) throw new Error("Bexio ist nicht verbunden");
  if (conn.bexio_user_id) return conn.bexio_user_id;

  // Noch nicht gecacht -> jetzt fetchen und sichern
  const token = await getValidAccessToken();
  const res = await fetch(`${API_BASE}/3.0/users/me`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bexio-User-Info fehlgeschlagen (${res.status}): ${text}`);
  }
  const me = (await res.json()) as { id?: number };
  if (!me.id) throw new Error("Bexio /3.0/users/me lieferte keine User-ID");

  const supabase = createAdminClient();
  await supabase
    .from("bexio_connection")
    .update({ bexio_user_id: me.id, updated_at: new Date().toISOString() })
    .eq("id", 1);
  return me.id;
}

export async function getConnection(): Promise<BexioConnection | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("bexio_connection")
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  return (data as BexioConnection | null) ?? null;
}

export async function disconnect(): Promise<void> {
  const supabase = createAdminClient();
  await supabase.from("bexio_connection").delete().eq("id", 1);
}

// Holt einen aktuellen access_token. Refresht automatisch wenn weniger als 60s
// vor Ablauf — so passiert kein 401-Schluckauf mitten in einer User-Aktion.
// Tokens leben in Vault — wir lesen sie via RPC, schreiben sie via RPC.
async function getValidAccessToken(): Promise<string> {
  const conn = await getConnection();
  if (!conn) throw new Error("Bexio ist nicht verbunden — erst in Einstellungen verbinden");

  const expiresAt = new Date(conn.expires_at).getTime();
  const now = Date.now();

  if (expiresAt - now > TOKEN_REFRESH_BUFFER_MS) {
    const cached = await getStoredToken("access");
    if (!cached) throw new Error("Access-Token nicht in Vault gefunden — bitte Bexio neu verbinden");
    return cached;
  }

  const refreshToken = await getStoredToken("refresh");
  if (!refreshToken) throw new Error("Refresh-Token nicht in Vault gefunden — bitte Bexio neu verbinden");

  const fresh = await refreshTokens(refreshToken);
  const supabase = createAdminClient();
  const newExpiresAt = new Date(Date.now() + fresh.expires_in * 1000).toISOString();
  await supabase
    .from("bexio_connection")
    .update({
      expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);

  // Bexio rotiert den Refresh-Token bei jedem Refresh — neuen speichern,
  // sonst wird der alte beim naechsten Mal abgewiesen.
  await setStoredToken("access", fresh.access_token);
  if (fresh.refresh_token) {
    await setStoredToken("refresh", fresh.refresh_token);
  }
  return fresh.access_token;
}

async function bexioFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getValidAccessToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

// Bexio-Kontakt-Erstellung. contact_type_id: 1 = Firma, 2 = Privatperson.
// Pflichtfelder: name_1 (Firma-Name oder Nachname). name_2 ist Vorname (oder leer
// fuer Firmen). Adresse, Telefon, Mail sind optional.
export interface CreateContactInput {
  isCompany: boolean;
  name1: string;
  name2?: string | null;
  email?: string | null;
  phone?: string | null;
  street?: string | null;
  postcode?: string | null;
  city?: string | null;
}

export interface CreateContactResult {
  id: number;
  nr?: string;
}

export interface CreateContactInputWithCountry extends CreateContactInput {
  /** ISO-2-Code aus customers.address_country. Wird via BEXIO_COUNTRY_ID
   *  auf Bexio's numerische country_id gemappt. Default CH wenn leer. */
  countryCode?: string | null;
}

export async function createContact(input: CreateContactInputWithCountry): Promise<CreateContactResult> {
  const code = (input.countryCode || "CH").toUpperCase();
  const countryId = BEXIO_COUNTRY_ID[code] ?? BEXIO_COUNTRY_ID.CH;

  // Bexio braucht beim /2.0/contact-POST zwingend user_id + owner_id (Pflicht).
  // Beide setzen wir auf den verbundenen Bexio-User. address/postcode/city
  // werden hier NICHT gesendet — die akzeptiert das aktuelle 2.0-Schema nicht
  // ("Unexpected extra form field"). Stattdessen rufen wir nach erfolgreicher
  // Kontakt-Erstellung createContactAddress auf, um die Adresse separat
  // anzuhaengen.
  const userId = await getBexioUserId();

  const payload = {
    contact_type_id: input.isCompany ? 1 : 2,
    name_1: input.name1,
    name_2: input.name2 ?? "",
    mail: input.email ?? "",
    phone_fixed: input.phone ?? "",
    country_id: countryId,
    user_id: userId,
    owner_id: userId,
  };
  const res = await bexioFetch("/2.0/contact", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kontakt-Anlegen fehlgeschlagen (${res.status}): ${text}`);
  }
  const data = await res.json();
  return { id: data.id, nr: data.nr };
}

// Hängt eine Hauptadresse an einen frisch erstellten Bexio-Kontakt.
// /2.0/contact erlaubt keine inline-Adresse mehr — Adressen leben jetzt als
// eigene Resource pro Kontakt. address_type_id=1 = Hauptadresse.
//
// Wird nach createContact aufgerufen, schlägt aber kein Fehler zurück wenn
// fehlt — dann landet der Kontakt halt ohne Adresse in Bexio (besser als
// gar kein Kontakt).
export async function createContactAddress(
  contactId: number,
  input: { street?: string | null; postcode?: string | null; city?: string | null; countryCode?: string | null; name?: string | null },
): Promise<void> {
  const street = (input.street ?? "").trim();
  const postcode = (input.postcode ?? "").trim();
  const city = (input.city ?? "").trim();
  // Wenn überhaupt nichts da ist — sparen wir uns den API-Call.
  if (!street && !postcode && !city) return;

  const code = (input.countryCode || "CH").toUpperCase();
  const countryId = BEXIO_COUNTRY_ID[code] ?? BEXIO_COUNTRY_ID.CH;

  const payload = {
    contact_id: contactId,
    address_type_id: 1, // Hauptadresse
    name: input.name ?? "",
    subject: "",
    department: "",
    address: street,
    postcode,
    city,
    country_id: countryId,
  };
  const res = await bexioFetch("/2.0/address", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    // Loggen aber nicht throwen — Kontakt existiert bereits, Adresse manuell
    // ergaenzbar in Bexio.
    const text = await res.text();
    logWarn("bexio.address", `Adresse fuer Kontakt ${contactId} konnte nicht angelegt werden (${res.status}): ${text}`);
  }
}

// === Search-Endpoint fuer Duplikat-Erkennung (#8) ===
//
// Vor dem Anlegen pruefen ob der Kontakt schon in Bexio existiert. Heuristik:
// 1. Email exakt -> sehr starker Match
// 2. Name (case-insensitive substring) -> moeglicher Match
// Wenn Treffer, Frontend zeigt "Verknuepfen statt anlegen?"-Modal.
//
// Bexio's /2.0/contact/search erwartet JSON-Array mit Feldern + Werten +
// Operator. Doku: https://docs.bexio.com/legacy/resources/contact/

export interface BexioContactSearchResult {
  id: number;
  nr?: string;
  name_1: string;
  name_2?: string;
  mail?: string;
  contact_type_id?: number;
  postcode?: string;
  city?: string;
}

async function bexioSearch(field: string, value: string): Promise<BexioContactSearchResult[]> {
  const res = await bexioFetch("/2.0/contact/search?limit=20", {
    method: "POST",
    body: JSON.stringify([{ field, value, criteria: "like" }]),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bexio-Suche fehlgeschlagen (${res.status}): ${text}`);
  }
  return (await res.json()) as BexioContactSearchResult[];
}

/** Sucht in Bexio nach Kontakten die zur gegebenen Email/Name passen koennten.
 *  Returnt deduplizierte Liste (Email-Match first, dann Name-Match). */
export async function findMatchingContacts(opts: {
  email: string | null | undefined;
  name: string;
}): Promise<BexioContactSearchResult[]> {
  const seen = new Map<number, BexioContactSearchResult>();

  // Email zuerst — eindeutiger Match
  if (opts.email && opts.email.trim()) {
    try {
      const byEmail = await bexioSearch("mail", opts.email.trim());
      for (const c of byEmail) seen.set(c.id, c);
    } catch {
      // Wenn Email-Suche fehlschlaegt: weiter mit Name. Lieber falsch-negativ
      // als komplett blockieren.
    }
  }

  // Dann Name (kann mehr Treffer liefern, aber relevant bei fehlender Email)
  const trimmedName = opts.name.trim();
  if (trimmedName) {
    try {
      const byName = await bexioSearch("name_1", trimmedName);
      for (const c of byName) {
        if (!seen.has(c.id)) seen.set(c.id, c);
      }
    } catch {}
  }

  return Array.from(seen.values());
}

// Holt einen Bexio-Kontakt per ID. Wird genutzt um die menschenlesbare 'nr'
// (Kundennummer) bei einem schon existierenden Kontakt nachzuladen, wenn wir
// ihn ueber das Match-Modal verknuepfen statt neu anlegen.
export async function getContactById(contactId: number): Promise<BexioContactSearchResult | null> {
  const res = await bexioFetch(`/2.0/contact/${contactId}`, { method: "GET" });
  if (!res.ok) return null;
  return (await res.json()) as BexioContactSearchResult;
}

// URL zur Kontakt-Detailseite in Bexio (zum Oeffnen nach Anlegen).
export function bexioContactUrl(contactId: number): string {
  return `https://office.bexio.com/index.php/kontakt/show/id/${contactId}`;
}

// URL zur Kontakt-Liste in Bexio. /kontakt/edit/id/0 zeigt eine leere Seite,
// nicht das gehoffte "neuen Kontakt"-Formular. Stattdessen leiten wir auf die
// Liste — dort ist der "Neuer Kontakt"-Button gross sichtbar oben rechts.
// Pre-fill via URL-Parameter unterstuetzt Bexio sowieso nicht.
export const BEXIO_NEW_CONTACT_URL = "https://office.bexio.com/index.php/kontakt/list";

// === Rechnungs-Suche fuer Deep-Linking aus dem Auftrags-Archiv ===
//
// Bexio's /kb_invoice/show/id/X braucht die interne Bexio-ID, nicht die
// menschenlesbare Rechnungsnummer. Der User tippt aber nur die Nummer ein
// (z.B. "26017") — wir muessen die ID via API-Suche rausfinden.

export interface BexioInvoiceSearchResult {
  id: number;
  document_nr: string;
  title?: string;
  contact_id?: number;
  total?: string;
  is_valid_from?: string;
}

/** Sucht in Bexio nach einer Rechnung mit der gegebenen document_nr.
 *  Returnt das erste exakte Match (oder null wenn nicht gefunden / Fehler). */
export async function findInvoiceByNr(nr: string): Promise<BexioInvoiceSearchResult | null> {
  try {
    const res = await bexioFetch("/2.0/kb_invoice/search?limit=10", {
      method: "POST",
      body: JSON.stringify([{ field: "document_nr", value: nr, criteria: "=" }]),
    });
    if (!res.ok) return null;
    const list = (await res.json()) as BexioInvoiceSearchResult[];
    if (!Array.isArray(list) || list.length === 0) return null;
    // Bevorzugt exact-match (sollte mit criteria:"=" eh schon der Fall sein).
    return list.find((i) => i.document_nr === nr) ?? list[0] ?? null;
  } catch {
    return null;
  }
}

/** URL zur Rechnungs-Detailseite in Bexio. */
export function bexioInvoiceUrl(invoiceId: number): string {
  return `https://office.bexio.com/index.php/kb_invoice/show/id/${invoiceId}`;
}

/** Fallback wenn kein Direkt-Link moeglich ist (Rechnung nicht gefunden,
 *  Bexio nicht verbunden, Scope fehlt). User landet auf der Liste und
 *  kann manuell suchen. */
export const BEXIO_INVOICE_LIST_URL = "https://office.bexio.com/index.php/kb_invoice";

// =====================================================================
// === Accounting (Budget-Soll/Ist) ===
// =====================================================================
//
// Wird nur fuer das Budget-Feature genutzt. Setzt voraus dass die Bexio-
// Verbindung den 'accounting'-Scope hat (siehe feature_accounting-Flag
// auf bexio_connection und scopesFor({accounting:true})).
//
// WICHTIG (Datensparsamkeit): Wir holen Buchungen aus Bexio um sie ZU
// AGGREGIEREN, NICHT um sie zu speichern. Die einzelnen Bookings fliessen
// durch den Cron-Memory, persistent gespeichert wird ausschliesslich die
// Monats-Summe pro Konto in budget_account_snapshot. Heisst: wer in 6
// Monaten in unsere DB schaut, sieht keine Empfaenger, keine Betraege
// einzelner Rechnungen, keine Daten — nur "Konto X im Monat Y hat
// total Z CHF Bewegung gehabt".

/** Konto im Bexio-Kontenrahmen. Felder gem. Bexio's /3.0/accounts-Response.
 *  type ist ein String: 'activa', 'passiva', 'income', 'expense', 'balancing'.
 *  Fuer Budget-Soll/Ist interessieren uns 'income' + 'expense'. */
export interface BexioAccount {
  id: number;
  account_no: string;
  name: string;
  type?: "activa" | "passiva" | "income" | "expense" | "balancing" | string;
  is_active?: boolean;
  account_group_id?: number;
}

/** Listet alle Konten des verbundenen Bexio-Mandanten. Bexio liefert default
 *  300 pro Page — wir muessen ggf. paginieren. Der Kontenrahmen hat realistisch
 *  100-500 Eintraege, daher reicht ein Single-Call mit limit=2000. */
export async function listAccounts(): Promise<BexioAccount[]> {
  const res = await bexioFetch("/3.0/accounts?limit=2000");
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bexio-Konten laden fehlgeschlagen (${res.status}): ${text}`);
  }
  return (await res.json()) as BexioAccount[];
}

/** Buchungs-Zeile wie sie aus Bexio's Accounting-Journal kommt. Felder
 *  gem. /3.0/accounting_journal — wir lesen NUR die Felder die fuer die
 *  Aggregation noetig sind, nichts personenbezogenes. */
export interface BexioJournalEntry {
  /** ISO-Datum der Buchung. */
  date: string;
  /** Sollkonto-Nummer (text, z.B. "5000"). Bexio liefert teilweise nur die
   *  account_id — wir mappen das auf account_no via listAccounts(). */
  debit_account_id?: number;
  credit_account_id?: number;
  amount: number;
}

/** Aggregations-Ergebnis: Map(account_no -> Map(year-month -> {sum, count})).
 *  Genau das was in budget_account_snapshot gehoert. */
export type MonthlyAccountAggregate = Map<string, Map<string, { sum_chf: number; booking_count: number }>>;

/** Synchronisiert Bexio-Konten als budget_categories.
 *
 *  Strategie:
 *    1. Aktive Aufwand+Ertrags-Konten (account_type 3+4) ziehen.
 *    2. Top-Level-Gruppen via Praefix der account_no anlegen falls fehlen
 *       (Personalaufwand 5xxx, Sachaufwand 6xxx, ...). Predefined Mapping
 *       gem. Schweizer KMU-Kontenrahmen.
 *    3. Pro Konto: budget_categories-Zeile upserten (UNIQUE bexio_account_no).
 *    4. auto_source 'internal_labor' auf der Personalaufwand-Gruppe sicherstellen
 *       — dort lebt die Auto-Lohn-Berechnung (Stempel x Vollkosten).
 *
 *  Idempotent: mehrfach aufrufbar, anpassende Aenderungen werden upserted.
 *  Wird vom Cron + dem manuellen "Synchronisieren"-Button getriggert. */
export interface SyncBudgetCategoriesResult {
  groups_ensured: number;
  accounts_imported: number;
  accounts_skipped: number;
}

// Aufwand- + Ertragskonten: Budget vergleicht Ausgaben gegen Umsatz, daher
// brauchen wir auch die 3xxx-Ertraege (Auftragskonten / Service-Umsatz).
const KMU_TOP_LEVEL_GROUPS: Record<string, { name: string; sort_order: number; auto_source: string | null }> = {
  "3": { name: "Ertrag (3xxx)",              sort_order: 30, auto_source: null },
  "4": { name: "Materialaufwand (4xxx)",     sort_order: 40, auto_source: null },
  "5": { name: "Personalaufwand (5xxx)",     sort_order: 50, auto_source: "internal_labor" },
  "6": { name: "Sachaufwand (6xxx)",         sort_order: 60, auto_source: null },
  "7": { name: "Nebenerfolg (7xxx)",         sort_order: 70, auto_source: null },
  "8": { name: "Ausserordentlich (8xxx)",    sort_order: 80, auto_source: null },
};

export async function syncBexioAccountsToBudgetCategories(): Promise<SyncBudgetCategoriesResult> {
  const supabase = createAdminClient();
  const accounts = await listAccounts();

  // 1. Top-Level-Gruppen idempotent sicherstellen.
  const groupIdByDigit: Record<string, string> = {};
  let groupsEnsured = 0;
  for (const [digit, def] of Object.entries(KMU_TOP_LEVEL_GROUPS)) {
    const { data: existing } = await supabase
      .from("budget_categories")
      .select("id, auto_source, archived_at")
      .eq("name", def.name)
      .is("parent_id", null)
      .maybeSingle();

    if (existing) {
      groupIdByDigit[digit] = existing.id as string;
      // Reaktivieren falls archiviert + auto_source nachziehen.
      const patch: Record<string, unknown> = {};
      if (existing.archived_at) patch.archived_at = null;
      if (def.auto_source && existing.auto_source !== def.auto_source) patch.auto_source = def.auto_source;
      if (Object.keys(patch).length > 0) {
        await supabase.from("budget_categories").update(patch).eq("id", existing.id);
      }
      groupsEnsured++;
      continue;
    }

    const { data: inserted, error } = await supabase
      .from("budget_categories")
      .insert({
        name: def.name,
        sort_order: def.sort_order,
        auto_source: def.auto_source,
        is_auto_synced: true,
      })
      .select("id")
      .single();
    if (error || !inserted) {
      throw new Error(`Gruppe '${def.name}' konnte nicht angelegt werden: ${error?.message ?? "unknown"}`);
    }
    groupIdByDigit[digit] = inserted.id as string;
    groupsEnsured++;
  }

  // 2. Konten upserten. Aufwand + Ertrag (Auftragskonten/Service-Umsatz).
  let imported = 0;
  let skipped = 0;
  for (const acc of accounts) {
    if (acc.is_active === false) { skipped++; continue; }
    if (acc.type !== "expense" && acc.type !== "income") { skipped++; continue; }
    const firstDigit = (acc.account_no || "").charAt(0);
    const parentId = groupIdByDigit[firstDigit];
    if (!parentId) { skipped++; continue; }

    // Name: "5000 — Lohnaufwand" — Praefix sichert konsistente Sortierung
    // unabhaengig vom Namen-Casing.
    const display = `${acc.account_no} – ${acc.name}`;
    const sortOrder = parseInt(acc.account_no, 10) || 0;

    const { error } = await supabase
      .from("budget_categories")
      .upsert(
        {
          bexio_account_no: acc.account_no,
          name: display,
          parent_id: parentId,
          sort_order: sortOrder,
          is_auto_synced: true,
          bexio_account_group_id: acc.account_group_id ?? null,
          archived_at: null,
        },
        { onConflict: "bexio_account_no" },
      );
    if (error) {
      logWarn("bexio.syncCategories", `Konto ${acc.account_no} konnte nicht upserted werden: ${error.message}`);
      skipped++;
      continue;
    }
    imported++;
  }

  return { groups_ensured: groupsEnsured, accounts_imported: imported, accounts_skipped: skipped };
}

/** Zieht alle Buchungen im angegebenen Datums-Bereich, mappt account_id auf
 *  account_no und aggregiert auf Monats-Ebene pro Konto.
 *
 *  Berechnung pro Konto:
 *   • Aufwandskonto (account_type=4): Summe der DEBIT-Buchungen
 *   • Ertragskonto  (account_type=3): Summe der CREDIT-Buchungen
 *  Andere Konten werden ignoriert (irrelevant fuer Budget-Soll/Ist).
 *
 *  Pagination: Bexio's Journal-Endpoint liefert max ~2000 pro Call. Wir
 *  paginieren bis nichts mehr kommt. */
export async function aggregateBookingsByMonth(opts: {
  from: string;   // "2026-01-01"
  to: string;     // "2026-12-31"
}): Promise<MonthlyAccountAggregate> {
  // Kontenrahmen laden um account_id -> {no, type} zu mappen.
  const accounts = await listAccounts();
  const accountById = new Map<number, { no: string; type: string | undefined }>();
  for (const a of accounts) {
    accountById.set(a.id, { no: a.account_no, type: a.type });
  }

  const agg: MonthlyAccountAggregate = new Map();
  function add(account_no: string, monthKey: string, amount: number) {
    if (!agg.has(account_no)) agg.set(account_no, new Map());
    const byMonth = agg.get(account_no)!;
    const existing = byMonth.get(monthKey) ?? { sum_chf: 0, booking_count: 0 };
    existing.sum_chf += amount;
    existing.booking_count += 1;
    byMonth.set(monthKey, existing);
  }

  let offset = 0;
  const limit = 500;
  // Sicherheits-Cap: maximal 200k Buchungen ziehen (= 400 Pages). Bei
  // sehr aktiven Bexio-Mandanten Schutz vor Endlos-Loop.
  const MAX_PAGES = 400;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `/3.0/accounting_journal?from=${opts.from}&to=${opts.to}&limit=${limit}&offset=${offset}`;
    const res = await bexioFetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Bexio-Journal laden fehlgeschlagen (${res.status}): ${text}`);
    }
    const entries = (await res.json()) as BexioJournalEntry[];
    if (!Array.isArray(entries) || entries.length === 0) break;

    for (const entry of entries) {
      if (!entry.date) continue;
      const monthKey = entry.date.slice(0, 7); // "YYYY-MM"
      // Aufwand: Soll-Buchung auf Aufwandskonto.
      if (entry.debit_account_id) {
        const acc = accountById.get(entry.debit_account_id);
        if (acc && acc.type === "expense") add(acc.no, monthKey, entry.amount);
      }
      // Ertrag: Haben-Buchung auf Ertragskonto.
      if (entry.credit_account_id) {
        const acc = accountById.get(entry.credit_account_id);
        if (acc && acc.type === "income") add(acc.no, monthKey, entry.amount);
      }
    }

    if (entries.length < limit) break;
    offset += limit;
  }

  return agg;
}
