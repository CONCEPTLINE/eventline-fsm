import { describe, it, expect } from "vitest";
import { isPathAllowed } from "@/lib/permissions";
import { ADMIN_NAV_GROUP, NAV_GROUPS } from "@/lib/constants";
import { getNavIcon } from "@/lib/nav-icons";

// Technik-Dashboard (VERTRAG §6.1): nur Admins. Sidebar, Mobile-Menue und der
// (app)/layout-Redirect haengen an isPathAllowed — ein Nicht-Admin sieht den
// Menuepunkt nicht und wird umgeleitet. Kein Rechte-Slug oeffnet die Seite.
const PFADE = ["/technik", "/technik?teil=cpu", "/technik?teil=ram&bereich=24h", "/technik/x"];
const NICHT_ADMINS = ["techniker", "projekt-leiter", "partner", "lieferant", "buero", ""];
const VIELE_RECHTE = ["auftraege:view", "einstellungen:view", "technik:view", "nas:view", "ki:view"];

/** Gleiche Filterung wie die Sidebar (src/components/layout/sidebar.tsx). */
const sichtbareEintraege = (rechte: string[], rolle: string) =>
  [...NAV_GROUPS, ADMIN_NAV_GROUP].flatMap((g) => g.items.filter((i) => isPathAllowed(i.href, rechte, rolle))).map((i) => i.href);

describe("Technik-Dashboard — Zugang nur fuer Admins", () => {
  it.each(PFADE)("admin darf %s", (p) => {
    expect(isPathAllowed(p, [], "admin")).toBe(true);
  });

  for (const rolle of NICHT_ADMINS) {
    it.each(PFADE)(`${rolle || "(ohne Rolle)"} darf %s nicht`, (p) => {
      expect(isPathAllowed(p, [], rolle)).toBe(false);
      expect(isPathAllowed(p, VIELE_RECHTE, rolle)).toBe(false);
    });
  }

  it("trifft nur ganze Pfad-Segmente (/technikx ist nicht die Technik-Seite)", () => {
    expect(isPathAllowed("/technikx", [], "techniker")).toBe(true);
  });

  it("Admin sieht den Eintrag «Technik» direkt nach NAS, Nicht-Admins nicht", () => {
    const items = ADMIN_NAV_GROUP.items.map((i) => i.href);
    expect(items.indexOf("/technik")).toBe(items.indexOf("/nas") + 1);
    expect(sichtbareEintraege([], "admin")).toContain("/technik");
    for (const rolle of NICHT_ADMINS) expect(sichtbareEintraege(VIELE_RECHTE, rolle)).not.toContain("/technik");
  });

  it("Icon «Server» ist in der Navigation hinterlegt", () => {
    const eintrag = ADMIN_NAV_GROUP.items.find((i) => i.href === "/technik");
    expect(eintrag?.icon).toBe("Server");
    expect(getNavIcon("Server")).not.toBeNull();
  });
});
