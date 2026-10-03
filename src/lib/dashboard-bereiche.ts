// Feste Bereiche des Dashboards (ersetzt den frueheren Widget-Baukasten).
//
// Das Dashboard ist fest gestaltet: ein Raster aus drei Reihen zu je zwei
// Plaetzen (links 58 %, rechts 42 %): [Aufmerksamkeit | Team],
// [Anwesenheit | Als Naechstes], [Naechster Einsatz | Mein Monat]. Fehlt ein
// Nachbar, nimmt die Karte die ganze Reihe; leere Reihen entfallen; Karten
// einer Reihe sind gleich hoch (Vorlage: scratchpad dashboards/Main.dc.html).
// Nutzer koennen nichts verschieben oder ausblenden. Was jemand sieht, folgt aus
//   1. den Rechten der Rolle (und ihrem Sichtbereich self/team/all),
//   2. den Rollen-Schaltern `roles.dashboard_bereiche_aus` (Ein/Aus je
//      Bereich, keine Reihenfolge, keine Breiten) — z. B. Projekt-Leiter
//      ohne «Braucht Aufmerksamkeit» und ohne «Team».
// Admins sehen immer alle Firmen-Bereiche, aber keine persoenlichen
// (eigener Einsatz, eigener Monat) — Entscheid Mischa 2026-10-02.

export type DashboardBereichKey =
  | "kennzahlen"
  | "aufmerksamkeit"
  | "anwesenheit"
  | "team"
  | "naechste"
  | "einsatz"
  | "monat";

export type DashboardSpalte = "kopf" | "links" | "rechts";

export interface DashboardBereich {
  key: DashboardBereichKey;
  label: string;
  /** Ein Satz fuer den Rollen-Editor. */
  beschreibung: string;
  /** Wo der Bereich im festen Layout sitzt. */
  spalte: DashboardSpalte;
  /** Persoenliche Bereiche (eigene Daten) — fuer Admins nie sichtbar. */
  persoenlich: boolean;
  /** Fuer den Rollen-Editor: welches Recht den Bereich freischaltet (Klartext). */
  rechtHinweis: string;
}

export const DASHBOARD_BEREICHE: readonly DashboardBereich[] = [
  {
    key: "kennzahlen",
    label: "Kennzahlen",
    beschreibung: "Offene Aufträge und Termine der nächsten 7 Tage oben neben dem Gruss.",
    spalte: "kopf",
    persoenlich: false,
    rechtHinweis: "Aufträge ansehen oder Kalender ansehen",
  },
  {
    key: "aufmerksamkeit",
    label: "Braucht Aufmerksamkeit",
    beschreibung: "Nur was ansteht: überfällige Aufträge, Anfragen, Anträge, Belege, Tickets.",
    spalte: "links",
    persoenlich: false,
    rechtHinweis: "Aufträge ansehen",
  },
  {
    key: "anwesenheit",
    label: "Anwesenheit",
    beschreibung: "Büro-Anwesenheit der nächsten 7 Tage, eigene Zeile bearbeitbar.",
    spalte: "links",
    persoenlich: false,
    rechtHinweis: "Anwesenheit ansehen",
  },
  {
    key: "team",
    label: "Team",
    beschreibung: "Wer eingestempelt oder abwesend ist — bei Team-Leitern nur das eigene Team.",
    spalte: "rechts",
    persoenlich: false,
    rechtHinweis: "Stempelzeiten aller sehen oder Sichtbereich «Team»",
  },
  {
    key: "naechste",
    label: "Als Nächstes",
    beschreibung: "Die kommenden Aufträge der nächsten 7 Tage — bei Team-Leitern nur die mit eigenem Team.",
    spalte: "rechts",
    persoenlich: false,
    rechtHinweis: "Aufträge ansehen und Kalender ansehen (nicht bei Sichtbereich «Nur ich»)",
  },
  {
    key: "einsatz",
    label: "Nächster Einsatz",
    beschreibung: "Der eigene nächste Einsatz mit Zeit und Ort.",
    spalte: "rechts",
    persoenlich: true,
    rechtHinweis: "Kalender ansehen",
  },
  {
    key: "monat",
    label: "Mein Monat",
    beschreibung: "Eigene Stunden bisher und Prognose zum Monatsende.",
    spalte: "rechts",
    persoenlich: true,
    rechtHinweis: "kein besonderes Recht",
  },
] as const;

export const DASHBOARD_BEREICH_KEYS: readonly DashboardBereichKey[] = DASHBOARD_BEREICHE.map((b) => b.key);

export function istDashboardBereich(x: unknown): x is DashboardBereichKey {
  return typeof x === "string" && (DASHBOARD_BEREICH_KEYS as readonly string[]).includes(x);
}

export interface DashboardSichtKontext {
  isAdmin: boolean;
  /** Permission-Pruefung der Rolle (Admins: immer true). */
  hat: (permission: string) => boolean;
  scope: "self" | "team" | "all";
  /** roles.dashboard_bereiche_aus — fuer Admins ignoriert. */
  aus?: readonly string[] | null;
}

/** Darf die Rolle den Bereich ueberhaupt sehen (nur Rechte, ohne Schalter)? */
export function bereichErlaubt(key: DashboardBereichKey, ctx: DashboardSichtKontext): boolean {
  const def = DASHBOARD_BEREICHE.find((b) => b.key === key);
  if (!def) return false;
  if (def.persoenlich && ctx.isAdmin) return false;
  switch (key) {
    case "kennzahlen":
      return ctx.hat("auftraege:view") || ctx.hat("kalender:view");
    case "aufmerksamkeit":
      return ctx.hat("auftraege:view");
    case "anwesenheit":
      return ctx.hat("anwesenheit:view");
    case "team":
      return ctx.hat("stempelzeiten:see-all") || ctx.scope === "team";
    case "naechste":
      return ctx.hat("auftraege:view") && ctx.hat("kalender:view") && ctx.scope !== "self";
    case "einsatz":
      return ctx.hat("kalender:view");
    case "monat":
      return true;
  }
}

/** Sichtbare Bereiche = erlaubt (Rechte) UND nicht per Rollen-Schalter aus. */
export function sichtbareBereiche(ctx: DashboardSichtKontext): Set<DashboardBereichKey> {
  const aus = new Set(ctx.isAdmin ? [] : (ctx.aus ?? []));
  const sichtbar = new Set<DashboardBereichKey>();
  for (const b of DASHBOARD_BEREICHE) {
    if (aus.has(b.key)) continue;
    if (bereichErlaubt(b.key, ctx)) sichtbar.add(b.key);
  }
  return sichtbar;
}
