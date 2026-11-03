// POST /api/krank/[id]/gesund — «Wieder gesund»: Ende der eigenen
// Krankmeldung = heute (AAB: Wiederaufnahme melden). Nur eigene, laufende
// Krankmeldungen (Ende offen oder heute/kuenftig). Benachrichtigt
// ferien:approve (Admins inkl.) — ohne Diagnose.

import { NextResponse } from "next/server";
import { requireInternal } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { todayLocalIso } from "@/lib/swiss-time";
import { krankLaeuft } from "@/lib/krank";
import { personenMitRecht } from "@/lib/rechte-empfaenger";
import { notifyWiederGesund } from "@/lib/notification-service";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInternal();
  if (auth.error) return auth.error;
  const ich = auth.user.id;
  const { id } = await params;
  const admin = createAdminClient();
  try {
    const { data: k, error } = await admin
      .from("time_off")
      .select("id, user_id, type, status, start_date, end_date, ende_offen")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!k || k.user_id !== ich || k.type !== "krank" || k.status !== "genehmigt") {
      return NextResponse.json({ success: false, error: "Krankmeldung nicht gefunden" }, { status: 404 });
    }
    const heute = todayLocalIso();
    if (!krankLaeuft({ bis: k.end_date as string, endeOffen: k.ende_offen === true }, heute)) {
      return NextResponse.json({ success: false, error: "Diese Krankmeldung ist schon abgeschlossen" }, { status: 400 });
    }
    // Ende = heute (laeuft danach nicht mehr); begann sie erst kuenftig, bleibt sie ein Tag.
    const ende = heute < (k.start_date as string) ? (k.start_date as string) : heute;
    const { error: uErr } = await admin.from("time_off").update({ end_date: ende, ende_offen: false }).eq("id", id);
    if (uErr) throw new Error(uErr.message);

    try {
      const [{ data: prof }, approver] = await Promise.all([
        admin.from("profiles").select("full_name").eq("id", ich).maybeSingle(),
        personenMitRecht(admin, "ferien:approve"),
      ]);
      await notifyWiederGesund(admin, {
        recipients: approver.map((p) => p.id).filter((x) => x !== ich),
        timeOffId: id,
        name: (prof?.full_name as string | undefined) ?? "Jemand",
        ab: k.start_date as string,
        bis: ende,
      });
    } catch (e) {
      logError("api.krank.gesund.notify", e, { userId: ich });
    }
    return NextResponse.json({ success: true, end_date: ende });
  } catch (e) {
    logError("api.krank.gesund", e, { userId: ich, id });
    return NextResponse.json({ success: false, error: "Speichern fehlgeschlagen" }, { status: 500 });
  }
}
