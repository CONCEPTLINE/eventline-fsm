// Spiegel Kontenplan: /2.0/accounts und /2.0/account_groups — Vollabgleich
// mit Löschung nicht gelieferter Zeilen (synced_at < lauf.gestartet, nie
// `not in (…)`). Kein Scope im Spec-Security-Block → bei 403
// verfuegbar=false (ANNAHME G.5: `accounting` reicht).

import type { SyncEntitaet, SyncEntitaetErgebnis } from "@/lib/finanzen/types";
import { alleSeiten2 } from "./bexio-client";
import { loescheNichtGeliefert, upsertBloecke, type SpiegelZeile, type SyncKontext } from "./index";

interface BexioKonto {
  id: number;
  uuid?: string | null;
  account_no?: string | number | null;
  name?: string | null;
  account_type?: number | null;
  tax_id?: number | null;
  fibu_account_group_id?: number | null;
  is_active?: boolean | null;
  is_locked?: boolean | null;
}

interface BexioKontengruppe {
  id: number;
  uuid?: string | null;
  account_no?: string | number | null;
  name?: string | null;
  parent_fibu_account_group_id?: number | null;
  is_active?: boolean | null;
  is_locked?: boolean | null;
}

async function vollabgleich(
  ctx: SyncKontext,
  entitaet: SyncEntitaet,
  tabelle: string,
  zeilen: SpiegelZeile[],
): Promise<SyncEntitaetErgebnis> {
  if (zeilen.length === 0) {
    return { entitaet, anzahl: 0, fehler: "0 Zeilen geliefert — Vollabgleich nicht angewendet", verfuegbar: true, wasserzeichen: null };
  }
  const anzahl = await upsertBloecke(ctx, tabelle, zeilen);
  await loescheNichtGeliefert(ctx, tabelle);
  return { entitaet, anzahl, fehler: null, verfuegbar: true, wasserzeichen: ctx.lauf.gestartet };
}

export async function syncKonten(ctx: SyncKontext): Promise<SyncEntitaetErgebnis> {
  const geliefert = await alleSeiten2<BexioKonto>(ctx, (l, o) => `/2.0/accounts?limit=${l}&offset=${o}`, undefined, 2000);
  const zeilen: SpiegelZeile[] = geliefert
    .filter((k) => Number.isFinite(k?.id))
    .map((k) => ({
      id: k.id,
      uuid: k.uuid ?? null,
      account_no: k.account_no == null ? null : String(k.account_no),
      name: k.name ?? null,
      account_type: k.account_type ?? null,
      tax_id: k.tax_id ?? null,
      fibu_account_group_id: k.fibu_account_group_id ?? null,
      is_active: k.is_active !== false,
      is_locked: k.is_locked === true,
      raw: k,
    }));
  return vollabgleich(ctx, "konten", "konten", zeilen);
}

export async function syncKontengruppen(ctx: SyncKontext): Promise<SyncEntitaetErgebnis> {
  const geliefert = await alleSeiten2<BexioKontengruppe>(
    ctx,
    (l, o) => `/2.0/account_groups?limit=${l}&offset=${o}`,
    undefined,
    2000,
  );
  const zeilen: SpiegelZeile[] = geliefert
    .filter((g) => Number.isFinite(g?.id))
    .map((g) => ({
      id: g.id,
      uuid: g.uuid ?? null,
      account_no: g.account_no == null ? null : String(g.account_no),
      name: g.name ?? null,
      parent_fibu_account_group_id: g.parent_fibu_account_group_id ?? null,
      is_active: g.is_active !== false,
      is_locked: g.is_locked === true,
      raw: g,
    }));
  return vollabgleich(ctx, "kontengruppen", "kontengruppen", zeilen);
}
