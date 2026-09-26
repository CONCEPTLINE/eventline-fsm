/**
 * /lieferant → Redirect auf /lieferant/anfragen — der Arbeitsort des
 * Portals (Technik-Anfragen prüfen). Der Root-Pfad soll nie eine leere
 * Seite zeigen (Spiegel-Idee zu /partner-Deep-Links).
 */

import { redirect } from "next/navigation";

export default function LieferantRootPage() {
  redirect("/lieferant/anfragen");
}
