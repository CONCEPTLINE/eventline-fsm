import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CATERING_ORDNER, dokumentName, dokumentPfad, legeDokumenteAb } from "./dokumente";

const bytes = new Uint8Array([1, 2, 3]);
const dateien = [
  { art: "vertrag-a" as const, bytes }, { art: "vertrag-b" as const, bytes }, { art: "karte" as const, bytes },
];

/** Minimaler Ersatz für den Supabase-Client: protokolliert die Aufrufe in der Reihenfolge. */
function stub(alt: { id: string; storage_path: string }[], fehlerBei?: "upload" | "insert") {
  const log: string[] = [];
  const zeilen: Record<string, unknown>[] = [];
  const client = {
    from: () => ({
      select: () => ({ eq: () => ({ like: (_c: string, muster: string) => { log.push(`suche:${muster}`); return Promise.resolve({ data: alt, error: null }); } }) }),
      insert: (rows: Record<string, unknown>[]) => { log.push(`insert:${rows.length}`); zeilen.push(...rows); return Promise.resolve({ error: fehlerBei === "insert" ? new Error("insert kaputt") : null }); },
      delete: () => ({ in: (_c: string, ids: string[]) => { log.push(`delete:${ids.join(",")}`); return Promise.resolve({ error: null }); } }),
    }),
    storage: { from: () => ({ upload: (pfad: string, _b: Uint8Array, o: { upsert: boolean; contentType: string }) => { log.push(`upload:${pfad}:${o.upsert}:${o.contentType}`); return Promise.resolve({ error: fehlerBei === "upload" ? new Error("upload kaputt") : null }); } }) },
  } as unknown as SupabaseClient;
  return { client, log, zeilen };
}

describe("Catering-Dokumente im Auftrag", () => {
  it("Namen und Pfade", () => {
    expect(dokumentName("INT-26404", "vertrag-a")).toBe("INT-26404_Vertrag_A_Bestellung.pdf");
    expect(dokumentPfad("abc", "INT-26404", "karte")).toBe("jobs/abc/catering/INT-26404_Getraenkekarte.pdf");
  });
  it("lädt hoch, legt neue Zeilen an und löscht ERST DANACH die alten", async () => {
    const s = stub([{ id: "alt1", storage_path: "jobs/J/catering/x.pdf" }, { id: "alt2", storage_path: "jobs/J/catering/y.pdf" }]);
    await legeDokumenteAb(s.client, { jobId: "J", userId: "U", nr: "INT-1", dateien });
    expect(s.log).toEqual([
      "suche:jobs/J/catering/%",
      "upload:jobs/J/catering/INT-1_Vertrag_A_Bestellung.pdf:true:application/pdf",
      "upload:jobs/J/catering/INT-1_Vertrag_B_Mindestumsatz.pdf:true:application/pdf",
      "upload:jobs/J/catering/INT-1_Getraenkekarte.pdf:true:application/pdf",
      "insert:3",
      "delete:alt1,alt2",
    ]);
    expect(s.zeilen.map((z) => z.folder)).toEqual([CATERING_ORDNER, CATERING_ORDNER, CATERING_ORDNER]);
    expect(s.zeilen.every((z) => z.job_id === "J" && z.uploaded_by === "U" && z.mime_type === "application/pdf" && z.file_size === 3)).toBe(true);
  });
  it("beim ersten Speichern gibt es nichts zu löschen", async () => {
    const s = stub([]);
    await legeDokumenteAb(s.client, { jobId: "J", userId: "U", nr: "INT-1", dateien });
    expect(s.log.some((l) => l.startsWith("delete"))).toBe(false);
  });
  it("bei einem Fehler wird nichts Altes gelöscht", async () => {
    for (const fehler of ["upload", "insert"] as const) {
      const s = stub([{ id: "alt1", storage_path: "jobs/J/catering/x.pdf" }], fehler);
      await expect(legeDokumenteAb(s.client, { jobId: "J", userId: "U", nr: "INT-1", dateien })).rejects.toThrow();
      expect(s.log.some((l) => l.startsWith("delete"))).toBe(false);
    }
  });
});
