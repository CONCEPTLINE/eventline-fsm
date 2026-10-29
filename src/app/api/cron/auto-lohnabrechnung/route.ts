// Cron: automatischer Lohnlauf (täglich, vercel.json).
//
// Holt alle gesperrten Monate (ab dem 5. des Folgemonats) ohne gültige
// Lohnabrechnung nach — auch den Eintrittsmonat —, ab lohn_einstellungen.lauf_ab.
// Logik: src/lib/lohn/lauf.ts. Ein Fehler betrifft nur die betroffene Person;
// Status steht in lohn_lauf (in der App unter Lohn › Lohndokumente sichtbar),
// Fehler gehen als Meldung an alle mit Lohnrecht.
//
// SYSTEMWEG — ausdrücklich von der Gerätesperre ausgenommen: Hier gibt es
// keinen Benutzer und kein Gerät. Berechtigt ist nur, wer das Cron-Geheimnis
// kennt (CRON_SECRET, zeitsicher verglichen). Die Route ruft die Lohn-
// Funktionen direkt mit dem Server-Schlüssel auf — kein HTTP-Umweg über die
// Benutzer-Route /api/hr/wage-documents/generate (die verlangt Lohnrecht +
// vertrautes Gerät und nimmt das Cron-Geheimnis nicht mehr an).
//
// ?probe=1  nur planen (welche Person/welcher Monat würde erzeugt), nichts
//           schreiben — für den Live-Gang vor dem ersten echten Lauf.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { istCronAufruf } from "@/lib/geheimnis";
import { fuehreLohnLaufAus } from "@/lib/lohn/lauf";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET fehlt in der Server-Config" }, { status: 503 });
  }
  if (!istCronAufruf(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const probe = new URL(request.url).searchParams.get("probe") === "1";
  const antwort = await fuehreLohnLaufAus(createAdminClient(), { ausloeser: "cron", probe });
  return NextResponse.json(antwort, { status: antwort.status === "fehler" ? 500 : 200 });
}
