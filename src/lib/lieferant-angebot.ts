// Angebots-Uploads des Lieferanten (Portal, /api/lieferant/anfragen/[jobId]/angebot):
// Ablage-Ordner und Aufraeumen verwaister Uploads. Nur serverseitig (Admin-Client).
//
// Verwaist = die Datei liegt im Storage (signierte Upload-URL wurde genutzt),
// aber die Bestaetigung (schritt "fertig") kam nie — keine documents-Zeile.
// Aufgeraeumt wird beim naechsten Upload-Start desselben Lieferanten und
// taeglich im Cron db-retention.

import type { SupabaseClient } from "@supabase/supabase-js";
import { logError } from "@/lib/log";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Eine Datei direkt in einem Angebots-Ordner: jobs/<job>/lieferant-<id>/<datei>. */
const ANGEBOT_DATEI = new RegExp(`^jobs/${UUID}/lieferant-${UUID}/[^/]+$`);

/** Ablage-Ordner der Lieferanten-Angebote eines Auftrags. */
export function angebotPraefix(jobId: string, lieferantId: string): string {
  return `jobs/${jobId.toLowerCase()}/lieferant-${lieferantId.toLowerCase()}/`;
}

/** Verwaiste Angebots-Uploads loeschen: nur Dateien in lieferant-<uuid>-
 *  Ordnern, ohne documents-Zeile und aelter als 24 h. Die Auswahl macht die
 *  DB (angebot_upload_waisen, Migration 338, hoechstens 100 je Lauf); vor dem
 *  Loeschen wird nochmals gegen documents geprueft (Wettlauf mit «fertig»).
 *  Mit `lieferantId` nur dessen Ordner (Upload-Start), ohne alle (Cron).
 *  Wirft nie — Aufraeumen darf weder einen Upload noch den Cron stoppen. */
export async function angebotWaisenAufraeumen(
  admin: SupabaseClient,
  lieferantId?: string,
): Promise<{ geloescht: number; fehler: boolean }> {
  try {
    const { data, error } = await admin.rpc("angebot_upload_waisen", { p_lieferant_id: lieferantId ?? null });
    if (error) throw error;
    const eigenerOrdner = lieferantId ? `/lieferant-${lieferantId.toLowerCase()}/` : null;
    const kandidaten = ((data ?? []) as { pfad: string }[])
      .map((r) => r.pfad)
      .filter((p) => ANGEBOT_DATEI.test(p) && (!eigenerOrdner || p.includes(eigenerOrdner)));
    if (kandidaten.length === 0) return { geloescht: 0, fehler: false };

    const belegt = new Set<string>();
    for (let i = 0; i < kandidaten.length; i += 50) {
      const { data: docs, error: dErr } = await admin
        .from("documents")
        .select("storage_path")
        .in("storage_path", kandidaten.slice(i, i + 50));
      if (dErr) throw dErr;
      for (const d of (docs ?? []) as { storage_path: string }[]) belegt.add(d.storage_path);
    }
    const weg = kandidaten.filter((p) => !belegt.has(p));
    if (weg.length === 0) return { geloescht: 0, fehler: false };

    const { data: entfernt, error: rErr } = await admin.storage.from("documents").remove(weg);
    if (rErr) throw rErr;
    return { geloescht: entfernt?.length ?? 0, fehler: false };
  } catch (e) {
    logError("lieferant.angebot.waisen", e, { lieferantId: lieferantId ?? null });
    return { geloescht: 0, fehler: true };
  }
}
