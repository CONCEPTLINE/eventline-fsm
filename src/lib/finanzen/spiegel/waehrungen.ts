// Spiegel /3.0/currencies (id, name = ISO 4217, round_factor). Bexio hat
// KEIN /2.0/currency. Vollabgleich mit Löschung nicht gelieferter Zeilen.
// security: null in der Spec → jeder gültige Token (ANNAHME G.5); 403/404
// → verfuegbar=false, die Views fallen auf «CHF» zurück.

import type { SyncEntitaetErgebnis } from "@/lib/finanzen/types";
import { alleSeiten2 } from "./bexio-client";
import { loescheNichtGeliefert, upsertBloecke, type SpiegelZeile, type SyncKontext } from "./index";
import { zahl } from "./wandeln";

interface BexioWaehrung {
  id: number;
  name?: string | null;
  round_factor?: number | string | null;
}

export async function syncWaehrungen(ctx: SyncKontext): Promise<SyncEntitaetErgebnis> {
  const geliefert = await alleSeiten2<BexioWaehrung>(ctx, (l, o) => `/3.0/currencies?limit=${l}&offset=${o}`);
  const zeilen: SpiegelZeile[] = geliefert
    .filter((w) => Number.isFinite(w?.id))
    .map((w) => ({ id: w.id, name: String(w.name ?? ""), round_factor: zahl(w.round_factor), raw: w }));

  if (zeilen.length === 0) {
    return {
      entitaet: "waehrungen",
      anzahl: 0,
      fehler: "0 Zeilen geliefert — Vollabgleich nicht angewendet",
      verfuegbar: true,
      wasserzeichen: null,
    };
  }
  const anzahl = await upsertBloecke(ctx, "waehrungen", zeilen);
  await loescheNichtGeliefert(ctx, "waehrungen");
  return { entitaet: "waehrungen", anzahl, fehler: null, verfuegbar: true, wasserzeichen: ctx.lauf.gestartet };
}
