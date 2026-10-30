import { describe, expect, it } from "vitest";
import { icsEnde, icsFalten, icsTagZuerich, icsText, icsZeitUtc } from "./ical";

describe("icsTagZuerich", () => {
  it("Mitternacht Zürich (Sommer, 22:00 UTC am Vortag) bleibt der Zürcher Tag", () => {
    expect(icsTagZuerich(new Date("2026-06-15T22:00:00Z"))).toBe("20260616");
  });
  it("Mitternacht Zürich (Winter, 23:00 UTC am Vortag) bleibt der Zürcher Tag", () => {
    expect(icsTagZuerich(new Date("2026-11-30T23:00:00Z"))).toBe("20261201");
  });
  it("00:00 UTC ist derselbe Tag in Zürich", () => {
    expect(icsTagZuerich(new Date("2026-04-17T00:00:00Z"))).toBe("20260417");
  });
  it("Ende exklusiv: + 1 Tag über Monats- und Jahresgrenze", () => {
    expect(icsTagZuerich(new Date("2026-12-30T23:00:00Z"), 1)).toBe("20270101");
    expect(icsTagZuerich(new Date("2026-02-28T00:00:00Z"), 1)).toBe("20260301");
  });
  it("Zeitumstellung: letzter Sonntag im Oktober", () => {
    expect(icsTagZuerich(new Date("2026-10-24T22:00:00Z"), 1)).toBe("20261026");
  });
});

describe("icsZeitUtc / icsEnde", () => {
  it("UTC-Format mit Z", () => {
    expect(icsZeitUtc(new Date("2026-05-05T06:00:00Z"))).toBe("20260505T060000Z");
  });
  it("Ende vor Start → Start + 1 h", () => {
    const s = new Date("2026-05-05T06:00:00Z");
    expect(icsEnde(s, new Date("2026-05-04T22:00:00Z")).toISOString()).toBe("2026-05-05T07:00:00.000Z");
    expect(icsEnde(s, null).toISOString()).toBe("2026-05-05T07:00:00.000Z");
    expect(icsEnde(s, s).toISOString()).toBe("2026-05-05T07:00:00.000Z");
  });
  it("gültiges Ende bleibt", () => {
    const s = new Date("2026-05-05T06:00:00Z");
    const e = new Date("2026-05-05T09:30:00Z");
    expect(icsEnde(s, e)).toBe(e);
  });
});

describe("icsText", () => {
  it("maskiert Sonderzeichen und alle Zeilenumbrüche", () => {
    expect(icsText("a,b;c\\d\r\ne\rf\ng")).toBe("a\\,b\\;c\\\\d\\ne\\nf\\ng");
  });
  it("null/undefined → leer", () => {
    expect(icsText(null)).toBe("");
    expect(icsText(undefined)).toBe("");
  });
});

describe("icsFalten", () => {
  it("kurze Zeile bleibt", () => {
    expect(icsFalten("SUMMARY:kurz")).toBe("SUMMARY:kurz");
  });
  it("faltet nach 75 Bytes, Folgezeilen mit Leerzeichen, Inhalt bleibt", () => {
    const zeile = "DESCRIPTION:" + "ä".repeat(100);
    const gefaltet = icsFalten(zeile);
    const enc = new TextEncoder();
    for (const teil of gefaltet.split("\r\n")) expect(enc.encode(teil).length).toBeLessThanOrEqual(75);
    expect(gefaltet.split("\r\n").slice(1).every((t) => t.startsWith(" "))).toBe(true);
    expect(gefaltet.replace(/\r\n /g, "")).toBe(zeile);
  });
});
