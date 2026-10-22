// Meldung an die Zustaendigen, wenn ein Partner an einer BESTAETIGTEN Anfrage
// (Status 'offen') Notizen aendert oder ein Dokument nachreicht. Diese
// Aenderungen laufen ohne Statuswechsel — frueher erfuhr niemand davon.
// In der Entwurf-/Anfrage-Phase ist keine Meldung noetig: dort kommt die
// Meldung ohnehin beim Absenden bzw. bei «Änderungen vornehmen».

import type { SupabaseClient } from "@supabase/supabase-js";
import { notifySystem } from "@/lib/notification-service";
import { recipientsWithPermission } from "@/lib/notification-recipients";
import { formatJobNumber } from "@/lib/nummern-format";
import { logError } from "@/lib/log";

const TITEL_PRAEFIX = "Partner-Nachtrag: ";
const SPERRE_MS = 30 * 60_000;

export async function partnerNachreichenMelden(
  admin: SupabaseClient,
  args: { jobId: string; userId: string; was: "notizen" | "dokument" },
): Promise<void> {
  try {
    const { data: job } = await admin
      .from("jobs")
      .select("job_number, title, status, location:locations(name)")
      .eq("id", args.jobId)
      .maybeSingle();
    if (!job || job.status !== "offen") return;
    // Notizen speichert das Portal automatisch bei jeder Tipp-Pause — darum
    // hoechstens eine Nachtrag-Meldung je Auftrag innerhalb des Fensters.
    const link = `/auftraege/${args.jobId}`;
    const { count: kuerzlich } = await admin
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("link", link)
      .like("title", `${TITEL_PRAEFIX}%`)
      .gte("created_at", new Date(Date.now() - SPERRE_MS).toISOString());
    if ((kuerzlich ?? 0) > 0) return;
    const { data: profil } = await admin.from("profiles").select("full_name").eq("id", args.userId).maybeSingle();
    const loc = Array.isArray(job.location) ? job.location[0] : job.location;
    const ort = (loc as { name?: string } | null)?.name ?? "Location";
    const wer = (profil?.full_name as string | null) ?? "Partner";
    const nr = formatJobNumber(job.job_number);
    const text =
      args.was === "notizen"
        ? `${wer} (${ort}) hat die Notizen von ${nr} geändert.`
        : `${wer} (${ort}) hat bei ${nr} ein Dokument nachgereicht.`;
    const empfaenger = await recipientsWithPermission(admin, "auftraege:edit");
    await notifySystem(admin, {
      recipients: empfaenger,
      title: `${TITEL_PRAEFIX}${job.title}`,
      message: text,
      link,
    });
  } catch (e) {
    logError("partner-nachreichen-melden", e, { jobId: args.jobId, was: args.was });
  }
}
