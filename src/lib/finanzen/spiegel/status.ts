// Bexio-Status-IDs → Spiegel-Status (Mapping in types.ts, Belege in
// scratchpad/bexio/dump.txt).

import {
  OFFERTE_STATUS_VON_BEXIO,
  RECHNUNG_STATUS_VON_BEXIO,
  type OfferteStatus,
  type RechnungStatus,
} from "@/lib/finanzen/types";

/** kb_invoice.kb_item_status_id → RechnungStatus ("unbekannt" bei fremder ID). */
export function rechnungStatus(id: number): RechnungStatus {
  return RECHNUNG_STATUS_VON_BEXIO[id] ?? "unbekannt";
}

/** kb_offer.kb_item_status_id → OfferteStatus ("unbekannt" bei fremder ID). */
export function offerteStatus(id: number): OfferteStatus {
  return OFFERTE_STATUS_VON_BEXIO[id] ?? "unbekannt";
}
