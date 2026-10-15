import { describe, it, expect } from "vitest";
import { isPathAllowed, PERMISSION_MODULES } from "@/lib/permissions";
import { ADMIN_NAV_GROUP, NAV_GROUPS } from "@/lib/constants";
import { getNavIcon } from "@/lib/nav-icons";
import { paletteEintraege } from "@/components/shell/palette-actions";
import { FINANZEN_PERMISSION, FINANZEN_PFAD } from "@/lib/finanzen/types";

// Finanzen Welle 1 (Spec C.B4 Schritt 1): admin-only. Sidebar, Mehr-Sheet,
// Palette und der (app)/layout-Redirect haengen an isPathAllowed — eine Rolle
// MIT finanzen:view sieht den Eintrag trotzdem nicht und wird umgeleitet,
// weil die Routen (requireAdminTrustedDevice) dieselbe Grenze ziehen.
const PFADE = ["/finanzen", "/finanzen?x=1", "/finanzen/x"];
const NICHT_ADMINS = ["techniker", "projekt-leiter", "partner", "lieferant", "buero", ""];
const MIT_FINANZRECHT = [FINANZEN_PERMISSION, "abrechnung:view", "auftraege:view", "einstellungen:view", "lohn:manage"];

/** Gleiche Filterung wie die Sidebar (src/components/layout/sidebar.tsx). */
const sichtbareEintraege = (rechte: string[], rolle: string) =>
  [...NAV_GROUPS, ADMIN_NAV_GROUP].flatMap((g) => g.items.filter((i) => isPathAllowed(i.href, rechte, rolle))).map((i) => i.href);

const finanzenGruppe = NAV_GROUPS.find((g) => g.label === "Finanzen");
const eintrag = finanzenGruppe?.items.find((i) => i.href === FINANZEN_PFAD);

describe("Finanzen — Zugang nur fuer Admins (Welle 1)", () => {
  it.each(PFADE)("admin darf %s", (p) => {
    expect(isPathAllowed(p, [], "admin")).toBe(true);
    expect(isPathAllowed(p, MIT_FINANZRECHT, "admin")).toBe(true);
  });

  for (const rolle of NICHT_ADMINS) {
    it.each(PFADE)(`${rolle || "(ohne Rolle)"} darf %s nicht — auch nicht mit finanzen:view`, (p) => {
      expect(isPathAllowed(p, [], rolle)).toBe(false);
      expect(isPathAllowed(p, MIT_FINANZRECHT, rolle)).toBe(false);
    });
  }

  it("trifft nur ganze Pfad-Segmente (/finanzenx ist nicht die Finanzseite)", () => {
    expect(isPathAllowed("/finanzenx", [], "techniker")).toBe(true);
  });

  it("Rechte-Modul finanzen existiert mit genau der Aktion view", () => {
    const mod = PERMISSION_MODULES.find((m) => m.slug === "finanzen");
    expect(mod).toBeDefined();
    expect(mod?.paths).toEqual([FINANZEN_PFAD]);
    expect([...(mod?.actions ?? [])]).toEqual(["view"]);
  });

  it("Sidebar: «Übersicht» steht im Bereich Finanzen vor Abrechnung, nur fuer Admins", () => {
    expect(finanzenGruppe).toBeDefined();
    const hrefs = finanzenGruppe?.items.map((i) => i.href) ?? [];
    expect(hrefs.indexOf(FINANZEN_PFAD)).toBe(0);
    expect(hrefs.indexOf("/abrechnung")).toBe(1);
    expect(eintrag?.label).toBe("Übersicht");
    expect(sichtbareEintraege([], "admin")).toContain(FINANZEN_PFAD);
    for (const rolle of NICHT_ADMINS) expect(sichtbareEintraege(MIT_FINANZRECHT, rolle)).not.toContain(FINANZEN_PFAD);
  });

  it("Eintrag hat palette === false und Icon BarChart3", () => {
    expect(eintrag?.palette).toBe(false);
    expect(eintrag?.icon).toBe("BarChart3");
    expect(getNavIcon("BarChart3")).not.toBeNull();
  });

  it("Befehlspalette bietet /finanzen niemandem an — auch dem Admin nicht", () => {
    for (const [rechte, rolle] of [[[], "admin"], [MIT_FINANZRECHT, "admin"], [MIT_FINANZRECHT, "buero"]] as const) {
      const eintraege = paletteEintraege([...rechte], rolle);
      expect(eintraege.some((e) => e.href === FINANZEN_PFAD)).toBe(false);
      expect(eintraege.some((e) => e.label === "Übersicht")).toBe(false);
    }
    // Abrechnung bleibt in der Palette (palette-Default = sichtbar).
    expect(paletteEintraege([], "admin").some((e) => e.href === "/abrechnung")).toBe(true);
  });
});
