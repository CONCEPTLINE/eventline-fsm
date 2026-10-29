import { describe, expect, it } from "vitest";
import { entschluessele, verschluessele } from "./token-krypto";

describe("Token-Verschlüsselung", () => {
  const geheimnis = "test-service-role-key";
  it("hin und zurück, jedes Mal anderer Geheimtext", () => {
    const a = verschluessele("refresh-123", geheimnis);
    const b = verschluessele("refresh-123", geheimnis);
    expect(a.startsWith("v1:")).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain("refresh-123");
    expect(entschluessele(a, geheimnis)).toEqual({ klar: "refresh-123", warVerschluesselt: true });
  });
  it("Alt-Token unverschlüsselt wird akzeptiert", () => {
    expect(entschluessele("0.AXoA-alt", geheimnis)).toEqual({ klar: "0.AXoA-alt", warVerschluesselt: false });
  });
  it("falscher Schlüssel oder veränderter Text → Fehler", () => {
    const a = verschluessele("refresh-123", geheimnis);
    expect(() => entschluessele(a, "anderer-key")).toThrow();
    expect(() => entschluessele(a.slice(0, -4) + "AAAA", geheimnis)).toThrow();
  });
});
