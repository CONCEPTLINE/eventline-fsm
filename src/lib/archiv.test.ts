import { describe, it, expect } from "vitest";
import {
  auftragArchiviert,
  kundeArchiviert,
  standortArchiviert,
  projektArchiviert,
  entwurfArchiviert,
  istArchivSperre,
  vermerk,
  vermerkMitBegruendung,
  auftragStornoTooltip,
  auftragStornoVon,
} from "@/lib/archiv";

// Archiv = nur lesen (Leo 2026-10-15) — die Regeln muessen 1:1 zu den
// DB-Triggern aus Migration 342 passen.
describe("Archiv-Regeln je Bereich", () => {
  it("Auftraege: abgeschlossen + storniert", () => {
    expect(auftragArchiviert("abgeschlossen")).toBe(true);
    expect(auftragArchiviert("storniert")).toBe(true);
    for (const s of ["offen", "partner_anfrage", "partner_entwurf", "entwurf", "anfrage", null, undefined, ""]) {
      expect(auftragArchiviert(s)).toBe(false);
    }
  });
  it("Kunden/Locations: archived_at gesetzt", () => {
    expect(kundeArchiviert({ archived_at: "2026-10-01T10:00:00Z" })).toBe(true);
    expect(kundeArchiviert({ archived_at: null })).toBe(false);
    expect(kundeArchiviert(null)).toBe(false);
    expect(standortArchiviert({ archived_at: "2026-10-01T10:00:00Z" })).toBe(true);
    expect(standortArchiviert({ archived_at: null })).toBe(false);
  });
  it("Projekte: abgeschlossen + abgelehnt + storniert", () => {
    for (const s of ["abgeschlossen", "abgelehnt", "storniert"]) expect(projektArchiviert(s)).toBe(true);
    for (const s of ["entwurf", "angefragt", "genehmigt"]) expect(projektArchiviert(s)).toBe(false);
  });
  it("Entwuerfe: storniert + umgewandelt", () => {
    expect(entwurfArchiviert("storniert")).toBe(true);
    expect(entwurfArchiviert("umgewandelt")).toBe(true);
    expect(entwurfArchiviert("aktiv")).toBe(false);
    expect(entwurfArchiviert("wartet_auf_kunde")).toBe(false);
  });
  it("DB-Sperre wird am SQLSTATE PT409 erkannt", () => {
    expect(istArchivSperre({ code: "PT409" })).toBe(true);
    expect(istArchivSperre({ code: "42501" })).toBe(false);
    expect(istArchivSperre(null)).toBe(false);
  });
});

describe("Vermerk «Storniert am … von … — Begründung: …»", () => {
  it("Datum im Zuercher Kalender (23:30 UTC = naechster Tag in Zuerich)", () => {
    expect(vermerk("Storniert", "2026-10-14T23:30:00Z", "Leo Muster")).toBe("Storniert am 15.10.2026 von Leo Muster");
  });
  it("fehlende Teile fallen weg", () => {
    expect(vermerk("Storniert")).toBe("Storniert");
    expect(vermerk("Storniert", null, "  ")).toBe("Storniert");
    expect(vermerkMitBegruendung("Abgelehnt", null, null, "  ")).toBe("Abgelehnt");
    expect(vermerkMitBegruendung("Abgelehnt", null, null, " Budget fehlt ")).toBe("Abgelehnt — Begründung: Budget fehlt");
  });
  it("Auftrags-Tooltip nur bei storniert, Name aus Profil oder Namens-Historie", () => {
    const basis = { cancelled_at: "2026-10-01T08:00:00Z", cancellation_reason: "Kunde hat abgesagt" };
    expect(auftragStornoTooltip({ ...basis, status: "abgeschlossen" })).toBeUndefined();
    expect(auftragStornoTooltip({ ...basis, status: "storniert", cancelled_by_profile: { full_name: "Leo Muster" } }))
      .toBe("Storniert am 01.10.2026 von Leo Muster — Begründung: Kunde hat abgesagt");
    expect(auftragStornoVon({ cancelled_by_profile: null, cancelled_by_name: "Ehemalig" })).toBe("Ehemalig");
    expect(auftragStornoTooltip({ status: "storniert", cancelled_at: null, cancellation_reason: null })).toBe("Storniert");
  });
});
