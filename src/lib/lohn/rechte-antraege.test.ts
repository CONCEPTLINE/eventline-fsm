import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/permission-audit", () => ({ logPermissionAudit: vi.fn(async () => true) }));
vi.mock("@/lib/notification-service", () => ({ notifySystem: vi.fn() }));

import { oeffnetLohn, personBrauchtAntrag } from "./rechte-antraege";

const p = (altRolle: string, neuRolle: string, altAktiv: boolean, neuAktiv: boolean, lohnRollen: string[] = []) =>
  personBrauchtAntrag({
    altRolle,
    neuRolle,
    altAktiv,
    neuAktiv,
    altOeffnet: altRolle === "admin" || lohnRollen.includes(altRolle),
    neuOeffnet: neuRolle === "admin" || lohnRollen.includes(neuRolle),
  });

describe("Vier Augen bei Rechten — wann braucht es einen Antrag (wie DB-Trigger 359)", () => {
  it("Rolle mit Lohnrecht erkennen", () => {
    expect(oeffnetLohn("admin", [])).toBe(true);
    expect(oeffnetLohn("buchhaltung", ["lohn:manage"])).toBe(true);
    expect(oeffnetLohn("techniker", ["kalender:view"])).toBe(false);
    expect(oeffnetLohn("x", null)).toBe(false);
  });
  it("Admin-Rolle vergeben und entziehen: Antrag", () => {
    expect(p("techniker", "admin", true, true)).toEqual({ noetig: true, gewaehrt: true });
    expect(p("admin", "techniker", true, true)).toEqual({ noetig: true, gewaehrt: false });
  });
  it("Rolle mit Lohnrecht vergeben/entziehen: Antrag; ohne Lohnbezug: frei", () => {
    expect(p("techniker", "buchhaltung", true, true, ["buchhaltung"])).toEqual({ noetig: true, gewaehrt: true });
    expect(p("buchhaltung", "techniker", true, true, ["buchhaltung"])).toEqual({ noetig: true, gewaehrt: false });
    expect(p("techniker", "teamleiter", true, true)).toEqual({ noetig: false, gewaehrt: false });
  });
  it("Admin → Lohn-Rolle (beide mit Lohnzugang) bleibt Antrag, weil der Admin-Status wechselt", () => {
    expect(p("admin", "buchhaltung", true, true, ["buchhaltung"]).noetig).toBe(true);
  });
  it("Deaktivieren ist frei (Notfall), Reaktivieren eines Admins braucht Antrag", () => {
    expect(p("admin", "admin", true, false)).toEqual({ noetig: false, gewaehrt: false });
    expect(p("admin", "admin", false, true)).toEqual({ noetig: true, gewaehrt: true });
    expect(p("techniker", "techniker", false, true)).toEqual({ noetig: false, gewaehrt: false });
  });
});
