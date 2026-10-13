// Kurven-Reihen gegen die Zeilengrenze der Supabase-API (Vorfall 2026-10-14: Kurven brachen nach ~1 h ab,
// weil technik_reihe() mehr als 1000 Zeilen lieferte und die API den Rest still abschnitt).
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BEREICHE, BEREICH_DAUER_MS, BEREICH_SCHRITT_S, REIHEN_SCHLUESSEL, quelleVonSchluessel } from "./konstanten";
import { API_ZEILEN_MAX, ladeReihen, reihenBloecke, zeitpunkteJeSchluessel } from "./stand-server";
import type { Bereich } from "./typen";

/** Attrappe: technik_reihe() mit lueckenlosen Minutenwerten, Antwort wie PostgREST nach t sortiert und
 *  auf API_ZEILEN_MAX Zeilen gekappt. Zaehlt die Aufrufe und die groesste Antwort. */
function attrappe() {
  const stat = { aufrufe: 0, groessteAntwort: 0 };
  const kette = { select: () => kette, eq: () => kette, gte: () => kette, lte: () => kette, order: () => kette, limit: async () => ({ data: [], error: null }) };
  const admin = {
    from: () => kette,
    rpc: async (_name: string, a: { p_von: string; p_bis: string; p_schritt_s: number; p_schluessel: string[] }) => {
      stat.aufrufe++;
      const schritt = a.p_schritt_s * 1000;
      const von = Date.parse(a.p_von), bis = Date.parse(a.p_bis);
      const zeilen: Array<{ t: string; schluessel: string; mittel: number; spitze: number }> = [];
      for (let t = Math.floor(von / schritt) * schritt; t < bis; t += schritt) {
        for (const s of [...a.p_schluessel].sort()) zeilen.push({ t: new Date(t).toISOString(), schluessel: s, mittel: 1, spitze: 2 });
      }
      const data = zeilen.slice(0, API_ZEILEN_MAX);
      stat.groessteAntwort = Math.max(stat.groessteAntwort, data.length);
      return { data, error: null };
    },
  };
  return { admin: admin as unknown as SupabaseClient, stat };
}

const erwartet = (b: Bereich, jetzt: Date) => {
  const schritt = BEREICH_SCHRITT_S[b] * 1000;
  const von = jetzt.getTime() - BEREICH_DAUER_MS[b];
  return Math.ceil((jetzt.getTime() - Math.floor(von / schritt) * schritt) / schritt);
};

describe("Technik-Dashboard — Kurven ohne stille Kappung", () => {
  it.each(BEREICHE)("Bloecke %s: alle Schluessel genau einmal, jede Antwort unter der Grenze", (b) => {
    for (const q of ["rig", "ki", "nas"] as const) {
      const schluessel = REIHEN_SCHLUESSEL.filter((s) => quelleVonSchluessel(s) === q);
      const bloecke = reihenBloecke(b, schluessel);
      expect(bloecke.flat()).toEqual(schluessel);
      for (const block of bloecke) expect(block.length * zeitpunkteJeSchluessel(b)).toBeLessThan(API_ZEILEN_MAX);
    }
  });

  it.each(BEREICHE)("ladeReihen %s: jede Reihe lueckenlos ueber den ganzen Zeitraum", async (b) => {
    const jetzt = new Date("2026-10-14T10:17:23Z");
    const { admin, stat } = attrappe();
    const r = await ladeReihen(admin, b, jetzt);
    const n = erwartet(b, jetzt);
    for (const s of REIHEN_SCHLUESSEL) {
      const punkte = r.werte[s];
      expect(punkte.length, s).toBe(n);
      expect(punkte.every((p) => p[1] != null), s).toBe(true);
      // letzter Punkt im letzten Schritt vor «jetzt» (frueher: nach ~1 h abgerissen)
      expect(jetzt.getTime() - punkte[punkte.length - 1][0], s).toBeLessThan(BEREICH_SCHRITT_S[b] * 1000);
    }
    expect(stat.groessteAntwort).toBeLessThan(API_ZEILEN_MAX);
  });

  it("scheitert laut statt still zu kappen, wenn eine Antwort die Grenze erreicht", async () => {
    const { admin } = attrappe();
    const voll = { ...admin, rpc: async () => ({ data: Array.from({ length: API_ZEILEN_MAX }, (_, i) => ({ t: new Date(i * 60_000).toISOString(), schluessel: "cpu.last", mittel: 1, spitze: 1 })), error: null }) };
    await expect(ladeReihen(voll as unknown as SupabaseClient, "6h", new Date())).rejects.toThrow(/API-Grenze/);
  });
});
