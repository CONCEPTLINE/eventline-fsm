/**
 * /sicherheit → Weiterleitung. Die eigene Seite war am 2026-10-14 nur
 * wenige Stunden live; ihr Inhalt lebt (wieder) in den Einstellungen:
 *   ?tab=anmeldungen&bereich=partner    → Partnerportal › Anmeldungen
 *   ?tab=anmeldungen&bereich=lieferant  → Lieferantenportal › Anmeldungen
 *   sonst (Anmeldungen Firma, ?tab=geraete|entwickler, ohne Tab)
 *                                       → Firmenportal › Sicherheit
 * Rechte prueft /einstellungen (Tabs nur fuer Admins).
 */

import { redirect } from "next/navigation";

function ersterWert(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function SicherheitRedirect({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const tab = ersterWert(sp.tab);
  const bereich = ersterWert(sp.bereich);

  // Anmeldungen war der Standard-Tab — ?bereich=… ohne tab zaehlt mit.
  const anmeldungen = !tab || tab === "anmeldungen";
  const ziel =
    anmeldungen && bereich === "partner"
      ? "partner-aktivitaet"
      : anmeldungen && bereich === "lieferant"
        ? "lieferant-aktivitaet"
        : "sicherheit";
  redirect(`/einstellungen?tab=${ziel}`);
}
