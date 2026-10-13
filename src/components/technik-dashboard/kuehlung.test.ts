import { describe, expect, it } from "vitest";
import { PROFIL_UEBERNAHME_MS } from "@/lib/technik-dashboard/konstanten";
import type { RigPaket } from "@/lib/technik-dashboard/typen";
import { eckDrehungen, rpmAchse, rpmDauer, uebernahme } from "./kuehlung";

const rig = (over: Partial<RigPaket> = {}): RigPaket => ({ gemessen_am: "2026-10-14T10:00:00Z", ...over });

describe("Technik-Dashboard — gezeichnete Front-Luefter drehen nach echten Drehzahlen", () => {
  it("genau drei Front-Luefter: jeder mit eigener Drehzahl, ein stehender bleibt still", () => {
    const r = rig({ kuehlung: { status: "ok", luefter: [
      { nr: 3, ort: "front", rpm: 600 }, { nr: 1, ort: "front", rpm: 2400 }, { nr: 2, ort: "front", rpm: 0, prozent: 30 }, { nr: 4, ort: "radiator", rpm: 1500 },
    ] } });
    expect(eckDrehungen(r, true)).toEqual([rpmDauer(2400), null, rpmDauer(600)]);
  });

  it("sonst Mittel der drehenden (Front, dann alle, dann Radiator aus cpu.luefter_rpm)", () => {
    const zwei = rig({ kuehlung: { status: "ok", luefter: [{ nr: 1, ort: "front", rpm: 1000 }, { nr: 2, ort: "front", rpm: 0 }, { nr: 3, ort: "heck", rpm: 3000 }] } });
    expect(eckDrehungen(zwei, true)).toEqual(Array(3).fill(rpmDauer(1000)));
    const ohneFront = rig({ kuehlung: { status: "ok", luefter: [{ nr: 1, ort: "radiator", rpm: 800 }, { nr: 2, ort: "heck", rpm: 1200 }] } });
    expect(eckDrehungen(ohneFront, true)).toEqual(Array(3).fill(rpmDauer(1000)));
    expect(eckDrehungen(rig({ cpu: { luefter_rpm: [1200, 0] } }), true)).toEqual(Array(3).fill(rpmDauer(1200)));
  });

  it("veraltet, ohne Rig oder ohne Drehzahl: alle still (kein erfundener Wert)", () => {
    const r = rig({ kuehlung: { status: "ok", luefter: [{ nr: 1, ort: "front", rpm: 1000 }] } });
    expect(eckDrehungen(r, false)).toEqual([null, null, null]);
    expect(eckDrehungen(null, true)).toEqual([null, null, null]);
    expect(eckDrehungen(rig({ kuehlung: { status: "ok", luefter: [{ nr: 1, ort: "front" }] } }), true)).toEqual([null, null, null]);
    expect(eckDrehungen(rig(), true)).toEqual([null, null, null]);
  });
});

describe("Technik-Dashboard — Uebernahme des Luefter-Profils (nur Serverdaten)", () => {
  const jetzt = Date.parse("2026-10-14T10:00:00Z");
  const stand = (wunsch: "leise" | "ausgewogen" | "kuehl" | null, aktiv: "leise" | "ausgewogen" | "kuehl" | undefined, vorMs: number) => ({
    steuerung: wunsch ? { luefter_profil: wunsch, geaendert_am: new Date(jetzt - vorMs).toISOString() } : null,
    rig: rig({ kuehlung: { status: "ok" as const, profil_aktiv: aktiv } }),
  });

  it("gleich, wenn das Rig das gewuenschte Profil meldet", () => {
    expect(uebernahme(stand("kuehl", "kuehl", 10_000), jetzt)).toEqual({ art: "gleich", wunsch: "kuehl", aktiv: "kuehl" });
  });

  it("laeuft innerhalb der Frist, danach ruhig offen", () => {
    expect(uebernahme(stand("kuehl", "ausgewogen", 20_000), jetzt).art).toBe("laeuft");
    expect(uebernahme(stand("kuehl", "ausgewogen", PROFIL_UEBERNAHME_MS + 1), jetzt).art).toBe("offen");
    expect(uebernahme(stand("leise", undefined, 5_000), jetzt).art).toBe("laeuft");
  });

  it("ohne lesbaren Wunsch unbekannt", () => {
    expect(uebernahme(stand(null, "ausgewogen", 0), jetzt)).toEqual({ art: "unbekannt", wunsch: null, aktiv: "ausgewogen" });
  });
});

describe("Technik-Dashboard — Achse der Drehzahl-Kurven", () => {
  it("rundet auf 500 auf, mindestens die Vorgabe", () => {
    expect(rpmAchse(undefined, 3000)).toBe(3000);
    expect(rpmAchse([[0, 2100, 2300], [1, null, null]], 2000)).toBe(3000);
    expect(rpmAchse([[0, 4100, null]], 3000)).toBe(5000);
  });
});
