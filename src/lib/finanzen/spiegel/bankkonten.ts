// Spiegel /3.0/banking/accounts (ohne Saldo — Bexio liefert keinen; der
// Saldo kommt aus dem Journal über account_id, v_bankkonten_saldo).
// Vollabgleich mit Löschung nicht gelieferter Zeilen.

import type { SyncEntitaetErgebnis } from "@/lib/finanzen/types";
import { alleSeiten2 } from "./bexio-client";
import { loescheNichtGeliefert, upsertBloecke, type SpiegelZeile, type SyncKontext } from "./index";

interface BexioBankkonto {
  id: number;
  uuid?: string | null;
  name?: string | null;
  owner?: string | null;
  bank_name?: string | null;
  iban_nr?: string | null;
  currency_id?: number | null;
  account_id?: number | null;
  type?: string | null;
}

export async function syncBankkonten(ctx: SyncKontext): Promise<SyncEntitaetErgebnis> {
  const geliefert = await alleSeiten2<BexioBankkonto>(ctx, (l, o) => `/3.0/banking/accounts?limit=${l}&offset=${o}`);
  const zeilen: SpiegelZeile[] = geliefert
    .filter((b) => Number.isFinite(b?.id))
    .map((b) => ({
      id: b.id,
      uuid: b.uuid ?? null,
      name: b.name ?? null,
      owner: b.owner ?? null,
      bank_name: b.bank_name ?? null,
      iban_nr: b.iban_nr ?? null,
      currency_id: b.currency_id ?? null,
      account_id: b.account_id ?? null,
      type: b.type == null ? null : String(b.type),
      raw: b,
    }));

  if (zeilen.length === 0) {
    return {
      entitaet: "bankkonten",
      anzahl: 0,
      fehler: "0 Zeilen geliefert — Vollabgleich nicht angewendet",
      verfuegbar: true,
      wasserzeichen: null,
    };
  }
  const anzahl = await upsertBloecke(ctx, "bankkonten", zeilen);
  await loescheNichtGeliefert(ctx, "bankkonten");
  return { entitaet: "bankkonten", anzahl, fehler: null, verfuegbar: true, wasserzeichen: ctx.lauf.gestartet };
}
