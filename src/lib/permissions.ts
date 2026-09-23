// Single source of truth fuer das Permission-Modell.
//
// Permissions sind Strings im Format "module:action".
//   "kunden:view"   = Kunden sehen / Kunden-Tab in Sidebar zeigen
//   "kunden:create" = Neuer Kunde anlegen
//   "kunden:edit"   = Kundendaten bearbeiten
//   "kunden:delete" = Kunde archivieren/loeschen
//
// Die admin-Rolle wird im SQL-Helper `has_permission()` und im JS-Helper
// `hasPermission()` IMMER als allmaechtig behandelt — das verhindert dass
// sich ein Admin per UI-Konfiguration selbst aussperrt.
//
// Module die keine Action-Granularitaet haben (Kalender, HR, Vertrieb,
// Einstellungen): nur "view". Wer diese Module sieht, sieht alles drin.

export type PermissionAction = "view" | "create" | "edit" | "archive" | "delete" | "manage" | "approve" | "see-all" | "edit-all";

export interface PermissionModule {
  slug: string;
  label: string;
  /** Pfade die zu diesem Modul gehoeren — fuer Layout-Guard. */
  paths: string[];
  /** Welche Aktionen werden in der Rollen-Matrix angeboten. */
  actions: PermissionAction[];
}

export const PERMISSION_MODULES: PermissionModule[] = [
  // Kalender — view = Kalender sehen, create/edit/delete = Termine verwalten.
  // Ist auch fuer Termine im Auftrag-Detail relevant (gleiche Permission).
  { slug: "kalender",      label: "Kalender",      paths: ["/kalender"],                                         actions: ["view", "create", "edit", "delete"] },
  // Operationen → Aufträge (Begriff aus der Sidebar, statt "Operations").
  // 'see-all' ist die ehemalige Lead-Funktion: sieht alle Auftraege,
  // nicht nur eigene (=via job_appointments zugewiesene). Steuert
  // is_admin_or_lead() in der DB.
  { slug: "auftraege",     label: "Aufträge",      paths: ["/auftraege"],                                        actions: ["view", "create", "edit", "delete", "see-all"] },
  // Abrechnung — abgeschlossene Auftraege als "Rechnung gestellt" markieren.
  // view = /abrechnung-Seite sehen; edit = "Rechnung gestellt"-Button druecken.
  { slug: "abrechnung",    label: "Abrechnung",    paths: ["/abrechnung"],                                       actions: ["view", "edit"] },
  // Vertrieb — Lead-Pipeline. CRUD pro Lead.
  // manage = Leads umverteilen (Reassign von User A auf User B), Team-
  // Ziele setzen, alle personal columns sehen; ohne 'manage' kann ein
  // Vertriebler nur eigene + unassigned Leads holen/zurueckgeben.
  { slug: "vertrieb",      label: "Vertrieb",      paths: ["/vertrieb"],                                         actions: ["view", "create", "edit", "delete", "manage"] },
  // Projekte — interner Zeit-Budget-Topf. view = Seite sehen; create =
  // eigenes Projekt anfragen (Antrag); approve = Antrag pruefen und
  // Budget setzen (Admin-Domäne). see-all = alle Projekte sehen (statt
  // nur eigene) — fuer HR/Buchhaltung.
  { slug: "projekte",      label: "Projekte",      paths: ["/projekte"],                                         actions: ["view", "create", "approve", "see-all"] },
  // archive = Standort mit Begruendung ins Archiv (Prinzip wie Auftrag-
  // Storno); Reaktivieren nutzt dieselbe Permission.
  { slug: "locations",     label: "Locations",     paths: ["/locations", "/standorte", "/raeume"], actions: ["view", "create", "edit", "archive", "delete"] },
  { slug: "kunden",        label: "Kunden",        paths: ["/kunden"],                                           actions: ["view", "create", "edit", "archive", "delete"] },
  { slug: "lieferanten",   label: "Lieferanten",   paths: ["/lieferanten"],                                      actions: ["view", "create", "edit", "delete"] },
  // Todos sind personal (RLS ueber created_by/assigned_to). Permissions
  // gaten den UI-Pfad: view = Sidebar+Page, create = Anlegen-Button.
  // Edit/Delete eigener Todos ist immer erlaubt (RLS-Owner) — daher
  // nicht als Toggle, sonst missverstaendlich.
  // see-all / edit-all heben den Owner-Lock auf: sieht/bearbeitet
  // Todos aller Mitarbeiter (z.B. fuer Team-Leitung).
  { slug: "todos",         label: "Todos",         paths: ["/todos"],                                            actions: ["view", "create", "see-all", "edit-all"] },
  // /hr ist der HR-Hub (Übersicht / Stempelzeiten / Tickets / Ferien /
  // Löhne als Tabs) und fuer alle sichtbar — kein "hr:view" hier, damit
  // die Rolle in der Matrix nicht auftaucht. Die einzelnen Tabs werden
  // ueber ihre jeweiligen Module-Permissions (stempelzeiten/tickets) bzw.
  // role='admin' + TrustedDeviceGate (loehne) gegated.
  // Loehne — Pro-Mitarbeiter-Saetze (Brutto + Arbeitgeber-Anteil) pflegen.
  // Sensitives Modul: nur HR/Geschaeftsfuehrung. Mitarbeiter sehen ihre
  // eigene Brutto-Zahl via /einstellungen → Mein Konto (RPC, kein Modul-View).
  // KEINE eigene Route — die Lohntabelle ist Content im Loehne-Tab unter /hr,
  // daher leere paths-Liste. Tab-internes Gate uebernimmt die admin-only-Regel.
  { slug: "lohn",          label: "Löhne",         paths: [],                                                    actions: ["manage"] },
  // Stempelzeiten als eigenes Modul (Tab im HR-Hub + Deep-Link /stempelzeiten).
  // see-all / edit-all heben den Owner-Lock auf der time_entries-Tabelle
  // auf — fuer HR-Verantwortliche die alle Stempelzeiten korrigieren.
  { slug: "stempelzeiten", label: "Stempelzeiten", paths: ["/stempelzeiten"],                                    actions: ["view", "see-all", "edit-all"] },
  { slug: "tickets",       label: "Tickets",       paths: ["/tickets"],                                          actions: ["view", "create", "manage"] },
  { slug: "einstellungen", label: "Einstellungen", paths: ["/einstellungen"],                                    actions: ["view"] },
  // Ferien: Mitarbeiter beantragen ihre eigenen via RLS (user_id),
  // brauchen keine view-Permission — Seite ist always-allowed.
  // approve = Admin/Genehmiger genehmigt oder lehnt ab.
  { slug: "ferien",        label: "Ferien",        paths: [],                                                    actions: ["approve"] },
  // Buero-Anwesenheit — Dashboard-Widget Wochen-Grid: wer ist welchen Tag
  // im Buero. Nur view (= sieht das Grid UND kann sich selbst eintragen);
  // keine separate edit-Action, da die Aktion (Toggle der eigenen Zeile)
  // sowieso nur via DB-RLS auf user_id=auth.uid() greift.
  { slug: "anwesenheit",   label: "Büro-Anwesenheit", paths: [],                                                 actions: ["view"] },
  // Admin-only: User-Aktivitaets-Log einsehen (wann welcher Mitarbeiter
  // in der App war). Hat keinen eigenen Pfad — Tab im /einstellungen.
  // Wird via has_permission('admin:activity') gegated, Admin durch.
];

// Partnerportal-Module — eigener Permission-Namespace `partner:*`.
//
// Format: "partner:<modul>:<action>". Alle Slugs beginnen mit `partner:`
// damit
//   - ein Berechtigungs-Check nie versehentlich internes `kalender:view`
//     mit dem Partner-Belegungsplan verwechselt,
//   - Partner-Sub-Rollen (Partner-Admin vs Partner-Mitarbeiter — siehe
//     MEMORY.project_partner_role_hierarchy) sauber Subsets vergeben,
//   - has_permission() denselben Prefix-Match bekommt wie fuer interne
//     Slugs (keine Sonderfaelle im UI-Guard).
//
// RLS-Semantik: die Location-Scope-Klausel (partner_location_id) bleibt
// die Autoritaet fuer WELCHE Zeilen ein Partner sieht — die partner:*-
// Permission gated nur OB.
//
// GRACE-PERIOD (Migration 216): waehrend der Umstellung akzeptieren die
// RLS-Policies parallel die alten dashed Slugs `partner-anfragen:*` und
// `partner-belegungsplan:*` (Migration 099). Beide Familien sind unten
// aufgelistet — die dashed Eintraege werden entfernt sobald die App-Seite
// verifiziert auf den neuen Namespace umgestellt ist.
export const PARTNER_PERMISSION_MODULES: PermissionModule[] = [
  // NEU: partner:*-Namespace
  { slug: "partner:anfragen",      label: "Partner-Anfragen",      paths: ["/partner/anfragen"],      actions: ["view", "create", "edit", "delete"] },
  { slug: "partner:belegungsplan", label: "Partner-Belegungsplan", paths: ["/partner/belegungsplan"], actions: ["view"] },
  // Auftraege = bestaetigte Anfragen (partner_anfrage -> offen). Partner
  // sieht sie read-only im Kalender; RLS scoped auf partner_location_id.
  { slug: "partner:auftraege",     label: "Partner-Auftraege",     paths: [],                         actions: ["view"] },
  // LEGACY (Migration 099) — bleiben waehrend Grace-Period parseable.
  // Werden von Migration 216-Nachfolger entfernt.
  { slug: "partner-anfragen",      label: "Anfragen (legacy)",     paths: ["/partner/anfragen"],      actions: ["view", "create", "edit", "delete"] },
  { slug: "partner-belegungsplan", label: "Belegungsplan (legacy)", paths: ["/partner/belegungsplan"], actions: ["view"] },
];

/**
 * Neuer partner:*-Namespace hat neben CRUD auf Anfragen zusaetzlich eine
 * `respond`-Action fuer Antworten im Anfrage-Thread (z.B. auf Rueckfragen
 * / Ablehnungen von EVENTLINE-Admins reagieren). Wird als Feature-Slug
 * gefuehrt statt als PermissionAction, damit "respond" nicht in andere
 * Module wie kunden/vertrieb sickert wo es semantisch nichts bedeutet.
 */
export const PARTNER_EXTRA_PERMISSIONS: readonly string[] = [
  "partner:anfragen:respond",
];

/** Pfade die fuer alle eingeloggten User erreichbar sind, unabhaengig von der Rolle.
 *  - /dashboard: Startseite, jeder soll dort landen koennen
 *  - /mein-konto: User-Self-Service (Profil, Benachrichtigungen, Dokumente, Kalender;
 *                 Admin-Space-Tab nur sichtbar fuer role='admin') */
const ALWAYS_ALLOWED_PREFIXES = ["/dashboard", "/mein-konto", "/ferien"];

/** Pfade die strikt nur fuer role='admin' sind — Sidebar blendet sie fuer
 *  alle anderen aus, isPathAllowed liefert false (-> /dashboard-Redirect
 *  im (app)/layout). RLS sperrt die Daten zusaetzlich auf der DB-Seite.
 *  Leer seit HR-Tab-Hub (2026-09): /hr ist wieder für alle sichtbar, aber
 *  der Löhne-Tab innerhalb ist admin-only + TrustedDeviceGate. Andere
 *  admin-only Bereiche haben ihre eigenen Modul-View-Permissions. */
const ADMIN_ONLY_PREFIXES: string[] = [];

/** Pfade die immer erreichbar sind, auch ohne Modul-View-Permission, weil
 *  sie via Verknuepfung aus einem anderen Modul aufgerufen werden (z.B.
 *  /kunden/[uuid] aus einem Auftrag heraus, ohne dass der User die ganze
 *  Kunden-Liste sehen darf). Detail-Pages — keine Listen, keine Neu/Edit. */
const ALWAYS_ALLOWED_DETAIL_REGEX: RegExp[] = [
  /^\/kunden\/[0-9a-f-]{36}\/?$/i,
];

/** Permission-Check fuer eine konkrete Aktion (z.B. "kunden:edit"). */
export function hasPermission(permissions: string[], role: string, perm: string): boolean {
  if (role === "admin") return true;
  return permissions.includes(perm);
}

/** True wenn der User das Modul sehen darf (= module:view-Permission). */
function canSeeModule(slug: string, permissions: string[], role: string): boolean {
  return hasPermission(permissions, role, `${slug}:view`);
}

export function isPathAllowed(pathname: string, permissions: string[], role: string): boolean {
  // Sidebar-Items koennen Query-Strings enthalten (z.B. "/hr?tab=loehne").
  // Fuer die Path-Match-Logik interessiert uns nur der reine Pfad, sonst
  // faellt "/hr?tab=loehne" durch den admin-only-Check.
  const qIdx = pathname.indexOf("?");
  if (qIdx !== -1) pathname = pathname.slice(0, qIdx);
  // Admin-only-Pfade: explizit pruefen damit die Sidebar sie fuer Nicht-
  // Admins ausblendet (auch wenn role==admin sowieso true zurueckgibt).
  if (ADMIN_ONLY_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return role === "admin";
  }
  if (role === "admin") return true;
  if (ALWAYS_ALLOWED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) return true;
  // Detail-Pages (/kunden/[uuid] etc.) sind ohne Modul-Permission erreichbar
  // — sie werden ueber Verknuepfungen aus anderen Modulen geoeffnet (z.B.
  // Klick auf den Kundennamen in einem Auftrag). RLS auf den Tabellen sorgt
  // dafuer dass nur sichtbare Datensaetze angezeigt werden.
  if (ALWAYS_ALLOWED_DETAIL_REGEX.some((re) => re.test(pathname))) return true;
  for (const mod of PERMISSION_MODULES) {
    if (mod.paths.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
      return canSeeModule(mod.slug, permissions, role);
    }
  }
  // Pfade die zu keinem Modul gehoeren (z.B. /api/...) lassen wir durch.
  return true;
}

// Feature-Permissions: cross-cutting Funktionen die nicht an einen Modul-
// Pfad gebunden sind (z.B. Bexio-Buttons tauchen auf Kunden- UND Auftrags-
// Detailseiten auf). In der Rollen-Matrix als eigene Sektion gerendert.
export interface PermissionFeature {
  key: string;
  label: string;
  description: string;
}

export const PERMISSION_FEATURES: PermissionFeature[] = [
  {
    key: "bexio:use",
    label: "Bexio benutzen",
    description: "Kontakte mit Bexio verlinken, in Bexio anlegen, dort öffnen",
  },
];

/** Sammelt alle bekannten Permission-Strings — fuer API-Validierung beim Anlegen/Aendern von Rollen. */
export function allKnownPermissions(): string[] {
  const out: string[] = [];
  for (const m of PERMISSION_MODULES) {
    for (const a of m.actions) out.push(`${m.slug}:${a}`);
  }
  for (const m of PARTNER_PERMISSION_MODULES) {
    for (const a of m.actions) out.push(`${m.slug}:${a}`);
  }
  for (const p of PARTNER_EXTRA_PERMISSIONS) out.push(p);
  for (const f of PERMISSION_FEATURES) out.push(f.key);
  return out;
}
