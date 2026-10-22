// GET /api/auftrag-mails — Mails an auftrag@in…, die auf eine Zuordnung
// warten (Seite /auftraege/mails). Recht auftraege:see-all (Admin immer).
// Liefert Inhalt, Anhaenge (signierte URLs, 10 Min.) und Vorschlaege:
// zuerst der AKTUELLE Mailverlauf (wird live berechnet — wurde inzwischen
// eine Folgemail zugeordnet, steht deren Auftrag oben), dann die beim
// Eingang gespeicherten KI-/Abgleich-Vorschlaege.

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { findeVerlauf, WARTE_BUCKET, type WarteAnhang } from "@/lib/auftrag-mail/server";
import { vorschlaegeZusammen, type Vorschlag } from "@/lib/auftrag-mail/vorschlaege";

export const dynamic = "force-dynamic";

type Zeile = {
  id: string;
  absender: string | null;
  betreff: string | null;
  betreff_norm: string | null;
  message_id: string | null;
  referenzen: string[] | null;
  konversation: string | null;
  inhalt: string | null;
  anhaenge: WarteAnhang[] | null;
  vorschlaege: Vorschlag[] | null;
  empfangen_am: string;
};

export async function GET() {
  const auth = await requirePermission("auftraege:see-all");
  if (auth.error) return auth.error;
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("auftrag_mails")
    .select("id, absender, betreff, betreff_norm, message_id, referenzen, konversation, inhalt, anhaenge, vorschlaege, empfangen_am")
    .eq("status", "wartet")
    .order("empfangen_am", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ success: false, error: "Mails nicht ladbar: " + error.message }, { status: 500 });
  const zeilen = (data ?? []) as Zeile[];

  const mitVorschlaegen = await Promise.all(
    zeilen.map(async (z) => {
      let verlauf: Vorschlag[] = [];
      try {
        const v = await findeVerlauf(
          admin,
          {
            messageId: z.message_id,
            referenzen: z.referenzen ?? [],
            konversation: z.konversation,
            betreffNorm: z.betreff_norm ?? "",
          },
          z.id,
        );
        if (v.art === "treffer") {
          verlauf = [{ job_id: v.jobId, grund: v.grund === "header" ? "Gleicher Mailverlauf" : "Gleicher Betreff", quelle: "verlauf" }];
        } else if (v.art === "konflikt") {
          verlauf = v.jobIds.map((id) => ({ job_id: id, grund: "Gleicher Mailverlauf", quelle: "verlauf" as const }));
        }
      } catch {
        /* Vorschlaege sind Hilfe, kein Muss */
      }
      return { z, vorschlaege: vorschlaegeZusammen([verlauf, z.vorschlaege ?? []], 4) };
    }),
  );

  const jobIds = [...new Set(mitVorschlaegen.flatMap((m) => m.vorschlaege.map((v) => v.job_id)))];
  const jobs = new Map<string, { job_number: number; title: string | null; start_date: string | null }>();
  if (jobIds.length) {
    const { data: jr } = await admin.from("jobs").select("id, job_number, title, start_date").in("id", jobIds).not("is_deleted", "is", true);
    for (const j of (jr ?? []) as { id: string; job_number: number; title: string | null; start_date: string | null }[]) jobs.set(j.id, j);
  }

  const pfade = zeilen.flatMap((z) => (z.anhaenge ?? []).map((a) => a.pfad));
  const urls = new Map<string, string>();
  if (pfade.length) {
    const { data: signed } = await admin.storage.from(WARTE_BUCKET).createSignedUrls(pfade, 600);
    for (const s of signed ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
  }

  return NextResponse.json({
    success: true,
    mails: mitVorschlaegen.map(({ z, vorschlaege }) => ({
      id: z.id,
      absender: z.absender,
      betreff: z.betreff,
      empfangen_am: z.empfangen_am,
      inhalt: z.inhalt ?? "",
      anhaenge: (z.anhaenge ?? []).map((a) => ({ name: a.name, mime: a.mime, groesse: a.groesse, url: urls.get(a.pfad) ?? null })),
      vorschlaege: vorschlaege
        .filter((v) => jobs.has(v.job_id))
        .map((v) => ({ ...v, job_number: jobs.get(v.job_id)!.job_number, title: jobs.get(v.job_id)!.title, start_date: jobs.get(v.job_id)!.start_date })),
    })),
  });
}
