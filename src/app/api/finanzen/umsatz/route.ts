/**
 * GET /api/finanzen/umsatz?jahr=YYYY — 12 Monatszeilen aus
 * finanzen.umsatz_monate(p_jahr). jahr: /^\d{4}$/, Default = Zuerich-Jahr.
 * Guard requireFinanzen, Protokoll FAIL-CLOSED (details { jahr } — kein Betrag).
 */
import type { NextRequest } from "next/server";
import { requireFinanzen, finanzenJson, protokollFehler } from "@/lib/finanzen/auth";
import { protokolliereZugriff } from "@/lib/finanzen/zugriffe";
import { finanzenDb } from "@/lib/finanzen/db";
import { ZUGRIFF_AKTION, type UmsatzAntwort, type UmsatzMonat } from "@/lib/finanzen/types";
import { todayLocalIso } from "@/lib/swiss-time";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

/** Zeile von umsatz_monate() (numerics als string). */
interface UmsatzZeile {
  monat: number;
  umsatz: string | number | null;
  umsatz_vorjahr: string | number | null;
}

const n = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

export async function GET(req: NextRequest) {
  const auth = await requireFinanzen();
  if (auth.error) return auth.error;

  // Jahr aus der Query; Default = laufendes Jahr im Zuerich-Kalender
  // (todayLocalIso = "YYYY-MM-DD", die ersten vier Zeichen sind das Jahr).
  const roh = req.nextUrl.searchParams.get("jahr");
  const jahr = roh && /^\d{4}$/.test(roh) ? Number(roh) : Number(todayLocalIso().slice(0, 4));

  // FAIL-CLOSED: ohne Protokollzeile keine Finanzdaten.
  if (!(await protokolliereZugriff({
    actorProfileId: auth.user.id,
    bereich: "finanzen",
    aktion: ZUGRIFF_AKTION.FINANZEN_UMSATZ,
    geraetHash: auth.geraetHash,
    details: { jahr },
  }))) return protokollFehler();

  const { data, error } = await finanzenDb().rpc("umsatz_monate", { p_jahr: jahr });
  if (error) {
    logError("api.finanzen.umsatz", new Error("rpc"), { code: error.code, jahr });
    return finanzenJson({ success: false, error: "Umsatz konnte nicht geladen werden" }, { status: 500 });
  }

  const zeilen = (data ?? []) as UmsatzZeile[];
  // Immer 12 Monate — fehlt eine Zeile, zaehlt sie als 0.
  const proMonat = new Map(zeilen.map((z) => [n(z.monat), z]));
  const monate: UmsatzMonat[] = Array.from({ length: 12 }, (_, i) => {
    const z = proMonat.get(i + 1);
    return { monat: i + 1, umsatz: n(z?.umsatz), umsatz_vorjahr: n(z?.umsatz_vorjahr) };
  });

  const antwort: UmsatzAntwort = { success: true, jahr, monate };
  return finanzenJson(antwort);
}
