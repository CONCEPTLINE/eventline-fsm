/**
 * GET /api/finanzen/kreditoren — offene Lieferantenrechnungen aus
 * finanzen.v_offene_kreditoren. Guard requireFinanzen, Protokoll FAIL-CLOSED.
 */
import { requireFinanzen, finanzenJson, protokollFehler } from "@/lib/finanzen/auth";
import { protokolliereZugriff } from "@/lib/finanzen/zugriffe";
import { finanzenDb } from "@/lib/finanzen/db";
import { ZUGRIFF_AKTION, type BillStatus, type KreditorenAntwort, type OffenerKreditor } from "@/lib/finanzen/types";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

/** Zeile der View (numerics als string). */
interface KreditorZeile {
  bill_id: string;
  document_no: string | null;
  lieferant: string;
  datum: string | null;
  faellig: string | null;
  tage_ueberfaellig: number | null;
  betrag_offen: string | number | null;
  betrag_total: string | number | null;
  status: BillStatus;
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
    aktion: ZUGRIFF_AKTION.FINANZEN_KREDITOREN,
    geraetHash: auth.geraetHash,
  }))) return protokollFehler();

  const { data, error } = await finanzenDb().from("v_offene_kreditoren").select("*");
  if (error) {
    logError("api.finanzen.kreditoren", new Error("select"), { code: error.code });
    return finanzenJson({ success: false, error: "Kreditoren konnten nicht geladen werden" }, { status: 500 });
  }

  const zeilen = (data ?? []) as KreditorZeile[];
  const posten: OffenerKreditor[] = zeilen.map((z) => ({
    bill_id: z.bill_id,
    document_no: z.document_no,
    lieferant: z.lieferant,
    datum: z.datum,
    faellig: z.faellig,
    tage_ueberfaellig: n(z.tage_ueberfaellig),
    betrag_offen: n(z.betrag_offen),
    betrag_total: n(z.betrag_total),
    status: z.status,
    waehrung: z.waehrung,
  }));

  const antwort: KreditorenAntwort = { success: true, posten };
  return finanzenJson(antwort);
}
