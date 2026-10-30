// lib/trust-one-ablage — Fremd-API der Ablage in Trust one (Fristen-Zaehler, Mail-Anhaenge) mit Attrappe fuer fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));

import { createECDH } from "node:crypto";
import { TEST_RIG_OEFFENTLICH, TEST_RIG_PRIVAT_HEX, tfd1Entschluesseln } from "./ablage/test-hilfen";
import { chiffratLaenge } from "./ablage/tfd1";
import {
  ablageFristenLink,
  ablageMaxGroesse,
  ablageZiel,
  ablageZielName,
  ladeTrustOneFristen,
  leiteAblageAnhangWeiter,
  trustOneAblageBereit,
} from "./trust-one-ablage";

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
  vi.stubEnv("RIG_ABLAGE_ENC_PUBLIC_KEY", "");
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
    expect(trustOneAblageBereit()).toBe(false);
    await expect(ladeTrustOneFristen()).rejects.toThrow(/nicht verbunden/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("leiteAblageAnhangWeiter", () => {
  const anhang = {
    bytes: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]).buffer,
    name: "Vertrag 2026.pdf",
    mime: "application/pdf",
    absender: "kunde@example.ch",
    betreff: "Vertrag",
    empfangenAm: "2026-10-24T08:00:00.000Z",
    mailId: "mail-123",
  };
  const EINGANG = "https://one.trust-group.ch/api/ablage/extern/eingang";
  const UPLOAD = "https://abc.supabase.co/storage/v1/object/upload/sign/ablage/eingang/0b3a2c1e-1111-4222-8333-444455556666?token=tok";
  const angemeldet = { ok: true, pfad: "eingang/0b3a2c1e-1111-4222-8333-444455556666", upload_url: UPLOAD, token: "tok" };

  type Init = RequestInit & { headers: Record<string, string> };
  const aufruf = (n: number) => fetchMock.mock.calls[n] as [string, Init];
  const json = (n: number) => JSON.parse(aufruf(n)[1].body as string) as Record<string, unknown>;

  it("anmelden → PUT an die signierte Upload-URL → bestaetigen", async () => {
    fetchMock
      .mockResolvedValueOnce(antwort(200, angemeldet))
      .mockResolvedValueOnce(antwort(200, { Key: "ablage/eingang/x" }))
      .mockResolvedValueOnce(antwort(200, { ok: true, id: "0b3a2c1e-1111-4222-8333-444455556666" }));
    await expect(leiteAblageAnhangWeiter(anhang)).resolves.toEqual({ status: "ok", doppelt: false });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [url1, init1] = aufruf(0);
    expect(url1).toBe(EINGANG);
    expect(init1.method).toBe("POST");
    expect(init1.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(json(0)).toEqual({
      schritt: "anmelden", bereich: "eventline-gmbh", name: "Vertrag 2026.pdf", mime: "application/pdf", groesse: 8, mail_id: "mail-123",
    });

    const [url2, init2] = aufruf(1);
    expect(url2).toBe(UPLOAD);
    expect(init2.method).toBe("PUT");
    expect(init2.headers["content-type"]).toBe("application/pdf");
    expect(init2.headers["x-upsert"]).toBe("false");
    expect(init2.headers.Authorization).toBeUndefined(); // kein ERP-Token an den Speicher
    expect(new Uint8Array(init2.body as ArrayBuffer)).toEqual(new Uint8Array(anhang.bytes));

    expect(aufruf(2)[0]).toBe(EINGANG);
    expect(json(2)).toEqual({
      schritt: "bestaetigen", bereich: "eventline-gmbh", name: "Vertrag 2026.pdf", mime: "application/pdf", groesse: 8, mail_id: "mail-123",
      pfad: "eingang/0b3a2c1e-1111-4222-8333-444455556666", absender: "kunde@example.ch", betreff: "Vertrag",
      empfangen_am: "2026-10-24T08:00:00.000Z",
    });
  });

  it("schon_da beim Anmelden = ok + doppelt, ohne Upload (Wiederholung des Webhooks)", async () => {
    fetchMock.mockResolvedValueOnce(antwort(200, { ok: true, schon_da: true }));
    await expect(leiteAblageAnhangWeiter(anhang)).resolves.toEqual({ status: "ok", doppelt: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("schon_da beim Bestaetigen (parallele Wiederholung) = ok + doppelt", async () => {
    fetchMock
      .mockResolvedValueOnce(antwort(200, angemeldet))
      .mockResolvedValueOnce(antwort(200, {}))
      .mockResolvedValueOnce(antwort(200, { ok: true, schon_da: true }));
    await expect(leiteAblageAnhangWeiter(anhang)).resolves.toEqual({ status: "ok", doppelt: true });
  });

  it("413/415/400 beim Anmelden = abgewiesen mit Ursache (kein Upload, kein Neuversuch)", async () => {
    fetchMock.mockResolvedValueOnce(antwort(413, { ok: false, error: "Datei zu gross (61 MB). Max 50 MB." }));
    expect(await leiteAblageAnhangWeiter(anhang)).toEqual({
      status: "abgewiesen", ursache: "groesse", grund: "anmelden HTTP 413: Datei zu gross (61 MB). Max 50 MB.",
    });
    fetchMock.mockResolvedValueOnce(antwort(415, { ok: false, error: "Dateityp nicht erlaubt: x" }));
    expect(await leiteAblageAnhangWeiter(anhang)).toMatchObject({ status: "abgewiesen", ursache: "typ" });
    fetchMock.mockResolvedValueOnce(antwort(400, { ok: false, error: "Bereich nicht erlaubt" }));
    expect(await leiteAblageAnhangWeiter(anhang)).toMatchObject({ status: "abgewiesen", ursache: "ungueltig" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("502 beim Bestaetigen, Upload-Fehler, 401/503, Netz, kaputte Antwort = fehler (Neuversuch)", async () => {
    fetchMock
      .mockResolvedValueOnce(antwort(200, angemeldet))
      .mockResolvedValueOnce(antwort(200, {}))
      .mockResolvedValueOnce(antwort(502, { ok: false, error: "Anhang konnte nicht übernommen werden" }));
    expect(await leiteAblageAnhangWeiter(anhang)).toEqual({
      status: "fehler", grund: "bestaetigen HTTP 502: Anhang konnte nicht übernommen werden",
    });

    fetchMock.mockResolvedValueOnce(antwort(200, angemeldet)).mockResolvedValueOnce(antwort(400, { error: "Duplicate" }));
    expect(await leiteAblageAnhangWeiter(anhang)).toEqual({ status: "fehler", grund: "Upload HTTP 400" });

    fetchMock.mockResolvedValueOnce(antwort(200, angemeldet)).mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await leiteAblageAnhangWeiter(anhang)).toEqual({ status: "fehler", grund: "nicht erreichbar" });

    fetchMock.mockResolvedValueOnce(antwort(401, { success: false, error: "Unauthorized" }));
    expect((await leiteAblageAnhangWeiter(anhang)).status).toBe("fehler");
    fetchMock.mockResolvedValueOnce(antwort(503, { success: false }));
    expect((await leiteAblageAnhangWeiter(anhang)).status).toBe("fehler");
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await leiteAblageAnhangWeiter(anhang)).toEqual({ status: "fehler", grund: "nicht erreichbar" });
    fetchMock.mockResolvedValueOnce(antwort(200, { ok: true, pfad: "eingang/x" }));
    expect(await leiteAblageAnhangWeiter(anhang)).toEqual({ status: "fehler", grund: "anmelden: Antwort ohne pfad/upload_url" });
  });

  it("413 vom Speicher beim Upload = abgewiesen (groesse)", async () => {
    fetchMock.mockResolvedValueOnce(antwort(200, angemeldet)).mockResolvedValueOnce(new Response("Payload too large", { status: 413 }));
    expect(await leiteAblageAnhangWeiter(anhang)).toEqual({ status: "abgewiesen", ursache: "groesse", grund: "Upload HTTP 413" });
  });

  it("abgelaufene Frist: fehler ohne Aufruf (Resend wiederholt)", async () => {
    expect(await leiteAblageAnhangWeiter(anhang, Date.now() - 1)).toEqual({ status: "fehler", grund: "Zeit abgelaufen" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ohne Token: fehler, ohne Aufruf", async () => {
    vi.stubEnv("TRUST_ONE_ABLAGE_TOKEN", "");
    expect((await leiteAblageAnhangWeiter(anhang)).status).toBe("fehler");
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("Grenze und Name fuer die Meldungen folgen dem Schalter (Trust one 50 MB, Trust flow 48 MiB)", () => {
    expect([ablageMaxGroesse(), ablageZielName()]).toEqual([50 * 1024 * 1024, "Trust one"]);
    vi.stubEnv("ABLAGE_ZIEL", "trust-flow");
    expect([ablageMaxGroesse(), ablageZielName()]).toEqual([48 * 1024 * 1024, "Trust flow"]);
  });

  it("ohne ABLAGE_ZIEL geht der Mail-Eingang unveraendert an Trust one (Klartext, auch mit gesetztem Rig-Schluessel)", async () => {
    vi.stubEnv("RIG_ABLAGE_ENC_PUBLIC_KEY", TEST_RIG_OEFFENTLICH);
    fetchMock
      .mockResolvedValueOnce(antwort(200, { ok: true, pfad: "eingang/x", upload_url: "https://abc.supabase.co/storage/v1/object/upload/sign/ablage/eingang/x?token=tok" }))
      .mockResolvedValueOnce(antwort(200, {}))
      .mockResolvedValueOnce(antwort(200, { ok: true, id: "x" }));
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const anhang = { bytes, name: "a.pdf", mime: "application/pdf", absender: null, betreff: null, empfangenAm: null, mailId: "m1" };
    await expect(leiteAblageAnhangWeiter(anhang)).resolves.toEqual({ status: "ok", doppelt: false });
    expect(fetchMock.mock.calls[0][0]).toBe("https://one.trust-group.ch/api/ablage/extern/eingang");
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({ bereich: "eventline-gmbh", groesse: 3 });
    expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBe(bytes);
  });
});

describe("Mail-Eingang nach Trust flow (E1, ABLAGE_ZIEL=trust-flow, «TFD1»)", () => {
  const EINGANG = "https://flow.trust-group.ch/api/ablage/extern/eingang";
  const AUFTRAG = "0b3a2c1e-1111-4222-8333-444455556666";
  const AUFTRAG_2 = "7c1d2e3f-5555-4666-8777-888899990000";
  const UPLOAD = `https://xyz.supabase.co/storage/v1/object/upload/sign/durchgang/${AUFTRAG}?token=tok`;
  const UPLOAD_2 = `https://xyz.supabase.co/storage/v1/object/upload/sign/durchgang/${AUFTRAG_2}?token=tok2`;
  const klartext = new TextEncoder().encode("%PDF-1.7 Testinhalt der Rechnung");
  const anhang = {
    bytes: klartext.buffer,
    name: "Rechnung 2026-11.pdf",
    mime: "application/pdf",
    absender: "kunde@example.ch",
    betreff: "Rechnung",
    empfangenAm: "2026-11-28T08:00:00.000Z",
    mailId: "mail-456",
  };
  const angemeldet = (auftrag = AUFTRAG, upload = UPLOAD, rig = TEST_RIG_OEFFENTLICH) => ({
    ok: true, auftrag_id: auftrag, eingang_id: "e-1", upload_url: upload, token: "tok", rig_schluessel: rig,
  });

  type Init = RequestInit & { headers: Record<string, string> };
  const aufruf = (n: number) => fetchMock.mock.calls[n] as [string, Init];
  const json = (n: number) => JSON.parse(aufruf(n)[1].body as string) as Record<string, unknown>;
  const urls = () => fetchMock.mock.calls.map((c) => `${(c[1] as RequestInit).method} ${c[0] as string}`);

  beforeEach(() => {
    vi.stubEnv("ABLAGE_ZIEL", "trust-flow");
    vi.stubEnv("RIG_ABLAGE_ENC_PUBLIC_KEY", TEST_RIG_OEFFENTLICH);
  });

  it("anmelden → PUT des Chiffrats (nur der Rig kann es lesen) → bestaetigen", async () => {
    fetchMock
      .mockResolvedValueOnce(antwort(200, angemeldet()))
      .mockResolvedValueOnce(antwort(200, { Key: `durchgang/${AUFTRAG}` }))
      .mockResolvedValueOnce(antwort(200, { ok: true, id: "e-1" }));
    await expect(leiteAblageAnhangWeiter(anhang)).resolves.toEqual({ status: "ok", doppelt: false });
    expect(urls()).toEqual([`POST ${EINGANG}`, `PUT ${UPLOAD}`, `POST ${EINGANG}`]);

    expect(aufruf(0)[1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(json(0)).toEqual({
      schritt: "anmelden", firma: "eventline", name: "Rechnung 2026-11.pdf", mime: "application/pdf", groesse: klartext.byteLength,
      mail_id: "mail-456", absender: "kunde@example.ch", betreff: "Rechnung",
    });

    const put = aufruf(1)[1];
    expect(put.headers).toEqual({ "content-type": "application/octet-stream" }); // kein ERP-Token an den Speicher
    const chiffrat = put.body as Uint8Array;
    expect(chiffrat.byteLength).toBe(chiffratLaenge(klartext.byteLength));
    expect(Buffer.from(chiffrat.subarray(0, 4)).toString("ascii")).toBe("TFD1");
    expect(Buffer.from(chiffrat).includes(Buffer.from("Testinhalt"))).toBe(false); // kein Klartext im Upload
    expect(new Uint8Array(tfd1Entschluesseln(chiffrat, TEST_RIG_PRIVAT_HEX, AUFTRAG))).toEqual(klartext);
    expect(() => tfd1Entschluesseln(chiffrat, TEST_RIG_PRIVAT_HEX, AUFTRAG_2)).toThrow(); // passt nur zu seinem Auftrag

    expect(aufruf(2)[1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(json(2)).toEqual({ schritt: "bestaetigen", firma: "eventline", auftrag_id: AUFTRAG });
  });

  it("schon_da beim Anmelden = ok + doppelt, ohne Verschluesseln und Upload", async () => {
    fetchMock.mockResolvedValueOnce(antwort(200, { ok: true, schon_da: true }));
    await expect(leiteAblageAnhangWeiter(anhang)).resolves.toEqual({ status: "ok", doppelt: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("409 (Auftrag abgelaufen) beim Bestaetigen → einmal neu anmelden, neues Chiffrat fuer den neuen Auftrag", async () => {
    fetchMock
      .mockResolvedValueOnce(antwort(200, angemeldet()))
      .mockResolvedValueOnce(antwort(200, {}))
      .mockResolvedValueOnce(antwort(409, { ok: false, error: "abgelaufen" }))
      .mockResolvedValueOnce(antwort(200, angemeldet(AUFTRAG_2, UPLOAD_2)))
      .mockResolvedValueOnce(antwort(200, {}))
      .mockResolvedValueOnce(antwort(200, { ok: true, id: "e-2" }));
    await expect(leiteAblageAnhangWeiter(anhang)).resolves.toEqual({ status: "ok", doppelt: false });
    expect(urls()).toEqual([`POST ${EINGANG}`, `PUT ${UPLOAD}`, `POST ${EINGANG}`, `POST ${EINGANG}`, `PUT ${UPLOAD_2}`, `POST ${EINGANG}`]);
    expect(json(3).schritt).toBe("anmelden");
    expect(new Uint8Array(tfd1Entschluesseln(aufruf(4)[1].body as Uint8Array, TEST_RIG_PRIVAT_HEX, AUFTRAG_2))).toEqual(klartext);
    expect(json(5)).toEqual({ schritt: "bestaetigen", firma: "eventline", auftrag_id: AUFTRAG_2 });
  });

  it("409 beim Anmelden → einmal neu anmelden; ein zweites 409 = fehler (Resend wiederholt)", async () => {
    fetchMock
      .mockResolvedValueOnce(antwort(409, { ok: false, error: "abgelaufen" }))
      .mockResolvedValueOnce(antwort(200, { ok: true, schon_da: true }));
    await expect(leiteAblageAnhangWeiter(anhang)).resolves.toEqual({ status: "ok", doppelt: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(antwort(200, angemeldet()))
      .mockResolvedValueOnce(antwort(200, {}))
      .mockResolvedValueOnce(antwort(409, { ok: false, error: "abgelaufen" }))
      .mockResolvedValueOnce(antwort(409, { ok: false, error: "abgelaufen" }));
    expect(await leiteAblageAnhangWeiter(anhang)).toEqual({ status: "fehler", grund: "anmelden HTTP 409: abgelaufen" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("502 beim PUT → PUT einmal wiederholt (gleiches Chiffrat), dann bestaetigen; zweimal 502 = fehler", async () => {
    fetchMock
      .mockResolvedValueOnce(antwort(200, angemeldet()))
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }))
      .mockResolvedValueOnce(antwort(200, {}))
      .mockResolvedValueOnce(antwort(200, { ok: true, id: "e-1" }));
    await expect(leiteAblageAnhangWeiter(anhang)).resolves.toEqual({ status: "ok", doppelt: false });
    expect(urls()).toEqual([`POST ${EINGANG}`, `PUT ${UPLOAD}`, `PUT ${UPLOAD}`, `POST ${EINGANG}`]);
    expect(aufruf(2)[1].body).toBe(aufruf(1)[1].body);

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(antwort(200, angemeldet()))
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }));
    expect(await leiteAblageAnhangWeiter(anhang)).toEqual({ status: "fehler", grund: "Upload HTTP 502" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("502 (Speicher) beim Bestaetigen → Upload einmal wiederholen, dann nochmals bestaetigen", async () => {
    fetchMock
      .mockResolvedValueOnce(antwort(200, angemeldet()))
      .mockResolvedValueOnce(antwort(200, {}))
      .mockResolvedValueOnce(antwort(502, { ok: false, error: "groesse" }))
      .mockResolvedValueOnce(antwort(200, {}))
      .mockResolvedValueOnce(antwort(200, { ok: true, id: "e-1" }));
    await expect(leiteAblageAnhangWeiter(anhang)).resolves.toEqual({ status: "ok", doppelt: false });
    expect(urls()).toEqual([`POST ${EINGANG}`, `PUT ${UPLOAD}`, `POST ${EINGANG}`, `PUT ${UPLOAD}`, `POST ${EINGANG}`]);
  });

  it("503 (Buero nicht erreichbar / Lesebetrieb) = fehler ohne Upload (Webhook 502 → Resend wiederholt)", async () => {
    fetchMock.mockResolvedValueOnce(antwort(503, { ok: false, error: "nicht eingerichtet" }));
    expect(await leiteAblageAnhangWeiter(anhang)).toEqual({ status: "fehler", grund: "anmelden HTTP 503: nicht eingerichtet" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("401 (Token) = fehler wie bei Trust one (Resend wiederholt, nach der Korrektur kommt der Anhang an), Ursache «zugang» im Grund", async () => {
    fetchMock.mockResolvedValueOnce(antwort(401, { ok: false, error: "unauthorized" }));
    expect(await leiteAblageAnhangWeiter(anhang)).toEqual({ status: "fehler", grund: "anmelden HTTP 401 (zugang): unauthorized" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("413/415/400 = abgewiesen (endgueltig, kein Upload, kein Neuversuch)", async () => {
    fetchMock.mockResolvedValueOnce(antwort(413, { ok: false, error: "zu gross" }));
    expect(await leiteAblageAnhangWeiter(anhang)).toMatchObject({ status: "abgewiesen", ursache: "groesse" });
    fetchMock.mockResolvedValueOnce(antwort(415, { ok: false, error: "typ" }));
    expect(await leiteAblageAnhangWeiter(anhang)).toMatchObject({ status: "abgewiesen", ursache: "typ" });
    fetchMock.mockResolvedValueOnce(antwort(400, { ok: false, error: "ungueltig" }));
    expect(await leiteAblageAnhangWeiter(anhang)).toMatchObject({ status: "abgewiesen", ursache: "ungueltig" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("falscher oder fehlender rig_schluessel in der Antwort: fehler «Rig-Schlüssel stimmt nicht», KEIN PUT", async () => {
    const anderer = createECDH("prime256v1");
    anderer.generateKeys();
    const fremd = anderer.getPublicKey().toString("base64url");
    fetchMock.mockResolvedValueOnce(antwort(200, angemeldet(AUFTRAG, UPLOAD, fremd)));
    const erg = await leiteAblageAnhangWeiter(anhang);
    expect(erg.status).toBe("fehler");
    expect("grund" in erg && erg.grund).toMatch(/^Rig-Schlüssel stimmt nicht/);

    const ohne: Record<string, unknown> = angemeldet();
    delete ohne.rig_schluessel;
    fetchMock.mockResolvedValueOnce(antwort(200, ohne));
    expect((await leiteAblageAnhangWeiter(anhang)).status).toBe("fehler");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urls().every((u) => u.startsWith("POST "))).toBe(true);
  });

  it("RIG_ABLAGE_ENC_PUBLIC_KEY fehlt oder ungueltig: fehler, gar kein Aufruf (fail closed)", async () => {
    vi.stubEnv("RIG_ABLAGE_ENC_PUBLIC_KEY", "");
    expect(await leiteAblageAnhangWeiter(anhang)).toEqual({ status: "fehler", grund: "RIG_ABLAGE_ENC_PUBLIC_KEY fehlt" });
    vi.stubEnv("RIG_ABLAGE_ENC_PUBLIC_KEY", TEST_RIG_OEFFENTLICH.slice(0, 80));
    expect(await leiteAblageAnhangWeiter(anhang)).toMatchObject({ status: "fehler", grund: expect.stringMatching(/RIG_ABLAGE_ENC_PUBLIC_KEY ungültig/) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ueber 48 MiB: abgewiesen wie 413, ohne Anmelden", async () => {
    const gross = { ...anhang, bytes: new ArrayBuffer(48 * 1024 * 1024 + 1) };
    expect(await leiteAblageAnhangWeiter(gross)).toMatchObject({ status: "abgewiesen", ursache: "groesse" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("TRUST_FLOW_URL ueberschreibt die Adresse; abgelaufene Frist = fehler ohne Aufruf", async () => {
    vi.stubEnv("TRUST_FLOW_URL", "http://localhost:3200/");
    fetchMock.mockResolvedValueOnce(antwort(200, { ok: true, schon_da: true }));
    await leiteAblageAnhangWeiter(anhang);
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:3200/api/ablage/extern/eingang");
    expect(await leiteAblageAnhangWeiter(anhang, Date.now() - 1)).toEqual({ status: "fehler", grund: "Zeit abgelaufen" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
