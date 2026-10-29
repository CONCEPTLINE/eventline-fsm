// Wartungsmodus für Umbauten (Wunsch Mischa, 29.10.2026; Migration 363).
//
// Ist ein Bereich in Wartung, zeigen seine Seiten statt des Inhalts eine
// ruhige Hinweisseite und seine API-Routen antworten 503 mit WARTUNG_MELDUNG.
// Ausnahmen (Profil-IDs in public.wartung.ausnahmen, z. B. Mischa) arbeiten
// normal und sehen einen Hinweisbalken «Wartung aktiv».
//
// Diese Datei ist rein (Browser + Server): Bereiche, Texte, Regeln, Cache.
// Laden aus der DB und die 503-Antwort: src/lib/wartung-server.ts.
// Eingebunden zentral in src/lib/api-auth.ts (requirePermission nach Recht,
// requireUser/requireInternal/requireAdmin mit { wartung }), in den Layouts
// der Seiten (src/components/wartung/wartung-seite.tsx) und im Cron
// /api/cron/auto-lohnabrechnung (pausiert den Lauf).
//
// Schalten: Einstellungen › Sicherheit (Admins, vertrautes Gerät) oder
// node scripts/wartung.mjs an|aus|status|ausnahmen.

export const WARTUNG_BEREICHE = ["lohn", "rechte", "geraete", "finanzen"] as const;
export type WartungBereich = (typeof WARTUNG_BEREICHE)[number];

export const WARTUNG_BEREICH_INFO: Record<WartungBereich, { label: string; umfang: string }> = {
  lohn: {
    label: "Lohn",
    umfang: "Lohn-Seite (Meine + Team), Lohndokumente, Monatsstunden, Generieren, BVG-Prognose, automatischer Lohnlauf",
  },
  rechte: {
    label: "Rechte",
    umfang: "Mitarbeiter, Rollen, Partner- und Lieferanten-Zugänge, Rechte-Anträge",
  },
  geraete: {
    label: "Geräte",
    umfang: "Gerätefreigabe und neue Geräte-Anfragen",
  },
  finanzen: {
    label: "Finanzen",
    umfang: "Finanzen-Seite und Finanzdaten",
  },
};

export const WARTUNG_KONTAKT = {
  name: "Mischa Dittus",
  mail: "mischa@eventline-basel.com",
  telefon: "079 614 93 83",
  telefonLink: "tel:+41796149383",
} as const;

/** Wortgleich auf der Hinweisseite und in der 503-Antwort (Toast). */
export const WARTUNG_MELDUNG =
  `Diese Funktion ist im Moment wegen Umbauten nicht möglich. Bitte ${WARTUNG_KONTAKT.name} kontaktieren: ` +
  `${WARTUNG_KONTAKT.mail} · ${WARTUNG_KONTAKT.telefon}`;

/** `code` in der 503-Antwort. */
export const WARTUNG_FEHLER_CODE = "wartung";

export interface WartungStand {
  /** Bereiche in Wartung, feste Reihenfolge wie WARTUNG_BEREICHE. */
  bereiche: WartungBereich[];
  grund: string | null;
  /** ISO-Zeitpunkt, seit dem (mindestens ein Bereich) in Wartung ist. */
  seit: string | null;
  /** Profil-IDs, die trotz Wartung arbeiten. */
  ausnahmen: string[];
}

export const KEINE_WARTUNG: WartungStand = Object.freeze({ bereiche: [], grund: null, seit: null, ausnahmen: [] }) as WartungStand;

/** frei = keine Wartung; gesperrt = Hinweis/503; ausnahme = normal + Balken. */
export type WartungZugang = "frei" | "gesperrt" | "ausnahme";

export function istWartungBereich(x: unknown): x is WartungBereich {
  return typeof x === "string" && (WARTUNG_BEREICHE as readonly string[]).includes(x);
}

/** DB-Zeile (public.wartung) → Stand. Unbekanntes fällt weg, nie Wurf. */
export function normalisiereWartung(row: {
  bereiche?: unknown;
  grund?: unknown;
  seit?: unknown;
  ausnahmen?: unknown;
} | null | undefined): WartungStand {
  if (!row) return KEINE_WARTUNG;
  const roh = Array.isArray(row.bereiche) ? row.bereiche : [];
  const bereiche = WARTUNG_BEREICHE.filter((b) => roh.includes(b));
  const ausnahmen = Array.from(
    new Set((Array.isArray(row.ausnahmen) ? row.ausnahmen : []).filter((x): x is string => typeof x === "string" && x.length > 0)),
  );
  const grund = typeof row.grund === "string" && row.grund.trim() ? row.grund.trim() : null;
  const seit = typeof row.seit === "string" && row.seit ? row.seit : null;
  return { bereiche, grund: bereiche.length ? grund : null, seit: bereiche.length ? seit : null, ausnahmen };
}

/** Darf `profileId` im Bereich arbeiten? Ohne Profil (nicht angemeldet,
 *  System) gibt es keine Ausnahme. */
export function wartungZugang(stand: WartungStand, bereich: WartungBereich, profileId: string | null | undefined): WartungZugang {
  if (!stand.bereiche.includes(bereich)) return "frei";
  return profileId && stand.ausnahmen.includes(profileId) ? "ausnahme" : "gesperrt";
}

/** Zugang je Bereich (für die Seiten-Layouts). */
export function wartungZugaenge(stand: WartungStand, profileId: string | null | undefined): Record<WartungBereich, WartungZugang> {
  return Object.fromEntries(WARTUNG_BEREICHE.map((b) => [b, wartungZugang(stand, b, profileId)])) as Record<WartungBereich, WartungZugang>;
}

/** Was die Seiten-Layouts dem Browser mitgeben (Kontext für Tabs/Karten). */
export interface WartungAnfrage {
  zugang: Record<WartungBereich, WartungZugang>;
  grund: string | null;
  seit: string | null;
}

/** Rechte-Slug → Bereich. requirePermission (api-auth.ts) prüft damit jede
 *  Route, die das Recht verlangt — auch über requireTrustedDevice und
 *  requireAdminTrustedDevice/requireFinanzen. */
const BEREICH_FUER_RECHT: Record<string, WartungBereich> = {
  "lohn:manage": "lohn",
  "finanzen:view": "finanzen",
};

export function wartungBereichFuerRecht(perm: string): WartungBereich | null {
  return BEREICH_FUER_RECHT[perm] ?? null;
}

/** Bereichsliste für Menschen: «Lohn, Rechte». */
export function wartungBereicheText(bereiche: readonly WartungBereich[]): string {
  return bereiche.map((b) => WARTUNG_BEREICH_INFO[b].label).join(", ");
}

// ---------------------------------------------------------------------------
// Kurzer Cache (je Server-Instanz)
// ---------------------------------------------------------------------------
// Der Stand wird höchstens alle `ttlMs` aus der DB gelesen. Ein Schalten per
// Skript wirkt damit nach spätestens ttlMs, ein Schalten in der App sofort in
// der Instanz, die es ausführt (leeren()).
//
// Fehler beim Lesen: letzter bekannter Stand; gab es noch keinen, gilt «keine
// Wartung» (ohne ihn zu merken — der nächste Aufruf liest neu). Die Wartung ist
// ein Umbau-Hinweis, keine Sicherheitsschranke: Rechte und Gerät prüfen die
// Routen unabhängig davon weiter.

export interface WartungsCache {
  lesen(opts?: { frisch?: boolean }): Promise<WartungStand>;
  leeren(): void;
}

export function erstelleWartungsCache(
  laden: () => Promise<WartungStand>,
  opts: { ttlMs: number; jetzt?: () => number; beiFehler?: (e: unknown) => void },
): WartungsCache {
  const jetzt = opts.jetzt ?? Date.now;
  let wert: WartungStand | null = null;
  let geladenAt = 0;
  let laufend: Promise<WartungStand> | null = null;
  let generation = 0;

  const neuLaden = (): Promise<WartungStand> => {
    if (laufend) return laufend;
    const gen = generation;
    const p = laden()
      .then((s) => {
        if (gen === generation) {
          wert = s;
          geladenAt = jetzt();
        }
        return s;
      })
      .catch((e: unknown) => {
        opts.beiFehler?.(e);
        return wert ?? KEINE_WARTUNG;
      })
      .finally(() => {
        if (laufend === p) laufend = null;
      });
    laufend = p;
    return p;
  };

  return {
    lesen({ frisch = false } = {}) {
      if (!frisch && wert && jetzt() - geladenAt < opts.ttlMs) return Promise.resolve(wert);
      if (frisch) {
        // Laufendes (evtl. älteres) Laden nicht wiederverwenden.
        generation++;
        laufend = null;
      }
      return neuLaden();
    },
    leeren() {
      generation++;
      wert = null;
      geladenAt = 0;
      laufend = null;
    },
  };
}
