// lib/trust-one-ablage — Fristen-Zaehler der Ablage (Trust flow / Trust one) mit Attrappe fuer fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));

import { ablageFristenLink, ablageZiel, ladeTrustOneFristen } from "./trust-one-ablage";

const TOKEN = "t".repeat(40);
const fetchMock = vi.fn();

function antwort(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("TRUST_ONE_ABLAGE_TOKEN", TOKEN);
  vi.stubEnv("TRUST_ONE_URL", "");
  vi.stubEnv("TRUST_FLOW_URL", "");
  vi.stubEnv("ABLAGE_ZIEL", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("ladeTrustOneFristen", () => {
  it("fragt Bereich eventline-gmbh fuer 30 Tage mit Bearer und liefert aktiv + vorschlag", async () => {
    fetchMock.mockResolvedValue(antwort(200, { success: true, fristen: [], anzahl_aktiv: 2, anzahl_vorschlag: 3 }));
    await expect(ladeTrustOneFristen()).resolves.toEqual({ aktiv: 2, vorschlag: 3 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://one.trust-group.ch/api/ablage/extern/fristen?bereich=eventline-gmbh&tage=30");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("TRUST_ONE_URL ueberschreibt die Adresse (ohne Schraegstrich am Ende)", async () => {
    vi.stubEnv("TRUST_ONE_URL", "http://localhost:3100/");
    fetchMock.mockResolvedValue(antwort(200, { success: true, anzahl_aktiv: 0, anzahl_vorschlag: 0 }));
    await ladeTrustOneFristen();
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:3100/api/ablage/extern/fristen?bereich=eventline-gmbh&tage=30");
  });

  it("wirft statt 0: Serverfehler, kaputte Antwort, Netzfehler, fehlender Token", async () => {
    fetchMock.mockResolvedValueOnce(antwort(500, { success: false }));
    await expect(ladeTrustOneFristen()).rejects.toThrow(/HTTP 500/);
    fetchMock.mockResolvedValueOnce(antwort(200, { success: true, anzahl_aktiv: "2", anzahl_vorschlag: 0 }));
    await expect(ladeTrustOneFristen()).rejects.toThrow(/nicht wie erwartet/);
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(ladeTrustOneFristen()).rejects.toThrow(/nicht erreichbar/);
    vi.stubEnv("TRUST_ONE_ABLAGE_TOKEN", "");
    await expect(ladeTrustOneFristen()).rejects.toThrow(/nicht verbunden/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("Schalter ABLAGE_ZIEL (Umzug nach Trust flow)", () => {
  it("Standard trust-one: fehlend, leer oder unbekannt; nur «trust-flow» schaltet um", () => {
    expect(ablageZiel()).toBe("trust-one");
    vi.stubEnv("ABLAGE_ZIEL", "trust_flow");
    expect(ablageZiel()).toBe("trust-one");
    vi.stubEnv("ABLAGE_ZIEL", " Trust-Flow ");
    expect(ablageZiel()).toBe("trust-flow");
  });

  it("trust-one: Fristen weiter per GET an Trust one (unveraendert)", async () => {
    vi.stubEnv("ABLAGE_ZIEL", "trust-one");
    fetchMock.mockResolvedValue(antwort(200, { success: true, anzahl_aktiv: 1, anzahl_vorschlag: 0 }));
    await expect(ladeTrustOneFristen()).resolves.toEqual({ aktiv: 1, vorschlag: 0 });
    expect(fetchMock.mock.calls[0][0]).toBe("https://one.trust-group.ch/api/ablage/extern/fristen?bereich=eventline-gmbh&tage=30");
  });

  it("trust-flow: POST {firma, tage: 30} mit Bearer; faellig → aktiv, vorschlaege → vorschlag", async () => {
    vi.stubEnv("ABLAGE_ZIEL", "trust-flow");
    fetchMock.mockResolvedValue(antwort(200, { offen: 9, faellig: 4, vorschlaege: 2 }));
    await expect(ladeTrustOneFristen()).resolves.toEqual({ aktiv: 4, vorschlag: 2 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://flow.trust-group.ch/api/ablage/extern/fristen");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ firma: "eventline", tage: 30 });
  });

  it("trust-flow: TRUST_FLOW_URL ueberschreibt die Adresse", async () => {
    vi.stubEnv("ABLAGE_ZIEL", "trust-flow");
    vi.stubEnv("TRUST_FLOW_URL", "http://localhost:3200/");
    fetchMock.mockResolvedValue(antwort(200, { offen: 0, faellig: 0, vorschlaege: 0 }));
    await ladeTrustOneFristen();
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:3200/api/ablage/extern/fristen");
  });

  it("trust-flow wirft statt 0: Serverfehler, kaputte Antwort, Netzfehler, fehlender Token", async () => {
    vi.stubEnv("ABLAGE_ZIEL", "trust-flow");
    fetchMock.mockResolvedValueOnce(antwort(401, { error: "nein" }));
    await expect(ladeTrustOneFristen()).rejects.toThrow(/Trust flow antwortet nicht wie erwartet \(HTTP 401\)/);
    fetchMock.mockResolvedValueOnce(antwort(200, { offen: 1, faellig: -1, vorschlaege: 0 }));
    await expect(ladeTrustOneFristen()).rejects.toThrow(/nicht wie erwartet/);
    fetchMock.mockResolvedValueOnce(antwort(200, { anzahl_aktiv: 1, anzahl_vorschlag: 0, success: true }));
    await expect(ladeTrustOneFristen()).rejects.toThrow(/nicht wie erwartet/);
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(ladeTrustOneFristen()).rejects.toThrow(/Trust flow ist nicht erreichbar/);
    vi.stubEnv("TRUST_ONE_ABLAGE_TOKEN", "");
    await expect(ladeTrustOneFristen()).rejects.toThrow(/Trust flow ist nicht verbunden/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("Link der Dashboard-Kachel folgt dem Schalter (Trust flow /eventline/fristen, sonst Trust one wie bisher)", () => {
    expect(ablageFristenLink()).toBe("https://one.trust-group.ch/geschaeft/ablage/eventline-gmbh?ansicht=fristen");
    vi.stubEnv("ABLAGE_ZIEL", "trust-flow");
    expect(ablageFristenLink()).toBe("https://flow.trust-group.ch/eventline/fristen");
    vi.stubEnv("TRUST_FLOW_URL", "http://localhost:3200/");
    expect(ablageFristenLink()).toBe("http://localhost:3200/eventline/fristen");
  });
});
