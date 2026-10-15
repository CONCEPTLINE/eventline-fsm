// Spiegel /2.0/kb_offer (liefert KEIN reference, nur api_reference).
// Wie Rechnungen Schritt (1)+(2) (Delta + Offen-Suche Status 2), ohne
// Zahlungen/Mahnungen, plus Verwaisten-Prüfung über OFFERTE_STATUS_OFFEN.

import {
  DELTA_UEBERLAPPUNG_MS,
  OFFERTE_STATUS_OFFEN,
  SYNC_VERWAIST_MAX_PRO_LAUF,
  type SyncEntitaetErgebnis,
} from "@/lib/finanzen/types";
import { alleSeiten2, bexioJson, istNichtGefunden, pause, PAUSE_MS, pruefeFrist, ZeitbudgetFehler } from "./bexio-client";
import { ladeIdsMitWerten, loescheIds, upsertBloecke, type SpiegelZeile, type SyncKontext } from "./index";
import { offerteStatus } from "./status";
import { bexioSuchZeit, bexioZeitNachTz, datum, zahl } from "./wandeln";

interface BexioOfferte {
  id: number;
  document_nr?: string | number | null;
  title?: string | null;
  contact_id?: number | null;
  contact_sub_id?: number | null;
  project_id?: number | null;
  user_id?: number | null;
  currency_id?: number | null;
  kb_item_status_id?: number | null;
  total_gross?: string | number | null;
  total_net?: string | number | null;
  total?: string | number | null;
  is_valid_from?: string | null;
  is_valid_until?: string | null;
  api_reference?: string | null;
  updated_at?: string | null;
}

function zeile(o: BexioOfferte): SpiegelZeile {
  const statusId = Number(o.kb_item_status_id);
  return {
    id: o.id,
    document_nr: String(o.document_nr ?? ""),
    title: o.title ?? null,
    contact_id: o.contact_id ?? null,
    contact_sub_id: o.contact_sub_id ?? null,
    project_id: o.project_id ?? null,
    user_id: o.user_id ?? null,
    currency_id: o.currency_id ?? null,
    kb_item_status_id: Number.isFinite(statusId) ? statusId : 0,
    status: offerteStatus(statusId),
    total_gross: zahl(o.total_gross),
    total_net: zahl(o.total_net),
    total: zahl(o.total),
    is_valid_from: datum(o.is_valid_from),
    is_valid_until: datum(o.is_valid_until),
    api_reference: o.api_reference ?? null,
    bexio_updated_at: bexioZeitNachTz(o.updated_at),
    raw: o,
  };
}

export async function syncOfferten(ctx: SyncKontext): Promise<SyncEntitaetErgebnis> {
  const fehler: string[] = [];
  const wz = ctx.voll ? null : (ctx.stand.offerten?.wasserzeichen ?? null);

  let delta: BexioOfferte[];
  if (!wz) {
    delta = await alleSeiten2<BexioOfferte>(ctx, (l, o) => `/2.0/kb_offer?limit=${l}&offset=${o}&order_by=id_asc`);
  } else {
    const seit = bexioSuchZeit(new Date(Date.parse(wz) - DELTA_UEBERLAPPUNG_MS));
    delta = await alleSeiten2<BexioOfferte>(
      ctx,
      (l, o) => `/2.0/kb_offer/search?order_by=updated_at_asc&limit=${l}&offset=${o}`,
      { method: "POST", body: JSON.stringify([{ field: "updated_at", value: seit, criteria: "greater_than" }]) },
    );
  }
  const offene = await alleSeiten2<BexioOfferte>(
    ctx,
    (l, o) => `/2.0/kb_offer/search?limit=${l}&offset=${o}`,
    { method: "POST", body: JSON.stringify([{ field: "kb_item_status_id", value: [...OFFERTE_STATUS_OFFEN], criteria: "in" }]) },
  );

  const geliefert = [...delta, ...offene].filter((o) => Number.isFinite(o?.id));
  const gelieferteIds = new Set<number>(geliefert.map((o) => o.id));
  const anzahl = await upsertBloecke(ctx, "offerten", geliefert.map(zeile));
  const wasserzeichen = ctx.lauf.gestartet;

  // Verwaisten-Prüfung.
  const spiegelOffen = await ladeIdsMitWerten(ctx, "offerten", "kb_item_status_id", OFFERTE_STATUS_OFFEN);
  const verwaist = spiegelOffen.map(Number).filter((id) => !gelieferteIds.has(id));
  const pruefen = verwaist.slice(0, SYNC_VERWAIST_MAX_PRO_LAUF);
  let geprueft = 0;
  try {
    for (const id of pruefen) {
      pruefeFrist(ctx);
      try {
        const o = await bexioJson<BexioOfferte>(ctx, `/2.0/kb_offer/${id}`);
        await upsertBloecke(ctx, "offerten", [zeile(o)]);
      } catch (e) {
        if (!istNichtGefunden(e)) throw e;
        await loescheIds(ctx, "offerten", [id]);
      }
      geprueft++;
      await pause(PAUSE_MS);
    }
  } catch (e) {
    if (!(e instanceof ZeitbudgetFehler)) throw e;
    fehler.push(`Zeitbudget: ${verwaist.length - geprueft} verwaiste noch offen`);
    return { entitaet: "offerten", anzahl, fehler: fehler.join("; "), verfuegbar: true, wasserzeichen };
  }
  if (verwaist.length > pruefen.length) fehler.push(`${verwaist.length - pruefen.length} verwaiste noch offen`);

  return { entitaet: "offerten", anzahl, fehler: fehler.length ? fehler.join("; ") : null, verfuegbar: true, wasserzeichen };
}
