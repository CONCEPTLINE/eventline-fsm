import { describe, expect, it } from "vitest";
import { gruppeOffenePunkte, gruppeWartetAufLieferant } from "@/lib/technik";

// Offen-Marker der Positionsgruppen (Technik-Tab + Lieferantenportal).
// Firmen-Sicht = Definition von technik_offene_punkte (Migration 336).

const k = (position_id: string | null, vom_lieferanten: boolean, created_at: string, review_id: string | null = null) =>
  ({ position_id, review_id, vom_lieferanten, created_at });

describe("gruppeOffenePunkte (Sicht EVENTLINE)", () => {
  it("zaehlt offene Empfehlungen/Probleme nur der eigenen Einzelpositionen", () => {
    const o = gruppeOffenePunkte(
      ["a", "b"],
      [
        { position_id: "a", art: "empfehlung", status: "offen" },
        { position_id: "b", art: "problem", status: "offen" },
        { position_id: "b", art: "problem", status: "erledigt" },
        { position_id: "x", art: "problem", status: "offen" }, // andere Gruppe
        { position_id: null, art: "empfehlung", status: "offen" }, // allgemein
      ],
      [],
    );
    expect(o).toEqual({ empfehlungen: 1, probleme: 1, unbeantwortet: 0, total: 2 });
  });

  it("Positions-Faden zaehlt nur, wenn der letzte Beitrag vom Lieferanten ist", () => {
    const o = gruppeOffenePunkte(["a", "b"], [], [
      k("a", false, "2026-10-25T08:00:00Z"),
      k("a", true, "2026-10-25T09:00:00Z"), // a: Lieferant zuletzt → offen
      k("b", true, "2026-10-25T08:00:00Z"),
      k("b", false, "2026-10-25T09:00:00Z"), // b: EVENTLINE hat geantwortet
    ]);
    expect(o.unbeantwortet).toBe(1);
    expect(o.total).toBe(1);
  });

  it("Faeden an Rueckmeldungen zaehlen nie separat", () => {
    const o = gruppeOffenePunkte(["a"], [], [k("a", true, "2026-10-25T09:00:00Z", "r1")]);
    expect(o.total).toBe(0);
  });
});

describe("gruppeWartetAufLieferant (Portal)", () => {
  it("ungeprueft = nicht bestaetigt und ohne offene Rueckmeldung; je Einzelposition einmal", () => {
    const w = gruppeWartetAufLieferant(
      [
        { id: "a", status: "geplant" }, // ungeprueft
        { id: "b", status: "geplant" }, // hat offenes Problem → wartet auf EVENTLINE
        { id: "c", status: "bestaetigt" }, // erledigt, aber Kommentar von EVENTLINE offen
        { id: "d", status: "geplant" }, // ungeprueft UND unbeantwortet → zaehlt einmal
      ],
      [{ position_id: "b", status: "offen" }],
      [
        k("c", true, "2026-10-25T08:00:00Z"),
        k("c", false, "2026-10-25T09:00:00Z"),
        k("d", false, "2026-10-25T09:00:00Z"),
      ],
    );
    expect(w).toEqual({ ungeprueft: 2, unbeantwortet: 2, total: 3 });
  });
});
