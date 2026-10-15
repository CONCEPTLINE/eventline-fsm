// /api/sicherheit/check — Admin loest den Sicherheits-Check manuell aus
// ("jetzt prüfen"-Knopf auf /sicherheit). Gleiche Pruefungen wie der taegliche
// Cron, nur source='manuell'.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { runSecurityAudit } from "@/lib/security-audit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const res = await runSecurityAudit("manuell");
  return NextResponse.json({ success: true, ...res });
}
