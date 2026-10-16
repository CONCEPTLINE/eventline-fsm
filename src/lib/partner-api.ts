// Partnerportal (Browser): Aufruf der Server-Routen unter /api/partner/**.
// Seit 2026-10-16 liest und schreibt das Portal NUR noch ueber diese Routen
// (keine direkten Tabellen-Abfragen mehr, siehe src/lib/partner-portal-
// server.ts). Ein Fehler ist immer ein Fehler (fehler = Text fuer den Toast,
// null = ohne Server-Meldung), nie eine leere Antwort.

export type PartnerApiAntwort<T> = { ok: true; daten: T } | { ok: false; fehler: string | null; status: number };

/** GET ohne `body`, sonst POST mit JSON. */
export async function partnerApi<T = Record<string, unknown>>(url: string, body?: unknown): Promise<PartnerApiAntwort<T>> {
  try {
    const res = await fetch(
      url,
      body === undefined
        ? undefined
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
    const json = (await res.json().catch(() => null)) as ({ success?: boolean; error?: string } & T) | null;
    if (!res.ok || !json?.success) return { ok: false, fehler: json?.error ?? null, status: res.status };
    return { ok: true, daten: json };
  } catch {
    return { ok: false, fehler: "Netzwerkfehler", status: 0 };
  }
}
