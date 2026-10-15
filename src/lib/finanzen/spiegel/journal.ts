// Spiegel /3.0/accounting/journal — UNTER VORBEHALT: im Mai 2026 lieferte
// /3.0/accounting_journal 404 trotz accounting-Scope (Spec E.1). 403/404 →
// verfuegbar=false (Index setzt den Hinweis), die Bankkonten-Seite blendet
// Salden aus; kein roter Lauf-Status für die anderen Entitäten.
//
// Echter Vollabgleich ab JOURNAL_AB (Gründung 2026-03-09, ANNAHME G.4) bis
// heute + 1 Tag (falls «to» exklusiv) mit Löschung nicht gelieferter
// Buchungen — in Bexio verschwundene Buchungen (Storno-Neuverbuchung,
// gelöschte manuelle Buchungen) würden den Bank-Saldo sonst dauerhaft
// verfälschen. Zeitbudget-Abbruch → KEIN Delete, Hinweis «Journal
// unvollständig — Salden vorläufig» (Index).

import { JOURNAL_AB, type SyncEntitaetErgebnis } from "@/lib/finanzen/types";
import { plusTage } from "@/lib/swiss-time";
import { alleSeiten2 } from "./bexio-client";
import { loescheNichtGeliefert, upsertBloecke, type SpiegelZeile, type SyncKontext } from "./index";
import { datum, zahl } from "./wandeln";

interface BexioBuchung {
  id: number;
  ref_id?: number | null;
  ref_uuid?: string | null;
  ref_class?: string | null;
  date?: string | null;
  debit_account_id?: number | null;
  credit_account_id?: number | null;
  description?: string | null;
  amount?: number | string | null;
  currency_id?: number | null;
  currency_factor?: number | string | null;
  base_currency_id?: number | null;
  base_currency_amount?: number | string | null;
}

export async function syncJournal(ctx: SyncKontext): Promise<SyncEntitaetErgebnis> {
  const bis = plusTage(ctx.heute, 1);
  const geliefert = await alleSeiten2<BexioBuchung>(
    ctx,
    (l, o) => `/3.0/accounting/journal?from=${JOURNAL_AB}&to=${bis}&limit=${l}&offset=${o}`,
    undefined,
    2000,
  );

  let ohneDatum = 0;
  const zeilen: SpiegelZeile[] = [];
  for (const b of geliefert) {
    if (!Number.isFinite(b?.id)) continue;
    const d = datum(b.date);
    if (!d) {
      ohneDatum++;
      continue;
    }
    zeilen.push({
      id: b.id,
      ref_id: b.ref_id ?? null,
      ref_uuid: b.ref_uuid ?? null,
      ref_class: b.ref_class ?? null,
      datum: d,
      debit_account_id: b.debit_account_id ?? null,
      credit_account_id: b.credit_account_id ?? null,
      description: b.description ?? null,
      amount: zahl(b.amount),
      currency_id: b.currency_id ?? null,
      currency_factor: zahl(b.currency_factor),
      base_currency_id: b.base_currency_id ?? null,
      base_currency_amount: zahl(b.base_currency_amount),
      raw: b,
    });
  }

  if (zeilen.length === 0) {
    return {
      entitaet: "journal",
      anzahl: 0,
      fehler: "0 Zeilen geliefert — Vollabgleich nicht angewendet",
      verfuegbar: true,
      wasserzeichen: null,
    };
  }
  const anzahl = await upsertBloecke(ctx, "journal_buchungen", zeilen);
  await loescheNichtGeliefert(ctx, "journal_buchungen");
  return {
    entitaet: "journal",
    anzahl,
    fehler: ohneDatum > 0 ? `${ohneDatum} Buchungen ohne Datum übersprungen` : null,
    verfuegbar: true,
    wasserzeichen: ctx.lauf.gestartet,
  };
}
