// 3D-Ansicht im Technik-Tab (Leo 2026-10-25, Variante A): Wie erkennt die
// App eine 3D-Visualisierung eines Auftrags? — EINE Regel fuer Tab, Portal
// und Skill «eventline-3d-technikvisualisierung»:
//
//   HTML-Dokument am Auftrag (documents.job_id, mime text/html) UND
//   (Ordner «3D»  ODER  Name endet auf «_3D_v<N>.html»).
//
// Der Ordner ist das Hauptmerkmal: der Upload im Technik-Tab (und das
// Skill-Skript fsm_upload.mjs) legt dort ab, im Dokumente-Tab sieht man den
// Ordner «3D». Das Namensmuster faengt Dateien auf, die jemand im
// Dokumente-Tab ohne Ordner hochlaedt. Ausgespielt wird immer ueber die
// abgeschottete Route /api/visualisierung/[id] (CSP-Sandbox, next.config.ts).

import { istHtml } from "@/lib/upload-regeln";

/** Fester Dokument-Ordner fuer 3D-Visualisierungen. */
export const DREI_D_ORDNER = "3D";

const NAME_RE = /_3D_v(\d+)\.html?$/i;

export interface Visualisierung {
  id: string;
  name: string;
  folder: string | null;
  mime_type: string | null;
  created_at: string;
}

export function ist3dVisualisierung(d: Pick<Visualisierung, "name" | "folder" | "mime_type">): boolean {
  return istHtml(d.mime_type) && (d.folder === DREI_D_ORDNER || NAME_RE.test(d.name));
}

/** Versionsnummer aus dem Namen («…_3D_v3.html» → 3), sonst null. */
export function dreiDVersion(name: string): number | null {
  const m = name.match(NAME_RE);
  return m ? Number(m[1]) : null;
}

/** 3D-Visualisierungen, neueste (Upload-Zeitpunkt) zuerst. */
export function dreiDListe<T extends Visualisierung>(docs: T[]): T[] {
  return docs
    .filter(ist3dVisualisierung)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

export function neueste3d<T extends Visualisierung>(docs: T[]): T | null {
  return dreiDListe(docs)[0] ?? null;
}
