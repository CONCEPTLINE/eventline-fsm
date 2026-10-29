// Vertrieb › Kampagnen: Stand des Postfach-Abgleichs (GET, vertrieb:view)
// und «Jetzt abgleichen» (POST, vertrieb:edit). Gleiche Logik wie der Cron
// (src/lib/vertrieb/mail-sync-lauf.ts). vertrieb_m365_verbindung ist nur
// für den Server lesbar — hier geht nie ein Token hinaus.

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { fuehreMailSyncAus } from "@/lib/vertrieb/mail-sync-lauf";
import type { MailSyncStand } from "@/types/vertrieb";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function ladeStand(): Promise<MailSyncStand> {
  const { data } = await createAdminClient()
    .from("vertrieb_m365_verbindung")
    .select("postfach, refresh_token, letzter_sync_am, letzter_sync_fehler")
    .eq("id", 1)
    .maybeSingle();
  return {
    verbunden: !!data?.refresh_token,
    postfach: data?.postfach ?? null,
    letzter_sync_am: data?.letzter_sync_am ?? null,
    letzter_sync_fehler: data?.letzter_sync_fehler ?? null,
  };
}

export async function GET() {
  const auth = await requirePermission("vertrieb:view");
  if (auth.error) return auth.error;
  return NextResponse.json(await ladeStand(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST() {
  const auth = await requirePermission("vertrieb:edit");
  if (auth.error) return auth.error;
  const ergebnis = await fuehreMailSyncAus();
  return NextResponse.json({ ...ergebnis, stand: await ladeStand() });
}
