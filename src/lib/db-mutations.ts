/**
 * Helper fuer Mutations die ueber unsere API-Routes statt direkt vom
 * Supabase-Browser-Client gehen. Vorteile:
 *   - Zentrale Server-seitige Auth-Pruefung via requireUser()
 *   - Spaetere Erweiterung um Audit-Logs / Side-Effects ohne Page-Touches
 *   - Konsistente Error-Form
 *
 * Verwende diese Helpers fuer destructive Ops auf den whitelisted Tabellen
 * (siehe src/app/api/db/delete/route.ts).
 */

export type DbMutationResult = { ok: boolean; error?: string };

export async function deleteRow(
  table: string,
  id: string,
): Promise<DbMutationResult> {
  try {
    const res = await fetch("/api/db/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table, id }),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Netzwerkfehler" };
  }
}

/**
 * Spalten-Update ueber die Server-Boundary (/api/db/update). Tabellen UND
 * Spalten sind dort whitelisted — siehe src/app/api/db/update/route.ts.
 * RLS entscheidet weiterhin, ob der User die Zeile aendern darf.
 */
export async function updateRow(
  table: string,
  id: string,
  values: Record<string, unknown>,
): Promise<DbMutationResult> {
  try {
    const res = await fetch("/api/db/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table, id, values }),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Netzwerkfehler" };
  }
}
