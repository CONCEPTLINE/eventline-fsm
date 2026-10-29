// Stempel-Prüfung vor dem Monatsabschluss (Lohn-Umbau Phase 4).
//
// Ein Lohnmonat einer Person ist «blockiert: Stempel prüfen», solange sie in
// diesem Monat (Beginn des Stempels, Ortszeit Zürich) einen
//   - offenen Stempel (kein Ende) hat — der Kern zählt ihn nicht, die
//     Abrechnung wäre zu tief; oder
//   - sehr langen Stempel (> STEMPEL_LANG_STUNDEN) hat, den die
//     Lohnverwaltung noch nicht als korrekt bestätigt hat (time_entries.geprueft_at).
// Dann erzeugen weder der Lauf noch der Knopf eine Abrechnung (LohnFehler
// «stempel_pruefen», src/lib/lohn/abrechnung.ts).
//
// Schwelle 16 h: Tages- und Abendarbeit liegt nach Art. 10 Abs. 3 ArG mit
// Pausen und Überzeit innerhalb von 14 Stunden; 2 h Reserve für Auf-/Abbau
// bei Anlässen. Darüber ist ein Stempel praktisch immer ein vergessenes
// Ausstempeln. Dieselbe Zahl steht in der Datenbank
// (public.stempel_lang_grenze(), Migration 368) — das Prüfskript vergleicht.
//
// Nur Server (Admin-Client).

import type { SupabaseClient } from "@supabase/supabase-js";
import { ladeAlleSeiten } from "./daten";

export const STEMPEL_LANG_STUNDEN = 16;
export const STEMPEL_LANG_MS = STEMPEL_LANG_STUNDEN * 60 * 60 * 1000;

export type StempelProblemArt = "offen" | "lang";

export interface StempelProblem {
  id: string;
  profileId: string;
  art: StempelProblemArt;
  clockIn: string;
  clockOut: string | null;
  /** Dauer in Minuten (offen: bis jetzt). */
  dauerMinuten: number;
  langBegruendung: string | null;
}

const ZEIT = new Intl.DateTimeFormat("de-CH", {
  timeZone: "Europe/Zurich",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** Lokale Grenzen [erster Tag 00:00, Folgemonat 00:00) als UTC-Puffer (±1 Tag); genau gefiltert wird danach. */
function grobeGrenzen(jahr: number, monat: number): { von: string; bis: string } {
  const von = new Date(Date.UTC(jahr, monat - 1, 1) - 24 * 3600 * 1000).toISOString();
  const bis = new Date(Date.UTC(jahr, monat, 1) + 24 * 3600 * 1000).toISOString();
  return { von, bis };
}

function lokalerMonat(iso: string): string {
  const t = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit" }).format(new Date(iso));
  return t.slice(0, 7);
}

/** Ist ein abgeschlossener Stempel «sehr lang»? */
export function istLangerStempel(clockIn: string, clockOut: string | null): boolean {
  if (!clockOut) return false;
  return new Date(clockOut).getTime() - new Date(clockIn).getTime() > STEMPEL_LANG_MS;
}

/**
 * Probleme der Personen im Lohnmonat (offen / lang und ungeprüft).
 * Ergebnis je Person (leer = nichts zu prüfen). Wirft bei Ladefehlern.
 */
export async function ladeStempelProbleme(
  admin: SupabaseClient,
  profileIds: string[],
  jahr: number,
  monat: number,
): Promise<Map<string, StempelProblem[]>> {
  const out = new Map<string, StempelProblem[]>();
  const ids = Array.from(new Set(profileIds));
  if (ids.length === 0) return out;
  const { von, bis } = grobeGrenzen(jahr, monat);
  const schluessel = `${jahr}-${String(monat).padStart(2, "0")}`;
  const jetzt = Date.now();
  for (let i = 0; i < ids.length; i += 150) {
    const teil = ids.slice(i, i + 150);
    const zeilen = await ladeAlleSeiten<{
      id: string;
      user_id: string;
      clock_in: string;
      clock_out: string | null;
      lang_begruendung: string | null;
      geprueft_at: string | null;
    }>(
      (a, b) =>
        admin
          .from("time_entries")
          .select("id, user_id, clock_in, clock_out, lang_begruendung, geprueft_at")
          .in("user_id", teil)
          .gte("clock_in", von)
          .lt("clock_in", bis)
          .order("id")
          .range(a, b),
      "Stempel-Prüfung",
    );
    for (const z of zeilen) {
      if (lokalerMonat(z.clock_in) !== schluessel) continue;
      const offen = z.clock_out == null;
      const lang = !offen && istLangerStempel(z.clock_in, z.clock_out) && !z.geprueft_at;
      if (!offen && !lang) continue;
      const ende = z.clock_out ? new Date(z.clock_out).getTime() : jetzt;
      const p: StempelProblem = {
        id: z.id,
        profileId: z.user_id,
        art: offen ? "offen" : "lang",
        clockIn: z.clock_in,
        clockOut: z.clock_out,
        dauerMinuten: Math.max(0, Math.round((ende - new Date(z.clock_in).getTime()) / 60000)),
        langBegruendung: z.lang_begruendung,
      };
      out.set(z.user_id, [...(out.get(z.user_id) ?? []), p]);
    }
  }
  for (const l of out.values()) l.sort((a, b) => a.clockIn.localeCompare(b.clockIn));
  return out;
}

/** Ein Satz für Lauf-Protokoll, Fehlermeldung und Alarm (ohne Beträge). */
export function stempelProblemText(probleme: StempelProblem[]): string {
  const offen = probleme.filter((p) => p.art === "offen");
  const lang = probleme.filter((p) => p.art === "lang");
  const teile: string[] = [];
  if (offen.length > 0) {
    teile.push(`${offen.length === 1 ? "1 offener Stempel" : `${offen.length} offene Stempel`} (seit ${offen.map((p) => ZEIT.format(new Date(p.clockIn))).join(", ")})`);
  }
  if (lang.length > 0) {
    teile.push(`${lang.length === 1 ? "1 Stempel" : `${lang.length} Stempel`} über ${STEMPEL_LANG_STUNDEN} h ungeprüft (${lang
      .map((p) => `${ZEIT.format(new Date(p.clockIn))}, ${Math.floor(p.dauerMinuten / 60)}:${String(p.dauerMinuten % 60).padStart(2, "0")} h`)
      .join("; ")})`);
  }
  return `Stempel prüfen: ${teile.join(" · ")}`;
}
