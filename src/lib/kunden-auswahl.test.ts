import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { kundenAuswahl } from "./kunden-auswahl";

// Minimaler Abfrage-Rekorder: jede Kette liefert sich selbst zurueck und
// merkt sich die Aufrufe — geprueft wird, WAS an PostgREST ginge.
function rekorder() {
  const aufrufe: [string, ...unknown[]][] = [];
  const kette: Record<string, (...a: unknown[]) => unknown> = {};
  for (const m of ["from", "select", "eq", "is", "or", "order"]) {
    kette[m] = (...a: unknown[]) => {
      aufrufe.push([m, ...a]);
      return kette;
    };
  }
  return { client: kette as unknown as SupabaseClient, aufrufe };
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("kundenAuswahl", () => {
  it("bietet ohne bestehende Wahl nur aktive, nicht archivierte Kunden an", () => {
    const { client, aufrufe } = rekorder();
    kundenAuswahl(client, "id, name");
    expect(aufrufe).toEqual([
      ["from", "customers"],
      ["select", "id, name"],
      ["eq", "is_active", true],
      ["is", "archived_at", null],
      ["order", "name"],
    ]);
  });

  it("laedt den bereits gewaehlten (evtl. archivierten) Kunden in derselben Abfrage mit", () => {
    const { client, aufrufe } = rekorder();
    kundenAuswahl(client, "id, name", [A, null, undefined, "", A, B]);
    expect(aufrufe).toEqual([
      ["from", "customers"],
      ["select", "id, name"],
      ["or", `and(is_active.eq.true,archived_at.is.null),id.in.(${A},${B})`],
      ["order", "name"],
    ]);
  });

  it("laesst nur echte UUIDs in den Filter (keine PostgREST-Injektion)", () => {
    const { client, aufrufe } = rekorder();
    kundenAuswahl(client, "id", ["x),archived_at.not.is.null,id.eq.(", "kein-uuid"]);
    expect(aufrufe.map((a) => a[0])).toEqual(["from", "select", "eq", "is", "order"]);
  });
});
