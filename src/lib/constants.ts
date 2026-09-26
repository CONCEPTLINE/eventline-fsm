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
  "id, job_number, job_type, title, description, status, priority, customer_id, location_id, room_id, external_address, start_date, end_date, contact_person, contact_phone, contact_email";

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
// Sidebar, mobile bottom-nav and mobile sheet all read from NAV_GROUPS.
// Icons resolve via src/lib/nav-icons.ts — add new icons there.

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** Show as a primary tab in mobile bottom-nav. Max 4 across all items. */
  mobile?: boolean;
  /** Zusatz-Pfade die als "in diesem Bereich" gelten — fuer Routen die unter
   *  einem anderen Top-Level-Pfad liegen aber semantisch hierher gehoeren
   *  (z.B. /standorte/[id] und /raeume/[id] gehoeren zu /locations). */
  matchPrefixes?: string[];
}

export interface NavGroup {
  /** Empty string = no group header (renders flat at top of sidebar). */
  label: string;
  items: NavItem[];
}

// Sidebar-Struktur nach Audit-Rebuild + Rueck-Konsolidierung (2026-09):
// HR wieder als EINE Sidebar-Position (/hr) mit Tab-Hub innen —
// Stempelzeiten / Tickets / Ferien / Löhne sind Tabs, nicht eigene
// Sidebar-Bereiche. Grund: 3 einzelne Sidebar-Eintraege haben die
// "HR-Zeug ist beisammen"-Wahrnehmung zerschossen und Mitarbeiter mussten
// mehrere Bereiche durchklicken; ein Hub mit kompakten Tabs (nicht wieder
// mit Riesen-Card-Buttons wie die Ur-Zwischenseite) haelt alles zusammen.
// Deep-Links auf /stempelzeiten, /tickets, /ferien funktionieren weiter
// (duenne Wrapper).
// Kunden/Lieferanten → EIN Sidebar-Eintrag "Datenbank" mit 2 Tabs
// (/datenbank?tab=…). Die Einzel-Routes /kunden, /lieferanten bleiben als
// Deep-Link-Alias erhalten. Locations lebt wieder als EIGENER Sidebar-
// Eintrag (Leo, 2026-09-05): Schluesselcodes werden bei Auftraegen
// regelmaessig nachgeschlagen — muss ein Klick tief sein, nicht zwei.
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: "LayoutDashboard", mobile: true },
      { href: "/todos", label: "Todos", icon: "CheckSquare", mobile: true },
      { href: "/kalender", label: "Kalender", icon: "Calendar", mobile: true },
      // HR als Hub: enthält Übersicht + Stempelzeiten + Tickets + Ferien
      // (+ Löhne fuer Admin auf trusted device). matchPrefixes damit die
      // Detail-Deep-Links (/stempelzeiten, /tickets/[id], /ferien) den HR-
      // Eintrag in der Sidebar aktiv markieren.
      {
        href: "/hr",
        label: "HR",
        icon: "Briefcase",
        matchPrefixes: ["/stempelzeiten", "/tickets", "/ferien"],
      },
    ],
  },
  {
    label: "Kunden-Workflow",
    items: [
      { href: "/vertrieb", label: "Vertrieb", icon: "TrendingUp" },
      // Entwuerfe (Migration 206, 2026-09-05): eigener Bereich fuer
      // Auftrags-Entwuerfe — intensive Kunden-Kontakte, Notizen-Historie,
      // Umwandlung in echten Auftrag als bewusster Schritt. Liegt bewusst
      // ueber "Aufträge", weil Entwuerfe der Vorstufe in der Pipeline sind.
      { href: "/entwuerfe", label: "Entwürfe", icon: "FileEdit" },
      { href: "/auftraege", label: "Aufträge", icon: "ClipboardList", mobile: true },
      { href: "/abrechnung", label: "Rechnungen", icon: "Receipt" },
    ],
  },
  {
    label: "Intern",
    items: [
      { href: "/projekte", label: "Projekte", icon: "FolderKanban" },
      // Datenbank-Hub — konsolidiert Kunden + Lieferanten als Tabs.
      // matchPrefixes damit /kunden, /lieferanten und ihre Detail-Routen
      // (/kunden/[id] etc.) den Datenbank-Eintrag aktiv markieren.
      {
        href: "/datenbank",
        label: "Datenbank",
        icon: "Database",
        matchPrefixes: ["/kunden", "/lieferanten"],
      },
      // Locations eigenstaendig — bei Aufbau werden Schluesselcodes /
      // Kontakt-Infos regelmaessig nachgeschlagen (Barakuba, Theater BAU3
      // etc.). matchPrefixes damit /standorte/[id] und /raeume/[id] den
      // Locations-Eintrag aktiv markieren.
      {
        href: "/locations",
        label: "Locations",
        icon: "MapPin",
        matchPrefixes: ["/standorte", "/raeume"],
      },
    ],
  },
];

export const ADMIN_NAV_GROUP: NavGroup = {
  label: "Admin",
  items: [
    // NAS-Ablage: Dokumente mit Kurzbeschrieb in die UGREEN-Ordnerstruktur
    // ablegen (bewusst ohne KI-Analyse — sensible Dokumente).
    { href: "/ablage", label: "NAS-Ablage", icon: "HardDriveUpload" },
    // Löhne sind kein separater Sidebar-Eintrag mehr — sie leben als
    // admin-only Tab (+ TrustedDeviceGate) innerhalb /hr.
    { href: "/einstellungen", label: "Einstellungen", icon: "Settings" },
  ],
};

// Flat lists for backwards compatibility
export const NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);
export const ADMIN_NAV_ITEMS = ADMIN_NAV_GROUP.items;
