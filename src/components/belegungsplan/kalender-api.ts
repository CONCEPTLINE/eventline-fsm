// Kalender eines Standorts — Aufrufe der Server-Routen fuer Partnerportal
// und interne Location-Seite. Beide haben dieselben Formen
// (docs/barakuba/VERTRAG-KALENDER.md), nur die Basis unterscheidet sich:
//   Partner: /api/partner            (Standort aus der Sitzung)
//   intern:  /api/standorte/<id>
// Der Kalender bekommt das fertige Objekt vom Aufrufer (gleiches Muster wie
// frueher laden/speichern) — so kann der Aufrufer einzelne Aufrufe anpassen
// (z.B. intern: archivierte Location nur lesen).
//
// Antwortform der Routen: { success, error?, …daten }. Ein Fehler ist immer
// ein Fehler (fehler = Text fuer den Toast, null = ohne Server-Meldung).

import type {
  KalenderAntwort,
  ProgrammheftAntwort,
  SerieEingabe,
  TerminEingabeKalender,
  Uebernahme,
} from "@/lib/standort-kalender";

export type KalenderErgebnis<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; fehler: string | null };

export type KalenderLadeErgebnis = KalenderErgebnis<{ antwort: KalenderAntwort; darfEintragen: boolean }>;
export type KalenderAktion = "anlegen" | "aendern" | "loeschen";
/** «Nur diesen» Termin einer Serie oder die ganze Serie. */
export type SerienUmfang = "serie" | "nur_diesen";
export type UebernahmeEingabe = Pick<Uebernahme, "von" | "bis" | "notiz">;

export type ProgrammheftStand = ProgrammheftAntwort;

export interface KalenderApi {
  /** Eintraege im Zeitraum [startIso, endIso). */
  laden: (startIso: string, endIso: string) => Promise<KalenderLadeErgebnis>;
  /** Einzeltermin (auch Programm-Eintraege) anlegen/aendern/loeschen. */
  termin: (aktion: KalenderAktion, id?: string, eingabe?: TerminEingabeKalender) => Promise<KalenderErgebnis>;
  serieAnlegen: (eingabe: SerieEingabe) => Promise<KalenderErgebnis>;
  serieAendern: (id: string, umfang: SerienUmfang, serienTag: string | null, eingabe: SerieEingabe) => Promise<KalenderErgebnis>;
  serieLoeschen: (id: string, umfang: SerienUmfang, serienTag: string | null) => Promise<KalenderErgebnis>;
  uebernahmeSpeichern: (id: string | null, eingabe: UebernahmeEingabe) => Promise<KalenderErgebnis>;
  uebernahmeLoeschen: (id: string) => Promise<KalenderErgebnis>;
  /** Liest das Programmheft der Website und vergleicht mit dem Kalender. */
  programmheftLaden: () => Promise<KalenderErgebnis<ProgrammheftStand>>;
  /** Taeglichen automatischen Abgleich ein-/ausschalten. */
  programmheftAuto: (auto: boolean) => Promise<KalenderErgebnis>;
  programmheftUebernehmen: (quelleIds: string[]) => Promise<KalenderErgebnis>;
}

type Antwort<T> = { ok: true; daten: T } | { ok: false; fehler: string | null };

async function anfrage<T>(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<Antwort<T>> {
  try {
    const res = await fetch(url, {
      method,
      cache: "no-store",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => null)) as ({ success?: boolean; error?: string } & T) | null;
    if (!res.ok || !json?.success) return { ok: false, fehler: json?.error ?? null };
    return { ok: true, daten: json };
  } catch {
    return { ok: false, fehler: "Netzwerkfehler" };
  }
}

const nurOk = (r: Antwort<unknown>): KalenderErgebnis => (r.ok ? { ok: true } : { ok: false, fehler: r.fehler });

/** Alle Kalender-Aufrufe unter einer Basis («/api/partner» bzw. «/api/standorte/<id>»). */
export function kalenderApi(basis: string): KalenderApi {
  return {
    async laden(start, end) {
      const r = await anfrage<Partial<KalenderAntwort> & { darfEintragen?: boolean }>(
        "GET",
        `${basis}/belegungsplan?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
      );
      if (!r.ok) return r;
      return {
        ok: true,
        antwort: {
          eintraege: r.daten.eintraege ?? [],
          uebernahmen: r.daten.uebernahmen ?? [],
          verfuegbarkeit: r.daten.verfuegbarkeit ?? [],
        },
        darfEintragen: r.daten.darfEintragen === true,
      };
    },
    async termin(aktion, id, eingabe) {
      return nurOk(await anfrage("POST", `${basis}/kalender-termine`, { aktion, id, ...eingabe }));
    },
    async serieAnlegen(eingabe) {
      return nurOk(await anfrage("POST", `${basis}/kalender-serien`, eingabe));
    },
    async serieAendern(id, umfang, serienTag, eingabe) {
      return nurOk(
        await anfrage("PATCH", `${basis}/kalender-serien/${encodeURIComponent(id)}`, {
          umfang,
          ...(serienTag ? { serienTag } : {}),
          eingabe,
        }),
      );
    },
    async serieLoeschen(id, umfang, serienTag) {
      const qs = new URLSearchParams({ umfang });
      if (serienTag) qs.set("serienTag", serienTag);
      return nurOk(await anfrage("DELETE", `${basis}/kalender-serien/${encodeURIComponent(id)}?${qs.toString()}`));
    },
    async uebernahmeSpeichern(id, eingabe) {
      return nurOk(
        id
          ? await anfrage("PATCH", `${basis}/uebernahmen/${encodeURIComponent(id)}`, eingabe)
          : await anfrage("POST", `${basis}/uebernahmen`, eingabe),
      );
    },
    async uebernahmeLoeschen(id) {
      return nurOk(await anfrage("DELETE", `${basis}/uebernahmen/${encodeURIComponent(id)}`));
    },
    async programmheftLaden() {
      const r = await anfrage<Partial<ProgrammheftStand>>("GET", `${basis}/programmheft`);
      if (!r.ok) return r;
      return {
        ok: true,
        funde: r.daten.funde ?? [],
        quelle: r.daten.quelle ?? "",
        auto: r.daten.auto === true,
        abgeglichenAm: r.daten.abgeglichenAm ?? null,
      };
    },
    async programmheftAuto(auto) {
      return nurOk(await anfrage("PATCH", `${basis}/programmheft`, { auto }));
    },
    async programmheftUebernehmen(quelleIds) {
      return nurOk(await anfrage("POST", `${basis}/programmheft`, { quelleIds }));
    },
  };
}
