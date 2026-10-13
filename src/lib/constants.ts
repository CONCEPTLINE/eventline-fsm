import { hasPermission, isPathAllowed } from "@/lib/permissions";

// Primaerer Admin-Empfaenger fuer Benachrichtigungen aus Vertrieb.
// Ueber env-var ueberschreibbar fuer Test-/Staging-Umgebungen — Default ist
// Leo's Adresse. Sender-Adresse (from:/replyTo:) bleibt im jeweiligen
// Mail-Template hartkodiert, da das die Brand-Identitaet ist.
export const ADMIN_NOTIFICATION_EMAIL =
  process.env.ADMIN_NOTIFICATION_EMAIL || "leo@eventline-basel.com";

// Status-Labels für Aufträge — Light- + Dark-Mode-Farben.
// Lifecycle: entwurf → offen → abgeschlossen | storniert.
// 'anfrage' (frueher Vermietentwurf-Akquise) und 'entwurf' bleiben als
// Labels erhalten (Historie), werden im UI aber nicht mehr als Filter
// angeboten — Entwuerfe leben ab 2026-09 in der eigenen Tabelle
// job_drafts (siehe Migration 206) unter /entwuerfe.
export const JOB_STATUS = {
  // Partner-Anfrage: gelb/amber, "wartet auf Eventline-Entscheidung".
  // Entsteht ueber das Partner-Portal — Partner erstellt eine Anfrage,
  // Admin akzeptiert (→ offen) oder lehnt ab (→ storniert).
  partner_anfrage: { label: "Partner-Anfrage", color: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300" },
  // Historische Status-Labels — es entstehen keine neuen Jobs mehr in
  // diesen Zustaenden, aber Alt-Datensaetze koennen sie noch tragen.
  anfrage: { label: "Anfrage", color: "bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-300" },
  entwurf: { label: "Entwurf", color: "bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-300" },
  offen: { label: "Bevorstehend", color: "bg-gray-100 text-gray-700 dark:bg-gray-500/20 dark:text-gray-300" },
  abgeschlossen: { label: "Abgeschlossen", color: "bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300" },
  storniert: { label: "Storniert", color: "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300" },
} as const;

// Abgeleitete Status-Mengen (Skalierbarkeits-Audit 2026-09-23) — vorher als
// wortgleiche Literal-Arrays ueber mehrere Dateien verstreut.
// Endzustaende: der Auftrag ist durch (Archiv-Segment auf /auftraege).
export const JOB_STATUS_GESCHLOSSEN = ["abgeschlossen", "storniert"] as const;
// Laufende/aktive Status (alles ausser abgeschlossen/storniert/partner_anfrage)
// — z.B. "auf welche Auftraege darf gestempelt werden".
export const JOB_STATUS_VORSTUFEN = ["offen", "anfrage", "entwurf"] as const;

// Zentral definierte Spalten-Listen fuer Job-Selects: vermeidet Drift bei
// neuen Spalten-Zugaengen (z.B. contact_*-Felder aus Migration 042). Wer
// Form-Daten laedt nutzt JOB_FORM_FIELDS, Listen mit Joins ergaenzen den
// Join-Teil eigenstaendig.
export const JOB_FORM_FIELDS =
  "id, job_number, job_type, title, description, status, priority, customer_id, location_id, room_id, external_address, start_date, end_date, contact_person, contact_phone, contact_email, project_lead_id";

// Komponierbare Select-Fragmente fuer Job-Listen (Skalierbarkeits-Audit
// 2026-09-23). Die grossen Listen-Selects (/auftraege, /abrechnung,
// api/dashboard, api/calendar.ics) setzen ihre Spalten-Listen aus diesen
// Bausteinen zusammen (Template-Literal) und ergaenzen site-spezifische
// Spalten/Joins literal. Fragmente sind reine Textbausteine — beim Umstellen
// einer Stelle MUSS die resultierende Spaltenmenge exakt gleich bleiben.
export const JOB_FIELDS = {
  /** Identitaet + Anzeige-Basics — jede Job-Liste braucht die. */
  core: "id, job_number, title",
  status: "status",
  zeitraum: "start_date, end_date",
  /** Rechnungs-Workflow-Spalten (/auftraege-Archiv, /abrechnung). */
  rechnung: "invoiced_at, invoice_number, invoice_skipped_at, invoice_skipped_reason",
  /** Standard-Joins (nur Name) — Listen die mehr Felder brauchen joinen selbst. */
  kunde: "customer:customers(name)",
  location: "location:locations(name)",
} as const;

// Prioritäten — nur 'normal' (default) und 'dringend'
// 'niedrig' und 'hoch' wurden nie genutzt, der relevante Hinweis ist binär:
// "ist das jetzt dringend oder nicht?"
export const JOB_PRIORITY = {
  normal: { label: "Normal", color: "bg-gray-100 text-gray-600 dark:bg-gray-500/20 dark:text-gray-300" },
  dringend: { label: "Dringend", color: "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300" },
} as const;

// Kundentypen
export const CUSTOMER_TYPES = {
  company: "Firma",
  individual: "Privatperson",
  organization: "Organisation",
} as const;

// Benutzerrollen
export const USER_ROLES = {
  admin: "Admin",
  techniker: "Service-Techniker",
} as const;

// === NAVIGATION (single source of truth) ===
// Adding/changing nav items: edit ONLY this file.
// Sidebar, Bottom-Nav und Befehlspalette lesen NAV_GROUPS; das Mehr-Sheet
// am Handy hat seine eigene, bewusst kurze Liste in src/lib/mobile-seiten.ts.
// Icons resolve via src/lib/nav-icons.ts — add new icons there.

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** Fester Link-Platz in der Bottom-Nav (Dashboard, Todos, Kalender).
   *  Nicht erweitern: die Nav hat fuenf feste Plaetze (3 Links + Stempeln + Mehr). */
  mobile?: boolean;
  /** Zusatz-Pfade die als "in diesem Bereich" gelten — fuer Routen die unter
   *  einem anderen Top-Level-Pfad liegen aber semantisch hierher gehoeren
   *  (z.B. /standorte/[id] und /raeume/[id] gehoeren zu /locations). */
  matchPrefixes?: string[];
  /** Fuer Eintraege, deren Pfad an keinem Rechte-Modul haengt: sichtbar nur
   *  mit mindestens einem dieser Rechte (Admin sieht immer alles). */
  rechte?: string[];
}

export interface NavGroup {
  /** Leer = ohne Ueberschrift, immer offen (oberster Block). Sonst ein
   *  aufklappbarer Bereich in der Sidebar. */
  label: string;
  items: NavItem[];
}

// Sidebar-Struktur (Struktur-Umbau 2026-10): wenige feste Bereiche, die
// auf- und zuklappen. Damit die App wachsen kann, ohne umgebaut zu werden:
//   1. Neue Seite → als Eintrag in den passenden Bereich. Sonst nichts.
//   2. Neuer Bereich nur fuer eine neue Art Arbeit (wie Finanzen), max. ~8.
//   3. Ab ~6 Seiten in einem Bereich: eng Verwandtes zu EINER Seite mit Tabs.
//   4. Tabs nur fuer Ansichten derselben Sache (Aktiv/Archiv, Meine/Team).
//   5. URLs bleiben flach (/kunden, /lohn …) — die Gruppe gibt es nur hier.
// Bereiche (Reihenfolge = wie viele Leute sie taeglich brauchen):
//   (oben)    mein Tag, immer offen: Dashboard, Todos, Kalender
//   Geschäft  Vertrieb → Entwürfe → Aufträge, dazu Projekte
//   Kontakte  Kunden, Locations, Lieferanten. Locations soll ein Klick
//             bleiben (Leo, 2026-09-05, Schluesselcodes) → wer den Bereich
//             offen laesst, hat ihn; die Sidebar merkt sich offene Bereiche.
//   HR        Anträge, Stempelzeiten, Tickets & Belege, Abwesenheit, Lohn
//   Finanzen  Abrechnung (+ kuenftige Finanzseiten)
//   Admin     Ablage, Technik, Einstellungen
// Admin-Einstellungen leben an EINEM Ort: /einstellungen (Firmenportal mit
// Firma, Mitarbeiter, Rollen, Integrationen, Sicherheit; Partner- und
// Lieferantenportal). Eine neue Einstellung wird dort ein Sub-Tab im
// passenden Portal — keine eigene Sidebar-Seite. Werden es zu viele
// Sub-Tabs, Verwandtes zu einem Sub-Tab mit Abschnitten gruppieren.
// Alte Einstiege (/datenbank, /hr?tab=…, /ablage, /standorte, /raeume,
// /mitarbeiter, /sicherheit) funktionieren weiter — als Weiterleitung oder
// via matchPrefixes auf den neuen Eintrag.
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: "LayoutDashboard", mobile: true },
      { href: "/todos", label: "Todos", icon: "CheckSquare", mobile: true },
      { href: "/kalender", label: "Kalender", icon: "Calendar", mobile: true },
    ],
  },
  {
    label: "Geschäft",
    items: [
      { href: "/vertrieb", label: "Vertrieb", icon: "TrendingUp" },
      // Entwuerfe (Migration 206, 2026-09-05): eigener Bereich fuer
      // Auftrags-Entwuerfe — intensive Kunden-Kontakte, Notizen-Historie,
      // Umwandlung in echten Auftrag als bewusster Schritt. Liegt bewusst
      // ueber "Aufträge", weil Entwuerfe der Vorstufe in der Pipeline sind.
      { href: "/entwuerfe", label: "Entwürfe", icon: "FileEdit" },
      // Am Handy im Mehr-Sheet (Mobile-Overhaul 2026-10): die Bottom-Nav hat
      // fuenf feste Plaetze — Dashboard, Todos, Stempeln, Kalender, Mehr.
      { href: "/auftraege", label: "Aufträge", icon: "ClipboardList" },
      // Projekte (intern, Stunden-Budget) bleiben fachlich getrennt von
      // Auftraegen — eigene Seite, eigene Daten; nur die Gruppe ist gemeinsam.
      { href: "/projekte", label: "Projekte", icon: "FolderKanban" },
    ],
  },
  {
    label: "Kontakte",
    items: [
      // /datenbank (frueherer Kunden/Lieferanten-Hub) leitet hierher weiter.
      { href: "/kunden", label: "Kunden", icon: "Users", matchPrefixes: ["/datenbank"] },
      // /standorte/[id] und /raeume/[id] (Verwaltung bzw. Raum) gehoeren
      // zu Locations.
      { href: "/locations", label: "Locations", icon: "MapPin", matchPrefixes: ["/standorte", "/raeume"] },
      { href: "/lieferanten", label: "Lieferanten", icon: "Truck" },
    ],
  },
  {
    // Jede HR-Seite ist ein eigener Eintrag mit eigener Adresse (kein Hub
    // mit Tabs mehr). /hr und /hr?tab=… leiten auf die passende Seite um.
    label: "HR",
    items: [
      // Genehmigen (Abwesenheit, Tickets, Belege, Stempel-Korrekturen) —
      // nur wer etwas genehmigen darf.
      {
        href: "/antraege",
        label: "Anträge",
        icon: "Inbox",
        rechte: ["ferien:approve", "tickets:manage", "stempelzeiten:see-all"],
      },
      { href: "/stempelzeiten", label: "Stempelzeiten", icon: "Clock" },
      { href: "/tickets", label: "Tickets & Belege", icon: "TicketCheck" },
      { href: "/ferien", label: "Abwesenheit", icon: "Palmtree" },
      { href: "/lohn", label: "Lohn", icon: "Wallet" },
    ],
  },
  {
    // Bereich fuer alles, was Geld in die Firma bringt oder rausgeht —
    // neue Finanzseiten (Rechnungen, Budget, Auswertungen …) kommen hier rein.
    label: "Finanzen",
    items: [
      { href: "/abrechnung", label: "Abrechnung", icon: "Receipt" },
    ],
  },
];

// Nur fuer Admins (ADMIN_ONLY_PREFIXES in permissions.ts) — ausser
// Einstellungen, das haengt an einstellungen:view.
export const ADMIN_NAV_GROUP: NavGroup = {
  label: "Admin",
  items: [
    // Ablage = die NAS-Seite (Dokumente in die UGREEN-Ordnerstruktur
    // ablegen, Backup-Status). /ablage = Alias.
    { href: "/nas", label: "Ablage", icon: "HardDriveUpload", matchPrefixes: ["/ablage"] },
    // Technik-Dashboard (Rig, lokale KI, NAS als digitaler Zwilling), nur Admins,
    // nur Laptop. Vertrag: docs/technik-dashboard/VERTRAG.md.
    { href: "/technik", label: "Technik", icon: "Server" },
    // Alle Admin-Einstellungen (inkl. Mitarbeiter und Sicherheit) — siehe
    // Kommentar ueber NAV_GROUPS.
    { href: "/einstellungen", label: "Einstellungen", icon: "Settings" },
  ],
};

/** Sichtbare Nav-Gruppen fuer eine Rolle — Sidebar, Mobile-Sheet und
 *  Befehlspalette lesen alle diese Liste (gleiche Labels, gleiche
 *  Sichtbarkeit). Gefiltert pro Eintrag via isPathAllowed plus optionale
 *  `rechte` (mind. eines; Admin sieht alles); leere Gruppen fallen weg. */
export function sichtbareNavGruppen(permissions: string[], role: string): NavGroup[] {
  const sichtbar = (i: NavItem) =>
    isPathAllowed(i.href, permissions, role) &&
    (!i.rechte || i.rechte.some((r) => hasPermission(permissions, role, r)));
  return [...NAV_GROUPS, ADMIN_NAV_GROUP]
    .map((g) => ({ ...g, items: g.items.filter(sichtbar) }))
    .filter((g) => g.items.length > 0);
}

/** Ist ein Nav-Eintrag fuer die aktuelle URL aktiv? Eine Regel fuer
 *  Sidebar und Mobile-Sheet:
 *  - Eintraege mit Query (z.B. "/x?tab=y") nur bei exakt gleicher URL
 *  - /dashboard und /kalender nur exakt (tiefere Pfade bluten nicht rein)
 *  - sonst Pfad-Prefix, plus die Zusatz-Prefixe aus matchPrefixes */
export function isNavItemActive(item: Pick<NavItem, "href" | "matchPrefixes">, pathname: string, search: string): boolean {
  if (item.href.includes("?")) return pathname + (search ? `?${search}` : "") === item.href;
  if (item.href === "/dashboard" || item.href === "/kalender") return pathname === item.href;
  if (pathname.startsWith(item.href)) return true;
  return item.matchPrefixes?.some((p) => pathname.startsWith(p)) ?? false;
}

// Flat lists for backwards compatibility
export const NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);
export const ADMIN_NAV_ITEMS = ADMIN_NAV_GROUP.items;
