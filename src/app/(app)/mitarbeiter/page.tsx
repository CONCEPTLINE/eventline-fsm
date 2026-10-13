/**
 * /mitarbeiter → Weiterleitung. Die Mitarbeiter-Verwaltung lebt (wieder)
 * in den Einstellungen: Firmenportal › Mitarbeiter. Die eigene Seite war
 * am 2026-10-14 nur wenige Stunden live; alte Links und Lesezeichen landen
 * so trotzdem richtig. Rechte prueft /einstellungen (Tab nur fuer Admins).
 */

import { redirect } from "next/navigation";

export default function MitarbeiterRedirect() {
  redirect("/einstellungen?tab=mitarbeiter");
}
