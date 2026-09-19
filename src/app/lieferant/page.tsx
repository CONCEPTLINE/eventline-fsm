/**
 * /lieferant → Redirect auf /lieferant/konto.
 * Das Lieferantenportal hat V1 nur "Mein Konto" — der Root-Pfad soll
 * nie eine leere Seite zeigen (Spiegel-Idee zu /partner-Deep-Links).
 */

import { redirect } from "next/navigation";

export default function LieferantRootPage() {
  redirect("/lieferant/konto");
}
