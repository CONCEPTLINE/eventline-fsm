// Zentrale Registry aller Dashboard-Widgets.
//
// Wahrheit ueber:
//   - welche Widgets es gibt (WidgetId)
//   - welche Permission ein Widget braucht (requires: "modul:action"[])
//   - fuer welche Rollen es standardmaessig sichtbar ist (defaultRoles)
//
// WICHTIG: Diese Datei enthaelt bewusst KEINE Render-Funktionen / React-Komponenten,
// nur reine Config-Data. Damit kann sie sowohl server-side (in /api/dashboard und
// permission-Helpern) als auch client-side (im Rollen-Tab und Dashboard-Layout)
// importiert werden, ohne dass React-Rendering-Code mitgezogen wird.
//
// Widget-Komponenten leben in `src/app/(app)/dashboard/page.tsx` bzw. in
// `src/components/dashboard/*` und werden dort ueber die WidgetId aus dieser
// Registry aufgeloest.

import { hasPermission } from "@/lib/permissions";
import { PORTAL_ROLLEN } from "@/lib/roles";

export type WidgetId =
  | "kpi-offene-auftraege"
  | "kpi-termine-woche"
  | "kpi-nicht-abgerechnet"
  | "overdue-jobs"
  | "zu-erledigen"
  | "team-status"
  | "anwesenheitskalender"
  | "ma-monat-stunden"
  | "ma-prognose"
  | "ma-naechster-einsatz"
  | "partner-willkommen";

/**
 * Groesse eines Widgets im Dashboard-Raster (Desktop: 2 Spalten).
 *   '1x1' = eine Zelle (halb-breit, eine Reihe)
 *   '2x1' = volle Breite, eine Reihe
 *   '1x2' = halb-breit, zwei Reihen hoch
 *   '2x2' = volle Breite und zwei Reihen hoch
 *
 * Auf Mobile (1-Spalten-Layout) hat die Groesse keinen Effekt — jedes Widget
 * sitzt linear untereinander. col-span/row-span sind bewusst nur unter dem
 * `md:`-Breakpoint aktiv.
 */
export type WidgetSize = "1x1" | "2x1" | "1x2" | "2x2";

export interface DashboardWidget {
  /** Stabile ID — wird in DB (Layout-Persistenz) und URLs referenziert, niemals umbenennen. */
  id: WidgetId;
  /** UI-Label fuer den Rollen-Tab und Widget-Header. */
  title: string;
  /** Raster-Groesse im Dashboard-Grid (siehe WidgetSize). */
  size: WidgetSize;
  /**
   * Permissions die ein Nutzer braucht, damit das Widget sichtbar ist.
   * Format "modul:action" (siehe src/lib/permissions.ts). Leeres Array = keine
   * spezielle Permission noetig (jeder authentifizierte Nutzer darf es sehen).
   * Admins duerfen wie immer alles — hasPermission() gated das.
   */
  requires: string[];
  /**
   * Rollen fuer die dieses Widget in der Default-Layout-Reihenfolge auftaucht,
   * wenn der Nutzer noch kein persoenliches Layout gespeichert hat.
   */
  defaultRoles: string[];
}

/**
 * Reihenfolge in diesem Array bestimmt die Default-Anordnung im Dashboard,
 * pro Rolle gefiltert ueber `widgetsForRole()`.
 */
export const DASHBOARD_WIDGETS: readonly DashboardWidget[] = [
  {
    id: "kpi-offene-auftraege",
    title: "Offene Aufträge",
    size: "1x1",
    requires: ["auftraege:view"],
    defaultRoles: ["admin"],
  },
  {
    id: "kpi-termine-woche",
    title: "Termine nächste 7 Tage",
    size: "1x1",
    requires: ["kalender:view"],
    defaultRoles: ["admin"],
  },
  {
    id: "kpi-nicht-abgerechnet",
    title: "Nicht abgerechnet",
    size: "1x1",
    requires: ["abrechnung:view"],
    defaultRoles: ["admin"],
  },
  {
    id: "overdue-jobs",
    title: "Überfällige Aufträge",
    size: "2x1",
    requires: ["auftraege:view"],
    defaultRoles: ["admin"],
  },
  {
    id: "zu-erledigen",
    title: "Zu erledigen",
    size: "1x1",
    // Zeigt Ferien-Antraege + ueberfaellige Auftraege + neue Belege — jede
    // Zeile linkt in einen der Admin-Bereiche. Ohne Permission triggert
    // sonst der loader='admin' die vollen 10 Admin-Counts (RLS gibt sie
    // dann eh nicht raus, aber die Queries laufen).
    requires: ["auftraege:view"],
    defaultRoles: ["admin"],
  },
  {
    id: "team-status",
    title: "Team-Status",
    size: "1x1",
    requires: ["stempelzeiten:see-all"],
    defaultRoles: ["admin"],
  },
  {
    id: "anwesenheitskalender",
    title: "Büro-Anwesenheit",
    size: "2x2",
    requires: ["anwesenheit:view"],
    defaultRoles: ["admin", "techniker"],
  },
  {
    id: "ma-monat-stunden",
    title: "Meine Stunden diesen Monat",
    size: "1x1",
    requires: [],
    defaultRoles: ["techniker"],
  },
  {
    id: "ma-prognose",
    title: "Prognose Monatsende",
    size: "1x1",
    requires: [],
    defaultRoles: ["techniker"],
  },
  {
    id: "ma-naechster-einsatz",
    title: "Nächster Einsatz",
    size: "2x1",
    requires: ["kalender:view"],
    defaultRoles: ["techniker"],
  },
  {
    id: "partner-willkommen",
    title: "Willkommen im Partner-Portal",
    size: "2x1",
    requires: [],
    defaultRoles: ["partner"],
  },
] as const;

/**
 * Tailwind-Klassen fuer die Positionierung eines Widgets im 2-Spalten-Grid
 * (siehe Dashboard-Renderer). Mobile bleibt bewusst 1-spaltig — `md:`-Prefixe
 * verhindern, dass col-span/row-span dort reinreissen.
 */
export function widgetSizeClasses(size: WidgetSize): string {
  switch (size) {
    case "1x1":
      return "";
    case "2x1":
      return "md:col-span-2";
    case "1x2":
      return "md:row-span-2";
    case "2x2":
      return "md:col-span-2 md:row-span-2";
  }
}

/**
 * Default-Widget-Reihenfolge fuer eine Rolle — alle Widgets deren
 * `defaultRoles` die Rolle enthalten, in Registry-Reihenfolge.
 *
 * Wird genutzt, wenn ein Nutzer noch kein persoenliches Layout gespeichert hat
 * bzw. der Rollen-Tab in den Einstellungen einen "Zuruecksetzen"-Default zeigt.
 *
 * FALLBACK fuer frei definierte Rollen (kein defaultRoles-Match, z.B. eine
 * neue "Buchhaltung"-Rolle): statt eines LEEREN Dashboards alle Widgets,
 * deren `requires`-Permissions die Rolle erfuellt (hasPermission — Admins
 * passen automatisch durch). Reine Portal-Widgets (defaultRoles nur
 * Portal-Rollen, z.B. partner-willkommen) bleiben dabei aussen vor —
 * die waeren fuer eine interne Rolle sichtbar falsch.
 */
export function widgetsForRole(role: string, permissions: string[] = []): WidgetId[] {
  const byDefault = DASHBOARD_WIDGETS.filter((w) => w.defaultRoles.includes(role));
  if (byDefault.length > 0) return byDefault.map((w) => w.id);
  return DASHBOARD_WIDGETS
    .filter((w) =>
      !(w.defaultRoles.length > 0 && w.defaultRoles.every((r) => (PORTAL_ROLLEN as readonly string[]).includes(r))) &&
      w.requires.every((p) => hasPermission(permissions, role, p)),
    )
    .map((w) => w.id);
}

/**
 * Widget-Metadaten per ID abfragen. Liefert `undefined` fuer unbekannte IDs
 * (z. B. veraltete DB-Layout-Eintraege) — Caller entscheidet, wie damit umgegangen wird.
 */
export function widgetById(id: WidgetId): DashboardWidget | undefined {
  return DASHBOARD_WIDGETS.find((w) => w.id === id);
}

/**
 * Column-Span-Klassen pro Widget im 12-Spalten-Grid (Tailwind).
 *
 * Single source of truth fuer sowohl das Dashboard-Layout
 * (src/app/(app)/dashboard/page.tsx) als auch die Vorschau im
 * Personalisierungs-Modal (src/components/dashboard/dashboard-preferences-modal.tsx).
 * Beide Files importieren aus dieser Konstante — damit koennen sie nicht
 * mehr auseinanderdriften, wenn ein Widget umsortiert wird.
 *
 * Fehlt ein Eintrag -> volle Breite (`col-span-12`). Neue Widget-IDs die in
 * die Registry kommen, brauchen also nur hier einen Eintrag um in Vorschau
 * und Live-Layout korrekt gerendert zu werden.
 */
export const WIDGET_SPAN: Record<WidgetId, string> = {
  "kpi-offene-auftraege": "col-span-12 sm:col-span-4",
  "kpi-termine-woche": "col-span-12 sm:col-span-4",
  "kpi-nicht-abgerechnet": "col-span-12 sm:col-span-4",
  "overdue-jobs": "col-span-12",
  "zu-erledigen": "col-span-12 lg:col-span-6",
  "team-status": "col-span-12 lg:col-span-6",
  "anwesenheitskalender": "col-span-12",
  "ma-monat-stunden": "col-span-12 lg:col-span-6",
  "ma-prognose": "col-span-12 lg:col-span-6",
  "ma-naechster-einsatz": "col-span-12",
  "partner-willkommen": "col-span-12",
};

/** Lookup wrapper mit Default-Fallback auf volle Breite. */
export function widgetSpanClass(id: string): string {
  return (WIDGET_SPAN as Record<string, string | undefined>)[id] ?? "col-span-12";
}

/** Numerischer Default-Span (4/6/8/12) pro Widget. Wird aus der WIDGET_SPAN-
 *  Klasse extrahiert (letzter col-span-N-Match) und dient als Fallback wenn
 *  der User keinen Widget-Span-Override gesetzt hat. Mobile-Verhalten bleibt
 *  ausserhalb — die WIDGET_SPAN-Klasse liefert weiterhin die responsive
 *  Prefixes (col-span-12 sm:col-span-4). */
export function widgetDefaultSpan(id: string): number {
  const cls = widgetSpanClass(id);
  const matches = [...cls.matchAll(/col-span-(\d+)/g)];
  if (matches.length === 0) return 12;
  const last = matches[matches.length - 1]?.[1];
  const n = last ? parseInt(last, 10) : 12;
  return n === 4 || n === 6 || n === 8 || n === 12 ? n : 12;
}

/** Baut die effektive Grid-Klasse aus dem User-Override (falls vorhanden)
 *  oder dem Registry-Default. Mobil (col-span-12) bleibt immer identisch —
 *  Overrides gelten nur ab dem sm:-Breakpoint (echtes Dashboard-Grid).
 *
 *  WICHTIG: Klassen-Strings sind LITERAL — dynamisch zusammengebaute Tailwind-
 *  Klassen wie `sm:col-span-${n}` werden vom Tailwind-Compiler nicht erkannt
 *  und landen NICHT im CSS-Bundle (die Kachel bleibt dann silent auf 12).
 *  Deshalb hier ein festes Mapping mit allen erlaubten Werten als Literale. */
export function widgetEffectiveSpanClass(
  id: string,
  override: number | undefined,
): string {
  const span = override ?? widgetDefaultSpan(id);
  switch (span) {
    case 4:
      return "col-span-12 sm:col-span-4";
    case 6:
      return "col-span-12 sm:col-span-6";
    case 8:
      return "col-span-12 sm:col-span-8";
    case 12:
    default:
      return "col-span-12";
  }
}
