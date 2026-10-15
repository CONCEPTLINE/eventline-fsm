/**
 * GET /api/finanzen/bankkonten — Bankkonten mit Journal-Saldo
 * (finanzen.v_bankkonten_saldo). Erst sync_stand.journal pruefen: ist das
 * Journal bei Bexio nicht verfuegbar (403/404), gehen keine Salden raus
 * (verfuegbar=false, konten=[]) — die Seite zeigt den Hinweis.
 * Guard requireFinanzen, Protokoll FAIL-CLOSED.
 */
import { requireFinanzen, finanzenJson, protokollFehler } from "@/lib/finanzen/auth";
import { protokolliereZugriff } from "@/lib/finanzen/zugriffe";
import { finanzenDb } from "@/lib/finanzen/db";
import { ZUGRIFF_AKTION, type BankkontenAntwort, type BankkontoSaldo, type SyncStandRow } from "@/lib/finanzen/types";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

/** Zeile der View (numerics als string). */
interface BankkontoZeile {
  bankkonto_id: number;
  name: string | null;
  bank_name: string | null;
  iban_nr: string | null;
  account_id: number | null;
  account_no: string | null;
  saldo: string | number | null;
  buchungen_anzahl: number | null;
  letzte_buchung: string | null;
}

const n = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

export async function GET() {
  const auth = await requireFinanzen();
  if (auth.error) return auth.error;

  // FAIL-CLOSED: ohne Protokollzeile keine Finanzdaten.
  if (!(await protokolliereZugriff({
    actorProfileId: auth.user.id,
    bereich: "finanzen",
    aktion: ZUGRIFF_AKTION.FINANZEN_BANKKONTEN,
    geraetHash: auth.geraetHash,
  }))) return protokollFehler();

  const db = finanzenDb();
  const stand = await db.from("sync_stand").select("*").eq("entitaet", "journal").maybeSingle();
  if (stand.error) {
    logError("api.finanzen.bankkonten", new Error("sync_stand"), { code: stand.error.code });
    return finanzenJson({ success: false, error: "Bankkonten konnten nicht geladen werden" }, { status: 500 });
  }
  const journal = (stand.data ?? null) as SyncStandRow | null;
  // verfuegbar allein reicht nicht: die Seed-Zeile (Migration 323) steht auf
  // verfuegbar=true, bevor je eine Buchung geladen wurde (Erstlauf bricht am
  // Zeitbudget vor dem Journal ab; «0 Zeilen geliefert»). Das Wasserzeichen
  // wird nur nach vollstaendig geladenem Journal gesetzt — ohne Wasserzeichen
  // waeren alle Salden CHF 0.00 ohne Hinweis.
  const geladen = journal?.wasserzeichen != null;
  const verfuegbar = journal?.verfuegbar === true && geladen;
  const hinweis =
    journal?.hinweis ??
    (verfuegbar ? null : "Noch kein Journal-Abgleich — Salden erscheinen nach dem ersten vollständigen Abgleich.");

  if (!verfuegbar) {
    const antwort: BankkontenAntwort = { success: true, verfuegbar: false, hinweis, konten: [] };
    return finanzenJson(antwort);
  }

  const { data, error } = await db.from("v_bankkonten_saldo").select("*");
  if (error) {
    logError("api.finanzen.bankkonten", new Error("select"), { code: error.code });
    return finanzenJson({ success: false, error: "Bankkonten konnten nicht geladen werden" }, { status: 500 });
  }

  const zeilen = (data ?? []) as BankkontoZeile[];
  const konten: BankkontoSaldo[] = zeilen.map((z) => ({
    bankkonto_id: z.bankkonto_id,
    name: z.name,
    bank_name: z.bank_name,
    iban_nr: z.iban_nr,
    account_id: z.account_id,
    account_no: z.account_no,
    saldo: n(z.saldo),
    buchungen_anzahl: n(z.buchungen_anzahl),
    letzte_buchung: z.letzte_buchung,
  }));

  const antwort: BankkontenAntwort = { success: true, verfuegbar: true, hinweis, konten };
  return finanzenJson(antwort);
}
