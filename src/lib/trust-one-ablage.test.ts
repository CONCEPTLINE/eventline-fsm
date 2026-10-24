// lib/trust-one-ablage — Fremd-API der Ablage in Trust one (Fristen-Zaehler, Mail-Anhaenge) mit Attrappe fuer fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));

import { ladeTrustOneFristen, leiteAblageAnhangWeiter, trustOneAblageBereit } from "./trust-one-ablage";

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
