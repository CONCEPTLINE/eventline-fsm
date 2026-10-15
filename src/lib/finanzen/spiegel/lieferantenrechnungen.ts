// Spiegel /4.0/purchase/bills (kein updated_at-Filter in Bexio):
// (1) Vollabgleich der letzten ≈ 15 Monate (bill_date_start), (2) zweiter
// Durchlauf status=TODO ohne Datumsgrenze (alle nicht-bezahlten, nicht-
// Entwurf-Bills — fängt offene Bills mit älterem Rechnungsdatum), (3)
// Verwaisten-Prüfung über Spiegel-Bills mit Status ∉ {DRAFT, PAID}, (4)
// Outgoing-Payments NUR für Bills aus dem TODO-Durchlauf.
//
// 4.0-Beträge kommen als double → numeric(14,2), als String gesendet.
// Bezahlte Bills ausserhalb des Fensters bleiben stehen (Vorbehalt E.5).
// 403/404 auf der Liste → verfuegbar=false (Einkaufsmodul/Scope).

import {
  BILL_STATUS_NICHT_OFFEN,
  BILLS_FENSTER_TAGE,
  SYNC_VERWAIST_MAX_PRO_LAUF,
  type SyncEntitaetErgebnis,
} from "@/lib/finanzen/types";
import { plusTage } from "@/lib/swiss-time";
import {
  alleSeiten4,
  bexioJson,
  BexioAntwortFehler,
  datenAlsListe,
  istNichtGefunden,
  pause,
  PAUSE_MS,
  ZeitbudgetFehler,
} from "./bexio-client";
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
import { datum, zahl } from "./wandeln";

interface BexioBill {
  id: string;
  document_no?: string | null;
  title?: string | null;
  status?: string | null;
  vendor?: string | null;
  firstname_suffix?: string | null;
  lastname_company?: string | null;
  supplier_id?: number | null;
  vendor_ref?: string | null;
  currency_code?: string | null;
  net?: number | string | null;
  gross?: number | string | null;
  pending_amount?: number | string | null;
  bill_date?: string | null;
  due_date?: string | null;
  overdue?: boolean | null;
  created_at?: string | null;
}

interface BexioOutgoingPayment {
  id: string;
  bill_id?: string | null;
  payment_type?: string | null;
  status?: string | null;
  execution_date?: string | null;
  amount?: number | string | null;
  sender_bank_account_id?: number | null;
}

function istBillId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Listen-Zeile (alle Spalten). */
function zeile(b: BexioBill): SpiegelZeile {
  return {
    id: b.id,
    document_no: b.document_no ?? null,
    title: b.title ?? null,
    status: String(b.status ?? "DRAFT"),
    vendor: b.vendor ?? null,
    firstname_suffix: b.firstname_suffix ?? null,
    lastname_company: b.lastname_company ?? null,
    supplier_id: b.supplier_id ?? null,
    vendor_ref: b.vendor_ref ?? null,
    currency_code: b.currency_code ?? null,
    net: zahl(b.net),
    gross: zahl(b.gross),
    pending_amount: zahl(b.pending_amount),
    bill_date: datum(b.bill_date),
    due_date: datum(b.due_date),
    overdue: b.overdue === true,
    created_at_bexio: b.created_at ?? null,
    raw: b,
  };
}

/** Detail-Zeile (GET /bills/{id} hat KEIN vendor/net/gross): nur die
 *  Felder setzen, die das Detail liefert — sonst würden Listen-Felder
 *  genullt. */
function zeileAusDetail(b: BexioBill): SpiegelZeile {
  const z: SpiegelZeile = { id: b.id, raw: b };
  if (b.document_no !== undefined) z.document_no = b.document_no ?? null;
  if (b.title !== undefined) z.title = b.title ?? null;
  if (b.status != null) z.status = String(b.status);
  if (b.vendor !== undefined) z.vendor = b.vendor ?? null;
  if (b.firstname_suffix !== undefined) z.firstname_suffix = b.firstname_suffix ?? null;
  if (b.lastname_company !== undefined) z.lastname_company = b.lastname_company ?? null;
  if (b.supplier_id !== undefined) z.supplier_id = b.supplier_id ?? null;
  if (b.vendor_ref !== undefined) z.vendor_ref = b.vendor_ref ?? null;
  if (b.currency_code !== undefined) z.currency_code = b.currency_code ?? null;
  if (b.net !== undefined) z.net = zahl(b.net);
  if (b.gross !== undefined) z.gross = zahl(b.gross);
  if (b.pending_amount !== undefined) z.pending_amount = zahl(b.pending_amount);
  if (b.bill_date !== undefined) z.bill_date = datum(b.bill_date);
  if (b.due_date !== undefined) z.due_date = datum(b.due_date);
  if (b.overdue !== undefined) z.overdue = b.overdue === true;
  if (b.created_at !== undefined) z.created_at_bexio = b.created_at ?? null;
  return z;
}

/** Outgoing-Payments einer Bill neu laden (N+1). Ein 404 wird NICHT als
 *  «keine Zahlungen» geschluckt — Listen-Endpunkte antworten leer mit 200;
 *  404 heisst Endpunkt/Modul fehlt und landet als «Zahlungen: HTTP 404» im
 *  Lauf-Ergebnis (Catch im Aufrufer), statt still eine leere Tabelle zu
 *  hinterlassen. Danach zahlungen_synced_at der Bill setzen (Fortschritts-
 *  marker für die Reihenfolge im nächsten Lauf). */
async function zahlungenLaden(ctx: SyncKontext, billId: string): Promise<void> {
  const antwort = await bexioJson<{ data?: BexioOutgoingPayment[] | BexioOutgoingPayment | null }>(
    ctx,
    `/4.0/purchase/outgoing-payments?bill_id=${encodeURIComponent(billId)}&limit=100&page=1`,
  );
  const liste = datenAlsListe(antwort?.data);
  const zeilen: SpiegelZeile[] = liste
    .filter((p) => istBillId(p?.id))
    .map((p) => ({
      id: p.id,
      bill_id: billId,
      payment_type: p.payment_type ?? null,
      status: p.status ?? null,
      execution_date: datum(p.execution_date),
      amount: zahl(p.amount),
      sender_bank_account_id: p.sender_bank_account_id ?? null,
      raw: p,
    }));
  await ersetzeKinder(ctx, "lieferanten_zahlungen", "bill_id", billId, zeilen);
  await setzeSpalten(ctx, "lieferantenrechnungen", billId, { zahlungen_synced_at: ctx.jetzt.toISOString() });
}

export async function syncLieferantenrechnungen(ctx: SyncKontext): Promise<SyncEntitaetErgebnis> {
  const fehler: string[] = [];

  // (1) Fenster ≈ 15 Monate.
  const ab = plusTage(ctx.heute, -BILLS_FENSTER_TAGE);
  const fenster = await alleSeiten4<BexioBill>(
    ctx,
    (p, l) => `/4.0/purchase/bills?limit=${l}&page=${p}&bill_date_start=${ab}`,
  );
  // (2) Alle offenen ohne Datumsgrenze.
  const todo = await alleSeiten4<BexioBill>(ctx, (p, l) => `/4.0/purchase/bills?status=TODO&limit=${l}&page=${p}`);

  const geliefert = [...fenster, ...todo].filter((b) => istBillId(b?.id));
  const gelieferteIds = new Set<string>(geliefert.map((b) => b.id));
  const anzahl = await upsertBloecke(ctx, "lieferantenrechnungen", geliefert.map(zeile));
  const wasserzeichen = ctx.lauf.gestartet;

  // (3) Verwaisten-Prüfung: im Spiegel offen, nicht geliefert.
  const spiegelOffen = await ladeIdsMitWerten(ctx, "lieferantenrechnungen", "status", BILL_STATUS_NICHT_OFFEN, true);
  const verwaist = spiegelOffen.map(String).filter((id) => !gelieferteIds.has(id));
  const pruefen = verwaist.slice(0, SYNC_VERWAIST_MAX_PRO_LAUF);
  let geprueft = 0;
  try {
    for (const id of pruefen) {
      try {
        const b = await bexioJson<BexioBill>(ctx, `/4.0/purchase/bills/${encodeURIComponent(id)}`);
        if (istBillId(b?.id)) await upsertBloecke(ctx, "lieferantenrechnungen", [zeileAusDetail(b)]);
      } catch (e) {
        if (!istNichtGefunden(e)) throw e;
        await loescheIds(ctx, "lieferantenrechnungen", [id]);
      }
      geprueft++;
      await pause(PAUSE_MS);
    }
  } catch (e) {
    if (!(e instanceof ZeitbudgetFehler)) throw e;
    fehler.push(`Zeitbudget: ${verwaist.length - geprueft} verwaiste noch offen`);
    return { entitaet: "lieferantenrechnungen", anzahl, fehler: fehler.join("; "), verfuegbar: true, wasserzeichen };
  }
  if (verwaist.length > pruefen.length) fehler.push(`${verwaist.length - pruefen.length} verwaiste noch offen`);

  // (4) Outgoing-Payments nur für die offenen Bills (TODO-Durchlauf) —
  //     nach Bedürftigkeit: nie geladene zuerst, dann die am längsten nicht
  //     geladenen (zahlungen_synced_at). So füllen sich die Zahlungen über
  //     mehrere Läufe, wenn das Zeitbudget nicht für alle reicht (Spec E.14),
  //     statt jeden Lauf dieselben ersten K Bills zu bedienen.
  const todoIds = await sortiereNachStand(
    ctx,
    "lieferantenrechnungen",
    "zahlungen_synced_at",
    [...new Set(todo.filter((b) => istBillId(b?.id)).map((b) => b.id))],
  );
  let fertig = 0;
  try {
    for (const id of todoIds) {
      await zahlungenLaden(ctx, id);
      fertig++;
      await pause(PAUSE_MS);
    }
  } catch (e) {
    if (e instanceof ZeitbudgetFehler) {
      fehler.push(`Zeitbudget: ${todoIds.length - fertig} von ${todoIds.length} Lieferantenrechnungen ohne Zahlungen`);
    } else if (e instanceof BexioAntwortFehler) {
      // Zahlungs-Endpunkt verweigert (Scope/Modul) — Bills selbst sind da.
      fehler.push(`Zahlungen: HTTP ${e.status}`);
    } else {
      throw e;
    }
  }

  return {
    entitaet: "lieferantenrechnungen",
    anzahl,
    fehler: fehler.length ? fehler.join("; ") : null,
    verfuegbar: true,
    wasserzeichen,
  };
}
