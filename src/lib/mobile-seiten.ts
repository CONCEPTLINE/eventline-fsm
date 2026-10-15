// Mobile-Schicht: welche Seite am Handy wie heisst und wie sie behandelt
// wird. EINE Quelle fuer den mobilen Kopf (Titel), das Mehr-Sheet (Eintraege)
// und den Hinweis-Balken («Am Computer besser bedienbar»).
//
// Entscheid (Mischa 2026-10-11): Alles, was man im Feld nicht operativ
// braucht, bleibt Buero. Buero-Seiten werden am Handy NICHT gesperrt, sie
// bekommen nur den Hinweis — Deep-Links aus Mails funktionieren weiter.

import { NAV_GROUPS, ADMIN_NAV_GROUP } from "@/lib/constants";

/** Window-Event, mit dem der Abmelde-Knopf in «Mein Konto» (Handy) die
 *  Abmelde-Logik des (app)-Layouts ruft. Liegt hier und nicht in
 *  mein-konto-mobil.tsx, damit das Layout nicht dessen Modulgraph
 *  (Konto-Karten, Passkeys …) in jeden Seiten-Chunk zieht. */
export const ABMELDEN_EVENT = "eventline:abmelden";

/** Seiten, die fuer die Arbeit im Feld gebaut sind (oder dort gebraucht
 *  werden). Alles andere ist Buero. */
const FELD_PREFIXES = [
  "/dashboard",
  "/kalender",
  "/todos",
  "/auftraege",
  "/stempelzeiten",
  "/tickets",
  "/ferien",
  "/mein-konto",
  "/locations",
  "/standorte",
  "/raeume",
  "/anleitung",
];

/** Ausnahmen innerhalb der Feld-Bereiche, die trotzdem Buero sind
 *  (Formulare und Reports, die am Computer gemacht werden). */
const BUERO_REGEX = [
  /^\/auftraege\/neu(\/|$)/,
  /^\/auftraege\/[^/]+\/bearbeiten(\/|$)/,
  /^\/standorte\/[^/]+\/report(\/|$)/,
];

function reinerPfad(pathname: string): string {
  const q = pathname.indexOf("?");
  return q === -1 ? pathname : pathname.slice(0, q);
}

/** true = Seite ist Buero-Arbeit → am Handy Hinweis-Balken. */
export function istBueroSeite(pathname: string): boolean {
  const p = reinerPfad(pathname);
  if (BUERO_REGEX.some((re) => re.test(p))) return true;
  return !FELD_PREFIXES.some((pre) => p === pre || p.startsWith(pre + "/"));
}

/** Titel im mobilen Kopf: Nav-Label (gleiche Woerter wie am Desktop) plus
 *  die Seiten, die keinen eigenen Nav-Eintrag haben. Reihenfolge = erster
 *  Treffer gewinnt, darum stehen Tiefere vor Allgemeinen. */
const EXTRA_TITEL: Array<[string, string]> = [
  // Finanzen-Übersicht: Nav-Label ist «Übersicht», am Handy sagt der Kopf
  // «Finanzen» (Buero-Seite → Hinweis-Balken kommt automatisch).
  ["/finanzen", "Finanzen"],
  ["/stempelzeiten", "Stempelzeiten"],
  ["/tickets", "Tickets & Belege"],
  ["/ferien", "Abwesenheit"],
  ["/mein-konto", "Mein Konto"],
  ["/anleitung", "Anleitung"],
  ["/standorte", "Locations"],
  ["/raeume", "Locations"],
  ["/kunden", "Kunden"],
  ["/lieferanten", "Lieferanten"],
  ["/ablage", "Ablage"],
];

const NAV_TITEL: Array<[string, string]> = [...NAV_GROUPS, ADMIN_NAV_GROUP]
  .flatMap((g) => g.items)
  .map((i) => [reinerPfad(i.href), i.label]);

export function titelFuerPfad(pathname: string): string {
  const p = reinerPfad(pathname);
  const alle = [...EXTRA_TITEL, ...NAV_TITEL];
  const hit = alle.find(([pre]) => p === pre || p.startsWith(pre + "/"));
  return hit ? hit[1] : "EVENTLINE";
}

/** Wurzel des Bereichs (z. B. /auftraege/abc → /auftraege). Fuer den
 *  Zurueck-Pfeil im mobilen Kopf, wenn die Seite keine Breadcrumbs setzt. */
export function bereichsWurzel(pathname: string): string | null {
  const p = reinerPfad(pathname);
  const teile = p.split("/").filter(Boolean);
  if (teile.length < 2) return null;
  return "/" + teile[0];
}

/** Eintraege des Mehr-Sheets. Rechte werden beim Rendern per isPathAllowed
 *  geprueft (Admin sieht alles). Nur Feld-Werkzeuge — Buero bleibt Desktop. */
export const MEHR_ICH = [
  { href: "/stempelzeiten", label: "Stempelzeiten" },
  { href: "/tickets", label: "Tickets & Belege" },
  { href: "/ferien", label: "Abwesenheit" },
  { href: "/mein-konto", label: "Mein Konto" },
] as const;

export const MEHR_ARBEIT = [
  { href: "/auftraege", label: "Aufträge" },
  { href: "/locations", label: "Locations" },
] as const;

/** Pfade, bei denen der Nav-Platz «Mehr» als aktiv gilt. */
export function istMehrBereich(pathname: string): boolean {
  const p = reinerPfad(pathname);
  return [...MEHR_ICH, ...MEHR_ARBEIT].some(
    (e) => p === e.href || p.startsWith(e.href + "/"),
  ) || p.startsWith("/standorte") || p.startsWith("/raeume");
}
