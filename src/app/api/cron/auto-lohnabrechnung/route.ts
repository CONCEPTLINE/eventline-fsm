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
//
// Wartung «Lohn» (Migration 363): der Lauf pausiert — nichts wird erzeugt,
// lohn_lauf hält «pausiert (Wartung)» fest (bei ?probe=1 nichts). Ausnahmen
// gibt es hier nicht (kein Benutzer). Stand frisch aus der DB, nicht gecacht;
// ist er nicht lesbar, läuft nichts (500, im Zweifel lieber kein Lauf).
//
// Phase 4: Monate mit offenen/ungeprüften langen Stempeln sind «blockiert»
// (kein Fehler, 200). Fehler, blockierte Monate und «Lauf konnte nicht
// starten» (auch: Wartungsstand nicht lesbar) gehen als Alarm-Mail an die
// Lohnverwaltung (src/lib/lohn/alarm.ts, ohne Beträge).

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { istCronAufruf } from "@/lib/geheimnis";
import { fuehreLohnLaufAus, pausiereLohnLauf } from "@/lib/lohn/lauf";
import { ladeWartungStreng } from "@/lib/wartung-server";
import { logError } from "@/lib/log";
import { sendeLaufAlarm } from "@/lib/lohn/alarm";

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
  const admin = createAdminClient();
  let wartung;
  try {
    wartung = await ladeWartungStreng();
  } catch (e) {
    logError("lohn.lauf.wartung", e);
    if (!probe) {
      await sendeLaufAlarm(admin, { laufId: null, art: "start", text: "Wartungsstand nicht lesbar — Lauf nicht gestartet" });
    }
    return NextResponse.json({ status: "fehler", meldung: "Wartungsstand nicht lesbar — Lauf nicht gestartet" }, { status: 500 });
  }
  if (wartung.bereiche.includes("lohn")) {
    const pause = await pausiereLohnLauf(admin, { ausloeser: "cron", probe });
    return NextResponse.json(pause, { status: pause.status === "fehler" ? 500 : 200 });
  }
  const antwort = await fuehreLohnLaufAus(admin, { ausloeser: "cron", probe });
  return NextResponse.json(antwort, { status: antwort.status === "fehler" ? 500 : 200 });
}
