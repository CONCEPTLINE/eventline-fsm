// Spiegel /2.0/kb_invoice ohne Positionen (Welle 1) + Zahlungen + Mahnungen.
//
// (1) Kopfdaten: Delta über POST /search updated_at greater_than
//     (Wasserzeichen − 26 h); ohne Wasserzeichen/voll: GET alle (order id).
// (2) IMMER zusätzlich alle offenen Rechnungen (Status 8/16/31) komplett —
//     damit stimmen Summe/Anzahl/Überfällig auch bei Statuswechseln, bei
//     denen updated_at nicht mitläuft.
//     → Kopfdaten vollständig = Wasserzeichen gesetzt (auch wenn (3)/(4)
//       am Zeitbudget abbrechen: der nächste Lauf lädt offene ohnehin neu).
// (3) Verwaisten-Prüfung: im Spiegel offen, von Bexio in diesem Lauf nicht
//     geliefert → Einzel-GET; 404 → löschen (Cascade räumt Kinder), sonst
//     upsert (Status aktualisiert sich). Max SYNC_VERWAIST_MAX_PRO_LAUF.
//     VOR dem N+1, damit sie nicht vom N+1 verhungert (sonst blieben in
//     Bexio gelöschte offene Rechnungen als Geister-Posten stehen).
// (4) N+1 NUR für offene Rechnungen: Zahlungen + Mahnungen (delete+insert),
//     mahnstufe = max(reminder_level). Nie für bezahlte/stornierte/Entwürfe
//     (Erstlauf mit allen Rechnungen wäre ein Lambda-Kill). Reihenfolge nach
//     Bedürftigkeit (kinder_synced_at: nie geladene zuerst, dann die am
//     längsten nicht geladenen) — so füllen sich Zahlungen/Mahnungen über
//     mehrere Läufe, wenn das Zeitbudget nicht für alle reicht (Spec E.14).
//
// Beträge als STRINGS (numeric, keine Float-Rundung). Keine Beträge/Namen/
// Nummern in Fehlertexten — nur Zählungen.

import {
  DELTA_UEBERLAPPUNG_MS,
  RECHNUNG_STATUS_OFFEN,
  SYNC_VERWAIST_MAX_PRO_LAUF,
  type SyncEntitaetErgebnis,
} from "@/lib/finanzen/types";
import { alleSeiten2, bexioJson, istNichtGefunden, pause, PAUSE_MS, ZeitbudgetFehler } from "./bexio-client";
import {
  ersetzeKinder,
  ladeIdsMitWerten,
  loescheIds,
  setzeSpalten,
  sortiereNachStand,
  upsertBloecke,
  type SpiegelZeile,
  type SyncKontext,
} from "./index";
import { rechnungStatus } from "./status";
import { bexioSuchZeit, bexioZeitNachTz, datum, zahl } from "./wandeln";

interface BexioRechnung {
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
  total_taxes?: string | number | null;
  total?: string | number | null;
  total_received_payments?: string | number | null;
  total_credit_vouchers?: string | number | null;
  total_remaining_payments?: string | number | null;
  is_valid_from?: string | null;
  is_valid_to?: string | null;
  reference?: string | null;
  api_reference?: string | null;
  updated_at?: string | null;
}

interface BexioZahlung {
  id: number;
  date?: string | null;
  value?: string | number | null;
  bank_account_id?: number | null;
  title?: string | number | null;
  payment_service_id?: number | null;
  is_cash_discount?: boolean | null;
}

interface BexioMahnung {
  id: number;
  title?: string | null;
  is_valid_from?: string | null;
  is_valid_to?: string | null;
  reminder_level?: number | string | null;
  is_sent?: boolean | null;
  remaining_price?: string | number | null;
  received_total?: string | number | null;
}

/** Kopfzeile; null wenn is_valid_from fehlt (Zeile wird übersprungen). */
function zeile(r: BexioRechnung): SpiegelZeile | null {
  const von = datum(r.is_valid_from);
  if (!von) return null;
  const statusId = Number(r.kb_item_status_id);
  return {
    id: r.id,
    document_nr: String(r.document_nr ?? ""),
    title: r.title ?? null,
    contact_id: r.contact_id ?? null,
    contact_sub_id: r.contact_sub_id ?? null,
    project_id: r.project_id ?? null,
    user_id: r.user_id ?? null,
    currency_id: r.currency_id ?? null,
    kb_item_status_id: Number.isFinite(statusId) ? statusId : 0,
    status: rechnungStatus(statusId),
    total_gross: zahl(r.total_gross),
    total_net: zahl(r.total_net),
    total_taxes: zahl(r.total_taxes),
    total: zahl(r.total),
    total_received_payments: zahl(r.total_received_payments),
    total_credit_vouchers: zahl(r.total_credit_vouchers),
    total_remaining_payments: zahl(r.total_remaining_payments),
    is_valid_from: von,
    is_valid_to: datum(r.is_valid_to),
    reference: r.reference ?? null,
    api_reference: r.api_reference ?? null,
    bexio_updated_at: bexioZeitNachTz(r.updated_at),
    raw: r,
  };
}

function istOffen(r: BexioRechnung): boolean {
  return RECHNUNG_STATUS_OFFEN.includes(Number(r.kb_item_status_id));
}

/** Zahlungen + Mahnungen einer Rechnung neu laden (N+1); am Ende mahnstufe
 *  und kinder_synced_at (Fortschrittsmarker) setzen. */
async function kinderLaden(ctx: SyncKontext, id: number): Promise<void> {
  const zahlungen = await bexioJson<unknown>(ctx, `/2.0/kb_invoice/${id}/payment?limit=500`);
  const zahlungZeilen: SpiegelZeile[] = (Array.isArray(zahlungen) ? (zahlungen as BexioZahlung[]) : [])
    .filter((p) => Number.isFinite(p?.id))
    .map((p) => ({
      id: p.id,
      rechnung_id: id,
      datum: datum(p.date),
      betrag: zahl(p.value),
      bank_account_id: p.bank_account_id ?? null,
      title: p.title == null ? null : String(p.title),
      payment_service_id: p.payment_service_id ?? null,
      is_cash_discount: !!p.is_cash_discount,
      raw: p,
    }));
  await ersetzeKinder(ctx, "rechnung_zahlungen", "rechnung_id", id, zahlungZeilen);

  const mahnungen = await bexioJson<unknown>(ctx, `/2.0/kb_invoice/${id}/kb_reminder`);
  const mahnungZeilen: SpiegelZeile[] = (Array.isArray(mahnungen) ? (mahnungen as BexioMahnung[]) : [])
    .filter((m) => Number.isFinite(m?.id))
    .map((m) => ({
      id: m.id,
      rechnung_id: id,
      title: m.title ?? null,
      is_valid_from: datum(m.is_valid_from),
      is_valid_to: datum(m.is_valid_to),
      reminder_level: Number(m.reminder_level) || 0,
      is_sent: !!m.is_sent,
      remaining_price: zahl(m.remaining_price),
      received_total: zahl(m.received_total),
      raw: m,
    }));
  await ersetzeKinder(ctx, "mahnungen", "rechnung_id", id, mahnungZeilen);

  const mahnstufe = mahnungZeilen.reduce((max, m) => Math.max(max, Number(m.reminder_level) || 0), 0);
  await setzeSpalten(ctx, "rechnungen", id, { mahnstufe, kinder_synced_at: ctx.jetzt.toISOString() });
}

export async function syncRechnungen(ctx: SyncKontext): Promise<SyncEntitaetErgebnis> {
  const fehler: string[] = [];
  const wz = ctx.voll ? null : (ctx.stand.rechnungen?.wasserzeichen ?? null);

  // (1) Delta bzw. Vollabgleich der Kopfdaten.
  let delta: BexioRechnung[];
  if (!wz) {
    delta = await alleSeiten2<BexioRechnung>(ctx, (l, o) => `/2.0/kb_invoice?limit=${l}&offset=${o}&order_by=id_asc`);
  } else {
    const seit = bexioSuchZeit(new Date(Date.parse(wz) - DELTA_UEBERLAPPUNG_MS));
    delta = await alleSeiten2<BexioRechnung>(
      ctx,
      (l, o) => `/2.0/kb_invoice/search?order_by=updated_at_asc&limit=${l}&offset=${o}`,
      { method: "POST", body: JSON.stringify([{ field: "updated_at", value: seit, criteria: "greater_than" }]) },
    );
  }

  // (2) Immer: alle offenen Rechnungen komplett.
  const offene = await alleSeiten2<BexioRechnung>(
    ctx,
    (l, o) => `/2.0/kb_invoice/search?limit=${l}&offset=${o}`,
    { method: "POST", body: JSON.stringify([{ field: "kb_item_status_id", value: [...RECHNUNG_STATUS_OFFEN], criteria: "in" }]) },
  );

  const geliefert = [...delta, ...offene].filter((r) => Number.isFinite(r?.id));
  const zeilen: SpiegelZeile[] = [];
  let ohneDatum = 0;
  const gelieferteIds = new Set<number>();
  const offeneIds = new Set<number>();
  for (const r of geliefert) {
    const z = zeile(r);
    if (!z) {
      ohneDatum++;
      continue;
    }
    zeilen.push(z);
    gelieferteIds.add(r.id);
    if (istOffen(r)) offeneIds.add(r.id);
  }
  if (ohneDatum > 0) fehler.push(`${ohneDatum} Rechnungen ohne Datum übersprungen`);
  const anzahl = await upsertBloecke(ctx, "rechnungen", zeilen);
  // Kopfdaten vollständig → Wasserzeichen steht fest, egal was (3)/(4) tun.
  const wasserzeichen = ctx.lauf.gestartet;

  // (3) Verwaisten-Prüfung: im Spiegel offen, von Bexio nicht geliefert —
  //     vor dem N+1, damit sie nicht vom N+1 verhungert.
  const spiegelOffen = await ladeIdsMitWerten(ctx, "rechnungen", "kb_item_status_id", RECHNUNG_STATUS_OFFEN);
  const verwaist = spiegelOffen.map(Number).filter((id) => !gelieferteIds.has(id));
  const pruefen = verwaist.slice(0, SYNC_VERWAIST_MAX_PRO_LAUF);
  let geprueft = 0;
  try {
    for (const id of pruefen) {
      try {
        const r = await bexioJson<BexioRechnung>(ctx, `/2.0/kb_invoice/${id}`);
        const z = zeile(r);
        if (z) await upsertBloecke(ctx, "rechnungen", [z]);
      } catch (e) {
        if (!istNichtGefunden(e)) throw e;
        await loescheIds(ctx, "rechnungen", [id]);
      }
      geprueft++;
      await pause(PAUSE_MS);
    }
  } catch (e) {
    if (!(e instanceof ZeitbudgetFehler)) throw e;
    fehler.push(`Zeitbudget: ${verwaist.length - geprueft} verwaiste noch offen`);
    fehler.push(`Zeitbudget: ${offeneIds.size} von ${offeneIds.size} Rechnungen ohne Zahlungen/Mahnungen`);
    return { entitaet: "rechnungen", anzahl, fehler: fehler.join("; "), verfuegbar: true, wasserzeichen };
  }
  if (verwaist.length > pruefen.length) fehler.push(`${verwaist.length - pruefen.length} verwaiste noch offen`);

  // (4) N+1 nur für offene Rechnungen, nach Bedürftigkeit (kinder_synced_at).
  const offenListe = await sortiereNachStand(ctx, "rechnungen", "kinder_synced_at", [...offeneIds]);
  let fertig = 0;
  try {
    for (const id of offenListe) {
      await kinderLaden(ctx, id);
      fertig++;
      await pause(PAUSE_MS);
    }
  } catch (e) {
    if (!(e instanceof ZeitbudgetFehler)) throw e;
    fehler.push(`Zeitbudget: ${offenListe.length - fertig} von ${offenListe.length} Rechnungen ohne Zahlungen/Mahnungen`);
    return { entitaet: "rechnungen", anzahl, fehler: fehler.join("; "), verfuegbar: true, wasserzeichen };
  }

  return {
    entitaet: "rechnungen",
    anzahl,
    fehler: fehler.length ? fehler.join("; ") : null,
    verfuegbar: true,
    wasserzeichen,
  };
}
