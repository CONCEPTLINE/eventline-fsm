// GET /api/lieferant/anfragen — Technik-Anfragen des eingeloggten
// Lieferanten (Portal). Admin-Client mit strikter Whitelist: der Lieferant
// sieht NUR Titel/Datum/Location/Gaeste + Technik-Zaehler — nie Preise,
// Stunden, Dokumente oder Kundendaten.

import { NextResponse } from "next/server";
import { requireLieferantPortal } from "@/lib/technik-server";
import { logError } from "@/lib/log";

export async function GET() {
  const gate = await requireLieferantPortal();
  if (gate.error) return gate.error;
  const { admin, lieferantId } = gate;

  try {
    const { data: zuweisungen } = await admin
      .from("job_lieferanten")
      .select("job_id, angefragt_at, job:jobs(id, title, job_number, start_date, end_date, guest_count, event_type, is_deleted, location:locations(name))")
      .eq("lieferant_id", lieferantId)
      .order("created_at", { ascending: false });

    const jobs = ((zuweisungen ?? []) as unknown as {
      job_id: string;
      angefragt_at: string | null;
      job: {
        id: string; title: string; job_number: number | null;
        start_date: string | null; end_date: string | null;
        guest_count: number | null; event_type: string | null; is_deleted: boolean;
        location: { name: string } | { name: string }[] | null;
      } | null;
    }[]).filter((z) => z.job && !z.job.is_deleted);

    const jobIds = jobs.map((z) => z.job_id);
    const [{ data: posRows }, { data: revRows }] = await Promise.all([
      jobIds.length
        ? admin.from("job_technik_positionen").select("job_id, status").in("job_id", jobIds)
        : Promise.resolve({ data: [] as { job_id: string; status: string }[] }),
      jobIds.length
        ? admin.from("job_technik_reviews").select("job_id, art, status").in("job_id", jobIds).eq("status", "offen")
        : Promise.resolve({ data: [] as { job_id: string; art: string; status: string }[] }),
    ]);

    const anfragen = jobs.map((z) => {
      const j = z.job!;
      const loc = Array.isArray(j.location) ? j.location[0] : j.location;
      const pos = ((posRows ?? []) as { job_id: string; status: string }[]).filter((p) => p.job_id === z.job_id);
      const offen = ((revRows ?? []) as { job_id: string }[]).filter((r) => r.job_id === z.job_id).length;
      return {
        jobId: j.id,
        titel: j.title,
        jobNumber: j.job_number,
        startDate: j.start_date,
        endDate: j.end_date,
        gaeste: j.guest_count,
        eventTyp: j.event_type,
        locationName: loc?.name ?? null,
        angefragtAt: z.angefragt_at,
        positionen: pos.length,
        bestaetigt: pos.filter((p) => p.status === "bestaetigt").length,
        offenePunkte: offen,
      };
    });

    return NextResponse.json({ success: true, anfragen });
  } catch (e) {
    logError("api.lieferant.anfragen", e);
    return NextResponse.json({ success: false, error: "Laden fehlgeschlagen" }, { status: 500 });
  }
}
