// Spiegel /2.0/contact (nur Stammfelder; raw = ganzes Objekt).
//
// Ohne Wasserzeichen (oder voll): Vollabgleich GET inkl. zweitem Durchlauf
// show_archived=true. Mit Wasserzeichen: Delta über POST /search
// updated_at greater_than (Wasserzeichen − 26 h). Keine Löschung — Kontakte
// werden nur referenziert (Debitoren-Liste zeigt den Namen).

import { DELTA_UEBERLAPPUNG_MS, type SyncEntitaetErgebnis } from "@/lib/finanzen/types";
import { alleSeiten2 } from "./bexio-client";
import { upsertBloecke, type SpiegelZeile, type SyncKontext } from "./index";
import { bexioSuchZeit, bexioZeitNachTz } from "./wandeln";

interface BexioKontakt {
  id: number;
  nr?: string | number | null;
  name_1?: string | null;
  name_2?: string | null;
  contact_type_id?: number | null;
  updated_at?: string | null;
}

function zeile(k: BexioKontakt): SpiegelZeile {
  return {
    id: k.id,
    nr: k.nr == null ? null : String(k.nr),
    name_1: k.name_1 ?? "",
    name_2: k.name_2 ?? null,
    contact_type_id: k.contact_type_id ?? null,
    bexio_updated_at: bexioZeitNachTz(k.updated_at),
    raw: k,
  };
}

export async function syncKontakte(ctx: SyncKontext): Promise<SyncEntitaetErgebnis> {
  const wz = ctx.voll ? null : (ctx.stand.kontakte?.wasserzeichen ?? null);
  let geliefert: BexioKontakt[];

  if (!wz) {
    const aktiv = await alleSeiten2<BexioKontakt>(ctx, (l, o) => `/2.0/contact?limit=${l}&offset=${o}&order_by=id_asc`);
    const archiv = await alleSeiten2<BexioKontakt>(
      ctx,
      (l, o) => `/2.0/contact?limit=${l}&offset=${o}&order_by=id_asc&show_archived=true`,
    );
    geliefert = [...aktiv, ...archiv];
  } else {
    const seit = bexioSuchZeit(new Date(Date.parse(wz) - DELTA_UEBERLAPPUNG_MS));
    const init: RequestInit = {
      method: "POST",
      body: JSON.stringify([{ field: "updated_at", value: seit, criteria: "greater_than" }]),
    };
    const aktiv = await alleSeiten2<BexioKontakt>(
      ctx,
      (l, o) => `/2.0/contact/search?order_by=updated_at_asc&limit=${l}&offset=${o}`,
      init,
    );
    const archiv = await alleSeiten2<BexioKontakt>(
      ctx,
      (l, o) => `/2.0/contact/search?order_by=updated_at_asc&limit=${l}&offset=${o}&show_archived=true`,
      init,
    );
    geliefert = [...aktiv, ...archiv];
  }

  const zeilen = geliefert.filter((k) => Number.isFinite(k?.id)).map(zeile);
  const anzahl = await upsertBloecke(ctx, "kontakte", zeilen);
  return { entitaet: "kontakte", anzahl, fehler: null, verfuegbar: true, wasserzeichen: ctx.lauf.gestartet };
}
