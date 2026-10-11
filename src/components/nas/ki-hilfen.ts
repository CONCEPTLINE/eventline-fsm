"use client";

// Gemeinsame Bausteine der NAS-Seite fuer die neuen Funktionen der lokalen
// KI (docs/lokale-ki/MASTERPLAN.md §3.1–§3.4, Etappe 3):
//   - leseKiArten(): welche Auftrags-Arten das Rig meldet (MP-1), aus der
//     Antwort von GET /api/ki/status.
//   - kiBereitFuer(): online UND Art gemeldet -> Element anzeigen.
//   - weckeKi(): POST /api/ki/wach (MP-2), gedrosselt.
//   - holeNasDatei(): Datei vom NAS holen (ablage_abrufe) — gemeinsamer
//     Weg fuer den Download-Knopf der Seite und die Archiv-Quellen.
//   - blobFuerVorschau(): richtigen MIME-Typ fuer die Vorschau setzen.
//   - dateiTyp(): kurzer Typ-Chip aus der Endung (PDF, DOCX …).

import type { SupabaseClient } from "@supabase/supabase-js";
import { KI_BASIS_ARTEN } from "@/lib/ki/konstanten";

/** Neue Arten aus dem Masterplan. Lokal statt aus `KiArt` (src/lib/ki/typen.ts),
 *  damit die Seite nicht an der Reihenfolge der Etappe-1-Konstanten haengt. */
export type KiNeueArt = "nas_suche" | "archiv_frage";

/** Liest `arten` aus der Antwort von GET /api/ki/status (eine Quelle fuer
 *  Herzschlag und Faehigkeiten, MASTERPLAN MP-1):
 *   - `undefined` = unbekannt (Feld fehlt, z. B. aelterer Server) — neue
 *     Funktionen bleiben dann unsichtbar,
 *   - `null` = altes Rig ohne Faehigkeiten-Meldung (= nur Basis-Arten),
 *   - sonst die gemeldeten Arten (nur Strings). */
export function leseKiArten(roh: unknown): string[] | null | undefined {
  if (roh === null) return null;
  if (!Array.isArray(roh)) return undefined;
  return roh.filter((a): a is string => typeof a === "string");
}

/** Bereit = online (laut /api/ki/status) UND die Art ist gemeldet. `null`
 *  (altes Rig) gilt als «nur Basis-Arten» — die neuen Arten also nie. */
export function kiBereitFuer(online: boolean | undefined, arten: string[] | null | undefined, art: KiNeueArt): boolean {
  if (!online || arten === undefined) return false;
  const liste: readonly string[] = arten ?? KI_BASIS_ARTEN;
  return liste.includes(art);
}

/** Abholtakt des Rigs beschleunigen (MASTERPLAN §3.2). Die Route drosselt
 *  selbst; hier zusaetzlich hoechstens alle 30 s ein Aufruf je Tab. Fehler
 *  sind egal — ohne Wecken dauert es nur bis zum naechsten 2-s-Poll. */
let letztesWecken = 0;
export function weckeKi(): void {
  const jetzt = Date.now();
  if (jetzt - letztesWecken < 30_000) return;
  letztesWecken = jetzt;
  void fetch("/api/ki/wach", { method: "POST" }).catch(() => {});
}

/** Kurzer Typ aus der Dateiendung fuer den Typ-Chip. */
export function dateiTyp(name: string): string | null {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name);
  return m ? m[1].toUpperCase() : null;
}

/** Ordner-Anteil eines Pfads ("" = Hauptebene). */
export function ordnerVon(pfad: string): string {
  const i = pfad.lastIndexOf("/");
  return i === -1 ? "" : pfad.slice(0, i);
}

/** Dateiname eines Pfads. */
export function nameVon(pfad: string): string {
  return pfad.slice(pfad.lastIndexOf("/") + 1);
}

const ABRUF_POLL_MS = 4_000;
const ABRUF_MAX_MS = 150_000;

/** Datei vom NAS holen (Leo 2026-09-30) — EIN Weg fuer den Download-Knopf
 *  der Seite und die Quellen aus «Frag das Archiv»: Abruf-Zeile anlegen,
 *  der Sync-Client laedt die Datei in den Uebergabe-Bucket, signierte URL
 *  ueber /api/ablage/abruf/<id>, Datei als Blob holen. Der Name kommt aus
 *  der Route (NFC — Mac-Umlaute), nie aus der signierten URL.
 *  `onGestartet` laeuft, sobald die Abruf-Zeile steht (Toast «Wird vom NAS
 *  geholt…»). Wirft einen Error mit deutscher Meldung (fuer den Toast).
 *  Holt der Sync die Datei nicht ab (Zeitueberschreitung, Abbruch, Netz),
 *  wird die Abruf-Zeile geloescht — sonst laedt ein spaeter wieder
 *  laufender Sync die Datei (evtl. eine Personalakte) noch in den Bucket,
 *  obwohl niemand sie mehr abholt. */
export async function holeNasDatei(
  supabase: SupabaseClient,
  pfad: string,
  opts: { signal?: AbortSignal; onGestartet?: () => void } = {},
): Promise<{ blob: Blob; name: string }> {
  const { data: row, error } = await supabase.from("ablage_abrufe").insert({ pfad }).select("id").single();
  if (error || !row) throw new Error("Abruf konnte nicht gestartet werden" + (error ? ": " + error.message : ""));
  const id = (row as { id: string }).id;
  opts.onGestartet?.();
  /** true, sobald der Sync die Zeile erledigt hat (bereit/fehler). */
  let erledigt = false;
  try {
    const start = Date.now();
    while (Date.now() - start < ABRUF_MAX_MS) {
      await new Promise((r) => setTimeout(r, ABRUF_POLL_MS));
      if (opts.signal?.aborted) throw new Error("Abruf abgebrochen");
      const { data: st } = await supabase.from("ablage_abrufe").select("status, fehler").eq("id", id).maybeSingle();
      if (!st) break;
      const s = st as { status: string; fehler: string | null };
      if (s.status === "bereit") {
        erledigt = true;
        const res = await fetch(`/api/ablage/abruf/${id}`, { signal: opts.signal });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.success || typeof json.url !== "string") throw new Error(json?.error ?? "Datei konnte nicht geholt werden");
        const name = String(json.name ?? nameVon(pfad)).normalize("NFC");
        const dl = await fetch(json.url, { signal: opts.signal });
        if (!dl.ok) throw new Error("Datei konnte nicht geholt werden (HTTP " + dl.status + ")");
        return { blob: await dl.blob(), name };
      }
      if (s.status === "fehler") {
        erledigt = true;
        throw new Error("NAS meldet: " + (s.fehler ?? "Abruf fehlgeschlagen"));
      }
    }
    throw new Error("Zeitüberschreitung — läuft der Sync-Container auf dem NAS?");
  } catch (e) {
    if (!erledigt) {
      // ablage_abrufe ist eine fluechtige Uebergabe-Zeile (kein Audit, kein
      // Storage) und steht nicht auf der Liste von /api/db/delete — direkt
      // loeschen wie bisher der Download-Knopf der NAS-Seite (RLS: Admin).
      // eslint-disable-next-line no-restricted-syntax
      try { await supabase.from("ablage_abrufe").delete().eq("id", id); } catch { /* Housekeeping raeumt nach 1 h */ }
    }
    // fetch wirft bei Netzproblemen einen TypeError, beim Abbruch einen
    // AbortError — beide ohne deutsche Meldung.
    if (e instanceof DOMException && e.name === "AbortError") throw new Error("Abruf abgebrochen");
    if (e instanceof TypeError) throw new Error("Abruf fehlgeschlagen — Netzwerkfehler");
    throw e;
  }
}

/** Der NAS-Sync legt Abrufe als application/octet-stream in den Bucket —
 *  so wuerde der Browser eine PDF im iframe herunterladen statt zeigen.
 *  Fuer die Vorschau den Typ nach der Endung setzen: PDF und Rasterbilder.
 *  Office bleibt unveraendert (OfficeViewer liest die Bytes selbst). SVG/HTML
 *  bewusst NICHT — eine Blob-URL laeuft im Ursprung der App, aktive Inhalte
 *  vom NAS sollen dort nie ausgefuehrt werden. */
const VORSCHAU_TYP: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
export function blobFuerVorschau(blob: Blob, name: string): Blob {
  const typ = VORSCHAU_TYP[(dateiTyp(name) ?? "").toLowerCase()];
  return typ && blob.type !== typ ? new Blob([blob], { type: typ }) : blob;
}
