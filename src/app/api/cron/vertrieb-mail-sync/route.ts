// Cron: Vertrieb › Kampagnen mit Leos Microsoft-365-Postfach abgleichen
// (alle 15 Min., vercel.json). Setzt «Angeschrieben», «Antwort erhalten»
// und «Nicht zustellbar» automatisch — nie, wenn ein Mensch den Status
// gesetzt hat. Logik: src/lib/vertrieb/mail-sync-lauf.ts.
//
// Fehler (Token abgelaufen, Graph nicht erreichbar) landen in
// vertrieb_m365_verbindung.letzter_sync_fehler und in der App unter
// Vertrieb; die Route antwortet trotzdem 200 mit ok:false, damit der Cron
// nicht dauernd rot ist.

import { NextResponse } from "next/server";
import { istCronAufruf } from "@/lib/geheimnis";
import { fuehreMailSyncAus } from "@/lib/vertrieb/mail-sync-lauf";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET fehlt in der Server-Config" }, { status: 503 });
  }
  if (!istCronAufruf(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await fuehreMailSyncAus());
}
