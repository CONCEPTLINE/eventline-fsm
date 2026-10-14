import { describe, expect, it } from "vitest";
import {
  aenderungZeilen,
  idsZumAufloesen,
  kuerzen,
  ruecknehmbareId,
  wertAnzeigen,
  wiederherstellenText,
  zeileAlsText,
  type AenderungNamen,
  type AuftragAenderung,
} from "./auftrag-aenderungen";

const namen: AenderungNamen = {
  kunde: { k1: "Verein SCALA", k2: "Muster AG" },
  location: { l1: "Volkshaus" },
  raum: { r1: "Saal 1" },
  person: { p1: "Leo Muster", p2: "Mischa Muster" },
};

function eintrag(p: Partial<AuftragAenderung>): AuftragAenderung {
  return {
    id: "x",
    zeitpunkt: "2026-10-14T10:00:00+00:00",
    person_id: null,
    person_name: null,
    felder: {},
    art: "aenderung",
    bezug_id: null,
    rueckgaengig_at: null,
    rueckgaengig_von: null,
    ...p,
  };
}

describe("wertAnzeigen", () => {
  it("leer → Strich", () => {
    expect(wertAnzeigen("title", null)).toBe("—");
    expect(wertAnzeigen("contact_email", "  ")).toBe("—");
  });

  it("Datum auf Mitternacht Zürich ohne Uhrzeit, sonst mit (Sommer- und Winterzeit)", () => {
    // Mitternacht Zürich im Sommer (UTC+2) und im Winter (UTC+1), egal in welcher Zeitzone gespeichert
    expect(wertAnzeigen("start_date", "2026-10-13T22:00:00+00:00")).toBe("14.10.2026");
    expect(wertAnzeigen("end_date", "2026-12-01T00:00:00+01:00")).toBe("01.12.2026");
    expect(wertAnzeigen("start_date", "2026-10-14T16:30:00+02:00")).toBe("14.10.2026, 16:30");
  });

  it("UTC-Mitternacht (Entwurf-Umwandlung, KI-Umdatierung) zählt als reines Datum", () => {
    expect(wertAnzeigen("start_date", "2026-10-14T00:00:00+00:00")).toBe("14.10.2026");
    expect(wertAnzeigen("end_date", "2026-12-01T00:00:00+00:00")).toBe("01.12.2026");
    // echte Uhrzeit bleibt sichtbar
    expect(wertAnzeigen("start_date", "2026-10-14T08:15:00+00:00")).toBe("14.10.2026, 10:15");
  });

  it("IDs werden zu Namen, Unbekanntes bleibt erkennbar", () => {
    expect(wertAnzeigen("customer_id", "k1", namen)).toBe("Verein SCALA");
    expect(wertAnzeigen("location_id", "l1", namen)).toBe("Volkshaus");
    expect(wertAnzeigen("room_id", "r1", namen)).toBe("Saal 1");
    expect(wertAnzeigen("project_lead_id", "p2", namen)).toBe("Mischa Muster");
    expect(wertAnzeigen("customer_id", "weg", namen)).toBe("(nicht verfügbar)");
  });

  it("Auftragsart und Priorität auf Deutsch", () => {
    expect(wertAnzeigen("job_type", "location")).toBe("Location");
    expect(wertAnzeigen("job_type", "extern")).toBe("Firma / Privat");
    expect(wertAnzeigen("priority", "dringend")).toBe("Dringend");
    expect(wertAnzeigen("priority", "normal")).toBe("Normal");
  });
});

describe("aenderungZeilen", () => {
  it("Formular-Reihenfolge, deutsche Feldnamen, alt → neu", () => {
    const zeilen = aenderungZeilen(
      {
        end_date: { alt: "2026-10-14T22:00:00+00:00", neu: "2026-10-15T22:00:00+00:00" },
        title: { alt: "Alt", neu: "Neu" },
        customer_id: { alt: "k1", neu: "k2" },
      },
      namen,
    );
    expect(zeilen.map((z) => z.label)).toEqual(["Titel", "Kunde", "Ende"]);
    expect(zeilen.map((z) => zeileAlsText(z))).toEqual([
      "Titel: Alt → Neu",
      "Kunde: Verein SCALA → Muster AG",
      "Ende: 15.10.2026 → 16.10.2026",
    ]);
  });

  it("Beschreibung gilt als langer Text, unbekannte Felder hinten", () => {
    const zeilen = aenderungZeilen({ zz_neu: { alt: 1, neu: 2 }, description: { alt: null, neu: "kurz" } });
    expect(zeilen.map((z) => [z.label, z.lang])).toEqual([
      ["Beschreibung", true],
      ["zz_neu", false],
    ]);
    expect(zeilen[0].alt).toBe("—");
  });
});

describe("kuerzen / wiederherstellenText", () => {
  it("kürzt lange Texte und macht Zeilenumbrüche flach", () => {
    expect(kuerzen("a\n b", 10)).toBe("a b");
    expect(kuerzen("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("Rückfrage zeigt jetzt → wiederhergestellt", () => {
    const text = wiederherstellenText(aenderungZeilen({ title: { alt: "Alt", neu: "Neu" } }));
    expect(text).toContain("• Titel: Neu → Alt");
  });
});

describe("idsZumAufloesen / ruecknehmbareId", () => {
  it("sammelt Verweis-IDs inkl. «zurückgenommen von»", () => {
    const ids = idsZumAufloesen([
      eintrag({ felder: { customer_id: { alt: "k1", neu: null }, title: { alt: "a", neu: "b" } }, rueckgaengig_von: "p1" }),
      eintrag({ felder: { project_lead_id: { alt: "p2", neu: "p1" }, room_id: { alt: null, neu: "r1" } } }),
    ]);
    expect(ids.kunde).toEqual(["k1"]);
    expect(ids.raum).toEqual(["r1"]);
    expect(ids.person.sort()).toEqual(["p1", "p2"]);
    expect(ids.location).toEqual([]);
  });

  it("nur die neueste offene Änderung ist rücknehmbar", () => {
    const liste = [
      eintrag({ id: "r", art: "rueckgaengig", bezug_id: "c" }),
      eintrag({ id: "c", rueckgaengig_at: "2026-10-14T11:00:00Z" }),
      eintrag({ id: "b" }),
      eintrag({ id: "a" }),
    ];
    expect(ruecknehmbareId(liste)).toBe("b");
    expect(ruecknehmbareId([eintrag({ id: "r", art: "rueckgaengig" })])).toBeNull();
  });
});
