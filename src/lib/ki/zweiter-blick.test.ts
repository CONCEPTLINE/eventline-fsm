import { describe, expect, it } from "vitest";
import { basisRezept, istZweiterBlick, zweiterBlickBleibt, zweiterBlickHinweis, zweiterBlickSchluessel } from "./zweiter-blick";

describe("Zweiter Blick (Migration 347)", () => {
  it("erkennt das Rezept mit «+zb» und das Basisrezept", () => {
    expect(istZweiterBlick("zz/v4+zb")).toBe(true);
    expect(istZweiterBlick("zz/v4")).toBe(false);
    expect(istZweiterBlick("+zb")).toBe(false);
    expect(istZweiterBlick(null)).toBe(false);
    expect(basisRezept("zz/v4+zb")).toBe("zz/v4");
    expect(basisRezept("zz/v4")).toBe("zz/v4");
  });

  it("das schnelle Modell desselben Rezepts überstimmt den zweiten Blick nie", () => {
    expect(zweiterBlickBleibt("zz/v4+zb", "zz/v4")).toBe(true);
    expect(zweiterBlickBleibt("zz/v4+zb", "zz/v5")).toBe(false);
    expect(zweiterBlickBleibt("zz/v4", "zz/v4+zb")).toBe(false);
    expect(zweiterBlickBleibt(null, "zz/v4")).toBe(false);
  });

  it("Schlüssel: gleiche Datei, gleiches Basisrezept — NFC", () => {
    const nfd = "ZZ_Alt/Müller.pdf";
    expect(zweiterBlickSchluessel(nfd, "a", "zz/v4+zb")).toBe(zweiterBlickSchluessel(nfd.normalize("NFC"), "a", "zz/v4"));
    expect(zweiterBlickSchluessel("x", "a", "zz/v4")).not.toBe(zweiterBlickSchluessel("x", "b", "zz/v4"));
  });

  it("Hinweis: geändert, gleich geblieben oder ohne Vorgänger", () => {
    const v = { ziel_ordner: "02_LOCATIONS/A", name_vorschlag: "2025_Vertrag.pdf", ersetzt_ziel: null, ersetzt_name: null };
    expect(zweiterBlickHinweis(v)).not.toContain("vorher");
    expect(zweiterBlickHinweis({ ...v, ersetzt_ziel: "02_LOCATIONS/A", ersetzt_name: "2025_Vertrag.pdf" })).toContain("wie vorher");
    const anders = zweiterBlickHinweis({ ...v, ersetzt_ziel: "02_LOCATIONS/B", ersetzt_name: "alt.pdf" });
    expect(anders).toContain("Ordner vorher: 02_LOCATIONS/B");
    expect(anders).toContain("Name vorher: alt.pdf");
    expect(zweiterBlickHinweis({ ...v, ersetzt_ziel: "02_LOCATIONS/A", ersetzt_name: null })).toContain("vorher ohne neuen Namen");
  });
});
