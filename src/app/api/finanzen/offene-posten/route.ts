/**
 * GET /api/finanzen/offene-posten — offene Debitoren aus finanzen.v_offene_debitoren.
 * Guard requireFinanzen, Protokoll FAIL-CLOSED. bexio_url setzt die Route
 * (bexioInvoiceUrl). Betraege Number(), waehrung durchgereicht (null = CHF).
 */
import { requireFinanzen, finanzenJson, protokollFehler } from "@/lib/finanzen/auth";
import { protokolliereZugriff } from "@/lib/finanzen/zugriffe";
import { finanzenDb } from "@/lib/finanzen/db";
import { ZUGRIFF_AKTION, type OffenePostenAntwort, type OffenerDebitor, type RechnungStatus } from "@/lib/finanzen/types";
import { bexioInvoiceUrl } from "@/lib/bexio";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

/** Zeile der View (numerics als string). */
interface DebitorZeile {
  rechnung_id: number;
  document_nr: string;
  kunde: string;
  contact_id: number | null;
  datum: string;
  faellig: string | null;
  tage_ueberfaellig: number | null;
  betrag_offen: string | number | null;
  betrag_total: string | number | null;
  status: RechnungStatus;
  mahnstufe: number | null;
  waehrung: string | null;
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
    aktion: ZUGRIFF_AKTION.FINANZEN_OFFENE_POSTEN,
    geraetHash: auth.geraetHash,
  }))) return protokollFehler();

  const { data, error } = await finanzenDb().from("v_offene_debitoren").select("*");
  if (error) {
    logError("api.finanzen.offene-posten", new Error("select"), { code: error.code });
    return finanzenJson({ success: false, error: "Offene Posten konnten nicht geladen werden" }, { status: 500 });
  }

  const zeilen = (data ?? []) as DebitorZeile[];
  const posten: OffenerDebitor[] = zeilen.map((z) => ({
    rechnung_id: z.rechnung_id,
    document_nr: z.document_nr,
    kunde: z.kunde,
    contact_id: z.contact_id,
    datum: z.datum,
    faellig: z.faellig,
    tage_ueberfaellig: n(z.tage_ueberfaellig),
    betrag_offen: n(z.betrag_offen),
    betrag_total: n(z.betrag_total),
    status: z.status,
    mahnstufe: n(z.mahnstufe),
    waehrung: z.waehrung,
    bexio_url: bexioInvoiceUrl(z.rechnung_id),
  }));

  const antwort: OffenePostenAntwort = { success: true, posten };
  return finanzenJson(antwort);
}
