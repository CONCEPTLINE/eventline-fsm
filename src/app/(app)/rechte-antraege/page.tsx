/**
 * /rechte-antraege → Weiterleitung. Die Vier-Augen-Anträge (Rechte und
 * Lohndaten) sind seit 29.10.2026 der Reiter «Rechte & Lohndaten» der Seite
 * Anträge: /antraege?tab=rechte (Inhalt src/components/hr/rechte-antraege-view.tsx).
 * Alte Links (Glocke, Lesezeichen) bleiben gültig: ?id=… reist mit (&id=…),
 * ebenso alle übrigen Parameter. Rechte und Wartung («Rechte») prüft die Zielseite.
 */

import { redirect } from "next/navigation";
import { ANTRAEGE_TAB_RECHTE } from "@/lib/antraege-links";

export default async function RechteAntraegeWeiterleitung({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const ziel = new URLSearchParams({ tab: ANTRAEGE_TAB_RECHTE });
  for (const [key, value] of Object.entries(sp)) {
    if (key === "tab" || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) ziel.append(key, v);
  }
  redirect(`/antraege?${ziel.toString()}`);
}
