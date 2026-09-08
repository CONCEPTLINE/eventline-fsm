// Aktionen-Katalog fuer die Cmd-K-Palette.
//
// Statischer Katalog von App-Aktionen/Zielen mit deutschen Synonymen —
// "krank" fuehrt zu Abwesenheiten, "lohnerhoehung" zu HR → Loehne, usw.
// Matching ist client-seitig (kein API-Call): Query-Tokens werden
// umlaut-normalisiert und muessen ALLE im Suchtext (Label + Keywords +
// Sublabel) vorkommen.
//
// Permission-Gating: sensible Ziele tragen ein `gate`, das die Palette
// gegen usePermissions() prueft (Admins passen via has_permission
// automatisch durch — Memory-Regel). Ungegatete Aktionen sieht jeder;
// die Zielseite gated notfalls selbst nochmal (Defense in depth).

import type { LucideIcon } from "lucide-react";
import {
  CalendarOff, Clock, ClipboardList, FileText, Wallet, FileStack,
  Timer, Percent, CheckSquare, TicketCheck, Users, Shield, Building2,
  Plug, Handshake, UserCircle, LayoutDashboard, Calendar, FolderKanban,
  MapPin, Home, Truck, TrendingUp, Receipt, Database, CalendarCheck,
} from "lucide-react";

export interface PaletteAction {
  /** Stabile ID (fuer React-Keys). */
  id: string;
  label: string;
  /** Wohin es fuehrt — als Erklaerung unter dem Label. */
  sublabel: string;
  href: string;
  icon: LucideIcon;
  /** Synonyme/Suchbegriffe (klein, ohne Umlaut-Zwang — wird normalisiert). */
  keywords: string[];
  /** Optional: Permission-Slug (via can()) oder "admin" (via role). */
  gate?: string;
}

export const PALETTE_ACTIONS: PaletteAction[] = [
  // ─── Alltag / Melden ────────────────────────────────────────────
  {
    id: "abwesenheit",
    label: "Abwesenheit melden",
    sublabel: "Krankheit, Ferien, Militär — Abwesenheit beantragen",
    href: "/ferien",
    icon: CalendarOff,
    keywords: ["krank", "krankheit", "krankmeldung", "arzt", "unfall", "abwesenheit", "absenz", "ferien", "urlaub", "frei nehmen", "militaer", "abwesend"],
  },
  {
    id: "stempeln",
    label: "Stempelzeiten",
    sublabel: "Ein-/Ausstempeln und Zeiterfassung ansehen",
    href: "/stempelzeiten",
    icon: Clock,
    keywords: ["stempeln", "einstempeln", "ausstempeln", "zeiterfassung", "arbeitszeit", "stunden", "zeit erfassen", "stempeluhr"],
  },
  {
    id: "neuer-auftrag",
    label: "Neuer Auftrag",
    sublabel: "Auftrag erstellen",
    href: "/auftraege/neu",
    icon: ClipboardList,
    keywords: ["neuer auftrag", "auftrag erstellen", "auftrag anlegen", "job erstellen", "einsatz erstellen"],
    gate: "auftraege:create",
  },
  {
    id: "neuer-entwurf",
    label: "Neuer Entwurf",
    sublabel: "Auftrags-Entwurf anlegen",
    href: "/entwuerfe/neu",
    icon: FileText,
    keywords: ["entwurf", "neuer entwurf", "entwurf erstellen", "draft"],
    gate: "auftraege:create",
  },
  {
    id: "todo",
    label: "Todos",
    sublabel: "Todo-Liste öffnen und erstellen",
    href: "/todos",
    icon: CheckSquare,
    keywords: ["todo", "aufgabe", "task", "todo erstellen", "erledigen"],
    gate: "todos:view",
  },
  {
    id: "ticket",
    label: "Ticket erstellen",
    sublabel: "Problem melden oder Stempel-Änderung anfragen",
    href: "/tickets",
    icon: TicketCheck,
    keywords: ["ticket", "problem melden", "stempel aendern", "stempel korrektur", "korrektur anfragen", "support"],
    gate: "tickets:view",
  },

  // ─── HR / Lohn (sensibel, gegated) ─────────────────────────────
  {
    id: "lohnerhoehung",
    label: "Löhne & Lohnerhöhung",
    sublabel: "HR → Löhne → Mitarbeiter (Lohn ändern oder Erhöhung planen)",
    href: "/hr?tab=loehne&subtab=mitarbeiter",
    icon: Wallet,
    keywords: ["lohn", "lohnerhoehung", "gehalt", "gehaltserhoehung", "salaer", "stundenlohn", "lohn aendern", "verdienst", "brutto"],
    gate: "lohn:manage",
  },
  {
    id: "lohnabrechnungen",
    label: "Lohnabrechnungen",
    sublabel: "HR → Löhne → PDFs (Monats-Abrechnungen)",
    href: "/hr?tab=loehne&subtab=pdfs",
    icon: FileStack,
    keywords: ["lohnabrechnung", "lohn pdf", "abrechnung lohn", "payslip", "lohnzettel"],
    gate: "lohn:manage",
  },
  {
    id: "monatsstunden",
    label: "Monatsstunden",
    sublabel: "HR → Löhne → Monatsstunden (Stunden-Übersicht pro MA)",
    href: "/hr?tab=loehne&subtab=monatsstunden",
    icon: Timer,
    keywords: ["monatsstunden", "stunden uebersicht", "stundenkontrolle", "soll ist"],
    gate: "lohn:manage",
  },
  {
    id: "lohn-standardwerte",
    label: "Lohn-Standardwerte",
    sublabel: "HR → Löhne → Standardwerte (AHV/ALV/BVG-Sätze)",
    href: "/hr?tab=loehne&subtab=standardwerte",
    icon: Percent,
    keywords: ["standardwerte", "abzuege", "ahv", "alv", "bvg", "sozialleistungen", "arbeitgeberanteil", "quellensteuer"],
    gate: "lohn:manage",
  },
  {
    id: "ferien-genehmigen",
    label: "Ferien genehmigen",
    sublabel: "HR → Ferien (offene Anträge prüfen)",
    href: "/hr?tab=ferien",
    icon: CalendarCheck,
    keywords: ["ferien genehmigen", "urlaubsantraege", "antraege pruefen", "abwesenheiten genehmigen", "ferienantrag"],
    gate: "ferien:approve",
  },

  // ─── Verwaltung ────────────────────────────────────────────────
  {
    id: "team",
    label: "Mitarbeiter verwalten",
    sublabel: "Einstellungen → Team (anlegen, bearbeiten, deaktivieren)",
    href: "/einstellungen?tab=team",
    icon: Users,
    keywords: ["mitarbeiter", "team", "benutzer", "user", "neuer mitarbeiter", "mitarbeiter anlegen", "einladen", "deaktivieren"],
    gate: "einstellungen:view",
  },
  {
    id: "rollen",
    label: "Rollen & Rechte",
    sublabel: "Einstellungen → Rollen (Berechtigungen pro Rolle)",
    href: "/einstellungen?tab=rollen",
    icon: Shield,
    keywords: ["rollen", "rechte", "berechtigungen", "permissions", "zugriff"],
    gate: "einstellungen:view",
  },
  {
    id: "firma",
    label: "Firmen-Stammdaten",
    sublabel: "Einstellungen → Firma",
    href: "/einstellungen?tab=firma",
    icon: Building2,
    keywords: ["firma", "stammdaten", "firmendaten", "adresse firma"],
    gate: "einstellungen:view",
  },
  {
    id: "integrationen",
    label: "Integrationen",
    sublabel: "Einstellungen → Integrationen (Bexio)",
    href: "/einstellungen?tab=integrationen",
    icon: Plug,
    keywords: ["integration", "bexio", "schnittstelle", "api"],
    gate: "einstellungen:view",
  },
  {
    id: "partner-verwalten",
    label: "Partner verwalten",
    sublabel: "Einstellungen → Partnerportal",
    href: "/einstellungen?tab=partner",
    icon: Handshake,
    keywords: ["partner", "partnerportal", "partner user", "locationpartner"],
    gate: "einstellungen:view",
  },
  {
    id: "mein-konto",
    label: "Mein Konto",
    sublabel: "Profil, Passwort, mein Lohn",
    href: "/mein-konto",
    icon: UserCircle,
    keywords: ["konto", "profil", "passwort", "passwort aendern", "mein lohn", "account", "einstellungen persoenlich"],
  },

  // ─── Seiten (Navigation) ───────────────────────────────────────
  { id: "dashboard",  label: "Dashboard",  sublabel: "Übersicht", href: "/dashboard", icon: LayoutDashboard, keywords: ["dashboard", "uebersicht", "start", "home"] },
  { id: "kalender",   label: "Kalender",   sublabel: "Termine & Einsätze", href: "/kalender", icon: Calendar, keywords: ["kalender", "termine", "agenda"], gate: "kalender:view" },
  { id: "auftraege",  label: "Aufträge",   sublabel: "Alle Aufträge", href: "/auftraege", icon: ClipboardList, keywords: ["auftraege", "auftrag suchen", "jobs", "einsaetze"], gate: "auftraege:view" },
  { id: "projekte",   label: "Projekte",   sublabel: "Interne Projekte", href: "/projekte", icon: FolderKanban, keywords: ["projekte", "projekt", "intern"], gate: "projekte:view" },
  { id: "kunden",     label: "Kunden",     sublabel: "Kundenverzeichnis", href: "/kunden", icon: Users, keywords: ["kunden", "kunde", "kundenliste"], gate: "kunden:view" },
  { id: "standorte",  label: "Standorte",  sublabel: "Locations inkl. Verrechnungssätze (im Standort → Einstellungen)", href: "/standorte", icon: MapPin, keywords: ["standorte", "location", "verrechnungssatz", "verrechnungssaetze", "stundensatz", "pikett"], gate: "locations:view" },
  { id: "raeume",     label: "Räume",      sublabel: "Raum-Verwaltung", href: "/raeume", icon: Home, keywords: ["raeume", "raum", "räume"], gate: "locations:view" },
  { id: "lieferanten",label: "Lieferanten",sublabel: "Catering, Technik, AV", href: "/lieferanten", icon: Truck, keywords: ["lieferanten", "lieferant", "catering", "technik firma"], gate: "lieferanten:view" },
  { id: "vertrieb",   label: "Vertrieb",   sublabel: "Lead-Pipeline", href: "/vertrieb", icon: TrendingUp, keywords: ["vertrieb", "leads", "lead", "pipeline", "akquise"], gate: "vertrieb:view" },
  { id: "abrechnung", label: "Abrechnung", sublabel: "Aufträge verrechnen", href: "/abrechnung", icon: Receipt, keywords: ["abrechnung", "rechnung", "verrechnen", "rechnung stellen"], gate: "abrechnung:view" },
  { id: "datenbank",  label: "Datenbank",  sublabel: "Daten-Verwaltung", href: "/datenbank", icon: Database, keywords: ["datenbank", "daten"], gate: "admin" },
];

/** Umlaut-/Diakritik-Normalisierung: "Lohnerhöhung" == "lohnerhoehung"
 *  == "lohnerhohung". ö→o via NFD-Strip, plus ue/oe/ae→u/o/a damit die
 *  Schweizer Schreibweise mit ausgeschriebenen Umlauten auch matcht. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ae/g, "a")
    .replace(/oe/g, "o")
    .replace(/ue/g, "u")
    .replace(/ß/g, "ss");
}

/**
 * Aktionen zur Query matchen. Jedes Query-Token muss im Suchtext der
 * Aktion vorkommen (AND). Sortierung: Label-Prefix-Treffer zuerst,
 * dann Keyword-Treffer. Max `limit` Ergebnisse.
 */
export function matchActions(
  query: string,
  canFn: (slug: string) => boolean,
  isAdmin: boolean,
  limit = 6,
): PaletteAction[] {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const scored: { action: PaletteAction; score: number }[] = [];
  for (const a of PALETTE_ACTIONS) {
    // Gate pruefen — Admins duerfen immer alles (Memory-Regel; can()
    // laesst Admins via has_permission eh durch, "admin"-Gate explizit).
    if (a.gate) {
      if (a.gate === "admin") {
        if (!isAdmin) continue;
      } else if (!canFn(a.gate)) {
        continue;
      }
    }
    const label = normalize(a.label);
    const hay = [label, normalize(a.sublabel), ...a.keywords.map(normalize)].join(" ");
    if (!tokens.every((t) => hay.includes(t))) continue;
    // Score: Label-Prefix > Label enthaelt > nur Keywords.
    const score = label.startsWith(tokens[0]) ? 0 : label.includes(tokens[0]) ? 1 : 2;
    scored.push({ action: a, score });
  }
  scored.sort((x, y) => x.score - y.score);
  return scored.slice(0, limit).map((s) => s.action);
}
