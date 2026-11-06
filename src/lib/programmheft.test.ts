import { describe, expect, it } from "vitest";
import { fundZuTermin, gleicheHerkunft, programmListeParsen, programmTage } from "./programmheft";

const SEITE = "https://www.barakuba.ch/veranstaltungen/";
const HTML = `<base href="https://www.barakuba.ch/">
<div class="event__item"><a href="2026/06/11/braente"><time datetime="2026-11-06 00:00">6.</time> / <time datetime="2026-11-07 00:00">7.</time>
<h2 class="event__title">Bränte</h2></a></div>
<div class="event__item"><a href="2026/27/11/famiglia-rossi"><time datetime="2026-11-27 00:00">27.</time>
<h2 class="event__title">Famiglia Rossi</h2></a></div>`;

describe("Programmheft", () => {
  it("mehrtägige Veranstaltung = je Abend ein Fund mit gleicher Zeit, quelleId <url>#<Tag>", () => {
    const liste = programmListeParsen(HTML, SEITE);
    expect(liste[0]).toMatchObject({ titel: "Bränte", datum: "2026-11-06", bisDatum: "2026-11-07" });
    liste[0].von = "20:00";
    const tage = programmTage(liste, "2026-11-01");
    expect(tage.map((t) => t.quelleId)).toEqual([
      "https://www.barakuba.ch/2026/06/11/braente#2026-11-06",
      "https://www.barakuba.ch/2026/06/11/braente#2026-11-07",
      "https://www.barakuba.ch/2026/27/11/famiglia-rossi#2026-11-27",
    ]);
    expect(tage.slice(0, 2).map((t) => [t.datum, t.von])).toEqual([["2026-11-06", "20:00"], ["2026-11-07", "20:00"]]);
    // je Abend ein eigener Termin am selben Tag, kein durchgehender Block
    const t2 = fundZuTermin(tage[1])!;
    expect(new Date(t2.start_at).toISOString()).toBe("2026-11-07T19:00:00.000Z");
    expect(t2.end_at).toBeNull();
  });

  it("vergangene Abende fallen weg", () => {
    const tage = programmTage(programmListeParsen(HTML, SEITE), "2026-11-07");
    expect(tage.map((t) => t.datum)).toEqual(["2026-11-07", "2026-11-27"]);
  });
  it("Detailseiten nur von derselben Herkunft", () => {
    const h = new URL("https://www.barakuba.ch/veranstaltungen/").origin;
    expect(gleicheHerkunft("https://www.barakuba.ch/2026/27/11/famiglia-rossi", h)).toBe(true);
    expect(gleicheHerkunft("http://www.barakuba.ch/x", h)).toBe(false);
    expect(gleicheHerkunft("https://barakuba.ch.evil.example/x", h)).toBe(false);
    expect(gleicheHerkunft("https://169.254.169.254/latest", h)).toBe(false);
    expect(gleicheHerkunft("kein url", h)).toBe(false);
  });
});
