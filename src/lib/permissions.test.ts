import { describe, it, expect } from "vitest";
import { isPathAllowed } from "./permissions";

// NAS-Sperre (Mischa 2026-10-11): der ganze NAS-Bereich (/nas, Alias /ablage)
// ist nur fuer Admins — Sidebar, Mobile-Menue und (app)/layout-Redirect haengen
// an isPathAllowed.
const NAS_PFADE = ["/nas", "/nas/x", "/nas?tab=suche", "/ablage", "/ablage/x", "/ablage?tab=y"];
const NICHT_ADMINS = ["techniker", "projekt-leiter", "partner", "lieferant", "buero", ""];

// Rechte, mit denen ein Nicht-Admin sonst fast alles sieht — auch ein
// (heute nicht vergebenes) nas:ablage darf die Sperre nicht oeffnen.
const VIELE_RECHTE = ["auftraege:view", "kunden:view", "todos:view", "einstellungen:view", "nas:ablage", "nas:view", "ablage:view"];

describe("isPathAllowed — NAS nur fuer Admins", () => {
  it.each(NAS_PFADE)("admin darf %s", (pfad) => {
    expect(isPathAllowed(pfad, [], "admin")).toBe(true);
  });

  for (const rolle of NICHT_ADMINS) {
    it.each(NAS_PFADE)(`${rolle || "(ohne Rolle)"} darf %s nicht`, (pfad) => {
      expect(isPathAllowed(pfad, [], rolle)).toBe(false);
      expect(isPathAllowed(pfad, VIELE_RECHTE, rolle)).toBe(false);
    });
  }

  it("trifft nur ganze Pfad-Segmente (/nasx, /ablagefoo sind kein NAS)", () => {
    expect(isPathAllowed("/nasx", [], "techniker")).toBe(true);
    expect(isPathAllowed("/ablagefoo", [], "techniker")).toBe(true);
  });
});

describe("isPathAllowed — andere Pfade unveraendert", () => {
  it("Admin darf weiterhin alles", () => {
    for (const p of ["/dashboard", "/auftraege", "/auftraege/123", "/kunden", "/einstellungen", "/lohn?tab=dokumente"]) {
      expect(isPathAllowed(p, [], "admin")).toBe(true);
    }
  });

  it("Sicherheit und Mitarbeiter nur fuer Admins", () => {
    for (const p of ["/sicherheit", "/sicherheit?tab=geraete", "/mitarbeiter", "/mitarbeiter/x"]) {
      expect(isPathAllowed(p, [], "admin")).toBe(true);
      expect(isPathAllowed(p, VIELE_RECHTE, "techniker")).toBe(false);
    }
  });

  it("Anträge und Lohn sind fuer alle erreichbar (die Seiten pruefen selbst)", () => {
    for (const p of ["/antraege", "/lohn", "/lohn?tab=dokumente"]) {
      expect(isPathAllowed(p, [], "techniker")).toBe(true);
    }
  });

  it("immer erlaubte Pfade bleiben fuer alle offen", () => {
    for (const p of ["/dashboard", "/mein-konto", "/mein-konto/profil", "/ferien"]) {
      expect(isPathAllowed(p, [], "techniker")).toBe(true);
    }
  });

  it("Modul-Pfade haengen weiter an <modul>:view", () => {
    expect(isPathAllowed("/auftraege", ["auftraege:view"], "techniker")).toBe(true);
    expect(isPathAllowed("/auftraege/abc", ["auftraege:view"], "techniker")).toBe(true);
    expect(isPathAllowed("/auftraege", [], "techniker")).toBe(false);
    expect(isPathAllowed("/einstellungen?tab=rollen", [], "projekt-leiter")).toBe(false);
    expect(isPathAllowed("/einstellungen?tab=rollen", ["einstellungen:view"], "projekt-leiter")).toBe(true);
  });

  it("Kunden-Detailseite bleibt ohne Modul-Recht erreichbar, die Liste nicht", () => {
    expect(isPathAllowed("/kunden/0b8c1a2e-1234-4abc-8def-0123456789ab", [], "techniker")).toBe(true);
    expect(isPathAllowed("/kunden", [], "techniker")).toBe(false);
  });

  it("Pfade ohne Modul bleiben offen", () => {
    expect(isPathAllowed("/api/irgendwas", [], "techniker")).toBe(true);
  });
});
