// Stundensätze je Person aus Trust flow (Tabelle personal_saetze, Migrationen
// 377 + 383; geliefert über POST /api/flow/saetze). Seit «Lohn neu» Phase 1b
// rechnet das ERP Kosten und «Mein Monat» nur noch damit — keine eigene
// Lohnlogik (keine AHV-Grenzen, keine Abzüge; der Satz enthält das schon):
//   - kosten_chf_h: Vollkosten Arbeitgeber je Stunde → Auftragskosten,
//     Standort-Report, Projekt-Kosten (nur mit Lohnrecht + vertrautem Gerät).
//   - netto_chf_h: Nettolohn je Stunde → «Mein Monat» (NUR die eigene Person).
//   - null: kein Stundensatz (z. B. reiner Provisionslohn) → Stunden dieser
//     Person fliessen nicht in Kosten ein und werden als «ohne Satz» gezeigt,
//     nie still als 0 CHF.
// Gültig an Tag D ist die Zeile mit dem grössten gueltig_ab <= D. Vor dem
// ersten gueltig_ab gibt es keinen Satz (null).
//
// Die Tabelle ist nur für service_role lesbar (RLS ohne Policies) — Aufrufer
// laden mit dem Admin-Client und prüfen die Rechte VORHER wie bisher. Immer
// nur die gebrauchte Spalte laden (Kosten ODER Netto), damit Netto-Sätze nie
// in eine Kostenrechnung (oder umgekehrt) geraten.

import type { SupabaseClient } from "@supabase/supabase-js";

export type SatzArt = "kosten" | "netto";

const SPALTE: Record<SatzArt, "kosten_chf_h" | "netto_chf_h"> = {
  kosten: "kosten_chf_h",
  netto: "netto_chf_h",
};

export interface SatzZeile {
  profile_id: string;
  /** YYYY-MM-DD */
  gueltig_ab: string;
  /** CHF je Stunde; null = kein Stundensatz. */
  satz: number | null;
}

/** Je Person die Sätze aufsteigend nach gueltig_ab. */
export type SatzVerlauf = Map<string, { gueltig_ab: string; satz: number | null }[]>;

// ---------------------------------------------------------------------------
// Rein (ohne DB) — auch im Browser nutzbar
// ---------------------------------------------------------------------------

/** CHF-Wert aus der DB (numeric kommt je nach Weg als Zahl oder Text). */
function alsSatz(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Zeilen → Verlauf je Person (sortiert, bei doppeltem Datum gilt die letzte Zeile). */
export function satzVerlauf(zeilen: readonly SatzZeile[]): SatzVerlauf {
  const je = new Map<string, Map<string, number | null>>();
  for (const z of zeilen) {
    if (!z.profile_id || !/^\d{4}-\d{2}-\d{2}$/.test(z.gueltig_ab)) continue;
    let m = je.get(z.profile_id);
    if (!m) je.set(z.profile_id, (m = new Map()));
    m.set(z.gueltig_ab, alsSatz(z.satz));
  }
  const out: SatzVerlauf = new Map();
  for (const [pid, m] of je) {
    out.set(
      pid,
      [...m.entries()].map(([gueltig_ab, satz]) => ({ gueltig_ab, satz })).sort((a, b) => a.gueltig_ab.localeCompare(b.gueltig_ab)),
    );
  }
  return out;
}

/** Satz der Person am Tag `datum` (YYYY-MM-DD, Zürich-Kalender): grösstes
 *  gueltig_ab <= datum. null = kein Satz (keine Zeile davor oder Satz leer). */
export function satzAm(verlauf: SatzVerlauf, profileId: string, datum: string): number | null {
  const zeilen = verlauf.get(profileId);
  if (!zeilen) return null;
  let treffer: number | null = null;
  for (const z of zeilen) {
    if (z.gueltig_ab > datum) break;
    treffer = z.satz;
  }
  return treffer;
}

/** Minuten je Tag × Satz am jeweiligen Tag. Minuten an Tagen ohne Satz
 *  fliessen NICHT ein, sondern stehen in `minutenOhneSatz`. */
export function chfAusMinuten(
  verlauf: SatzVerlauf,
  profileId: string,
  minutenJeTag: ReadonlyMap<string, number>,
): { chf: number; minutenMitSatz: number; minutenOhneSatz: number } {
  let chf = 0;
  let minutenMitSatz = 0;
  let minutenOhneSatz = 0;
  for (const [tag, min] of minutenJeTag) {
    if (!(min > 0)) continue;
    const satz = satzAm(verlauf, profileId, tag);
    if (satz === null) {
      minutenOhneSatz += min;
    } else {
      chf += (satz * min) / 60;
      minutenMitSatz += min;
    }
  }
  return { chf, minutenMitSatz, minutenOhneSatz };
}

// ---------------------------------------------------------------------------
// Laden (Server, Admin-Client)
// ---------------------------------------------------------------------------

const SEITE = 1000;
const STUECK = 100;

/**
 * Lädt den Verlauf EINER Satz-Art für die Personen — alle Zeilen mit
 * gueltig_ab <= `bis` (YYYY-MM-DD), auch ältere: der am Bereichsanfang
 * gültige Satz liegt meist vor dem Bereich. Nur mit dem Admin-Client
 * aufrufen, nachdem die Rechte geprüft sind (Netto nur für die eigene Person).
 */
export async function ladeSatzVerlauf(
  admin: SupabaseClient,
  profileIds: readonly string[],
  art: SatzArt,
  bis: string,
): Promise<SatzVerlauf> {
  const ids = [...new Set(profileIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const spalte = SPALTE[art];
  const zeilen: SatzZeile[] = [];
  for (let i = 0; i < ids.length; i += STUECK) {
    const teil = ids.slice(i, i + STUECK);
    for (let von = 0; ; von += SEITE) {
      const { data, error } = await admin
        .from("personal_saetze")
        .select(`id, profile_id, gueltig_ab, ${spalte}`)
        .in("profile_id", teil)
        .lte("gueltig_ab", bis)
        .order("id")
        .range(von, von + SEITE - 1);
      if (error) throw new Error(`Stundensätze konnten nicht geladen werden: ${error.message}`);
      const rows = (data ?? []) as unknown as Record<string, unknown>[];
      for (const r of rows) {
        zeilen.push({ profile_id: String(r.profile_id), gueltig_ab: String(r.gueltig_ab), satz: alsSatz(r[spalte]) });
      }
      if (rows.length < SEITE) break;
    }
  }
  return satzVerlauf(zeilen);
}
