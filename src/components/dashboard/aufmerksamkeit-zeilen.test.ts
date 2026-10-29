import { describe, expect, it } from "vitest";
import { aufmerksamkeitZeilen } from "./aufmerksamkeit-karte";
import type { AufmerksamkeitDaten } from "./typen";

const leer: AufmerksamkeitDaten = {
  ueberfaellig: { anzahl: 0, eintraege: [] },
  partner_anfragen: 0,
  abwesenheits_antraege: 0,
  rechte_antraege: 0,
  nicht_abgerechnet: 0,
  neue_belege: 0,
  offene_tickets: 0,
  fristen_30_tage: 0,
};

describe("aufmerksamkeitZeilen — Fristen (E3.4)", () => {
  it("Zeile «Fristen in 30 Tagen» mit Link auf die Fristen der Ablage in Trust one", () => {
    const [z] = aufmerksamkeitZeilen({ ...leer, fristen_30_tage: 3 });
    expect(z).toMatchObject({
      key: "fristen",
      n: 3,
      label: "Fristen in 30 Tagen",
      ton: "amber",
      href: "https://one.trust-group.ch/geschaeft/ablage/eventline-gmbh?ansicht=fristen",
    });
    expect(aufmerksamkeitZeilen({ ...leer, fristen_30_tage: 1 })[0].label).toBe("Frist in 30 Tagen");
  });

  it("keine Zeile bei 0, ohne Recht (null) oder aus einem alten Session-Cache (fehlt)", () => {
    expect(aufmerksamkeitZeilen(leer)).toHaveLength(0);
    expect(aufmerksamkeitZeilen({ ...leer, fristen_30_tage: null })).toHaveLength(0);
    const alt = { ...leer } as Partial<AufmerksamkeitDaten>;
    delete alt.fristen_30_tage;
    expect(aufmerksamkeitZeilen(alt as AufmerksamkeitDaten)).toHaveLength(0);
  });

  it("Reihenfolge: nach den Anfragen, vor dem Abrechnen", () => {
    const keys = aufmerksamkeitZeilen({ ...leer, abwesenheits_antraege: 1, fristen_30_tage: 2, nicht_abgerechnet: 1 }).map((z) => z.key);
    expect(keys).toEqual(["abwesenheit", "fristen", "abrechnen"]);
  });
});

describe("aufmerksamkeitZeilen — Rechte-/Lohndaten-Anträge", () => {
  it("Zeile mit Link auf den Reiter «Rechte & Lohndaten», direkt nach den Abwesenheits-Anträgen", () => {
    const zeilen = aufmerksamkeitZeilen({ ...leer, abwesenheits_antraege: 1, rechte_antraege: 2, fristen_30_tage: 1 });
    expect(zeilen.map((z) => z.key)).toEqual(["abwesenheit", "rechte", "fristen"]);
    expect(zeilen[1]).toMatchObject({ n: 2, label: "Rechte-/Lohndaten-Anträge", ton: "amber", href: "/antraege?tab=rechte&from=dashboard" });
    expect(aufmerksamkeitZeilen({ ...leer, rechte_antraege: 1 })[0].label).toBe("Rechte-/Lohndaten-Antrag");
  });

  it("keine Zeile bei 0, für Nicht-Admins (null) oder aus einem alten Session-Cache (fehlt)", () => {
    expect(aufmerksamkeitZeilen({ ...leer, rechte_antraege: null })).toHaveLength(0);
    const alt = { ...leer } as Partial<AufmerksamkeitDaten>;
    delete alt.rechte_antraege;
    expect(aufmerksamkeitZeilen(alt as AufmerksamkeitDaten)).toHaveLength(0);
  });
});
