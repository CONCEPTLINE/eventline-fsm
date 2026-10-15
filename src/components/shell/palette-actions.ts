// Aktionen-Katalog fuer die Cmd-K-Palette.
//
// Zwei Quellen, zusammengefuehrt in paletteEintraege():
//   1. PALETTE_ACTIONS — statischer Katalog von App-Aktionen/Zielen mit
//      deutschen Synonymen — "krank" fuehrt zu Abwesenheit melden,
//      "lohnerhoehung" zu HR › Lohn, usw.
//   2. Seiten — exakt die Sidebar (sichtbareNavGruppen: gleiche Labels,
//      gleiche Sichtbarkeit). SEITEN_INFO ergaenzt nur Unterzeile und
//      Suchbegriffe; eine eigene Seitenliste gibt es nicht mehr. Der
//      Bereichs-Name (Geschäft, Kontakte, HR, Finanzen, Admin) steht vorne
//      in der Unterzeile und ist Suchbegriff («hr» findet alle HR-Seiten).
// Matching ist client-seitig (kein API-Call): Query-Tokens werden
// umlaut-normalisiert und muessen ALLE im Suchtext (Label + Keywords +
// Sublabel) vorkommen.
//
// Permission-Gating: sensible Ziele tragen ein `gate` — Permission-Slug
// (via hasPermission, Admins passen automatisch durch — Memory-Regel) oder
// "admin" fuer Ziele, die nur Admins oeffnen koennen (sonst zeigt die
// Palette eine Aktion, die auf der Zielseite zurueckspringt). Ungegatete
// Aktionen sieht jeder; die Zielseite gated notfalls selbst nochmal
// (Defense in depth).

import {
  CalendarOff, Clock, ClipboardList, FileText, Wallet, FileStack,
  Timer, Percent, TicketCheck, Users, Shield, ShieldCheck, Building2,
  Plug, Handshake, UserCircle, Compass, CalendarCheck, Truck, LayoutDashboard,
} from "lucide-react";
import { sichtbareNavGruppen } from "@/lib/constants";
import { NAV_ICON_MAP, type IconComponent } from "@/lib/nav-icons";
import { hasPermission } from "@/lib/permissions";

export interface PaletteAction {
  /** Stabile ID (fuer React-Keys). */
  id: string;
  label: string;
  /** Wohin es fuehrt — als Erklaerung unter dem Label. */
  sublabel: string;
  href: string;
  icon: IconComponent;
  /** Synonyme/Suchbegriffe (klein, ohne Umlaut-Zwang — wird normalisiert). */
  keywords: string[];
  /** Optional: Permission-Slug (via hasPermission) oder "admin" (via role). */
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
    gate: "stempelzeiten:view",
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
    sublabel: "HR › Lohn › Mitarbeiter-Lohn (Lohn ändern oder Erhöhung planen)",
    href: "/lohn?ansicht=team&tab=mitarbeiter",
    icon: Wallet,
    keywords: ["lohn", "lohnerhoehung", "gehalt", "gehaltserhoehung", "salaer", "stundenlohn", "lohn aendern", "verdienst", "brutto"],
    gate: "lohn:manage",
  },
  {
    id: "lohnabrechnungen",
    label: "Lohnabrechnungen",
    sublabel: "HR › Lohn › Lohndokumente (Monats-Abrechnungen)",
    href: "/lohn?ansicht=team&tab=dokumente",
    icon: FileStack,
    keywords: ["lohnabrechnung", "lohn pdf", "abrechnung lohn", "payslip", "lohnzettel"],
    gate: "lohn:manage",
  },
  {
    id: "monatsstunden",
    label: "Monatsstunden",
    sublabel: "HR › Lohn › Monatsstunden (Stunden-Übersicht pro MA)",
    href: "/lohn?ansicht=team&tab=monatsstunden",
    icon: Timer,
    keywords: ["monatsstunden", "stunden uebersicht", "stundenkontrolle", "soll ist"],
    gate: "lohn:manage",
  },
  {
    id: "lohn-standardwerte",
    label: "Lohn-Standardwerte",
    sublabel: "HR › Lohn › Standardwerte (AHV/ALV/BVG-Sätze)",
    href: "/lohn?ansicht=team&tab=standardwerte",
    icon: Percent,
    keywords: ["standardwerte", "abzuege", "ahv", "alv", "bvg", "sozialleistungen", "arbeitgeberanteil", "quellensteuer"],
    gate: "lohn:manage",
  },
  {
    id: "abwesenheit-genehmigen",
    label: "Abwesenheit genehmigen",
    sublabel: "HR › Anträge (offene Anträge prüfen)",
    href: "/antraege",
    icon: CalendarCheck,
    keywords: ["abwesenheit genehmigen", "ferien genehmigen", "urlaubsantraege", "antraege pruefen", "abwesenheiten genehmigen", "ferienantrag"],
    gate: "ferien:approve",
  },

  // ─── Verwaltung ────────────────────────────────────────────────
  {
    id: "team",
    label: "Mitarbeiter verwalten",
    sublabel: "Einstellungen › Mitarbeiter (anlegen, bearbeiten, deaktivieren)",
    href: "/einstellungen?tab=mitarbeiter",
    icon: Users,
    keywords: ["mitarbeiter", "team", "benutzer", "user", "neuer mitarbeiter", "mitarbeiter anlegen", "einladen", "deaktivieren"],
    gate: "admin",
  },
  {
    id: "rollen",
    label: "Rollen & Rechte",
    sublabel: "Einstellungen › Rollen (Berechtigungen pro Rolle)",
    href: "/einstellungen?tab=rollen",
    icon: Shield,
    keywords: ["rollen", "rechte", "berechtigungen", "permissions", "zugriff"],
    gate: "admin",
  },
  {
    id: "firma",
    label: "Firmen-Stammdaten",
    sublabel: "Einstellungen › Firma",
    href: "/einstellungen?tab=firma",
    icon: Building2,
    keywords: ["firma", "stammdaten", "firmendaten", "adresse firma"],
    gate: "admin",
  },
  {
    // Einziger Einstellungen-Tab fuer Nicht-Admins (persoenliches Bexio-/
    // Kalender-Setup) — daher einstellungen:view statt "admin".
    id: "integrationen",
    label: "Integrationen",
    sublabel: "Einstellungen › Integrationen (Bexio)",
    href: "/einstellungen?tab=integrationen",
    icon: Plug,
    keywords: ["integration", "bexio", "schnittstelle", "api"],
    gate: "einstellungen:view",
  },
  {
    id: "sicherheit",
    label: "Sicherheit",
    sublabel: "Einstellungen › Sicherheit (Anmeldungen, vertraute Geräte, Entwickler-Modus)",
    href: "/einstellungen?tab=sicherheit",
    icon: ShieldCheck,
    keywords: ["sicherheit", "anmeldungen", "login", "aktivitaet", "geraete", "vertraute geraete", "entwickler", "developer", "ansicht als", "system"],
    gate: "admin",
  },
  {
    id: "partner-zugaenge",
    label: "Partner-Zugänge",
    sublabel: "Einstellungen › Partnerportal › Zugänge",
    href: "/einstellungen?tab=partner",
    icon: Handshake,
    keywords: ["partner", "partnerportal", "partner user", "locationpartner", "partner verwalten", "zugang", "zugaenge"],
    gate: "admin",
  },
  {
    id: "lieferanten-zugaenge",
    label: "Lieferanten-Zugänge",
    sublabel: "Einstellungen › Lieferantenportal › Zugänge",
    href: "/einstellungen?tab=lieferant",
    icon: Truck,
    keywords: ["lieferantenportal", "lieferant zugang", "lieferanten zugang", "portal", "zugang", "zugaenge", "lieferant user"],
    gate: "admin",
  },
  {
    id: "anleitung",
    label: "Anleitung & Neuerungen",
    sublabel: "Was ist neu in der App — mit Anleitungen zu allen Funktionen",
    href: "/anleitung",
    icon: FileText,
    keywords: ["anleitung", "hilfe", "neuerungen", "was ist neu", "neu", "features", "handbuch", "guide", "erklaerung"],
  },
  {
    id: "mein-konto",
    label: "Mein Konto",
    sublabel: "Profil, Passwort, mein Lohn",
    href: "/mein-konto",
    icon: UserCircle,
    keywords: ["konto", "profil", "passwort", "passwort aendern", "mein lohn", "account", "einstellungen persoenlich"],
  },

  // ─── Seiten mit eigener Zeile (Sidebar-Seiten kommen aus NAV_GROUPS) ──
  { id: "vertrieb",   label: "Akquise",    sublabel: "Locations suchen", href: "/vertrieb", icon: Compass, keywords: ["akquise", "location", "locations", "suche", "kooperation", "vertrieb"], gate: "vertrieb:view" },
];

/** Unterzeile + Suchbegriffe je Sidebar-Seite (Label/Icon/Sichtbarkeit
 *  kommen aus NAV_GROUPS). Die Unterzeile bekommt den Bereichs-Namen
 *  vorangestellt; fehlt ein Eintrag, steht nur der Bereichs-Name. */
const SEITEN_INFO: Record<string, { sublabel: string; keywords: string[] }> = {
  "/dashboard":     { sublabel: "Übersicht", keywords: ["dashboard", "uebersicht", "start", "home"] },
  "/todos":         { sublabel: "Todo-Liste öffnen und erstellen", keywords: ["todo", "aufgabe", "task", "todo erstellen", "erledigen"] },
  "/kalender":      { sublabel: "Termine & Einsätze", keywords: ["kalender", "termine", "agenda"] },
  "/entwuerfe":     { sublabel: "Auftrags-Entwürfe", keywords: ["entwuerfe", "entwurf", "draft"] },
  "/auftraege":     { sublabel: "Alle Aufträge", keywords: ["auftraege", "auftrag suchen", "jobs", "einsaetze"] },
  "/projekte":      { sublabel: "Interne Projekte", keywords: ["projekte", "projekt", "intern"] },
  "/kunden":        { sublabel: "Kundenverzeichnis", keywords: ["kunden", "kunde", "kundenliste", "datenbank"] },
  "/locations":     { sublabel: "Verwaltungen und Räume (Verrechnungssätze in der Verwaltung)", keywords: ["location", "standorte", "standort", "verwaltung", "raeume", "raum", "verrechnungssatz", "verrechnungssaetze", "stundensatz", "pikett"] },
  "/lieferanten":   { sublabel: "Catering, Technik, AV", keywords: ["lieferanten", "lieferant", "catering", "technik firma", "datenbank"] },
  "/antraege":      { sublabel: "Offene Anträge prüfen und genehmigen", keywords: ["antraege", "anfragen", "genehmigen", "personal"] },
  "/stempelzeiten": { sublabel: "Ein-/Ausstempeln und Zeiterfassung", keywords: ["stempelzeiten", "stempeln", "zeiterfassung", "personal"] },
  "/tickets":       { sublabel: "Tickets und Belege", keywords: ["tickets", "ticket", "beleg", "belege", "spesen", "quittung"] },
  "/ferien":        { sublabel: "Ferien, Krankheit, Militär", keywords: ["abwesenheit", "ferien", "krank", "urlaub", "personal"] },
  "/lohn":          { sublabel: "Lohnabrechnungen und Lohnausweise", keywords: ["lohn", "loehne", "lohnabrechnung", "lohnausweis", "gehalt", "personal"] },
  "/abrechnung":    { sublabel: "Aufträge verrechnen", keywords: ["abrechnung", "rechnung", "rechnungen", "verrechnen", "rechnung stellen"] },
  "/nas":           { sublabel: "Dokumente ins NAS ablegen", keywords: ["ablage", "nas", "ablegen", "dokumente ablegen"] },
  "/technik":       { sublabel: "Rig, lokale KI, NAS, Backup", keywords: ["technik", "rig", "ki", "server", "backup", "system"] },
  "/einstellungen": { sublabel: "Firma, Mitarbeiter, Rollen, Integrationen, Sicherheit, Portale", keywords: ["einstellungen", "konfiguration", "settings"] },
};

/** Alles, was die Palette dieser Rolle anbieten darf: Aktionen (nach
 *  `gate` gefiltert) + die Sidebar-Seiten genau so, wie die Sidebar sie
 *  dieser Rolle zeigt. Seiten, zu denen eine sichtbare Aktion mit
 *  gleichem Ziel existiert (Vertrieb → «Akquise», Stempelzeiten …),
 *  erscheinen nicht doppelt — die Aktion uebernimmt dann Seiten-Name,
 *  Bereich und Suchbegriffe, damit die Seite unter ihrem Sidebar-Namen
 *  auffindbar bleibt (z. B. «Belege» → Ticket erstellen → /tickets). */
export function paletteEintraege(permissions: string[], role: string): PaletteAction[] {
  const isAdmin = role === "admin";
  const gruppen = sichtbareNavGruppen(permissions, role);
  const seitenBegriffe = new Map<string, string[]>();
  for (const g of gruppen) {
    for (const item of g.items) {
      // palette: false (z. B. Finanzen) — weder als Seite noch als Suchbegriff.
      if (item.palette === false) continue;
      seitenBegriffe.set(item.href, [
        item.label,
        ...(g.label ? [g.label] : []),
        ...(SEITEN_INFO[item.href]?.keywords ?? []),
      ]);
    }
  }
  const aktionen = PALETTE_ACTIONS.filter((a) => {
    if (!a.gate) return true;
    // Admins duerfen immer alles (Memory-Regel; hasPermission laesst
    // Admins eh durch, "admin"-Gate explizit).
    return a.gate === "admin" ? isAdmin : hasPermission(permissions, role, a.gate);
  }).map((a) => {
    const extra = seitenBegriffe.get(a.href);
    return extra ? { ...a, keywords: [...a.keywords, ...extra] } : a;
  });
  // Nur SICHTBARE Aktionen mit GLEICHEM Namen verdraengen eine Seite —
  // sonst verschwaende z. B. «Anträge» fuer tickets:manage ohne
  // ferien:approve ganz, oder «Abwesenheit» stuende nur als «Abwesenheit
  // melden» da (Sidebar-Name = Palette-Name).
  const eigeneZeile = new Set(aktionen.map((a) => `${a.href}|${a.label}`));
  const seiten: PaletteAction[] = gruppen.flatMap((g) =>
    g.items
      .filter((item) => item.palette !== false && !eigeneZeile.has(`${item.href}|${item.label}`))
      .map((item) => {
        const info = SEITEN_INFO[item.href];
        const sublabel = info
          ? (g.label ? `${g.label} · ${info.sublabel}` : info.sublabel)
          : (g.label || item.label);
        return {
          id: `seite-${item.href}`,
          label: item.label,
          sublabel,
          href: item.href,
          icon: NAV_ICON_MAP[item.icon] ?? LayoutDashboard,
          keywords: [...(g.label ? [g.label] : []), ...(info?.keywords ?? [])],
        };
      }),
  );
  return [...aktionen, ...seiten];
}

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
 * Eintraege (aus paletteEintraege) zur Query matchen. Jedes Query-Token
 * muss im Suchtext des Eintrags vorkommen (AND). Sortierung: Label-Prefix-
 * Treffer zuerst, dann Keyword-Treffer. Max `limit` Ergebnisse.
 */
export function matchActions(
  query: string,
  eintraege: PaletteAction[],
  limit = 6,
): PaletteAction[] {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const scored: { action: PaletteAction; score: number }[] = [];
  for (const a of eintraege) {
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
