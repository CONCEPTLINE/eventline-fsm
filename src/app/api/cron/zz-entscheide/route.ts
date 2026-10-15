// GET /api/cron/zz-entscheide — Vercel-Cron alle 10 Minuten (Migration 329).
//
// Arbeitet die Warteschlange «Rueckstau ZZ mit Claude» ab
// (nas_zz_beschriebe -> Claude -> offener Vorschlag, lib/ki/zz-warteschlange).
// Zusaetzlich startet POST /api/ki/nachtarbeit nach jeder Lieferung einen
// kurzen Lauf (after()); zwei Laeufe gleichzeitig claimen je Zeile und
// machen nichts doppelt. Antwort nur mit Anzahlen.
//
// Absicherung wie die anderen Crons: CRON_SECRET fehlt → 503, falscher Bearer → 401.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { verarbeiteZzWarteschlange } from "@/lib/ki/zz-warteschlange";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Budget des Laufs — Rest bis maxDuration fuer Abschluss und Antwort. */
const BUDGET_MS = 270_000;

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET fehlt in der Server-Config" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const ergebnis = await verarbeiteZzWarteschlange(createAdminClient(), { budgetMs: BUDGET_MS, max: 60 });
    return NextResponse.json({ success: true, ...ergebnis });
  } catch (e) {
    logError("cron.zz-entscheide", e);
    return NextResponse.json({ success: false, error: "Warteschlange konnte nicht verarbeitet werden" }, { status: 500 });
  }
}
