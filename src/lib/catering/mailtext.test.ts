import { describe, expect, it } from "vitest";
import { mailtext, type MailtextDaten } from "./mailtext";

const D: MailtextDaten = { anrede: "Hallo Michèle", anlass: "CD-Taufe", datumText: "9. April 2027", gaeste: 90, fixpreis: 960, mindestumsatz: 870, inbegriffen: 260, getraenkeProGast: 2.835, erwarteterUmsatz: 1683.99, du: true };

describe("mailtext", () => {
  it("nennt beide Preise, Menge, Gäste und rundet den Umsatz auf 100", () => {
    const t = mailtext(D);
    expect(t).toContain("für die Bar am 9. April 2027 (CD-Taufe)");
    expect(t).toContain("CHF 960");
    expect(t).toContain("CHF 870");
    expect(t).toContain("Kauft kein Gast etwas, zahlst du den ganzen Betrag von CHF 870");
    expect(t).toContain("260 Getränke");
    expect(t).toContain("90 Gästen");
    expect(t).toContain("rund CHF 1'700 Umsatz");
    expect(t).toContain("rund 3 pro Gast");
  });
  it("hält die Regeln ein: eine Frage, keine Ausrufezeichen, keine Aufzählung, höchstens 220 Wörter", () => {
    for (const du of [true, false]) {
      const t = mailtext({ ...D, du });
      expect((t.match(/\?/g) ?? []).length).toBe(1);
      expect(t).not.toContain("!");
      expect(t).not.toMatch(/^\s*[-•*]/m);
      expect(t.split(/\s+/).length).toBeLessThanOrEqual(220);
    }
  });
  it("Du- und Sie-Form unterscheiden sich", () => {
    expect(mailtext({ ...D, du: true })).toContain("übernimmst du");
    expect(mailtext({ ...D, du: false })).toContain("übernehmen Sie");
  });
  it("nimmt ohne Anrede eine neutrale Standardanrede und lässt das Datum weg, wenn keines da ist", () => {
    const t = mailtext({ ...D, anrede: " ", datumText: "" });
    expect(t.startsWith("Guten Tag")).toBe(true);
    expect(t).not.toContain(" am ");
    expect(t).toContain("für die Bar (CD-Taufe)");
  });
});
