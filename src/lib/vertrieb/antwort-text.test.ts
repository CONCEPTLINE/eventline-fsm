import { describe, expect, it } from "vitest";
import { antwortText, htmlZuText, ohneZitat } from "./antwort-text";

describe("htmlZuText", () => {
  it("macht aus HTML Absätze und dekodiert Zeichen", () => {
    const html = "<html><head><style>p{}</style></head><body><p>Guten Tag Herr Balaszeskul</p><p>Gerne&nbsp;nehmen wir Kontakt auf &amp; melden uns.<br>Freundliche Grüsse</p><ul><li>Punkt</li></ul></body></html>";
    expect(htmlZuText(html)).toBe("Guten Tag Herr Balaszeskul\n\nGerne nehmen wir Kontakt auf & melden uns.\nFreundliche Grüsse\n\n• Punkt");
  });
  it("Zahlen-Entitäten", () => {
    expect(htmlZuText("Z&#252;rich &#x2013; Basel")).toBe("Zürich – Basel");
  });
});

describe("ohneZitat", () => {
  it("schneidet beim Outlook-Kopf ab", () => {
    const t = "Danke, gerne.\n\nGruss Anna\n\nVon: Leo <leo@eventline-basel.com>\nGesendet: Montag, 3. November 2026\nBetreff: Messe\n\nGuten Tag …";
    expect(ohneZitat(t)).toBe("Danke, gerne.\n\nGruss Anna");
  });
  it("schneidet bei «Am … schrieb …:» und entfernt >-Zeilen", () => {
    expect(ohneZitat("Ja, interessiert.\n> alte Zeile\nAm 3.11.2026 um 08:00 schrieb Leo <leo@x.ch>:\nalt")).toBe("Ja, interessiert.");
    expect(ohneZitat("Yes please.\n\nOn Mon, Nov 3, 2026 at 8:00 AM Leo wrote:\nold")).toBe("Yes please.");
  });
  it("schneidet bei Original-Nachricht und Unterstrich-Trenner", () => {
    expect(ohneZitat("Ok\n-----Ursprüngliche Nachricht-----\nalt")).toBe("Ok");
    expect(ohneZitat("Ok\n________________________________\nVon: x")).toBe("Ok");
  });
  it("nur Zitat → ganzer Text bleibt", () => {
    expect(ohneZitat("> nur zitiert")).toBe("> nur zitiert");
  });
});

describe("antwortText", () => {
  it("bevorzugt uniqueBody, fällt auf body zurück", () => {
    expect(antwortText({ contentType: "text", content: "Neu" }, { contentType: "text", content: "Neu\nVon: a\nAn: b" })).toBe("Neu");
    expect(antwortText({ contentType: "text", content: "  " }, { contentType: "html", content: "<p>Hallo</p>" })).toBe("Hallo");
    expect(antwortText(null, null)).toBe("");
  });
});
