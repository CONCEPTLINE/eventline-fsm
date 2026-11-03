import { describe, expect, it } from "vitest";
import {
  ARZTZEUGNIS_AB_TAG,
  arztzeugnisFaelligAb,
  arztzeugnisFehlt,
  bisherigeTage,
  kalenderTage,
  krankLaeuft,
} from "./krank";

describe("krank — Arztzeugnis ab dem 3. Kalendertag (AAB)", () => {
  it("Regel ist der 3. Kalendertag", () => {
    expect(ARZTZEUGNIS_AB_TAG).toBe(3);
  });

  it("zaehlt Kalendertage inklusiv, auch ueber Monats- und Jahreswechsel", () => {
    expect(kalenderTage("2026-11-03", "2026-11-03")).toBe(1);
    expect(kalenderTage("2026-10-31", "2026-11-02")).toBe(3);
    expect(kalenderTage("2026-12-31", "2027-01-01")).toBe(2);
  });

  it("faellig ab Tag 3 (Ab + 2)", () => {
    expect(arztzeugnisFaelligAb("2026-11-03")).toBe("2026-11-05");
    expect(arztzeugnisFaelligAb("2026-10-30")).toBe("2026-11-01");
  });

  it("offenes Ende: Tag 1 und 2 ohne Zeugnis ok, ab Tag 3 fehlt es", () => {
    const k = { ab: "2026-11-03", bis: "2026-11-03", endeOffen: true, hatZeugnis: false };
    expect(arztzeugnisFehlt(k, "2026-11-03")).toBe(false);
    expect(arztzeugnisFehlt(k, "2026-11-04")).toBe(false);
    expect(arztzeugnisFehlt(k, "2026-11-05")).toBe(true);
  });

  it("bekanntes Ende unter 3 Tagen: nie faellig", () => {
    const k = { ab: "2026-11-03", bis: "2026-11-04", endeOffen: false, hatZeugnis: false };
    expect(bisherigeTage(k, "2026-11-20")).toBe(2);
    expect(arztzeugnisFehlt(k, "2026-11-20")).toBe(false);
  });

  it("bekanntes Ende ab 3 Tagen: faellig erst, wenn Tag 3 erreicht ist", () => {
    const k = { ab: "2026-11-03", bis: "2026-11-07", endeOffen: false, hatZeugnis: false };
    expect(arztzeugnisFehlt(k, "2026-11-04")).toBe(false);
    expect(arztzeugnisFehlt(k, "2026-11-05")).toBe(true);
  });

  it("mit Zeugnis fehlt nichts; Ab in der Zukunft zaehlt 0 Tage", () => {
    expect(arztzeugnisFehlt({ ab: "2026-11-01", bis: "2026-11-01", endeOffen: true, hatZeugnis: true }, "2026-11-09")).toBe(false);
    expect(bisherigeTage({ ab: "2026-11-10", bis: "2026-11-10", endeOffen: true }, "2026-11-03")).toBe(0);
  });

  it("laeuft bei offenem Ende oder Ende nach heute; Ende heute = abgeschlossen", () => {
    expect(krankLaeuft({ bis: "2026-11-01", endeOffen: true }, "2026-11-03")).toBe(true);
    expect(krankLaeuft({ bis: "2026-11-04", endeOffen: false }, "2026-11-03")).toBe(true);
    expect(krankLaeuft({ bis: "2026-11-03", endeOffen: false }, "2026-11-03")).toBe(false);
    expect(krankLaeuft({ bis: "2026-11-02", endeOffen: false }, "2026-11-03")).toBe(false);
  });
});
