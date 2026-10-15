/**
 * GET /api/finanzen/uebersicht — Kennzahlen-Zeile aus finanzen.kennzahlen().
 *
 * Guard requireFinanzen (Admin + vertrautes Geraet), Protokoll
 * FAIL-CLOSED (ohne Zeile in finanzen.zugriffe keine Finanzdaten). Betraege
 * kommen als numeric-Strings aus PostgREST und werden hier mit Number()
 * gewandelt. 5xx-Antworten nie mit Postgres-Texten; logError-extra nur { code }.
 */
import { requireFinanzen, finanzenJson, protokollFehler } from "@/lib/finanzen/auth";
import { protokolliereZugriff } from "@/lib/finanzen/zugriffe";
import { finanzenDb } from "@/lib/finanzen/db";
import { ZUGRIFF_AKTION, type UebersichtAntwort } from "@/lib/finanzen/types";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

/** Zeile von finanzen.kennzahlen() — numerics als string. */
interface KennzahlenZeile {
  jahr: number;
  stichtag: string;
  debitoren_offen_summe: string | number | null;
  debitoren_offen_anzahl: number | null;
  debitoren_ueberfaellig_summe: string | number | null;
  debitoren_ueberfaellig_anzahl: number | null;
  kreditoren_offen_summe: string | number | null;
  kreditoren_offen_anzahl: number | null;
  kreditoren_ueberfaellig_summe: string | number | null;
  kreditoren_ueberfaellig_anzahl: number | null;
  umsatz_jahr_summe: string | number | null;
  umsatz_vorjahr_gleicher_zeitraum_summe: string | number | null;
  fremdwaehrung_anzahl: number | null;
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
    aktion: ZUGRIFF_AKTION.FINANZEN_UEBERSICHT,
    geraetHash: auth.geraetHash,
  }))) return protokollFehler();

  const { data, error } = await finanzenDb().rpc("kennzahlen");
  const zeilen = (data ?? null) as KennzahlenZeile[] | null;
  const z = zeilen?.[0];
  if (error || !z) {
    logError("api.finanzen.uebersicht", error ? new Error("rpc") : new Error("leer"), error ? { code: error.code } : undefined);
    return finanzenJson({ success: false, error: "Kennzahlen konnten nicht geladen werden" }, { status: 500 });
  }

  const antwort: UebersichtAntwort = {
    success: true,
    kennzahlen: {
      jahr: n(z.jahr),
      stichtag: String(z.stichtag),
      debitoren: {
        offen_summe: n(z.debitoren_offen_summe),
        offen_anzahl: n(z.debitoren_offen_anzahl),
        ueberfaellig_summe: n(z.debitoren_ueberfaellig_summe),
        ueberfaellig_anzahl: n(z.debitoren_ueberfaellig_anzahl),
      },
      kreditoren: {
        offen_summe: n(z.kreditoren_offen_summe),
        offen_anzahl: n(z.kreditoren_offen_anzahl),
        ueberfaellig_summe: n(z.kreditoren_ueberfaellig_summe),
        ueberfaellig_anzahl: n(z.kreditoren_ueberfaellig_anzahl),
      },
      umsatz: {
        jahr_summe: n(z.umsatz_jahr_summe),
        vorjahr_gleicher_zeitraum_summe: n(z.umsatz_vorjahr_gleicher_zeitraum_summe),
      },
      fremdwaehrung_anzahl: n(z.fremdwaehrung_anzahl),
    },
  };
  return finanzenJson(antwort);
}
