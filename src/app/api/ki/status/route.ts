import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { logError } from "@/lib/log";
import { istKiOnline } from "@/lib/ki/queue";

// GET /api/ki/status → { online, letzter_poll, modell, warteschlange, arten }
// (SPEC 2.3) fuer den Chip «Lokale KI · online/offline». `arten` = die vom
// Rig gemeldeten Auftrags-Arten (ki_status.arten, MASTERPLAN MP-1; null =
// altes Rig ohne Meldung) — die NAS-Seite liest sie nur von hier. Gelesen ueber den
// Nutzer-Client: die RLS-Policy (Migration 288) zeigt den Herzschlag nur
// internen Mitarbeitern — Portal-Konten sehen schlicht «offline».

export async function GET() {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("ki_status")
      .select("letzter_poll, modell, warteschlange, arten")
      .eq("id", 1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return NextResponse.json(
      {
        success: true,
        online: istKiOnline(data?.letzter_poll as string | null),
        letzter_poll: (data?.letzter_poll as string | null) ?? null,
        modell: (data?.modell as string | null) ?? null,
        warteschlange: (data?.warteschlange as number | null) ?? 0,
        arten: Array.isArray(data?.arten) ? (data.arten as unknown[]).filter((a): a is string => typeof a === "string") : null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    logError("ki.status", e);
    return NextResponse.json({ success: false, error: "KI-Status konnte nicht gelesen werden" }, { status: 500 });
  }
}
