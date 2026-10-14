import { describe, expect, it } from "vitest";
import { besteZeile, fristSachverhalt, parteiKern, planeBereinigung, quellPfade, sachverhaltDerZeile, type FristZeileRoh } from "./fristen-sachverhalt";

describe("parteiKern / fristSachverhalt", () => {
  it("Rechtsform, Gross-/Kleinschreibung, Akzente und Satzzeichen zaehlen nicht", () => {
    expect(parteiKern("Verein SCALA BASEL")).toBe("scala basel");
    expect(parteiKern("SCALA BASEL")).toBe("scala basel");
    expect(parteiKern("Verein Scala Basel")).toBe("scala basel");
    expect(parteiKern("Herzog & Tech GmbH")).toBe("herzog tech");
    expect(parteiKern("Zürcher Kantonalbank AG")).toBe(parteiKern("Zurcher Kantonalbank"));
    expect(parteiKern("Freunde e.V.")).toBe("freunde");
  });
  it("verschiedene Parteien bleiben verschieden", () => {
    expect(parteiKern("Theater BAU3")).not.toBe(parteiKern("Barakuba"));
  });
  it("ohne (brauchbare) Partei kein Sachverhalt", () => {
    expect(fristSachverhalt("kuendigung", null)).toBeNull();
    expect(fristSachverhalt("kuendigung", "")).toBeNull();
    expect(fristSachverhalt("kuendigung", "GmbH")).toBeNull();
    expect(fristSachverhalt("kuendigung", "Verein SCALA BASEL")).toBe("kuendigung:scala basel");
    expect(fristSachverhalt("zahlung", "SCALA BASEL")).toBe("zahlung:scala basel");
  });
});

const basis: FristZeileRoh = {
  id: "00000000-0000-0000-0000-000000000001",
  pfad: "02_LOCATIONS/002506_SCALA_BASEL/02_Verwaltungsvertraege/01_Entwuerfe/Vereinbarung_V02.pdf",
  art: "kuendigung",
  datum: "2027-12-31",
  bezeichnung: "Kündigung · Verein SCALA BASEL",
  quelle: "ki",
  status: "vorschlag",
  sicherheit: "hoch",
  grundlage: { ende: "2027-12-31", faellig: "2027-12-31", kuendigungsfrist: { anzahl: 6, einheit: "monate" } },
};
const z = (id: number, p: Partial<FristZeileRoh>): FristZeileRoh => ({ ...basis, id: `00000000-0000-0000-0000-${String(id).padStart(12, "0")}`, ...p });

describe("sachverhaltDerZeile", () => {
  it("aus der KI-Bezeichnung", () => {
    expect(sachverhaltDerZeile(basis)).toBe("kuendigung:scala basel");
  });
  it("Spalte geht vor", () => {
    expect(sachverhaltDerZeile({ ...basis, sachverhalt: "x:y" })).toBe("x:y");
  });
  it("Bezeichnung mit Dateiname (KI ohne Partei) -> keiner", () => {
    expect(sachverhaltDerZeile({ ...basis, pfad: "ZZ/bilanz_2026.pdf", bezeichnung: "Ablauf · bilanz_2026.pdf" })).toBeNull();
  });
  it("auf 120 Zeichen gekappter Dateiname -> keiner", () => {
    const name = "a".repeat(130) + ".pdf";
    const bez = `Ablauf · ${name}`.slice(0, 120);
    expect(sachverhaltDerZeile({ ...basis, pfad: `ZZ/${name}`, bezeichnung: bez })).toBeNull();
  });
  it("nur KI-Fristen (Ablage/von Hand: Bezeichnung = Dateiname)", () => {
    expect(sachverhaltDerZeile({ ...basis, quelle: "ablage" })).toBeNull();
  });
});

describe("quellPfade", () => {
  it("Hauptpfad zuerst, ohne Doppel (auch NFC/NFD)", () => {
    const nfd = "A/Münster.pdf";
    const nfc = "A/Münster.pdf";
    expect(quellPfade({ pfad: "A/x.pdf", weitere_pfade: ["A/y.pdf", "A/x.pdf", nfd, nfc] })).toEqual(["A/x.pdf", "A/y.pdf", nfd]);
    expect(quellPfade({ pfad: null, weitere_pfade: null })).toEqual([]);
  });
});

describe("besteZeile", () => {
  it("Sicherheit vor Vollstaendigkeit vor Kopie vor Pfadlaenge", () => {
    const a = z(1, { sicherheit: "mittel" });
    const b = z(2, { sicherheit: "hoch", grundlage: { faellig: "2027-12-31" } });
    const c = z(3, { sicherheit: "hoch", pfad: "X/Historie/V.pdf" });
    const d = z(4, { sicherheit: "hoch", pfad: "X/Entwuerfe/ein-viel-laengerer-name.pdf" });
    expect(besteZeile([a, b, c, d]).id).toBe(d.id);
    expect(besteZeile([a, b, c]).id).toBe(c.id);
    expect(besteZeile([a, b]).id).toBe(b.id);
  });
});

describe("planeBereinigung", () => {
  // Echter Fall (Okt. 2026): derselbe SCALA-Vertrag als .docx/.pdf, V02 und
  // Historie-Kopie -> 4 gleiche Kündigungs-Fristen.
  const scala = [
    z(1, { pfad: "S/01_Entwuerfe/V02.docx" }),
    z(2, { pfad: "S/01_Entwuerfe/V02.pdf" }),
    z(3, { pfad: "S/01_Entwuerfe/Historie/V.docx" }),
    z(4, { pfad: "S/01_Entwuerfe/Historie/V.pdf", bezeichnung: "Kündigung · SCALA BASEL", grundlage: { faellig: "2027-12-31" } }),
  ];
  const andere = [
    z(5, { pfad: "ZZ/Gegenvorschlag.docx", datum: "2026-12-31", bezeichnung: "Kündigung · Verein Scala Basel" }),
    z(6, { pfad: "ZZ/Gegenvorschlag.docx", art: "zahlung", datum: "2027-01-01", bezeichnung: "Zahlung · Verein Scala Basel" }),
    z(7, { pfad: "ZZ/bilanz.pdf", art: "ablauf", datum: "2026-12-31", bezeichnung: "Ablauf · bilanz.pdf" }),
  ];

  it("fuehrt gleiche Frist (Art + Partei + Datum) zusammen, alle Dokumente bleiben als Quelle", () => {
    const plan = planeBereinigung([...scala, ...andere]);
    expect(plan.gruppen).toHaveLength(1);
    const g = plan.gruppen[0];
    expect(g.sachverhalt).toBe("kuendigung:scala basel");
    expect(g.behalten.id).toBe(scala[1].id); // gleich sicher + vollstaendig, keine Historie-Kopie, kuerzester Pfad
    expect(g.weg.map((x) => x.id).sort()).toEqual([scala[0].id, scala[2].id, scala[3].id].sort());
    expect(quellPfade({ pfad: g.behalten.pfad, weitere_pfade: g.weitere_pfade }).sort()).toEqual(scala.map((x) => x.pfad).sort());
  });

  it("anderes Datum oder andere Art wird NICHT zusammengefuehrt; ohne Partei nie", () => {
    const plan = planeBereinigung([...scala, ...andere]);
    const weg = new Set(plan.gruppen.flatMap((g) => g.weg.map((x) => x.id)));
    for (const a of andere) expect(weg.has(a.id)).toBe(false);
    expect(plan.setzen.find((s) => s.id === andere[2].id)).toBeUndefined();
    expect(plan.setzen.find((s) => s.id === andere[0].id)?.sachverhalt).toBe("kuendigung:scala basel");
  });

  it("bestaetigte, verworfene und erledigte Fristen werden nie zusammengefuehrt oder geloescht", () => {
    const aktiv = z(8, { pfad: "S/aktiv.pdf", status: "aktiv" });
    const verworfen = z(9, { pfad: "S/verworfen.pdf", status: "verworfen" });
    const erledigt = z(10, { pfad: "S/erledigt.pdf", status: "erledigt" });
    const offen = z(11, { pfad: "S/offen.pdf" });
    const plan = planeBereinigung([aktiv, verworfen, erledigt, offen]);
    expect(plan.gruppen).toHaveLength(0);
    // Sachverhalt wird nachgetragen (Abgleich der Nachtarbeit), Status nie.
    expect(plan.setzen.map((s) => s.id).sort()).toEqual([aktiv.id, verworfen.id, erledigt.id, offen.id].sort());
  });

  it("beim Ablegen erfasste Fristen bleiben unberuehrt", () => {
    const ablage = z(12, { quelle: "ablage", bezeichnung: "2026-01-01 – Vertrag.pdf" });
    expect(planeBereinigung([ablage, z(13, { pfad: "S/a.pdf" })]).gruppen).toHaveLength(0);
  });

  it("leer und Einzelfall: nichts zu tun", () => {
    expect(planeBereinigung([])).toEqual({ gruppen: [], setzen: [] });
    expect(planeBereinigung([basis]).gruppen).toHaveLength(0);
  });

  it("schon gesetzter Sachverhalt wird nicht nochmals geschrieben; vorhandene weitere_pfade bleiben", () => {
    const a = z(14, { pfad: "S/a.pdf", sachverhalt: "kuendigung:scala basel", weitere_pfade: ["S/alt.pdf"] });
    const b = z(15, { pfad: "S/bb.pdf" });
    const plan = planeBereinigung([a, b]);
    expect(plan.gruppen).toHaveLength(1);
    expect(plan.gruppen[0].behalten.id).toBe(a.id);
    expect(plan.gruppen[0].weitere_pfade).toEqual(["S/alt.pdf", "S/bb.pdf"]);
    expect(plan.setzen.find((s) => s.id === a.id)).toBeUndefined();
  });
});
