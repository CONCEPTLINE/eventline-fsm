import { describe, expect, it } from "vitest";
import { sichtbareNavGruppen } from "./constants";

/** HR-Eintraege der Sidebar fuer eine Rolle (Labels in Reihenfolge). */
function hr(permissions: string[], role: string): string[] {
  return sichtbareNavGruppen(permissions, role).find((g) => g.label === "HR")?.items.map((i) => i.label) ?? [];
}

describe("Sidebar HR — Meine Anfragen vs. Tickets, Freigaben", () => {
  const mitarbeiter = ["stempelzeiten:view", "tickets:view", "tickets:create"];

  it("Mitarbeiter: Meine Anfragen statt Tickets, keine Freigaben", () => {
    expect(hr(mitarbeiter, "techniker")).toEqual(["Meine Anfragen", "Stempelzeiten", "Abwesenheit", "Lohn"]);
  });

  it("tickets:manage: Freigaben und Tickets, keine «Meine Anfragen» (ueber Mein Konto erreichbar)", () => {
    expect(hr([...mitarbeiter, "tickets:manage"], "teamleiter")).toEqual(["Freigaben", "Stempelzeiten", "Tickets", "Abwesenheit", "Lohn"]);
  });

  it("nur ferien:approve: Freigaben + Meine Anfragen", () => {
    expect(hr([...mitarbeiter, "ferien:approve"], "projektleiter")).toEqual(["Freigaben", "Meine Anfragen", "Stempelzeiten", "Abwesenheit", "Lohn"]);
  });

  it("Admin wie tickets:manage", () => {
    expect(hr([], "admin")).toEqual(["Freigaben", "Stempelzeiten", "Tickets", "Abwesenheit", "Lohn"]);
  });
});
