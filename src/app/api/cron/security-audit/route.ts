// Taeglicher automatischer Sicherheits-Check (Auto-Pentest + Auffaelligkeiten).
// Schreibt security_runs + security_findings; /sicherheit zeigt den letzten Lauf.
// Autorisierung wie andere Crons: Bearer CRON_SECRET.

import { NextResponse } from "next/server";
import { runSecurityAudit } from "@/lib/security-audit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET fehlt" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const res = await runSecurityAudit("cron");
  return NextResponse.json({ success: true, ...res });
}
