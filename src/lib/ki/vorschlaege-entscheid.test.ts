import { describe, expect, it, vi } from "vitest";
import { fakeAdmin, type FakeDb } from "./test-fake-db";
import { baueLernbeispiel, legeNeuenOrdnerAn, leseEntscheideBody, pruefeEntscheidName, pruefeNeuenOrdner, schreibeLernbeispiel, zielFuerEntscheid } from "./vorschlaege";

// Entscheide ueber Vorschlaege (Migration 329): neuer Dateiname, neuer
// Ordner (ziel_neu) und Lernbeispiele.

const ID = "0b9c2c6e-6a55-4d1f-9b1e-0d6f4a0e1a11";
const PFAD = "ZZ_Dokumente/_EVENTLINE/20260828191911_001.pdf";

describe("leseEntscheideBody: name", () => {
  it("name bei annehmen/korrigieren uebernommen, bei ablehnen weggelassen", () => {
    const r = leseEntscheideBody({
      entscheide: [
        { id: ID, aktion: "annehmen", name: "Neu.pdf" },
        { id: ID.replace("11", "12"), aktion: "ablehnen", name: "egal.pdf" },
      ],
    });
    expect(r).toEqual({ ok: true, entscheide: [{ id: ID, aktion: "annehmen", name: "Neu.pdf" }, { id: ID.replace("11", "12"), aktion: "ablehnen" }] });
  });
  it("name kein String -> 400", () => {
    expect(leseEntscheideBody({ entscheide: [{ id: ID, aktion: "annehmen", name: 3 }] })).toEqual({ ok: false, fehler: "Ungültiger Dateiname" });
  });
});

describe("pruefeEntscheidName", () => {
  it("leer/unveraendert -> Name bleibt", () => {
    expect(pruefeEntscheidName(undefined, PFAD)).toEqual({ name: null });
    expect(pruefeEntscheidName("  ", PFAD)).toEqual({ name: null });
    expect(pruefeEntscheidName("20260828191911_001.pdf", PFAD)).toEqual({ name: null });
  });
  it("gueltig -> neuer Name; ungueltig -> 400 mit Grund", () => {
    expect(pruefeEntscheidName(" 2026-08-28_Scan_Rechnung_Herzog-Tech.pdf ", PFAD)).toEqual({ name: "2026-08-28_Scan_Rechnung_Herzog-Tech.pdf" });
    expect(pruefeEntscheidName("Scan.docx", PFAD)).toEqual({ code: 400, fehler: "Dateiname ungültig: Endung muss .pdf bleiben" });
    expect(pruefeEntscheidName("Lohn_28_CHF.pdf", PFAD)).toEqual({ code: 400, fehler: "Dateiname ungültig: enthält Inhaltsangabe: Betrag" });
  });
});

describe("pruefeNeuenOrdner", () => {
  const aktiv = new Map([["01_FIRMA", "01_FIRMA"], ["06_PERSONAL/1001_Müller", "06_PERSONAL/1001_Müller"]]);
  it("eine neue Ebene unter aktivem Oberordner, Schreibweise des Oberordners", () => {
    expect(pruefeNeuenOrdner("01_FIRMA/05_Versicherungen", aktiv, "ZZ_Dokumente")).toEqual({ pfad: "01_FIRMA/05_Versicherungen" });
    expect(pruefeNeuenOrdner("06_PERSONAL/1001_Müller/Verträge".normalize("NFC"), new Map([["06_PERSONAL/1001_Müller".normalize("NFC"), "06_PERSONAL/1001_Müller"]]), "ZZ_Dokumente")).toEqual({
      pfad: "06_PERSONAL/1001_Müller/Verträge",
    });
  });
  it("abgewiesen: kein Oberordner, inaktiver Oberordner, ZZ/99_System, schlechter Name", () => {
    expect(pruefeNeuenOrdner("Neu", aktiv, "ZZ_X")).toMatchObject({ code: 400 });
    expect(pruefeNeuenOrdner("02_LOCATIONS/Neu", aktiv, "ZZ_X")).toMatchObject({ code: 409 });
    expect(pruefeNeuenOrdner("01_FIRMA/ZZ_Neu", aktiv, "ZZ_X")).toMatchObject({ code: 400 });
    expect(pruefeNeuenOrdner("99_System/Neu", aktiv, "ZZ_X")).toMatchObject({ code: 400 });
    expect(pruefeNeuenOrdner("01_FIRMA/.versteckt", aktiv, "ZZ_X")).toMatchObject({ code: 400 });
    expect(pruefeNeuenOrdner("01_FIRMA/a:b", aktiv, "ZZ_X")).toMatchObject({ code: 400 });
  });
});

describe("Lernbeispiele", () => {
  const vorschlag = { id: "v1", pfad: PFAD, ziel_ordner: "01_FIRMA/03_Rechnungen", name_vorschlag: "2026-08-28_Scan_Rechnung.pdf" };

  it("angenommen ohne Aenderung", () => {
    expect(
      baueLernbeispiel({ vorschlag, aktion: "angenommen", finalOrdner: "01_FIRMA/03_Rechnungen", finalName: "2026-08-28_Scan_Rechnung.pdf", beschrieb: { a: 1 }, dokart: "rechnung", userId: "u1" }),
    ).toMatchObject({ original_name: "20260828191911_001.pdf", final_ordner: "01_FIRMA/03_Rechnungen", ordner_geaendert: false, name_geaendert: false, entschieden_von: "u1" });
  });

  it("korrigiert: anderer Ordner, Name behalten (= geaendert gegenueber Vorschlag)", () => {
    const z = baueLernbeispiel({ vorschlag, aktion: "korrigiert", finalOrdner: "01_FIRMA/04_Offerten", finalName: null, beschrieb: {}, dokart: null, userId: "u1" });
    expect(z).toMatchObject({ final_ordner: "01_FIRMA/04_Offerten", final_name: "20260828191911_001.pdf", ordner_geaendert: true, name_geaendert: true });
  });

  it("abgelehnt: final_* und Flags null", () => {
    const z = baueLernbeispiel({ vorschlag, aktion: "abgelehnt", finalOrdner: null, finalName: null, beschrieb: {}, dokart: null, userId: "u1" });
    expect(z).toMatchObject({ aktion: "abgelehnt", final_ordner: null, final_name: null, ordner_geaendert: null, name_geaendert: null, vorgeschlagen_ordner: "01_FIRMA/03_Rechnungen" });
  });

  it("schreibeLernbeispiel: nur mit ZZ-Beschrieb, Beschrieb und Dokumentart aus der Warteschlange", async () => {
    const db: FakeDb = {
      tabellen: { nas_zz_beschriebe: [{ id: "b1", vorschlag_id: "v1", beschrieb: { dokart: "rechnung", was: "Rechnung" } }], nas_ablage_lernbeispiele: [] },
      aufrufe: [],
    };
    const dokart = vi.fn((b: unknown) => (b as { dokart: string }).dokart);
    const ok = await schreibeLernbeispiel(fakeAdmin(db) as never, { vorschlag, aktion: "angenommen", finalOrdner: vorschlag.ziel_ordner, finalName: null, userId: "u1" }, dokart);
    expect(ok).toBe(true);
    expect(db.tabellen.nas_ablage_lernbeispiele).toHaveLength(1);
    expect(db.tabellen.nas_ablage_lernbeispiele[0]).toMatchObject({ vorschlag_id: "v1", dokart: "rechnung", beschrieb: { dokart: "rechnung", was: "Rechnung" }, name_geaendert: true });

    const ohne = await schreibeLernbeispiel(fakeAdmin(db) as never, { vorschlag: { ...vorschlag, id: "v2" }, aktion: "abgelehnt", finalOrdner: null, finalName: null, userId: "u1" }, dokart);
    expect(ohne).toBe(false);
    expect(db.tabellen.nas_ablage_lernbeispiele).toHaveLength(1);
  });

  it("schreibeLernbeispiel wirft nie (DB-Fehler nur geloggt)", async () => {
    const kaputt = { from: () => { throw new Error("weg"); } };
    await expect(schreibeLernbeispiel(kaputt as never, { vorschlag, aktion: "abgelehnt", finalOrdner: null, finalName: null, userId: "u1" }, () => null)).resolves.toBe(false);
  });
});

describe("Neuer Ordner beim Uebernehmen", () => {
  const zeile = { ziel_neu: true, ziel_ordner: "01_FIRMA/05_Versicherungen", ordner_ist: "ZZ_Dokumente" };

  it("gibt es den Ordner noch nicht -> neuer Ordner", () => {
    expect(zielFuerEntscheid(zeile, "01_FIRMA/05_Versicherungen", new Map([["01_FIRMA", "01_FIRMA"]]))).toEqual({ ziel: "01_FIRMA/05_Versicherungen", neuerOrdner: true });
  });

  it("inzwischen angelegt (anderer Vorschlag, auch nas_ausstehend) -> bestehender Ordner, kein Insert", () => {
    const aktiv = new Map([["01_FIRMA", "01_FIRMA"], ["01_FIRMA/05_Versicherungen", "01_FIRMA/05_Versicherungen"]]);
    expect(zielFuerEntscheid(zeile, "01_FIRMA/05_Versicherungen", aktiv)).toEqual({ ziel: "01_FIRMA/05_Versicherungen", neuerOrdner: false });
  });

  it("anderer (bestehender) Ordner gewaehlt -> normaler Weg", () => {
    expect(zielFuerEntscheid(zeile, "01_FIRMA", new Map([["01_FIRMA", "01_FIRMA"]]))).toEqual({ ziel: "01_FIRMA", neuerOrdner: false });
  });

  it("legeNeuenOrdnerAn: Konflikt auf pfad (gleichzeitig angelegt) ist kein Fehler, kein Doppel", async () => {
    const db: FakeDb = {
      tabellen: { ablage_ordner: [{ id: "o1", pfad: "01_FIRMA/05_Versicherungen", aktiv: true, nas_ausstehend: true }] },
      unique: { ablage_ordner: (z, alle) => alle.some((a) => a.pfad === z.pfad) },
      aufrufe: [],
    };
    await expect(legeNeuenOrdnerAn(fakeAdmin(db) as never, "01_FIRMA/05_Versicherungen")).resolves.toBeNull();
    expect(db.tabellen.ablage_ordner).toHaveLength(1);
    await expect(legeNeuenOrdnerAn(fakeAdmin(db) as never, "01_FIRMA/06_Neu")).resolves.toBeNull();
    expect(db.tabellen.ablage_ordner.map((o) => o.pfad)).toEqual(["01_FIRMA/05_Versicherungen", "01_FIRMA/06_Neu"]);
  });
});
