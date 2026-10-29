import { describe, expect, it } from "vitest";
import { bereinigeNachfassText, nachfassStand, neutralisiere, wiederEinsetzen, NACHFASS_MAX, NACHFASS_TAGE, type NachfassFelder } from "./nachfassen";

const jetzt = new Date("2026-11-20T12:00:00Z");
const basis: NachfassFelder = {
  status: "gesendet",
  antworten_anzahl: 0,
  nachfass_anzahl: 0,
  mail_gesendet_am: "2026-11-05T08:00:00Z",
  nachgefasst_am: null,
};

describe("Nachfassen", () => {
  it("Konstanten: 10 Tage, höchstens 2 Runden", () => {
    expect(NACHFASS_TAGE).toBe(10);
    expect(NACHFASS_MAX).toBe(2);
  });

  it("angeschrieben vor mehr als 10 Tagen, keine Antwort → fällig", () => {
    const s = nachfassStand(basis, jetzt);
    expect(s).toMatchObject({ moeglich: true, faellig: true, faelligAb: "2026-11-15T08:00:00.000Z" });
  });

  it("weniger als 10 Tage → noch nicht fällig, aber mit Datum", () => {
    const s = nachfassStand({ ...basis, mail_gesendet_am: "2026-11-15T08:00:00Z" }, jetzt);
    expect(s).toMatchObject({ moeglich: true, faellig: false, faelligAb: "2026-11-25T08:00:00.000Z" });
  });

  it("genau auf der Grenze ist noch nicht fällig (wie die DB: <)", () => {
    expect(nachfassStand({ ...basis, mail_gesendet_am: "2026-11-10T12:00:00Z" }, jetzt).faellig).toBe(false);
  });

  it("mit Antwort, anderem Status oder ohne Versand → nie fällig", () => {
    expect(nachfassStand({ ...basis, antworten_anzahl: 1 }, jetzt).moeglich).toBe(false);
    expect(nachfassStand({ ...basis, status: "geantwortet" }, jetzt).moeglich).toBe(false);
    expect(nachfassStand({ ...basis, status: "geplant" }, jetzt).moeglich).toBe(false);
    expect(nachfassStand({ ...basis, mail_gesendet_am: null }, jetzt).moeglich).toBe(false);
  });

  it("nach dem Nachfassen zählen 10 Tage ab dem Nachfassen", () => {
    const k = { ...basis, nachfass_anzahl: 1, nachgefasst_am: "2026-11-16T09:00:00Z" };
    expect(nachfassStand(k, jetzt)).toMatchObject({ faellig: false, faelligAb: "2026-11-26T09:00:00.000Z" });
    expect(nachfassStand(k, new Date("2026-11-27T00:00:00Z")).faellig).toBe(true);
  });

  it("nach 2 Runden nie mehr fällig", () => {
    const s = nachfassStand({ ...basis, nachfass_anzahl: 2, nachgefasst_am: "2026-10-01T09:00:00Z" }, jetzt);
    expect(s).toMatchObject({ moeglich: false, faellig: false, fertig: true });
  });
});

describe("Nachfass-Text bereinigen", () => {
  it("ß → ss und Gruss/Signatur am Ende weg", () => {
    const r = bereinigeNachfassText("Guten Tag Frau Muster\n\nGerne erinnere ich an meine Mail. Passt Ihnen ein kurzes Gespräch?\n\nFreundliche Grüße\nLeo Balaszeskul");
    expect(r.text).toBe("Guten Tag Frau Muster\n\nGerne erinnere ich an meine Mail. Passt Ihnen ein kurzes Gespräch?");
    expect(r.raumname).toBe(false);
  });
  it("erkennt verbotene Raumnamen", () => {
    expect(bereinigeNachfassText("Im BAU3 hätten wir Platz.").raumname).toBe(true);
    expect(bereinigeNachfassText("Die Barakuba ist frei.").raumname).toBe(true);
    expect(bereinigeNachfassText("Eine skalierbare Lösung.").raumname).toBe(false);
  });
});

describe("Anrede und Namen neutralisieren (nichts Persönliches an die KI)", () => {
  const mail = "Sehr geehrte Frau Anna Muster\n\nGerne stellen wir Ihnen EVENTLINE vor. Frau Muster, passt das?\n\nFreundliche Grüsse\nLeo";
  it("ersetzt Anrede-Zeile und Namen", () => {
    const n = neutralisiere(mail, "Für Frau Muster: Messe 2027", "Frau Anna Muster");
    expect(n.text).not.toMatch(/Anna|Muster/);
    expect(n.betreff).not.toMatch(/Muster/);
    expect(n.text.startsWith("{ANREDE}")).toBe(true);
    expect(n.text).toContain("Frau {NAME3}, passt das?");
  });
  it("setzt wieder ein; fehlende Anrede wird vorangestellt; Reste verschwinden", () => {
    const n = neutralisiere(mail, "Messe", "Anna Muster");
    expect(wiederEinsetzen("{ANREDE}\n\nKurz nachgefragt, Frau {NAME3}?", n.ersetzungen)).toBe("Sehr geehrte Frau Anna Muster\n\nKurz nachgefragt, Frau Muster?");
    expect(wiederEinsetzen("Kurz nachgefragt.", n.ersetzungen)).toBe("Sehr geehrte Frau Anna Muster\n\nKurz nachgefragt.");
    expect(wiederEinsetzen("Hallo {NAME9}", [])).toBe("Hallo");
  });
  it("ohne Anrede und ohne Person bleibt der Text gleich", () => {
    const n = neutralisiere("Guten Morgen zusammen", "x", null);
    expect(n.ersetzungen).toEqual([]);
  });
});
