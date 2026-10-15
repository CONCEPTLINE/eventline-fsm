// GET /api/cron/finanzen-sync
//
// Täglicher Cron (vercel.json "30 2 * * *" = 03:30/04:30 Zürich): Bexio-
// Spiegel für die Finanz-Übersicht nachführen (src/lib/finanzen/spiegel).
//
// Scope-Gate: Verbindungen vor 2026-10-15 haben die Finanz-Scopes nicht →
// {skipped: "scope"} (kein Fehler — sonst wäre der Cron dauernd rot), bis in
// Einstellungen › Integrationen neu verbunden wurde. Läuft bereits ein
// Abgleich (manueller Klick) → {skipped: "laeuft"}.
//
// Antworten enthalten NIE Bexio-Texte oder Beträge — nur das Lauf-Protokoll
// (Zählungen, Kurztexte). Nur lesende Bexio-Calls.

import { NextResponse } from "next/server";
import { getConnection, hasFinanzScopes } from "@/lib/bexio";
import { finanzenSyncAusfuehren, SyncLaeuftFehler } from "@/lib/finanzen/spiegel";
import type { SyncCronAntwort } from "@/lib/finanzen/types";
import { logError } from "@/lib/log";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET fehlt in der Server-Config" }, { status: 503 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const conn = await getConnection();
    if (!conn) return NextResponse.json<SyncCronAntwort>({ success: true, skipped: "nicht verbunden" });
    if (!hasFinanzScopes(conn)) return NextResponse.json<SyncCronAntwort>({ success: true, skipped: "scope" });

    const { lauf } = await finanzenSyncAusfuehren({ art: "cron", ausgeloestVon: null });
    return NextResponse.json<SyncCronAntwort>({ success: true, lauf });
  } catch (e) {
    if (e instanceof SyncLaeuftFehler) {
      return NextResponse.json<SyncCronAntwort>({ success: true, skipped: "laeuft" });
    }
    logError("cron.finanzen-sync", e);
    return NextResponse.json<SyncCronAntwort>({ success: false, error: "Sync fehlgeschlagen" }, { status: 502 });
  }
}
