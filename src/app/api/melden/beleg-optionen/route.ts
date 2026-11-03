// GET /api/melden/beleg-optionen — Auswahl fuer «Beleg melden».
//
// Antwort:
//   { abgesprochen: [{ id, full_name }]   — wer Belege freigeben darf: alle
//                                            aktiven internen Konten mit
//                                            tickets:manage (Admins inkl.),
//                                            ohne die Person selbst
//     auftraege: [{ id, job_number, title, project_lead_id }]
//                                          — eigene Einsaetze der letzten 60
//                                            und naechsten 14 Tage, neueste zuerst
//     vorschlag_auftrag_id                  — Auftrag des heutigen bzw. letzten
//                                            Einsatzes (oder null) }
//
// «Ansicht als»: Einsaetze der angesehenen Person (nur lesen).

import { NextResponse } from "next/server";
import { requireInternal } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { personenMitRecht } from "@/lib/rechte-empfaenger";
import { logError } from "@/lib/log";
import { localDateIso } from "@/lib/swiss-time";

export const dynamic = "force-dynamic";

const TAG_MS = 86_400_000;

interface TerminZeile {
  start_time: string;
  job: { id: string; job_number: number; title: string; project_lead_id: string | null; status: string; is_deleted: boolean | null } | null;
}

export async function GET() {
  const auth = await requireInternal();
  if (auth.error) return auth.error;
  const ich = auth.effectiveUserId;
  const admin = createAdminClient();
  try {
    const jetzt = Date.now();
    const [personen, termine] = await Promise.all([
      personenMitRecht(admin, "tickets:manage"),
      admin
        .from("job_appointments")
        .select("start_time, job:jobs(id, job_number, title, project_lead_id, status, is_deleted)")
        .eq("assigned_to", ich)
        .not("job_id", "is", null)
        .gte("start_time", new Date(jetzt - 60 * TAG_MS).toISOString())
        .lt("start_time", new Date(jetzt + 14 * TAG_MS).toISOString())
        .order("start_time", { ascending: false })
        .limit(200),
    ]);
    if (termine.error) throw new Error(termine.error.message);

    const zeilen = ((termine.data ?? []) as unknown as TerminZeile[])
      .filter((t) => t.job && !t.job.is_deleted && t.job.status !== "storniert");

    // Vorschlag: der Einsatz, der heute (Zuerich) laeuft, sonst der letzte
    // vergangene. Zukuenftige Einsaetze schlagen wir nicht vor.
    const heute = localDateIso(new Date(jetzt));
    const tagVon = (iso: string) => localDateIso(new Date(iso));
    const vorschlag =
      zeilen.find((t) => tagVon(t.start_time) === heute) ??
      zeilen.find((t) => tagVon(t.start_time) < heute) ??
      null;

    const gesehen = new Set<string>();
    const auftraege = [];
    for (const t of zeilen) {
      if (!t.job || gesehen.has(t.job.id)) continue;
      gesehen.add(t.job.id);
      auftraege.push({ id: t.job.id, job_number: t.job.job_number, title: t.job.title, project_lead_id: t.job.project_lead_id });
    }

    return NextResponse.json(
      {
        success: true,
        abgesprochen: personen.filter((p) => p.id !== ich),
        auftraege,
        vorschlag_auftrag_id: vorschlag?.job?.id ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    logError("api.melden.beleg-optionen", e, { userId: ich });
    return NextResponse.json({ success: false, error: "Auswahl konnte nicht geladen werden" }, { status: 500 });
  }
}
