// «Link teilen» fuer eine HTML-Visualisierung (Browser) — EINE Umsetzung
// fuer den Dokumente-Tab und die 3D-Ansicht im Technik-Tab. Der Link
// (ohne Login, 90 Tage) kommt von POST /api/visualisierung/[id]/link.

import { toast } from "sonner";
import { formatDateFull } from "@/lib/format";

/** Erzeugt den Link und legt ihn in die Zwischenablage (mit Toast).
 *  ClipboardItem mit Promise: Safari verlangt den Kopier-Aufruf noch im
 *  Klick, der Link kommt erst danach vom Server. */
export async function visualisierungLinkKopieren(docId: string): Promise<void> {
  let gueltigBis = "";
  const linkText = fetch(`/api/visualisierung/${docId}/link`, { method: "POST" })
    .then((r) => r.json())
    .then((json) => {
      if (!json.success) throw new Error(json.error ?? "Link konnte nicht erstellt werden");
      gueltigBis = json.gueltigBis;
      return json.url as string;
    });
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({ "text/plain": linkText.then((u) => new Blob([u], { type: "text/plain" })) }),
      ]);
    } else {
      await navigator.clipboard.writeText(await linkText);
    }
    toast.success(`Link kopiert — gültig bis ${formatDateFull(gueltigBis)}`, {
      description: "Ansehen ohne Login. Dokument löschen = Link sofort ungültig.",
    });
  } catch (err) {
    // Server-Fehler (z.B. kein Recht) vor dem allgemeinen Kopier-Fehler zeigen.
    const serverFehler = await linkText.then(() => null, (e: Error) => e.message);
    toast.error(serverFehler ?? (err instanceof Error ? err.message : "Kopieren fehlgeschlagen"));
  }
}
